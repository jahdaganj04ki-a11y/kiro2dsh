/**
 * Kiro data-plane transport: headers, endpoint walk, retries, streaming.
 *
 * This module owns the three facts that decide whether a non-Kiro client gets
 * an answer at all:
 *
 * 1. The **fingerprint headers**. The gateway parses `User-Agent` as an AWS SDK
 *    v2.1 UA string and rejects a value it cannot parse with
 *    `400 format of value 'os/win/10 lang/js …' is invalid`. The exact token
 *    shape, the per-machine id, the invocation id and the agent-mode marker all
 *    have to be present, so they are built here from one stable fingerprint
 *    rather than passed through from a config file.
 * 2. The **surface order**. `runtime.*.kiro.dev` is a deprecated path gateway
 *    that answers valid modern payloads with 400, and a 400 is terminal, so it
 *    must never be tried first. Amazon surfaces answer a foreign token with
 *    401/403, which does fall through — that is what makes an ordered walk
 *    safe for every auth method.
 * 3. **When to retry**. 401/403 refresh the token once and move to the next
 *    surface; 429 honours `retry-after` and never burns the whole list; a 400
 *    payload error stops immediately, because resending a malformed body to
 *    another host cannot repair it.
 *
 * @module lib/kiro/transport
 */

import { randomUUID } from 'node:crypto'

import {
  API_KEY_SURFACE_ORDER,
  CODEWHISPERER_TARGET,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_FIRST_CHUNK_TIMEOUT_MS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  ENDPOINT_FALLBACK_STATUSES,
  EVENTSTREAM_ACCEPT,
  KIRO_FIXED_HEADERS,
  KIRO_SURFACES,
  KIRO_UA,
  OAUTH_SURFACE_ORDER,
  assertValidAwsRegion,
} from '../constants.js'
import { ERROR_CODES, KiroError, classifyUpstream } from '../errors.js'
import { fingerprint, mergeHeaders, readBodyPrefix, retryAfterHeaderMs, sleep } from '../util.js'
import { EventStreamParser } from './eventstream.js'
import { KiroTurnReducer } from './response.js'

/**
 * Build the per-account fingerprint headers.
 *
 * The machine id is a digest of a stable credential identity, so one account
 * always presents one machine: Kiro keys its session and quota behaviour on it,
 * and rotating it per request makes rate limiting worse.
 */
export function buildFingerprintHeaders(credentials, options = {}) {
  const seed = credentials?.clientId
    || credentials?.refreshToken
    || credentials?.profileArn
    || credentials?.accessToken
    || 'kiro-anonymous'
  const machineId = fingerprint(seed)
  const os = options.os || KIRO_UA.os
  const osVersion = options.osVersion || KIRO_UA.osVersion
  const kiroVersion = options.kiroVersion || KIRO_UA.kiroVersion
  const userAgent = [
    `aws-sdk-js/${KIRO_UA.runtimeSdkVersion}`,
    'ua/2.1',
    `os/${os}#${osVersion}`,
    'lang/js',
    `md/nodejs#${options.nodeVersion || KIRO_UA.nodeVersion}`,
    `api/${KIRO_UA.api}#${KIRO_UA.runtimeSdkVersion}`,
    'm/N,E',
    `KiroIDE-${kiroVersion}-${machineId}`,
  ].join(' ')

  return {
    'User-Agent': userAgent,
    'x-amz-user-agent': `aws-sdk-js/${KIRO_UA.runtimeSdkVersion} KiroIDE-${kiroVersion}-${machineId}`,
    'x-amzn-kiro-agent-mode': options.agentMode || 'vibe',
    'x-amzn-codewhisperer-optout': 'true',
    'amz-sdk-request': 'attempt=1; max=3',
    'amz-sdk-invocation-id': randomUUID(),
    Accept: EVENTSTREAM_ACCEPT,
  }
}

/**
 * Render one surface URL for a region.
 * @param {string} surface key of `KIRO_SURFACES`
 * @param {string} region
 */
export function surfaceUrl(surface, region = 'us-east-1') {
  const template = KIRO_SURFACES[surface]
  if (!template) throw new KiroError(`unknown Kiro surface ${JSON.stringify(surface)}`, ERROR_CODES.invalidPayload)
  if (template.includes('{region}')) {
    assertValidAwsRegion(region)
    return template.replace('{region}', region)
  }
  return template
}

/**
 * Auth-aware endpoint ordering.
 *
 * @param {{ authMethod?: string, region?: string, surfaces?: string[] }} credentials
 * @returns {string[]} surface keys, most acceptable first
 */
/**
 * Which hosts to try, in order, for one credential.
 *
 * Duplicates are collapsed and unknown names dropped: a settings value of
 * `["q","q"]` must not spend the retry budget on the same host twice, and a list
 * that ends up empty after filtering falls back to the default order rather than
 * failing the turn with no request at all.
 */
export function orderedSurfaces(credentials = {}) {
  const fallback = credentials.authMethod === 'api_key' ? API_KEY_SURFACE_ORDER : OAUTH_SURFACE_ORDER
  const wanted = Array.isArray(credentials.surfaces) && credentials.surfaces.length > 0
    ? [...new Set(credentials.surfaces.filter(surface => KIRO_SURFACES[surface]))]
    : []
  return wanted.length > 0 ? wanted : [...fallback]
}

/** Auth headers per credential kind; the wrong `TokenType` is an instant 401. */
export function buildAuthHeaders(credentials) {
  const headers = {}
  const authMethod = credentials?.authMethod
  if (authMethod === 'api_key') {
    // A Kiro API key is a long-lived bearer credential that CodeWhisperer only
    // accepts when it is explicitly typed as such.
    const key = credentials?.apiKey || credentials?.accessToken
    if (key) {
      headers.Authorization = `Bearer ${key}`
      headers.TokenType = 'API_KEY'
    }
    return headers
  }
  if (credentials?.accessToken) {
    headers.Authorization = `Bearer ${credentials.accessToken}`
    if (authMethod === 'external_idp') headers.TokenType = 'EXTERNAL_IDP'
    // The Amazon surfaces also honour the SSO bearer marker; without it the
    // deprecated path gateway answers REQUEST_BODY_INVALID for modern payloads.
    headers['x-amz-sso-bearer'] = credentials.accessToken
  }
  if (credentials?.profileArn) headers['x-amzn-codewhisperer-profile-arn'] = credentials.profileArn
  headers['x-amzn-codewhisperer-machine-id'] = credentials?.machineId || 'kiro-desktop'
  return headers
}

/**
 * Header names the data plane reads as a client fingerprint.
 *
 * The harness mandates its own attribution `user-agent` on every provider request,
 * and that is exactly what makes Kiro answer "usable in the IDE only": the gateway
 * parses this pair before it looks at the payload, and a generic or mismatched value
 * is rejected. So injected headers may add anything *except* these, which the
 * transport owns. `Content-Type` belongs here too, because a body the runtime cannot
 * parse is refused with an error that names nothing.
 */
const FINGERPRINT_HEADERS = Object.freeze(new Set([
  'user-agent',
  'x-amz-user-agent',
  'x-amzn-kiro-agent-mode',
  'x-amzn-codewhisperer-optout',
  'amz-sdk-request',
  'amz-sdk-invocation-id',
  'accept',
  'content-type',
]))

/** Drop the protected names from a caller-supplied header record. */
function withoutFingerprint(headers) {
  if (!headers) return null
  const kept = {}
  for (const [name, value] of Object.entries(headers)) {
    if (FINGERPRINT_HEADERS.has(String(name).toLowerCase())) continue
    kept[name] = value
  }
  return Object.keys(kept).length > 0 ? kept : null
}

/** Compose the full header set for one request. */
export function buildHeaders(credentials, options = {}) {
  const url = options.url || ''
  const headers = mergeHeaders(
    KIRO_FIXED_HEADERS,
    withoutFingerprint(options.extraHeaders),
    buildFingerprintHeaders(credentials, options),
    buildAuthHeaders(credentials),
  )
  // The legacy CodeWhisperer host is the only surface using the RPC target.
  if (url.includes('://codewhisperer.')) headers['x-amz-target'] = CODEWHISPERER_TARGET
  else delete headers['x-amz-target']
  // JSON calls (catalog, quota) must not claim the EventStream media type.
  if (options.accept && options.accept !== EVENTSTREAM_ACCEPT) headers.Accept = options.accept
  return headers
}

async function readWithTimeout(reader, signal, timeoutMs, message) {
  if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
  let timer
  let onAbort
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new KiroError(message, ERROR_CODES.timeout)), timeoutMs)
  })
  const aborts = new Promise((_, reject) => {
    onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
  try {
    const result = await Promise.race([reader.read(), timeout, aborts])
    if (result?.done) return null
    return result?.value ?? null
  } finally {
    clearTimeout(timer)
    if (signal && onAbort) signal.removeEventListener?.('abort', onAbort)
  }
}

/**
 * One Kiro turn, streamed as provider-neutral turn events.
 *
 * The generator yields text, reasoning and tool-call events as frames arrive,
 * then exactly one terminal event. Failures before the first byte become thrown
 * `KiroError`s with the harness-compatible code; failures inside a stream
 * become a terminal `error` event, because partial output already reached the
 * consumer and cannot be taken back.
 *
 * @param {{
 *   payload: object,
 *   credentials: object,
 *   modelSettings?: object,
 *   contextWindow?: number,
 *   fetch?: typeof globalThis.fetch,
 *   refresh?: () => Promise<boolean>,
 *   log?: object,
 *   signal?: AbortSignal,
 *   timeouts?: { connectMs?: number, firstChunkMs?: number, idleMs?: number },
 *   rateLimitRetries?: number,
 *   repair?: { enabled?: boolean, instruction?: string },
 * }} options
 * @returns {AsyncGenerator<object, void, void>}
 */
export async function* streamKiroTurn(options) {
  const fetchImpl = options.fetch || globalThis.fetch
  const surfaces = orderedSurfaces(options.credentials)
  const region = options.credentials?.region || 'us-east-1'
  const connectMs = options.timeouts?.connectMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const firstChunkMs = options.timeouts?.firstChunkMs ?? DEFAULT_FIRST_CHUNK_TIMEOUT_MS
  const idleMs = options.timeouts?.idleMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  const rateLimitRetries = Math.max(0, options.rateLimitRetries ?? 1)
  let payload = options.payload
  let lastError = new KiroError('Kiro request produced no result', ERROR_CODES.endpoint)
  let refreshed = false
  let rateLimitWaits = 0

  // Round 0 is the request; round 1 exists only to re-run a turn whose tool
  // wrapper was malformed and which streamed nothing else.
  attempts: for (let round = 0; round < 2; round++) {
    let surfaceIndex = 0
    while (surfaceIndex < surfaces.length) {
      const surface = surfaces[surfaceIndex]
      const url = surfaceUrl(surface, region)
      const headers = buildHeaders(options.credentials, {
        url,
        agentMode: options.modelSettings?.agentMode,
        extraHeaders: options.credentials?.extraHeaders,
        os: options.credentials?.uaOs,
        osVersion: options.credentials?.uaOsVersion,
        nodeVersion: options.credentials?.uaNodeVersion,
        kiroVersion: options.credentials?.uaKiroVersion,
      })

      let response
      try {
        response = await fetchWithConnectTimeout(fetchImpl, url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: options.signal,
        }, connectMs)
      } catch (error) {
        if (error?.name === 'AbortError') throw error
        lastError = new KiroError(`Kiro surface ${surface} is unreachable: ${error?.message || error}`, ERROR_CODES.endpoint, { cause: error })
        options.log?.warn?.(`kiro: ${surface} fetch failed: ${error?.message || error}`)
        surfaceIndex++
        continue
      }

      if (response.ok) {
        let emittedVisible = false
        let terminal = null
        const reducer = new KiroTurnReducer({ contextWindow: options.contextWindow })
        const queued = []
        const parser = new EventStreamParser({
          onFrame: frame => {
            for (const event of reducer.push(frame)) {
              if (event.type === 'text' || event.type === 'reasoning' || event.type === 'tool-call') emittedVisible = true
              queued.push(event)
            }
          },
        })
        const reader = response.body?.getReader?.()
        if (!reader) {
          throw new KiroError('Kiro response did not include an EventStream body', ERROR_CODES.corruptStream)
        }
        let sawFrame = false
        try {
          for (;;) {
            const chunk = await readWithTimeout(
              reader,
              options.signal,
              emittedVisible || sawFrame ? idleMs : firstChunkMs,
              emittedVisible || sawFrame ? 'Kiro stream stalled' : 'Kiro stream timed out before the first chunk',
            )
            if (chunk === null) break
            sawFrame = true
            for (const frame of parser.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk))) {
              void frame
              while (queued.length > 0) yield queued.shift()
            }
            while (queued.length > 0) yield queued.shift()
          }
          const corrupt = parser.finish()
          if (corrupt) {
            terminal = {
              type: 'error',
              message: corrupt.message,
              code: ERROR_CODES.corruptStream,
              transportState: 'incomplete_frame',
              stopDisposition: 'terminal_incomplete',
            }
          } else {
            for (const event of reducer.finish()) {
              if (event.type === 'error' && !terminal) terminal = event
              else yield event
            }
          }
        } catch (error) {
          if (error?.name === 'AbortError') throw error
          terminal = {
            type: 'error',
            message: error?.message || String(error),
            code: error instanceof KiroError && error.code === ERROR_CODES.timeout ? ERROR_CODES.timeout : ERROR_CODES.corruptStream,
            transportState: 'read_error',
            stopDisposition: 'terminal_incomplete',
          }
        } finally {
          reader.cancel?.().catch?.(() => {})
        }

        while (queued.length > 0) yield queued.shift()

        if (terminal) {
          const repairable = options.repair?.enabled !== false
            && round === 0
            && !emittedVisible
            && terminal.stopDisposition === 'retryable_protocol_failure'
          if (repairable) {
            payload = withRepairInstruction(payload, options.repair?.instruction)
            options.log?.warn?.(`kiro: ${terminal.message}; retrying once with a repair instruction`)
            continue attempts
          }
          yield terminal
          return
        }
        return
      }

      const body = await readBodyPrefix(response, 8192)
      const failure = classifyUpstream(response.status, body)
      lastError = new KiroError(`Kiro ${surface} answered ${response.status}: ${failure.message}`, failure.code, {
        status: response.status,
        reason: failure.reason,
        requestId: response.headers?.get?.('x-amzn-requestid') || undefined,
      })

      if ((response.status === 401 || response.status === 403) && !refreshed && typeof options.refresh === 'function') {
        // Rotating the token is cheaper than walking the whole surface list, and
        // an expired OAuth token is rejected identically by every host.
        refreshed = true
        const ok = await options.refresh().catch(() => false)
        if (ok) {
          options.log?.info?.('kiro: refreshed the access token after an auth rejection; retrying the same surface')
          continue
        }
      }
      if (response.status === 429 && rateLimitWaits < rateLimitRetries) {
        const wait = retryAfterHeaderMs(response)
        rateLimitWaits++
        lastError = new KiroError(`Kiro ${surface} rate limited: ${failure.message}`, ERROR_CODES.rateLimit, {
          status: 429,
          providerRetryAfterMs: wait,
        })
        options.log?.warn?.(`kiro: ${surface} rate limited; waiting ${wait}ms then retrying (${rateLimitWaits}/${rateLimitRetries})`)
        await sleep(wait, options.signal)
        continue
      }
      if (failure.fallback || ENDPOINT_FALLBACK_STATUSES.has(response.status)) {
        options.log?.warn?.(`kiro: ${surface} rejected this credential (${response.status}); trying the next surface`)
        surfaceIndex++
        continue
      }
      // A 400 payload error or a quota answer is terminal for every surface:
      // the body or the account is the problem, not the host. Resending the
      // same payload to the next host cannot repair it, which is why a 400 is
      // deliberately absent from ENDPOINT_FALLBACK_STATUSES.
      throw lastError
    }
    // Every surface has now answered. Re-entering the round would replay the same
    // body at the same hosts, so the walk ends here and only a repair (above) or
    // a rate-limit wait restarts it.
    break attempts
  }

  throw lastError
}

/**
 * Fetch with a connect timeout: the abort covers response headers only, so a
 * healthy stream is never cut off by it.
 */
async function fetchWithConnectTimeout(fetchImpl, url, init, connectMs) {
  if (!Number.isFinite(connectMs) || connectMs <= 0) return await fetchImpl(url, init)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('Kiro connect timeout')), connectMs)
  const signals = [init.signal, controller.signal].filter(Boolean)
  const signal = typeof AbortSignal.any === 'function' && signals.length > 1 ? AbortSignal.any(signals) : signals[0]
  try {
    return await fetchImpl(url, { ...init, signal })
  } catch (error) {
    if (controller.signal.aborted && !init.signal?.aborted) {
      throw new KiroError(`Kiro request timed out before the response headers arrived (${connectMs}ms)`, ERROR_CODES.timeout)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Append a repair instruction to the current user turn.
 *
 * It must not become a top-level `systemPrompt`: kiro.dev answers any body
 * carrying that field with 400 REQUEST_BODY_INVALID.
 */
export function withRepairInstruction(payload, instruction) {
  const next = structuredClone(payload || {})
  const message = next?.conversationState?.currentMessage?.userInputMessage
  const text = typeof message?.content === 'string' ? message.content : ''
  const note = instruction
    || 'Retry the previous response. Its tool call was malformed: if you use a tool, the name and arguments must both be present and complete.'
  if (message) message.content = text ? `${text}\n\n${note}` : note
  return next
}

export { DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_FIRST_CHUNK_TIMEOUT_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS }
