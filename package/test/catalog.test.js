/**
 * Per-model settings — the requirement this plugin exists to satisfy.
 *
 * Every model has to carry its own endpoint, context window, output cap, vision
 * flag and reasoning mechanism, because Kiro rejects a request whose `modelId` is
 * paired with a token count over its ceiling, and answers a thinking-untagged
 * Claude request differently from a GPT `reasoning.effort` request. A single
 * "max tokens" setting for the whole provider is what makes other harnesses fail.
 *
 * @module test/catalog.test.js
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EFFORT_LABELS,
  GPT_EFFORTS,
  SEED_MODELS,
  buildCatalog,
  catalogOrder,
  claudeEfforts,
  describeCapabilities,
  effortWireValue,
  findModel,
  mergeLiveCatalog,
  normalizeModel,
  reasoningInfo,
  TAG_BUDGETS,
  reasoningPath,
  resolveMaxTokens,
} from '../lib/catalog.js'
import { DEFAULT_MAX_OUTPUT, MAX_OUTPUT_CAP, THINKING_BUDGET_MAX, THINKING_BUDGET_MIN } from '../lib/constants.js'

const catalog = buildCatalog({})

test('the seed table is populated and unique', () => {
  assert.ok(SEED_MODELS.length >= 19, `expected a catalog of real Kiro models, got ${SEED_MODELS.length}`)
  const ids = new Set(SEED_MODELS.map(model => model.id))
  assert.equal(ids.size, SEED_MODELS.length, 'seed ids must be unique')
  for (const model of SEED_MODELS) {
    assert.ok(model.context > 0, `${model.id} needs a context window`)
    assert.ok(model.maxOutput > 0, `${model.id} needs an output cap`)
    assert.ok(model.maxOutput <= model.context, `${model.id} cannot out-emit its own window`)
  }
})

test('each family gets the thinking carrier Kiro actually accepts', () => {
  // Sending the wrong carrier is a 400, so this mapping is the whole difference
  // between "works in Kiro" and "works elsewhere".
  assert.equal(reasoningPath('gpt-5.6-sol'), 'reasoning')
  assert.equal(reasoningPath('claude-sonnet-4.5'), 'tag')
  assert.equal(reasoningPath('claude-opus-4.5'), 'tag')
  // 4.6+ moved to a wire field, and the legacy date-suffixed spelling kept the tag.
  assert.equal(reasoningPath('claude-opus-4.6'), 'output_config')
  assert.equal(reasoningPath('claude-opus-4.20250805'), 'tag')
  // A family that documents no reasoning field still gets thinking, through the
  // prompt tag — that is how Kiro itself turns it on for DeepSeek or MiniMax.
  assert.equal(reasoningPath('deepseek-3.2'), 'tag')
  assert.equal(findModel(catalog, 'deepseek-3.2').reasoning, 'tag')
  assert.equal(findModel(catalog, 'minimax-m2.1').reasoning, 'tag')
  // The router model has no thinking control of its own, so nothing is sent.
  assert.equal(findModel(catalog, 'auto').reasoning, 'none')
  assert.equal(effortWireValue(findModel(catalog, 'auto'), 'high'), null)
})

test('an unsupported tier is clamped down, never dropped or invented', () => {
  // xhigh is a 4.7+ tier: asking for it on a 4.6 model means "think harder", so the
  // strongest tier that model accepts is sent instead of no thinking at all.
  const sonnet46 = findModel(catalog, 'claude-sonnet-4.6')
  assert.deepEqual([...sonnet46.efforts], ['low', 'medium', 'high', 'max'])
  assert.equal(effortWireValue(sonnet46, 'xhigh'), 'high')
  const opus5 = findModel(catalog, 'claude-opus-5.5')
  assert.equal(effortWireValue(opus5, 'xhigh'), 'xhigh')
  assert.equal(effortWireValue(opus5, 'max'), 'max')
  // GPT has no `max` tier on the wire; the reference translator maps it to xhigh.
  const gpt = findModel(catalog, 'gpt-5.6-sol')
  assert.equal(effortWireValue(gpt, 'max'), 'xhigh')
  assert.equal(effortWireValue(gpt, 'minimal'), null)
  // A tag-path model gets a budget; the clamp lands on the budget list it declares.
  const deepseek = findModel(catalog, 'deepseek-3.2')
  assert.equal(effortWireValue(deepseek, 'xhigh'), TAG_BUDGETS.high)
})

test('effort wire values are per family', () => {
  const gpt = findModel(catalog, 'gpt-5.6-sol')
  assert.equal(gpt.reasoning, 'reasoning')
  assert.equal(effortWireValue(gpt, 'high'), 'high')
  const claude = findModel(catalog, 'claude-opus-4.5')
  assert.equal(claude.reasoning, 'tag')
  // An id the family does not offer has no wire value; the caller then omits the
  // field instead of sending something Kiro will reject.
  assert.equal(effortWireValue(gpt, 'minimal'), null)
  // A tag-path model carries the effort as a thinking-token budget, not a string.
  assert.equal(typeof effortWireValue(claude, 'high'), 'number')
})

test('claude efforts widen on the models that document the wider range', () => {
  assert.deepEqual(claudeEfforts('claude-sonnet-4.5'), ['low', 'medium', 'high'])
  assert.deepEqual(claudeEfforts('claude-opus-5'), ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.ok(GPT_EFFORTS.includes('xhigh'))
})

test('max output is clamped to the wire ceiling, per model', () => {
  const model = findModel(catalog, 'claude-sonnet-4.5')
  assert.equal(resolveMaxTokens(model, 10), 10)
  void model
  assert.equal(resolveMaxTokens(model, undefined), model.maxOutput)
  assert.ok(resolveMaxTokens(model, 10_000_000) <= MAX_OUTPUT_CAP)
  assert.ok(resolveMaxTokens(model, 10_000_000) <= model.maxOutput)
  // A non-positive request means "no preference", not "answer in one token".
  assert.equal(resolveMaxTokens(model, -5), model.maxOutput)
  assert.equal(resolveMaxTokens(model, 0), model.maxOutput)
  assert.equal(resolveMaxTokens(model, Number.NaN), model.maxOutput)
  assert.equal(normalizeModel({ id: 'x' }).maxOutput, DEFAULT_MAX_OUTPUT)
  assert.equal(normalizeModel({ id: 'x' }).context, 200_000)
})

test('vision is declared, not assumed', () => {
  const withVision = findModel(catalog, 'claude-sonnet-4.5')
  const without = findModel(catalog, 'deepseek-3.2')
  assert.equal(withVision.vision, true)
  assert.deepEqual(withVision.inputModalities, ['text', 'image'])
  assert.equal(without.vision, false)
  assert.deepEqual(without.inputModalities, ['text'])
})

test('`auto` is listed as a router without agentic instructions', () => {
  const auto = findModel(catalog, 'auto')
  assert.equal(auto.upstream, 'auto')
  assert.equal(auto.reasoning, 'none')
  assert.equal(auto.efforts, false)
  assert.equal(auto.agentic, false)
})

test('variant ids inherit the base model sizes', () => {
  const base = findModel(catalog, 'claude-sonnet-4.5')
  const thinking = findModel(catalog, 'claude-sonnet-4.5-thinking')
  assert.equal(thinking.upstream, base.upstream)
  assert.equal(thinking.context, base.context)
  assert.equal(thinking.maxOutput, base.maxOutput)
  assert.equal(thinking.variantOf, base.id)
  assert.equal(thinking.thinkingTag, true)
})

test('reasoning metadata is shaped for the harness model page', () => {
  const model = findModel(catalog, 'gpt-5.6-sol')
  const info = reasoningInfo(model)
  assert.ok(info.efforts.length > 0)
  for (const entry of info.efforts) {
    assert.equal(typeof entry.id, 'string')
    assert.equal(typeof entry.name, 'string')
    assert.equal(typeof entry.description, 'string')
    assert.ok(entry.description.length > 0, 'an empty description renders as a blank row')
  }
  assert.ok(info.efforts.some(entry => entry.id === info.defaultEffort))
  assert.equal(reasoningInfo(findModel(catalog, 'auto')), undefined)
  assert.ok(Object.keys(EFFORT_LABELS).length > 0)
})

test('the catalog orders strongest-first so a picker does not lead with `auto`', () => {
  const ids = catalogOrder(catalog).map(model => model.id)
  assert.ok(ids.indexOf('auto') > ids.length / 2, 'auto should not lead the list')
  assert.ok(ids.length > SEED_MODELS.length, 'variants must be listed too')
})

test('capability descriptions match what a turn will enforce', () => {
  const model = findModel(catalog, 'claude-opus-5.5')
  const described = describeCapabilities(model)
  assert.equal(described.vision, model.vision)
  assert.equal(described.context, model.context)
  assert.equal(described.max_output, model.maxOutput)
  assert.equal(described.reasoning, model.reasoning)
  assert.deepEqual(described.input_modalities, model.inputModalities)
  assert.equal(described.tools, true)
})

test('a live Kiro catalog corrects the seed table instead of replacing it', () => {
  const live = [{ modelId: 'claude-sonnet-4.5', modelName: 'Claude Sonnet 4.5 (Kiro)', tokenLimits: { maxInputTokens: 300_000 }, rateMultiplier: 1.1 }]
  const { catalog: merged, missing } = mergeLiveCatalog(buildCatalog({}), live)
  assert.ok(missing.includes('claude-opus-4.5'), 'a model the account cannot list must be reported')
  const model = findModel(merged, 'claude-sonnet-4.5')
  assert.equal(model.context, 300_000, 'the account-specific window must win')
  assert.equal(model.rateMultiplier, 1.1)
  assert.equal(model.name, 'Claude Sonnet 4.5 (Kiro)')
  // Untouched models keep their seed sizes: a partial listing must not flatten
  // the rest of the catalog to defaults.
  assert.equal(findModel(merged, 'claude-opus-4.5').context, findModel(catalog, 'claude-opus-4.5').context)
  assert.equal(model.name, 'Claude Sonnet 4.5 (Kiro)')
})

test('a model Kiro added after this table ships is still usable', () => {
  const { catalog: merged } = mergeLiveCatalog(buildCatalog({}), [{ modelId: 'glm-9', modelName: 'GLM 9', tokenLimits: { maxInputTokens: 250_000 } }])
  const model = findModel(merged, 'glm-9')
  assert.ok(model, 'an unlisted id must appear in the catalog')
  assert.equal(model.context, 250_000)
  assert.equal(model.maxOutput, DEFAULT_MAX_OUTPUT)
})

test('model overrides are normalized like seeds', () => {
  const custom = buildCatalog({ 'my-model': { name: 'Mine', contextWindow: 500_000, maxTokens: 40_000, vision: true } })
  const model = findModel(custom, 'my-model')
  assert.equal(model.context, 500_000)
  assert.equal(model.maxOutput, 40_000)
  assert.equal(model.vision, true)
  assert.equal(model.upstream, 'my-model')
  assert.ok(THINKING_BUDGET_MIN < THINKING_BUDGET_MAX)
})
