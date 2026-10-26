/**
 * Kiro sign-in flows, one per auth method Kiro offers.
 *
 * Kiro has no single "log in" endpoint, and each path has its own trap:
 *
 * - **AWS SSO OIDC (Builder ID / IDC)** needs a *client registration* first.
 *   The device-code request must carry that fresh `clientId`/`clientSecret`, and
 *   they have to be kept with the account afterwards, because the refresh call
 *   authenticates the client too. Losing them makes the refresh token useless.
 * - **Social (Google/GitHub)** runs through Cognito behind the Kiro auth host.
 *   The redirect URI must be the `kiro://` custom protocol the IdP whitelist
 *   contains — `http://localhost` is refused — so the flow is completed by
 *   pasting the callback URL back into the plugin.
 * - **Import** validates a pasted refresh token by refreshing it once. That is
 *   also the cheapest way to tell "typo" from "expired".
 * - **Auto-import** reads the local AWS SSO cache and the Kiro IDE profile the
 *   desktop app writes on Windows, which is the only path that needs no browser.
 * - **API key** cannot be validated by listing profiles (`ListAvailableProfiles`
 *   does not accept `TokenType=API_KEY` and answers 200 with an empty list for a
 *   junk key), so validation goes through the same Q catalog surface inference
 *   uses.
 * - **External IdP** refreshes against the tenant endpoint; see
 *   {@link module:lib/auth/external-idp}.
 *
 * @module lib/auth/flows
 */

import { createHash, randomBytes } from 'node:crypto'
import { readFile as fsReadFile, readdir as fsReaddir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  DEFAULT_PROFILE_ARNS,
  DEFAULT_REGION,
  JSON_ACCEPT,
  KIRO_AUTH_HOST,
  KIRO_OIDC_CLIENT,
  KIRO_OIDC_HOST,
  KIRO_SOCIAL,
  KIRO_START_URL,
  assertValidAwsRegion,
} from '../constants.js'
import { ERROR_CODES, KiroError } from '../errors.js'
import { identityFromAccessToken, readBodyPrefix } from '../util.js'
import { expiresAtFrom } from './token-refresh.js'

/** Refresh tokens issued by the Kiro desktop auth host carry this prefix. */
export const SOCIAL_REFRESH_PREFIX = 'aorAAAAAG'

async function postJson(url, body, { fetch = globalThis.fetch, headers = {}, signal } = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: JSON_ACCEPT, ...headers },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  })
  const text = await response.text().catch(() => '')
  if (!response.ok) {
    throw new KiroError(`Kiro auth endpoint answered ${response.status}: ${text.slice(0, 300) || response.statusText}`, ERROR_CODES.auth, {
      status: response.status,
    })
  }
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    throw new KiroError(`Kiro auth endpoint returned a non-JSON answer (${response.status})`, ERROR_CODES.upstream, { status: response.status })
  }
}

/** Step 1 of the SSO flow: register a public OIDC client for this Kiro install. */
export async function registerOidcClient(options = {}) {
  const region = options.region || DEFAULT_REGION
  assertValidAwsRegion(region)
  const endpoint = options.registerClientUrl || `${KIRO_OIDC_HOST.replace('{region}', region)}/client/register`
  const data = await postJson(endpoint, {
    clientName: KIRO_OIDC_CLIENT.clientName,
    clientType: KIRO_OIDC_CLIENT.clientType,
    scopes: KIRO_OIDC_CLIENT.scopes,
    grantTypes: KIRO_OIDC_CLIENT.grantTypes,
    issuerUrl: KIRO_OIDC_CLIENT.issuerUrl,
  }, { fetch: options.fetch, signal: options.signal })
  if (!data?.clientId || !data?.clientSecret) {
    throw new KiroError('AWS SSO did not return a client id and secret', ERROR_CODES.upstream)
  }
  return { clientId: data.clientId, clientSecret: data.clientSecret, region, clientSecretExpiresAt: data.clientSecretExpiresAt ?? null }
}

/** Step 2: ask for a device code the human can type into the browser page. */
export async function startDeviceAuthorization(options = {}) {
  const region = options.region || DEFAULT_REGION
  assertValidAwsRegion(region)
  const startUrl = (typeof options.startUrl === 'string' && options.startUrl.trim()) || KIRO_START_URL
  const client = options.clientId && options.clientSecret
    ? { clientId: options.clientId, clientSecret: options.clientSecret, region }
    : await registerOidcClient({ region, fetch: options.fetch, signal: options.signal })

  const endpoint = options.deviceAuthUrl || `${KIRO_OIDC_HOST.replace('{region}', region)}/device_authorization`
  const data = await postJson(endpoint, {
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    startUrl,
  }, { fetch: options.fetch, signal: options.signal })

  return {
    userCode: data.userCode,
    verificationUri: data.verificationUri,
    verificationUriComplete: data.verificationUriComplete || null,
    expiresInSeconds: Number(data.expiresIn) || 600,
    intervalSeconds: Number(data.interval) || 5,
    deviceCode: data.deviceCode,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    region,
    startUrl,
    authMethod: options.authMethod === 'idc' ? 'idc' : 'builder-id',
    // The shared placeholder only belongs to the builder-id family; an
    // organization account must resolve its own profile ARN from its token.
    defaultProfileArn: options.authMethod === 'idc' ? '' : DEFAULT_PROFILE_ARNS['builder-id'],
  }
}

/**
 * Step 3: poll for the token. Returns a status instead of throwing on a pending
 * authorization, because "the human has not confirmed yet" is the normal case.
 * @returns {Promise<{ status: 'authorized'|'pending'|'slow_down'|'declined'|'expired'|'failed', account?: object, error?: object }>}
 */
export async function pollDeviceToken(options = {}) {
  const { clientId, clientSecret, deviceCode, region = DEFAULT_REGION, authMethod = 'builder-id', startUrl, profileArn } = options
  const fetch = options.fetch || globalThis.fetch
  const endpoint = options.tokenUrl || `${KIRO_OIDC_HOST.replace('{region}', region)}/token`
  let response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: JSON_ACCEPT },
      body: JSON.stringify({
        clientId,
        clientSecret,
        deviceCode,
        grantType: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
      ...(options.signal ? { signal: options.signal } : {}),
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    return { status: 'failed', error: { message: error?.message || String(error), code: ERROR_CODES.endpoint } }
  }
  const text = await response.text().catch(() => '')
  let data = {}
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { error: 'invalid_response', error_description: text.slice(0, 200) }
  }
  if (response.ok && data.accessToken) {
    return {
      status: 'authorized',
      account: buildAccount({
        authMethod,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        expiresIn: data.expiresIn,
        profileArn: data.profileArn || profileArn || null,
        clientId,
        clientSecret,
        region,
        startUrl,
      }),
    }
  }
  const code = String(data.error || data.errorCode || '').toLowerCase()
  if (code === 'authorization_pending') return { status: 'pending' }
  if (code === 'slow_down') return { status: 'slow_down' }
  if (code === 'authorization_declined') return { status: 'declined', error: data }
  if (code === 'expired_token') return { status: 'expired', error: data }
  return { status: 'failed', error: { code, message: data.error_description || data.message || text.slice(0, 200) || `HTTP ${response.status}` } }
}

/** Shared account-record shape; every flow returns exactly this. */
export function buildAccount(input) {
  const now = Date.now()
  return {
    authMethod: input.authMethod,
    label: input.label || labelFor(input.authMethod),
    email: input.email || identityFromAccessToken(input.accessToken) || null,
    accessToken: input.accessToken,
    refreshToken: input.refreshToken || null,
    expiresAt: Number.isFinite(input.expiresAt) ? input.expiresAt : expiresAtFrom(input.expiresIn, now),
    profileArn: input.profileArn || null,
    region: input.region || DEFAULT_REGION,
    clientId: input.clientId || null,
    clientSecret: input.clientSecret || null,
    clientName: input.clientName || (input.clientId ? KIRO_OIDC_CLIENT.clientName : null),
    startUrl: input.startUrl || null,
    scope: input.scope || null,
    tokenEndpoint: input.tokenEndpoint || null,
    apiKey: input.apiKey || null,
    createdAt: input.createdAt || new Date(now).toISOString(),
  }
}

function labelFor(authMethod) {
  return {
    'builder-id': 'AWS Builder ID',
    idc: 'IAM Identity Center',
    google: 'Google',
    github: 'GitHub',
    'external_idp': 'Enterprise IdP',
    api_key: 'Kiro API key',
    import: 'Imported token',
    'auto-import': 'Kiro IDE (local)',
  }[authMethod] || 'Kiro'
}

/** PKCE pair for the social flow; S256 only, as Cognito requires. */
export function generatePkce() {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { codeVerifier: verifier, codeChallenge: challenge, state: randomBytes(16).toString('hex') }
}

/** Cognito whitelists only the `kiro://` custom protocol, so the callback is manual. */
export function buildSocialLoginUrl(options = {}) {
  const provider = options.provider === 'github' ? 'Github' : 'Google'
  const redirect = options.redirectUri || KIRO_SOCIAL.redirectUri
  const params = new URLSearchParams({
    idp: provider,
    redirect_uri: redirect,
    code_challenge: options.codeChallenge,
    code_challenge_method: 'S256',
    state: options.state,
    prompt: 'select_account',
  })
  return `${KIRO_SOCIAL.loginUrl}?${params.toString()}`
}

/** Pull `code` (and `state`) out of a pasted `kiro://…?code=…` callback URL. */
export function parseSocialCallback(input) {
  const raw = String(input || '').trim()
  if (!raw) throw new KiroError('paste the full callback URL (or just the code) from the browser', ERROR_CODES.rejected)
  const params = new URLSearchParams(decodeCallbackQuery(raw))
  const code = params.get('code')
  const state = params.get('state')
  const error = params.get('error')
  if (error) throw new KiroError(`the identity provider refused the login: ${params.get('error_description') || error}`, ERROR_CODES.auth)
  if (!code) throw new KiroError('no code= parameter was found in that callback', ERROR_CODES.rejected)
  return { code, state: state || undefined }
}

function decodeCallbackQuery(raw) {
  const withoutScheme = raw.replace(/^kiro:\/\/[^?]*\??/iu, '')
  if (withoutScheme !== raw) return withoutScheme
  const query = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : raw
  return query.startsWith('code=') || query.includes('=') ? query : `code=${query}`
}

/** Exchange the social code for tokens; the redirect URI must match the request exactly. */
export async function exchangeSocialCode(options = {}) {
  const redirectUri = options.redirectUri || KIRO_SOCIAL.redirectUri
  const data = await postJson(KIRO_SOCIAL.tokenUrl, {
    code: options.code,
    code_verifier: options.codeVerifier,
    redirect_uri: redirectUri,
  }, { fetch: options.fetch, signal: options.signal })
  if (!data.accessToken) throw new KiroError('the Kiro auth host returned no access token', ERROR_CODES.auth)
  return buildAccount({
    authMethod: options.provider === 'github' ? 'github' : 'google',
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresIn: data.expiresIn || 3600,
    profileArn: data.profileArn || null,
  })
}

/**
 * Import a pasted refresh token. The token is exercised once so a stale or
 * mistyped value fails here instead of on the first model call.
 */
export async function importRefreshToken(options = {}) {
  const refreshToken = String(options.refreshToken || '').trim()
  if (!refreshToken) throw new KiroError('a Kiro refresh token is required', ERROR_CODES.rejected)
  const hasClient = Boolean(options.clientId && options.clientSecret)
  if (!hasClient && options.strictFormat !== false && !refreshToken.startsWith(SOCIAL_REFRESH_PREFIX) && !refreshToken.startsWith('aor')) {
    // Format is a hint, not a gate: an SSO-issued token does not use the prefix,
    // so a mismatch only downgrades the error message after a failed refresh.
    options.log?.debug?.('kiro: imported token does not look like a Kiro social token')
  }
  const region = options.region || DEFAULT_REGION
  assertValidAwsRegion(region)
  const endpoint = hasClient
    ? `${KIRO_OIDC_HOST.replace('{region}', region)}/token`
    : `${KIRO_AUTH_HOST}/refreshToken`
  const body = hasClient
    ? { clientId: options.clientId, clientSecret: options.clientSecret, refreshToken, grantType: 'refresh_token' }
    : { refreshToken }
  let data
  try {
    data = await postJson(endpoint, body, {
      fetch: options.fetch,
      signal: options.signal,
      headers: hasClient ? {} : { 'User-Agent': 'kiro-cli/1.0.0' },
    })
  } catch (error) {
    throw error instanceof KiroError
      ? new KiroError(`that refresh token was refused: ${error.message}`, ERROR_CODES.auth, { status: error.status })
      : error
  }
  const accessToken = data.accessToken
  if (!accessToken) throw new KiroError('the token endpoint returned no access token', ERROR_CODES.auth)
  return buildAccount({
    authMethod: hasClient ? (options.authMethod === 'builder-id' ? 'builder-id' : 'idc') : 'import',
    label: hasClient ? undefined : 'Imported token',
    accessToken,
    refreshToken: data.refreshToken || refreshToken,
    expiresIn: data.expiresIn,
    profileArn: options.profileArn || data.profileArn || null,
    clientId: hasClient ? options.clientId : null,
    clientSecret: hasClient ? options.clientSecret : null,
    region,
    startUrl: options.startUrl || null,
  })
}

/**
 * Validate a Kiro API key against the Q catalog.
 *
 * `ListAvailableProfiles` is deliberately not used: it answers 200 with an empty
 * list for a junk key, which would let a broken credential pass the settings
 * check and fail on the first real turn.
 */
export async function validateApiKey(options = {}) {
  const apiKey = String(options.apiKey || '').trim()
  if (!apiKey) throw new KiroError('a Kiro API key is required', ERROR_CODES.rejected)
  const region = options.region || DEFAULT_REGION
  assertValidAwsRegion(region)
  const params = new URLSearchParams({ origin: 'AI_EDITOR' })
  const endpoint = options.endpoint
    || `https://q.${region}.amazonaws.com/ListAvailableModels?${params.toString()}`
  const fetch = options.fetch || globalThis.fetch
  const response = await fetch(endpoint, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      TokenType: 'API_KEY',
      Accept: JSON_ACCEPT,
      'User-Agent': 'AWS-SDK-JS/3.0.0 kiro-ide/1.0.0',
      'x-amz-user-agent': 'aws-sdk-js/3.0.0 kiro-ide/1.0.0',
    },
    ...(options.signal ? { signal: options.signal } : {}),
  })
  if (!response.ok) {
    const text = await readBodyPrefix(response, 1024)
    throw new KiroError(`the API key was refused (${response.status}): ${text.slice(0, 200) || response.statusText}`, ERROR_CODES.auth, { status: response.status })
  }
  let models = []
  try {
    const data = await response.json()
    models = Array.isArray(data?.models) ? data.models : []
  } catch {
    throw new KiroError('the Q catalog returned a non-JSON answer for this key', ERROR_CODES.upstream)
  }
  if (models.length === 0) throw new KiroError('the API key returned no usable models', ERROR_CODES.auth)
  return {
    account: buildAccount({
      authMethod: 'api_key',
      accessToken: apiKey,
      apiKey,
      refreshToken: null,
      // Keys do not rotate; a far horizon keeps the proactive refresh path idle.
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
      profileArn: options.profileArn || null,
      region,
    }),
    models,
  }
}

/**
 * Find credentials the local Kiro IDE already stored.
 *
 * On Windows the desktop app writes two places worth reading:
 * `%USERPROFILE%\.aws\sso\cache` (tokens, plus the client registration file the
 * `clientIdHash` points at) and `%APPDATA%\Kiro\User\globalStorage\kiro.kiroagent\profile.json`
 * (the account's profile ARN). The ARN's region is rewritten to us-east-1
 * because the runtime gateway only accepts that spelling, even for an IDC
 * account that lives elsewhere.
 *
 * @param {{ env?: object, home?: string, platform?: string, readFile?: Function, readdir?: Function }} [options]
 */
export async function discoverLocalCredentials(options = {}) {
  const env = options.env || process.env
  const platform = options.platform || process.platform
  const home = options.home || homedir()
  const readFile = options.readFile || fsReadFile
  const readdir = options.readdir || fsReaddir
  const appData = env.APPDATA || (platform === 'win32' ? join(home, 'AppData', 'Roaming') : resolve(home, '.config'))
  const cacheDirs = [
    env.AWS_SSO_CACHE_PATH,
    join(home, '.aws', 'sso', 'cache'),
  ].filter(Boolean)
  const profileDirs = platform === 'win32'
    ? [join(appData, 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent')]
    : [
        join(appData, 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent'),
        join(home, '.config', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent'),
      ]

  const readJson = async path => {
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch {
      return null
    }
  }

  let refreshToken = null
  let tokenData = null
  let source = null
  for (const dir of cacheDirs) {
    let files = []
    try {
      files = await readdir(dir)
    } catch {
      continue
    }
    const preferred = join(dir, 'kiro-auth-token.json')
    const candidates = files.includes('kiro-auth-token.json') ? [preferred, ...files.filter(name => name.endsWith('.json')).map(name => join(dir, name))] : files.filter(name => name.endsWith('.json')).map(name => join(dir, name))
    for (const path of candidates) {
      const data = await readJson(path)
      if (data?.refreshToken && typeof data.refreshToken === 'string' && data.refreshToken.startsWith('aor')) {
        refreshToken = data.refreshToken
        tokenData = data
        source = path
        break
      }
    }
    if (refreshToken) {
      const clientIdHash = tokenData?.clientIdHash
      if (clientIdHash) {
        const client = await readJson(join(dir, `${clientIdHash}.json`))
        if (client?.clientId && client?.clientSecret) {
          tokenData = { ...tokenData, clientId: client.clientId, clientSecret: client.clientSecret }
        }
      }
      break
    }
  }

  let profileArn = null
  let profileEmail = null
  for (const dir of profileDirs) {
    const data = await readJson(join(dir, 'profile.json'))
    if (data?.arn) {
      profileArn = String(data.arn).replace(/^(arn:aws:codewhisperer:)[^:]+(:)/u, `$1${DEFAULT_REGION}$2`)
      profileEmail = data.email || data.startUrl || null
      break
    }
  }

  if (!refreshToken) {
    return {
      found: false,
      reason: 'no-token',
      message: 'No Kiro token was found in the AWS SSO cache. Sign in inside the Kiro IDE once, or use another auth method.',
      searched: cacheDirs,
    }
  }
  return {
    found: true,
    source,
    refreshToken,
    clientId: tokenData?.clientId || null,
    clientSecret: tokenData?.clientSecret || null,
    region: tokenData?.region || DEFAULT_REGION,
    authMethod: tokenData?.authMethod === 'idc' || tokenData?.startUrl ? 'idc' : 'import',
    profileArn,
    email: profileEmail,
    startUrl: tokenData?.startUrl || null,
  }
}

/** Refresh a locally discovered token once, so the plugin owns a live session. */
export async function adoptLocalCredentials(options = {}) {
  const discovered = options.discovered || await discoverLocalCredentials(options)
  if (!discovered.found) {
    throw new KiroError(discovered.message || 'no local Kiro credential was found', ERROR_CODES.notConfigured)
  }
  const account = await importRefreshToken({
    refreshToken: discovered.refreshToken,
    clientId: discovered.clientId,
    clientSecret: discovered.clientSecret,
    region: discovered.region,
    profileArn: discovered.profileArn,
    authMethod: discovered.authMethod,
    startUrl: discovered.startUrl,
    fetch: options.fetch,
    signal: options.signal,
    log: options.log,
  })
  return { ...account, label: 'Kiro IDE (local)', email: account.email || discovered.email || null }
}
