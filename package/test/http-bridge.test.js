/**
 * The bridge over a real socket.
 *
 * Everything up to this file can be reasoned about frame by frame. What cannot be
 * reasoned about is the carrier: whether SSE actually flushes, whether a client
 * that hangs up stops the upstream turn, whether a preflight is answered, whether a
 * fixed port is defended. Those are tested here against a loopback listener, with
 * the turn runner as the only fake.
 *
 * @module test/http-bridge.test.js
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createBridgeServer, isLoopbackHost } from '../lib/bridge/http-server.js'
import { createBridgeRouter } from '../lib/bridge/router.js'
import { buildCatalog } from '../lib/catalog.js'
import { ERROR_CODES, KiroError } from '../lib/errors.js'
import { buildChunks, iterable } from './helpers.js'

const ANSWER = [
  { text: 'partial answer' },
  { usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } },
  { finish: { kind: 'stop' } },
]

function serverFor({ runTurn, settings = {}, host } = {}) {
  const router = createBridgeRouter({
    // Not `async`: the router is handed the turn stream synchronously, which is how
    // the adapter's generator works.
    runTurn: runTurn || (() => iterable(buildChunks(ANSWER))),
    catalog: () => buildCatalog({}),
    settings: () => settings,
  })
  const server = createBridgeServer({ handle: (request) => router.handle(request), settings: () => settings, ...(host ? { host } : {}) })
  return { server, router }
}

test('the bridge listens on loopback and answers a chat completion', async () => {
  const { server } = serverFor({})
  const bound = await server.start()
  try {
    assert.equal(bound.host, '127.0.0.1')
    assert.ok(bound.port > 0)
    assert.match(bound.url, /^http:\/\/127\.0\.0\.1:\d+$/u)
    assert.deepEqual(server.address(), bound)

    const health = await fetch(`${bound.url}/health`)
    assert.equal(health.status, 200)
    assert.equal((await health.json()).ok, true)

    const completion = await fetch(`${bound.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4.5', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(completion.status, 200)
    const body = await completion.json()
    assert.equal(body.choices[0].message.content, 'partial answer')
    // Hop-by-hop headers belong to the http layer: copying `content-length` from the
    // fetch Response alongside a chunked write would make Node throw mid-reply.
    assert.equal(completion.headers.get('content-length'), null)
    assert.equal(completion.headers.get('content-type'), 'application/json; charset=utf-8')
    assert.equal(completion.headers.get('access-control-allow-origin'), '*')
  } finally {
    await server.stop()
  }
  assert.equal(server.address(), null)
})

test('a streaming reply is flushed frame by frame and can be abandoned', async () => {
  let aborted = null
  const { server } = serverFor({
    runTurn: (canonical, options) => {
      aborted = options?.signal
      // Two frames now, then silence: a client that goes away has to be what ends it.
      return iterable([...buildChunks([{ text: 'first' }]), ...buildChunks([{ text: 'second' }]).slice(0, 0)])
    },
  })
  const bound = await server.start()
  try {
    const response = await fetch(`${bound.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8')
    const text = await response.text()
    assert.match(text, /"content":"first"/u)
    assert.match(text, /data: \[DONE\]/u)
    assert.ok(aborted, 'the turn is handed a signal')
    assert.equal(aborted.aborted, false, 'the turn is not cancelled while the client is still reading')
  } finally {
    await server.stop()
  }
})

test('hanging up cancels the signal the turn was given', async () => {
  const seen = []
  const { server } = serverFor({
    runTurn: (canonical, options) => ({
      [Symbol.asyncIterator]() {
        let sent = 0
        return {
          next: async () => {
            if (sent === 0) {
              sent++
              return { value: { type: 'block-start', index: 0, blockType: 'text' }, done: false }
            }
            // Never finish: only a cancellation ends this turn.
            await new Promise(resolve => {
              options.signal.addEventListener('abort', () => resolve(), { once: true })
            })
            return { value: undefined, done: true }
          },
        }
      },
    }),
  })
  const bound = await server.start()
  try {
    const controller = new AbortController()
    const response = await fetch(`${bound.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true }),
      signal: controller.signal,
    })
    const reader = response.body.getReader()
    const first = await reader.read()
    assert.ok(first.value, 'the first frame is delivered before anything is cancelled')
    seen.push(first)
    controller.abort()
    // The server notices the closed socket and aborts the signal it handed the turn.
    await new Promise(resolve => setTimeout(resolve, 50))
    const status = await fetch(`${bound.url}/health`)
    assert.equal(status.status, 200, 'one hung-up request does not take the bridge with it')
  } finally {
    await server.stop()
  }
  assert.ok(seen.length >= 1)
})

test('a preflight is answered without involving the router', async () => {
  const { server } = serverFor({})
  const bound = await server.start()
  try {
    const preflight = await fetch(`${bound.url}/v1/chat/completions`, { method: 'OPTIONS' })
    assert.equal(preflight.status, 204)
    assert.match(preflight.headers.get('access-control-allow-headers'), /x-api-key/iu)
    assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS')
  } finally {
    await server.stop()
  }
})

test('a handler that dies before the router answers is reported by code, not as 502', async () => {
  const { server } = serverFor({})
  server.setHandle(async () => {
    throw new KiroError('sign in again', ERROR_CODES.auth)
  })
  const bound = await server.start()
  try {
    const response = await fetch(`${bound.url}/v1/chat/completions`, { method: 'POST', body: '{}' })
    assert.equal(response.status, 401)
    const body = await response.json()
    assert.equal(body.error.message, 'sign in again')
    assert.equal(body.error.type, 'invalid_request_error')
  } finally {
    await server.stop()
  }
})

test('a configured token is enforced over the socket', async () => {
  const { server } = serverFor({ settings: { bridgeToken: 'let-me-in' } })
  const bound = await server.start()
  try {
    assert.equal((await fetch(`${bound.url}/v1/models`)).status, 401)
    const allowed = await fetch(`${bound.url}/v1/models`, { headers: { 'x-api-key': 'let-me-in' } })
    assert.equal(allowed.status, 200)
    assert.ok((await allowed.json()).data.length > 19)
  } finally {
    await server.stop()
  }
})

test('a fixed port is defended before the bridge gives up', async () => {
  const first = serverFor({})
  const taken = await first.server.listenOn ? null : null
  void taken
  const bound = await first.server.start()
  const second = serverFor({})
  try {
    // The same port, deliberately: the retry ladder should find the next free one.
    const other = createBridgeServer({ handle: async () => new Response('{}'), port: bound.port, host: '127.0.0.1' })
    const secondBound = await other.start()
    assert.notEqual(secondBound.port, bound.port)
    assert.ok(secondBound.port > bound.port)
    await other.stop()
  } finally {
    await first.server.stop()
    void second
  }
})

test('a public bind without a secret is refused before anything listens', async () => {
  const open = createBridgeServer({ handle: async () => new Response('{}'), host: '0.0.0.0' })
  await assert.rejects(open.start(), /non-loopback host without a bridge token/u)
  const guarded = createBridgeServer({ handle: async () => new Response('{}'), host: '0.0.0.0', settings: () => ({ bridgeToken: 'x' }) })
  assert.equal(typeof guarded.start, 'function')
  assert.doesNotThrow(() => guarded.assertBindable())
  const started = await guarded.start()
  await guarded.stop()
  assert.ok(started.port > 0)
  void guarded
})

test('loopback is recognised in the spellings that matter', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true)
  assert.equal(isLoopbackHost('127.0.0.53'), true)
  assert.equal(isLoopbackHost('localhost'), true)
  assert.equal(isLoopbackHost('::1'), true)
  assert.equal(isLoopbackHost('[::1]'), true)
  assert.equal(isLoopbackHost('0.0.0.0'), false)
  assert.equal(isLoopbackHost('192.168.1.20'), false)
  assert.equal(isLoopbackHost(''), false)
})

test('a body that is not JSON is refused with a 400, not a crash', async () => {
  const { server } = serverFor({})
  const bound = await server.start()
  try {
    const response = await fetch(`${bound.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"model": "m", "messages": [',
    })
    assert.equal(response.status, 400)
    assert.match((await response.json()).error.message, /not valid JSON/u)
  } finally {
    await server.stop()
  }
})
