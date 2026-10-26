/**
 * The wire behaviour that makes these models work *outside* the Kiro IDE.
 *
 * A generic client fails against Kiro for reasons that have nothing to do with the
 * model: the data plane rejects a missing device fingerprint, a wrong `Accept`, a
 * missing opt-out header, or a request sent to the other host. This file pins those
 * requirements down, together with the recovery paths (401 rotation, 429 backoff,
 * endpoint walk, one repair retry) a long-lived agent needs.
 *
 * @module test/transport.test.js
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildAuthHeaders, buildFingerprintHeaders, buildHeaders, orderedSurfaces, streamKiroTurn, surfaceUrl } from '../lib/kiro/transport.js'
import { classifyUpstream, ERROR_CODES } from '../lib/errors.js'
import { DEFAULT_CONNECT_TIMEOUT_MS, EVENTSTREAM_ACCEPT, OAUTH_SURFACE_ORDER } from '../lib/constants.js'
import { account, drain, eventStreamResponse, frame, minimalPayload, recordingLogger, streamResponse } from './helpers.js'

/** The device fingerprint is the last hyphen-separated token of the KiroIDE marker. */
function fingerprintTail(userAgent) {
  return /KiroIDE-[\d.]+-([0-9a-f]+)/u.exec(userAgent)?.[1] ?? ''
}

const credentials = {
  accessToken: 'at-secret-token',
  refreshToken: 'aorTEST',
  region: 'us-east-1',
  profileArn: 'arn:aws:codewhisperer:us-east-1:1:profile/ABC',
  clientId: 'client-id',
  authMethod: 'builder-id',
}

test('the fingerprint headers are the ones Kiro checks', () => {
  const headers = buildFingerprintHeaders(credentials, {})
  assert.match(headers['User-Agent'], /aws-sdk-js\/\d/u)
  assert.match(headers['User-Agent'], /os\/windows#/u)
  assert.match(headers['User-Agent'], /KiroIDE-[\d.]+-[0-9a-f]{32,}/u)
  // Without the opt-out, CodeWhisperer treats the caller as an IDE and answers with
  // its own feature gate — the error every outside client reports first.
  assert.equal(headers['x-amzn-codewhisperer-optout'], 'true')
  assert.equal(headers.Accept, EVENTSTREAM_ACCEPT)
  assert.match(headers['amz-sdk-invocation-id'], /^[0-9a-f-]{36}$/u)
  assert.equal(headers['x-amzn-kiro-agent-mode'], 'vibe')
})

test('the fingerprint is stable per credential and differs across credentials', () => {
  const first = buildFingerprintHeaders(credentials, {})['User-Agent']
  const again = buildFingerprintHeaders({ ...credentials }, {})['User-Agent']
  assert.equal(first, again)
  // The fingerprint is seeded from the most stable identifier available, so two
  // different clients never look like the same device.
  const other = buildFingerprintHeaders({ ...credentials, clientId: 'other-client' }, {})['User-Agent']
  assert.notEqual(fingerprintTail(first), fingerprintTail(other))
  const noClient = buildFingerprintHeaders({ accessToken: 'a', region: 'us-east-1' }, {})['User-Agent']
  assert.notEqual(fingerprintTail(first), fingerprintTail(noClient))
})

test('auth headers follow the auth method', () => {
  assert.equal(buildAuthHeaders({ authMethod: 'api_key', apiKey: 'Ki-abc' }).Authorization, 'Bearer Ki-abc')
  const bearer = buildAuthHeaders({ authMethod: 'builder-id', accessToken: 'tok' })
  assert.equal(bearer.Authorization, 'Bearer tok')
  assert.equal(bearer['x-amzn-codewhisperer-bearer-token-type'], undefined)
  const idp = buildAuthHeaders({ authMethod: 'external_idp', accessToken: 'tok' })
  assert.equal(idp.Authorization, 'Bearer tok')
  assert.equal(buildHeaders({ ...credentials, profileArn: null }, { url: 'https://q.us-east-1.amazonaws.com/x' })['x-amzn-codewhisperer-profile-arn'], undefined)
})

test('the RPC target is only sent to the legacy host', () => {
  const legacy = buildHeaders(credentials, { url: 'https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse' })
  const modern = buildHeaders(credentials, { url: 'https://q.us-east-1.amazonaws.com/generateAssistantResponse' })
  assert.match(legacy['x-amz-target'], /CodeWhispererRuntime|generateAssistantResponse/iu)
  assert.equal(modern['x-amz-target'], undefined)
})

test('extra headers from the caller are merged last', () => {
  const headers = buildHeaders(credentials, { url: 'https://q.us-east-1.amazonaws.com/generateAssistantResponse', extraHeaders: { 'x-attribution': 'dsh' } })
  assert.equal(headers['x-attribution'], 'dsh')
})

test('surfaces are walked in order and deduplicated', () => {
  assert.deepEqual(orderedSurfaces({ surfaces: ['q', 'q', 'codewhisperer'] }), ['q', 'codewhisperer'])
  assert.deepEqual(orderedSurfaces({ surfaces: ['nonsense', 'also-nonsense'] }), [...OAUTH_SURFACE_ORDER], 'a bad settings value must not disable the transport')
  assert.deepEqual(orderedSurfaces({ authMethod: 'api_key' }), ['q'], 'the CodeWhisperer surface refuses API-key payloads')
  assert.deepEqual(orderedSurfaces({}), [...OAUTH_SURFACE_ORDER])
  assert.match(surfaceUrl('q', 'eu-central-1'), /^https:\/\/q\.eu-central-1\.amazonaws\.com\/generateAssistantResponse$/u)
  assert.match(surfaceUrl('codewhisperer', 'us-gov-east-1'), /^https:\/\/codewhisperer\.us-gov-east-1\.amazonaws\.com/u)
  assert.throws(() => surfaceUrl('q', 'us-east-1.evil.example.com/'), /invalid AWS region/u)
})

test('an accepted turn streams text, usage and one terminal', async () => {
  const body = eventStreamResponse([
    { event: 'assistantResponseEvent', payload: { content: 'Hel' } },
    { event: 'assistantResponseEvent', payload: { content: 'lo' } },
    { event: 'metricsEvent', payload: { inputTokens: 10, outputTokens: 4 } },
    { event: 'messageStopEvent', payload: { stopReason: 'end_turn' } },
  ])
  const { fetch, requests } = fakeFetchOnce(body)
  void requests
  const events = await drain(streamKiroTurn({
    payload: minimalPayload(),
    credentials,
    modelSettings: { agentMode: 'vibe', id: 'claude-sonnet-4.5' },
    fetch,
  }))
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.url, 'https://q.us-east-1.amazonaws.com/generateAssistantResponse')
  const sent = JSON.parse(requests[0].body)
  assert.equal(sent.conversationState.currentMessage.userInputMessage.content, 'hello')
  assert.equal(sent.inferenceConfig.maxTokens, 4096)
  assert.equal(events.filter(event => event.type === 'text').map(event => event.text).join(''), 'Hello')
  assert.equal(events.at(-1).type, 'finish')
  assert.ok(events.some(event => event.type === 'usage'))
})

test('a 400 is terminal: no endpoint walk, no retry', async () => {
  const { fetch, requests } = fakeFetchOnce(new Response(JSON.stringify({ message: 'The provided model identifier is invalid', reasonCode: 'INVALID_MODEL_ID' }), { status: 400, headers: { 'Content-Type': 'application/json' } }))
  await assert.rejects(drain(streamKiroTurn({
    payload: minimalPayload(),
    credentials,
    modelSettings: {},
    fetch,
  })), error => {
    assert.equal(requests.length, 1, 'a rejected body must not be replayed at the other host')
    assert.equal(error.code, ERROR_CODES.modelUnavailable)
    return true
  })
})

test('a 404 on one surface falls through to the other', async () => {
  const ok = eventStreamResponse([{ event: 'assistantResponseEvent', payload: { content: 'x' } }, { event: 'messageStopEvent', payload: { stopReason: 'end_turn' } }])
  const { fetch, requests } = fakeFetchOnce([new Response('{"message":"not found"}', { status: 404 }), ok])
  const events = await drain(streamKiroTurn({ payload: minimalPayload(), credentials, modelSettings: {}, fetch }))
  assert.equal(requests.length, 2)
  assert.notEqual(requests[0].url, requests[1].url)
  assert.equal(events.at(-1).type, 'finish')
})

test('a 401 rotates the token once, then retries', async () => {
  const ok = eventStreamResponse([{ event: 'assistantResponseEvent', payload: { content: 'after refresh' } }, { event: 'messageStopEvent', payload: { stopReason: 'end_turn' } }])
  let calls = 0
  const fetch = async () => {
    calls++
    return calls === 1 ? new Response('{"message":"Unauthorized"}', { status: 401 }) : ok
  }
  let refreshed = 0
  const events = await drain(streamKiroTurn({
    payload: minimalPayload(),
    credentials,
    modelSettings: {},
    fetch,
    refresh: async () => {
      refreshed++
      return true
    },
  }))
  assert.equal(refreshed, 1)
  assert.equal(calls, 2)
  assert.equal(events.filter(event => event.type === 'text').map(event => event.text).join(''), 'after refresh')
})

test('an exhausted refresh surfaces as an auth failure', async () => {
  await assert.rejects(drain(streamKiroTurn({
    payload: minimalPayload(),
    credentials,
    modelSettings: {},
    fetch: async () => new Response('{"message":"Unauthorized"}', { status: 401 }),
    refresh: async () => false,
  })), error => {
    // Every surface refuses the same expired credential, and the error the caller
    // sees must be the auth failure, not the last host's HTTP status.
    assert.equal(error.code, ERROR_CODES.auth)
    assert.equal(error.status, 401)
    return true
  })
})

test('a 429 is retried after the advertised delay, within the cap', async () => {
  const ok = eventStreamResponse([{ event: 'assistantResponseEvent', payload: { content: 'late' } }, { event: 'messageStopEvent', payload: { stopReason: 'end_turn' } }])
  let calls = 0
  const fetch = async () => {
    calls++
    if (calls === 1) return new Response('{"message":"Too many requests"}', { status: 429, headers: { 'Retry-After': '0' } })
    return ok
  }
  const events = await drain(streamKiroTurn({
    payload: minimalPayload(),
    credentials,
    modelSettings: {},
    fetch,
    rateLimitRetries: 1,
    timeouts: { backoffMs: 1 },
  }))
  assert.equal(calls, 2)
  assert.equal(events.filter(event => event.type === 'text').map(event => event.text).join(''), 'late')
})

test('a rate-limited account gives up after its retries with the code intact', async () => {
  await assert.rejects(drain(streamKiroTurn({
    payload: minimalPayload(),
    credentials,
    modelSettings: {},
    fetch: async () => new Response('{"message":"Too many requests"}', { status: 429, headers: { 'Retry-After': '0' } }),
    rateLimitRetries: 0,
    timeouts: { backoffMs: 1 },
  })), error => {
    assert.equal(error.code, ERROR_CODES.rateLimit)
    // The 429 is what the next account-failover decision reads.
    assert.equal(error.status, 429)
    return true
  })
})

test('a malformed tool wrapper is retried once with a repair instruction', async () => {
  const broken = streamResponse([frame('toolUseEvent', { toolUseId: 'tu-1', name: 'execute_bash', input: '{"command":"unclosed' })])
  const good = eventStreamResponse([
    { event: 'assistantResponseEvent', payload: { content: 'repaired' } },
    { event: 'messageStopEvent', payload: { stopReason: 'end_turn' } },
  ])
  let calls = 0
  const bodies = []
  const fetch = async (_url, init) => {
    calls++
    bodies.push(JSON.parse(init.body))
    return calls === 1 ? broken : good
  }
  const log = recordingLogger()
  const events = await drain(streamKiroTurn({
    payload: minimalPayload({ conversationState: { ...minimalPayload().conversationState } }),
    credentials: { ...credentials, surfaces: ['q'] },
    modelSettings: {},
    fetch,
    repair: { enabled: true },
    log,
  }))
  assert.equal(calls, 2, 'the transport gets exactly one repair attempt')
  const first = bodies[0].conversationState.currentMessage.userInputMessage.content
  const second = bodies[1].conversationState.currentMessage.userInputMessage.content
  assert.notEqual(first, second, 'the retry carries an instruction the first attempt did not')
  assert.equal(events.filter(event => event.type === 'text').map(event => event.text).join(''), 'repaired')
  assert.match(log.lines.join('\n'), /repair instruction/u)
})

test('a repair is not attempted once visible text has been delivered', async () => {
  let calls = 0
  const fetch = async () => {
    calls++
    return streamResponse([
      frame('assistantResponseEvent', { content: 'partial answer' }),
      frame('toolUseEvent', { toolUseId: 'tu-1', name: 'x', input: '{broken' }),
    ])
  }
  await drain(streamKiroTurn({ payload: minimalPayload(), credentials, modelSettings: {}, fetch, repair: { enabled: true } }))
  assert.equal(calls, 1, 'a turn the user is already watching must not be replayed')
})

test('a broken frame ends the turn as incomplete, never as a clean stop', async () => {
  const truncated = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(frame('assistantResponseEvent', { content: 'half' }))
      controller.enqueue(frame('messageStopEvent', { stopReason: 'end_turn' }).subarray(0, 20))
      controller.close()
    },
  }), { headers: { 'Content-Type': EVENTSTREAM_ACCEPT } })
  const events = await drain(streamKiroTurn({ payload: minimalPayload(), credentials, modelSettings: {}, fetch: async () => truncated }))
  const last = events.at(-1)
  assert.equal(last.type, 'error')
  assert.equal(last.code, ERROR_CODES.corruptStream)
})

test('a slow first chunk times out instead of hanging the session', async () => {
  const stalled = new Response(new ReadableStream({
    start() {
      /* never enqueues */
    },
  }), { headers: { 'Content-Type': EVENTSTREAM_ACCEPT } })
  const events = await drain(streamKiroTurn({
    payload: minimalPayload(),
    credentials: { ...credentials, surfaces: ['q'] },
    modelSettings: {},
    fetch: async () => stalled,
    timeouts: { firstChunkMs: 20, idleMs: 20, connectMs: DEFAULT_CONNECT_TIMEOUT_MS },
  }))
  assert.equal(events.at(-1).type, 'error')
  assert.equal(events.at(-1).code, ERROR_CODES.timeout)
})

test('an abort signal cancels the request', async () => {
  const controller = new AbortController()
  const fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
  })
  const promise = drain(streamKiroTurn({ payload: minimalPayload(), credentials, modelSettings: {}, fetch, signal: controller.signal }))
  controller.abort()
  await assert.rejects(promise, /aborted/u)
})

test('every surface is tried before the turn is given up on', async () => {
  let calls = 0
  const urls = []
  await assert.rejects(drain(streamKiroTurn({
    payload: minimalPayload(),
    credentials,
    modelSettings: {},
    fetch: async url => {
      calls++
      urls.push(url)
      throw new Error('ECONNREFUSED')
    },
  })), error => {
    assert.equal(calls, OAUTH_SURFACE_ORDER.length)
    assert.equal(new Set(urls).size, OAUTH_SURFACE_ORDER.length, 'each surface is a different host')
    assert.equal(error.code, ERROR_CODES.endpoint)
    assert.match(error.message, /unreachable/iu)
    return true
  })
})

test('upstream classification is shared and honest about retryability', () => {
  assert.equal(classifyUpstream(401, '{}').code, ERROR_CODES.auth)
  assert.equal(classifyUpstream(401, '{}').fallback, true)
  assert.equal(classifyUpstream(403, '{"message":"Access denied"}').code, ERROR_CODES.auth)
  assert.equal(classifyUpstream(400, '{"message":"The provided model identifier is invalid"}').code, ERROR_CODES.modelUnavailable)
  assert.equal(classifyUpstream(400, '{"reasonCode":"INVALID_MODEL_ID"}').code, ERROR_CODES.modelUnavailable)
  assert.equal(classifyUpstream(400, '{}').fallback, false, 'a rejected body must not be replayed')
  assert.equal(classifyUpstream(429, '{}').retryable, true)
  assert.equal(classifyUpstream(500, 'oops').retryable, true)
  assert.match(classifyUpstream(400, '{"message":"boom"}').message, /boom/u)
  assert.equal(classifyUpstream(400, `{"message":"${'y'.repeat(3000)}"}`).message.length <= 400, true)
  // A quota answer is the account's problem, not the host's: no walk, no retry.
  assert.equal(classifyUpstream(402, '{"message":"credit balance exhausted"}').code, ERROR_CODES.quota)
  assert.equal(classifyUpstream(402, '{"message":"credit balance exhausted"}').fallback, false)
  // An HTML error page is summarized, not forwarded whole.
  assert.equal(classifyUpstream(503, `<html>${'x'.repeat(5000)}</html>`).message.length <= 400, true)
})

/** A fetch double that consumes a list of prepared responses. */
function fakeFetchOnce(replies) {
  const list = Array.isArray(replies) ? replies : [replies]
  const requests = []
  let index = 0
  return {
    requests,
    fetch: async (url, init = {}) => {
      requests.push({ url: String(url), init, body: init.body })
      const reply = list[Math.min(index++, list.length - 1)]
      if (typeof reply === 'function') return reply(url, init)
      return reply
    },
  }
}

test('a caller-injected fingerprint header cannot displace the pair the gateway reads', () => {
  const credentials = { ...account(), accessToken: 'at-token' }
  // This is what the harness mandates on every provider request, and it is the
  // single most common reason a non-IDE client is refused: the merge is
  // case-insensitive, so a plain override would rename `User-Agent` and win.
  const extraHeaders = {
    'user-agent': 'harness-agent/1.0',
    'x-amz-user-agent': 'harness-agent/1.0',
    accept: 'text/event-stream',
    'content-type': 'text/plain',
    'amz-sdk-invocation-id': 'not-a-uuid',
    'x-team-header': 'kept',
  }
  const headers = buildHeaders(credentials, { url: 'https://runtime.us-east-1.kiro.dev/generateAssistantResponse', extraHeaders })
  assert.match(headers['User-Agent'], /^aws-sdk-js\//u, 'the SDK-shaped fingerprint stays intact')
  assert.match(headers['User-Agent'], /KiroIDE-/u)
  assert.doesNotMatch(JSON.stringify(headers), /harness-agent/u, 'and is not present under another spelling either')
  assert.match(headers['x-amz-user-agent'], /^aws-sdk-js\//u)
  assert.equal(headers.Accept, EVENTSTREAM_ACCEPT)
  assert.match(headers['amz-sdk-invocation-id'], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u)
  assert.equal(headers['x-amzn-codewhisperer-optout'], 'true')
  // Everything a caller adds for its own reasons still passes through.
  assert.equal(headers['x-team-header'], 'kept')
  // A JSON surface still gets its media type, because the fingerprint rule is about
  // the *pair*, not about pretending every call is a stream.
  const json = buildHeaders(credentials, { url: 'https://q.us-east-1.amazonaws.com/ListAvailableModels', accept: 'application/json', extraHeaders })
  assert.equal(json.Accept, 'application/json')
  assert.match(json['User-Agent'], /KiroIDE-/u)
})
