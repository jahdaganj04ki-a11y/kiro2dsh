/**
 * The Kiro account store: an append-only-ish pool kept in the harness
 * credential record, not in a plugin-local JSON file.
 *
 * Two decisions are worth their reasons:
 *
 * 1. **Storage.** `ctx.credentials` owns the write lock and survives an app
 *    upgrade, and its `modifyRecord` is a serialized read-modify-write across
 *    processes. Rotating an AWS SSO refresh token is exactly a read-decide-
 *    replace, so a self-managed file in the profile directory would be a
 *    corruption bug waiting for two Harness instances.
 * 2. **A pool, not one account.** Kiro's rate limits are per credential. Keeping
 *    every signed-in account in registration order lets a 429 move to the next
 *    one instead of failing the turn, which is the only spreading the upstream
 *    actually honours.
 *
 * @module lib/auth/store
 */

import { DEFAULT_REGION, REFRESH_LEAD_MS } from '../constants.js'
import { ERROR_CODES, KiroError } from '../errors.js'
import { redact } from '../util.js'
import { needsRefresh, refreshKiroToken } from './token-refresh.js'

/** Record schema version; bump it and migrate in `read`. */
export const STORE_VERSION = 1

const SECRET_FIELDS = ['accessToken', 'refreshToken', 'clientSecret', 'apiKey']

/** One stable id for an account, derived from the credential rather than a counter. */
export function accountId(account) {
  const seed = account?.apiKey
    || account?.refreshToken
    || account?.accessToken
    || `${account?.authMethod || 'kiro'}:${account?.email || 'anonymous'}`
  return `kiro-${Buffer.from(String(seed).slice(-24)).toString('hex').slice(0, 16)}`
}

/** Blank pool. */
export function emptyStore() {
  return { version: STORE_VERSION, activeId: null, accounts: [] }
}

/**
 * Normalize anything read from storage (or typed into the panel) into a pool.
 * Unknown fields are dropped so a downgraded plugin cannot write junk forward.
 */
export function normalizeStore(input) {
  if (!input || typeof input !== 'object') return emptyStore()
  const accounts = Array.isArray(input.accounts) ? input.accounts : []
  const next = {
    version: STORE_VERSION,
    activeId: typeof input.activeId === 'string' ? input.activeId : null,
    accounts: accounts.filter(account => account && typeof account === 'object').map(account => ({
      id: typeof account.id === 'string' && account.id ? account.id : accountId(account),
      label: typeof account.label === 'string' ? account.label : 'Kiro',
      authMethod: account.authMethod || 'import',
      email: account.email || null,
      accessToken: typeof account.accessToken === 'string' ? account.accessToken : '',
      ...(typeof account.refreshToken === 'string' ? { refreshToken: account.refreshToken } : {}),
      ...(Number.isFinite(account.expiresAt) ? { expiresAt: account.expiresAt } : {}),
      ...(account.profileArn ? { profileArn: account.profileArn } : {}),
      region: account.region || DEFAULT_REGION,
      ...(account.clientId ? { clientId: account.clientId } : {}),
      ...(account.clientSecret ? { clientSecret: account.clientSecret } : {}),
      ...(account.startUrl ? { startUrl: account.startUrl } : {}),
      ...(account.scope ? { scope: account.scope } : {}),
      ...(account.tokenEndpoint ? { tokenEndpoint: account.tokenEndpoint } : {}),
      ...(account.apiKey ? { apiKey: account.apiKey } : {}),
      ...(account.defaultProfileArn ? { defaultProfileArn: account.defaultProfileArn } : {}),
      enabled: account.enabled !== false,
      createdAt: account.createdAt || new Date().toISOString(),
      updatedAt: account.updatedAt || account.createdAt || new Date().toISOString(),
      ...(account.lastError ? { lastError: account.lastError } : {}),
      ...(Number.isFinite(account.lastUsedAt) ? { lastUsedAt: account.lastUsedAt } : {}),
    })),
  }
  if (next.accounts.length > 0 && !next.accounts.some(account => account.id === next.activeId)) {
    next.activeId = next.accounts.find(account => account.enabled)?.id || next.accounts[0].id
  }
  if (next.accounts.length === 0) next.activeId = null
  return next
}

/**
 * Build the store over an injected persistence pair.
 *
 * @param {{
 *   read: () => Promise<object|null>,
 *   mutate: (fn: (current: object|null) => object|null|undefined) => Promise<unknown>,
 *   log?: object,
 *   refresh?: typeof refreshKiroToken,
 *   resolveProfileArn?: (credentials: object) => Promise<string|null>,
 *   fetch?: typeof globalThis.fetch,
 *   now?: () => number,
 * }} options
 */
export function createAccountStore(options) {
  const log = options.log
  const refresh = options.refresh || refreshKiroToken
  const now = options.now || (() => Date.now())
  /** Single-flight guard so two turns on one process never refresh in parallel. */
  let refreshing = null

  const readStore = async () => normalizeStore(await options.read().catch(() => null))

  const writeStore = async next => {
    const candidate = normalizeStore(next)
    await options.mutate(() => candidate)
    return candidate
  }

  /**
   * Apply `fn` to the current pool under the store's own lock.
   * @param {(store: object) => object|void|Promise<object|void>} fn
   * @returns {Promise<object>} the pool after the write (or the untouched read)
   */
  const transact = async fn => {
    const current = await readStore()
    const next = await fn(current)
    if (next === undefined || next === null) return current
    return await writeStore(next)
  }

  /** Add or replace one account, and make it the active one when none was. */
  const upsert = async account => {
    const stored = { ...account, id: account.id || accountId(account) }
    const next = await transact(store => {
      const index = store.accounts.findIndex(existing => existing.id === stored.id)
      const accounts = [...store.accounts]
      accounts[index >= 0 ? index : accounts.length] = {
        ...(index >= 0 ? accounts[index] : {}),
        ...stored,
        updatedAt: new Date(now()).toISOString(),
      }
      const activeId = index >= 0 ? store.activeId : (store.activeId && accounts.some(a => a.id === store.activeId && a.enabled) ? store.activeId : stored.id)
      return { ...store, accounts, activeId }
    })
    return { id: stored.id, store: next }
  }

  const setActive = async id => await transact(store => {
    if (!store.accounts.some(account => account.id === id)) {
      throw new KiroError(`no Kiro account with id ${id}`, ERROR_CODES.notConfigured)
    }
    return { ...store, activeId: id }
  })

  const setEnabled = async (id, enabled) => await transact(store => {
    if (!store.accounts.some(account => account.id === id)) {
      throw new KiroError(`no Kiro account with id ${id}`, ERROR_CODES.notConfigured)
    }
    const accounts = store.accounts.map(account => account.id === id ? { ...account, enabled: Boolean(enabled) } : account)
    const activeId = enabled ? store.activeId : (store.activeId === id ? (accounts.find(account => account.enabled)?.id || null) : store.activeId)
    return { ...store, accounts, activeId }
  })

  const remove = async id => await transact(store => {
    const accounts = store.accounts.filter(account => account.id !== id)
    const activeId = store.activeId === id ? (accounts.find(account => account.enabled)?.id || accounts[0]?.id || null) : store.activeId
    return { ...store, accounts, activeId }
  })

  const clear = async () => await writeStore(emptyStore())

  /** Record why an account last failed, so the panel can name it. */
  const noteFailure = async (id, error) => {
    const lastError = {
      code: error?.code || ERROR_CODES.upstream,
      message: redact(String(error?.message || error)).slice(0, 300),
      at: new Date(now()).toISOString(),
      ...(Number.isFinite(error?.status) ? { status: error.status } : {}),
    }
    await transact(store => ({
      ...store,
      accounts: store.accounts.map(account => account.id === id ? { ...account, lastError } : account),
    }))
  }

  /** Patch fields onto one account without a read-modify-write race. */
  const patch = async (id, fields) => await transact(store => ({
    ...store,
    accounts: store.accounts.map(account => account.id === id ? { ...account, ...fields, updatedAt: new Date(now()).toISOString() } : account),
  }))

  /**
   * Persist one refresh result.
   *
   * The write goes through `mutate` with a fresh read rather than the pool the
   * caller saw: a token rotated while this refresh was in flight would otherwise
   * be overwritten by a stale snapshot and invalidate the account.
   */
  const persistRefresh = async (id, patchValue) => await options.mutate(current => {
    const store = normalizeStore(current)
    const index = store.accounts.findIndex(account => account.id === id)
    if (index < 0) return undefined
    const accounts = [...store.accounts]
    accounts[index] = { ...accounts[index], ...patchValue, lastError: undefined, lastUsedAt: now(), updatedAt: new Date(now()).toISOString() }
    return { ...store, accounts }
  })

  /**
   * One account (the active one by default), with a usable access token.
   * @param {string} [requestedId] account to authorize; the active account when omitted
   */
  const authorize = async (requestedId) => {
    const store = await readStore()
    const active = (requestedId ? store.accounts.find(account => account.id === requestedId) : null)
      || store.accounts.find(account => account.id === store.activeId && account.enabled)
      || store.accounts.find(account => account.enabled)
    if (!active) throw new KiroError('no Kiro account is signed in', ERROR_CODES.notConfigured)
    if (active.authMethod === 'api_key' && !active.accessToken && !active.apiKey) {
      throw new KiroError('the API key account has no stored key', ERROR_CODES.invalidCredential)
    }
    if (!active.accessToken) throw new KiroError('this Kiro account has no access token; sign in again', ERROR_CODES.auth)
    if (!needsRefresh(active, now())) return { account: active, store }

    // Collapse concurrent refreshes for one account into a single rotation.
    if (refreshing && refreshing.id === active.id) {
      await refreshing.promise
      const refreshed = await readStore()
      const account = refreshed.accounts.find(candidate => candidate.id === active.id) || active
      return { account, store: refreshed }
    }
    const promise = (async () => {
      const patchValue = await refresh({
        account: active,
        log,
        fetch: options.fetch,
        ...(options.resolveProfileArn ? { resolveProfileArn: options.resolveProfileArn } : {}),
      })
      if (!patchValue?.accessToken) return null
      await persistRefresh(active.id, patchValue)
      return patchValue
    })()
    refreshing = { id: active.id, promise }
    let applied = null
    try {
      applied = await promise
    } catch (error) {
      await noteFailure(active.id, error).catch(() => {})
      if (error instanceof KiroError && error.code === ERROR_CODES.refreshExpired) {
        throw new KiroError(`${error.message} (account ${active.label || active.id})`, ERROR_CODES.refreshExpired)
      }
      // A network blip during refresh must not waste a token that may still be
      // valid for minutes, so the stale token stays in play and the turn goes on.
      log?.warn?.(`kiro: token refresh failed; continuing with the stored token (${error?.message || error})`)
    } finally {
      refreshing = null
    }
    if (applied) return { account: { ...active, ...applied }, store }
    return { account: active, store }
  }

  /**
   * Every usable account for quota spreading, active one first.
   * @param {string} [preferredId] put this account first for one call
   */
  const candidates = async (preferredId) => {
    const store = await readStore()
    const enabled = store.accounts.filter(account => account.enabled && (account.accessToken || account.apiKey))
    const index = enabled.findIndex(account => account.id === (preferredId || store.activeId))
    if (index > 0) enabled.unshift(...enabled.splice(index, 1))
    return enabled
  }

  /** Secret-free view for the settings panel and the status route. */
  const describe = async () => {
    const store = await readStore()
    const timestamp = now()
    return {
      activeId: store.activeId,
      accounts: store.accounts.map(account => describeAccount(account, timestamp)),
      configured: store.accounts.some(account => account.enabled),
    }
  }

  return { readStore, transact, upsert, setActive, setEnabled, remove, clear, patch, authorize, candidates, describe, noteFailure }
}

/** Public account view: identities and state, never a token. */
export function describeAccount(account, now = Date.now()) {
  const expiresAt = Number(account.expiresAt)
  return {
    id: account.id,
    label: account.label,
    authMethod: account.authMethod,
    email: account.email || null,
    region: account.region || DEFAULT_REGION,
    enabled: account.enabled !== false,
    hasProfileArn: Boolean(account.profileArn),
    profileArn: account.profileArn || null,
    hasClientId: Boolean(account.clientId),
    hasRefreshToken: Boolean(account.refreshToken),
    hasAccessToken: Boolean(account.accessToken),
    tokenType: account.apiKey ? 'API_KEY' : account.accessToken ? 'BEARER' : 'NONE',
    secretTails: Object.fromEntries(SECRET_FIELDS
      .filter(field => typeof account[field] === 'string' && account[field].length > 0)
      .map(field => [field, `…${String(account[field]).slice(-4)}`])),
    expiresAt: Number.isFinite(expiresAt) ? new Date(expiresAt).toISOString() : null,
    expiresInSeconds: Number.isFinite(expiresAt) ? Math.max(0, Math.round((expiresAt - now) / 1000)) : null,
    needsRefresh: needsRefresh(account, now, REFRESH_LEAD_MS),
    createdAt: account.createdAt || null,
    updatedAt: account.updatedAt || null,
    lastError: account.lastError || null,
  }
}
