/**
 * Credit and quota reporting for the active Kiro account.
 *
 * Kiro meters a signed-in user, not a model call: `getUsageLimits` answers with
 * a per-resource breakdown (`AGENTIC_REQUEST`, `AI_EDITOR`, …) and the moment the
 * window resets. A harness only needs three things from that — what is spent,
 * what is left, and when it refreshes — so this module collapses the breakdown
 * into those numbers, keeps them short-lived in memory, and degrades to "no
 * quota information" when the endpoint refuses, rather than failing a turn that
 * would otherwise have worked.
 *
 * @module lib/usage.js
 */

import { fetchUsageLimits } from './kiro/catalog-api.js'

/** Quota answers go stale quickly; a minute is long enough to survive a burst. */
export const USAGE_TTL_MS = 60_000

/**
 * @typedef {object} UsageSnapshot
 * @property {number|null} limit allowance for the current window
 * @property {number|null} used consumed in the current window
 * @property {number|null} remaining `limit - used`, clamped at zero
 * @property {number|null} resetAt epoch ms of the next reset
 * @property {string|null} plan subscription title reported by Kiro
 * @property {boolean} trial whether the account is on a free trial
 * @property {boolean} [unlimited] whether Kiro reported no cap for this meter
 * @property {object[]} breakdown per-resource usage as Kiro returned it
 * @property {number} fetchedAt epoch ms of the upstream call
 * @property {string|null} error why the numbers are missing, when they are
 */

/**
 * Fold one `getUsageLimits` response into the snapshot the UI and the bridge show.
 *
 * `normalizeUsage` already keyed everything by resource type (`agent_request`,
 * `agent_request_freetrial`, …) with `used`/`total`/`remaining`, so this only has
 * to choose which meter to headline and turn an ISO reset into an epoch.
 *
 * @param {object|null} data normalized usage from `fetchUsageLimits`
 * @param {number} [fetchedAt]
 * @returns {UsageSnapshot}
 */
export function toUsageSnapshot(data, fetchedAt = Date.now()) {
  if (!data || !data.quotas || Object.keys(data.quotas).length === 0) {
    return {
      limit: null,
      used: null,
      remaining: null,
      resetAt: null,
      plan: typeof data?.plan === 'string' ? data.plan : null,
      trial: false,
      breakdown: [],
      fetchedAt,
      error: data ? 'Kiro reported no usage breakdown for this account' : 'Kiro did not report usage limits for this account',
    }
  }
  const number = value => (Number.isFinite(Number(value)) ? Number(value) : null)
  const entries = Object.entries(data.quotas).filter(([key]) => !key.endsWith('_freetrial'))
  // The agentic meter is what a harness drains. When Kiro renames it, headline
  // the largest allowance instead: an under-reported quota sends users to buy
  // capacity they already have.
  const headline = entries.find(([key]) => key === 'agent_request' || key === 'agentic_request')
    || entries.slice().sort((left, right) => (number(right[1]?.total) ?? 0) - (number(left[1]?.total) ?? 0))[0]
  const [resourceType, quota] = headline || [null, {}]
  const freeTrial = entries.length > 0 && data.quotas[`${resourceType}_freetrial`]
  return {
    limit: number(quota.total),
    used: number(quota.used),
    remaining: number(quota.remaining) ?? (quota.total == null || quota.used == null ? null : Math.max(0, Number(quota.total) - Number(quota.used))),
    resetAt: toEpoch(quota.resetAt),
    plan: typeof data.plan === 'string' && data.plan ? data.plan : null,
    trial: Boolean(freeTrial),
    unlimited: quota.unlimited === true,
    breakdown: entries.map(([key, value]) => ({
      resourceType: key,
      used: number(value?.used),
      limit: number(value?.total),
      remaining: number(value?.remaining),
      resetAt: toEpoch(value?.resetAt),
    })),
    fetchedAt,
    error: null,
  }
}

/** ISO timestamp → epoch ms, or null. */
function toEpoch(value) {
  if (!value) return null
  const ms = typeof value === 'number' ? value : Date.parse(String(value))
  return Number.isFinite(ms) ? ms : null
}

/**
 * Build a cached usage provider bound to one credential source.
 *
 * @param {{
 *   credentialsFor: () => Promise<{ accessToken?: string, refreshToken?: string, apiKey?: string, region?: string, profileArn?: string, authMethod?: string } | null>,
 *   fetch?: typeof globalThis.fetch,
 *   log?: object,
 *   now?: () => number,
 *   ttlMs?: number,
 * }} deps
 * @returns {{ get(force?: boolean): Promise<UsageSnapshot>, describe(): Promise<object> }}
 */
export function createUsageProvider(deps) {
  const ttl = Number.isFinite(deps.ttlMs) && deps.ttlMs > 0 ? deps.ttlMs : USAGE_TTL_MS
  const now = deps.now || (Date.now.bind(Date.now))
  let cache = { key: null, at: 0, snapshot: null }
  let pending = null

  const get = async (force = false) => {
    const credentials = await deps.credentialsFor?.()
    if (!credentials || (!credentials.accessToken && !credentials.apiKey)) return toUsageSnapshot(null, now())
    const key = `${credentials.region || ''}|${credentials.profileArn || ''}|${(credentials.accessToken || credentials.apiKey).slice(-12)}`
    if (!force && cache.key === key && now() - cache.at < ttl && cache.snapshot) return cache.snapshot
    if (pending) return pending
    pending = (async () => {
      try {
        const data = await fetchUsageLimits({
          credentials,
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
          ...(deps.log ? { log: deps.log } : {}),
        })
        cache = { key, at: now(), snapshot: toUsageSnapshot(data, now()) }
        return cache.snapshot
      } finally {
        pending = null
      }
    })()
    return pending
  }

  return {
    get,
    describe: async () => {
      const snapshot = await get()
      return {
        plan: snapshot.plan,
        trial: snapshot.trial,
        used: snapshot.used,
        limit: snapshot.limit,
        remaining: snapshot.remaining,
        resetAt: snapshot.resetAt,
        breakdown: snapshot.breakdown,
        error: snapshot.error,
        fetchedAt: snapshot.fetchedAt,
      }
    },
  }
}

/**
 * Human-readable quota line for the settings panel.
 * @param {UsageSnapshot} snapshot
 * @param {(key: string, values?: object) => string} [t] locale formatter
 * @returns {string}
 */
export function formatUsage(snapshot, t) {
  if (!snapshot || snapshot.error) return t ? t('usage.unavailable') : 'Quota unavailable'
  const used = Number.isFinite(snapshot.used) ? snapshot.used : null
  const limit = Number.isFinite(snapshot.limit) ? snapshot.limit : null
  if (snapshot.unlimited) return snapshot.plan ? `${snapshot.plan} · unlimited` : 'unlimited'
  const core = used === null ? 'usage unknown' : limit === null ? `${used} used` : `${used} / ${limit} used`
  const plan = snapshot.plan ? `${snapshot.plan}${snapshot.trial ? ' (trial)' : ''} · ` : ''
  const reset = Number.isFinite(snapshot.resetAt)
    ? ` · resets ${new Date(snapshot.resetAt).toLocaleString()}`
    : ''
  return `${plan}${core}${reset}`
}
