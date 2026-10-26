/**
 * Kiro for DSH Desktop — plugin entry.
 *
 * Everything provider-specific lives behind `lib/`; this file is only the seam
 * where the plugin meets the harness. Four registrations, in the order the harness
 * expects them:
 *
 *   1. a credential store (`ctx.credentials`) holding the pool of Kiro accounts,
 *      plus one authorization flow per sign-in method, so a human can obtain a
 *      token from a settings page instead of a terminal;
 *   2. one `LlmAdapter` for the `kiro` route (and any extra route a profile adds),
 *      with per-model capability metadata resolved from the live Kiro catalog;
 *   3. model discovery, so the Models page can list what *this* account may call
 *      rather than what a static table guesses;
 *   4. the local HTTP bridge, which is what lets an agent that is not DSH —
 *      anything speaking OpenAI Chat Completions or Anthropic Messages — reach the
 *      same signed-in Kiro models through the same rules.
 *
 * No `ctx.llm` call here streams a model by itself: the adapter delegates to
 * `lib/turn.js`, the same code path the bridge uses, so a fix to the wire
 * protocol cannot land for one surface and miss the other.
 *
 * @module index
 */

import z from '@deepseek-ai/schemastery'
import { credentialKey, credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import { LlmAdapter, LlmError, attributionHeaders } from '@deepseek-ai/dsh-llm'

import { createAccountStore } from './lib/auth/store.js'
import { authMethodEntries, createSignInCoordinator, runSignIn } from './lib/auth/signin.js'
import { DEFAULT_ROUTE, createKiroAdapter } from './lib/adapter.js'
import { createUsageProvider } from './lib/usage.js'
import { createBridgeRouter, modelList } from './lib/bridge/router.js'
import { createBridgeServer, isLoopbackHost } from './lib/bridge/http-server.js'
import { buildCatalog, catalogOrder } from './lib/catalog.js'
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_OUTPUT, DEFAULT_REGION } from './lib/constants.js'
import { ERROR_CODES, KiroError } from './lib/errors.js'
import { credentialsFor } from './lib/turn.js'

/** Plugin name; also the credential scope and the default settings namespace. */
export const name = 'dsh-desktop-kiro'

/** Services this plugin cannot work without. Optional ones are `ctx.inject`ed. */
export const inject = ['llm', 'credentials', 'connection', 'settings', 'authorization']

/** The endpoint surfaces Kiro serves, in the order a request may walk them. */
const SURFACES = ['q', 'codewhisperer']

/** Per-model fields a profile may correct, mirroring the internal catalog entry. */
const modelFields = {
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  vision: z.boolean(),
  tools: z.boolean(),
  agentic: z.boolean(),
  reasoning: z.union(['none', 'tag', 'reasoning', 'output_config']),
  defaultEffort: z.union(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  rateMultiplier: z.number(),
}

/** One model an operator declares by hand, when Kiro has added one since this table. */
const declaredModel = z.object({ id: z.string().required(), ...modelFields })

/**
 * One Kiro route.
 *
 * A route is a (profile ARN family, endpoint, region) triple a caller wants to
 * address as its own provider — normally exactly one, named `kiro`. Adding
 * `kiro-work` costs a settings entry, not a second plugin.
 */
const providerProfile = z.object({
  displayName: z.string(),
  region: z.string(),
  profileArn: z.string(),
  baseUrl: z.string(),
  surfaces: z.array(z.union(SURFACES)),
  apiKeyEnv: z.string().role('credential-ref'),
  headers: z.dict(z.string()),
  models: z.array(declaredModel),
  modelOverrides: z.dict(modelFields),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  defaultMaxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_OUTPUT),
  connectTimeoutMs: z.natural(),
  firstChunkTimeoutMs: z.natural(),
  streamIdleTimeoutMs: z.natural(),
  rateLimitRetries: z.number().int().min(0).max(4),
  accountFailover: z.number().int().min(1).max(8),
  repairToolCalls: z.boolean(),
})

const bridgeConfig = z.object({
  enable: z.boolean().default(false),
  host: z.string().default('127.0.0.1'),
  port: z.natural().default(0),
  tokenRef: z.string().role('credential-ref'),
})

const authConfig = z.object({
  autoImport: z.boolean().default(true),
  refreshLeadingMs: z.number().step(1).min(0),
  preferredAccountId: z.string(),
})

/** The plugin's configuration document. */
export const Config = z.object({
  providers: z.dict(providerProfile).default({}).volatile(),
  bridge: bridgeConfig.default({}).volatile(),
  auth: authConfig.default({}).volatile(),
})

/** Credential record that owns the account pool. One record, one pool. */
const ACCOUNT_RECORD = 'account'

/**
 * Activate the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx the harness plugin context
 * @param {object} config the resolved {@link Config}, with `.get()` accessors
 */
export async function apply(ctx, config) {
  const settingsNs = ctx.fiber?.entry?.options?.id ?? name
  const log = ctx.logger
  const profiles = () => new Map(Object.entries(config?.providers?.get?.() || {}))
  const bridge = () => config?.bridge?.get?.() || {}
  const auth = () => config?.auth?.get?.() || {}

  // The Models page owns provider editing, so the generic plugin page is
  // suppressed and this plugin contributes its own account/bridge panel instead.
  ctx.inject(['settings'], child => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })

  let tokenCache = { value: '' }
  const refreshBridgeToken = async () => {
    const ref = bridge().tokenRef
    if (!ref) {
      tokenCache = { value: '' }
      return ''
    }
    const hit = await credentials?.resolve?.(isCredentialRefName(ref) ? credentialRef(ref) : ref)
    tokenCache = { value: hit?.value || '' }
    return tokenCache.value
  }

  /** `attributionHeaders()` may be absent on an older harness; never fail on it. */
  function safeAttribution() {
    try {
      return typeof attributionHeaders === 'function' ? attributionHeaders() || {} : {}
    } catch {
      return {}
    }
  }

  /** Settings as `lib/turn.js` and the transport expect them. */
  const settingsFor = route => {
    const profile = profiles().get(route) || profiles().get(DEFAULT_ROUTE) || {}
    return {
      region: profile.region || DEFAULT_REGION,
      profileArn: profile.profileArn || undefined,
      surfaces: Array.isArray(profile.surfaces) && profile.surfaces.length > 0 ? profile.surfaces : undefined,
      baseUrl: profile.baseUrl || undefined,
      // The harness mandates its attribution headers on every provider request;
      // Kiro's own fingerprint User-Agent is built in the transport and is not
      // overridden here, because the data plane rejects a mismatched pair.
      extraHeaders: { ...safeAttribution(), ...(profile.headers || {}) },
      connectTimeoutMs: profile.connectTimeoutMs,
      firstChunkTimeoutMs: profile.firstChunkTimeoutMs,
      streamIdleTimeoutMs: profile.streamIdleTimeoutMs,
      rateLimitRetries: profile.rateLimitRetries,
      accountFailover: profile.accountFailover,
      repairToolCalls: profile.repairToolCalls !== false,
      refreshLeadingMs: auth().refreshLeadingMs,
      preferredAccountId: auth().preferredAccountId,
      bridgeToken: tokenCache.value,
    }
  }

  const credentials = ctx.get('credentials')
  const recordKey = credentialKey(settingsNs, ACCOUNT_RECORD)
  const store = createAccountStore({
    log,
    now: () => Date.now(),
    read: async () => {
      const record = await credentials?.readRecord?.(recordKey)
      return record?.payload ?? null
    },
    // `modifyRecord` is the only write path that serializes across processes, and
    // a Kiro refresh token is single-use: two Harness windows refreshing the same
    // account would otherwise burn each other's token.
    mutate: async produce => {
      await credentials?.modifyRecord?.(recordKey, async () => ({ kind: 'grant', payload: await produce() }))
    },
  })

  const usage = createUsageProvider({
    log,
    credentialsFor: async () => {
      const [account] = await store.candidates()
      if (!account) return null
      return credentialsFor(account, null, settingsFor(DEFAULT_ROUTE))
    },
  })

  /**
   * Turn a profile's `apiKeyEnv` into a pool entry.
   *
   * A deployment that ships a Kiro API key through configuration should not also
   * have to sign in: resolving the ref here means the key arrives through the
   * credential seam and then behaves exactly like a signed-in account, including
   * the failover and per-model routing every other account gets.
   */
  async function adoptSettingsKey() {
    for (const [route, profile] of profiles()) {
      const ref = profile?.apiKeyEnv
      if (!ref) continue
      let value = null
      try {
        const hit = await credentials?.resolve?.(isCredentialRefName(ref) ? credentialRef(ref) : ref)
        value = hit?.value || null
      } catch (error) {
        log?.warn?.('kiro: route "%s" names apiKeyEnv "%s" but it did not resolve; %s', route, ref, error?.message || error)
        continue
      }
      if (!value) continue
      const existing = (await store.candidates()).find(account => account.apiKey === value)
      if (existing) continue
      await store.upsert({
        authMethod: 'api_key',
        label: `Kiro · API key (${route})`,
        apiKey: value,
        accessToken: value,
        region: profile.region || DEFAULT_REGION,
        ...(profile.profileArn ? { profileArn: profile.profileArn, defaultProfileArn: profile.profileArn } : {}),
        // Keys do not rotate; a far horizon keeps the proactive refresh path idle.
        expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
      })
      log?.info?.('kiro: adopted the API key for route "%s" from its credential ref', route)
    }
  }

  const resolveImage = block => resolveKiroImage(ctx, block)

  const { adapter, refreshCatalog, modelsFor } = createKiroAdapter({
    LlmAdapter,
    LlmError,
    store,
    usage,
    log,
    settings: () => settingsFor(DEFAULT_ROUTE),
    profiles,
    resolveImage,
    harness: { codeFor: code => code },
  })

  // --- credentials: one flow per sign-in method --------------------------------
  // The flow key *is* the record it commits: the seam refuses a flow that wrote
  // anywhere else, so a separate record for sign-in would fail every attempt.
  const flowKey = recordKey
  const methods = authMethodEntries().map(entry => ({ id: entry.id, label: entry.label }))
  ctx.inject(['authorization'], authorized => {
    authorized.effect(() => {
      const dispose = authorized.authorization.registerFlow({
        key: flowKey,
        label: 'Kiro (AWS Builder ID / IdC / Google / GitHub / IdP / API key)',
        methods,
        async run(session) {
          // The flow owns the write: it commits through the store, which commits
          // through `ctx.credentials`, which is the commit the seam observes.
          await runSignIn(session.method || 'builder-id', {
            session,
            store,
            settings: settingsFor(DEFAULT_ROUTE),
            log,
          })
        },
      })
      return dispose
    })
  })

  const coordinator = createSignInCoordinator({ store, settings: () => settingsFor(DEFAULT_ROUTE), log })

  // --- provider registration ---------------------------------------------------
  const directoryEntry = route => {
    const profile = profiles().get(route) || {}
    return {
      provider: route,
      displayName: profile.displayName || 'Kiro',
      settingsNs,
      settingsPath: ['providers', route],
      // Declared rather than installed: Kiro speaks its own event stream, which no
      // bundled catalog describes, so this plugin *is* the catalog for this route.
      declared: true,
      ...(profile.baseUrl ? { defaultBaseURL: profile.baseUrl } : {}),
    }
  }
  const routes = () => {
    const configured = [...profiles().keys()]
    return configured.length > 0 ? configured : [DEFAULT_ROUTE]
  }
  let directory = ctx.llm.registerConfigurableProviders(routes().map(directoryEntry))
  let registration = ctx.llm.registerAdapter(routes(), adapter)
  ctx.on('loader/volatile-update', () => {
    const next = routes()
    directory.replace(next.map(directoryEntry))
    registration.replace(next)
  })

  ctx.llm.registerModelDiscovery(settingsNs, async request => {
    // Discovery is what the "fetch models" button on the Models page calls; it
    // refreshes through the same path as bootstrap so the answer is the account's
    // own list, not this plugin's table.
    const route = request.provider || DEFAULT_ROUTE
    if (request.baseURL && request.provider === undefined) {
      // Discovery against an arbitrary base URL would mean speaking Kiro's
      // protocol to something that is not Kiro; hand-entry stays the honest answer.
      throw new LlmError('kiro: model discovery reads the signed-in Kiro account; it cannot interrogate an arbitrary baseURL', 'DISCOVERY_UNSUPPORTED')
    }
    await refreshCatalog(route)
    return modelsFor(route).map(model => ({
      id: model.id,
      name: model.name,
      contextWindow: model.context,
      maxTokens: model.maxOutput,
      inputModalities: [...(model.inputModalities || (model.vision ? ['text', 'image'] : ['text']))],
    }))
  })
  // --- HTTP surfaces -----------------------------------------------------------
  // The seed table answers `/v1/models` before the first refresh finishes, so a
  // bridge client is never told "no models" while the plugin is still booting.
  let routeCatalog = buildCatalog({})
  const publishCatalog = models => {
    routeCatalog = new Map(models.map(model => [model.id, model]))
  }

  const router = createBridgeRouter({
    runTurn: (request, options) => adapter.stream({ provider: DEFAULT_ROUTE, ...request, ...(options || {}) }),
    catalog: () => routeCatalog,
    settings: () => settingsFor(DEFAULT_ROUTE),
    store,
    usage: () => usage.describe(),
    log,
  })

  const json = (body, init) => new Response(JSON.stringify(body, null, 2), {
    ...(init || {}),
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(init?.headers || {}) },
  })
  const panel = (path, methods, handler) => ctx.connection.fetch.register({
    path,
    methods,
    requestBody: 'buffered',
    fetch: async request => {
      try {
        return json(await handler(request))
      } catch (error) {
        const kiro = error instanceof KiroError ? error : new KiroError(error?.message || String(error), ERROR_CODES.upstream)
        const status = kiro.status || (kiro.code === ERROR_CODES.auth || kiro.code === ERROR_CODES.notConfigured ? 401 : 500)
        return json({ code: kiro.code, error: kiro.message }, { status })
      }
    },
  })

  panel('/api/kiro.status', ['GET'], async () => ({
    accounts: await store.describe(),
    usage: await usage.describe().catch(() => null),
    models: catalogOrder(routeCatalog).length,
    bridge: { ...(await bridgeState()) },
  }))
  panel('/api/kiro.models', ['GET'], async () => ({ models: modelList(routeCatalog, 'openai').data }))
  panel('/api/kiro.refresh', ['POST'], async () => {
    const models = await refreshCatalog(DEFAULT_ROUTE)
    publishCatalog(models)
    return { models: models.length }
  })
  panel('/api/kiro.signin', ['POST'], async request => {
    const body = await readBody(request)
    return coordinator.round({ ...body, input: body?.input || body })
  })
  panel('/api/kiro.signin.cancel', ['POST'], async request => {
    const body = await readBody(request)
    coordinator.cancel(String(body?.stateId || ''))
    return { cancelled: true }
  })
  panel('/api/kiro.account', ['POST'], async request => {
    const body = await readBody(request)
    if (body?.action === 'active') return await store.setActive(String(body.id || ''))
    if (body?.action === 'enable') return await store.setEnabled(String(body.id || ''), body.enabled !== false)
    if (body?.action === 'remove') return await store.remove(String(body.id || ''))
    if (body?.action === 'clear') return await store.clear()
    throw new KiroError(`unknown account action "${body?.action}"`, ERROR_CODES.rejected)
  })
  panel('/api/kiro.chat', ['POST'], request => router.handle(request, new URL('/v1/chat/completions', 'http://127.0.0.1')))
  panel('/api/kiro.messages', ['POST'], request => router.handle(request, new URL('/v1/messages', 'http://127.0.0.1')))

  // --- optional standalone HTTP server (for agents that need a base URL) -------
  let server = null
  let serverState = null
  async function bridgeState() {
    if (!bridge().enable) return { enabled: false, url: null, host: null, port: 0, protected: Boolean(tokenCache.value) }
    const address = server?.address?.() || serverState
    return {
      enabled: true,
      url: address?.url || null,
      host: address?.host || bridge().host || '127.0.0.1',
      port: address?.port || 0,
      protected: Boolean(tokenCache.value),
    }
  }
  async function ensureServer() {
    const wanted = bridge()
    if (!wanted.enable) {
      if (server) await stopServer()
      return null
    }
    const port = Number.isInteger(wanted.port) ? wanted.port : 0
    if (server && serverState?.port === port && serverState?.host === (wanted.host || '127.0.0.1')) return serverState
    if (server) await stopServer()
    server = createBridgeServer({
      handle: request => router.handle(request),
      host: wanted.host || '127.0.0.1',
      port,
      log,
      settings: () => settingsFor(DEFAULT_ROUTE),
    })
    serverState = await server.start()
    log?.info?.('kiro: bridge ready; url=%s loopback=%s', serverState.url, isLoopbackHost(serverState.host))
    return serverState
  }
  async function stopServer() {
    try {
      await server?.stop()
    } catch (error) {
      log?.warn?.('kiro: bridge shutdown failed; %s', error?.message || error)
    }
    server = null
    serverState = null
  }

  ctx.effect(() => {
    // A plugin that opens a socket has to close it, or the next activation inside
    // the same process finds the port taken.
    ensureServer().catch(error => {
      log?.error?.('kiro: bridge failed to start; %s', error?.message || error)
    })
    return () => {
      void stopServer()
    }
  })
  ctx.on('loader/volatile-update', () => {
    void refreshBridgeToken()
    ensureServer().catch(error => log?.error?.('kiro: bridge restart failed; %s', error?.message || error))
  })

  // --- catalog + local-credential bootstrap ------------------------------------
  ctx.effect(() => {
    void (async () => {
      try {
        await refreshBridgeToken()
        await adoptSettingsKey()
        const described = await store.describe()
        if (!described.configured && auth().autoImport !== false) {
          // Adopting the Kiro IDE's own session is the difference between "install
          // and use" and "install and configure": the token is already on this
          // machine, and it rotates the same way the IDE rotates it.
          const result = await runSignIn('auto-import', {
            session: { notify: () => {}, prompt: async () => '' },
            store,
            settings: settingsFor(DEFAULT_ROUTE),
            log,
          })
          log?.info?.('kiro: imported the local Kiro session; status=%s', result.status)
        }
        publishCatalog(await refreshCatalog(DEFAULT_ROUTE))
        log?.info?.('kiro: catalog ready; models=%s routes=%s', routeCatalog.size, routes().join(','))
      } catch (error) {
        // Bootstrap failures must not break activation: the settings panel is how a
        // user fixes them, and a plugin that throws here never renders.
        log?.warn?.('kiro: bootstrap incomplete; %s', error?.message || error)
      }
    })()
  })
}

/**
 * Read one image block into Kiro's inline form.
 *
 * Two sources reach this point: a harness attachment reference (the desktop app)
 * and inline base64 from the bridge. Both have to arrive as `format` + `bytes`,
 * because that is all the data plane accepts — a URL is fetched by nobody, and a
 * path is meaningless to a model.
 */
async function resolveKiroImage(ctx, block) {
  if (block?.data) {
    return { format: formatOf(block.mediaType), source: { bytes: block.data } }
  }
  const ref = block?.attachment ?? block?.ref ?? block?.id
  if (!ref) return undefined
  const attachments = ctx.get('attachments')
  if (!attachments?.readImage) {
    ctx.logger?.warn?.('kiro: the attachments service is unavailable; dropping one image from the turn')
    return undefined
  }
  const image = await attachments.readImage(ref, undefined)
  if (!image?.data) return undefined
  return {
    format: formatOf(block.mediaType || image.mediaType),
    source: { bytes: Buffer.from(image.data).toString('base64') },
  }
}

function formatOf(mediaType) {
  const value = String(mediaType || 'image/png').toLowerCase()
  if (value.includes('jpeg') || value.includes('jpg')) return 'jpeg'
  if (value.includes('gif')) return 'gif'
  if (value.includes('webp')) return 'webp'
  return 'png'
}

/** Read a panel request body, which arrives buffered or as a `Request` depending on transport. */
async function readBody(request) {
  if (!request) return {}
  if (typeof request.json === 'function') {
    try {
      return await request.json()
    } catch {
      return {}
    }
  }
  if (typeof request.body === 'string') {
    try {
      return JSON.parse(request.body)
    } catch {
      return {}
    }
  }
  if (request.body instanceof Uint8Array) {
    try {
      return JSON.parse(new TextDecoder().decode(request.body))
    } catch {
      return {}
    }
  }
  return request.body && typeof request.body === 'object' ? request.body : {}
}
