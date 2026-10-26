/**
 * Test fixtures: a fetch double that records, a Kiro account, and an
 * AWS EventStream frame writer.
 *
 * The plugin never talks to Kiro in tests, so everything a turn needs arrives
 * from here — which is also what keeps `node --test` runnable in a checkout with
 * no `node_modules`.
 *
 * @module test/helpers
 */

import { encodeEventFrame, parseEventFrame } from '../lib/kiro/eventstream.js'

/** A minimal in-memory credential pool with the store's method names. */
export function fakeStore(accounts = [], options = {}) {
  const pool = { version: 1, activeId: accounts[0]?.id ?? null, accounts: [...accounts] }
  const calls = []
  const store = {
    pool,
    calls,
    readStore: async () => pool,
    transact: async fn => {
      const next = await fn(pool)
      if (next) Object.assign(pool, next)
      return pool
    },
    upsert: async account => {
      const id = account.id || `kiro-${pool.accounts.length + 1}`
      pool.accounts.push({ ...account, id, enabled: true })
      pool.activeId ||= id
      return { id, store: pool }
    },
    setActive: async id => {
      pool.activeId = id
      return pool
    },
    setEnabled: async (id, enabled) => {
      const account = pool.accounts.find(entry => entry.id === id)
      if (account) account.enabled = enabled
      return pool
    },
    remove: async id => {
      pool.accounts = pool.accounts.filter(entry => entry.id !== id)
      if (pool.activeId === id) pool.activeId = pool.accounts[0]?.id ?? null
      return pool
    },
    clear: async () => {
      pool.accounts = []
      pool.activeId = null
      return pool
    },
    patch: async (id, patch) => {
      const account = pool.accounts.find(entry => entry.id === id)
      if (account) Object.assign(account, patch)
      return account
    },
    authorize: async id => {
      calls.push(['authorize', id])
      const account = pool.accounts.find(entry => entry.id === (id || pool.activeId))
      if (!account) throw new Error('no Kiro account is signed in')
      return { account: options.authorizeAs ? { ...account, ...options.authorizeAs } : account, store: pool }
    },
    candidates: async () => pool.accounts.filter(account => account.enabled),
    describe: async () => ({
      activeId: pool.activeId,
      configured: pool.accounts.length > 0,
      accounts: pool.accounts.map(account => ({ ...account })),
    }),
    noteFailure: async (id, error) => {
      calls.push(['noteFailure', id, error?.code])
    },
  }
  return store
}

/** A usable account record; `expiresAt` far enough out that refresh never fires. */
export function account(overrides = {}) {
  return {
    id: 'kiro-test',
    label: 'Test Account',
    authMethod: 'builder-id',
    accessToken: 'at' + 'x'.repeat(40),
    refreshToken: 'aorTEST',
    expiresAt: Date.now() + 30 * 60 * 1000,
    region: 'us-east-1',
    profileArn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/TESTARN',
    enabled: true,
    ...overrides,
  }
}

/**
 * A `fetch` double that answers from a list of handlers and records requests.
 *
 * @param {Array<number | Response | {status?, body?, headers?, delayMs?} | ((request: Request) => Response|Promise<Response>)>} replies
 *   consumed in order; a function may return a fresh `Response` per call
 * @returns {{ fetch: (url: string, init: object) => Promise<Response>, requests: Array<{url:string, init:object, body:any}> }}
 */
export function fakeFetch(replies) {
  const requests = []
  let index = 0
  const fetch = async (url, init = {}) => {
    let body = init.body
    if (body instanceof Uint8Array || Buffer.isBuffer?.(body)) body = new TextDecoder().decode(body)
    requests.push({ url: String(url), init: { ...init, ...(body ? { body } : {}) }, body })
    const template = typeof replies === 'function' ? replies({ url, init, index: requests.length - 1 }) : replies[Math.min(index++, replies.length - 1)]
    if (typeof template === 'function') return await template({ url, init, index: requests.length - 1 })
    if (template instanceof Response) return template
    if (typeof template === 'number') return new Response('', { status: template })
    const { status = 200, headers = {}, body: responseBody = '' } = template || {}
    return new Response(responseBody, { status, headers })
  }
  return { fetch, requests }
}

/** A JSON `Response`. */
export function jsonResponse(body, status = 200, headers = { 'Content-Type': 'application/json' }) {
  return new Response(JSON.stringify(body), { status, headers })
}

/**
 * Build a `Response` whose body is AWS EventStream bytes.
 * @param {Array<{event?: string, payload?: object|null, messageType?: string, headers?: object}>} events
 */
export function eventStreamResponse(events, init = {}) {
  const frames = events.map(event => encodeEventFrame({
    ':message-type': event.messageType || 'event',
    ...(event.event ? { ':event-type': event.event } : {}),
    ':content-type': 'application/application/vnd.amazon.eventstream',
    ...(event.headers || {}),
  }, event.payload ?? null))
  const chunks = [concat(frames)]
  const stream = new ReadableStream({
    start(controller) {
      for (const frame of chunks) controller.enqueue(frame)
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'application/vnd.amazon.eventstream', ...(init.headers || {}) },
    ...init,
  })
}

/** Encode one EventStream frame as bytes, for hand-built streams. */
export function frame(event, payload = null, extraHeaders = {}) {
  return encodeEventFrame({
    ':message-type': 'event',
    ...(event ? { ':event-type': event } : {}),
    ':content-type': 'application/application/vnd.amazon.eventstream',
    ...extraHeaders,
  }, payload)
}

/** Join encoded frames into one chunk, as a real socket would deliver them. */
export function concat(frames) {
  const size = frames.reduce((total, frameBytes) => total + frameBytes.byteLength, 0)
  const out = new Uint8Array(size)
  let offset = 0
  for (const bytes of frames) {
    out.set(bytes, offset)
    offset += bytes.byteLength
  }
  return out
}

/** Decode encoded frame bytes into the `{headers, payload}` shape a reducer takes. */
export function eventShape(bytes) {
  return parseEventFrame(bytes)
}

/** A `Response` streaming several pre-encoded chunk groups. */
export function streamResponse(chunks, init = {}) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/vnd.amazon.eventstream', ...(init.headers || {}) },
    ...init,
  })
}

/** A minimal but *valid* `generateAssistantResponse` body, as the transport sees it. */
export function minimalPayload(overrides = {}) {
  return {
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId: 'conversation-1',
      currentMessage: {
        userInputMessage: {
          messageId: 'message-1',
          content: 'hello',
          modelId: 'claude-sonnet-4.5',
          userInputMessageContext: {
            tools: [{ toolSpecification: { name: 'read_file', description: 'read', inputSchema: { json: { type: 'object', properties: {} } } } }],
          },
        },
      },
      history: [],
    },
    inferenceConfig: { maxTokens: 4096 },
    ...overrides,
  }
}

/** A logger double that keeps every line, so assertions can read the log. */
export function recordingLogger() {
  const lines = []
  const records = []
  const push = level => (...args) => {
    const text = args.map(value => (typeof value === 'string' ? value : String(value))).join(' ')
    lines.push(`${level}: ${text}`)
    records.push({ level, text, args })
  }
  return { lines, records, debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') }
}

/** Collect an async iterable into an array. */
export async function drain(iterable) {
  const out = []
  for await (const value of iterable) out.push(value)
  return out
}
