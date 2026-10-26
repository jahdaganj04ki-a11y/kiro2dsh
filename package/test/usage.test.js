/**
 * Quota reporting: what a spent account looks like from the outside.
 *
 * Kiro meters an account, not a call, and the answer is only ever decoration for
 * the Models page and the bridge's status route — so the property worth locking
 * down is that a quota read can never fail a conversation, and never shows one
 * account's balance to another.
 *
 * @module test/usage.test.js
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createUsageProvider, formatUsage, toUsageSnapshot, USAGE_TTL_MS } from '../lib/usage.js'
import { recordingLogger } from './helpers.js'

const RESET = '2026-11-01T00:00:00.000Z'

const DEFAULT_CREDENTIALS = { accessToken: 'a'.repeat(40), region: 'us-east-1', authMethod: 'builder-id' }

/** A provider whose upstream is one scripted `Response`. */
function providerFor({ response, credentials = DEFAULT_CREDENTIALS, fetch, now, ttlMs } = {}) {
  const calls = []
  const provider = createUsageProvider({
    credentialsFor: async () => credentials,
    fetch: fetch || (async (url) => {
      calls.push(String(url))
      return response === undefined
        ? new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
        : response
    }),
    log: recordingLogger(),
    ...(now ? { now } : {}),
    ...(ttlMs ? { ttlMs } : {}),
  })
  return { provider, calls }
}

/** The raw `getUsageLimits` body, in Kiro's own field names. */
function usageResponse({ used = 0, limit = 9, plan = 'Kiro Pro', trial = null, reset = null } = {}) {
  return new Response(JSON.stringify({
    subscriptionInfo: { subscriptionTitle: plan },
    ...(reset ? { nextDateReset: reset } : {}),
    usageBreakdownList: [{
      resourceType: 'AGENTIC_REQUEST',
      currentUsage: used,
      usageLimit: limit,
      ...(trial ? { freeTrialInfo: { currentUsage: trial.used, usageLimit: trial.limit, freeTrialExpiry: trial.expiry } } : {}),
    }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

test('the agentic meter is headlined, and the trial copy of it is not double-counted', () => {
  const snapshot = toUsageSnapshot({
    plan: 'Kiro Pro',
    quotas: {
      agent_request: { used: 40, total: 200, remaining: 160, resetAt: RESET },
      agent_request_freetrial: { used: 1, total: 50 },
      ai_editor: { used: 5, total: 100 },
    },
  }, 1000)
  assert.equal(snapshot.limit, 200)
  assert.equal(snapshot.used, 40)
  assert.equal(snapshot.remaining, 160)
  assert.equal(snapshot.plan, 'Kiro Pro')
  assert.equal(snapshot.trial, true)
  assert.equal(snapshot.resetAt, Date.parse(RESET))
  assert.equal(snapshot.fetchedAt, 1000)
  assert.deepEqual(snapshot.breakdown.map(entry => entry.resourceType), ['agent_request', 'ai_editor'])
  assert.equal(snapshot.error, null)
})

test('a renamed meter falls back to the largest allowance, never the smallest', () => {
  const snapshot = toUsageSnapshot({
    quotas: {
      code_reference: { used: 1, total: 10 },
      agentic_request: { used: 3, total: 900 },
    },
  })
  assert.equal(snapshot.limit, 900)
  assert.equal(snapshot.used, 3)
  // `remaining` is derived when the upstream answer omits it, clamped at zero.
  assert.equal(toUsageSnapshot({ quotas: { agent_request: { used: 300, total: 200 } } }).remaining, 0)
  // A meter with no numbers at all stays null rather than inventing zero.
  assert.equal(toUsageSnapshot({ quotas: { agent_request: {} } }).used, null)
})

test('unlimited and missing numbers are said plainly', () => {
  const unlimited = toUsageSnapshot({ quotas: { agent_request: { used: 12, unlimited: true, resetAt: 123 } } })
  assert.equal(unlimited.unlimited, true)
  assert.equal(unlimited.limit, null)
  assert.equal(unlimited.resetAt, 123, 'a numeric reset is kept as it is')

  assert.equal(toUsageSnapshot({ quotas: {} }).error, 'Kiro reported no usage breakdown for this account')
  assert.deepEqual(toUsageSnapshot({ quotas: {} }).breakdown, [])
  assert.equal(toUsageSnapshot(null).error, 'Kiro did not report usage limits for this account')
})

test('the panel line is readable in every state', () => {
  assert.equal(formatUsage(toUsageSnapshot({ plan: 'Pro', quotas: { agent_request: { used: 40, total: 200, remaining: 160 } } })), 'Pro · 40 / 200 used')
  assert.equal(formatUsage(toUsageSnapshot({ plan: 'Pro', quotas: { agent_request: { used: 40, total: 200 }, agent_request_freetrial: {} } })), 'Pro (trial) · 40 / 200 used')
  assert.equal(formatUsage(toUsageSnapshot({ quotas: { agent_request: { unlimited: true } } })), 'unlimited')
  assert.equal(formatUsage(toUsageSnapshot({ plan: 'Pro', quotas: { agent_request: { unlimited: true } } })), 'Pro · unlimited')
  assert.equal(formatUsage(toUsageSnapshot({ quotas: { agent_request: { used: 7 } } })), '7 used')
  assert.equal(formatUsage(toUsageSnapshot(null)), 'Quota unavailable')
  assert.equal(formatUsage(null), 'Quota unavailable')
  assert.equal(formatUsage(toUsageSnapshot(null), key => `[${key}]`), '[usage.unavailable]')
  const resetting = toUsageSnapshot({ quotas: { agent_request: { used: 1, total: 2, resetAt: RESET } } })
  assert.match(formatUsage(resetting), /resets /u)
})

test('a quota read is cached for a minute and shared with concurrent callers', async () => {
  let clock = 10_000
  const calls = []
  let release
  const gate = new Promise(resolve => { release = resolve })
  const provider = createUsageProvider({
    credentialsFor: async () => DEFAULT_CREDENTIALS,
    fetch: async (url) => {
      calls.push(String(url))
      await gate
      return usageResponse({ used: calls.length })
    },
    log: recordingLogger(),
    now: () => clock,
  })
  const first = provider.get()
  const second = provider.get()
  await Promise.resolve()
  release()
  assert.deepEqual(await first, await second)
  assert.equal(calls.length, 1, 'one in-flight request serves both askers')

  clock += USAGE_TTL_MS - 1
  assert.equal((await provider.get()).used, 1)
  assert.equal(calls.length, 1, 'still inside the window')
  clock += 2
  assert.equal((await provider.get()).used, 2)
  assert.equal(calls.length, 2)
  await provider.get(true)
  assert.equal(calls.length, 3, 'a forced read ignores the cache')
})

test('a quota endpoint that is down degrades to no information', async () => {
  const signedOut = providerFor({ credentials: null })
  assert.equal((await signedOut.provider.get()).error, 'Kiro did not report usage limits for this account')
  assert.equal(signedOut.calls.length, 0, 'no credentials, no request')

  // Both surfaces are tried; when neither answers the snapshot says so and the
  // caller shows "quota unavailable" instead of failing.
  const refused = providerFor({ fetch: async (url) => { refused.calls.push(String(url)); return new Response('nope', { status: 503 }) } })
  const snapshot = await refused.provider.get()
  assert.equal(refused.calls.length, 2, 'the CodeWhisperer host and the q host')
  assert.match(refused.calls[0], /^https:\/\/codewhisperer\.us-east-1\.amazonaws\.com\/getUsageLimits/u)
  assert.match(refused.calls[1], /^https:\/\/q\.us-east-1\.amazonaws\.com\/getUsageLimits/u)
  assert.equal(snapshot.error, 'Kiro did not report usage limits for this account')
  assert.equal(snapshot.used, null)

  // A credential store that itself fails is reported, not thrown at the panel.
  const locked = createUsageProvider({
    credentialsFor: async () => { throw new Error('keychain locked') },
    log: recordingLogger(),
  })
  assert.equal((await locked.get()).error, 'keychain locked')
  assert.equal((await locked.describe()).error, 'keychain locked')
})

test('a signed-in account is read through the host for its own region', async () => {
  const { provider, calls } = providerFor({
    credentials: { accessToken: 'a'.repeat(40), region: 'eu-central-1', profileArn: 'arn:aws:codewhisperer:eu-central-1:1:profile/X' },
    fetch: async (url) => { calls.push(String(url)); return usageResponse({ used: 1, limit: 2 }) },
  })
  const snapshot = await provider.get()
  assert.equal(snapshot.used, 1)
  assert.ok(calls[0].includes('eu-central-1'))
  const described = await provider.describe()
  assert.deepEqual(Object.keys(described).sort(), ['breakdown', 'error', 'fetchedAt', 'limit', 'plan', 'remaining', 'resetAt', 'trial', 'used'])
})

test('switching accounts is not answered with the previous account\u2019s quota', async () => {
  let credentials = { id: 'kiro-one', accessToken: `a${'1'.repeat(39)}`, region: 'us-east-1' }
  const seen = []
  const provider = createUsageProvider({
    credentialsFor: async () => credentials,
    fetch: async (url) => {
      seen.push(String(url))
      return usageResponse({ used: seen.length })
    },
    log: recordingLogger(),
  })
  assert.equal((await provider.get()).used, 1)
  assert.equal((await provider.get()).used, 1, 'cached')
  assert.equal(seen.length, 1)
  credentials = { id: 'kiro-two', accessToken: `a${'1'.repeat(39)}`, region: 'eu-central-1' }
  assert.equal((await provider.get()).used, 2, 'another account on the same token is asked separately')
  assert.ok(seen[1].includes('eu-central-1'), 'in its own region')

  // A re-login under the same id rotates the token, and the numbers move with it.
  credentials = { id: 'kiro-two', accessToken: `b${'2'.repeat(39)}`, region: 'eu-central-1' }
  assert.equal((await provider.get()).used, 3)
})
