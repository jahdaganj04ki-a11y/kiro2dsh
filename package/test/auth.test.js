/**
 * Credential refresh and the account pool.
 *
 * These two modules decide whether a turn can be authorised at all, and they are
 * where the seven sign-in methods diverge: each one refreshes at a different
 * endpoint with a different body, and a wrong choice reads as a grant error rather
 * than a 401. The pool side matters just as much — a token rotated by one turn must
 * not be clobbered by another, and nothing secret may leave `describe()`.
 *
 * @module test/auth.test.js
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyRefreshError, dedupRefresh, expiresAtFrom, needsRefresh, refreshKiroToken } from '../lib/auth/token-refresh.js'
import { accountId, createAccountStore, describeAccount, emptyStore, normalizeStore } from '../lib/auth/store.js'
import { ERROR_CODES } from '../lib/errors.js'
import { KIRO_AUTH_HOST, REFRESH_LEAD_MS } from '../lib/constants.js'
import { account, fakeJwt, jsonResponse, recordingLogger, tokenFetch } from './helpers.js'

const FRESH = fakeJwt({ email: 'dev@example.com', exp: Math.floor(Date.now() / 1000) + 3600 })

/** An in-memory analogue of the harness credential record store. */
function memStore(initial = emptyStore()) {
  let pool = initial
  const writes = []
  return {
    get pool() {
      return pool
    },
    set pool(value) {
      pool = value
    },
    writes,
    read: async () => pool,
    mutate: async fn => {
      const next = await fn(pool)
      if (next !== undefined && next !== null) {
        pool = next
        writes.push(JSON.parse(JSON.stringify(next)))
      }
      return pool
    },
    /** Simulate another process writing between a read and a write. */
    sneak: accountPatch => {
      pool = { ...pool, accounts: pool.accounts.map(entry => ({ ...entry, ...accountPatch })) }
    },
  }
}

function storeFor({ accounts = [], refresh, resolveProfileArn, now } = {}) {
  const mem = memStore(normalizeStore({ version: 1, activeId: accounts[0]?.id ?? null, accounts }))
  const store = createAccountStore({
    read: mem.read,
    mutate: mem.mutate,
    log: recordingLogger(),
    // A test that reaches rotation without installing a double fails here instead of
    // sending a request to Amazon from the unit suite.
    refresh: refresh || (async () => {
      throw new Error('test refresh double not installed')
    }),
    ...(resolveProfileArn ? { resolveProfileArn } : {}),
    ...(now ? { now } : {}),
  })
  return { store, mem }
}

// ---------------------------------------------------------------- refresh routing

test('an API key has no refresh path and says so by doing nothing', async () => {
  const { fetch, calls } = tokenFetch([jsonResponse({})])
  const patch = await refreshKiroToken({ account: { id: 'k', authMethod: 'api_key', apiKey: 'kiro-api-key', refreshToken: 'aorX' }, fetch })
  assert.equal(patch, null)
  assert.equal(calls.length, 0, 'rotating a long-lived key would fail and confuse the user')
})

test('a credential without a refresh token asks for a new sign-in', async () => {
  await assert.rejects(refreshKiroToken({ account: { id: 'x', authMethod: 'builder-id', accessToken: FRESH }, fetch: tokenFetch([]).fetch }), error => {
    assert.equal(error.code, ERROR_CODES.refreshExpired)
    assert.match(error.message, /sign in again/iu)
    return true
  })
})

test('builder-id and idc refresh through the AWS OIDC token endpoint', async () => {
  const { fetch, calls } = tokenFetch([{ body: { accessToken: fakeJwt({ exp: 2_000_000_000 }), expiresIn: 3600 } }])
  const patch = await refreshKiroToken({
    account: { id: 'b1', authMethod: 'builder-id', refreshToken: 'aorOLD', clientId: 'cid', clientSecret: 'sec', region: 'us-east-1' },
    fetch,
  })
  assert.equal(calls[0].url, 'https://oidc.us-east-1.amazonaws.com/token')
  assert.deepEqual(JSON.parse(calls[0].body), { clientId: 'cid', clientSecret: 'sec', refreshToken: 'aorOLD', grantType: 'refresh_token' })
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json')
  assert.equal(patch.accessToken.split('.')[1], fakeJwt({ exp: 2_000_000_000 }).split('.')[1])
  assert.equal(patch.refreshToken, 'aorOLD', 'an absent rotation keeps the caller\'s token rather than clearing it')
  assert.ok(Number.isFinite(patch.expiresAt))
  assert.equal(patch.email, 'kiro-user', 'a token with no mailbox falls back to its subject')

  // IDC clients are regional; Builder ID registrations are only honoured in us-east-1.
  const idc = tokenFetch([{ body: { accessToken: FRESH, refreshToken: 'aorNEW', expiresIn: 900, profileArn: 'arn:aws:codewhisperer:eu-central-1:1:profile/P' } }])
  const idcPatch = await refreshKiroToken({
    account: { id: 'i1', authMethod: 'idc', refreshToken: 'aorOLD', clientId: 'cid', clientSecret: 'sec', region: 'eu-central-1' },
    fetch: idc.fetch,
  })
  assert.equal(idc.calls[0].url, 'https://oidc.eu-central-1.amazonaws.com/token')
  assert.equal(idcPatch.profileArn, 'arn:aws:codewhisperer:eu-central-1:1:profile/P')
  assert.equal(idcPatch.refreshToken, 'aorNEW')
  assert.equal(idcPatch.email, 'dev@example.com', 'a token whose subject the record does not know fills in the identity')
})

test('a Builder-ID refresh in another region is refused locally', async () => {
  const { fetch, calls } = tokenFetch([jsonResponse({})])
  await assert.rejects(refreshKiroToken({
    account: { id: 'b', authMethod: 'builder-id', refreshToken: 'aor', clientId: 'c', clientSecret: 's', region: 'us-east-1; rm' },
    fetch,
  }), error => {
    assert.match(error.message, /region/iu)
    return true
  })
  assert.equal(calls.length, 0, 'an invalid region must never be interpolated into a URL')
})

test('social and imported tokens refresh at the desktop auth host with the CLI agent', async () => {
  for (const authMethod of ['google', 'github', 'import']) {
    const { fetch, calls } = tokenFetch([{ body: { accessToken: FRESH, expiresIn: 1200 } }])
    await refreshKiroToken({ account: { id: `${authMethod}-1`, authMethod, refreshToken: 'aorAAAAAGTOKEN' }, fetch })
    assert.equal(calls[0].url, `${KIRO_AUTH_HOST}/refreshToken`, `${authMethod} refreshes at the social host`)
    assert.deepEqual(JSON.parse(calls[0].body), { refreshToken: 'aorAAAAAGTOKEN' })
    assert.equal(calls[0].init.headers['User-Agent'], 'kiro-cli/1.0.0')
  }
})

test('an external IdP refresh posts form-encoded to its own tenant endpoint', async () => {
  const { fetch, calls } = tokenFetch([{ body: { access_token: FRESH, refresh_token: 'rt-new', expires_in: 600 } }])
  const patch = await refreshKiroToken({
    account: {
      id: 'e1',
      authMethod: 'external_idp',
      refreshToken: 'rt-old',
      tokenEndpoint: 'https://login.microsoftonline.com/tenant-id/oauth2/v2/token',
      clientId: 'app-client',
      scope: 'openid offline_access',
      profileArn: 'arn:aws:codewhisperer:us-east-1:1:profile/SELF',
    },
    fetch,
  })
  const form = new URLSearchParams(String(calls[0].body))
  assert.equal(calls[0].url, 'https://login.microsoftonline.com/tenant-id/oauth2/v2/token')
  assert.equal(form.get('grant_type'), 'refresh_token')
  assert.equal(form.get('client_id'), 'app-client')
  assert.equal(form.get('refresh_token'), 'rt-old')
  assert.match(form.get('scope'), /offline_access/u)
  assert.equal(patch.refreshToken, 'rt-new')
  assert.equal(patch.profileArn, 'arn:aws:codewhisperer:us-east-1:1:profile/SELF', 'a self-resolved ARN is never replaced')
})

test('a misconfigured external IdP is an invalid credential, not a network failure', async () => {
  await assert.rejects(refreshKiroToken({
    account: { id: 'e2', authMethod: 'external_idp', refreshToken: 'rt', tokenEndpoint: 'https://evil.example.com/token' },
    fetch: tokenFetch([]).fetch,
  }), error => {
    assert.equal(error.code, ERROR_CODES.invalidCredential)
    assert.match(error.message, /not configured correctly/u)
    return true
  })
})

test('a dead refresh token is permanent, a server hiccup is not', async () => {
  const permanent = tokenFetch([{ status: 400, body: JSON.stringify({ error: 'invalid_grant', error_description: 'refresh token expired' }) }])
  await assert.rejects(refreshKiroToken({ account: { id: 'p', authMethod: 'import', refreshToken: 'aorX' }, fetch: permanent.fetch }), error => {
    assert.equal(error.code, ERROR_CODES.refreshExpired)
    assert.match(error.message, /Sign in again/u)
    assert.equal(error.stage, 'kiro-social', 'the failing stage is flattened onto the error')
    return true
  })
  const transient = tokenFetch([{ status: 502, body: 'upstream bad gateway' }])
  let transientError = null
  await assert.rejects(refreshKiroToken({ account: { id: 't', authMethod: 'import', refreshToken: 'aorX' }, fetch: transient.fetch }), error => {
    transientError = error.message
    assert.equal(error.code, ERROR_CODES.auth)
    assert.match(error.message, /502/u)
    return true
  })
  assert.doesNotMatch(transientError, /aorX/u, 'a refresh failure must not echo the token into the message')
})

test('classifyRefreshError reads both the AWS SSO and OAuth shapes', () => {
  assert.equal(classifyRefreshError('{"error":{"code":"RefreshTokenExpired"}}', 400).permanent, true)
  assert.equal(classifyRefreshError('{"error":"invalid_grant"}', 400).permanent, true)
  assert.equal(classifyRefreshError('{"error_description":"refresh_token_reused"}', 400).permanent, true)
  assert.equal(classifyRefreshError('{"message":"slow down"}', 429).permanent, false)
  assert.equal(classifyRefreshError('not json', 500).permanent, false)
  assert.equal(classifyRefreshError('{"error":"invalid_grant"}', 400).code, 'invalid_grant')
})

test('concurrent refreshes of one credential collapse into one request', async () => {
  let calls = 0
  const fetch = async () => {
    calls++
    await new Promise(resolve => setTimeout(resolve, 5))
    return jsonResponse({ accessToken: FRESH, expiresIn: 3600 })
  }
  const shared = { id: 'same', authMethod: 'import', refreshToken: 'aorSHARED' }
  const [a, b, c] = await Promise.all([
    refreshKiroToken({ account: shared, fetch }),
    refreshKiroToken({ account: { ...shared }, fetch }),
    refreshKiroToken({ account: { ...shared, id: 'other' }, fetch }),
  ])
  assert.equal(calls, 2, 'two accounts sharing a refresh token are two credentials, not one')
  assert.equal(a.accessToken, b.accessToken)
  assert.notEqual(a.accessToken, undefined)
  assert.ok(c.accessToken)
})

test('dedupRefresh releases its key whether it resolves or throws', async () => {
  let runs = 0
  const boom = async () => {
    runs++
    throw new Error('nope')
  }
  await assert.rejects(dedupRefresh('key-1', boom), /nope/u)
  await dedupRefresh('key-1', async () => {
    runs++
    return { ok: true }
  })
  assert.equal(runs, 2)
})

test('expiry decisions keep a five-minute lead and skip API keys', () => {
  const now = 1_700_000_000_000
  assert.equal(needsRefresh({ expiresAt: now + REFRESH_LEAD_MS - 1000, refreshToken: 'x' }, now), true)
  assert.equal(needsRefresh({ expiresAt: now + REFRESH_LEAD_MS + 60_000, refreshToken: 'x' }, now), false)
  assert.equal(needsRefresh({ refreshToken: 'x' }, now), true, 'no expiry information but a token to rotate with: try')
  assert.equal(needsRefresh({ accessToken: 'x' }, now), false)
  assert.equal(needsRefresh({ authMethod: 'api_key', refreshToken: 'x' }, now), false)
  assert.equal(needsRefresh(null, now), false)
  assert.equal(expiresAtFrom(120, now), now + 120_000)
  assert.equal(expiresAtFrom(0, now), now + 3600 * 1000)
  assert.equal(expiresAtFrom('garbage', now), now + 3600 * 1000)
})

// ---------------------------------------------------------------------- the pool

test('normalizeStore repairs anything read from disk and drops the rest', () => {
  const next = normalizeStore({
    activeId: 'missing',
    accounts: [
      { accessToken: 'at', refreshToken: 'aorA', evil: 'x'.repeat(80) },
      null,
      'nope',
      { id: 'explicit', authMethod: 'api_key', apiKey: 'key', enabled: false },
    ],
  })
  assert.equal(next.accounts.length, 2)
  assert.equal(next.accounts[0].authMethod, 'import', 'an unlabelled credential is treated as an imported token')
  assert.equal(next.accounts[0].region, 'us-east-1')
  assert.equal(next.accounts[0].enabled, true)
  assert.equal(next.accounts[0].evil, undefined, 'unknown fields are not carried forward')
  assert.equal(next.accounts[1].id, 'explicit')
  assert.equal(next.activeId, next.accounts[0].id, 'a dangling activeId is repaired to a usable account')
  assert.deepEqual(normalizeStore(null), emptyStore())
  assert.equal(normalizeStore({ accounts: [] }).activeId, null)
})

test('an account id is derived from its credential, not from a counter', () => {
  const first = accountId({ refreshToken: 'aorSAME' })
  assert.equal(first, accountId({ refreshToken: 'aorSAME', label: 'renamed' }))
  assert.notEqual(first, accountId({ refreshToken: 'aorOTHER' }))
  assert.match(first, /^kiro-[0-9a-f]{16}$/u)
  assert.match(accountId({}), /^kiro-[0-9a-f]{16}$/u)
  // The id is a digest: a hex copy of the token tail would put the secret into
  // every log line and panel row that names the account.
  assert.doesNotMatch(accountId({ refreshToken: 'aorABCDEFGHIJKLMN' }), /616f72/u)
})

test('upsert merges by id and only steals the active slot when there was none', async () => {
  const { store, mem } = storeFor({})
  const one = await store.upsert({ accessToken: 'at1', refreshToken: 'aor1', authMethod: 'import' })
  const two = await store.upsert({ accessToken: 'at2', refreshToken: 'aor2', authMethod: 'google', label: 'Work' })
  assert.equal(mem.pool.activeId, one.id)
  assert.equal(mem.pool.accounts.length, 2)
  const again = await store.upsert({ id: one.id, label: 'Personal', extraNoise: 1 })
  assert.equal(again.id, one.id)
  assert.equal(mem.pool.accounts[0].accessToken, 'at1', 'a partial write keeps the stored token')
  assert.equal(mem.pool.accounts[0].label, 'Personal')
  assert.equal(mem.pool.accounts[0].extraNoise, undefined)
  assert.equal(mem.pool.activeId, one.id)
  await store.setActive(two.id)
  assert.equal(mem.pool.activeId, two.id)
  await assert.rejects(store.setActive('nope'), error => {
    assert.equal(error.code, ERROR_CODES.notConfigured)
    return true
  })
})

test('disabling or deleting the active account hands the slot to another', async () => {
  const accounts = [
    { id: 'a', accessToken: 'at-a', refreshToken: 'aorA' },
    { id: 'b', accessToken: 'at-b', refreshToken: 'aorB' },
  ]
  const { store, mem } = storeFor({ accounts })
  assert.equal(mem.pool.activeId, 'a')
  await store.setEnabled('a', false)
  assert.equal(mem.pool.activeId, 'b')
  assert.equal((await store.candidates()).map(entry => entry.id).join(','), 'b')
  await store.setEnabled('a', true)
  assert.equal(mem.pool.activeId, 'b', 're-enabling does not take the slot back')
  await store.remove('b')
  assert.equal(mem.pool.activeId, 'a')
  await store.remove('a')
  assert.equal(mem.pool.activeId, null)
  assert.equal(mem.pool.accounts.length, 0)
  await store.clear()
})

test('candidates list only usable accounts and put the preferred one first', async () => {
  const { store } = storeFor({
    accounts: [
      { id: 'a', accessToken: 'at-a', refreshToken: 'aorA' },
      { id: 'b', accessToken: '', refreshToken: 'aorB' },
      { id: 'c', authMethod: 'api_key', apiKey: 'key-c' },
      { id: 'd', accessToken: 'at-d', refreshToken: 'aorD', enabled: false },
    ],
  })
  assert.deepEqual((await store.candidates()).map(entry => entry.id), ['a', 'c'])
  assert.deepEqual((await store.candidates('c')).map(entry => entry.id), ['c', 'a'])
})

test('a token with minutes left is used as it is', async () => {
  const accounts = [{ id: 'a', accessToken: 'at-old', refreshToken: 'aorA', expiresAt: Date.now() + 30 * 60_000 }]
  const { store } = storeFor({ accounts })
  const result = await store.authorize('a')
  assert.equal(result.account.accessToken, 'at-old', 'a round trip per turn to rotate a healthy token is a waste')
})

test('an expiring token is rotated once for concurrent turns and persisted', async () => {
  const accounts = [{ id: 'a', accessToken: 'at-old', refreshToken: 'aorA', expiresAt: Date.now() + 60_000 }]
  let refreshes = 0
  const { store, mem } = storeFor({
    accounts,
    refresh: async () => {
      refreshes++
      await new Promise(resolve => setTimeout(resolve, 5))
      return { accessToken: 'at-new', refreshToken: 'aorA2', expiresAt: Date.now() + 3600_000 }
    },
  })
  const [x, y] = await Promise.all([store.authorize('a'), store.authorize('a')])
  assert.equal(refreshes, 1, 'AWS SSO refresh tokens are single-use: rotating twice burns the second one')
  assert.equal(x.account.accessToken, 'at-new')
  assert.equal(y.account.accessToken, 'at-new')
  assert.equal(mem.pool.accounts[0].accessToken, 'at-new')
  assert.equal(mem.pool.accounts[0].refreshToken, 'aorA2')
  assert.equal(mem.pool.accounts[0].lastError, undefined, 'a successful rotation clears the fault record')
})

test('a refresh that races another writer keeps the newer field', async () => {
  const accounts = [{ id: 'a', label: 'Personal', accessToken: 'at-old', refreshToken: 'aorA', expiresAt: Date.now() + 1000 }]
  const { store, mem } = storeFor({
    accounts,
    refresh: async () => {
      // The panel renames the account while the refresh is in flight.
      mem.sneak({ label: 'Renamed while refreshing' })
      return { accessToken: 'at-new', expiresAt: Date.now() + 3600_000 }
    },
  })
  const result = await store.authorize('a')
  assert.equal(result.account.accessToken, 'at-new')
  assert.equal(mem.pool.accounts[0].accessToken, 'at-new')
  assert.equal(mem.pool.accounts[0].label, 'Renamed while refreshing', 'the pool the caller saw is re-read before writing')
})

test('a transient refresh failure keeps the stale token and does not blame the account', async () => {
  const accounts = [{ id: 'a', label: 'Personal', accessToken: 'at-stale', refreshToken: 'aorA', expiresAt: Date.now() + 1000 }]
  const { store, mem } = storeFor({
    accounts,
    refresh: async () => {
      throw new Error('socket hang up')
    },
  })
  const result = await store.authorize('a')
  assert.equal(result.account.accessToken, 'at-stale', 'a network blip must not waste a token that still works')
  const noted = mem.pool.accounts[0].lastError
  assert.match(noted.message, /socket hang up/u, 'the panel has to be able to say why the turn was slow')
  assert.equal(noted.code, ERROR_CODES.upstream, 'a transport blip is not a credential fault')
  const again = await store.authorize('a')
  assert.equal(again.account.accessToken, 'at-stale', 'the failed attempt must not have burned the stored token')
})

test('an expired grant is reported against the named account', async () => {
  const { KiroError } = await import('../lib/errors.js')
  const accounts = [{ id: 'a', label: 'Work', accessToken: 'at', refreshToken: 'aorA', expiresAt: Date.now() + 1000 }]
  const { store } = storeFor({
    accounts,
    refresh: async () => {
      throw new KiroError('Kiro refresh token is no longer usable. Sign in again.', ERROR_CODES.refreshExpired)
    },
  })
  await assert.rejects(store.authorize('a'), error => {
    assert.equal(error.code, ERROR_CODES.refreshExpired)
    assert.match(error.message, /\(account Work\)/u)
    return true
  })
})

test('authorize refuses accounts that cannot be used, with distinct codes', async () => {
  const none = storeFor({})
  await assert.rejects(none.store.authorize(), error => {
    assert.equal(error.code, ERROR_CODES.notConfigured)
    return true
  })
  const keyOnly = storeFor({ accounts: [{ id: 'k', authMethod: 'api_key', apiKey: 'kiro-key', accessToken: '' }] })
  const result = await keyOnly.store.authorize('k')
  assert.equal(result.account.apiKey, 'kiro-key', 'the key itself is the bearer credential')
  const noKey = storeFor({ accounts: [{ id: 'k2', authMethod: 'api_key', accessToken: '' }] })
  await assert.rejects(noKey.store.authorize('k2'), error => {
    assert.equal(error.code, ERROR_CODES.invalidCredential)
    return true
  })
  const noToken = storeFor({ accounts: [{ id: 's', authMethod: 'import', accessToken: '', refreshToken: 'aorX' }] })
  await assert.rejects(noToken.store.authorize('s'), error => {
    assert.equal(error.code, ERROR_CODES.auth)
    assert.match(error.message, /sign in again/iu)
    return true
  })
})

test('describe() shows the state of the pool and never a secret', async () => {
  const accounts = [{
    id: 'a',
    label: 'Work',
    authMethod: 'builder-id',
    email: 'dev@example.com',
    accessToken: 'at-SECRET-VALUE-123',
    refreshToken: 'aorSECRET-VALUE-456',
    clientSecret: 'shhhSECRET',
    expiresAt: Date.now() + 3600_000,
  }]
  const { store } = storeFor({ accounts })
  const view = await store.describe()
  const text = JSON.stringify(view)
  assert.equal(view.configured, true)
  assert.equal(view.activeId, 'a')
  assert.equal(view.accounts[0].tokenType, 'BEARER')
  assert.equal(view.accounts[0].hasRefreshToken, true)
  assert.equal(view.accounts[0].secretTails.refreshToken, '…-456')
  assert.doesNotMatch(text, /SECRET-VALUE|shhhSECRET/u)
  assert.ok(Number.isFinite(view.accounts[0].expiresInSeconds))
  assert.equal(view.accounts[0].needsRefresh, false)
  assert.equal(describeAccount({ id: 'x', apiKey: 'key-abcw' }).tokenType, 'API_KEY')
  assert.equal(describeAccount({ id: 'x' }).tokenType, 'NONE')
})

test('noteFailure redacts the message and keeps the code', async () => {
  const { store, mem } = storeFor({ accounts: [{ id: 'a', accessToken: 'at', refreshToken: 'aorA' }] })
  await store.noteFailure('a', new Error(`Bearer at-TOKEN-VALUE leaked here, plus ${'x'.repeat(400)}`))
  const record = mem.pool.accounts[0].lastError
  assert.equal(typeof record.message, 'string')
  assert.ok(record.message.length <= 300)
  assert.doesNotMatch(record.message, /at-TOKEN-VALUE/u)
  assert.equal(record.code, ERROR_CODES.upstream)
  assert.ok(Date.parse(record.at) > 0)
})

test('patch writes fields without a read-modify-write race', async () => {
  // A frozen clock, because `updatedAt` is the thing being checked and two writes in
  // the same millisecond would make the assertion a coin flip.
  const clock = 1_700_000_000_000
  const { store, mem } = storeFor({
    accounts: [{ id: 'a', accessToken: 'at', refreshToken: 'aorA', expiresAt: clock + 3600_000 }],
    now: () => clock,
  })
  await store.patch('a', { region: 'eu-central-1' })
  assert.equal(mem.pool.accounts[0].region, 'eu-central-1')
  assert.equal(mem.pool.accounts[0].updatedAt, new Date(clock).toISOString())
  const patched = await store.transact(current => ({ ...current, accounts: [{ ...current.accounts[0], label: 'Z' }] }))
  assert.equal(patched.accounts[0].label, 'Z')
  const untouched = await store.transact(() => undefined)
  assert.equal(untouched.accounts[0].label, 'Z', 'a read-only transaction does not rewrite the pool')
})
