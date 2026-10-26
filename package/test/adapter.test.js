/**
 * The adapter seam: harness contract in, Kiro turn out.
 *
 * These tests pass stubs for everything the harness would provide, so what is
 * under test is the translation itself — the metadata the Models page renders, the
 * codes the retry policy routes on, and what a per-route profile changes.
 *
 * @module test/adapter.test.js
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createKiroAdapter, modelInfo, toHarnessFailureCode } from '../lib/adapter.js'
import { buildCatalog } from '../lib/catalog.js'
import { ERROR_CODES, KiroError } from '../lib/errors.js'
import { encodeEventFrame } from '../lib/kiro/eventstream.js'
import { account, drain, eventStreamResponse, fakeStore, recordingLogger } from './helpers.js'

class FakeLlmError extends Error {
  constructor(message, code, options) {
    super(message, options)
    this.name = 'LlmError'
    this.code = code
  }
}

function adapterFor({ profiles = new Map(), settings = {}, store, fetch, log } = {}) {
  return createKiroAdapter({
    LlmError: FakeLlmError,
    store: store || fakeStore([account()]),
    settings: () => settings,
    profiles: () => profiles,
    ...(fetch ? { fetch } : {}),
    log: log || recordingLogger(),
  })
}

test('the harness codes are the ones the loop routes on', () => {
  assert.equal(toHarnessFailureCode(ERROR_CODES.auth), 'AUTH')
  assert.equal(toHarnessFailureCode(ERROR_CODES.refreshExpired), 'AUTH')
  assert.equal(toHarnessFailureCode(ERROR_CODES.notConfigured), 'MISSING_CREDENTIAL')
  assert.equal(toHarnessFailureCode(ERROR_CODES.invalidCredential), 'INVALID_CREDENTIAL')
  // A spent account is not a rate limit: one needs patience, the other a decision.
  assert.equal(toHarnessFailureCode(ERROR_CODES.rateLimit), 'RATE_LIMIT')
  assert.equal(toHarnessFailureCode(ERROR_CODES.quota), 'QUOTA')
  assert.equal(toHarnessFailureCode(ERROR_CODES.modelUnavailable), 'INVALID_REQUEST')
  assert.equal(toHarnessFailureCode(ERROR_CODES.rejected), 'INVALID_REQUEST')
  assert.equal(toHarnessFailureCode(ERROR_CODES.timeout), 'TIMEOUT')
  assert.equal(toHarnessFailureCode(ERROR_CODES.endpoint), 'TRANSPORT')
  assert.equal(toHarnessFailureCode(ERROR_CODES.upstream), 'SERVER')
  // A code the harness owns already is passed through untouched, because the
  // compaction service matches on the exact string.
  assert.equal(toHarnessFailureCode('CONTEXT_WINDOW_EXCEEDED'), 'CONTEXT_WINDOW_EXCEEDED')
  assert.equal(toHarnessFailureCode('EMPTY_RESPONSE'), 'EMPTY_RESPONSE')
  assert.equal(toHarnessFailureCode('something-new'), 'UPSTREAM_ERROR')
  assert.equal(toHarnessFailureCode(undefined), 'UPSTREAM_ERROR')
})

test('the catalog the Models page reads is per-model, not per-provider', () => {
  const { modelsFor, describeModel } = adapterFor({})
  const listed = modelsFor('kiro')
  assert.ok(listed.length > 19)
  assert.ok(listed.some(model => model.id === 'claude-sonnet-4.5-thinking'))

  const opus = describeModel('kiro', 'claude-opus-4.5')
  assert.equal(opus.provider, 'kiro')
  assert.equal(opus.id, 'claude-opus-4.5')
  assert.deepEqual(opus.inputModalities, ['text', 'image'])
  assert.deepEqual(opus.context, { contextWindow: 200000 })
  assert.equal(opus.defaultMaxTokens, 32000)
  assert.deepEqual(opus.reasoning.efforts.map(effort => effort.id), ['minimal', 'low', 'medium', 'high'])
  assert.equal(opus.reasoning.defaultEffort, 'medium')
  // Reasoning-parameter families stop at `xhigh`; `max` is an output_config tier.
  assert.deepEqual(describeModel('kiro', 'gpt-5.6-sol').reasoning.efforts.map(effort => effort.id), ['low', 'medium', 'high', 'xhigh'])
  assert.ok(describeModel('kiro', 'claude-opus-5.5').reasoning.efforts.some(effort => effort.id === 'max'))
  // Kiro reads the system prompt as the first turn only, so the adapter must not
  // claim a mid-conversation update mode the wire cannot honour.
  assert.equal(opus.systemPromptUpdate, undefined)

  // Vision is per model, and so is the absence of reasoning.
  assert.deepEqual(describeModel('kiro', 'deepseek-3.2').inputModalities, ['text'])
  assert.equal(describeModel('kiro', 'kiro-auto').reasoning, undefined)
  assert.deepEqual(describeModel('kiro', 'next-big-thing'), {
    provider: 'kiro', id: 'next-big-thing', name: 'next-big-thing', inputModalities: ['text'],
  }, 'an unlisted id must still resolve, with no invented limits')
})

test('a route profile can correct the catalog without forking it', () => {
  const { describeModel, modelsFor } = adapterFor({
    profiles: new Map([['kiro', {
      displayName: 'Kiro (work)',
      defaultContextWindow: 512000,
      defaultMaxTokens: 16000,
      modelOverrides: { 'claude-haiku-4.5': { maxOutput: 8000 } },
    }]]),
  })
  assert.equal(describeModel('kiro', 'claude-haiku-4.5').defaultMaxTokens, 8000, 'the model wins over the route default')
  assert.equal(describeModel('kiro', 'ghost-model').context.contextWindow, 512000)
  assert.equal(describeModel('ghost-route', 'ghost-model').defaultMaxTokens, 16000, 'an unknown route falls back to the default profile')
  assert.ok(modelsFor('kiro').length > 19)
})

test('an explicit model list replaces the seed table wholesale', () => {
  const { modelsFor } = adapterFor({
    profiles: new Map([['kiro', { models: [{ id: 'claude-sonnet-4.5', context: 1000, maxOutput: 200, vision: false, reasoning: 'none' }] }]]),
  })
  assert.deepEqual(modelsFor('kiro').map(model => model.id), ['claude-sonnet-4.5', 'claude-sonnet-4.5-agentic'],
    'the listed model keeps its agentic variant, and a reasoning-free entry gets no thinking variant')
})

test('modelInfo is the shape normalizeModelInfo accepts', () => {
  const model = buildCatalog({}).get('claude-sonnet-4.5')
  const info = modelInfo('kiro', 'claude-sonnet-4.5', model, {})
  assert.equal(typeof info.name, 'string')
  assert.ok(info.name.length > 0)
  assert.ok(Number.isSafeInteger(info.defaultMaxTokens) && info.defaultMaxTokens > 0)
  assert.ok(info.reasoning.efforts.length > 0)
  assert.equal(new Set(info.reasoning.efforts.map(effort => effort.id)).size, info.reasoning.efforts.length)
  assert.ok(info.reasoning.efforts.every(effort => typeof effort.name === 'string' && effort.name.length > 0))
  assert.ok(info.reasoning.efforts.every(effort => effort.description.includes('Kiro') || effort.description.includes('prompt tag')))
})

test('a refresh hides what this account cannot buy, but never blocks a named request', async () => {
  const calls = []
  const fetch = async (url) => {
    calls.push(String(url))
    // Kiro's listing, in its own spelling: `contextLength`/`maxTokens` per model.
    return eventStreamResponseJson({ models: [
      { modelId: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', description: '', contextLength: 200000, maxTokens: 32000 },
      // Deliberately mis-spelled on the way back: the fold has to recognise it.
      { modelId: 'claude_haiku_4_5', name: 'Claude Haiku 4.5', contextLength: 200000, maxTokens: 32000 },
    ] })
  }
  const log = recordingLogger()
  const { refreshCatalog, selectableModels, modelsFor, describeModel, unavailable } = adapterFor({ fetch, log })
  const refreshed = await refreshCatalog('kiro')
  assert.ok(refreshed.length >= 2)
  assert.ok(calls.some(url => url.includes('ListAvailableModels')), 'the listing is asked of Kiro, not guessed')
  // Both listed models are still offered, under this plugin's ids...
  const offered = selectableModels('kiro').map(model => model.id)
  assert.ok(offered.includes('claude-sonnet-4.5'))
  assert.ok(offered.includes('claude-haiku-4.5'), 'a folded id must not become a new duplicate entry')
  assert.equal(new Set(offered).size, offered.length, 'no id is offered twice')
  // ...and everything the listing did not mention is parked as unavailable.
  assert.ok(unavailable().length > 0)
  assert.ok(modelsFor('kiro').length > selectableModels('kiro').length)
  assert.ok(unavailable().includes('claude-opus-5.5'))
  // Naming a hidden model still resolves: a stale listing is not proof.
  assert.equal(describeModel('kiro', 'claude-opus-5.5').id, 'claude-opus-5.5')
  // The listing also corrects sizes, which is the point of refreshing at all.
  assert.equal(describeModel('kiro', 'claude-sonnet-4.5').context.contextWindow, 200000)
})

test('a refresh that cannot reach Kiro keeps the offline catalog', async () => {
  const log = recordingLogger()
  const { refreshCatalog, modelsFor } = adapterFor({
    fetch: async () => { throw new Error('ECONNRESET') },
    log,
  })
  const before = modelsFor('kiro').length
  const after = await refreshCatalog('kiro')
  assert.equal(after.length, before)
  assert.ok(log.lines.some(line => line.includes('catalog refresh failed')), 'and says so once')
})

test('a refresh without a signed-in account is a debug line, not an error', async () => {
  const log = recordingLogger()
  const { refreshCatalog } = adapterFor({ store: fakeStore([]), log, fetch: async () => { throw new Error('must not be called') } })
  const listed = await refreshCatalog('kiro')
  assert.ok(listed.length > 19)
  assert.ok(log.lines.some(line => line.includes('refresh skipped')))
})

test('a failure before the first chunk is an LlmError the loop can route on', async () => {
  const store = fakeStore([account()])
  store.authorize = async () => { throw new KiroError('endpoint unreachable', ERROR_CODES.endpoint) }
  const { adapter } = adapterFor({ store })
  let error = null
  try {
    await drain(adapter.stream({ provider: 'kiro', model: 'claude-sonnet-4.5', messages: [] }))
  } catch (caught) {
    error = caught
  }
  assert.ok(error instanceof FakeLlmError)
  assert.equal(error.code, 'TRANSPORT')
  assert.match(error.message, /kiro: model "claude-sonnet-4\.5" on route "kiro" failed: endpoint unreachable/u)
})

test('a failure after the first chunk stays in band, with a harness code', async () => {
  // A frame whose declared length outruns the bytes on the wire: the stream ends
  // incomplete, which is a mid-turn failure rather than a clean stop.
  const good = encodeEventFrame({
    ':message-type': 'event',
    ':event-type': 'assistantResponseEvent',
    ':content-type': 'application/application/vnd.amazon.eventstream',
  }, { content: 'partial' })
  const truncated = good.slice(0, good.byteLength - 6)
  const fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(truncated)
      controller.close()
    },
  }), { status: 200, headers: { 'content-type': 'application/vnd.amazon.eventstream' } })
  const { adapter } = adapterFor({ fetch })
  const chunks = await drain(adapter.stream({ provider: 'kiro', model: 'claude-sonnet-4.5', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }))
  const finish = chunks.at(-1)
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'error', 'an incomplete stream is not a completed turn')
  assert.equal(finish.reason.failure.code, 'TRANSPORT', 'the in-band code is translated too')
})

test('prepareCall binds the caller signal to the dispatch', async () => {
  const seen = []
  const fetch = async (url, init) => {
    seen.push(init)
    return eventStreamResponse([
      { event: 'assistantResponseEvent', payload: { content: 'ok' } },
      { event: 'messageStopEvent', payload: { stopReason: 'end_turn' } },
    ])
  }
  const { adapter } = adapterFor({ fetch })
  const controller = new AbortController()
  const call = await adapter.prepareCall('kiro', 'claude-sonnet-4.5', controller.signal)
  assert.equal(call.model.id, 'claude-sonnet-4.5')
  await drain(call.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }))
  assert.equal(seen.length, 1)
})

test('providerInfo labels the route with the profile the operator chose', () => {
  const { adapter } = adapterFor({ profiles: new Map([['kiro', { displayName: 'Kiro (personal)' }]]) })
  assert.deepEqual(adapter.providerInfo('kiro'), { id: 'kiro', name: 'Kiro (personal)' })
  // An unregistered route inherits the default profile rather than inventing a label.
  assert.deepEqual(adapter.providerInfo('other'), { id: 'other', name: 'Kiro (personal)' })
})

/** A JSON answer, as the CodeWhisperer REST endpoints return it. */
function eventStreamResponseJson(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}
