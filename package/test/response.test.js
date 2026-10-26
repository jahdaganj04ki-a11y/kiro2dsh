/**
 * Turning Kiro's events into one answer.
 *
 * Kiro splits a turn across `assistantResponseEvent`, `codeEvent`,
 * `reasoningContentEvent`, `toolUseEvent`, `messageStopEvent`, `metadataEvent`,
 * `metricsEvent` and `meteringEvent` — and not every model emits all of them, in
 * every order, or at all before the socket ends. The reducer has to produce a
 * correct answer *and* a correct terminal state from whatever arrives.
 *
 * @module test/response.test.js
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { KiroTurnReducer, mergeStopReason, normalizeStopReason, stopDisposition } from '../lib/kiro/response.js'
import { eventShape, frame } from './helpers.js'

/** Feed frames through a reducer and collect the events. */
function collect(frames, options = {}) {
  const reducer = new KiroTurnReducer(options)
  const events = []
  for (const item of frames) events.push(...reducer.push(item))
  events.push(...reducer.finish())
  return { events, reducer }
}

// The reducer consumes decoded frames, so the fixture decodes once and reuses.
const f = (event, payload, headers) => eventShape(frame(event, payload, headers))

test('text and code events both reach the answer', () => {
  const { events } = collect([
    f('assistantResponseEvent', { content: 'Hello ' }),
    f('codeEvent', { content: 'world' }),
    f('messageStopEvent', { stopReason: 'end_turn' }),
  ])
  const text = events.filter(event => event.type === 'text').map(event => event.text).join('')
  assert.equal(text, 'Hello world')
  assert.equal(events.at(-1).type, 'finish')
  assert.equal(events.at(-1).reason, 'stop')
  assert.equal(events.at(-1).stopReason, 'end_turn')
})

test('reasoning streams as its own channel', () => {
  const { events } = collect([
    f('reasoningContentEvent', { reasoningContentEvent: { text: 'thinking…' } }),
    f('assistantResponseEvent', { content: 'answer' }),
  ])
  assert.deepEqual(events.map(event => event.type), ['reasoning', 'text', 'finish'])
  assert.equal(events[0].text, 'thinking…')
})

test('an inline think-tag stream is separated from the answer', () => {
  // Some Kiro models put their reasoning in the text channel wrapped in tags.
  // Echoing those tags to the harness would show a user raw markup, and dropping
  // the content would lose the reasoning the UI renders.
  const { events } = collect([
    f('assistantResponseEvent', { content: '<th' + 'inking>plan a' }),
    f('assistantResponseEvent', { content: 'nd b</th' + 'inking>the answer' }),
  ])
  const reasoning = events.filter(event => event.type === 'reasoning').map(event => event.text).join('')
  const text = events.filter(event => event.type === 'text').map(event => event.text).join('')
  assert.equal(reasoning, 'plan and b')
  assert.equal(text, 'the answer')
  assert.ok(!text.includes('inkting'), 'no tag fragment may leak into the answer')
})

test('tool calls are emitted once, with complete arguments', () => {
  const { events } = collect([
    f('toolUseEvent', { toolUseId: 'tu-1', name: 'read_file', input: '{"path":' }),
    f('toolUseEvent', { toolUseId: 'tu-1', input: '"/etc/hosts"}' }),
    f('messageStopEvent', {}),
  ])
  const calls = events.filter(event => event.type === 'tool-call')
  assert.equal(calls.length, 1, 'a fragmented tool call must not be emitted twice')
  assert.equal(calls[0].name, 'read_file')
  assert.equal(JSON.parse(calls[0].arguments).path, '/etc/hosts')
  assert.equal(events.at(-1).reason, 'tool-calls')
})

test('an unterminated tool call is an error, not a partial tool call', () => {
  // Kiro can end the stream mid-arguments. Emitting a broken `toolUse` would make
  // the harness execute a truncated command, so the turn fails instead.
  const { events } = collect([
    f('toolUseEvent', { toolUseId: 'tu-1', name: 'execute_bash', input: '{"command":"rm -rf /' }),
  ])
  const error = events.find(event => event.type === 'error')
  assert.ok(error, 'a truncated tool call must surface as an error')
  assert.equal(error.code, 'INVALID_KIRO_TOOL_CALL')
  assert.equal(error.stopDisposition, 'retryable_protocol_failure')
  assert.equal(events.some(event => event.type === 'tool-call'), false)
  assert.equal(stopDisposition('malformed_model_output'), 'retryable_protocol_failure')
})

test('usage merges metrics and metering without double counting', () => {
  const { events } = collect([
    f('assistantResponseEvent', { content: 'x' }),
    f('metricsEvent', { inputTokens: 1200, outputTokens: 340, cacheReadInputTokens: 900, cacheCreationInputTokens: 10 }),
    f('meteringEvent', { usage: 0.4, unit: 'credit' }),
    f('messageStopEvent', { stopReason: 'end_turn' }),
  ])
  assert.equal(events.filter(event => event.type === 'usage').length, 1, 'usage is emitted once, before the terminal')
  const usage = events.find(event => event.type === 'usage')
  assert.equal(usage.usage.inputTokens, 1200)
  assert.equal(usage.usage.cacheReadTokens, 900)
  // Input and cached input overlap on Kiro, so the harness must not add them.
  assert.equal(usage.usage.totalTokens, 1200 + 340)
  assert.equal(usage.usage.kiroCredits, 0.4)
})

test('max_tokens and maxItems reached are both reported as a length stop', () => {
  // The reducer speaks Kiro's vocabulary; `lib/turn.js` maps it onto the harness's.
  for (const value of ['MAX_TOKENS', 'max_tokens', 'maxTokens', 'length', 'max_output_tokens']) {
    assert.equal(normalizeStopReason(value), 'max_tokens')
  }
  assert.equal(normalizeStopReason('tool_use'), 'tool_use')
  assert.equal(normalizeStopReason(''), null)
  const { events } = collect([
    f('assistantResponseEvent', { content: 'partial' }),
    f('metadataEvent', { stopReason: 'MAX_TOKENS' }),
  ])
  assert.equal(events.at(-1).reason, 'max-tokens')
  assert.equal(events.at(-1).diagnostics.stop_disposition, 'length')
  // A truncated turn still reports which reason cut it short, so the harness can
  // tell "hit the output cap" from "the socket died".
  assert.equal(normalizeStopReason('model_context_window_exceeded'), 'model_context_window_exceeded')
  assert.equal(stopDisposition('model_context_window_exceeded'), 'terminal_incomplete')
})

test('a stop reason survives an empty stream, and the merge keeps the worse one', () => {
  assert.equal(mergeStopReason('end_turn', 'max_tokens'), 'max_tokens')
  assert.equal(mergeStopReason('tool_use', 'end_turn'), 'tool_use')
  assert.equal(mergeStopReason(null, null), null)
})

test('an empty answer is reported, never delivered as a successful turn', () => {
  // A turn with no content either way must not finish clean, or the loop persists an
  // empty assistant message and replays the same request forever.
  for (const frames of [[], [f('messageStopEvent', { stopReason: 'end_turn' })]]) {
    const { events } = collect(frames)
    assert.equal(events.at(-1).type, 'error')
    assert.equal(events.at(-1).code, 'EMPTY_RESPONSE')
  }
  const clean = collect([f('messageStopEvent', { stopReason: 'end_turn' })]).events.at(-1)
  assert.equal(clean.stopDisposition, 'retryable_protocol_failure', 'a clean empty stop deserves one repair retry')
})

test('an EventStream error frame ends the turn with the upstream reason', () => {
  const { events } = collect([{
    headers: { ':message-type': 'error' },
    payload: { message: 'too many tokens', __type: 'ValidationException' },
  }])
  assert.equal(events[0].type, 'error')
  assert.match(events[0].message, /too many tokens/u)
})

test('context usage is carried for the caller to trim against', () => {
  const { reducer } = collect([f('contextUsageEvent', { contextUsagePercentage: 92 })])
  assert.equal(reducer.state.contextUsagePercentage, 92)
})

test('unknown events are ignored rather than fatal', () => {
  // Kiro adds event types; a turn must survive an event this build has never seen.
  const { events } = collect([
    f('someFutureEvent', { note: 'hello' }),
    f('assistantResponseEvent', { content: 'ok' }),
  ])
  assert.equal(events.filter(event => event.type === 'error').length, 0)
  assert.equal(events.filter(event => event.type === 'text').length, 1)
})

test('a tool call over the size bound fails the turn instead of truncating', () => {
  const big = JSON.stringify({ command: 'x'.repeat(2048) })
  const { events } = collect([
    f('toolUseEvent', { toolUseId: 'tu-1', name: 'execute_bash', input: big }),
  ], { maxToolBytes: 64 })
  assert.ok(events.some(event => event.type === 'error'))
})

test('finish() is idempotent', () => {
  const reducer = new KiroTurnReducer()
  reducer.push(f('assistantResponseEvent', { content: 'a' }))
  assert.equal(reducer.finish().filter(event => event.type === 'finish').length, 1)
  assert.deepEqual(reducer.finish(), [])
})
