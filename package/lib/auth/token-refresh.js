/**
 * Kiro token refresh, one path per auth method.
 *
 * The methods do not share a token endpoint, and using the wrong one is not a
 * clean 401 — it is a confusing grant error. `refreshKiroToken` therefore
 * branches on the credential's own `authMethod` exactly the way Kiro itself
 * issues tokens:
 *
 * | authMethod | refresh endpoint | body shape |
 * |---|---|---|
 * | `external_idp` | the tenant `token_endpoint` (Entra) | form-encoded `grant_type=refresh_token` + `client_id` + `scope` |
 * | `builder-id`, `idc` | `https://oidc.<region>.amazonaws.com/token` | JSON `clientId`/`clientSecret`/`grantType` |
 * | `google`, `github`, `import` | `https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken` | JSON `{ refreshToken }`, `User-Agent: kiro-cli/1.0.0` |
 * | `api_key` | none | the key is long-lived; there is nothing to rotate |
 *
 * Refresh tokens are single-use for AWS SSO, so two concurrent turns rotating
 * one token would lose whichever wrote first. `dedup` collapses concurrent
 * refreshes for the same credential into one request.
 *
 * @module lib/auth/token-refresh
 */

import { KIRO_AUTH_HOST, KIRO_OIDC_HOST, REFRESH_LEAD_MS, assertValidAwsRegion } from '../constants.js'
import { ERROR_CODES, KiroError } from '../errors.js'
import { decodeJwtPayload, expiryFromAccessToken, identityFromAccessToken, readBodyPrefix, redact } from '../util.js'
import { buildExternalIdpRefreshParams } from './external-idp.js'

/** In-flight refreshes keyed by credential fingerprint. */
const inflight = new Map()

/**
 * Collapse concurrent refreshes of one credential.
 * @param {string} key
 * @param {() => Promise<object|null>} run
 */
export async function dedupRefresh(key, run) {
  const existing = inflight.get(key)
  if (existing) return await existing
  const promise = run().finally(() => {
    if (inflight.get(key) === promise) inflight.delete(key)
  })
  inflight.set(key, promise)
  return await promise
}

/** Whether a stored access token needs rotation before the next request. */
export function needsRefresh(account, now = Date.now(), leadMs = REFRESH_LEAD_MS) {
  if (!account) return false
  if (account.authMethod === 'api_key') return false
  const expiresAt = Number(account.expiresAt)
  if (!Number.isFinite(expiresAt)) return Boolean(account.refreshToken)
  return expiresAt - now <= leadMs
}

/** Epoch milliseconds for an `expires_in` seconds value. */
export function expiresAtFrom(expiresIn, now = Date.now()) {
  const seconds = Number(expiresIn)
  if (Number.isFinite(seconds) && seconds > 0) return now + seconds * 1000
  return now + 3600 * 1000
}

/**
 * Refresh one account's access token.
 *
 * @param {{
 *   account: object,
 *   fetch?: typeof globalThis.fetch,
 *   log?: object,
 *   resolveProfileArn?: (credentials: object) => Promise<string|null>,
 * }} options
 * @returns {Promise<{ accessToken: string, refreshToken?: string, expiresAt?: number, profileArn?: string, authMethod: string }|null>}
 * @throws {KiroError} with `KIRO_REFRESH_EXPIRED` when the refresh token is dead
 *   for good, so the caller can surface "sign in again" instead of retrying.
 */
export async function refreshKiroToken(options) {
  const account = options.account || {}
  const fetchImpl = options.fetch || globalThis.fetch
  const log = options.log

  if (account.authMethod === 'api_key') {
    // A key has no refresh path; re-validate instead of pretending to rotate.
    return null
  }
  if (!account.refreshToken) {
    throw new KiroError('this Kiro account has no refresh token; sign in again', ERROR_CODES.refreshExpired)
  }

  const key = `${account.id || 'anon'}:${String(account.refreshToken).slice(-12)}`
  return await dedupRefresh(key, async () => {
    const attempt = await runRefresh({ ...options, fetch: fetchImpl })
    if (!attempt) return null
    const accessToken = attempt.accessToken
    if (!accessToken) return null
    const payload = decodeJwtPayload(accessToken)
    const patch = {
      accessToken,
      authMethod: account.authMethod,
      ...(attempt.refreshToken ? { refreshToken: attempt.refreshToken } : {}),
      ...(Number.isFinite(attempt.expiresAt) ? { expiresAt: attempt.expiresAt } : {}),
      ...(attempt.profileArn ? { profileArn: attempt.profileArn } : {}),
      ...(payload && !account.email ? { email: identityFromAccessToken(accessToken) || undefined } : {}),
    }
    if (!patch.expiresAt) {
      patch.expiresAt = attempt.expiresIn ? expiresAtFrom(attempt.expiresIn) : (expiryFromAccessToken(accessToken) || expiresAtFrom(3600))
    }
    // An account that never resolved its own profile ARN must not be sent to the
    // Amazon surfaces with a placeholder ARN belonging to another account.
    if (!patch.profileArn && !account.profileArn && typeof options.resolveProfileArn === 'function') {
      const arn = await options.resolveProfileArn({ ...account, ...patch }).catch(() => null)
      if (arn) patch.profileArn = arn
    }
    log?.info?.('kiro: refreshed the access token')
    return patch
  })
}

async function runRefresh(options) {
  const account = options.account
  const fetchImpl = options.fetch || globalThis.fetch
  const log = options.log
  const authMethod = account.authMethod

  if (authMethod === 'external_idp') {
    let request
    try {
      request = buildExternalIdpRefreshParams(account.refreshToken, account)
    } catch (error) {
      throw new KiroError(`external_idp refresh is not configured correctly: ${error.message}`, ERROR_CODES.invalidCredential)
    }
    const response = await fetchImpl(request.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: request.body,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    if (!response.ok) return await failure(response, 'external_idp')
    const tokens = await response.json()
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || account.refreshToken,
      expiresIn: tokens.expires_in,
      profileArn: account.profileArn || null,
    }
  }

  const isOidc = Boolean(account.clientId && account.clientSecret)
  if (isOidc) {
    const region = authMethod === 'idc' && account.region ? account.region : account.region || 'us-east-1'
    assertValidAwsRegion(region)
    // Builder-ID registrations are only honoured by the us-east-1 OIDC host;
    // IDC clients are regional, so the region the token was minted in is used.
    const endpoint = authMethod === 'idc'
      ? KIRO_OIDC_HOST.replace('{region}', region) + '/token'
      : KIRO_OIDC_HOST.replace('{region}', 'us-east-1') + '/token'
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        clientId: account.clientId,
        clientSecret: account.clientSecret,
        refreshToken: account.refreshToken,
        grantType: 'refresh_token',
      }),
      ...(options.signal ? { signal: options.signal } : {}),
    })
    if (!response.ok) return await failure(response, 'aws-sso-oidc')
    const tokens = await response.json()
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken || account.refreshToken,
      expiresIn: tokens.expiresIn,
      profileArn: tokens.profileArn || null,
    }
  }

  // Social (Google/GitHub) and an imported refresh token both rotate through the
  // desktop auth host, which expects the CLI user agent.
  const response = await fetchImpl(`${KIRO_AUTH_HOST}/refreshToken`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'kiro-cli/1.0.0',
    },
    body: JSON.stringify({ refreshToken: account.refreshToken }),
    ...(options.signal ? { signal: options.signal } : {}),
  })
  if (!response.ok) return await failure(response, 'kiro-social')
  const tokens = await response.json()
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || account.refreshToken,
    expiresIn: tokens.expiresIn,
    profileArn: tokens.profileArn || null,
  }
}

/** Read the failure, and escalate a permanently dead refresh token. */
async function failure(response, stage) {
  const text = await readBodyPrefix(response, 2048)
  const verdict = classifyRefreshError(text, response.status)
  if (verdict.permanent) {
    throw new KiroError(
      `Kiro refresh token is no longer usable (${verdict.code || response.status}). Sign in again.`,
      ERROR_CODES.refreshExpired,
      { status: response.status, stage, reason: verdict.code },
    )
  }
  throw new KiroError(`Kiro ${stage} refresh failed with ${response.status}: ${redact(text).slice(0, 300)}`, ERROR_CODES.auth, {
    status: response.status,
    stage,
  })
}

/**
 * AWS SSO and Cognito report a rotated or reused refresh token as a permanent
 * grant failure. Treating that as transient would retry forever and log the
 * token repeatedly, so it is decided by code, not by status.
 */
export function classifyRefreshError(body, status) {
  let parsed = null
  try {
    parsed = JSON.parse(body)
  } catch {
    parsed = null
  }
  const code = String(parsed?.error?.code || parsed?.error || parsed?.error_code || parsed?.errorDescription || '').toLowerCase()
  const description = String(parsed?.error_description || parsed?.message || body || '')
  const combined = `${code} ${description}`.toLowerCase()
  const permanent = [
    'refresh_token_expired',
    'refresh_token_reused',
    'refresh_token_invalidated',
    'invalid_grant',
    'invalid_grant_error',
  ].some(marker => combined.includes(marker))
  return { code: code || undefined, description, permanent, status }
}
