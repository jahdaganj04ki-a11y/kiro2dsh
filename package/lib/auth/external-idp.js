/**
 * Enterprise / Microsoft Entra ("external_idp") credential support.
 *
 * Organization tenants do not sign in through AWS SSO builder IDs: the Kiro IDE
 * is configured with an IdP, and the resulting token is bound to a profile ARN
 * owned by that tenant. Two things must hold for such a credential to work
 * outside the IDE, and both are enforced here:
 *
 * - the refresh request goes to the tenant's own `token_endpoint`, with
 *   `client_id` and `scope`; the Kiro auth host is not involved at all;
 * - the endpoint must actually be a Microsoft login host. The endpoint arrives
 *   from user-pasted JSON and is then posted a refresh token, so an unvalidated
 *   URL is a credential leak waiting to happen.
 *
 * @module lib/auth/external-idp.js
 */

import { KiroError, ERROR_CODES } from '../errors.js'

/** Hosts allowed to receive a refresh token. */
export const MICROSOFT_TOKEN_HOSTS = Object.freeze([
  'login.microsoftonline.com',
  'login.microsoft.com',
  'login.windows.net',
])

const DEFAULT_REGION = 'us-east-1'
const DEFAULT_EXPIRES_IN = 3600

function trim(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** Reject anything that is not an https Microsoft login endpoint. */
export function validateMicrosoftTokenEndpoint(rawEndpoint) {
  const endpoint = trim(rawEndpoint)
  if (!endpoint) throw new Error('token_endpoint is required')
  let parsed
  try {
    parsed = new URL(endpoint)
  } catch {
    throw new Error('token_endpoint must be a valid URL')
  }
  if (parsed.protocol !== 'https:') throw new Error('token_endpoint must use https')
  if (!MICROSOFT_TOKEN_HOSTS.includes(parsed.hostname.toLowerCase())) {
    throw new Error('token_endpoint must be a Microsoft login endpoint')
  }
  return parsed.toString()
}

/** Scopes arrive as an array or a space-joined string; the wire wants the latter. */
export function normalizeScope(scopes) {
  if (Array.isArray(scopes)) return scopes.map(trim).filter(Boolean).join(' ')
  return trim(scopes)
}

function resolveExpiresAt(input) {
  const explicit = input.expired || input.expires_at || input.expiresAt
  if (explicit) {
    const ms = new Date(explicit).getTime()
    if (Number.isFinite(ms)) return ms
  }
  const expiresIn = Number(input.expires_in || input.expiresIn || 0)
  if (Number.isFinite(expiresIn) && expiresIn > 0) return Date.now() + expiresIn * 1000
  const payload = decodeJwt(input.access_token || input.accessToken)
  if (payload?.exp) return payload.exp * 1000
  return Date.now() + DEFAULT_EXPIRES_IN * 1000
}

function decodeJwt(jwt) {
  if (typeof jwt !== 'string') return null
  const parts = jwt.split('.')
  if (parts.length !== 3) return null
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(Buffer.from(`${base64}${'='.repeat((4 - (base64.length % 4)) % 4)}`, 'base64').toString('utf8'))
  } catch {
    return null
  }
}

/**
 * Normalize a pasted CLIProxyAPI/Kiro auth JSON into an account record.
 * @param {string | object} rawAuth
 * @returns {object} an account record ready to store
 */
export function normalizeExternalIdpAuth(rawAuth) {
  let input = rawAuth
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input)
    } catch {
      throw new KiroError('the pasted auth JSON could not be parsed', ERROR_CODES.invalidCredential)
    }
  }
  if (!input || typeof input !== 'object') {
    throw new KiroError('auth JSON is required', ERROR_CODES.invalidCredential)
  }
  const authMethod = trim(input.auth_method || input.authMethod)
  if (authMethod && authMethod !== 'external_idp') {
    throw new KiroError(`only external_idp auth can be imported this way (got ${authMethod})`, ERROR_CODES.invalidCredential)
  }

  const accessToken = trim(input.access_token || input.accessToken)
  const refreshToken = trim(input.refresh_token || input.refreshToken)
  const clientId = trim(input.client_id || input.clientId)
  const scope = normalizeScope(input.scopes || input.scope)
  const profileArn = trim(input.profile_arn || input.profileArn)
  let tokenEndpoint
  try {
    tokenEndpoint = validateMicrosoftTokenEndpoint(input.token_endpoint || input.tokenEndpoint)
  } catch (error) {
    throw new KiroError(error.message, ERROR_CODES.invalidCredential)
  }

  const missing = [
    [accessToken, 'access_token'],
    [refreshToken, 'refresh_token'],
    [clientId, 'client_id'],
    [scope, 'scopes'],
    [profileArn, 'profile_arn'],
  ].filter(([value]) => !value).map(([, name]) => name)
  if (missing.length > 0) {
    throw new KiroError(`auth JSON is missing ${missing.join(', ')}`, ERROR_CODES.invalidCredential)
  }

  const payload = decodeJwt(accessToken)
  return {
    authMethod: 'external_idp',
    label: 'Enterprise IdP',
    accessToken,
    refreshToken,
    expiresAt: resolveExpiresAt(input),
    email: trim(input.email) || payload?.email || payload?.preferred_username || payload?.upn || payload?.sub || null,
    profileArn,
    region: trim(input.region) || DEFAULT_REGION,
    clientId,
    tokenEndpoint,
    scope,
  }
}

/** Form body for one Entra refresh, with the stored facts echoed back. */
export function buildExternalIdpRefreshParams(refreshToken, account = {}) {
  const clientId = trim(account.clientId || account.client_id)
  const scope = normalizeScope(account.scope || account.scopes)
  let tokenEndpoint
  try {
    tokenEndpoint = validateMicrosoftTokenEndpoint(account.tokenEndpoint || account.token_endpoint)
  } catch (error) {
    throw new Error(error.message)
  }
  if (!refreshToken) throw new Error('refresh token is required')
  if (!clientId) throw new Error('clientId is required for external_idp refresh')
  if (!scope) throw new Error('scope is required for external_idp refresh')
  return {
    tokenEndpoint,
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refreshToken,
      scope,
    }),
  }
}
