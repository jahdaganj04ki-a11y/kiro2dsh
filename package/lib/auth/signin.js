/**
 * One sign-in per auth method, driven through a session interface.
 *
 * Kiro's login surface is not one protocol but four: the device-code flow the IDE
 * uses for Builder ID and Identity Center, Kiro's own `socialLogin` exchange for
 * Google and GitHub, an enterprise IdP's own tokens for `external_idp`, and a
 * static API key for headless use — plus two ways to get an existing credential
 * into the pool (paste a refresh token, or adopt the local Kiro IDE / AWS SSO
 * cache). Every one of them ends the same way: a record committed to the store.
 *
 * The flow is written once against a `session` (`notify` / `prompt` / `signal`)
 * so the DSH authorization seam and the plugin's own HTTP endpoint can both drive
 * it. `prompt` is the resumable part: over HTTP a round-trip cannot stay open for
 * a human, so the coordinator parks the round, answers `awaiting_input`, and
 * resumes when the next request carries the answer.
 *
 * @module lib/auth/signin.js
 */

import {
  adoptLocalCredentials,
  buildAccount,
  buildSocialLoginUrl,
  discoverLocalCredentials,
  exchangeSocialCode,
  generatePkce,
  importRefreshToken,
  parseSocialCallback,
  pollDeviceToken,
  startDeviceAuthorization,
  validateApiKey,
} from './flows.js'
import { normalizeExternalIdpAuth } from './external-idp.js'
import { ERROR_CODES, KiroError } from '../errors.js'
import { AUTH_METHODS } from '../constants.js'

/** Sentinel thrown by a parked prompt; caught by the coordinator, never surfaced. */
class AwaitingInput extends Error {
  /**
   * @param {{ kind: string, message: string, field: string }} request
   */
  constructor(request) {
    super(request.message || 'input required')
    this.name = 'AwaitingInput'
    this.request = request
  }
}

/** Thrown when the human cancels; the caller maps it to `cancelled`. */
export class Declined extends Error {
  constructor(message = 'sign-in cancelled') {
    super(message)
    this.name = 'Declined'
  }
}

const METHOD_ALIASES = Object.freeze({
  'builder-id': 'builder-id',
  'builder-id-social': 'builder-id',
  aws: 'builder-id',
  sso: 'idc',
  'iam-identity-center': 'idc',
  'identity-center': 'idc',
  idc: 'idc',
  entra: 'external_idp',
  azure: 'external_idp',
  okta: 'external_idp',
  'external-idp': 'external_idp',
  'api-key': 'api_key',
  key: 'api_key',
  'refresh-token': 'import',
  token: 'import',
  local: 'auto-import',
  ide: 'auto-import',
  'auto-import': 'auto-import',
})

/** Normalize a method name, accepting the spellings users type. */
export function normalizeMethod(input) {
  const raw = String(input || '').trim().toLowerCase().replace(/[\s_]+/g, '-')
  const aliased = METHOD_ALIASES[raw] || raw
  if (!AUTH_METHODS.includes(aliased)) {
    throw new KiroError(`unknown Kiro auth method "${input}"; expected one of ${AUTH_METHODS.join(', ')}`, ERROR_CODES.rejected)
  }
  return aliased
}

/** Labels a settings panel or CLI can render next to each method. */
export const METHOD_LABELS = Object.freeze({
  'builder-id': 'AWS Builder ID (device code)',
  idc: 'AWS IAM Identity Center',
  google: 'Google',
  github: 'GitHub',
  external_idp: 'Enterprise IdP (Entra / Okta)',
  api_key: 'Kiro API key',
  import: 'Paste a refresh token',
  'auto-import': 'Use my local Kiro session',
})

/** The methods worth offering in a UI, in the order they should be listed. */
export function authMethodEntries() {
  return AUTH_METHODS.map(id => ({ id, label: METHOD_LABELS[id] || id }))
}

/** A session that answers every prompt from a pre-supplied input object. */
export function staticSession(input = {}, onNotify = () => {}) {
  const answers = input || {}
  return {
    method: answers.method,
    ...(answers.signal ? { signal: answers.signal } : {}),
    notify: notice => onNotify(notice),
    prompt: async request => {
      const value = answers[request.field]
      if (value === undefined || value === null || value === '') throw new AwaitingInput(request)
      return typeof value === 'string' ? value.trim() : value
    },
  }
}

/**
 * Run one sign-in to completion, or to the next question.
 *
 * @param {string} method one of `AUTH_METHODS`
 * @param {{
 *   session: { notify(message: object): void, prompt(request: object): Promise<string>, signal?: AbortSignal },
 *   store: object,
 *   state?: object,
 *   settings?: object,
 *   fetch?: Function,
 *   log?: object,
 *   activate?: boolean,
 * }} options
 * @returns {Promise<{ status: 'authorized'|'awaiting_input', account?: object, state?: object, prompt?: object }>}
 */
export async function runSignIn(method, options) {
  const normalized = normalizeMethod(method)
  const session = options.session
  // `state` survives between HTTP rounds, so a device code and its client
  // secret are never re-issued by a client that polls too eagerly.
  const state = { ...(options.state || {}) }
  const settings = options.settings || {}
  const log = options.log
  const transport = {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(session.signal ? { signal: session.signal } : {}),
    ...(log ? { log } : {}),
  }
  const answer = async (field, message, kind = 'text') => {
    const value = await session.prompt({ field, kind, message, required: true })
    if (value === undefined || value === null || value === '') throw new KiroError(`${message} is required`, ERROR_CODES.rejected)
    return value
  }
  const commit = async account => {
    const built = buildAccount({ ...account, authMethod: account.authMethod || normalized, region: account.region || state.region || settings.region })
    // `upsert` assigns the id, so activation has to read it back from there
    // rather than assume a flow handed one over.
    const { id } = await options.store.upsert(built)
    if (options.activate !== false) await options.store.setActive(id)
    log?.info?.(`kiro: signed in via %s; account=%s`, normalized, id)
    return { status: 'authorized', account: { ...built, id }, state: null }
  }

  switch (normalized) {
    case 'builder-id':
    case 'idc':
      return await runDeviceCode(normalized, { session, state, settings, commit, answer, transport, log })

    case 'google':
    case 'github': {
      const pkce = state.codeVerifier
        ? { codeVerifier: state.codeVerifier, codeChallenge: state.codeChallenge, state: state.oauthState }
        : generatePkce()
      Object.assign(state, { codeVerifier: pkce.codeVerifier, codeChallenge: pkce.codeChallenge, oauthState: pkce.state })
      const url = buildSocialLoginUrl({ provider: normalized, codeChallenge: pkce.codeChallenge, state: pkce.state })
      session.notify({
        message: `Sign in with ${normalized === 'google' ? 'Google' : 'GitHub'}, then paste the address the browser lands on (a kiro:// callback or the code inside it).\n${url}`,
        url,
      })
      const callback = await answer('callback', 'Paste the redirect URL or the code from your browser')
      const parsed = parseSocialCallback(callback)
      if (parsed.state && state.oauthState && parsed.state !== state.oauthState) {
        // A stale callback pasted from an older attempt would exchange a code this
        // round never asked for; refusing is cheaper than a confusing 400 later.
        throw new KiroError('that callback belongs to an earlier sign-in attempt; start again', ERROR_CODES.rejected)
      }
      const account = await exchangeSocialCode({ code: parsed.code, codeVerifier: pkce.codeVerifier, provider: normalized, ...transport })
      return await commit(account)
    }

    case 'external_idp': {
      const pasted = await answer('authJson', 'Paste the auth JSON your IdP helper produced (access_token, refresh_token, client_id, scopes, profile_arn, token_endpoint) — or fill the fields below instead')
      try {
        return await commit(normalizeExternalIdpAuth(pasted))
      } catch (error) {
        if (error?.code !== ERROR_CODES.invalidCredential) throw error
        session.notify({ message: `The JSON was not accepted (${error.message}). Falling back to asking for each field.` })
      }
      const tokenEndpoint = await answer('tokenEndpoint', 'Token endpoint, e.g. https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token')
      const clientId = await answer('clientId', 'Application (client) ID')
      const scope = await answer('scopes', 'Scopes, e.g. "api://<app>/.default openid profile offline_access"')
      const profileArn = await answer('profileArn', 'CodeWhisperer profile ARN for this organization')
      const tokens = await answer('tokens', 'Access token and refresh token, separated by a space or a newline')
      const [accessToken, refreshToken] = String(tokens).trim().split(/\s+/)
      return await commit(normalizeExternalIdpAuth({
        auth_method: 'external_idp',
        access_token: accessToken,
        refresh_token: refreshToken,
        client_id: clientId,
        scopes: scope,
        profile_arn: profileArn,
        token_endpoint: tokenEndpoint,
      }))
    }

    case 'api_key': {
      const key = await answer('apiKey', 'Paste your Kiro API key (from the Kiro console)')
      const region = state.region || settings.region || 'us-east-1'
      session.notify({ message: 'Checking the key against the Kiro model catalog…' })
      const validated = await validateApiKey({ apiKey: key, region, ...(settings.profileArn ? { profileArn: settings.profileArn } : {}), ...transport })
      return await commit({ ...validated.account, region: validated.account.region || region })
    }

    case 'import': {
      const raw = await answer('refreshToken', 'Paste the Kiro refresh token (aor… for a social login, aot… for a Builder ID / IdP token)')
      const clientId = settings.clientId || (await session.prompt({ field: 'clientId', kind: 'text', message: 'Client ID — leave blank unless this token came from Kiro\'s OIDC client' })) || ''
      const clientSecret = settings.clientSecret || (clientId ? await answer('clientSecret', 'Client secret for that client ID') : '')
      const account = await importRefreshToken({
        refreshToken: raw,
        ...(clientId ? { clientId } : {}),
        ...(clientSecret ? { clientSecret } : {}),
        ...(settings.region ? { region: settings.region } : {}),
        ...(settings.profileArn ? { profileArn: settings.profileArn } : {}),
        ...transport,
      })
      return await commit(account)
    }

    case 'auto-import': {
      session.notify({ message: 'Looking for a Kiro or AWS SSO session on this machine…' })
      const discovered = await discoverLocalCredentials({ ...transport })
      if (!discovered.found) {
        throw new KiroError(
          `${discovered.message || 'No local Kiro credential was found.'} Searched: ${(discovered.searched || []).join(', ')}`,
          ERROR_CODES.notConfigured,
        )
      }
      const account = await adoptLocalCredentials({ discovered, ...transport })
      const result = await commit(account)
      return { ...result, discovered: { source: discovered.source, email: discovered.email || null } }
    }

    default:
      throw new KiroError(`unsupported auth method ${method}`, ERROR_CODES.rejected)
  }
}

/**
 * The device-authorization grant, shared by Builder ID and Identity Center.
 *
 * Kiro's `device_authorization` + `token` pair is not a single blocking call: the
 * human approves in another browser at unknown latency, so the round returns
 * `awaiting_input` and the caller re-enters with the same state. Each re-entry
 * makes exactly one token request, which is what lets the same code drive a
 * terminal `--no-wait` and a UI with a spinner.
 */
async function runDeviceCode(authMethod, ctx) {
  const { session, state, settings, commit, answer, transport, log } = ctx
  // Only an organization needs a start URL; Builder ID deliberately omits it,
  // because sending one makes Kiro answer with the IdP's own error page.
  const startUrl = authMethod === 'idc' && !state.startUrl
    ? await answer('startUrl', 'Your Identity Center start URL (for example https://viewcenter.awsapps.com/start)')
    : state.startUrl
  if (startUrl) state.startUrl = startUrl

  if (!state.deviceCode) {
    session.notify({ message: 'Requesting a device code from Kiro…' })
    const device = await startDeviceAuthorization({
      region: settings.region,
      authMethod,
      ...(startUrl ? { startUrl } : {}),
      ...(settings.clientId && settings.clientSecret ? { clientId: settings.clientId, clientSecret: settings.clientSecret } : {}),
      ...transport,
    })
    Object.assign(state, {
      deviceCode: device.deviceCode,
      userCode: device.userCode,
      verificationUri: device.verificationUriComplete || device.verificationUri,
      clientId: device.clientId,
      clientSecret: device.clientSecret,
      region: device.region,
      expiresInSeconds: device.expiresInSeconds,
      intervalSeconds: device.intervalSeconds,
      defaultProfileArn: device.defaultProfileArn,
      startedAt: Date.now(),
    })
    session.notify({
      message: `Open ${state.verificationUri} and enter ${state.userCode} to finish signing in.`,
      url: state.verificationUri,
      code: state.userCode,
    })
  }

  if (Date.now() - (state.startedAt || Date.now()) > (state.expiresInSeconds || 600) * 1000) {
    throw new KiroError('the device code expired before it was approved; start the sign-in again', ERROR_CODES.refreshExpired, { state: null })
  }

  const polled = await pollDeviceToken({
    clientId: state.clientId,
    clientSecret: state.clientSecret,
    deviceCode: state.deviceCode,
    region: state.region,
    authMethod,
    ...(state.startUrl ? { startUrl: state.startUrl } : {}),
    ...(settings.profileArn ? { profileArn: settings.profileArn } : {}),
    ...transport,
  })
  if (polled.status === 'authorized') {
    return await commit({
      ...polled.account,
      // An organization account must keep the ARN its own token names; the
      // builder-id placeholder is only a fallback for personal accounts.
      profileArn: polled.account.profileArn || state.profileArn || null,
      defaultProfileArn: state.defaultProfileArn || undefined,
    })
  }
  if (polled.status === 'pending' || polled.status === 'slow_down') {
    return {
      status: 'awaiting_input',
      state,
      prompt: {
        field: 'wait',
        kind: 'text',
        message: `Waiting for you to approve ${state.userCode} at ${state.verificationUri}. Continue once that is done.`,
        polling: { intervalMs: (polled.status === 'slow_down' ? (state.intervalSeconds || 5) + 5 : state.intervalSeconds || 5) * 1000 },
      },
    }
  }
  if (polled.status === 'declined') throw new Declined('the sign-in was declined in the browser')
  if (polled.status === 'expired') {
    throw new KiroError('the device code expired before it was approved; start the sign-in again', ERROR_CODES.refreshExpired)
  }
  log?.warn?.(`kiro: device authorization failed: ${polled.error?.message || 'unknown'}`)
  throw new KiroError(polled.error?.message || 'Kiro refused the device authorization', polled.error?.code || ERROR_CODES.endpoint)
}

/**
 * Park-and-resume coordinator for HTTP callers.
 *
 * @param {{ store: object, settings?: () => object, fetch?: Function, log?: object, ttlMs?: number }} deps
 * @returns {{ round(input: object): Promise<object>, cancel(stateId: string): void, pending(): string[] }}
 */
export function createSignInCoordinator(deps) {
  const rounds = new Map()
  const ttl = Number.isFinite(deps.ttlMs) && deps.ttlMs > 0 ? deps.ttlMs : 10 * 60_000

  const round = async input => {
    const method = normalizeMethod(input?.method)
    const id = typeof input?.stateId === 'string' && input.stateId ? input.stateId : `kiro-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    const existing = rounds.get(id)
    const merged = { ...(existing?.answers || {}), ...(input?.input || {}) }
    if (existing?.timer) clearTimeout(existing.timer)
    const notices = []
    const session = {
      method,
      notify: notice => notices.push({ ...notice, at: Date.now() }),
      prompt: async request => {
        const value = merged[request.field]
        if (value === undefined || value === null || value === '') {
          rounds.set(id, {
            state: session.state || {},
            answers: merged,
            request,
            timer: setTimeout(() => rounds.delete(id), ttl),
          })
          rounds.get(id).timer.unref?.()
          throw new AwaitingInput(request)
        }
        delete merged[request.field]
        return typeof value === 'string' ? value.trim() : value
      },
      ...(input?.signal ? { signal: input.signal } : {}),
      state: existing?.state || {},
    }
    try {
      const result = await runSignIn(method, {
        session,
        store: deps.store,
        state: session.state,
        settings: { ...(deps.settings?.() || {}), ...(input?.settings || {}) },
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.log ? { log: deps.log } : {}),
      })
      rounds.delete(id)
      return { ...result, stateId: null, notices, ...(result.state ? { state: result.state } : {}) }
    } catch (error) {
      if (error instanceof AwaitingInput) {
        const parked = rounds.get(id)
        if (parked) parked.state = session.state
        return {
          status: 'awaiting_input',
          stateId: id,
          prompt: error.request,
          notices,
          ...(session.state.userCode ? { userCode: session.state.userCode, url: session.state.verificationUri } : {}),
        }
      }
      rounds.delete(id)
      if (error instanceof Declined) return { status: 'declined', notices }
      const kiro = error instanceof KiroError ? error : new KiroError(error?.message || String(error), ERROR_CODES.auth)
      return { status: 'failed', error: { message: kiro.message, code: kiro.code, ...(kiro.status ? { status: kiro.status } : {}) }, notices }
    }
  }

  return {
    round,
    cancel: id => {
      const entry = rounds.get(id)
      if (entry?.timer) clearTimeout(entry.timer)
      rounds.delete(id)
    },
    pending: () => [...rounds.keys()],
  }
}
