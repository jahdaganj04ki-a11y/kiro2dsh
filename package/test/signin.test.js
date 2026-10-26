/**
 * Every way a Kiro credential can enter the plugin.
 *
 * The methods differ in more than the URL they call: some need a start URL from the
 * human, one is a resumable browser dance, one never touches the network, and one
 * reads files the IDE left behind. These tests drive each through the same
 * coordinator the HTTP panel uses, so a flow that parks, resumes and commits is
 * proven before the desktop UI is involved at all.
 *
 * @module test/signin.test.js
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { authMethodEntries, createSignInCoordinator, METHOD_LABELS, normalizeMethod, runSignIn, staticSession } from '../lib/auth/signin.js'
import { discoverLocalCredentials } from '../lib/auth/flows.js'
import { ERROR_CODES } from '../lib/errors.js'
import { AUTH_METHODS, KIRO_SOCIAL } from '../lib/constants.js'
import { fakeJwt, fakeStore, jsonResponse } from './helpers.js'

const TOKEN = fakeJwt({ email: 'human@example.com', exp: Math.floor(Date.now() / 1000) + 3600 })

/** A fetch double that dispatches on the URL, so the order of calls cannot matter. */
function kiroFetch(handlers) {
  const calls = []
  const fetch = async (url, init = {}) => {
    const target = String(url)
    calls.push({ url: target, body: init.body == null ? undefined : String(init.body), headers: init.headers || {}, method: init.method })
    for (const [pattern, reply] of handlers) {
      if (!pattern.test(target)) continue
      const value = typeof reply === 'function' ? await reply({ url: target, body: init.body }) : reply
      if (value instanceof Response) return value
      const { status = 200, ...body } = value || {}
      return jsonResponse(status === 200 ? body : (Object.keys(body).length > 0 ? body : ''), status)
    }
    return new Response('{"message":"unhandled endpoint in test"}', { status: 599 })
  }
  return { fetch, calls }
}

const OIDC_HOST = 'https://oidc.us-east-1.amazonaws.com'

/** The three device-code endpoints, with a poll sequence the caller controls. */
function deviceFlow({ polls = [], startUrl = null } = {}) {
  let registered = 0
  return {
    polls,
    push: (...replies) => polls.push(...replies),
    registered: () => registered,
    handlers: [
      [/client\/register$/u, () => {
        registered++
        return { clientId: 'cid-kiro', clientSecret: 'sec-kiro', clientSecretExpiresAt: 0 }
      }],
      [/device_authorization$/u, () => ({
        deviceCode: 'device-code-1',
        userCode: 'ABCD-1234',
        verificationUri: 'https://view.awsapps.com/start',
        verificationUriComplete: 'https://view.awsapps.com/start?userCode=ABCD-1234',
        expiresIn: 600,
        interval: 1,
      })],
      [/\/token$/u, ({ body }) => {
        const reply = polls.shift() ?? { error: 'expired_token' }
        void body
        return typeof reply === 'function' ? reply() : reply
      }],
    ],
    startUrl,
  }
}

function coordinatorFor(store, fetch, settings = {}) {
  return createSignInCoordinator({ store, fetch, settings: () => settings })
}

// ------------------------------------------------------------------------ labels

test('every auth method has a name a human can read', () => {
  assert.deepEqual([...AUTH_METHODS], ['builder-id', 'idc', 'google', 'github', 'external_idp', 'api_key', 'import', 'auto-import'])
  const entries = authMethodEntries()
  assert.equal(entries.length, AUTH_METHODS.length)
  for (const entry of entries) {
    assert.ok(entry.label && entry.label !== entry.id, `${entry.id} needs a panel label`)
    assert.equal(METHOD_LABELS[entry.id], entry.label)
  }
  assert.equal(entries[0].id, 'builder-id', 'the free personal sign-in is offered first')
})

test('the spellings users type are accepted, the rest are refused with the list', () => {
  assert.equal(normalizeMethod('Builder_ID'), 'builder-id')
  assert.equal(normalizeMethod('builder-id-social'), 'builder-id')
  assert.equal(normalizeMethod('AWS'), 'builder-id')
  assert.equal(normalizeMethod('sso'), 'idc')
  assert.equal(normalizeMethod('IAM Identity Center'), 'idc')
  assert.equal(normalizeMethod('entra'), 'external_idp')
  assert.equal(normalizeMethod('okta'), 'external_idp')
  assert.equal(normalizeMethod('api-key'), 'api_key')
  assert.equal(normalizeMethod('refresh-token'), 'import')
  assert.equal(normalizeMethod('ide'), 'auto-import')
  assert.throws(() => normalizeMethod('karpathy'), error => {
    assert.equal(error.code, ERROR_CODES.rejected)
    assert.match(error.message, /builder-id, idc/u)
    return true
  })
  assert.throws(() => normalizeMethod(''), /unknown Kiro auth method/u)
})

// ----------------------------------------------------------------------- api_key

test('an API key is checked against the model catalog before it is stored', async () => {
  const store = fakeStore([])
  const { fetch, calls } = kiroFetch([
    [/ListAvailableModels/u, { models: [{ modelId: 'claude-sonnet-4.5' }] }],
  ])
  const result = await runSignIn('api_key', {
    session: staticSession({ apiKey: '  kiro-key-with-padding  ' }, () => {}),
    store,
    fetch,
  })
  assert.equal(result.status, 'authorized')
  assert.equal(result.account.authMethod, 'api_key')
  assert.equal(result.account.apiKey, 'kiro-key-with-padding', 'pasted keys carry the surrounding whitespace of a clipboard')
  assert.equal(result.account.accessToken, 'kiro-key-with-padding', 'the key is the bearer token for this method')
  assert.equal(result.account.refreshToken, null, 'a key has nothing to rotate')
  assert.ok(result.account.expiresAt > Date.now() + 300 * 24 * 3600_000, 'a year out keeps the refresh path idle')
  assert.equal(calls[0].headers.Authorization, 'Bearer kiro-key-with-padding')
  assert.equal(calls[0].headers.TokenType, 'API_KEY')
  assert.equal(store.pool.activeId, result.account.id)
  assert.equal(new URL(calls[0].url).hostname, 'q.us-east-1.amazonaws.com')
})

test('a key that names no model is refused, not stored', async () => {
  const store = fakeStore([])
  const empty = kiroFetch([[/ListAvailableModels/u, { models: [] }]])
  await assert.rejects(runSignIn('api_key', { session: staticSession({ apiKey: 'junk' }), store, fetch: empty.fetch }), error => {
    assert.equal(error.code, ERROR_CODES.auth)
    assert.match(error.message, /no usable models/u)
    return true
  })
  assert.equal(store.pool.accounts.length, 0)
  // Kiro's own error text is the only thing that tells the user what to change, so
  // it is carried into the message (truncated and redacted upstream).
  const denied = kiroFetch([[/ListAvailableModels/u, new Response('{"message":"key revoked"}', { status: 403 })]])
  await assert.rejects(runSignIn('api_key', { session: staticSession({ apiKey: 'nope' }), store, fetch: denied.fetch }), error => {
    assert.equal(error.status, 403)
    assert.match(error.message, /key revoked/u)
    return true
  })
  assert.equal(store.pool.accounts.length, 0)
})

// ------------------------------------------------------------------ device codes

test('Builder ID parks on the browser approval and resumes without re-asking', async () => {
  const store = fakeStore([])
  const device = deviceFlow({
    polls: [
      { error: 'authorization_pending', error_description: 'Pending' },
      { accessToken: TOKEN, refreshToken: 'aotNEW', expiresIn: 3600, profileArn: 'arn:aws:codewhisperer:us-east-1:1:profile/MINE' },
    ],
  })
  const { fetch, calls } = kiroFetch(device.handlers)
  const coordinator = coordinatorFor(store, fetch)

  const first = await coordinator.round({ method: 'builder-id' })
  assert.equal(first.status, 'awaiting_input')
  assert.equal(first.prompt.field, 'wait')
  assert.match(first.prompt.message, /ABCD-1234/u)
  assert.equal(first.userCode, 'ABCD-1234')
  assert.equal(first.url, 'https://view.awsapps.com/start?userCode=ABCD-1234')
  assert.equal(first.prompt.polling.intervalMs, 1000)
  assert.ok(first.stateId)
  assert.deepEqual(coordinator.pending(), [first.stateId])
  assert.equal(device.registered(), 1)

  const second = await coordinator.round({ method: 'builder-id', stateId: first.stateId, input: { wait: 'done' } })
  assert.equal(second.status, 'authorized')
  assert.equal(second.stateId, null)
  assert.equal(second.account.authMethod, 'builder-id')
  assert.equal(second.account.refreshToken, 'aotNEW')
  assert.equal(second.account.label, 'AWS Builder ID')
  assert.equal(second.account.clientId, 'cid-kiro', 'the client registration is part of the credential')
  assert.equal(second.account.profileArn, 'arn:aws:codewhisperer:us-east-1:1:profile/MINE')
  assert.equal(device.registered(), 1, 'the device code and its client secret survive the round trip')
  assert.equal(calls.filter(call => /\/token$/u.test(call.url)).length, 2)
  assert.deepEqual(JSON.parse(calls[calls.length - 1].body).grantType, 'urn:ietf:params:oauth:grant-type:device_code')
  assert.equal(store.pool.accounts.length, 1)
})

test('polling too fast is answered with a longer wait, not an error', async () => {
  const store = fakeStore([])
  // The first round polls once immediately (the browser may already be approved), so
  // the sequence is: pending for round one, slow_down for round two.
  const device = deviceFlow({ polls: [{ error: 'authorization_pending' }, { error: 'slow_down' }] })
  const coordinator = coordinatorFor(store, kiroFetch(device.handlers).fetch)
  const first = await coordinator.round({ method: 'builder-id' })
  const second = await coordinator.round({ method: 'builder-id', stateId: first.stateId, input: { wait: 'x' } })
  assert.equal(second.status, 'awaiting_input')
  assert.equal(second.prompt.polling.intervalMs, 6000, 'the interval grows by five seconds, as the RFC asks')
})

test('a declined or expired device code ends the round', async () => {
  const declined = deviceFlow({ polls: [{ error: 'authorization_pending' }, { error: 'authorization_declined' }] })
  const store = fakeStore([])
  const coordinator = coordinatorFor(store, kiroFetch(declined.handlers).fetch)
  const first = await coordinator.round({ method: 'builder-id' })
  const second = await coordinator.round({ method: 'builder-id', stateId: first.stateId, input: { wait: 'x' } })
  assert.equal(second.status, 'declined', 'a human saying no is not a failure to report as a bug')
  assert.deepEqual(coordinator.pending(), [])
  assert.equal(store.pool.accounts.length, 0)

  const expired = deviceFlow({ polls: [{ error: 'authorization_pending' }, { error: 'expired_token' }] })
  const store2 = fakeStore([])
  const coordinator2 = coordinatorFor(store2, kiroFetch(expired.handlers).fetch)
  const r1 = await coordinator2.round({ method: 'builder-id' })
  const r2 = await coordinator2.round({ method: 'builder-id', stateId: r1.stateId, input: { wait: 'x' } })
  assert.equal(r2.status, 'failed')
  assert.match(r2.error.message, /expired/iu)
})

test('Identity Center asks for the organization start URL and sends it upstream', async () => {
  const store = fakeStore([])
  const device = deviceFlow({ polls: [{ error: 'authorization_pending' }, { accessToken: TOKEN, refreshToken: 'aotIDC', expiresIn: 3600 }] })
  const { fetch, calls } = kiroFetch(device.handlers)
  const coordinator = coordinatorFor(store, fetch)
  const ask = await coordinator.round({ method: 'idc' })
  assert.equal(ask.status, 'awaiting_input')
  assert.equal(ask.prompt.field, 'startUrl', 'an organization login cannot be guessed')
  const next = await coordinator.round({ method: 'idc', stateId: ask.stateId, input: { startUrl: 'https://viewcenter.awsapps.com/start' } })
  assert.equal(next.status, 'awaiting_input')
  assert.equal(next.prompt.field, 'wait')
  const authorized = await coordinator.round({ method: 'idc', stateId: next.stateId, input: { wait: 'ok' } })
  assert.equal(authorized.status, 'authorized')
  assert.equal(authorized.account.authMethod, 'idc')
  assert.equal(authorized.account.startUrl, 'https://viewcenter.awsapps.com/start')
  const deviceCall = calls.find(call => /device_authorization$/u.test(call.url))
  assert.equal(JSON.parse(deviceCall.body).startUrl, 'https://viewcenter.awsapps.com/start')
  // Builder ID is never asked for a start URL, yet still sends Kiro's personal default.
  const builder = deviceFlow({ polls: [{ accessToken: TOKEN, refreshToken: 'aotB' }] })
  const builderFetch = kiroFetch(builder.handlers)
  const builderStore = fakeStore([])
  const builderResult = await runSignIn('builder-id', { session: staticSession({}), store: builderStore, fetch: builderFetch.fetch })
  assert.equal(builderResult.status, 'authorized')
  assert.equal(builderResult.account.startUrl, 'https://view.awsapps.com/start', 'the personal default is still sent, only never asked for')
  const builderDeviceCall = builderFetch.calls.find(call => /device_authorization$/u.test(call.url))
  assert.equal(JSON.parse(builderDeviceCall.body).startUrl, 'https://view.awsapps.com/start')
  // The shared placeholder ARN is derived from the auth method at request time, so a
  // personal account needs no stored ARN — and an org account must not inherit one.
  assert.equal(builderResult.account.profileArn, null)
})

test('a device code that outlived its own expiry is refused without a request', async () => {
  const store = fakeStore([])
  const { fetch, calls } = kiroFetch([
    [/client\/register$/u, { clientId: 'c', clientSecret: 's' }],
    [/device_authorization$/u, { deviceCode: 'd', userCode: 'U-1', expiresIn: 600, interval: 1 }],
    [/\/token$/u, { accessToken: TOKEN, refreshToken: 'aorX' }],
  ])
  const first = await runSignIn('builder-id', { session: staticSession({}), store, fetch })
  assert.equal(first.status, 'authorized')
  const before = calls.length
  // Re-entering with a state that has already expired must not spend another poll.
  // A completed round clears its state, so the expired round is rebuilt by hand.
  const stale = {
    deviceCode: 'd',
    clientId: 'c',
    clientSecret: 's',
    region: 'us-east-1',
    startedAt: Date.now() - 60_000,
    expiresInSeconds: 1,
  }
  await assert.rejects(runSignIn('builder-id', { session: staticSession({ wait: 'x' }), store, fetch, state: stale }), error => {
    assert.equal(error.code, ERROR_CODES.refreshExpired)
    assert.match(error.message, /expired/iu)
    return true
  })
  assert.equal(calls.length, before)
})

// ------------------------------------------------------------------ social logins

test('Google hands out a PKCE login URL and exchanges the pasted callback', async () => {
  const store = fakeStore([])
  const notices = []
  const { fetch, calls } = kiroFetch([
    [/oauth\/token$/u, { accessToken: TOKEN, refreshToken: 'aorAAAAAGSOCIAL', expiresIn: 3600, profileArn: null }],
  ])
  const session = {
    notify: notice => notices.push(notice),
    prompt: async request => {
      if (request.field !== 'callback') throw new Error(`unexpected prompt ${request.field}`)
      const state = new URL(notices[0].url).searchParams.get('state')
      const challenge = new URL(notices[0].url).searchParams.get('code_challenge')
      assert.ok(challenge && challenge.length > 20, 'S256 needs a real challenge')
      return `kiro://callback?code=code-123&state=${state}`
    },
  }
  const result = await runSignIn('google', { session, store, fetch })
  assert.equal(result.status, 'authorized')
  assert.equal(result.account.authMethod, 'google')
  assert.equal(result.account.refreshToken, 'aorAAAAAGSOCIAL')
  assert.equal(result.account.email, 'human@example.com')
  const url = new URL(notices[0].url)
  assert.equal(url.origin + url.pathname, KIRO_SOCIAL.loginUrl)
  assert.equal(url.searchParams.get('idp'), 'Google')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('redirect_uri'), KIRO_SOCIAL.redirectUri)
  const exchange = calls[0]
  assert.equal(exchange.url, KIRO_SOCIAL.tokenUrl)
  assert.equal(JSON.parse(exchange.body).code, 'code-123')
  assert.equal(JSON.parse(exchange.body).redirect_uri, KIRO_SOCIAL.redirectUri)
  assert.match(JSON.parse(exchange.body).code_verifier, /^[A-Za-z0-9_-]{43,}$/u)
})

test('a callback from an earlier attempt is refused, and GitHub is spelled Github', async () => {
  const store = fakeStore([])
  const { fetch, calls } = kiroFetch([[/oauth\/token$/u, { accessToken: TOKEN }]])
  await assert.rejects(runSignIn('github', {
    session: staticSession({ callback: 'kiro://callback?code=stale&state=00000000000000000000000000000000' }),
    store,
    fetch,
  }), error => {
    assert.equal(error.code, ERROR_CODES.rejected)
    assert.match(error.message, /earlier sign-in attempt/u)
    return true
  })
  assert.equal(calls.length, 0, 'nothing is sent to the token endpoint for a code we did not request')
  const notices = []
  await runSignIn('github', {
    session: { notify: n => notices.push(n), prompt: async () => 'plain-code-here' },
    store,
    fetch,
  }).catch(() => {})
  assert.equal(new URL(notices[0].url).searchParams.get('idp'), 'Github')
})

test('an error in the callback is reported as the provider said it', async () => {
  await assert.rejects(runSignIn('google', {
    session: staticSession({ callback: 'kiro://callback?error=access_denied&error_description=User cancelled' }),
    store: fakeStore([]),
    fetch: kiroFetch([]).fetch,
  }), error => {
    assert.match(error.message, /User cancelled/u)
    assert.equal(error.code, ERROR_CODES.auth)
    return true
  })
})

// ------------------------------------------------------------------ external IdP

const IDP_JSON = JSON.stringify({
  auth_method: 'external_idp',
  access_token: TOKEN,
  refresh_token: 'idp-refresh',
  client_id: 'app-client',
  scopes: 'api://kiro/.default openid profile offline_access',
  profile_arn: 'arn:aws:codewhisperer:us-east-1:123:profile/IDP',
  token_endpoint: 'https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token',
})

test('pasted IdP JSON is stored without a network round trip', async () => {
  const store = fakeStore([])
  const { fetch, calls } = kiroFetch([])
  const result = await runSignIn('external_idp', { session: staticSession({ authJson: IDP_JSON }), store, fetch })
  assert.equal(result.status, 'authorized')
  assert.equal(calls.length, 0)
  assert.equal(result.account.authMethod, 'external_idp')
  assert.equal(result.account.refreshToken, 'idp-refresh')
  assert.equal(result.account.tokenEndpoint, 'https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token')
  assert.equal(result.account.clientId, 'app-client')
  assert.match(result.account.scope, /offline_access/u)
  assert.equal(result.account.profileArn, 'arn:aws:codewhisperer:us-east-1:123:profile/IDP')
})

test('JSON that is not an IdP blob falls back to asking field by field', async () => {
  const store = fakeStore([])
  const prompts = []
  const session = {
    notify: () => {},
    prompt: async request => {
      prompts.push(request.field)
      const answers = {
        authJson: 'i forgot the json',
        tokenEndpoint: 'https://login.microsoftonline.com/t2/oauth2/v2.0/token',
        clientId: 'cid2',
        scopes: 'api://x/.default offline_access',
        profileArn: 'arn:aws:codewhisperer:us-east-1:9:profile/P2',
        tokens: `${TOKEN} rt-two`,
      }
      const value = answers[request.field]
      if (value === undefined) throw new Error(`unexpected prompt ${request.field}`)
      return value
    },
  }
  const result = await runSignIn('external_idp', { session, store, fetch: kiroFetch([]).fetch })
  assert.deepEqual(prompts, ['authJson', 'tokenEndpoint', 'clientId', 'scopes', 'profileArn', 'tokens'], 'only the fields still unknown are asked for')
  assert.equal(result.account.refreshToken, 'rt-two')
  assert.equal(result.account.profileArn, 'arn:aws:codewhisperer:us-east-1:9:profile/P2')
  assert.equal(result.account.label, 'Enterprise IdP')
})

test('an IdP endpoint that is not the tenant host is never contacted', async () => {
  const bad = IDP_JSON.replace('login.microsoftonline.com/tenant-1', 'evil.example.com')
  const store = fakeStore([])
  const { fetch, calls } = kiroFetch([])
  // A rejected paste falls back to asking field by field, so the assertion is that
  // nothing leaves the process and that the typed endpoint is refused too.
  const session = {
    notify: () => {},
    prompt: async request => ({
      authJson: bad,
      tokenEndpoint: 'https://evil.example.com/token',
      clientId: 'c',
      scopes: 'openid offline_access',
      profileArn: 'arn:aws:codewhisperer:us-east-1:1:profile/P',
      tokens: `${TOKEN} rt`,
    })[request.field],
  }
  await assert.rejects(runSignIn('external_idp', { session, store, fetch }), error => {
    assert.equal(error.code, ERROR_CODES.invalidCredential)
    assert.match(error.message, /must be a Microsoft login endpoint/iu)
    return true
  })
  assert.equal(calls.length, 0)
  assert.equal(store.pool.accounts.length, 0)
})

// ----------------------------------------------------------------------- imports

test('a pasted refresh token is exercised once before it is trusted', async () => {
  const store = fakeStore([])
  const { fetch, calls } = kiroFetch([
    [/refreshToken$/u, { accessToken: TOKEN, refreshToken: 'aorROTATED', expiresIn: 900 }],
  ])
  const result = await runSignIn('import', { session: staticSession({ refreshToken: 'aorAAAAAGPASTED' }), store, fetch })
  assert.equal(result.status, 'authorized')
  assert.equal(calls[0].url, 'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken')
  assert.equal(calls[0].headers['User-Agent'], 'kiro-cli/1.0.0')
  assert.equal(result.account.refreshToken, 'aorROTATED', 'a rotated token replaces the pasted one, or the next refresh starts from a burned value')
  assert.equal(result.account.authMethod, 'import')
  assert.equal(result.account.label, 'Imported token')
})

test('a token plus its client registration refreshes through OIDC instead', async () => {
  const store = fakeStore([])
  const { fetch, calls } = kiroFetch([
    [/oidc\..*\/token$/u, { accessToken: TOKEN, refreshToken: 'aotNEW', expiresIn: 900, profileArn: 'arn:aws:codewhisperer:us-east-1:1:profile/ORG' }],
  ])
  const result = await runSignIn('import', {
    session: staticSession({ refreshToken: 'aotNOFORMAT' }),
    store,
    fetch,
    settings: { clientId: 'regCid', clientSecret: 'regSecret', region: 'us-east-1' },
  })
  assert.equal(calls[0].url, `${OIDC_HOST}/token`)
  assert.equal(result.account.authMethod, 'idc')
  assert.equal(result.account.profileArn, 'arn:aws:codewhisperer:us-east-1:1:profile/ORG')
  assert.equal(result.account.clientSecret, 'regSecret')
})

test('a token the endpoint refuses is reported as a bad import', async () => {
  const { fetch } = kiroFetch([[/refreshToken$/u, new Response('{"message":"invalid_grant"}', { status: 400 })]])
  await assert.rejects(runSignIn('import', { session: staticSession({ refreshToken: 'aorSTALE' }), store: fakeStore([]), fetch }), error => {
    assert.match(error.message, /refused/iu)
    assert.equal(error.code, ERROR_CODES.auth)
    return true
  })
})

// ------------------------------------------------------------------ local session

async function fakeIdeHome({ withToken = true, withClient = true, withProfile = true } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'kiro2dsh-'))
  const cache = join(home, '.aws', 'sso', 'cache')
  const profile = join(home, '.config', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent')
  await mkdir(cache, { recursive: true })
  await mkdir(profile, { recursive: true })
  if (withToken) {
    await writeFile(join(cache, 'kiro-auth-token.json'), JSON.stringify({
      refreshToken: 'aorLOCALTOKEN',
      accessToken: 'stale-from-ide',
      region: 'eu-central-1',
      ...(withClient ? { clientIdHash: 'hash1' } : {}),
    }))
    if (withClient) {
      await writeFile(join(cache, 'hash1.json'), JSON.stringify({ clientId: 'ideCid', clientSecret: 'ideSecret' }))
    }
  }
  if (withProfile) {
    await writeFile(join(profile, 'profile.json'), JSON.stringify({ arn: 'arn:aws:codewhisperer:eu-central-1:99:profile/IDE', email: 'ide@example.com' }))
  }
  return home
}

test('the local Kiro session is found, refreshed and adopted', async () => {
  const home = await fakeIdeHome()
  try {
    const discovered = await discoverLocalCredentials({ home, platform: 'linux', env: {} })
    assert.equal(discovered.found, true)
    assert.equal(discovered.refreshToken, 'aorLOCALTOKEN')
    assert.equal(discovered.clientId, 'ideCid', 'the client registration is what lets the token rotate')
    assert.equal(discovered.region, 'eu-central-1')
    // The runtime gateway only accepts the us-east-1 spelling of a profile ARN.
    assert.equal(discovered.profileArn, 'arn:aws:codewhisperer:us-east-1:99:profile/IDE')
    assert.equal(discovered.email, 'ide@example.com')
    assert.equal(discovered.authMethod, 'import')

    const store = fakeStore([])
    const { fetch, calls } = kiroFetch([
      [/\/token$/u, { accessToken: 'opaque-not-a-jwt-token', refreshToken: 'aorFRESH', expiresIn: 3600 }],
    ])
    const result = await runSignIn('auto-import', { session: staticSession({}), store, fetch, settings: { homeDir: home } })
    assert.equal(result.status, 'authorized')
    assert.equal(result.discovered.source.includes('.aws/sso/cache'), true)
    assert.equal(result.account.label, 'Kiro IDE (local)', 'the panel has to say where the credential came from')
    assert.equal(result.account.authMethod, 'idc', 'a token with its client registration rotates through regional OIDC')
    assert.equal(result.account.region, 'eu-central-1')
    assert.equal(result.account.profileArn, 'arn:aws:codewhisperer:us-east-1:99:profile/IDE')
    // The token's own subject wins; the IDE's profile file only fills the gap, which
    // is why an opaque (non-JWT) token below falls back to the profile address.
    assert.equal(result.account.email, 'ide@example.com')
    assert.match(calls[0].url, /oidc\.eu-central-1\.amazonaws\.com\/token$/u, 'a regional client registration refreshes in its own region')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a missing local session says where it looked', async () => {
  const home = await fakeIdeHome({ withToken: false })
  try {
    const store = fakeStore([])
    const { fetch, calls } = kiroFetch([])
    await assert.rejects(runSignIn('auto-import', { session: staticSession({}), store, fetch, settings: { homeDir: home } }), error => {
      assert.equal(error.code, ERROR_CODES.notConfigured)
      assert.match(error.message, /\.aws\/sso\/cache/u)
      return true
    })
    assert.equal(calls.length, 0)
    const bare = await discoverLocalCredentials({ home, platform: 'win32', env: { APPDATA: join(home, 'AppData', 'Roaming') } })
    assert.equal(bare.found, false)
    assert.equal(bare.reason, 'no-token')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('an SSO token without its client registration is still adopted', async () => {
  const home = await fakeIdeHome({ withClient: false })
  try {
    const discovered = await discoverLocalCredentials({ home, platform: 'linux', env: {} })
    assert.equal(discovered.found, true)
    assert.equal(discovered.clientId, null)
    assert.equal(discovered.authMethod, 'import')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- coordinator

test('a parked round is forgotten after its ttl', async () => {
  const store = fakeStore([])
  const device = deviceFlow({ polls: [{ error: 'authorization_pending' }] })
  const coordinator = createSignInCoordinator({ store, fetch: kiroFetch(device.handlers).fetch, ttlMs: 20 })
  const first = await coordinator.round({ method: 'builder-id' })
  assert.equal(coordinator.pending().length, 1)
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.deepEqual(coordinator.pending(), [])
  // The abandoned round's state is now unknown to the coordinator: a fresh round
  // starts a new device code rather than failing on a dangling id.
  device.push({ accessToken: TOKEN, refreshToken: 'aorX', expiresIn: 3600 })
  const fresh = await coordinator.round({ method: 'builder-id' })
  assert.equal(fresh.status, 'authorized')
  void first
})

test('cancel drops the round and its timer', async () => {
  const store = fakeStore([])
  const device = deviceFlow({ polls: [{ error: 'authorization_pending' }] })
  const coordinator = createSignInCoordinator({ store, fetch: kiroFetch(device.handlers).fetch })
  const first = await coordinator.round({ method: 'builder-id' })
  assert.equal(coordinator.pending().length, 1)
  coordinator.cancel(first.stateId)
  assert.deepEqual(coordinator.pending(), [])
  coordinator.cancel('never-existed')
})

test('an unknown method is an answered failure, not a thrown one', async () => {
  const coordinator = createSignInCoordinator({ store: fakeStore([]), fetch: kiroFetch([]).fetch })
  const round = await coordinator.round({ method: 'telepathy' })
  assert.equal(round.status, 'failed')
  assert.equal(round.error.code, ERROR_CODES.rejected)
  assert.match(round.error.message, /unknown Kiro auth method/u)
})

test('a committed credential is activated only when the caller allows it', async () => {
  const store = fakeStore([{ id: 'existing', accessToken: 'at', refreshToken: 'aorE', enabled: true }])
  store.pool.activeId = 'existing'
  const { fetch } = kiroFetch([[/ListAvailableModels/u, { models: [{ modelId: 'claude-opus-5.5' }] }]])
  const result = await runSignIn('api_key', { session: staticSession({ apiKey: 'second-key' }), store, fetch, activate: false })
  assert.equal(result.status, 'authorized')
  assert.equal(store.pool.activeId, 'existing', 'a background import must not hijack the active account')
  assert.equal(store.pool.accounts.length, 2)
})
