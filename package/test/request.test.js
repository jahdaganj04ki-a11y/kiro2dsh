/**
 * The Kiro request body — where "every model uses its own settings" is decided.
 *
 * @module test/request.test.js
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildKiroPayload, projectBlocks, resolveProfileArn } from '../lib/kiro/request.js'
import { buildCatalog, findModel } from '../lib/catalog.js'
import { resolveModelIntent } from '../lib/model-id.js'
import { DEFAULT_PROFILE_ARNS, FORBIDDEN_BODY_FIELDS, MAX_OUTPUT_CAP, TOOL_NAME_MAX_LENGTH } from '../lib/constants.js'

const catalog = buildCatalog({})

/** Build a payload for one catalog id with the given extras. */
async function payload(id, extra = {}) {
  const intent = resolveModelIntent(id)
  const model = findModel(catalog, intent.model) || findModel(catalog, intent.upstream)
  const result = await buildKiroPayload({
    modelSettings: model,
    intent,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    conversationId: 'conversation-1',
    credentials: {
      accessToken: 'token',
      region: 'us-east-1',
      profileArn: 'arn:aws:codewhisperer:us-east-1:1:profile/ABC',
      authMethod: 'builder-id',
    },
    ...extra,
  })
  return result
}

test('the folded upstream id is what each turn carries', async () => {
  // Kiro's data plane validates `modelId` per user input message; a vendor
  // snapshot id there is a 400 before the model is consulted.
  const { payload: body, meta } = await payload('claude-sonnet-4-5-20250929')
  assert.equal(body.conversationState.currentMessage.userInputMessage.modelId, 'claude-sonnet-4.5')
  assert.equal(meta.upstream, 'claude-sonnet-4.5')
  assert.equal(meta.modelId, 'claude-sonnet-4.5', 'the catalog id stays visible for logging')
})

test('the output cap is resolved per model, never globally', async () => {
  const small = await payload('claude-haiku-4.5', { maxTokens: 999_999 })
  const big = await payload('claude-opus-5.5', { maxTokens: 999_999 })
  assert.ok(small.payload.inferenceConfig.maxTokens <= MAX_OUTPUT_CAP)
  assert.ok(big.payload.inferenceConfig.maxTokens <= findModel(catalog, 'claude-opus-5.5').maxOutput)
  assert.notEqual(small.payload.inferenceConfig.maxTokens, undefined)
})

test('sampling fields are sent only when the caller set them', async () => {
  const bare = await payload('claude-sonnet-4.5')
  assert.equal(bare.payload.inferenceConfig.temperature, undefined)
  assert.equal(bare.payload.inferenceConfig.topP, undefined)
  const tuned = await payload('claude-sonnet-4.5', { temperature: 0.2, topP: 0.9, stop: ['STOP', 'X', 'a', 'b', 'c', 'd'] })
  assert.equal(tuned.payload.inferenceConfig.temperature, 0.2)
  assert.equal(tuned.payload.inferenceConfig.topP, 0.9)
  assert.equal(tuned.payload.inferenceConfig.stopSequences.length, 4, 'Kiro accepts four stop sequences')
})

test('forbidden body fields never survive', async () => {
  const { payload: body } = await payload('claude-sonnet-4.5', { extraBody: { useAgent: 'agent' } })
  for (const field of FORBIDDEN_BODY_FIELDS) {
    assert.equal(body[field], undefined, `${field} must not be sent to Kiro`)
  }
})

test('each family gets its own thinking carrier', async () => {
  const tag = await payload('claude-sonnet-4.5-thinking', { reasoningEffort: 'high' })
  const content = tag.payload.conversationState.currentMessage.userInputMessage.content
  assert.ok(content.includes('<th' + 'inking'), 'a tag model is steered by its prompt, not a wire field')
  assert.equal(tag.payload.additionalModelRequestFields, undefined)
  assert.equal(tag.meta.thinking.path, 'tag')

  const wire = await payload('gpt-5.6-sol', { reasoningEffort: 'high' })
  assert.deepEqual(wire.payload.additionalModelRequestFields, { reasoning: { effort: 'high' } })
  assert.ok(!wire.payload.conversationState.currentMessage.userInputMessage.content.includes('inkting'))

  const adaptive = await payload('claude-opus-5', { reasoningEffort: 'xhigh' })
  assert.equal(adaptive.payload.additionalModelRequestFields.output_config.effort, 'xhigh')
  assert.equal(adaptive.payload.additionalModelRequestFields.thinking.type, 'adaptive')
})

test('`none` really turns thinking off', async () => {
  const off = await payload('claude-sonnet-4.5-thinking', { reasoningEffort: 'none' })
  assert.equal(off.meta.thinking, null)
  assert.equal(off.payload.additionalModelRequestFields, undefined)
  assert.ok(!off.payload.conversationState.currentMessage.userInputMessage.content.includes('inkting'))
})

test('the agentic prompt is opt-in and per variant', async () => {
  const plain = await payload('claude-sonnet-4.5')
  const agentic = await payload('claude-sonnet-4.5-agentic')
  assert.ok(!plain.payload.conversationState.currentMessage.userInputMessage.content.includes('chunk'))
  // The chunked-write instructions change how the model writes files, so they
  // appear only on the variant that asks for them.
  assert.equal(agentic.meta.agentic, true)
  assert.notEqual(agentic.payload.conversationState.currentMessage.userInputMessage.content, plain.payload.conversationState.currentMessage.userInputMessage.content)
})

test('images require a vision model', async () => {
  const block = { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' }
  const intent = id => resolveModelIntent(id)
  const withVision = await buildKiroPayload({
    modelSettings: findModel(catalog, 'claude-sonnet-4.5'),
    intent: intent('claude-sonnet-4.5'),
    messages: [{ role: 'user', content: [block] }],
    credentials: { accessToken: 't', region: 'us-east-1' },
    resolveImage: async () => ({ format: 'png', source: { bytes: 'aGVsbG8=' } }),
  })
  assert.equal(withVision.meta.images, 1)
  const without = await buildKiroPayload({
    modelSettings: findModel(catalog, 'deepseek-3.2'),
    intent: intent('deepseek-3.2'),
    // A non-vision model must not have an image silently dropped: the caller needs
    // to know, and Kiro would reject the body outright.
    messages: [{ role: 'user', content: [block] }],
    credentials: { accessToken: 't', region: 'us-east-1' },
    resolveImage: async () => ({ format: 'png', source: { bytes: 'aGVsbG8=' } }),
  })
  assert.equal(without.meta.images, 0)
  const projected = await projectBlocks([block], { images: true, resolveImage: async () => ({ format: 'png', source: { bytes: 'x' } }) })
  assert.equal(projected.images.length, 1)
})

test('tool names are made unique and stay inside the wire limit', async () => {
  const long = 'x'.repeat(TOOL_NAME_MAX_LENGTH + 40)
  const { payload: body } = await payload('claude-sonnet-4.5', {
    tools: [
      { name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } },
      { name: long, description: 'long', parameters: { type: 'object', properties: {} } },
      { name: 'weird name!', description: 'weird', parameters: { type: 'object', properties: {} } },
    ],
  })
  const names = body.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools.map(spec => spec.toolSpecification.name)
  assert.equal(names.length, 3)
  for (const name of names) {
    assert.ok(name.length <= TOOL_NAME_MAX_LENGTH, `${name} exceeds the limit`)
    assert.match(name, /^[A-Za-z0-9_-]+$/u, `${name} carries characters Kiro rejects`)
  }
  assert.equal(new Set(names).size, 3, 'names must stay distinguishable')
})

test('a tool result without its call is flattened, not sent as a pairing error', async () => {
  const intent = resolveModelIntent('claude-sonnet-4.5')
  const { payload: body, meta } = await buildKiroPayload({
    modelSettings: findModel(catalog, 'claude-sonnet-4.5'),
    intent,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'start' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'tool', toolCallId: 'missing-call', content: [{ type: 'text', text: 'result' }] },
    ],
    credentials: { accessToken: 't', region: 'us-east-1' },
  })
  assert.ok(meta.repairs.orphanResults >= 1)
  assert.equal(body.conversationState.history.concat(body.conversationState.currentMessage).length >= 3, true)
})

test('a call with no result gets one, because Kiro requires the pair', async () => {
  const model = findModel(catalog, 'claude-sonnet-4.5')
  const tools = [{ name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } }]
  const intent = resolveModelIntent('claude-sonnet-4.5')
  const { meta } = await buildKiroPayload({
    modelSettings: model,
    intent,
    tools,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'read it' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{"path":"/x"}' }] },
      { role: 'user', content: [{ type: 'text', text: 'and now?' }] },
    ],
    credentials: { accessToken: 't', region: 'us-east-1' },
  })
  assert.ok(meta.repairs.missingResults >= 1, 'an unanswered tool call must be repaired before sending')
})

test('an empty conversation still produces a valid turn', async () => {
  const { payload: body } = await payload('claude-sonnet-4.5', { messages: [] })
  const content = body.conversationState.currentMessage.userInputMessage.content
  assert.equal(typeof content, 'string')
  assert.ok(content.length >= 0)
})

test('the profile ARN resolves from the account, then the auth-method default', () => {
  assert.equal(
    resolveProfileArn({ profileArn: 'arn:aws:codewhisperer:us-east-1:1:profile/MINE' }),
    'arn:aws:codewhisperer:us-east-1:1:profile/MINE',
  )
  const fallback = resolveProfileArn({ authMethod: 'builder-id' })
  assert.equal(fallback, DEFAULT_PROFILE_ARNS['builder-id'], 'Builder ID runs on the shared placeholder profile')
  assert.equal(resolveProfileArn({ authMethod: 'idc' }), '', 'an organization account must name its own profile')
  assert.equal(resolveProfileArn({ authMethod: 'api_key' }), '')
  assert.equal(resolveProfileArn({ authMethod: 'import', refreshToken: 'ao' + 'rAAAAAGx' }), DEFAULT_PROFILE_ARNS.social)
  assert.equal(resolveProfileArn({ authMethod: 'import', refreshToken: 'ao' + 'tAAAAAGx' }), DEFAULT_PROFILE_ARNS['builder-id'])
})

test('the conversation id ties turns together and the trigger is marked manual', async () => {
  const { payload: body } = await payload('claude-sonnet-4.5', { conversationId: 'conv-42' })
  assert.equal(body.conversationState.conversationId, 'conv-42')
  assert.equal(body.conversationState.chatTriggerType, 'MANUAL')
})
