/**
 * The DSH-facing adapter: harness contract in, Kiro turn out.
 *
 * This is the only module that speaks both vocabularies. It deliberately contains
 * no harness *imports*: `LlmError`, the `LlmAdapter` base class and
 * `attributionHeaders` are passed in by `index.js`, so the translation is
 * unit-testable with stubs like everything else here. Four jobs:
 *
 *  1. resolve a `providers.<route>` profile plus the live Kiro catalog into the
 *     model metadata the Models page and the agent loop need (context window,
 *     output cap, reasoning efforts, input modalities);
 *  2. hand a harness request to the turn runner and re-emit its chunks;
 *  3. convert failures into `LlmError`s, because a bare `Error` loses the one
 *     thing the loop routes on — retry, re-auth, or shrink the context;
 *  4. refresh the catalog from Kiro and fold it back into (1).
 *
 * @module lib/adapter.js
 */

import { credentialsFor, createTurnRunner } from './turn.js'
import { buildCatalog, catalogOrder, findModel, mergeLiveCatalog, reasoningInfo } from './catalog.js'
import { ERROR_CODES, asKiroError } from './errors.js'
import { fetchKiroCatalog, fetchProfileArn } from './kiro/catalog-api.js'


/** The route this plugin owns by default; extra routes are per-account variants. */
export const DEFAULT_ROUTE = 'kiro'

/**
 * Map a plugin failure onto the harness failure codes the loop routes on.
 *
 * `AUTH`/`MISSING_CREDENTIAL` gate a re-auth prompt, `RATE_LIMIT` and
 * `CONTEXT_WINDOW_EXCEEDED` drive retry and compaction, and everything upstream
 * stays `UPSTREAM_*` so the loop can fail the attempt without blaming the user.
 */
export function toHarnessFailureCode(code) {
  return {
    [ERROR_CODES.auth]: 'AUTH',
    [ERROR_CODES.notConfigured]: 'MISSING_CREDENTIAL',
    [ERROR_CODES.refreshExpired]: 'AUTH',
    [ERROR_CODES.rateLimit]: 'RATE_LIMIT',
    [ERROR_CODES.quota]: 'RATE_LIMIT',
    [ERROR_CODES.context]: 'CONTEXT_WINDOW_EXCEEDED',
    [ERROR_CODES.image]: 'IMAGE_OFFLOAD_REQUIRED',
    [ERROR_CODES.invalidModel]: 'INVALID_MODEL',
    [ERROR_CODES.timeout]: 'UPSTREAM_TIMEOUT',
    [ERROR_CODES.endpoint]: 'UPSTREAM_UNAVAILABLE',
    [ERROR_CODES.rejected]: 'REJECTED_BY_UPSTREAM',
    [ERROR_CODES.stream]: 'UPSTREAM_STREAM_ERROR',
  }[code] || 'UPSTREAM_ERROR'
}

/**
 * @typedef {object} KiroProfile
 * @property {string} [displayName] label in the Models page
 * @property {string} [region] AWS region of the Kiro profile
 * @property {string} [profileArn] pinned CodeWhisperer profile ARN
 * @property {string[]} [surfaces] endpoint surfaces to try, in order
 * @property {object[]} [models] explicit model list, replacing the seed table
 * @property {object} [modelOverrides] per-model corrections (context, maxOutput…)
 * @property {string} [apiKeyEnv] credential ref holding a Kiro API key
 * @property {number} [connectTimeoutMs]
 * @property {number} [firstChunkTimeoutMs]
 * @property {number} [streamIdleTimeoutMs]
 * @property {object} [retryPolicy] harness retry policy for this route
 */

/**
 * Build everything the plugin registers: one adapter, one turn runner, one
 * catalog that both the desktop UI and the HTTP bridge read.
 *
 * @param {{
 *   LlmAdapter?: Function,
 *   LlmError?: Function,
 *   store: object,
 *   settings: () => object,
 *   profiles: () => Map<string, KiroProfile>,
 *   usage?: object,
 *   fetch?: typeof globalThis.fetch,
 *   log?: object,
 *   resolveImage?: (block: object) => Promise<object>,
 * }} deps
 * @returns {{
 *   adapter: object,
 *   runner: object,
 *   modelsFor(route: string): object[],
 *   describeModel(route: string, model: string): object,
 *   refreshCatalog(route?: string): Promise<object[]>,
 *   catalog(): Map<string, object>,
 * }}
 */
export function createKiroAdapter(deps) {
  let catalog = new Map()
  let catalogRoute = null
  /** Ids the live listing did not offer for the current credential. */
  let unavailable = new Set()

  /** The catalog for one route: seed table + that route's overrides. */
  const buildFor = route => {
    const profile = profileFor(route)
    return buildCatalog(profile.modelOverrides || {})
  }

  const catalogFor = route => {
    if (catalogRoute !== route || catalog.size === 0) {
      catalog = buildFor(route)
      catalogRoute = route
    }
    return catalog
  }

  const settingsFor = route => {
    const profile = profileFor(route)
    const global = deps.settings?.() || {}
    return {
      ...global,
      ...(profile.region ? { region: profile.region } : {}),
      ...(profile.profileArn ? { profileArn: profile.profileArn } : {}),
      ...(Array.isArray(profile.surfaces) && profile.surfaces.length > 0 ? { surfaces: profile.surfaces } : {}),
      ...(Number.isFinite(profile.connectTimeoutMs) ? { connectTimeoutMs: profile.connectTimeoutMs } : {}),
      ...(Number.isFinite(profile.firstChunkTimeoutMs) ? { firstChunkTimeoutMs: profile.firstChunkTimeoutMs } : {}),
      ...(Number.isFinite(profile.streamIdleTimeoutMs) ? { streamIdleTimeoutMs: profile.streamIdleTimeoutMs } : {}),
      ...(typeof profile.baseUrl === 'string' && profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
    }
  }

  const profileFor = route => {
    const profiles = deps.profiles?.()
    return profiles?.get?.(route) || profiles?.get?.(DEFAULT_ROUTE) || {}
  }

  const runner = createTurnRunner({
    settings: () => settingsFor(DEFAULT_ROUTE),
    store: deps.store,
    // The runner reads the catalog for the *requested* route through `routeOf`,
    // so one registration can serve several accounts with different endpoints.
    catalog: route => catalogFor(route || DEFAULT_ROUTE),
    ...(deps.routeOf ? { routeOf: deps.routeOf } : {}),
    usage: deps.usage,
    log: deps.log,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.resolveImage ? { resolveImage: deps.resolveImage } : {}),
  })

  /** Models this route can currently serve, in picker order. */
  const modelsFor = route => {
    const profile = profileFor(route)
    if (Array.isArray(profile.models) && profile.models.length > 0) {
      // An explicit `models` list is the caller's answer to Kiro's, so it wins
      // wholesale rather than being merged into the seed table.
      return catalogOrder(buildCatalog(Object.fromEntries(profile.models.map(entry => [entry.id, entry]))))
    }
    return catalogOrder(catalogFor(route))
  }

  /** The GUI-facing list: everything advertised *and* allowed for this account. */
  const selectableModels = route => modelsFor(route).filter(model => !unavailable.has(model.id))

  /** One exact model's harness metadata. */
  const describeModel = (route, modelId) => {
    const profile = profileFor(route)
    const model = findModel(catalogFor(route), modelId)
      || normalizeOverride(profile.models?.find?.(entry => entry.id === modelId) || profile.modelOverrides?.[modelId], modelId)
    return modelInfo(route, modelId, model, profile)
  }

  /** Pull the caller's model list from Kiro and fold it into the catalog. */
  const refreshCatalog = async (route = DEFAULT_ROUTE) => {
    const settings = settingsFor(route)
    const [account] = await deps.store.candidates()
    if (!account) {
      // No credential means no answer — but the seed table is still the honest
      // offline view, so the caller keeps a usable catalog instead of an error.
      deps.log?.debug?.('kiro: catalog refresh skipped (no signed-in account)')
      return catalogOrder(catalogFor(route))
    }
    const credentials = credentialsFor(account, null, settings)
    let profileArn = credentials.profileArn
    if (!profileArn) {
      // A missing ARN only narrows the list — `ListAvailableModels` answers with
      // the credential's default profile — so a failure here is a debug line.
      profileArn = await fetchProfileArn({
        credentials,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(settings.catalogTimeoutMs ? { timeoutMs: settings.catalogTimeoutMs } : {}),
        ...(deps.log ? { log: deps.log } : {}),
      })
    }
    try {
      const live = await fetchKiroCatalog({
        credentials: { ...credentials, ...(profileArn ? { profileArn } : {}) },
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(settings.catalogTimeoutMs ? { timeoutMs: settings.catalogTimeoutMs } : {}),
        ...(deps.log ? { log: deps.log } : {}),
      })
      const profile = profileFor(route)
      const { catalog: merged, missing } = mergeLiveCatalog(buildCatalog({}), live)
      catalog = mergeConfigured(merged, profile)
      // Kiro's listing is the account's own permission set: a model the caller
      // cannot buy is dropped from what the GUI may select, so the picker cannot
      // offer a turn that would fail with 403. Naming one anyway still runs,
      // because a stale listing is not proof that a model is unavailable.
      unavailable = new Set(missing || [])
      catalogRoute = route
      deps.log?.info?.(`kiro: catalog refreshed; models=%s hidden=%s route="%s"`, catalog.size, unavailable.size, route)
      return catalogOrder(catalog)
    } catch (error) {
      // A failed refresh keeps the previous catalog instead of emptying it, so
      // an offline laptop can still run a conversation from the seed table.
      deps.log?.warn?.(`kiro: catalog refresh failed (${error?.message || error}); keeping %s models`, catalog.size || 'the seed')
      return catalogOrder(catalogFor(route))
    }
  }

  const adapter = buildAdapter({ adapterBase: deps.LlmAdapter, LlmError: deps.LlmError, log: deps.log, modelsFor, selectableModels, describeModel, runner, settingsFor })

  return { adapter, runner, modelsFor, selectableModels, describeModel, refreshCatalog, catalog: catalogFor, unavailable: () => [...unavailable], toHarnessFailureCode }
}

/** Apply configured overrides on top of a freshly fetched catalog. */
function mergeConfigured(catalog, profile) {
  const overrides = profile?.modelOverrides
  if (!overrides || typeof overrides !== 'object') return catalog
  return buildCatalogFrom(catalog, overrides)
}

/** Rebuild a catalog map with per-model overrides applied. */
function buildCatalogFrom(base, overrides) {
  const rebuilt = buildCatalog(overrides)
  for (const [id, model] of base) {
    if (!rebuilt.has(id)) rebuilt.set(id, model)
  }
  return rebuilt
}

/** A `modelOverrides`-only entry still needs the same normalization as a seed. */
function normalizeOverride(entry, modelId) {
  if (!entry) return null
  return buildCatalog({ [modelId]: entry }).get(modelId) || null
}

/**
 * The harness view of one model.
 *
 * `systemPromptUpdate` is intentionally absent: Kiro reads the system prompt as
 * the first turn of the conversation, so a later `system` message is content, not
 * a live prompt replacement. Claiming `'in-history'` would let an agent rewrite
 * its instructions and then wonder why nothing changed.
 */
export function modelInfo(route, modelId, model, profile) {
  const efforts = model ? reasoningInfo(model) : undefined
  return {
    provider: route,
    id: modelId,
    name: model?.name || modelId,
    inputModalities: [...(model?.inputModalities || profile?.defaultInput || (model?.vision ? ['text', 'image'] : ['text']))],
    ...(Number.isFinite(model?.context) || Number.isFinite(profile?.defaultContextWindow)
      ? { context: { contextWindow: Number(model?.context) || Number(profile.defaultContextWindow) } }
      : {}),
    ...(Number.isFinite(model?.maxOutput) || Number.isFinite(profile?.defaultMaxTokens)
      ? { defaultMaxTokens: Number(model?.maxOutput) || Number(profile.defaultMaxTokens) }
      : {}),
    ...(efforts ? { reasoning: efforts } : {}),
  }
}

/** Assemble the adapter object, extending the harness base class when present. */
function buildAdapter(harness) {
  const base = harness.adapterBase ? new harness.adapterBase() : {}
  const fail = (route, modelId, error) => {
    const kiro = asKiroError(error)
    const message = `kiro: model "${modelId}" on route "${route}" failed: ${kiro.message}`
    if (harness.LlmError) return new harness.LlmError(message, toHarnessFailureCode(kiro.code))
    return Object.assign(new Error(message), { code: toHarnessFailureCode(kiro.code), cause: kiro })
  }
  const surface = {
    ...base,
    providerInfo(provider) {
      const profile = harness.settingsFor?.(provider) || {}
      return { id: provider, name: profile.displayName || 'Kiro' }
    },
    listModels(provider) {
      return Promise.resolve(harness.selectableModels(provider).map(model => ({
        provider,
        id: model.id,
        name: model.name,
        inputModalities: [...(model.inputModalities || (model.vision ? ['text', 'image'] : ['text']))],
      })))
    },
    resolveModel(provider, model) {
      return Promise.resolve(harness.describeModel(provider, model))
    },
    /** Bind metadata and dispatch to one catalog generation, per the adapter contract. */
    async prepareCall(provider, model, signal) {
      const resolved = harness.describeModel(provider, model)
      return {
        model: resolved,
        stream: options => surface.stream({ ...options, signal: signal || options.signal }),
      }
    },

  }
  /**
   * The one entry point the loop calls.
   *
   * A failure before the first chunk becomes an `LlmError` so the loop can route
   * on its code; anything after it is already in-band as a `finish` chunk (the
   * runner guarantees that), because the assistant message is durable by then and
   * rewriting it as a thrown error would lose the partial turn.
   */
  surface.stream = function stream(options) {
    const generator = harness.runner.streamTurn(options)
    return (async function* () {
      try {
        for await (const chunk of generator) yield chunk
      } catch (error) {
        throw fail(options.provider || DEFAULT_ROUTE, options.model, error)
      }
    })()
  }
  return surface
}

