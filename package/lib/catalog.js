/**
 * Per-model capability catalog.
 *
 * Kiro does not treat its models uniformly, and the differences are the exact
 * things that make a generic client fail:
 *
 * | dimension | why it differs |
 * |---|---|
 * | endpoint surface | API-key accounts are rejected by the CodeWhisperer host; OAuth accounts by the deprecated kiro.dev path gateway |
 * | image input | the Claude and GPT families accept `images`; DeepSeek/Qwen/GLM answers a payload carrying them with a 400 |
 * | context window | `tokenLimits.maxInputTokens` per model (200k, 272k, 1M) |
 * | output cap | `inferenceConfig.maxTokens` above the model ceiling is a 400, not a clamp |
 * | reasoning | modern Claudes want `additionalModelRequestFields.output_config.effort`, GPT 5.6 wants `reasoning.effort`, legacy models only understand the `<thinking_mode>` prompt tag |
 * | effort tiers | `xhigh`/`max` are rejected on pre-4.7 Claude; `max` maps to `xhigh` on GPT |
 * | agentic prompt | only meaningful for a coding agent, so `auto` must not receive it |
 *
 * Each model therefore carries a full settings record. The live
 * `ListAvailableModels` catalog is merged over this seed whenever an account is
 * connected, because upstream is the authority on sizes and availability; the
 * seed keeps the plugin usable offline and supplies the fields Kiro does not
 * disclose (effort path, endpoint preference, agentic support).
 *
 * @module lib/catalog
 */

import {
  AGENTIC_SUFFIX,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT,
  MAX_OUTPUT_CAP,
  THINKING_BUDGET_DEFAULT,
  THINKING_SUFFIX,
} from './constants.js'
import { clamp, positiveInt } from './util.js'
import { claudeVersion, foldUpstreamModelId, sameModelId } from './model-id.js'

/** Effort tiers per Claude generation, learned from the upstream schema. */
export function claudeEfforts(model) {
  const version = claudeVersion(model)
  if (!version) return ['low', 'medium', 'high']
  if (version.major > 5 || (version.major === 5 && version.minor !== null && version.minor > 0)) {
    return ['low', 'medium', 'high', 'xhigh', 'max']
  }
  if (version.major === 5) return ['low', 'medium', 'high', 'xhigh', 'max']
  if (version.major === 4 && version.minor !== null && version.minor >= 7) return ['low', 'medium', 'high', 'xhigh', 'max']
  if (version.major === 4 && version.minor !== null && version.minor === 6) return ['low', 'medium', 'high', 'max']
  return ['low', 'medium', 'high']
}

/**
 * Which wire field carries the reasoning level for one model.
 * @param {string} model folded upstream id
 * @returns {'output_config'|'reasoning'|'tag'|'none'}
 */
export function reasoningPath(model) {
  const id = String(model ?? '').toLowerCase().replace(/-/gu, '.')
  if (/(?:^|[/.])gpt[/.]5[/.]6(?:[/.]|$)/u.test(id)) return 'reasoning'
  if (!id.includes('claude')) return 'tag'
  const version = claudeVersion(model)
  if (!version) return 'tag'
  const { major, minor } = version
  // A date-suffixed snapshot (`4.5.20250929`) is the legacy Anthropic spelling;
  // Kiro answered additionalModelRequestFields with a 400 for those.
  const dateSuffixMinor = minor !== null && minor >= 1000
  return major < 4 || (major === 4 && (minor === null || minor <= 5 || dateSuffixMinor)) ? 'tag' : 'output_config'
}

/** Effort ids a `reasoning`-path (GPT) model accepts. */
export const GPT_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh'])

/** Prompt-tag models get budgets rather than levels. */
export const TAG_BUDGETS = Object.freeze({
  minimal: 1024,
  low: 4096,
  medium: THINKING_BUDGET_DEFAULT,
  high: 24000,
  xhigh: 32000,
  max: 32000,
})

/** Human labels for effort ids, used by both the harness picker and the panel. */
export const EFFORT_LABELS = Object.freeze({
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Maximum',
})

/**
 * Seed catalog. `upstream` is the id Kiro receives; every other field is local
 * behaviour. Entries are grouped by family and each one states its endpoint
 * preference explicitly, so a future family change is a table edit rather than
 * a hunt through the transport layer.
 */
export const SEED_MODELS = Object.freeze([
  {
    id: 'claude-opus-5.5',
    name: 'Claude Opus 5.5',
    context: 1_000_000,
    maxOutput: 128_000,
    vision: true,
    rateMultiplier: 2,
    description: '1M context preview. Sends output_config effort levels low…max and accepts image input.',
  },
  {
    id: 'claude-opus-5',
    name: 'Claude Opus 5',
    context: 1_000_000,
    maxOutput: 128_000,
    vision: true,
    rateMultiplier: 1.5,
  },
  {
    id: 'claude-opus-4.8',
    name: 'Claude Opus 4.8',
    context: 200_000,
    maxOutput: 64_000,
    vision: true,
    rateMultiplier: 1.5,
  },
  {
    id: 'claude-opus-4.7',
    name: 'Claude Opus 4.7',
    context: 200_000,
    maxOutput: 64_000,
    vision: true,
    rateMultiplier: 1.5,
  },
  {
    id: 'claude-opus-4.5',
    name: 'Claude Opus 4.5',
    context: 200_000,
    maxOutput: 32_000,
    vision: true,
    rateMultiplier: 1.3,
    // Legacy spelling: Kiro rejected additionalModelRequestFields here, so
    // reasoning travels as the <thinking_mode> prompt tag instead.
    reasoning: 'tag',
    efforts: ['minimal', 'low', 'medium', 'high'],
  },
  {
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    context: 200_000,
    maxOutput: 64_000,
    vision: true,
    rateMultiplier: 1,
  },
  {
    id: 'claude-sonnet-4.6',
    name: 'Claude Sonnet 4.6',
    context: 200_000,
    maxOutput: 32_000,
    vision: true,
    rateMultiplier: 1,
    efforts: ['low', 'medium', 'high', 'max'],
  },
  {
    id: 'claude-sonnet-4.5',
    name: 'Claude Sonnet 4.5',
    context: 200_000,
    maxOutput: 32_000,
    vision: true,
    rateMultiplier: 1,
    reasoning: 'tag',
    efforts: ['minimal', 'low', 'medium', 'high'],
  },
  {
    id: 'claude-haiku-4.5',
    name: 'Claude Haiku 4.5',
    context: 200_000,
    maxOutput: 32_000,
    vision: true,
    rateMultiplier: 0.4,
    reasoning: 'tag',
    efforts: ['minimal', 'low', 'medium', 'high'],
  },
  {
    id: 'gpt-5.6-sol',
    name: 'GPT 5.6 Sol',
    context: 272_000,
    maxOutput: 128_000,
    vision: true,
    rateMultiplier: 2.4,
    efforts: GPT_EFFORTS,
    description: 'Experimental OpenAI preview on the Kiro runtime, 272k window.',
  },
  {
    id: 'gpt-5.6-terra',
    name: 'GPT 5.6 Terra',
    context: 272_000,
    maxOutput: 128_000,
    vision: true,
    rateMultiplier: 1.2,
    efforts: GPT_EFFORTS,
  },
  {
    id: 'gpt-5.6-luna',
    name: 'GPT 5.6 Luna',
    context: 272_000,
    maxOutput: 128_000,
    vision: true,
    rateMultiplier: 0.6,
    efforts: GPT_EFFORTS,
  },
  {
    id: 'deepseek-3.2',
    name: 'DeepSeek 3.2',
    context: 128_000,
    maxOutput: 32_000,
    // Kiro rejects image/audio payloads for this family: text only.
    vision: false,
    tools: true,
    rateMultiplier: 0.3,
    reasoning: 'none',
    efforts: false,
  },
  {
    id: 'qwen3-coder-next',
    name: 'Qwen3 Coder Next',
    context: 256_000,
    maxOutput: 32_000,
    vision: false,
    rateMultiplier: 0.3,
    reasoning: 'none',
    efforts: false,
  },
  {
    id: 'glm-5',
    name: 'GLM 5',
    context: 200_000,
    maxOutput: 32_000,
    vision: false,
    rateMultiplier: 0.3,
    efforts: ['minimal', 'low', 'medium', 'high'],
  },
  {
    id: 'glm-5.2',
    name: 'GLM 5.2',
    context: 200_000,
    maxOutput: 32_000,
    vision: false,
    rateMultiplier: 0.3,
    efforts: ['minimal', 'low', 'medium', 'high'],
  },
  {
    id: 'minimax-m2.5',
    name: 'MiniMax M2.5',
    context: 200_000,
    maxOutput: 32_000,
    vision: false,
    rateMultiplier: 0.3,
    efforts: ['minimal', 'low', 'medium'],
  },
  {
    id: 'minimax-m2.1',
    name: 'MiniMax M2.1',
    context: 200_000,
    maxOutput: 32_000,
    vision: false,
    rateMultiplier: 0.2,
    reasoning: 'none',
    efforts: false,
  },
  {
    id: 'kimi-k3',
    name: 'Kimi K3',
    context: 256_000,
    maxOutput: 32_000,
    vision: false,
    rateMultiplier: 0.4,
    efforts: ['minimal', 'low', 'medium', 'high'],
  },
  {
    id: 'auto',
    name: 'Kiro Auto',
    context: 200_000,
    maxOutput: 32_000,
    vision: false,
    // Server-side model choice: the agentic chunked-write prompt targets coding
    // file writes and would steer a route the caller did not pick, so it is off.
    agentic: false,
    reasoning: 'none',
    efforts: false,
    description: 'Kiro selects the model per turn.',
  },
])

/** Default per-model fields, applied to every seed entry and every live model. */
export const MODEL_DEFAULTS = Object.freeze({
  surfaces: undefined,
  vision: false,
  tools: true,
  parallelToolCalls: true,
  agentic: true,
  reasoning: undefined,
  efforts: undefined,
  defaultEffort: 'medium',
  maxTokensCap: MAX_OUTPUT_CAP,
  origin: 'AI_EDITOR',
  agentMode: 'vibe',
  cache: true,
  thinkingTag: true,
})

/**
 * Complete one model record from a partial entry, deriving the reasoning path
 * and effort list when the entry does not state them.
 * @param {object} entry
 * @param {string} [entry.reasoning] `'output_config' | 'reasoning' | 'tag' | 'none'`
 * @param {string[] | false} [entry.efforts] selectable levels; `false` means the model cannot reason
 */
export function normalizeModel(entry) {
  const upstream = entry.upstream ? foldUpstreamModelId(entry.upstream) : foldUpstreamModelId(entry.id)
  const path = entry.reasoning ?? (upstream === 'auto' ? 'none' : reasoningPath(upstream))
  const efforts = entry.efforts === undefined
    ? path === 'none'
      ? false
      : path === 'reasoning'
        ? [...GPT_EFFORTS]
        : path === 'output_config'
          ? claudeEfforts(upstream)
          : ['minimal', 'low', 'medium', 'high']
    : entry.efforts
  const context = positiveInt(entry.context ?? entry.contextWindow, DEFAULT_CONTEXT_WINDOW)
  const maxOutput = positiveInt(entry.maxOutput ?? entry.maxTokens, DEFAULT_MAX_OUTPUT)
  const cap = positiveInt(entry.maxTokensCap, MAX_OUTPUT_CAP)
  return {
    ...MODEL_DEFAULTS,
    ...entry,
    id: entry.id,
    name: entry.name || entry.id,
    upstream,
    context,
    maxOutput,
    // Never advertise an output window the wire ceiling would reject.
    wireMaxTokens: positiveInt(entry.wireMaxTokens, Math.min(maxOutput, cap)),
    maxTokensCap: cap,
    vision: Boolean(entry.vision),
    tools: entry.tools !== false,
    reasoning: path,
    efforts: efforts === false ? false : Object.freeze([...efforts]),
    agentic: entry.agentic !== false && upstream !== 'auto',
    inputModalities: entry.vision ? ['text', 'image'] : ['text'],
    variants: entry.variants ?? true,
  }
}

/** Build the `-thinking` / `-agentic` variant ids for one model record. */
export function modelVariants(model) {
  if (model.variants === false) return []
  const ids = [model.id]
  const canThink = model.reasoning !== 'none' && model.efforts !== false
  if (canThink) ids.push(`${model.id}${THINKING_SUFFIX}`)
  if (model.agentic) ids.push(`${model.id}${AGENTIC_SUFFIX}`)
  if (canThink && model.agentic) ids.push(`${model.id}${THINKING_SUFFIX}${AGENTIC_SUFFIX}`)
  return ids.filter(id => id !== model.id)
}

/**
 * The catalog the plugin serves: every seed model plus every advertised variant.
 * @returns {Map<string, object>} id → model record (variants carry `variantOf`)
 */
export function buildCatalog(overrides = {}) {
  const catalog = new Map()
  for (const entry of SEED_MODELS) {
    const base = normalizeModel(applyOverride(entry, overrides[entry.id]))
    catalog.set(base.id, base)
    for (const variantId of modelVariants(base)) {
      const variant = applyOverride({ ...base, id: variantId }, overrides[variantId])
      const thinking = variantId.includes(THINKING_SUFFIX)
      const agentic = variantId.endsWith(AGENTIC_SUFFIX)
      catalog.set(variantId, {
        ...normalizeModel(variant),
        id: variantId,
        name: `${base.name}${thinking ? ' (thinking)' : ''}${agentic ? ' (agentic)' : ''}`,
        upstream: base.upstream,
        variantOf: base.id,
        thinking: thinking || base.thinking === true,
        agentic,
        forceThinking: thinking,
      })
    }
  }
  // Hand-declared models (a Kiro family added after this release) keep working.
  for (const [id, override] of Object.entries(overrides)) {
    if (catalog.has(id) || !override || override.enabled === false) continue
    catalog.set(id, normalizeModel({ id, name: override.name || id, upstream: override.upstream || id, ...override }))
  }
  for (const [id, model] of [...catalog]) {
    if (overrides[id]?.enabled === false) catalog.delete(id)
  }
  return catalog
}

function applyOverride(entry, override) {
  if (!override) return entry
  const next = { ...entry }
  for (const key of ['name', 'description', 'context', 'contextWindow', 'maxOutput', 'maxTokens', 'upstream', 'vision', 'tools', 'agentic', 'reasoning', 'defaultEffort', 'wireMaxTokens', 'maxTokensCap', 'surfaces', 'agentMode', 'origin', 'thinkingTag']) {
    if (override[key] !== undefined) next[key] = override[key]
  }
  if (override.efforts !== undefined) next.efforts = override.efforts === false ? false : [...override.efforts]
  if (override.headers) next.headers = { ...(entry.headers || {}), ...override.headers }
  return next
}

/**
 * Merge one live `ListAvailableModels` entry over a seed record.
 *
 * Upstream wins on sizes, naming and credit cost because it is the only source
 * that knows what this account may call. It never wins on behaviour the wire
 * requires (reasoning path, vision, endpoint preference), because Kiro does not
 * disclose those fields; a model missing from the live list is reported as
 * unavailable rather than silently kept.
 */
export function mergeLiveModel(seed, live) {
  const tokenLimits = live.tokenLimits || live.token_limit || {}
  const context = positiveInt(
    tokenLimits.maxInputTokens ?? live.maxInputTokens ?? live.contextWindow ?? live.context_length,
    seed?.context ?? DEFAULT_CONTEXT_WINDOW,
  )
  const maxOutput = positiveInt(
    tokenLimits.maxOutputTokens ?? live.maxOutputTokens ?? live.maxTokens ?? seed?.maxOutput ?? DEFAULT_MAX_OUTPUT,
    DEFAULT_MAX_OUTPUT,
  )
  const modalities = Array.isArray(live.supportedInputModes) ? live.supportedInputModes
    : Array.isArray(live.inputModalities) ? live.inputModalities
      : Array.isArray(live.modalities) ? live.modalities : undefined
  const vision = modalities ? modalities.some(mode => String(mode).toLowerCase() === 'image') : seed?.vision ?? false
  const upstream = live.modelId || live.id || seed?.upstream
  const name = live.modelName || live.name || seed?.name || upstream
  const rate = Number(live.rateMultiplier)
  return normalizeModel({
    ...(seed || {}),
    id: seed?.id ?? upstream,
    upstream,
    name,
    description: live.description || seed?.description,
    context,
    maxOutput,
    vision,
    tools: live.supportsToolCall === false ? false : seed?.tools !== false,
    agentic: live.supportsAgentic === false ? false : seed?.agentic !== false,
    rateMultiplier: Number.isFinite(rate) && rate > 0 ? rate : seed?.rateMultiplier ?? 1,
    live: true,
  })
}

/** Fold the upstream catalog into a local one; unknown models are appended. */
export function mergeLiveCatalog(catalog, liveModels = []) {
  const next = new Map(catalog)
  const seen = new Set()
  for (const live of liveModels) {
    if (!live || typeof live !== 'object') continue
    const upstreamId = live.modelId || live.id
    if (!upstreamId) continue
    seen.add(upstreamId)
    const seed = [...next.values()].find(model => model.upstream === upstreamId && !model.variantOf)
    const merged = mergeLiveModel(seed, { ...live, modelId: upstreamId })
    if (seed) {
      next.set(seed.id, merged)
      // Refresh the derived variants so their inherited sizes stay current.
      for (const variantId of modelVariants(merged)) {
        const existing = next.get(variantId)
        const thinking = variantId.includes(THINKING_SUFFIX)
        const agentic = variantId.endsWith(AGENTIC_SUFFIX)
        next.set(variantId, {
          ...normalizeModel({ ...merged, id: variantId }),
          id: variantId,
          name: `${merged.name}${thinking ? ' (thinking)' : ''}${agentic ? ' (agentic)' : ''}`,
          variantOf: merged.id,
          agentic,
          forceThinking: thinking,
        })
        void existing
      }
      for (const [id, model] of [...next]) {
        if (model.variantOf === seed.id && !modelVariants(merged).includes(id) && id !== seed.id) next.delete(id)
      }
    } else {
      next.set(merged.id, merged)
      for (const variantId of modelVariants(merged)) {
        next.set(variantId, {
          ...normalizeModel({ ...merged, id: variantId }),
          id: variantId,
          name: `${merged.name}${variantId.includes(THINKING_SUFFIX) ? ' (thinking)' : ''}${variantId.endsWith(AGENTIC_SUFFIX) ? ' (agentic)' : ''}`,
          variantOf: merged.id,
          agentic: variantId.endsWith(AGENTIC_SUFFIX),
          forceThinking: variantId.includes(THINKING_SUFFIX),
        })
      }
    }
  }
  return { catalog: next, missing: [...next.values()].filter(model => !model.variantOf && !seen.has(model.upstream)).map(model => model.id) }
}

/** Look one id up in a catalog, tolerating dash/dot spellings and vendor aliases. */
export function findModel(catalog, id) {
  const direct = catalog.get(id)
  if (direct) return direct
  const folded = foldUpstreamModelId(String(id ?? '').replace(AGENTIC_SUFFIX, '').replace(THINKING_SUFFIX, ''))
  for (const model of catalog.values()) {
    if (sameModelId(model.id, id) || sameModelId(model.upstream, folded)) {
      // Preserve variant intent when the caller used a suffixed id.
      const suffix = String(id ?? '').slice(String(model.id).length)
      if (suffix.includes(THINKING_SUFFIX) || suffix.includes(AGENTIC_SUFFIX)) {
        const variantId = `${model.id}${suffix.startsWith(AGENTIC_SUFFIX) ? AGENTIC_SUFFIX : ''}${suffix.includes(THINKING_SUFFIX) ? THINKING_SUFFIX : ''}`
        const variant = catalog.get(variantId)
        if (variant) return variant
      }
      return model
    }
  }
  return undefined
}

/** Clamp a requested output cap into the model's own ceiling. */
export function resolveMaxTokens(model, requested) {
  const cap = positiveInt(model.maxTokensCap, MAX_OUTPUT_CAP)
  const fallback = positiveInt(model.wireMaxTokens, Math.min(model.maxOutput, cap))
  // A caller that asks for zero or a negative output window is not asking for a
  // one-token answer; that spelling means "no preference", so the model default
  // applies. Anything above the ceiling is clamped, never forwarded.
  const wanted = Number.isFinite(requested) && requested > 0 ? requested : fallback
  return clamp(wanted, 1, cap)
}

/** Map one effort id onto the value the model's reasoning path expects. */
export function effortWireValue(model, effort) {
  if (!effort || model.efforts === false) return null
  const allowed = model.efforts || []
  if (!allowed.includes(effort)) return null
  if (model.reasoning === 'output_config') return effort === 'max' ? 'max' : effort
  if (model.reasoning === 'reasoning') return effort === 'max' ? 'xhigh' : effort
  if (model.reasoning === 'tag') return TAG_BUDGETS[effort] ?? THINKING_BUDGET_DEFAULT
  return null
}

/** Reasoning metadata for the harness model picker. */
export function reasoningInfo(model) {
  if (model.efforts === false || model.reasoning === 'none') return undefined
  const efforts = model.efforts || []
  const list = efforts.map(id => ({
    id,
    name: EFFORT_LABELS[id] || id,
    ...(model.reasoning === 'tag'
      ? { description: `${TAG_BUDGETS[id] ?? THINKING_BUDGET_DEFAULT} thinking tokens (prompt tag)` }
      : { description: `Kiro ${model.reasoning}.effort = ${effortWireValue(model, id) ?? id}` }),
  }))
  if (list.length === 0) return undefined
  return {
    efforts: list,
    defaultEffort: list.some(entry => entry.id === model.defaultEffort) ? model.defaultEffort : list[0].id,
  }
}

/**
 * What one model can do, in the shape both bridge formats echo.
 *
 * This is the answer to "does this model see images / take tools / think". It is
 * derived from the same entry the request builder reads, so a client that trusts
 * `/v1/models` gets exactly what a turn will enforce — and a client that does not
 * read it gets a clear rejection instead of a silently degraded request.
 *
 * @param {object} model a normalized catalog entry
 * @returns {object}
 */
export function describeCapabilities(model) {
  const efforts = model.efforts === false || model.efforts === undefined ? [] : [...model.efforts]
  return {
    context: model.context,
    max_output: model.maxOutput,
    upstream_id: model.upstream,
    vision: model.vision === true,
    input_modalities: [...(model.inputModalities || ['text'])],
    tools: model.tools !== false,
    parallel_tool_calls: model.parallelToolCalls !== false,
    // Kiro's two thinking mechanisms are not interchangeable: `tag` writes a
    // literal block into the prompt, `reasoning`/`output_config` are wire fields.
    reasoning: model.reasoning,
    reasoning_efforts: efforts,
    default_effort: efforts.includes(model.defaultEffort) ? model.defaultEffort : efforts[0] || null,
    thinking_tag: model.thinkingTag !== false,
    agentic: model.agentic === true,
    rate_multiplier: model.rateMultiplier ?? null,
    cache: model.cache !== false,
    temperature: true,
    top_p: true,
    supported_output_types: ['text/plain'],
    description: model.description || '',
  }
}

/** Display order for the selector: strongest capable model first, variants after their base. */
export function catalogOrder(catalog) {
  const rank = id => {
    const order = ['opus', 'sonnet', 'gpt', 'haiku', 'glm', 'kimi', 'minimax', 'deepseek', 'qwen', 'auto']
    const index = order.findIndex(family => String(id).includes(family))
    return index === -1 ? order.length : index
  }
  return [...catalog.values()].sort((left, right) => {
    const byFamily = rank(left.upstream) - rank(right.upstream)
    if (byFamily !== 0) return byFamily
    const byVariant = Number(Boolean(left.variantOf)) - Number(Boolean(right.variantOf))
    if (byVariant !== 0) return byVariant
    return String(left.id).localeCompare(String(right.id))
  })
}
