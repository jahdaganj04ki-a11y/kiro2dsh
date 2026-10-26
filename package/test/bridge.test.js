/**
 * The local OpenAI/Anthropic bridge: request in, wire out.
 *
 * The bridge exists so tools that speak only one of those two dialects can drive
 * Kiro at all, which means its contract is the formats themselves: a client that
 * sees `content_block_start` twice for one index, a `finish_reason` we invented, or
 * a system prompt silently dropped does not file a bug report — it just gets a
 * worse answer. So the assertions below are the bytes a client parses.
 *
 * @module test/bridge.test.js
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { estimateTokens, parseDataUri, requestText, resolveEffort, toCanonicalRequest, toToolSchemas } from '../lib/bridge/formats.js'
import { assertAuthorized, createBridgeRouter, modelList } from '../lib/bridge/router.js'
import { anthropicJSON, anthropicSSE, anthropicStopReason, openaiFinishReason, openaiJSON, openaiSSE, sse } from '../lib/bridge/render.js'

import { buildCatalog } from '../lib/catalog.js'
import { ERROR_CODES, KiroError } from '../lib/errors.js'
import { account as fakeAccount, buildChunks, fakeStore, iterable } from './helpers.js'

function concat(frames) {
  const out = new Uint8Array(frames.reduce((sum, frame) => sum + frame.length, 0))
  let offset = 0
  for (const frame of frames) {
    out.set(frame, offset)
    offset += frame.length
  }
  return out
}

/** Collect SSE frames into parsed events: `{ event, data }`. */
export async function collect(source) {
  const frames = []
  for await (const frame of source) frames.push(frame)
  const text = new TextDecoder().decode(concat(frames))
  const events = []
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue
    const eventName = /^event: (.+)$/mu.exec(block)?.[1] ?? null
    const data = /^data: (.*)$/mu.exec(block)?.[1]
    events.push({ event: eventName, data: data === undefined ? null : data === '[DONE]' ? '[DONE]' : JSON.parse(data) })
  }
  return events
}

const ANSWER = [
  { reasoning: 'thinking first' },
  { text: 'Hello' },
  { text: ' world' },
  { usage: { inputTokens: 120, outputTokens: 7, totalTokens: 127, cacheReadTokens: 40 } },
  { finish: { kind: 'stop' } },
]

function routerFor({ script = ANSWER, settings = {}, runTurn, store, usage, catalog = buildCatalog({}), seen = [] } = {}) {
  const router = createBridgeRouter({
    runTurn: runTurn || ((canonical, options) => {
      seen.push({ canonical, options })
      return iterable(buildChunks(script))
    }),
    catalog: () => catalog,
    settings: () => settings,
    ...(store ? { store } : {}),
    ...(usage ? { usage } : {}),
  })
  return { router, seen }
}

function request(path, init = {}) {
  return new Request(`http://127.0.0.1:0${path}`, init)
}

function post(path, body, headers = {}) {
  return request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
}

// ------------------------------------------------------------------ request side

test('an OpenAI request becomes the canonical turn the app would have run', () => {
  const canonical = toCanonicalRequest({
    model: 'kiro/claude-sonnet-4.5',
    messages: [
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{"p":"/x"}' } }] },
      { role: 'tool', tool_call_id: 'call-1', content: 'ok' },
      { role: 'project-manager', content: 'folded' },
    ],
    tools: [{ type: 'function', function: { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } } }],
    max_completion_tokens: 900,
    temperature: 0.2,
    stop: '.',
    stream: true,
  }, 'openai')
  assert.equal(canonical.model, 'kiro/claude-sonnet-4.5')
  assert.equal(canonical.maxTokens, 900)
  assert.equal(canonical.temperature, 0.2)
  assert.deepEqual(canonical.stop, ['.'])
  assert.equal(canonical.stream, true)
  assert.equal(canonical.messages.length, 5)
  assert.equal(canonical.messages[0].role, 'system')
  assert.deepEqual(canonical.messages[1].content[1], { type: 'image', mediaType: 'image/png', data: 'AAAA' })
  assert.equal(canonical.messages[2].content[0].type, 'tool-call')
  assert.equal(canonical.messages[2].content[0].arguments, '{"p":"/x"}')
  assert.deepEqual(canonical.messages[3], { role: 'tool', toolCallId: 'call-1', isError: false, content: [{ type: 'text', text: 'ok' }] })
  assert.equal(canonical.messages[4].role, 'user', 'an unknown role is content from the human, not an error')
  assert.deepEqual(canonical.tools, [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } }])
})

test('Anthropic shapes map onto the same canonical message', () => {
  const canonical = toCanonicalRequest({
    model: 'claude-opus-5.5',
    system: [{ type: 'text', text: 'Instructions', cache_control: { type: 'ephemeral' } }],
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'bash', input: { cmd: 'ls' } }, { type: 'thinking', thinking: 'private' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: [{ type: 'text', text: 'result' }], is_error: true }] },
    ],
    tools: [{ name: 'bash', description: 'Run', input_schema: { type: 'object' } }],
    max_tokens: 2048,
  }, 'anthropic')
  assert.equal(canonical.messages[0].role, 'system', 'the top-level system field is the instructions, not an orphan')
  assert.equal(canonical.messages[0].content[0].text, 'Instructions')
  assert.equal(canonical.messages[1].content[0].type, 'tool-call')
  assert.equal(canonical.messages[1].content[0].arguments, '{"cmd":"ls"}')
  assert.deepEqual(canonical.messages[1].content[1], undefined, 'a prior chain of thought is not replayed')
  assert.equal(canonical.messages[2].content[0].type, 'tool-result')
  assert.equal(canonical.messages[2].content[0].isError, true)
  assert.equal(canonical.messages[2].content[0].content, 'result')
  assert.deepEqual(canonical.tools, [{ name: 'bash', description: 'Run', parameters: { type: 'object' } }])
  assert.equal(canonical.maxTokens, 2048)
  assert.deepEqual(canonical.stop, undefined)
})

test('an explicit system message in the array is not duplicated', () => {
  const canonical = toCanonicalRequest({
    model: 'm',
    system: 'ignored in favour of the message',
    messages: [{ role: 'system', content: 'said once' }, { role: 'user', content: 'q' }],
  }, 'anthropic')
  assert.deepEqual(canonical.messages.map(message => message.role), ['system', 'user'])
  assert.equal(canonical.messages[0].content[0].text, 'said once')
})

test('media that cannot cross the wire is said out loud rather than dropped', () => {
  const canonical = toCanonicalRequest({
    model: 'm',
    messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
      { type: 'image_url', image_url: { url: 'data:image/bmp;base64,Qk0=' } },
      { type: 'input_audio', audio: { data: 'AAA', format: 'wav' } },
      { type: 'text', text: 'and the question' },
    ] }],
  }, 'openai')
  const blocks = canonical.messages[0].content
  assert.deepEqual(blocks.map(block => block.type), ['text', 'text', 'text', 'text'])
  assert.match(blocks[0].text, /^\[Image: https:\/\/example\.com\/cat\.png\]$/u)
  assert.equal(blocks[1].text, '[Unsupported attachment: image/bmp]', 'a bmp is not a png, and a wrong label fails on the far side')
  assert.match(blocks[2].text, /Audio input is not supported/u)
  assert.equal(parseDataUri('data:image/jpeg;charset=utf-8;base64,QQ==').mimeType, 'image/jpeg')
  assert.equal(parseDataUri('data:text/plain;base64,QQ==').mimeType, 'text/plain', 'the parser is honest about what it was given')
  assert.equal(parseDataUri('https://example.com/x.png'), null)
})

test('stop sequences survive both spellings', () => {
  assert.deepEqual(toCanonicalRequest({ model: 'm', messages: [], stop: ['a', '', 7, 'b'] }, 'openai').stop, ['a', 'b'])
  assert.deepEqual(toCanonicalRequest({ model: 'm', messages: [], stop_sequences: ['END', ''] }, 'anthropic').stop, ['END'])
})

test('a request that cannot name a model is refused before anything runs', () => {
  for (const body of [{}, { model: '  ' }, null]) {
    assert.throws(() => toCanonicalRequest(body, 'openai'), error => {
      assert.equal(error.code, ERROR_CODES.rejected)
      return true
    })
  }
})

test('thinking is asked for in whichever dialect the client knows', () => {
  assert.equal(resolveEffort({ reasoning_effort: 'HIGH' }), 'high')
  assert.equal(resolveEffort({ reasoning_effort: 'none' }), 'none')
  assert.equal(resolveEffort({ reasoning: { effort: 'xhigh' } }), 'xhigh')
  assert.equal(resolveEffort({ output_config: { effort: 'max' } }), 'max')
  assert.equal(resolveEffort({ thinking: { type: 'disabled' } }), 'none')
  assert.equal(resolveEffort({ thinking: { type: 'enabled', budget_tokens: 4096 } }), 'medium')
  assert.equal(resolveEffort({ thinking: { type: 'enabled', budget_tokens: 200 } }), 'low')
  assert.equal(resolveEffort({ thinking: { type: 'enabled', budget_tokens: 30_000 } }), 'xhigh')
  assert.equal(resolveEffort({ max_thinking_tokens: 100 }), 'medium')
  assert.equal(resolveEffort({ max_thinking_tokens: 0 }), 'none')
  assert.equal(resolveEffort({}), undefined)
  const canonical = toCanonicalRequest({ model: 'm', messages: [], reasoning_effort: 'none' }, 'openai')
  assert.equal(canonical.reasoningEffort, undefined)
  assert.equal(canonical.thinkingDisabled, true, 'off has to be said, or the model default answers instead')
})

test('tool_choice none removes the declarations, because Kiro cannot be asked politely', () => {
  const body = { tools: [{ type: 'function', function: { name: 'a', parameters: {} } }] }
  assert.equal(toToolSchemas(body, 'openai').length, 1)
  assert.deepEqual(toToolSchemas({ ...body, tool_choice: 'none' }, 'openai'), [])
  assert.deepEqual(toToolSchemas({ tools: [{ name: 'skip-me' }, null] }, 'openai'), [], 'a tool with no input schema is not a tool')
})

test('the token estimate is an order of magnitude, honestly labelled', () => {
  const canonical = toCanonicalRequest({ model: 'm', messages: [{ role: 'user', content: 'abcdefgh' }] }, 'openai')
  assert.equal(estimateTokens(requestText(canonical.messages)), 3)
  assert.equal(estimateTokens(''), 1)
  assert.equal(estimateTokens(undefined), 1)
})

// ------------------------------------------------------------------ answer frames

test('the SSE framer writes what the spec says', () => {
  const framed = new TextDecoder().decode(sse('message_start', { type: 'message_start' }))
  assert.equal(framed, 'event: message_start\ndata: {"type":"message_start"}\n\n')
  assert.equal(new TextDecoder().decode(sse(null, { a: 1 })), 'data: {"a":1}\n\n')
  assert.equal(new TextDecoder().decode(sse('ping')), 'event: ping\n\n')
})

test('OpenAI streaming: role first, deltas, usage last, one [DONE]', async () => {
  const events = await collect(openaiSSE(iterable(buildChunks(ANSWER)), { model: 'claude-sonnet-4.5' }))
  assert.equal(events.at(-1).data, '[DONE]')
  assert.equal(events.filter(event => event.data === '[DONE]').length, 1)
  assert.equal(events[0].data.choices[0].delta.role, 'assistant')
  const deltas = events.slice(1).flatMap(event => event.data?.choices?.[0]?.delta?.content ? [event.data.choices[0].delta.content] : [])
  assert.equal(deltas.join(''), 'Hello world')
  const reasoning = events.flatMap(event => event.data?.choices?.[0]?.delta?.reasoning_content || [])
  assert.deepEqual(reasoning, ['thinking first'], 'thinking reaches the channel reasoning clients already read')
  const final = events.at(-2).data
  assert.equal(final.choices[0].finish_reason, 'stop')
  assert.equal(final.usage.prompt_tokens, 160, 'cached input is part of what was billed')
  assert.equal(final.usage.completion_tokens, 7)
  assert.equal(final.usage.total_tokens, 167)
  assert.deepEqual(final.usage.prompt_tokens_details, { cached_tokens: 40 })
})

test('OpenAI streaming: tool calls arrive as function fragments, usage can be declined', async () => {
  const script = [
    { text: 'one moment' },
    { tool: { id: 'call-9', name: 'read', arguments: '{"path":"/x"}' } },
    { finish: { kind: 'tool-calls' } },
  ]
  const events = await collect(openaiSSE(iterable(buildChunks(script)), { model: 'm', includeUsage: false }))
  const toolFrame = events.find(event => event.data?.choices?.[0]?.delta?.tool_calls)
  assert.deepEqual(toolFrame.data.choices[0].delta.tool_calls[0].function, { name: 'read', arguments: '{"path":"/x"}' })
  assert.equal(toolFrame.data.choices[0].delta.tool_calls[0].id, 'call-9')
  assert.equal(events.at(-2).data.choices[0].finish_reason, 'tool_calls')
  assert.equal(events.at(-2).data.usage, undefined)
})

test('OpenAI streaming: a failure after the header is serialized into the stream', async () => {
  const script = [{ text: 'partial' }, { error: { message: 'upstream went away', code: ERROR_CODES.upstream } }]
  const events = await collect(openaiSSE(iterable(buildChunks(script)), { model: 'm' }))
  const failure = events.find(event => event.data?.error)
  assert.equal(failure.data.error.message, 'upstream went away')
  assert.equal(events.at(-1).data, '[DONE]', 'a stream that ends on an error still ends cleanly')
})

test('an empty OpenAI stream still produces a valid completion', async () => {
  const events = await collect(openaiSSE(iterable([]), { model: 'm' }))
  assert.equal(events.length, 3)
  assert.equal(events[1].data.choices[0].finish_reason, 'stop')
  assert.equal(events.at(-1).data, '[DONE]')
})

test('OpenAI JSON answers carry the message, the tools and the billing', async () => {
  const script = [
    { text: 'done: ' },
    { tool: { id: 'c1', name: 'bash', arguments: '{"cmd":"ls"}' } },
    { usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } },
    { finish: { kind: 'tool-calls' } },
  ]
  const { status, body } = await openaiJSON(iterable(buildChunks(script)), { model: 'claude-opus-5.5' })
  assert.equal(status, 200)
  assert.equal(body.object, 'chat.completion')
  assert.equal(body.model, 'claude-opus-5.5')
  assert.equal(body.choices[0].message.content, 'done: ')
  assert.deepEqual(body.choices[0].message.tool_calls[0].function, { name: 'bash', arguments: '{"cmd":"ls"}' })
  assert.equal(body.choices[0].finish_reason, 'tool_calls')
  assert.deepEqual(body.usage, { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 })
  const onlyTool = await openaiJSON(iterable(buildChunks([{ tool: { id: 'c1', name: 'bash', arguments: '{}' } }, { finish: { kind: 'tool-calls' } }])), { model: 'm' })
  assert.equal(onlyTool.body.choices[0].message.content, null, 'a tool-only turn says "no text", not "empty text"')
  const failed = await openaiJSON(iterable(buildChunks([{ error: { message: 'nope', code: 'AUTH' } }])), { model: 'm' })
  assert.equal(failed.status, 502)
  assert.equal(failed.body.error.code, 'AUTH')
})

test('Anthropic streaming opens and closes every content block exactly once', async () => {
  const events = await collect(anthropicSSE(iterable(buildChunks(ANSWER)), { model: 'claude-sonnet-4.5' }))
  assert.deepEqual(events.map(event => event.event), [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'content_block_start',
    'content_block_delta',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ])
  assert.equal(events[0].data.message.role, 'assistant')
  assert.equal(events[1].data.content_block.type, 'thinking')
  assert.equal(events[2].data.delta.type, 'thinking_delta')
  assert.equal(events[2].data.delta.thinking, 'thinking first')
  assert.equal(events[5].data.delta.type, 'text_delta')
  const starts = events.filter(event => event.event === 'content_block_start')
  assert.equal(new Set(starts.map(event => event.data.index)).size, starts.length, 'one start per index, or a strict SDK sees two blocks')
  const last = events.at(-2)
  assert.equal(last.data.delta.stop_reason, 'end_turn')
  assert.deepEqual(last.data.usage, { input_tokens: 120, output_tokens: 7, cache_read_input_tokens: 40 })
  assert.equal(events.at(-1).event, 'message_stop')
})

test('Anthropic streaming renders a tool call as an input_json_delta', async () => {
  const script = [
    { tool: { id: 'tu-7', name: 'write', arguments: '{"path":"/y"}' } },
    { finish: { kind: 'tool-calls' } },
  ]
  const events = await collect(anthropicSSE(iterable(buildChunks(script)), { model: 'm' }))
  const start = events.find(event => event.event === 'content_block_start')
  assert.deepEqual(start.data.content_block, { type: 'tool_use', id: 'tu-7', name: 'write', input: {} })
  const delta = events.find(event => event.data?.delta?.type === 'input_json_delta')
  assert.equal(delta.data.delta.partial_json, '{"path":"/y"}')
  assert.equal(events.at(-2).data.delta.stop_reason, 'tool_use')
  assert.ok(events.some(event => event.event === 'content_block_stop'), 'the tool block is closed before the message ends')
})

test('Anthropic streaming reports a mid-stream failure as an error event', async () => {
  const script = [{ text: 'so far' }, { error: { message: 'provider exploded' } }]
  const events = await collect(anthropicSSE(iterable(buildChunks(script)), { model: 'm' }))
  const error = events.find(event => event.event === 'error')
  assert.equal(error.data.error.message, 'provider exploded')
  assert.equal(events.at(-2).data.delta.stop_reason, 'refusal')
})

test('Anthropic JSON assembles blocks and repairs a broken tool payload', async () => {
  const script = [
    { reasoning: 'plan' },
    { text: 'answer' },
    { tool: { id: 'tu-1', name: 'bash', arguments: '{"cmd":"ls' } },
    { usage: { inputTokens: 9, outputTokens: 4, cacheReadTokens: 2 } },
    { finish: { kind: 'max-tokens' } },
  ]
  const { status, body } = await anthropicJSON(iterable(buildChunks(script)), { model: 'claude-opus-5.5' })
  assert.equal(status, 200)
  assert.equal(body.type, 'message')
  assert.deepEqual(body.content.map(block => block.type), ['thinking', 'text', 'tool_use'])
  assert.deepEqual(body.content[2].input, {}, 'an argument payload that never completed stays parseable')
  assert.equal(body.stop_reason, 'max_tokens')
  assert.deepEqual(body.usage, { input_tokens: 9, output_tokens: 4, cache_read_input_tokens: 2 })
  assert.equal(body.role, 'assistant')
  assert.equal(body.model, 'claude-opus-5.5')
})

test('the finish-reason mappers name the two vocabularies', () => {
  assert.equal(openaiFinishReason({ kind: 'stop' }), 'stop')
  assert.equal(openaiFinishReason('tool-calls'), 'tool_calls')
  assert.equal(openaiFinishReason({ kind: 'max-tokens' }), 'length')
  assert.equal(openaiFinishReason({ kind: 'error', failure: {} }), 'stop', 'OpenAI has no error reason, so the client reads the error frame instead')
  assert.equal(anthropicStopReason({ kind: 'error' }), 'refusal')
  assert.equal(anthropicStopReason({ kind: 'aborted' }), 'end_turn')
  assert.equal(anthropicStopReason(undefined), 'end_turn')
})

// ------------------------------------------------------------------------ router

test('the health route answers without touching the network', async () => {
  const { router } = routerFor({})
  for (const path of ['/health', '/']) {
    const response = await router.handle(request(path))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.provider, 'kiro')
    assert.ok(body.models >= 19)
    assert.ok(body.prefixes.includes('kiro/'))
  }
})

test('the model list describes what each id can actually do', async () => {
  const { router } = routerFor({})
  const openai = await (await router.handle(request('/v1/models'))).json()
  assert.equal(openai.object, 'list')
  const haiku = openai.data.find(model => model.id === 'claude-haiku-4.5')
  assert.equal(haiku.owned_by, 'kiro')
  assert.equal(haiku.context_length, 200_000)
  assert.deepEqual(haiku.supported_input_modalities, ['text', 'image'])
  assert.deepEqual(haiku.supported_reasoning_efforts, ['minimal', 'low', 'medium', 'high'])
  const deepseek = openai.data.find(model => model.id === 'deepseek-3.2')
  assert.deepEqual(deepseek.supported_input_modalities, ['text'], 'a family Kiro refuses images for is listed without image support')
  const auto = openai.data.find(model => model.id === 'auto')
  assert.equal(auto.supported_reasoning_efforts, null)
  assert.equal(openai.data.some(model => model.id === 'claude-haiku-4.5-thinking'), true, 'the variants a turn can run are listed for selection')

  const anthropic = await (await router.handle(request('/v1/models?format=anthropic'))).json()
  assert.equal(anthropic.data[0].type, 'model')
  const listed = anthropic.data.find(model => model.id === 'gpt-5.6-sol')
  assert.equal(listed.display_name, 'GPT 5.6 Sol')
  assert.equal(listed.max_input_tokens, 272_000)
  assert.equal(typeof listed.capabilities, 'object')
  assert.equal(anthropic.has_more, false)
  assert.equal(modelList(buildCatalog({}), 'anthropic').last_id, anthropic.data.at(-1).id)
})

test('the bridge secret is checked in both header spellings', () => {
  const headers = new Headers({ authorization: 'Bearer let-me-in' })
  assert.doesNotThrow(() => assertAuthorized({ headers }, { bridgeToken: 'let-me-in' }))
  assert.equal(assertAuthorized({ headers }, { bridgeToken: '' }), undefined, 'no configured token means any local process')
  assert.throws(() => assertAuthorized({ headers: new Headers({ authorization: 'Bearer wrong' }) }, { privateAccessToken: 'let-me-in' }), error => {
    assert.equal(error.code, ERROR_CODES.auth)
    assert.equal(error.status, 401)
    return true
  })
  assert.doesNotThrow(() => assertAuthorized({ headers: new Headers({ 'x-api-key': 'let-me-in' }) }, { bridgeToken: 'let-me-in' }))
  assert.throws(() => assertAuthorized({ headers: new Headers() }, { bridgeToken: 'let-me-in' }), /invalid bridge credentials/u)
})

test('a request without the secret is a 401 from the router too', async () => {
  const { router } = routerFor({ settings: { bridgeToken: 'secret-value' } })
  const response = await router.handle(post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'hi' }] }))
  assert.equal(response.status, 401)
  const body = await response.json()
  assert.equal(body.error.type, 'invalid_request_error')
  assert.doesNotMatch(JSON.stringify(body), /secret-value/u)
  const allowed = await router.handle(post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { Authorization: 'Bearer secret-value' }))
  assert.equal(allowed.status, 200)
})

test('endpoints that do not exist say so, and completions says why', async () => {
  const { router } = routerFor({})
  assert.equal((await router.handle(request('/v1/chat/completions'))).status, 405)
  assert.equal((await router.handle(post('/nope', {}))).status, 404)
  const legacy = await router.handle(post('/v1/completions', { model: 'm', prompt: 'x' }))
  assert.equal(legacy.status, 400)
  assert.match((await legacy.json()).error.message, /\/v1\/chat\/completions/u)
  const broken = await router.handle(request('/v1/chat/completions', { method: 'POST', body: '{oops' }))
  assert.equal(broken.status, 400)
  assert.match((await broken.json()).error.message, /not valid JSON/u)
})

test('count_tokens answers with the estimate a Claude client expects', async () => {
  const { router } = routerFor({})
  const body = await (await router.handle(post('/v1/messages/count_tokens', {
    model: 'claude-sonnet-4.5',
    system: 'rules',
    messages: [{ role: 'user', content: 'the question goes here' }],
  }))).json()
  assert.ok(Number.isInteger(body.input_tokens))
  assert.ok(body.input_tokens > 3)
})

test('a non-streaming OpenAI call runs one turn and answers as JSON', async () => {
  const { router, seen } = routerFor({})
  const response = await router.handle(post('/v1/chat/completions', {
    model: 'kiro/claude-sonnet-4.5',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 500,
    reasoning_effort: 'high',
  }))
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /application\/json/u)
  const body = await response.json()
  assert.equal(body.choices[0].message.content, 'Hello world')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].canonical.model, 'kiro/claude-sonnet-4.5', 'the turn runner owns the namespace, not the bridge')
  assert.equal(seen[0].canonical.maxTokens, 500)
  assert.equal(seen[0].canonical.reasoningEffort, 'high')
  assert.equal(seen[0].canonical.stream, false)
})

test('a streaming call is SSE and carries the client cancellation into the turn', async () => {
  const { router, seen } = routerFor({})
  const controller = new AbortController()
  const response = await router.handle(new Request('http://127.0.0.1:0/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'claude-opus-5.5', messages: [{ role: 'user', content: 'hi' }], stream: true, stream_options: { include_usage: false } }),
    signal: controller.signal,
  }))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8')
  assert.equal(response.headers.get('cache-control'), 'no-cache, no-transform', 'an SSE body must not be buffered by a proxy')
  const text = await response.text()
  assert.match(text, /data: \[DONE\]/u)
  assert.doesNotMatch(text, /"usage"/u, 'the client declined usage and must not be billed for it anyway')
  assert.equal(seen[0].canonical.stream, true)
  // A `Request` re-wraps the caller's signal, so identity is meaningless; what
  // matters is that the forwarded signal dies with the client.
  assert.equal(seen[0].options.signal.aborted, false)
  controller.abort()
  assert.equal(seen[0].options.signal.aborted, true, 'a hang-up has to reach the Kiro request, not just the socket')
})

test('declining nothing in stream_options still reports usage', async () => {
  const { router } = routerFor({})
  const response = await router.handle(post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true }))
  assert.match(await response.text(), /"prompt_tokens":160/u)
})

test('an Anthropic call gets an Anthropic body', async () => {
  const { router, seen } = routerFor({})
  const response = await router.handle(post('/v1/messages', {
    model: 'claude-sonnet-4.5',
    system: 'Be terse.',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 100,
  }, { 'anthropic-version': '2023-06-01' }))
  const body = await response.json()
  assert.equal(body.type, 'message')
  assert.equal(body.content.at(-1).text, 'Hello world')
  assert.equal(body.stop_reason, 'end_turn')
  assert.equal(seen[0].canonical.messages[0].role, 'system')
})

test('a turn that fails before the first frame becomes an HTTP status', async () => {
  const cases = [
    [new KiroError('the account must sign in again', ERROR_CODES.auth), ERROR_CODES.auth, 401],
    [new KiroError('slow down', ERROR_CODES.rateLimit, { status: 429 }), ERROR_CODES.rateLimit, 429],
    [new KiroError('that model is not in this catalog', ERROR_CODES.modelUnavailable, { status: 400 }), ERROR_CODES.modelUnavailable, 400],
    [new Error('something odd'), undefined, 502],
  ]
  for (const [error, code, status] of cases) {
    void 0
    const { router } = routerFor({
      runTurn: () => {
        throw error
      },
    })
    const response = await router.handle(post('/v1/chat/completions', { model: 'm', messages: [] }))
    assert.equal(response.status, status, error.message)
    const body = await response.json()
    assert.equal(body.error.code ?? null, code ?? null)
    assert.equal(body.error.message, error.message)
    if (status >= 500) assert.equal(body.error.type, 'upstream_error')
  }
})

test('a turn that fails after the first frame is written into the stream', async () => {
  const { router } = routerFor({
    runTurn: async function * () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'half an answer' }
      throw new Error('the socket died')
    },
  })
  const response = await router.handle(post('/v1/chat/completions', { model: 'm', messages: [], stream: true }))
  const text = await response.text()
  assert.match(text, /half an answer/u)
  assert.match(text, /"error":\{"message":"the socket died"/u)
  assert.match(text, /data: \[DONE\]\n\n$/u)
})

test('the status route says what is configured without giving anything away', async () => {
  const store = fakeStore([fakeAccount()])
  const { router } = routerFor({
    store,
    usage: async () => ({ used: 12, limit: 50, resourceType: 'AGENTIC_REQUEST' }),
    settings: { bridgeToken: 'topsecret', surfaces: ['q'], baseUrl: 'https://runtime.us-east-1.kiro.dev', modelRewrites: { a: 'b' } },
  })
  // The status page names accounts, so it is behind the same secret as the model calls.
  const guarded = await router.handle(request('/v1/kiro/status'))
  assert.equal(guarded.status, 401)
  const body = await (await router.handle(request('/v1/kiro/status', { headers: { Authorization: 'Bearer topsecret' } }))).json()
  assert.equal(body.accounts[0].label, 'Test Account')
  assert.equal(body.activeId, 'kiro-test')
  assert.equal(body.configured, true)
  assert.deepEqual(body.usage, { used: 12, limit: 50, resourceType: 'AGENTIC_REQUEST' })
  assert.equal(body.catalog >= 19, true)
  assert.equal(body.settings.bridgeTokenConfigured, true)
  assert.deepEqual(body.settings.surfaces, ['q'])
  assert.deepEqual(body.settings.modelRewrites, { a: 'b' })
  assert.equal(body.settings.autoImportLocalAuth, true)
  assert.doesNotMatch(JSON.stringify(body), /topsecret|atx{20,}|aorTEST/u)
  const failing = routerFor({ store, usage: async () => { throw new Error('quota endpoint down') }, settings: {} })
  const second = await (await failing.router.handle(request('/v1/kiro/status'))).json()
  assert.equal(second.usage, null, 'a quota failure must not take the status page down')

  // A store that handed over raw records must still not leak a credential.
  const leaking = routerFor({ store: fakeStore([fakeAccount()], { rawDescribe: true }), usage: async () => null, settings: {} })
  const third = await (await leaking.router.handle(request('/v1/kiro/status'))).text()
  assert.doesNotMatch(third, /atx{10,}|aorTEST/u, 'no credential, only its last four characters')
  assert.match(third, /"hasRefreshToken": true/u, 'the redacted view still says what is configured')
  assert.match(third, /"refreshToken": "…TEST"/u)
})
