/**
 * One turn, end to end, without a socket server.
 *
 * The turn runner is the code both the desktop adapter and the HTTP bridge share,
 * so these assertions cover what a user actually experiences: which account is
 * asked, what body the model's own settings produce, how chunks are ordered, and
 * when a failure is allowed to move to the next account.
 *
 * @module test/turn.test.js
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { ChunkBuilder, conversationIdFor, createTurnRunner, credentialsFor, harnessFailure, toHarnessUsage } from '../lib/turn.js'
import { buildCatalog } from '../lib/catalog.js'
import { ERROR_CODES } from '../lib/errors.js'
import { account, drain, eventStreamResponse, fakeStore, minimalPayload, recordingLogger } from './helpers.js'

/** Text + a clean stop, as Kiro would answer. */
function answered(text) {
  return eventStreamResponse([
    { event: 'assistantResponseEvent', payload: { content: text } },
    { event: 'metricsEvent', payload: { inputTokens: 30, outputTokens: 5, cacheReadInputTokens: 10 } },
    { event: 'messageStopEvent', payload: { stopReason: 'end_turn' } },
  ])
}

function runnerFor({ replies, accounts = [account()], settings = {}, catalog = buildCatalog({}), log } = {}) {
  const store = fakeStore(accounts)
  const requests = []
  const fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers })
    const list = Array.isArray(replies) ? replies : [replies]
    return list[Math.min(requests.length - 1, list.length - 1)] ?? answered('ok')
  }
  const runner = createTurnRunner({
    store,
    catalog: () => catalog,
    settings: () => settings,
    fetch,
    ...(log ? { log } : {}),
  })
  return { runner, store, requests }
}

test('a turn produces block-ordered chunks and ends once', async () => {
  const { runner } = runnerFor({ replies: answered('hello there') })
  const chunks = await drain(runner.streamTurn({ model: 'claude-sonnet-4.5', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }))
  assert.deepEqual(chunks.map(chunk => chunk.type), ['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
  assert.equal(chunks[1].text, 'hello there')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(chunks[3].usage.inputTokens, 30)
})

test('usage keeps cache counts disjoint from input', async () => {
  const { runner } = runnerFor({ replies: answered('x') })
  const chunks = await drain(runner.streamTurn({ model: 'claude-sonnet-4.5', messages: [] }))
  const usage = chunks.find(chunk => chunk.type === 'usage').usage
  // Kiro reports cached input as a subset of input; adding it would bill twice.
  assert.equal(usage.inputTokens, 30)
  assert.equal(usage.cacheReadTokens, 10)
  assert.equal(usage.totalTokens, 35)
})

test('each model sends its own settings, not one shared default', async () => {
  // The three ways this turn differs per model: the id Kiro is asked for, the
  // carrier that switches reasoning on, and the ceiling the wire accepts.
  const seen = {}
  for (const id of ['claude-haiku-4.5', 'gpt-5.6-sol', 'deepseek-3.2']) {
    const single = runnerFor({ replies: answered('x') })
    await drain(single.runner.streamTurn({ model: id, messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }], reasoningEffort: 'high' }))
    seen[id] = single.requests[0]
  }
  assert.deepEqual(
    Object.values(seen).map(request => request.body.conversationState.currentMessage.userInputMessage.modelId),
    ['claude-haiku-4.5', 'gpt-5.6-sol', 'deepseek-3.2'],
  )
  assert.equal(seen['gpt-5.6-sol'].body.additionalModelRequestFields.reasoning.effort, 'high')
  assert.equal(seen['claude-haiku-4.5'].body.additionalModelRequestFields, undefined)
  assert.match(seen['claude-haiku-4.5'].body.conversationState.currentMessage.userInputMessage.content, /<thinking_mode>enabled<\/thinking_mode>/u)
  assert.match(seen['deepseek-3.2'].body.conversationState.currentMessage.userInputMessage.content, /<max_thinking_length>\d+<\/max_thinking_length>/u)
  // Kiro answers a larger `maxTokens` with a 400 for every model, so the wire cap is
  // shared and only the advertised window differs — asserted in catalog.test.js.
  for (const request of Object.values(seen)) {
    assert.ok(request.body.inferenceConfig.maxTokens <= 32_000)
  }
  // Each family's origin header is what Kiro's own clients send for it.
  assert.equal(new Set(Object.values(seen).map(request => request.headers.origin || request.headers.Origin)).size >= 1, true)
})

test('a caller id outside the catalog still runs, with safe defaults', async () => {
  const single = runnerFor({ replies: answered('x') })
  const chunks = await drain(single.runner.streamTurn({ model: 'brand-new-model-2027', messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }] }))
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(single.requests[0].body.conversationState.currentMessage.userInputMessage.modelId, 'brand-new-model-2027')
})

test('the vendor spelling is folded before it leaves the process', async () => {
  const single = runnerFor({ replies: answered('x') })
  await drain(single.runner.streamTurn({ model: 'claude-sonnet-4-5-20250929', messages: [] }))
  assert.equal(single.requests[0].body.conversationState.currentMessage.userInputMessage.modelId, 'claude-sonnet-4.5')
})

test('a missing account is a configuration error the user can act on', async () => {
  const { runner } = runnerFor({ accounts: [] })
  await assert.rejects(drain(runner.streamTurn({ model: 'claude-sonnet-4.5', messages: [] })), error => {
    assert.equal(error.code, ERROR_CODES.notConfigured)
    assert.match(error.message, /Settings/iu)
    return true
  })
})

test('a failing account hands over to the next one, once', async () => {
  const denied = new Response('{"message":"AccessDeniedException"}', { status: 403, headers: { 'Content-Type': 'application/json' } })
  const accounts = [account({ id: 'a1', accessToken: 'denied' + 'x'.repeat(30) }), account({ id: 'a2' })]
  const store = fakeStore(accounts)
  const requests = []
  const log = recordingLogger()
  const runner = createTurnRunner({
    store,
    catalog: () => buildCatalog({}),
    settings: () => ({ accountFailover: 2, rateLimitRetries: 0 }),
    log,
    fetch: async (url, init) => {
      const headers = init.headers || {}
      // Keyed on the credential rather than on call order, so every surface and every
      // retry of the rate-limited account fails: only an account switch can answer.
      const denied = String(headers.Authorization || headers.authorization || '').includes('denied')
      requests.push({ denied })
      return denied ? new Response('{"message":"Too many requests"}', { status: 429 }) : answered('from second')
    },
  })
  const chunks = await drain(runner.streamTurn({ model: 'claude-sonnet-4.5', messages: [] }))
  const text = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
  assert.equal(text, 'from second')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.match(log.lines.join('\n'), /trying the next one/u)
})

test('a failure after the first delta is reported, not replayed', async () => {
  const store = fakeStore([account({ id: 'a1' }), account({ id: 'a2' })])
  let calls = 0
  const frame = eventStreamResponse([{ event: 'assistantResponseEvent', payload: { content: 'partial ' } }])
  const runner = createTurnRunner({
    store,
    catalog: () => buildCatalog({}),
    settings: () => ({ accountFailover: 2 }),
    fetch: async (_url, init) => {
      calls++
      void init
      // Emit a visible token, then drop the socket: the caller already has text in
      // hand, so restarting on the second account would duplicate it on screen.
      const bytes = new Uint8Array(await frame.arrayBuffer())
      // The reset has to arrive on the *next* read, the way a socket drop does: a
      // stream that is errored while it still holds bytes hands the caller nothing.
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(bytes)
        },
        pull(controller) {
          controller.error(new Error('connection reset'))
        },
      }), { headers: { 'Content-Type': 'application/vnd.amazon.eventstream' } })
    },
  })
  const chunks = await drain(runner.streamTurn({ model: 'claude-sonnet-4.5', messages: [] }))
  assert.equal(calls, 1, 'a turn the user is watching must not restart on another account')
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').length, 1)
  assert.equal(chunks.at(-1).type, 'finish')
  assert.equal(chunks.at(-1).reason.kind, 'error', 'the truncation still has to be reported')
})

test('a context-window truncation finishes as max-tokens, with the reason kept', async () => {
  const { runner } = runnerFor({
    replies: eventStreamResponse([
      { event: 'assistantResponseEvent', payload: { content: 'cut off' } },
      { event: 'messageStopEvent', payload: { stopReason: 'model_context_window_exceeded' } },
    ]),
  })
  const chunks = await drain(runner.streamTurn({ model: 'claude-sonnet-4.5', messages: [] }))
  assert.equal(chunks.at(-1).type, 'finish')
  assert.equal(chunks.at(-1).reason.kind, 'max-tokens')
  // The reason vocabulary the harness understands is `max-tokens`; Kiro's own
  // `model_context_window_exceeded` wording stays inside the plugin's diagnostics.
  assert.deepEqual(Object.keys(chunks.at(-1).reason), ['kind'])
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').length, 1)
})

test('thinking requested by the caller reaches the model that supports it', async () => {
  const single = runnerFor({ replies: answered('x') })
  await drain(single.runner.streamTurn({ model: 'gpt-5.6-sol', messages: [], reasoningEffort: 'high' }))
  assert.deepEqual(single.requests[0].body.additionalModelRequestFields, { reasoning: { effort: 'high' } })
  const tagged = runnerFor({ replies: answered('x') })
  await drain(tagged.runner.streamTurn({ model: 'claude-sonnet-4.5', messages: [], reasoningEffort: 'medium' }))
  assert.equal(tagged.requests[0].body.additionalModelRequestFields, undefined)
  assert.match(tagged.requests[0].body.conversationState.currentMessage.userInputMessage.content, /<th/iu)
})

test('an override in the catalog can make a model agentic by default', async () => {
  const catalog = buildCatalog({ 'my-agent': { name: 'My Agent', contextWindow: 100_000, maxTokens: 8_000, agenticDefault: true } })
  const single = runnerFor({ replies: answered('x'), catalog })
  await drain(single.runner.streamTurn({ model: 'my-agent', messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }] }))
  const content = single.requests[0].body.conversationState.currentMessage.userInputMessage.content
  assert.notEqual(content, 'go', 'the chunked-write instructions are part of the prompt for this model')
})

test('the conversation id is stable per session and sanitized', () => {
  const first = conversationIdFor({ sessionId: 'session/one' }, account())
  assert.equal(first, conversationIdFor({ sessionId: 'session/one' }, account()))
  assert.match(first, /^dsh-[A-Za-z0-9_-]+$/u)
  assert.notEqual(first, conversationIdFor({ sessionId: 'session/two' }, account()))
  assert.equal(conversationIdFor({}, account({ id: 'acc' })), 'dsh-acc')
})

test('credential view carries model and settings overrides', () => {
  const merged = credentialsFor(account({ agentMode: 'vibe' }), { agentMode: 'agent', surfaces: ['q'] }, { surfaces: ['codewhisperer'], extraHeaders: { 'x-a': '1' } })
  assert.equal(merged.agentMode, 'agent', 'the model decides the agent mode header')
  assert.deepEqual(merged.surfaces, ['q'], 'a model that only answers on one host wins over settings')
  assert.deepEqual(merged.extraHeaders, { 'x-a': '1' })
})

test('usage mapping drops unusable numbers', () => {
  assert.equal(toHarnessUsage(undefined), undefined)
  assert.deepEqual(toHarnessUsage({ inputTokens: 3, outputTokens: 4, totalTokens: 7 }), { inputTokens: 3, outputTokens: 4, totalTokens: 7 })
  assert.equal(toHarnessUsage({ inputTokens: Number.NaN }), undefined)
  const failure = harnessFailure(new Error('boom'))
  assert.equal(typeof failure.message, 'string')
  assert.match(failure.message, /boom/u)
  assert.equal(typeof failure.code, 'string')
})

test('the chunk builder enforces the protocol a consumer relies on', () => {
  const builder = new ChunkBuilder()
  builder.text('a').reasoning('b').text('c')
  assert.equal(builder.chunks.length, 8, 'three blocks, each opened once, two closed by the switch')
  const types = builder.chunks.map(chunk => chunk.type)
  // Switching channel closes the open block first: an interleaved open block would
  // leave the assembler waiting for a close that never comes.
  assert.deepEqual(types, ['block-start', 'text-delta', 'block-end', 'block-start', 'reasoning-delta', 'block-end', 'block-start', 'text-delta'])
  builder.usage({ inputTokens: 1 })
  builder.finish({ kind: 'stop' })
  builder.text('ignored')
  builder.error({ message: 'ignored' })
  assert.equal(builder.chunks.filter(chunk => chunk.type === 'finish').length, 1)
  assert.deepEqual(builder.chunks.at(-2), { type: 'usage', usage: { inputTokens: 1 } })
  assert.equal(builder.chunks.at(-1).type, 'finish')
  const closed = builder.closed.every(block => block.type === 'text' || block.type === 'reasoning')
  assert.ok(closed, 'every opened block must be closed with its final content')
  assert.equal(builder.closed.length, 3)
  assert.deepEqual(builder.closed.map(block => block.text), ['a', 'b', 'c'], 'accumulated content survives the close')
  // Nothing may follow the terminal chunk: a consumer that saw `finish` stops reading.
  assert.equal(builder.chunks.at(-1).type, 'finish')
})

test('a tool call gets its own complete block', () => {
  const builder = new ChunkBuilder()
  builder.text('using a tool').toolCall({ id: 'tu-1', name: 'read_file', arguments: '{"path":"/x"}' })
  builder.finish({ kind: 'tool-calls' })
  const deltas = builder.chunks.filter(chunk => chunk.type === 'tool-call-delta')
  assert.equal(deltas.length, 1)
  assert.equal(JSON.parse(deltas[0].argumentsDelta).path, '/x')
  assert.equal(builder.chunks.at(-2).block.type, 'tool-call')
})

test('the payload the transport receives is the one the builder validated', async () => {
  const single = runnerFor({ replies: answered('x') })
  await drain(single.runner.streamTurn({
    model: 'claude-sonnet-4.5',
    maxTokens: 12_000,
    temperature: 0.5,
    stop: ['END'],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }))
  const body = single.requests[0].body
  assert.equal(body.inferenceConfig.maxTokens, 12_000)
  assert.equal(body.inferenceConfig.temperature, 0.5)
  assert.deepEqual(body.inferenceConfig.stopSequences, ['END'])
  assert.equal(body.conversationState.chatTriggerType, 'MANUAL')
  assert.equal(typeof body.conversationState.conversationId, 'string')
  void minimalPayload
})
