/**
 * Model-id folding: the mismatch that makes an outside client fail outright.
 *
 * @module test/model-id.test.js
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { foldUpstreamModelId, isSyntheticVariant, parseSuffix, resolveModelIntent } from '../lib/model-id.js'

test('vendor snapshot ids fold onto the alias Kiro accepts', () => {
  // A date-suffixed Anthropic id is what most harnesses forward, and Kiro answers
  // it with 400 INVALID_MODEL_ID — so the fold is the whole reason these models
  // work outside the IDE at all.
  assert.equal(foldUpstreamModelId('claude-sonnet-4-5-20250929'), 'claude-sonnet-4.5')
  assert.equal(foldUpstreamModelId('claude-opus-4-1-20250805'), 'claude-opus-4.6')
  assert.equal(foldUpstreamModelId('anthropic.claude-3-5-sonnet-20241022-v2:0'), 'claude-sonnet-4.5')
})

test('families map onto Kiro naming', () => {
  assert.equal(foldUpstreamModelId('claude-opus-4.7'), 'claude-opus-4.7')
  assert.equal(foldUpstreamModelId('claude-sonnet-5'), 'claude-sonnet-5')
  assert.equal(foldUpstreamModelId('claude-haiku-5.5'), 'claude-haiku-5.5')
  assert.equal(foldUpstreamModelId('gpt-5.6-sol'), 'gpt-5.6-sol')
  assert.equal(foldUpstreamModelId('gpt-5.6-luna'), 'gpt-5.6-luna')
  assert.equal(foldUpstreamModelId('deepseek-v3.2'), 'deepseek-3.2')
  assert.equal(foldUpstreamModelId('qwen3-coder'), 'qwen3-coder-next')
  assert.equal(foldUpstreamModelId('kimi-k2'), 'kimi-k3')
  assert.equal(foldUpstreamModelId('glm-5.2'), 'glm-5.2')
  assert.equal(foldUpstreamModelId('minimax-m2.5'), 'minimax-m2.5')
})

test('an unknown id is forwarded untouched', () => {
  // Kiro adds models faster than any table can track; a fold that guessed would
  // silently reroute a brand-new model onto an older one.
  assert.equal(foldUpstreamModelId('gpt-9-turbo'), 'gpt-9-turbo')
  assert.equal(foldUpstreamModelId('llama-4'), 'llama-4')
  assert.equal(foldUpstreamModelId(''), '')
})

test('`auto` stays `auto`', () => {
  assert.equal(foldUpstreamModelId('auto'), 'auto')
})

test('`(level)` suffix is consumed as an override, not part of the id', () => {
  assert.deepEqual(parseSuffix('claude-sonnet-4.5(high)'), { cleanModel: 'claude-sonnet-4.5', override: { mode: 'level', level: 'high' } })
  assert.deepEqual(parseSuffix('claude-sonnet-4.5(none)'), { cleanModel: 'claude-sonnet-4.5', override: { mode: 'none' } })
  assert.deepEqual(parseSuffix('claude-sonnet-4.5'), { cleanModel: 'claude-sonnet-4.5', override: undefined })
})

test('variant suffixes resolve into intent flags', () => {
  assert.equal(isSyntheticVariant('claude-sonnet-4.5-thinking'), true)
  assert.equal(isSyntheticVariant('claude-sonnet-4.5'), false)
  const intent = resolveModelIntent('claude-sonnet-4.5-thinking-agentic')
  assert.equal(intent.thinking, true)
  assert.equal(intent.agentic, true)
  assert.equal(intent.model, 'claude-sonnet-4.5')
  assert.equal(intent.upstream, 'claude-sonnet-4.5')
  assert.equal(intent.requested, 'claude-sonnet-4.5-thinking-agentic')
})

test('an effort override rides on top of a snapshot id', () => {
  const intent = resolveModelIntent('claude-opus-4-5-20250929(max)')
  assert.equal(intent.upstream, 'claude-opus-4.5')
  assert.deepEqual(intent.thinkingOverride, { mode: 'level', level: 'max' })
})
