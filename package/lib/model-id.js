/**
 * Model-id folding and synthetic-variant resolution.
 *
 * Two mismatches make this module necessary:
 *
 * 1. Spelling. Anthropic ships date-suffixed snapshot ids
 *    (`claude-sonnet-4-5-20250929`), while Kiro's data plane only accepts its
 *    own dotted alias (`claude-sonnet-4.5`) and answers anything else with
 *    400 `INVALID_MODEL_ID`. Any agent that forwards the vendor spelling —
 *    which is what most harnesses do — therefore fails before the model is
 *    even reached.
 * 2. Variants. `-thinking` and `-agentic` are local request modifiers, not
 *    upstream models: they select reasoning on and the chunked-write prompt.
 *    Both suffixes must be consumed before the id leaves this process.
 *
 * Matching is keyword-based rather than an exact-id table, so a future minor
 * revision folds onto a working alias instead of falling through to a 400.
 * Unknown ids pass through untouched so models Kiro adds ahead of this list
 * stay usable.
 *
 * @module lib/model-id
 */

import { AGENTIC_SUFFIX, THINKING_SUFFIX } from './constants.js'

const SNAPSHOT_SUFFIX = /-\d{8}$/u

/** Split `model(level)` / `model-thinking` style suffixes off a model id. */
export function parseSuffix(model) {
  const raw = String(model ?? '')
  const match = raw.match(/^(.*?)\((minimal|low|medium|high|xhigh|max|none|off)\)$/iu)
  if (!match) return { cleanModel: raw, override: undefined }
  const level = match[2].toLowerCase()
  return {
    cleanModel: match[1],
    override: level === 'none' || level === 'off' ? { mode: 'none' } : { mode: 'level', level },
  }
}

/**
 * Fold a vendor model id onto the alias the Kiro gateway accepts.
 * @param {string} model
 * @returns {string} the upstream alias, or the input when nothing matches
 */
export function foldUpstreamModelId(model) {
  if (typeof model !== 'string' || model === '') return model
  const id = model.toLowerCase().replace(SNAPSHOT_SUFFIX, '')

  if (id.includes('sonnet')) {
    if (id.includes('5.5') || id.includes('5-5')) return 'claude-sonnet-5.5'
    if (id.includes('4.6') || id.includes('4-6')) return 'claude-sonnet-4.6'
    if (id.includes('sonnet-5') || id.includes('sonnet.5')) return 'claude-sonnet-5'
    if (id.includes('4.5') || id.includes('4-5')) return 'claude-sonnet-4.5'
    if (id.includes('sonnet-4') || id.includes('sonnet.4')) return 'claude-sonnet-4'
    return 'claude-sonnet-4.5'
  }
  if (id.includes('fable')) return 'claude-fable-5'
  if (id.includes('opus')) {
    if (id.includes('5.5') || id.includes('5-5')) return 'claude-opus-5.5'
    if (id.includes('opus-5') || id.includes('opus.5') || id.includes('opus 5')) return 'claude-opus-5'
    if (id.includes('4.8') || id.includes('4-8')) return 'claude-opus-4.8'
    if (id.includes('4.7') || id.includes('4-7')) return 'claude-opus-4.7'
    if (id.includes('4.6') || id.includes('4-6')) return 'claude-opus-4.6'
    if (id.includes('4.5') || id.includes('4-5')) return 'claude-opus-4.5'
    return 'claude-opus-4.6'
  }
  if (id.includes('haiku')) {
    return id.includes('5.5') || id.includes('5-5') ? 'claude-haiku-5.5' : 'claude-haiku-4.5'
  }
  if (id === 'auto') return 'auto'
  if (id.includes('deepseek')) return 'deepseek-3.2'
  if (id.includes('glm')) return id.includes('5.2') || id.includes('5-2') ? 'glm-5.2' : 'glm-5'
  if (id.includes('minimax')) {
    return id.includes('2.5') || id.includes('2-5') ? 'minimax-m2.5' : 'minimax-m2.1'
  }
  if (id.includes('qwen')) return 'qwen3-coder-next'
  if (id.includes('kimi')) return 'kimi-k3'
  if (id.includes('gpt')) {
    if (id.includes('terra')) return 'gpt-5.6-terra'
    if (id.includes('luna')) return 'gpt-5.6-luna'
    if (id.includes('sol') || id.includes('5.6') || id.includes('5-6')) return 'gpt-5.6-sol'
    return model
  }
  return model
}

/** True when `model` ends in one of the synthetic variant suffixes. */
export function isSyntheticVariant(model) {
  const id = String(model ?? '')
  return id.endsWith(AGENTIC_SUFFIX) || id.endsWith(THINKING_SUFFIX)
}

/**
 * Consume the variant suffixes and fold the rest onto the upstream alias.
 * @param {string} model
 * @returns {{ requested: string, model: string, upstream: string, agentic: boolean, thinking: boolean }}
 *   `requested` is the id the caller used (with suffixes, without any `(level)` override),
 *   `model` is the catalog id this plugin exposes, `upstream` is what Kiro receives.
 */
export function resolveModelIntent(model) {
  const { cleanModel, override } = parseSuffix(model)
  let upstream = String(cleanModel ?? '')
  let agentic = false
  let thinking = false
  if (upstream.endsWith(AGENTIC_SUFFIX)) {
    agentic = true
    upstream = upstream.slice(0, -AGENTIC_SUFFIX.length)
  }
  if (upstream.endsWith(THINKING_SUFFIX)) {
    thinking = true
    upstream = upstream.slice(0, -THINKING_SUFFIX.length)
  }
  return {
    requested: cleanModel,
    model: upstream,
    upstream: foldUpstreamModelId(upstream),
    agentic,
    thinking,
    thinkingOverride: override,
  }
}

/**
 * Parse Claude's `claude-<family>-<major>[.<minor>]` version pair, treating
 * `-` and `.` as equivalent separators so both vendor spellings resolve.
 * @param {string} model
 * @returns {{ major: number, minor: number | null } | null}
 */
export function claudeVersion(model) {
  if (typeof model !== 'string') return null
  const normalized = model.toLowerCase().replace(/-/gu, '.')
  const match = normalized.match(/(?:^|[/.])claude(?:[/.][a-z]+)*[/.](\d+)(?:[/.](\d+))?(?:[/.]|$)/u)
  if (!match) return null
  return { major: Number(match[1]), minor: match[2] === undefined ? null : Number(match[2]) }
}

/** Dash/dot-insensitive equality for model ids, used for catalog lookups. */
export function sameModelId(left, right) {
  const normalize = value => String(value ?? '').toLowerCase().replace(/-/gu, '.')
  return normalize(left) === normalize(right)
}
