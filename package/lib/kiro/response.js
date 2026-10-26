/**
 * Kiro EventStream frames → provider-neutral turn events.
 *
 * One reducer serves both consumers (the harness adapter and the HTTP bridge),
 * so a stream quirk can only be fixed once:
 *
 * - `toolUseEvent` arrives FRAGMENTED: the first frame carries `name` and
 *   `toolUseId`, later frames append `input` either as JSON string pieces or as
 *   whole objects. Both shapes appear in the wild, and merging a partial object
 *   would produce invalid tool arguments, so inputs are buffered until the
 *   stream ends and validated once.
 * - `assistantResponseEvent.content` may embed inline think tags that the
 *   stream does not announce with a separate event. Text inside them is
 *   reasoning, not answer, and leaking it would put chain-of-thought into the
 *   durable session log, so the tags are tracked across frames.
 * - terminal state is reported by `messageStopEvent` or by `metadataEvent`, and
 *   sometimes by neither. Missing terminal state is treated as an incomplete
 *   turn rather than as a successful stop.
 * - token accounting is optional and split across `metricsEvent`,
 *   `meteringEvent` and `contextUsageEvent`; a derived estimate is offered only
 *   when the upstream gave the credit and context signals but no token counts.
 *
 * @module lib/kiro/response
 */

const OPEN_TAG = ['<', 'thinking', '>'].join('')
const CLOSE_TAG = ['<', '/thinking', '>'].join('')

/** Kiro event types the reducer knows; anything else is counted and ignored. */
export const KNOWN_EVENTS = Object.freeze([
  'assistantResponseEvent',
  'reasoningContentEvent',
  'codeEvent',
  'toolUseEvent',
  'messageStopEvent',
  'metadataEvent',
  'MetadataEvent',
  'contextUsageEvent',
  'meteringEvent',
  'metricsEvent',
])

/**
 * Length of the tail of `text` that could still grow into `tag`.
 * @param {string} text
 * @param {string} tag
 * @returns {number}
 */
function partialTagLength(text, tag) {
  const limit = Math.min(text.length, tag.length - 1)
  for (let length = limit; length > 0; length--) {
    if (text.endsWith(tag.slice(0, length))) return length
  }
  return 0
}

/** Normalize the many spellings of a Kiro stop reason into one vocabulary. */
export function normalizeStopReason(value) {
  const reason = String(value || '').trim()
    .replace(/([a-z])([A-Z])/gu, '$1_$2')
    .toLowerCase()
    .replace(/[\s-]+/gu, '_')
  if (['endturn', 'end_turn', 'stop', 'stop_sequence'].includes(reason)) return 'end_turn'
  if (['tooluse', 'tool_use', 'tool_calls'].includes(reason)) return 'tool_use'
  if (['maxtokens', 'max_tokens', 'max_output_tokens', 'length'].includes(reason)) return 'max_tokens'
  return reason || null
}

/**
 * Classify a stop reason.
 * @param {string | null} stopReason
 * @param {boolean} hasToolCalls
 * @returns {'complete'|'tool_use'|'length'|'retryable_protocol_failure'|'terminal_incomplete'|'terminal_refusal'|'unknown_failure'}
 */
export function stopDisposition(stopReason, hasToolCalls) {
  if (['malformed_model_output', 'invalid_model_output'].includes(stopReason)) return 'retryable_protocol_failure'
  if (['cancelled', 'pause_turn', 'model_context_window_exceeded'].includes(stopReason)) return 'terminal_incomplete'
  if (stopReason === 'refusal' || /(?:content.*filter|guardrail|safety|policy|blocked)/u.test(stopReason || '')) {
    return 'terminal_refusal'
  }
  if (stopReason === 'max_tokens') return hasToolCalls ? 'terminal_incomplete' : 'length'
  if (stopReason && !['end_turn', 'tool_use'].includes(stopReason)) return 'unknown_failure'
  if (hasToolCalls || stopReason === 'tool_use') return 'tool_use'
  if (!stopReason || stopReason === 'end_turn') return 'complete'
  return 'unknown_failure'
}

/** Keep the more severe of two stop reasons: one frame must not mask a refusal. */
export function mergeStopReason(current, incoming) {
  if (!incoming) return current
  if (!current) return incoming
  const severity = reason => {
    const disposition = stopDisposition(reason, false)
    if (disposition === 'terminal_refusal') return 6
    if (disposition === 'terminal_incomplete') return 5
    if (disposition === 'unknown_failure') return 4
    if (disposition === 'retryable_protocol_failure') return 3
    if (disposition === 'length') return 2
    return 1
  }
  return severity(incoming) > severity(current) ? incoming : current
}

/** Reasons that mean "usable as far as it got, then the budget ran out". */
const TRUNCATION_REASONS = new Set(['model_context_window_exceeded', 'max_tokens'])

/**
 * Reducer over Kiro EventStream frames.
 *
 * `push(frame)` returns the events the frame produced; `finish()` closes the
 * turn with the terminal event. Tool calls are emitted only at `finish()`,
 * because their arguments can still be arriving.
 */
export class KiroTurnReducer {
  /**
   * @param {{ maxToolBytes?: number, model?: string, contextWindow?: number }} [options]
   */
  constructor(options = {}) {
    this.options = options
    this.maxToolBytes = options.maxToolBytes ?? 4 * 1024 * 1024
    this.reset()
  }

  reset() {
    this.state = {
      text: '',
      reasoning: '',
      toolBytes: 0,
      eventCounts: {},
      inThinking: false,
      // A tag can straddle two events, so an ambiguous tail of the answer channel
      // waits here until the next fragment proves it was not a tag.
      thinkingBuffer: '',
      stopReason: null,
      explicitStop: false,
      sawToolUse: false,
      terminalProvenance: null,
      usage: null,
      contextUsagePercentage: null,
      hasMetering: false,
      toolValidationError: null,
    }
    this.tools = new Map()
    this.toolOrder = []
    this.finished = false
  }

  /** Consume one decoded frame and return the events it produced. */
  push(frame) {
    const events = []
    const headers = frame?.headers || {}
    const messageType = headers[':message-type']
    if (messageType === 'error' || messageType === 'exception') {
      this.finished = true
      this.state.terminalProvenance = 'upstream_eventstream_error'
      events.push({
        type: 'error',
        message: frame?.payload?.message || `Kiro upstream sent an EventStream ${messageType}`,
        code: frame?.payload?.__type || frame?.payload?.reason || 'UPSTREAM_ERROR',
        transportState: 'upstream_error',
      })
      return events
    }

    const eventType = headers[':event-type'] || ''
    const countKey = KNOWN_EVENTS.includes(eventType) ? eventType : 'other'
    this.state.eventCounts[countKey] = (this.state.eventCounts[countKey] || 0) + 1
    const payload = frame?.payload || {}

    if (eventType === 'assistantResponseEvent') {
      const { text, reasoning } = this.#splitThinking(typeof payload.content === 'string' ? payload.content : '')
      // Reasoning is emitted first: the tag opens before the answer does, and the
      // chunk builder requires a block to close before the next one opens.
      if (reasoning) {
        this.state.reasoning += reasoning
        events.push({ type: 'reasoning', text: reasoning })
      }
      if (text) {
        this.state.text += text
        events.push({ type: 'text', text })
      }
      return events
    }
    if (eventType === 'codeEvent' && typeof payload.content === 'string') {
      // Kiro streams code as its own event type; it is answer text.
      this.state.text += payload.content
      events.push({ type: 'text', text: payload.content })
      return events
    }
    if (eventType === 'reasoningContentEvent') {
      const value = payload.reasoningContentEvent || payload
      const content = typeof value === 'string'
        ? value
        : value?.text || value?.content || value?.reasoningContent || ''
      if (content) {
        this.state.reasoning += content
        events.push({ type: 'reasoning', text: content })
      }
      return events
    }
    if (eventType === 'toolUseEvent') {
      this.state.sawToolUse = true
      const fragments = Array.isArray(payload) ? payload : [payload]
      for (const fragment of fragments) {
        const failure = this.#accumulateTool(fragment)
        if (failure) events.push(failure)
      }
      return events
    }
    if (eventType === 'messageStopEvent') {
      this.state.explicitStop = true
      const reason = normalizeStopReason(payload.stopReason ?? payload.stop_reason)
        || (this.state.sawToolUse ? 'tool_use' : 'end_turn')
      this.#mergeStop(reason, 'message_stop_event')
      return events
    }
    if (eventType === 'metadataEvent' || eventType === 'MetadataEvent') {
      const metadata = payload.metadataEvent || payload.metadata || payload
      const reason = normalizeStopReason(metadata?.stopReason ?? metadata?.stop_reason)
      if (reason) {
        this.state.explicitStop = true
        this.#mergeStop(reason, 'metadata_stop_reason')
      }
      return events
    }
    if (eventType === 'contextUsageEvent') {
      const percentage = Number(payload.contextUsagePercentage)
      if (Number.isFinite(percentage)) this.state.contextUsagePercentage = percentage
      return events
    }
    if (eventType === 'meteringEvent') {
      const metering = payload.meteringEvent || payload
      const credits = Number(metering.usage)
      this.state.hasMetering = true
      if (Number.isFinite(credits)) {
        this.state.usage = {
          ...(this.state.usage || {}),
          kiroCredits: credits,
          kiroCreditUnit: typeof metering.unit === 'string' ? metering.unit : 'credit',
        }
      }
      return events
    }
    if (eventType === 'metricsEvent') {
      const metrics = payload.metricsEvent || payload
      const input = Number(metrics.inputTokens) || 0
      const output = Number(metrics.outputTokens) || 0
      if (input || output) {
        const cacheRead = Number(metrics.cacheReadInputTokens || metrics.cache_read_input_tokens) || 0
        const cacheWrite = Number(metrics.cacheCreationInputTokens || metrics.cache_creation_input_tokens) || 0
        this.state.usage = {
          ...(this.state.usage || {}),
          inputTokens: input,
          outputTokens: output,
          ...(cacheRead ? { cacheReadTokens: cacheRead } : {}),
          ...(cacheWrite ? { cacheWriteTokens: cacheWrite } : {}),
          totalTokens: input + output,
        }
      }
      return events
    }
    return events
  }

  #mergeStop(reason, provenance) {
    const merged = mergeStopReason(this.state.stopReason, reason)
    if (merged !== this.state.stopReason) {
      this.state.stopReason = merged
      this.state.terminalProvenance = provenance
    }
  }

  /**
   * Inline think tags span frames, so the open/close search is stateful.
   * Unclosed content stays out of the answer text until the tag closes.
   */
  /**
   * Split one streamed fragment into answer text and thinking text.
   *
   * A tag-bearing model writes its reasoning into the answer channel between think
   * tags, because the prompt tag asks for exactly that. Both halves matter: the tags
   * must never reach the user's answer, and the thinking must not be dropped, since
   * the harness renders it as a foldable reasoning block and other agents read it as
   * `reasoning_content`. Tags can straddle two events, so a fragment that ends
   * inside a possible tag keeps its ambiguous tail until the next one arrives.
   *
   * @param {string} raw
   * @returns {{ text: string, reasoning: string }}
   */
  #splitThinking(raw) {
    const buffer = this.state.thinkingBuffer + raw
    this.state.thinkingBuffer = ''
    let text = ''
    let reasoning = ''
    let inThinking = this.state.inThinking
    let index = 0
    while (index < buffer.length) {
      const tag = inThinking ? CLOSE_TAG : OPEN_TAG
      const found = buffer.indexOf(tag, index)
      if (found < 0) {
        const held = partialTagLength(buffer.slice(index), tag)
        const visible = buffer.slice(index, buffer.length - held)
        if (inThinking) reasoning += visible
        else text += visible
        this.state.thinkingBuffer = buffer.slice(buffer.length - held)
        break
      }
      const visible = buffer.slice(index, found)
      if (inThinking) reasoning += visible
      else text += visible
      index = found + tag.length
      inThinking = !inThinking
    }
    this.state.inThinking = inThinking
    return { text, reasoning }
  }

  /** Close whatever the model left open, so a missing tag cannot hide output. */
  #flushThinking() {
    const pending = this.state.thinkingBuffer
    this.state.thinkingBuffer = ''
    if (!pending) return { text: '', reasoning: '' }
    // An unterminated block is still thinking; a tag that never opened is text.
    return this.state.inThinking ? { text: '', reasoning: pending } : { text: pending, reasoning: '' }
  }


  #accumulateTool(fragment) {
    const name = typeof fragment?.name === 'string' ? fragment.name.trim() : ''
    let id
    if (fragment?.toolUseId == null) {
      // Some surfaces omit the id on continuation fragments; keep buffering
      // under the last seen id so arguments are not lost.
      id = this.toolOrder[this.toolOrder.length - 1] || `call_${Date.now()}_${this.tools.size + 1}`
    } else if (typeof fragment.toolUseId !== 'string' || !fragment.toolUseId.trim()) {
      return { type: 'diagnostic', level: 'warn', message: 'Kiro toolUseEvent has an invalid toolUseId' }
    } else {
      id = fragment.toolUseId
    }
    let tool = this.tools.get(id)
    if (!tool) {
      if (!name) return { type: 'diagnostic', level: 'warn', message: 'Kiro toolUseEvent is missing a tool name' }
      tool = { id, name, inputKind: null, inputChunks: [], inputObject: null, inputBytes: 0 }
      this.tools.set(id, tool)
      this.toolOrder.push(id)
    } else if (name && tool.name !== name) {
      this.state.toolValidationError ||= 'Kiro tool name changed between fragments'
      return null
    }
    const input = fragment?.input
    if (input === undefined) return null
    if (typeof input === 'string') {
      if (tool.inputKind && tool.inputKind !== 'string') {
        this.state.toolValidationError ||= 'Kiro tool input changed fragment type'
        return null
      }
      tool.inputKind = 'string'
      tool.inputChunks.push(input)
      this.state.toolBytes += Buffer.byteLength(input)
    } else if (input && typeof input === 'object' && !Array.isArray(input)) {
      if (tool.inputKind && tool.inputKind !== 'object') {
        this.state.toolValidationError ||= 'Kiro tool input changed fragment type'
        return null
      }
      tool.inputKind = 'object'
      this.state.toolBytes -= tool.inputBytes || 0
      tool.inputObject = input
      tool.inputBytes = Buffer.byteLength(JSON.stringify(input))
      this.state.toolBytes += tool.inputBytes
    } else {
      this.state.toolValidationError ||= 'Kiro tool input must be a JSON object'
      return null
    }
    if (this.state.toolBytes > this.maxToolBytes) {
      this.state.terminalProvenance = 'integrity_buffer_exceeded'
      return { type: 'error', message: 'Kiro buffered tool input exceeded the memory bound', code: 'KIRO_BUFFER_EXCEEDED', transportState: 'buffer_exceeded' }
    }
    return null
  }

  /** Parse one buffered tool argument payload. */
  #parsedInput(tool) {
    if (!tool.inputKind) throw new Error('Kiro tool call is missing input')
    if (tool.inputKind === 'object') return tool.inputObject
    const parsed = JSON.parse(tool.inputChunks.join(''))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed
  }

  /**
   * Close the turn: emit buffered tool calls and the terminal event.
   * @returns {object[]} terminal events
   */
  finish() {
    if (this.finished) return []
    const flushed = this.#flushThinking()
    const events = []
    if (flushed.reasoning) {
      this.state.reasoning += flushed.reasoning
      events.push({ type: 'reasoning', text: flushed.reasoning })
    }
    if (flushed.text) {
      this.state.text += flushed.text
      events.push({ type: 'text', text: flushed.text })
    }
    this.finished = true
    const kept = []
    for (const id of this.toolOrder) {
      const tool = this.tools.get(id)
      // One unusable fragment must not discard the other complete calls in the
      // same turn: the client would see a turn that answered nothing.
      try {
        const input = this.#parsedInput(tool)
        kept.push({ id, name: tool.name, arguments: JSON.stringify(input) })
      } catch (error) {
        this.state.toolValidationError ||= error.message
      }
    }
    for (const call of kept) events.push({ type: 'tool-call', ...call })
    this.state.hasToolCalls = kept.length > 0

    if (kept.length === 0 && this.state.stopReason === 'tool_use'
      && !this.state.text && !this.state.reasoning) {
      if (this.state.toolValidationError) {
        return [{
          type: 'error',
          message: this.state.toolValidationError,
          code: 'INVALID_KIRO_TOOL_CALL',
          transportState: 'invalid_tool_call',
          stopDisposition: 'retryable_protocol_failure',
        }]
      }
      return [{
        type: 'error',
        message: 'Kiro tool_use stop reason did not include a complete tool call',
        code: 'INVALID_KIRO_TOOL_CALL',
        transportState: 'invalid_tool_call',
        stopDisposition: 'retryable_protocol_failure',
      }]
    }

    const hasOutput = Boolean(this.state.text || this.state.reasoning || kept.length > 0)
    if (!hasOutput && this.state.sawToolUse) {
      // The model reached for a tool and its arguments never completed. Retrying
      // once with the repair instruction is what recovers this inside Kiro's own
      // agent loop, so it is worth a retry here too.
      return [{
        type: 'error',
        message: 'Kiro ended with an incomplete tool call',
        code: 'INVALID_KIRO_TOOL_CALL',
        transportState: 'truncated_tool_call',
        stopDisposition: 'retryable_protocol_failure',
      }]
    }
    if (!hasOutput) {
      // An assistant turn with no content at all is not a successful answer: the
      // loop would persist an empty message and repeat the same request forever.
      // A clean `end_turn` that carried nothing is treated as a protocol slip, so
      // the transport can retry once with a repair instruction before failing.
      return [{
        type: 'error',
        message: 'Kiro EventStream ended without model output',
        code: 'EMPTY_RESPONSE',
        transportState: 'empty_eof',
        stopDisposition: this.state.explicitStop ? 'retryable_protocol_failure' : 'terminal_incomplete',
      }]
    }

    const disposition = stopDisposition(this.state.stopReason, kept.length > 0)
    const truncatedAfterOutput = disposition === 'terminal_incomplete'
      && TRUNCATION_REASONS.has(this.state.stopReason)
      && (Boolean(this.state.text) || Boolean(this.state.reasoning) || kept.length > 0)
    if (!truncatedAfterOutput
      && ['retryable_protocol_failure', 'terminal_incomplete', 'terminal_refusal', 'unknown_failure'].includes(disposition)) {
      return [{
        type: 'error',
        message: `Kiro ended with non-success stop reason: ${this.state.stopReason}`,
        code: 'KIRO_TERMINAL_STOP',
        transportState: 'clean_eof',
        stopReason: this.state.stopReason,
        stopDisposition: disposition,
        provenance: this.state.terminalProvenance || 'metadata_stop_reason',
      }]
    }

    const usage = this.#usage(kept)
    if (usage) events.push({ type: 'usage', usage })
    events.push({
      type: 'finish',
      reason: truncatedAfterOutput || disposition === 'length'
        ? 'max-tokens'
        : kept.length > 0
          ? 'tool-calls'
          : 'stop',
      stopReason: this.state.stopReason,
      truncated: truncatedAfterOutput,
      diagnostics: this.diagnostics({ stopDisposition: truncatedAfterOutput ? 'length' : disposition }),
    })
    return events
  }

  #usage(kept) {
    const usage = this.state.usage ? { ...this.state.usage } : null
    if (usage?.kiroCredits !== undefined) {
      // Credit accounting is not token accounting; keep it beside the counts.
      delete usage.kiroCredits
      this.state.credits = this.state.usage.kiroCredits
      this.state.creditUnit = this.state.usage.kiroCreditUnit
    }
    if (!usage?.totalTokens && this.state.hasMetering && this.state.contextUsagePercentage !== null) {
      // Kiro reported credits and context pressure but no token counts: derive a
      // conservative estimate so the token meter and compaction stay honest.
      const completionSource = this.state.text.length + kept.reduce((sum, call) => sum + call.arguments.length, 0)
      const contextWindow = Number(this.options.contextWindow) || 200000
      const prompt = Math.floor((this.state.contextUsagePercentage * contextWindow) / 100)
      const completion = completionSource ? Math.max(1, Math.floor(completionSource / 4)) : 0
      return {
        ...(usage || {}),
        inputTokens: prompt,
        outputTokens: completion,
        totalTokens: prompt + completion,
        estimated: true,
        ...(this.state.credits !== undefined ? { kiroCredits: this.state.credits, kiroCreditUnit: this.state.creditUnit } : {}),
      }
    }
    if (usage && this.state.credits !== undefined) {
      usage.kiroCredits = this.state.credits
      usage.kiroCreditUnit = this.state.creditUnit
    }
    return usage
  }

  /** Structured facts for logs and the failure record; never carries content. */
  diagnostics(overrides = {}) {
    return {
      terminal_provenance: this.state.terminalProvenance || 'clean_eventstream_eof',
      transport_state: this.finished ? 'clean_eof' : 'consuming_response',
      stop_reason: this.state.stopReason,
      stop_disposition: stopDisposition(this.state.stopReason, Boolean(this.state.hasToolCalls)),
      response_state: this.state.hasToolCalls
        ? 'valid_tool'
        : this.state.text || this.state.reasoning
          ? 'text_reasoning'
          : this.state.explicitStop
            ? 'explicit_stop'
            : 'no_semantic_output',
      event_counts: { ...this.state.eventCounts },
      ...overrides,
    }
  }
}
