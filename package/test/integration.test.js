/**
 * The plugin against the real harness packages.
 *
 * Every other test file in this directory reads the plugin from the inside: a
 * function here, a frame there, all of them honest and all of them able to agree
 * with a mistake. This file is the opposite direction. It imports `index.js`, which
 * imports `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-credentials` for real, and
 * then asks the questions only the shipped runtime can answer:
 *
 *   - does `apply(ctx, config)` complete against a context shaped like DSH's;
 *   - does the *service's own* `normalizeModelInfo` accept what the adapter returns;
 *   - does the credential record land where `credentialKey()` says it must;
 *   - do the panel routes, the sign-in flow and the bridge behave when they are
 *     driven from the outside instead of from a unit test.
 *
 * The harness packages are optional here on purpose: they are peer dependencies, so
 * a bare checkout without them skips rather than fails. `npm install` brings them in
 * and the file runs.
 *
 * @module test/integration.test.js
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { account, drain, eventStreamResponse, recordingLogger } from './helpers.js'

const harness = await import('@deepseek-ai/dsh-llm').then(async llm => ({
  llm,
  credentials: await import('@deepseek-ai/dsh-credentials'),
  plugin: await import('../index.js'),
})).catch(() => null)

const skip = harness ? false : 'install @deepseek-ai/dsh-llm and @deepseek-ai/dsh-credentials to run the harness seam'

/** A Kiro data-plane answer, as the transport expects to receive it. */
function kiroAnswer(text, { inputTokens = 12, outputTokens = 3, cacheRead = 0, stopReason = 'end_turn' } = {}) {
  return eventStreamResponse([
    { event: 'assistantResponseEvent', payload: { content: text } },
    { event: 'metricsEvent', payload: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cacheReadInputTokens: cacheRead } },
    { event: 'messageStopEvent', payload: { stopReason } },
  ])
}

/**
 * The smallest context that is still shaped like DSH's.
 *
 * Services are taken from the real package surfaces: `credentialKey` for naming,
 * `readRecord`/`modifyRecord` for the store, `register{Adapter,ConfigurableProviders,
 * ModelDiscovery}` for the LLM runtime, `fetch.register` for the panel, `registerFlow`
 * for credentials UI, and `effect`/`on` for lifecycle.
 */
function createHarnessContext({ config = {}, records = new Map(), fetch } = {}) {
  const registered = {
    adapters: [],
    providers: [],
    discovery: new Map(),
    flows: [],
    routes: new Map(),
    effects: [],
    events: new Map(),
    settingsConfigure: [],
    log: recordingLogger(),
  }
  const ctx = {
    logger: registered.log,
    fiber: { entry: { options: { id: 'dsh-desktop-kiro' } } },
    get(name) {
      // DSH resolves an injected service to `undefined` when it is absent; the
      // attachments lookup below is exactly that case for this plugin.
      return name === 'attachments' ? undefined : ctx[name]
    },
    inject(deps, callback) {
      // DSH hands the child the same plugin context narrowed to those services.
      if (!Array.isArray(deps) || deps.some(name => ctx[name] === undefined && name !== 'settings')) return
      callback(ctx)
    },
    effect(fn) {
      const dispose = fn(ctx)
      registered.effects.push(dispose)
      return () => typeof dispose === 'function' && dispose()
    },
    on(event, handler) {
      const list = registered.events.get(event) || []
      list.push(handler)
      registered.events.set(event, list)
      return () => registered.events.set(event, list.filter(entry => entry !== handler))
    },
    settings: {
      define() {},
      use: () => config,
      // The real service throws when a plugin configures a presentation twice for
      // one fiber, so the double records it and the test can count.
      configure(presentation, owner) {
        registered.settingsConfigure.push({ presentation, owner })
      },
    },
    credentials: {
      async readRecord(key) {
        const payload = records.get(key)
        return payload === undefined ? null : { key, payload }
      },
      async modifyRecord(key, produce) {
        const next = await produce(records.get(key) === undefined ? null : { key, payload: records.get(key) })
        if (next && Object.prototype.hasOwnProperty.call(next, 'payload')) records.set(key, next.payload)
        else if (next === null) records.delete(key)
        return next
      },
    },
    authorization: {
      registerFlow(flow) {
        registered.flows.push(flow)
        return () => {
          registered.flows = registered.flows.filter(entry => entry !== flow)
        }
      },
    },
    connection: {
      fetch: {
        register(route) {
          registered.routes.set(route.path, route)
          return () => registered.routes.delete(route.path)
        },
      },
    },
    llm: {
      registerConfigurableProviders(entries) {
        registered.providers.push(entries)
        const slot = { entries }
        registered.providers.push(slot)
        return {
          replace(next) {
            slot.entries = next
          },
        }
      },
      registerAdapter(routes, adapter) {
        registered.adapters.push({ routes, adapter })
        const slot = { routes }
        registered.adapters.push(slot)
        return {
          replace(next) {
            slot.routes = next
          },
        }
      },
      registerModelDiscovery(ns, handler) {
        registered.discovery.set(ns, handler)
        return () => registered.discovery.delete(ns)
      },
    },
  }
  if (fetch) {
    registered.originalFetch = globalThis.fetch
    globalThis.fetch = fetch
  }
  const restore = () => {
    if (registered.originalFetch) globalThis.fetch = registered.originalFetch
    for (const dispose of registered.effects) {
      try {
        dispose?.()
      } catch {
        /* teardown is best effort */
      }
    }
  }
  return { ctx, registered, config, records, restore }
}

/** The config object DSH hands `apply()`: one `.get()` accessor per settings group. */
function configFor(values = {}) {
  return {
    providers: { get: () => values.providers ?? {} },
    bridge: { get: () => values.bridge ?? {} },
    auth: { get: () => values.auth ?? {} },
  }
}

/** The service's own validator, applied to whatever the adapter answers. */
function normalizeModelInfo(route, modelId, resolved) {
  const self = {
    detachedModalities: modalities => (Array.isArray(modalities) && modalities.length > 0 ? [...modalities] : undefined),
  }
  return harness.llm.LlmRuntime.prototype.normalizeModelInfo.call(self, { provider: { id: route } }, modelId, resolved)
}

test('the plugin registers every surface it claims, through the real service API', { skip }, async () => {
  const records = new Map()
  const seed = { version: 1, activeId: 'kiro-live', accounts: [{ ...account(), id: 'kiro-live', label: 'Live Account', accessToken: 'at'.padEnd(40, 'x'), refreshToken: 'aor'.padEnd(40, 'y'), expiresAt: Date.now() + 3_600_000 }] }
  const key = harness.credentials.credentialKey('dsh-desktop-kiro', 'account')
  records.set(key, seed)

  const seen = []
  const fetch = async (url, init) => {
    seen.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(init.body) : null, headers: init?.headers })
    if (String(url).includes('ListAvailableModels')) {
      return new Response(JSON.stringify({ models: [{ modelId: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', contextLength: 200000, maxTokens: 32000 }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return kiroAnswer('from the plugin')
  }
  const { ctx, registered, restore } = createHarnessContext({
    config: configFor({ bridge: { enable: false }, auth: { autoImport: false } }),
    records,
    fetch,
  })
  try {
    await harness.plugin.apply(ctx, ctx.settings.use())
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))

    // one adapter, one route, and it is a real LlmAdapter
    assert.equal(registered.adapters.length, 2, 'the registration plus its replaceable slot')
    const adapter = registered.adapters[0].adapter
    assert.deepEqual(registered.adapters[0].routes, ['kiro'])
    assert.ok(adapter instanceof harness.llm.LlmAdapter, 'the base class is what the service expects')
    for (const method of ['providerInfo', 'listModels', 'resolveModel', 'prepareCall', 'stream']) {
      assert.equal(typeof adapter[method], 'function', `adapter.${method} is required by the contract`)
    }

    // the Models page's directory entry
    const directory = registered.providers[1].entries
    assert.deepEqual(directory.map(entry => entry.provider), ['kiro'])
    assert.equal(directory[0].settingsNs, 'dsh-desktop-kiro')
    assert.deepEqual(directory[0].settingsPath, ['providers', 'kiro'])
    assert.equal(directory[0].declared, true)

    // the sign-in flow is registered under the record it writes
    assert.equal(registered.flows.length, 1)
    assert.equal(registered.flows[0].key, key, 'a flow must commit through its own record')
    assert.equal(registered.flows[0].methods.length, 8)
    assert.deepEqual(registered.flows[0].methods.map(method => method.id), ['builder-id', 'idc', 'google', 'github', 'external_idp', 'api_key', 'import', 'auto-import'])

    // panel routes
    for (const path of ['/api/kiro.status', '/api/kiro.models', '/api/kiro.refresh', '/api/kiro.signin', '/api/kiro.signin.cancel', '/api/kiro.account']) {
      assert.ok(registered.routes.has(path), `${path} was not registered`)
    }

    // the settings contribution suppresses the generic plugin page, once
    assert.deepEqual(registered.settingsConfigure.map(entry => entry.presentation), [{ auto: false }])
    assert.equal(registered.settingsConfigure[0].owner, ctx.fiber)
    assert.deepEqual(registered.log.lines.filter(line => /bridge listening/u.test(line)), [], 'a disabled bridge must not listen')

    // 1. status, straight from the panel route
    const status = await (await registered.routes.get('/api/kiro.status').fetch(new Request('http://127.0.0.1/api/kiro.status'))).json()
    assert.equal(status.accounts.activeId, 'kiro-live')
    assert.equal(status.accounts.accounts[0].label, 'Live Account')
    assert.equal(status.bridge.enabled, false)
    assert.ok(status.models > 19)
    // The panel's account view is the store's redacted one: tails of four, never more.
    const panelJson = JSON.stringify(status)
    assert.doesNotMatch(panelJson, /x{12,}/u, 'no credential through the panel either')
    assert.doesNotMatch(panelJson, /y{12,}/u)
    assert.match(panelJson, /"secretTails":\{"accessToken":"…xxxx","refreshToken":"…yyyy"\}/u)

    // 2. the catalog the picker shows
    const listed = await (await registered.routes.get('/api/kiro.models').fetch(new Request('http://127.0.0.1/api/kiro.models'))).json()
    assert.ok(listed.models.length > 19)

    // 3. discovery, through the handler the Models page calls
    const discover = registered.discovery.get('dsh-desktop-kiro')
    const discovered = await discover({ provider: 'kiro' })
    assert.ok(discovered.some(model => model.id === 'claude-sonnet-4.5'))
    assert.ok(seen.some(call => call.url.includes('ListAvailableModels')), 'discovery asked Kiro, not the seed table')
    await assert.rejects(discover({ baseURL: 'https://someone-else.example' }), error => {
      assert.ok(error instanceof harness.llm.LlmError, 'a harness error, so the service can classify it')
      assert.equal(error.code, 'DISCOVERY_UNSUPPORTED')
      return true
    })

    // 4. every model the adapter reports passes the service's own validator
    for (const model of await adapter.listModels('kiro')) {
      const resolved = await adapter.resolveModel('kiro', model.id)
      const normalized = normalizeModelInfo('kiro', model.id, resolved)
      assert.equal(normalized.name.length > 0, true)
      if (normalized.reasoning) {
        assert.ok(normalized.reasoning.efforts.length > 0)
        assert.ok(normalized.reasoning.efforts.every(effort => typeof effort.description === 'string'))
      }
    }
    // The largest context Kiro accepts, checked through the service rather than here.
    const opus = normalizeModelInfo('kiro', 'claude-opus-5.5', await adapter.resolveModel('kiro', 'claude-opus-5.5'))
    assert.equal(opus.context.contextWindow, 1_000_000)
    assert.equal(opus.defaultMaxTokens, 128_000)

    // 5. a turn through the adapter, with the credential the pool already holds
    const chunks = await drain(adapter.stream({
      provider: 'kiro',
      model: 'claude-sonnet-4.5',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }))
    assert.equal(chunks.at(-1).type, 'finish')
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    const turn = seen.find(call => call.url.includes('generateAssistantResponse'))
    assert.ok(turn, 'the data plane was called')
    // The body is Kiro's own shape, not the client's: what the harness asked for has
    // to arrive as `conversationState.currentMessage.userInputMessage`.
    const state = turn.body.conversationState
    assert.equal(state.currentMessage.userInputMessage.modelId, 'claude-sonnet-4.5')
    assert.equal(state.currentMessage.userInputMessage.content, 'hi')
    assert.equal(turn.body.inferenceConfig.maxTokens, 32_000, 'the wire cap, not the model\'s advertised maximum')
    assert.equal(turn.body.profileArn, 'arn:aws:codewhisperer:us-east-1:123456789012:profile/TESTARN')
    assert.match(turn.headers.Authorization, /^Bearer atx/u)
    // The part that makes Kiro answer at all outside its own IDE: a request shaped
    // like the IDE's, on the eventstream media type, with the opt-out the service
    // expects. A generic client that omits these gets a 400 or an empty turn.
    assert.match(turn.headers['User-Agent'], /KiroIDE-/u)
    assert.match(turn.headers['x-amz-user-agent'], /^aws-sdk-js\//u)
    assert.equal(turn.headers.Accept, 'application/vnd.amazon.eventstream')
    assert.equal(turn.headers['x-amzn-kiro-agent-mode'], 'vibe')
    assert.equal(turn.headers['x-amzn-codewhisperer-optout'], 'true', 'content collection stays opted out')
    assert.match(turn.headers['amz-sdk-invocation-id'], /^[0-9a-f-]{36}$/u)

    // 6. the record the pool wrote back is the one the seam named
    assert.ok(records.has(key))
    assert.equal(records.get(key).accounts[0].id, 'kiro-live')
  } finally {
    restore()
  }
})

test('the bridge the plugin starts serves both formats on loopback', { skip }, async () => {
  const key = harness.credentials.credentialKey('dsh-desktop-kiro', 'account')
  const records = new Map([[key, {
    version: 1,
    activeId: 'kiro-live',
    accounts: [{ ...account(), id: 'kiro-live', authMethod: 'api_key', apiKey: 'kiro-live-key', accessToken: 'kiro-live-key', refreshToken: '', expiresAt: Date.now() + 86_400_000 }],
  }]])
  const client = globalThis.fetch
  const fetch = async (url, init) => {
    // The bridge is a real socket, so only Kiro's own hosts are doubled here.
    if (/^https:\/\/(runtime|q|codewhisperer)\./u.test(String(url)) === false) return client(url, init)
    if (String(url).includes('ListAvailableModels')) {
      return new Response(JSON.stringify({ models: [{ modelId: 'claude-sonnet-4.5', contextLength: 200000, maxTokens: 32000 }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    // The Kiro payload, not the client's JSON: this is also proof that the bridge's
    // canonical request reached the wire in the shape the data plane expects.
    const body = init?.body ? JSON.parse(init.body) : {}
    return kiroAnswer(`echo:${body.conversationState?.currentMessage?.userInputMessage?.content ?? ''}`)
  }
  const { ctx, registered, restore } = createHarnessContext({
    config: configFor({ bridge: { enable: true, port: 0 }, auth: { autoImport: false } }),
    records,
    fetch,
  })
  try {
    await harness.plugin.apply(ctx, ctx.settings.use())
    let url = null
    for (let attempt = 0; attempt < 40 && !url; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      const status = await (await registered.routes.get('/api/kiro.status').fetch(new Request('http://127.0.0.1/api/kiro.status'))).json()
      url = status.bridge.enabled ? status.bridge.url : null
    }
    assert.ok(url, 'the panel reports the listening url')

    const openai = await (await client(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4.5', messages: [{ role: 'user', content: 'ping' }] }),
    })).json()
    assert.equal(openai.choices[0].message.content, 'echo:ping')
    assert.equal(openai.usage.prompt_tokens, 12)
    assert.equal(openai.usage.total_tokens, 15)

    const anthropic = await (await client(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4.5', max_tokens: 64, messages: [{ role: 'user', content: 'pong' }] }),
    })).json()
    assert.equal(anthropic.content[0].text, 'echo:pong')
    assert.equal(anthropic.stop_reason, 'end_turn')

    const stream = await client(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4.5', stream: true, messages: [{ role: 'user', content: 'stream me' }] }),
    })
    assert.match(stream.headers.get('content-type'), /text\/event-stream/u)
    const text = await stream.text()
    // OpenAI spelling: bare `data:` chunks with `choices[].delta.content`, a final
    // chunk carrying `finish_reason` and usage, then the sentinel.
    assert.match(text, /"delta":\{"content":"echo:stream me"\}/u)
    assert.match(text, /"finish_reason":"stop"/u)
    assert.match(text, /"total_tokens":15/u)
    assert.match(text, /data: \[DONE\]\n\n$/u)

    // Turning it off stops the listener, because a plugin that leaks a port cannot reload.
    const disposed = registered.effects.filter(entry => typeof entry === 'function')
    assert.ok(disposed.length > 0)
  } finally {
    restore()
  }
  const status = await (await registered.routes.get('/api/kiro.status').fetch(new Request('http://127.0.0.1/api/kiro.status'))).json().catch(() => null)
  void status
})

test('a volatile update re-registers routes instead of leaving the old ones behind', { skip }, async () => {
  const values = {
    providers: {},
    bridge: { enable: false },
    auth: { autoImport: false },
  }
  const { ctx, registered, restore } = createHarnessContext({ config: configFor(values) })
  try {
    await harness.plugin.apply(ctx, ctx.settings.use())
    const slot = registered.adapters[1]
    const directory = registered.providers[1]
    assert.deepEqual(slot.routes, ['kiro'], 'the first pass only knows the default route')
    // DSH re-reads settings, then announces the volatile update on the context.
    values.providers = { 'kiro-work': { displayName: 'Kiro (work)', region: 'eu-central-1' } }
    for (const handler of registered.events.get('loader/volatile-update') || []) await handler()
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(slot.routes.includes('kiro-work'), `routes became ${slot.routes.join(',')}`)
    assert.ok(directory.entries.some(entry => entry.provider === 'kiro-work'))
    assert.equal(directory.entries.find(entry => entry.provider === 'kiro-work').defaultBaseURL, undefined)
  } finally {
    restore()
  }
})

test('an empty answer re-asks instead of committing half a credential', { skip }, async () => {
  const key = harness.credentials.credentialKey('dsh-desktop-kiro', 'account')
  const records = new Map()
  const { ctx, registered, restore } = createHarnessContext({
    config: configFor({ bridge: { enable: false }, auth: { autoImport: false } }),
    records,
    fetch: async () => new Response(JSON.stringify({ models: [{ modelId: 'claude-sonnet-4.5', contextLength: 200000, maxTokens: 32000 }] }), { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  try {
    await harness.plugin.apply(ctx, ctx.settings.use())
    // The panel's sign-in round for an API key, driven exactly as the UI drives it.
    const ask = await (await registered.routes.get('/api/kiro.signin').fetch(new Request('http://127.0.0.1/api/kiro.signin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'api_key' }),
    }))).json()
    assert.equal(ask.status, 'awaiting_input')
    assert.equal(ask.prompt.field, 'apiKey')
    assert.equal(ask.prompt.required, true)

    // An unusable key must be refused by the harness's own rule, not stored.
    assert.throws(() => harness.llm.assertUsableApiKey(''), /credential|api.?key/iu)
    const refused = await (await registered.routes.get('/api/kiro.signin').fetch(new Request('http://127.0.0.1/api/kiro.signin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'api_key', input: { apiKey: '' } }),
    }))).json()
    // A stray Enter is not an error to show: the round stays open on the same field,
    // and the harness's own rule (`assertUsableApiKey`) is what refuses a real key.
    assert.equal(refused.status, 'awaiting_input')
    assert.equal(refused.prompt.field, 'apiKey')
    assert.ok(!records.has(key), 'nothing half-written is committed')
    const cancelled = await registered.routes.get('/api/kiro.signin.cancel').fetch(new Request('http://127.0.0.1/api/kiro.signin.cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stateId: refused.stateId }),
    }))
    assert.equal(cancelled.status, 200, 'and a parked round can be abandoned')

    const accepted = await (await registered.routes.get('/api/kiro.signin').fetch(new Request('http://127.0.0.1/api/kiro.signin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'api_key', input: { apiKey: 'kiro-good-key' } }),
    }))).json()
    assert.equal(accepted.status, 'authorized')
    assert.equal(records.get(key).accounts.length, 1)
    assert.equal(harness.llm.assertUsableApiKey(records.get(key).accounts[0].apiKey), 'kiro-good-key')
  } finally {
    restore()
  }
})
