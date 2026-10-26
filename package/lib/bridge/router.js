/**
 * The local HTTP bridge.
 *
 * Kiro's signed-in user has always been reachable from inside the IDE and from
 * nowhere else, because the wire protocol carries a device fingerprint, a
 * `codebase` context header and a profile ARN that generic clients do not know
 * about. The bridge is the second door: it speaks OpenAI Chat Completions and
 * Anthropic Messages on loopback, and behind it every request runs through the
 * exact same turn pipeline as the desktop app — same catalog, same per-model
 * settings, same credential rotation, same tool-name limits.
 *
 * Routes:
 *   GET  /v1/models                    the catalog, in both formats' shape
 *   POST /v1/chat/completions          OpenAI Chat Completions (stream + JSON)
 *   POST /v1/messages                  Anthropic Messages (stream + JSON)
 *   POST /v1/messages/count_tokens     a token estimate for Claude Code-style clients
 *   GET  /v1/kiro/status               accounts, quota, and what this plugin can reach
 *   GET  /health                       liveness without any upstream call
 *
 * @module lib/bridge/router.js
 */

import { anthropicJSON, anthropicSSE, openaiJSON, openaiSSE, SSE_HEADERS } from './render.js'
import { estimateTokens, requestText, toCanonicalRequest } from './formats.js'
import { KiroError, ERROR_CODES } from '../errors.js'
import { catalogOrder, describeCapabilities } from '../catalog.js'
import { KIRO_MODEL_PREFIXES } from '../constants.js'
import { describeAccount } from '../auth/store.js'

const JSON_HEADERS = Object.freeze({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })

/** A JSON `Response`. */
function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: JSON_HEADERS })
}

/**
 * Wrap an async iterable of `Uint8Array` into a streaming `Response`.
 *
 * An error thrown before the first frame is a real failure and must reach the
 * client as one; after headers are committed the only honest option is to
 * serialize the error into the stream and terminate it.
 */
function stream(iterable, status = 200) {
  const iterator = iterable[Symbol.asyncIterator]()
  let emitted = false
  const source = new ReadableStream({
    async pull(controller) {
      try {
        const next = await iterator.next()
        if (next.done) controller.close()
        else {
          emitted = true
          controller.enqueue(next.value)
        }
      } catch (error) {
        if (!emitted) {
          controller.error(error)
          return
        }
        controller.enqueue(errorFrame(error))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      }
    },
    async cancel() {
      await iterator.return?.().catch(() => {})
    },
  })
  return new Response(source, { status, headers: SSE_HEADERS })
}

const encoder = new TextEncoder()

function errorFrame(error) {
  const message = error?.message || String(error)
  return encoder.encode(`data: ${JSON.stringify({ error: { message, type: 'upstream_error', code: error?.code } })}\n\n`)
}

/**
 * Reject anything that is not holding the shared secret.
 *
 * An empty `bridgeToken` means "any local process" — the documented default,
 * because the bridge binds to loopback and a second secret in front of the OS
 * session is theatre. Setting one turns every request without it into a 401.
 */
export function assertAuthorized(request, settings) {
  const expected = String(settings.bridgeToken || settings.privateAccessToken || '').trim()
  if (!expected) return
  const header = request.headers
  const bearer = typeof header.get === 'function' ? header.get('authorization') : header?.authorization
  const apiKey = typeof header.get === 'function' ? header.get('x-api-key') : header?.['x-api-key']
  const provided = String(bearer || '').replace(/^Bearer\s+/i, '') || String(apiKey || '')
  if (provided !== expected) throw new KiroError('invalid bridge credentials', ERROR_CODES.auth, { status: 401 })
}

/** The `/v1/models` payload, enriched with what each id can actually do. */
export function modelList(catalog, format) {
  const models = catalogOrder(catalog)
  if (format === 'anthropic') {
    return {
      data: models.map(model => ({
        type: 'model',
        id: model.id,
        display_name: model.name,
        created_at: null,
        max_input_tokens: model.context,
        max_tokens: model.maxOutput,
        capabilities: describeCapabilities(model),
      })),
      has_more: false,
      first_id: models[0]?.id ?? null,
      last_id: models[models.length - 1]?.id ?? null,
    }
  }
  return {
    object: 'list',
    data: models.map(model => ({
      id: model.id,
      object: 'model',
      owned_by: 'kiro',
      created: Math.floor(Date.now() / 1000),
      context_length: model.context,
      max_output_tokens: model.maxOutput,
      supported_input_modalities: model.inputModalities || (model.vision ? ['text', 'image'] : ['text']),
      supported_output_modalities: ['text'],
      supported_sampling_params: { temperature: true, top_p: true, stop: true, seed: false },
      supported_tools: true,
      supported_reasoning_efforts: model.efforts === false ? null : [...(model.efforts || [])],
      agentic: model.agentic,
      rate_multiplier: model.rateMultiplier,
    })),
  }
}

/**
 * Build the router.
 * @param {{
 *   runTurn: (request: object, options?: object) => AsyncGenerator<object>,
 *   catalog: () => object[],
 *   settings: () => object,
 *   store?: { describe(): Promise<object[] | { accounts: object[], activeId: string | null, configured: boolean }> },
 *   usage?: () => Promise<object | null>,
 *   log?: object,
 * }} deps
 * @returns {{ handle(request: Request, url?: URL): Promise<Response> }}
 */
export function createBridgeRouter(deps) {
  const handle = async (request, urlInput) => {
    const url = urlInput instanceof URL ? urlInput : new URL(request.url || String(urlInput || '/'), 'http://127.0.0.1')
    const path = url.pathname.replace(/\/+$/, '') || '/'
    const settings = deps.settings?.() || {}
    try {
      assertAuthorized(request, settings)
      if (request.method === 'GET' && (path === '/health' || path === '/')) {
        return json({ ok: true, provider: 'kiro', models: catalogOrder(deps.catalog()).length, prefixes: [...KIRO_MODEL_PREFIXES] })
      }
      if (request.method === 'GET' && (path === '/v1/models' || path === '/models')) {
        return json(modelList(deps.catalog(), url.searchParams.get('format') || (path.startsWith('/v1/messages') ? 'anthropic' : 'openai')))
      }
      if (request.method === 'GET' && path === '/v1/kiro/status') {
        // `describe()` answers with the pool view (`{ activeId, configured, accounts }`)
        // and some callers only have the list; both are accepted so the panel never
        // has to know which one it is talking to.
        const [described, usage] = await Promise.all([
          Promise.resolve(deps.store?.describe?.() ?? []).catch(() => null),
          deps.usage?.().catch(() => null) ?? Promise.resolve(null),
        ])
        const listed = Array.isArray(described) ? described : (described?.accounts ?? [])
        // Belt and braces: the panel endpoint may be reachable without a bridge
        // secret, so a record that still carries a credential is reduced here rather
        // than trusted to have been reduced by whoever supplied it.
        const accounts = listed.map(entry => (entry && (entry.accessToken || entry.refreshToken || entry.apiKey || entry.clientSecret))
          ? describeAccount(entry)
          : entry)
        return json({
          activeId: Array.isArray(described) ? null : (described?.activeId ?? null),
          configured: Array.isArray(described) ? described.length > 0 : (described?.configured ?? false),
          accounts,
          usage,
          catalog: catalogOrder(deps.catalog()).length,
          settings: publicSettings(settings),
        })
      }
      if (request.method !== 'POST') return json({ error: { message: `unsupported method ${request.method} ${path}`, type: 'invalid_request_error' } }, 405)

      const body = await readJson(request)
      const format = path === '/v1/messages' || path === '/v1/messages/count_tokens' ? 'anthropic' : 'openai'
      if (path === '/v1/messages/count_tokens') {
        const canonical = toCanonicalRequest(body, format)
        const tokens = estimateTokens(requestText(canonical.messages))
        return json({ input_tokens: tokens })
      }
      if (path !== '/v1/chat/completions' && path !== '/v1/messages' && path !== '/v1/completions') {
        return json({ error: { message: `unknown endpoint ${path}`, type: 'invalid_request_error' } }, 404)
      }
      if (path === '/v1/completions') {
        return json({ error: { message: 'Kiro serves chat models only; use /v1/chat/completions', type: 'invalid_request_error' } }, 400)
      }

      const canonical = toCanonicalRequest(body, format)
      const chunks = deps.runTurn(canonical, { signal: request.signal })
      if (canonical.stream) {
        return format === 'anthropic'
          ? stream(anthropicSSE(chunks, { model: canonical.model }))
          : stream(openaiSSE(chunks, { model: canonical.model, includeUsage: body.stream_options?.include_usage !== false }))
      }
      const result = format === 'anthropic'
        ? await anthropicJSON(chunks, { model: canonical.model })
        : await openaiJSON(chunks, { model: canonical.model })
      return json(result.body, result.status)
    } catch (error) {
      return errorResponse(error)
    }
  }
  return { handle }
}

/** Read a JSON body from either a `Request` or a plain `{body}` object. */
async function readJson(request) {
  if (typeof request.json === 'function') {
    const text = typeof request.text === 'function' ? await request.text() : null
    if (text) {
      try {
        return JSON.parse(text)
      } catch {
        throw new KiroError('request body is not valid JSON', ERROR_CODES.rejected, { status: 400 })
      }
    }
    return {}
  }
  const raw = request.body
  if (raw === undefined || raw === null) return {}
  if (typeof raw === 'string') return JSON.parse(raw)
  if (Buffer.isBuffer?.(raw)) return JSON.parse(raw.toString('utf8'))
  if (raw instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(raw))
  if (typeof raw === 'object') return raw
  throw new KiroError('unsupported request body', ERROR_CODES.rejected, { status: 400 })
}

/** Settings a status endpoint may echo back, with secrets removed. */
function publicSettings(settings) {
  return {
    baseUrl: settings.baseUrl || null,
    surfaces: Array.isArray(settings.surfaces) ? settings.surfaces : null,
    autoImportLocalAuth: settings.autoImportLocalAuth !== false,
    refreshLeadingMs: settings.refreshLeadingMs ?? null,
    bridgeTokenConfigured: Boolean(settings.bridgeToken || settings.privateAccessToken),
    modelRewrites: settings.modelRewrites ?? null,
  }
}

/**
 * HTTP status for a plugin error, by code rather than by message.
 *
 * Shared with the carrier, because a request that dies before the router answers
 * (a body that will not fit in memory, a handler that throws) has to be reported
 * with the same status the router would have chosen.
 */
export function statusForError(error) {
  if (Number.isInteger(error?.status)) return error.status
  switch (error?.code) {
    case ERROR_CODES.auth:
    case ERROR_CODES.notConfigured:
    case ERROR_CODES.refreshExpired:
    case ERROR_CODES.invalidCredential:
      return 401
    case ERROR_CODES.rejected:
    case ERROR_CODES.invalidPayload:
      return 400
    case ERROR_CODES.rateLimit:
    case ERROR_CODES.quota:
      return 429
    case ERROR_CODES.timeout:
      return 504
    case ERROR_CODES.modelUnavailable:
      return 404
    default:
      return 502
  }
}

/** The error envelope both formats accept — a 4xx/5xx with a JSON body only. */
function errorResponse(error) {
  const status = statusForError(error)
  return json({ error: { message: error?.message || String(error), type: status >= 500 ? 'upstream_error' : 'invalid_request_error', code: error?.code || null, ...(status >= 500 ? { retryable: error?.retryable ?? true } : {}) } }, status)
}
