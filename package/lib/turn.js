/**
 * One model turn: account → payload → Kiro stream → harness chunks.
 *
 * This is the orchestration the adapter and the HTTP bridge share, so both see
 * identical behaviour and only differ in how they render it. The order of
 * operations is the order the failure modes demand:
 *
 * 1. resolve the account (refreshing a token that is about to expire), because
 *    an auth failure must not be reported as a model failure;
 * 2. resolve the model settings (live catalog merged over the seed), because the
 *    payload shape depends on the model;
 * 3. build and validate the payload locally, so a conversation Kiro would
 *    refuse never costs a request;
 * 4. stream, mapping events onto the harness block protocol;
 * 5. fail over to the next account only while nothing has been emitted — after
 *    the first delta the partial answer is the caller's, and replaying would
 *    duplicate it.
 *
 * @module lib/turn
 */

import { DEFAULT_MAX_OUTPUT } from './constants.js'
import { ERROR_CODES, KiroError, asKiroError } from './errors.js'
import { catalogOrder, findModel, normalizeModel } from './catalog.js'
import { refreshKiroToken } from './auth/token-refresh.js'
import { buildKiroPayload } from './kiro/request.js'
import { streamKiroTurn } from './kiro/transport.js'
import { resolveModelIntent } from './model-id.js'

/**
 * Assemble harness-shaped stream chunks.
 *
 * The protocol rules it enforces are the ones a consumer relies on: `usage`
 * precedes `finish`, nothing follows `finish`, every opened block is closed,
 * and tool arguments stay raw JSON strings.
 */
export class ChunkBuilder {
  constructor() {
    this.chunks = []
    this.index = 0
    this.open = null
    this.text = ''
    this.reasoning = ''
    this.closed = []
    this.finished = false
    this.usageSent = false
  }

  #open(kind) {
    if (this.open?.kind === kind) return this.open.index
    this.#close()
    const index = this.index++
    this.open = { kind, index }
    if (kind === 'text') this.text = ''
    if (kind === 'reasoning') this.reasoning = ''
    this.chunks.push({ type: 'block-start', index, blockType: kind })
    return index
  }

  #close() {
    if (!this.open) return
    const { kind, index } = this.open
    const block = kind === 'text'
      ? { type: 'text', text: this.text }
      : { type: 'reasoning', text: this.reasoning }
    this.chunks.push({ type: 'block-end', index, block })
    this.closed.push(block)
    this.open = null
  }

  text(text) {
    if (!text) return this
    const index = this.#open('text')
    this.text += text
    this.chunks.push({ type: 'text-delta', index, text })
    return this
  }

  reasoning(text) {
    if (!text) return this
    const index = this.#open('reasoning')
    this.reasoning += text
    this.chunks.push({ type: 'reasoning-delta', index, text })
    return this
  }

  /** Tool calls are complete when Kiro is done fragmenting them, so they get their own block. */
  toolCall(call) {
    this.#close()
    const index = this.index++
    const block = { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments }
    this.chunks.push({ type: 'block-start', index, blockType: 'tool-call' })
    this.chunks.push({
      type: 'tool-call-delta',
      index,
      id: call.id,
      name: call.name,
      argumentsDelta: call.arguments,
    })
    this.chunks.push({ type: 'block-end', index, block })
    this.closed.push(block)
    return this
  }

  usage(usage) {
    if (!usage || this.usageSent) return this
    this.#close()
    this.usageSent = true
    this.chunks.push({ type: 'usage', usage })
    return this
  }

  finish(reason) {
    if (this.finished) return this
    this.#close()
    this.finished = true
    this.chunks.push({ type: 'finish', reason })
    return this
  }

  error(failure) {
    if (this.finished) return this
    this.#close()
    this.finished = true
    this.chunks.push({ type: 'finish', reason: { kind: 'error', failure } })
    return this
  }

  aborted(failure) {
    if (this.finished) return this
    this.#close()
    this.finished = true
    this.chunks.push({ type: 'finish', reason: { kind: 'aborted', failure } })
    return this
  }
}

/** Map a plugin error code onto the harness failure taxonomy. */
export function harnessFailure(error) {
  const wrapped = asKiroError(error)
  const failure = wrapped.toFailure()
  return failure
}

/**
 * Run one turn.
 *
 * @param {{
 *   store: object,
 *   catalog: () => Map<string, object>,
 *   refreshCatalog?: (account: object) => Promise<void>,
 *   resolveImage?: (block: object) => Promise<object|undefined>,
 *   settings: () => object,
 *   fetch?: typeof globalThis.fetch,
 *   log?: object,
 * }} deps
 * @returns {{ streamTurn: Function, models: Function, resolve: Function }}
 */
export function createTurnRunner(deps) {
  const log = deps.log

  /** Catalog lookup that keeps the caller's exact id when the catalog lacks it. */
  const resolve = (modelId, route) => {
    const catalog = deps.catalog(route)
    const intent = resolveModelIntent(modelId)
    const model = findModel(catalog, intent.model) || findModel(catalog, intent.upstream)
    if (model) {
      return { model, intent: { ...intent, agentic: intent.agentic || model.agenticDefault === true, upstream: model.upstream } }
    }
    // An unlisted id still deserves a turn: Kiro adds models faster than any
    // static table, and the alias fold already covers the one rewrite that used
    // to make such a request fail.
    const synthesized = normalizeModel({
      id: intent.model,
      name: intent.model,
      upstream: intent.upstream,
      ...(intent.model === 'auto' ? { agentic: false, reasoning: 'none', efforts: false } : {}),
    })
    return { model: synthesized, intent: { ...intent, upstream: synthesized.upstream } }
  }

  /** The model list the harness settings page and the HTTP bridge both show. */
  const models = route => catalogOrder(deps.catalog(route))

  /** One turn, yielded as harness chunks. Throws a `KiroError` on a hard failure. */
  async function* streamTurn(options) {
    const builder = new ChunkBuilder()
    const route = options.provider || undefined
    const settings = deps.settings?.(route) || {}
    const { model, intent } = resolve(options.model, route)
    const maxAccounts = Math.max(1, Math.trunc(Number(settings.accountFailover) || 2))
    const candidates = (await deps.store.candidates()).slice(0, maxAccounts)
    if (candidates.length === 0) {
      throw new KiroError(
        'no Kiro account is signed in — open Settings › Plugins › Kiro and connect one',
        ERROR_CODES.notConfigured,
      )
    }
    let yielded = 0
    let lastError = null

    for (const candidate of candidates) {
      let account
      try {
        account = (await deps.store.authorize(candidate.id)).account
      } catch (error) {
        lastError = asKiroError(error, ERROR_CODES.notConfigured)
        await deps.store.noteFailure?.(candidate.id, lastError).catch(() => {})
        // Nothing has reached the caller yet, so another account can still answer.
        if (candidates.length > 1) continue
        throw lastError
      }

      const credentials = credentialsFor(account, model, settings)
      let sawTerminal = false
      let streamError = null
      try {
        const { payload, meta } = await buildKiroPayload({
          modelSettings: model,
          intent,
          messages: options.messages || [],
          tools: options.tools,
          maxTokens: options.maxTokens,
          temperature: options.temperature,
          reasoningEffort: options.reasoningEffort,
          conversationId: conversationIdFor(options, account),
          credentials,
          ...(deps.resolveImage ? { resolveImage: deps.resolveImage } : {}),
        })
        log?.debug?.(`kiro: turn model=${meta.upstream} turns=${meta.turns} tools=${meta.toolSpecs} thinking=${meta.thinking ? `${meta.thinking.path}:${meta.thinking.effort}` : 'off'} images=${meta.images} profile=${meta.profileArn}`)
        if (meta.repairs && (meta.repairs.missingResults || meta.repairs.orphanResults || meta.repairs.invalidToolUses)) {
          log?.warn?.(`kiro: conversation repaired (missingResults=${meta.repairs.missingResults} orphanResults=${meta.repairs.orphanResults} invalidToolUses=${meta.repairs.invalidToolUses})`)
        }

        const generator = streamKiroTurn({
          payload,
          credentials,
          modelSettings: model,
          contextWindow: model.context,
          fetch: deps.fetch,
          ...(options.signal ? { signal: options.signal } : {}),
          rateLimitRetries: Number.isFinite(settings.rateLimitRetries) ? settings.rateLimitRetries : 1,
          repair: { enabled: settings.repairToolCalls !== false, ...(settings.repairInstruction ? { instruction: settings.repairInstruction } : {}) },
          ...timeoutOptions(settings),
          refresh: () => rotateToken(deps, account, log),
          log: scopedLogger(log, model.id),
        })

        for await (const event of generator) {
          if (event.type === 'text') builder.text(event.text)
          else if (event.type === 'reasoning') builder.reasoning(event.text)
          else if (event.type === 'tool-call') builder.toolCall(event)
          else if (event.type === 'usage') builder.usage(toHarnessUsage(event.usage))
          else if (event.type === 'finish') {
            sawTerminal = true
            builder.finish({ kind: mapFinish(event.reason) })
          } else if (event.type === 'error') streamError = streamError || event
          else if (event.type === 'diagnostic') log?.warn?.(`kiro: ${event.message}`)
          while (builder.chunks.length > yielded) yield builder.chunks[yielded++]
        }
        if (!streamError) {
          if (!sawTerminal) builder.finish({ kind: 'stop' })
          while (builder.chunks.length > yielded) yield builder.chunks[yielded++]
          return
        }
      } catch (error) {
        streamError = { message: error?.message, code: error?.code, status: error?.status, stopDisposition: null }
        lastError = asKiroError(error)
      }

      // A mid-stream failure with nothing emitted may be another account's
      // problem to solve; anything else must be reported, not retried.
      const switchable = yielded === 0 && isAccountSwitchable(streamError, lastError)
      if (streamError) {
        lastError = lastError || new KiroError(streamError.message || 'Kiro stream failed', streamError.code || ERROR_CODES.upstream)
        await deps.store.noteFailure?.(candidate.id, lastError).catch(() => {})
        if (switchable) {
          log?.warn?.(`kiro: account ${candidate.label || candidate.id} failed (${lastError.code}); trying the next one`)
          lastError = null
          continue
        }
        while (builder.chunks.length > yielded) yield builder.chunks[yielded++]
        yield { type: 'finish', reason: { kind: 'error', failure: lastError.toFailure() } }
        return
      }
      if (lastError) lastError = null
    }

    if (lastError) throw lastError
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'no Kiro account could serve this request', code: ERROR_CODES.upstream } } }
  }

  return { streamTurn, models, resolve, ChunkBuilder }
}

/** Whether a failed attempt can be handed to the next account. */
function isAccountSwitchable(streamError, lastError) {
  const code = lastError?.code || streamError?.code
  if (streamError?.stopDisposition === 'retryable_protocol_failure') return true
  return [ERROR_CODES.auth, ERROR_CODES.refreshExpired, ERROR_CODES.rateLimit, ERROR_CODES.quota, ERROR_CODES.endpoint].includes(code)
}

/** Timeout settings in the shape the transport expects; absent keys keep defaults. */
function timeoutOptions(settings) {
  const timeouts = {}
  if (Number.isFinite(settings.connectTimeoutMs)) timeouts.connectMs = settings.connectTimeoutMs
  if (Number.isFinite(settings.firstChunkTimeoutMs)) timeouts.firstChunkMs = settings.firstChunkTimeoutMs
  if (Number.isFinite(settings.streamIdleTimeoutMs)) timeouts.idleMs = settings.streamIdleTimeoutMs
  return Object.keys(timeouts).length > 0 ? { timeouts } : {}
}

/** Rotate one account's token and persist it through the store's lock. */
async function rotateToken(deps, account, log) {
  try {
    const patch = await refreshKiroToken({ account, log, ...(deps.fetch ? { fetch: deps.fetch } : {}) })
    if (!patch?.accessToken) return false
    await deps.store.patch(account.id, patch)
    return true
  } catch (error) {
    log?.warn?.(`kiro: token rotation failed: ${error?.message || error}`)
    if (error instanceof KiroError && error.code === ERROR_CODES.refreshExpired) throw error
    return false
  }
}

/** Finish-reason mapping between the reducer and the harness vocabulary. */
function mapFinish(reason) {
  if (reason === 'max-tokens') return 'max-tokens'
  if (reason === 'tool-calls') return 'tool-calls'
  return 'stop'
}

/**
 * Kiro ties a conversation to an id. Reusing the harness session id keeps one
 * Kiro conversation per Harness session, which is what makes context usage and
 * metering numbers line up with the IDE's own view.
 */
export function conversationIdFor(options, account) {
  const seed = options.sessionId || options.conversationId || account?.id || 'kiro'
  return `dsh-${String(seed).replace(/[^a-zA-Z0-9_-]/gu, '').slice(0, 64)}`
}

/** The credential view the transport needs, with model- and settings-level overrides. */
export function credentialsFor(account, model, settings) {
  return {
    ...account,
    agentMode: model?.agentMode || settings.agentMode || account.agentMode || 'vibe',
    ...(settings.surfaces ? { surfaces: settings.surfaces } : {}),
    ...(model?.surfaces ? { surfaces: model.surfaces } : {}),
    ...(settings.extraHeaders ? { extraHeaders: settings.extraHeaders } : {}),
  }
}

/** Token usage in the harness shape: disjoint counts, no cached input folded in. */
export function toHarnessUsage(usage) {
  if (!usage) return undefined
  const next = {}
  if (Number.isFinite(usage.inputTokens)) next.inputTokens = usage.inputTokens
  if (Number.isFinite(usage.outputTokens)) next.outputTokens = usage.outputTokens
  if (Number.isFinite(usage.totalTokens)) next.totalTokens = usage.totalTokens
  if (Number.isFinite(usage.cacheReadTokens)) next.cacheReadTokens = usage.cacheReadTokens
  if (Number.isFinite(usage.cacheWriteTokens)) next.cacheWriteTokens = usage.cacheWriteTokens
  return Object.keys(next).length > 0 ? next : undefined
}

function scopedLogger(log, modelId) {
  if (!log) return undefined
  const prefix = `kiro[${modelId}]`
  return {
    info: message => log.info?.(`${prefix}: ${message}`),
    warn: message => log.warn?.(`${prefix}: ${message}`),
    error: message => log.error?.(`${prefix}: ${message}`),
    debug: message => log.debug?.(`${prefix}: ${message}`),
  }
}
