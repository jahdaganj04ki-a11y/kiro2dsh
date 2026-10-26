/**
 * Harness chunk stream → OpenAI and Anthropic wire formats.
 *
 * Both renderers consume the *same* chunk stream the desktop adapter consumes,
 * rather than re-running the turn with different settings. That keeps the
 * answer a user sees in DSH Desktop and the answer another agent gets over
 * `/v1/chat/completions` byte-identical, which is the point of offering the
 * bridge at all: the same model, the same rules, two doors.
 *
 * @module lib/bridge/render.js
 */

const SSE_HEADERS = Object.freeze({
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
})

/** SSE headers for both formats. */
export { SSE_HEADERS }

const encoder = new TextEncoder()

/** One `data:` frame. */
export function sse(event, data) {
  const payload = data === undefined ? '' : `data: ${JSON.stringify(data)}\n`
  return encoder.encode(`${event ? `event: ${event}\n` : ''}${payload}\n`)
}

function openaiChunk(model, id, created, delta, finishReason, usage) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, ...(finishReason ? { finish_reason: finishReason } : {}) }],
    ...(usage ? { usage } : {}),
  }
}

function openaiUsage(usage) {
  if (!usage) return undefined
  const input = Number(usage.inputTokens) || 0
  const output = Number(usage.outputTokens) || 0
  const cacheRead = Number(usage.cacheReadTokens) || 0
  // Kiro reports cache reads as a separate bucket (Anthropic semantics), so they are
  // added to the prompt here; and `total_tokens` is defined by this format as
  // prompt + completion, which is not the same number Kiro totals.
  return {
    prompt_tokens: input + cacheRead,
    completion_tokens: output,
    total_tokens: input + cacheRead + output,
    ...(cacheRead ? { prompt_tokens_details: { cached_tokens: cacheRead } } : {}),
    ...(usage.kiroCredits !== undefined ? { kiro: { credits: usage.kiroCredits, unit: usage.kiroCreditUnit || 'credit' } } : {}),
  }
}

/** Map one harness finish reason onto the OpenAI `finish_reason` string. */
export function openaiFinishReason(reason) {
  const kind = typeof reason === 'string' ? reason : reason?.kind
  if (kind === 'tool-calls') return 'tool_calls'
  if (kind === 'max-tokens') return 'length'
  if (kind === 'aborted') return 'stop'
  if (kind === 'error') return 'stop'
  return 'stop'
}

/**
 * Stream an OpenAI chat-completion answer.
 * @param {AsyncIterable<object>} chunks harness stream chunks
 * @param {{ model: string, id?: string, includeUsage?: boolean }} options
 * @returns {AsyncGenerator<Uint8Array>} SSE frames
 */
export async function* openaiSSE(chunks, options) {
  const id = options.id || `chatcmpl-${Date.now()}`
  const created = Math.floor(Date.now() / 1000)
  let roleSent = false
  let lastUsage = null
  let terminalSent = false
  yield sse(null, openaiChunk(options.model, id, created, { role: 'assistant', content: '' }, null))
  roleSent = true
  for await (const chunk of chunks) {
    if (chunk.type === 'text-delta') {
      yield sse(null, openaiChunk(options.model, id, created, { content: chunk.text }, null))
    } else if (chunk.type === 'reasoning-delta') {
      // DeepSeek/Reasoner-style clients read `reasoning_content`; the alternative
      // is dropping thinking output entirely.
      yield sse(null, openaiChunk(options.model, id, created, { reasoning_content: chunk.text }, null))
    } else if (chunk.type === 'tool-call-delta' && chunk.name) {
      yield sse(null, openaiChunk(options.model, id, created, {
        tool_calls: [{ index: 0, id: chunk.id, type: 'function', function: { name: chunk.name, arguments: chunk.argumentsDelta || '' } }],
      }, null))
    } else if (chunk.type === 'tool-call-delta') {
      yield sse(null, openaiChunk(options.model, id, created, {
        tool_calls: [{ index: 0, function: { arguments: chunk.argumentsDelta || '' } }],
      }, null))
    } else if (chunk.type === 'usage') {
      lastUsage = chunk.usage
    } else if (chunk.type === 'finish') {
      terminalSent = true
      const failure = chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted' ? chunk.reason.failure : undefined
      if (failure) {
        yield sse(null, { error: { message: failure.message, type: 'upstream_error', code: failure.code, ...(failure.status ? { status: failure.status } : {}) } })
      }
      if (options.includeUsage !== false && lastUsage) {
        yield sse(null, openaiChunk(options.model, id, created, {}, openaiFinishReason(chunk.reason), openaiUsage(lastUsage)))
      } else {
        yield sse(null, openaiChunk(options.model, id, created, {}, openaiFinishReason(chunk.reason)))
      }
    }
    void roleSent
  }
  if (!terminalSent) yield sse(null, openaiChunk(options.model, id, created, {}, 'stop', lastUsage && options.includeUsage !== false ? openaiUsage(lastUsage) : undefined))
  yield encoder.encode('data: [DONE]\n\n')
}

/** Aggregate a chunk stream into one `chat.completion` JSON answer. */
export async function openaiJSON(chunks, options) {
  const id = options.id || `chatcmpl-${Date.now()}`
  const created = Math.floor(Date.now() / 1000)
  const message = { role: 'assistant', content: '' }
  const toolCalls = []
  let usage = null
  let finishReason = 'stop'
  let failure = null
  for await (const chunk of chunks) {
    if (chunk.type === 'text-delta') message.content += chunk.text
    else if (chunk.type === 'reasoning-delta') message.reasoning_content = (message.reasoning_content || '') + chunk.text
    else if (chunk.type === 'tool-call-delta') {
      const index = 0
      let call = toolCalls.find(candidate => candidate.id === chunk.id)
      if (chunk.name && !call) {
        call = { index, id: chunk.id, type: 'function', function: { name: chunk.name, arguments: '' } }
        toolCalls.push(call)
      }
      call ||= toolCalls[toolCalls.length - 1]
      if (call) call.function.arguments += chunk.argumentsDelta || ''
    } else if (chunk.type === 'usage') usage = chunk.usage
    else if (chunk.type === 'finish') {
      finishReason = openaiFinishReason(chunk.reason)
      if (chunk.reason?.failure) failure = chunk.reason.failure
    }
  }
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls.map((call, index) => ({ ...call, index }))
    if (!message.content) message.content = null
    if (finishReason === 'stop') finishReason = 'tool_calls'
  }
  if (failure) {
    return { status: 502, body: { error: { message: failure.message, type: 'upstream_error', code: failure.code, ...(failure.status ? { status: failure.status } : {}) } } }
  }
  const prompt = usage ? openaiUsage(usage) : undefined
  return {
    status: 200,
    body: {
      id,
      object: 'chat.completion',
      created,
      model: options.model,
      choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
      ...(prompt ? { usage: prompt } : {}),
    },
  }
}

/** Anthropic event names for one harness finish reason. */
export function anthropicStopReason(reason) {
  const kind = typeof reason === 'string' ? reason : reason?.kind
  if (kind === 'tool-calls') return 'tool_use'
  if (kind === 'max-tokens') return 'max_tokens'
  if (kind === 'error') return 'refusal'
  return 'end_turn'
}

/**
 * Stream an Anthropic `messages` answer (`message_start`, content blocks, deltas).
 * @param {AsyncIterable<object>} chunks
 * @param {{ model: string, id?: string }} options
 */
export async function* anthropicSSE(chunks, options) {
  const id = options.id || `msg_${Date.now().toString(36)}`
  let messageStarted = false
  const blocks = new Map()
  let nextIndex = 0
  let usage = { input_tokens: 0, output_tokens: 0 }
  let lastStop = 'end_turn'

  const start = type => {
    const index = nextIndex++
    blocks.set(index, { type, id: type === 'tool_use' ? undefined : undefined })
    return index
  }

  for await (const chunk of chunks) {
    if (!messageStarted) {
      messageStarted = true
      yield sse('message_start', {
        type: 'message_start',
        message: { id, type: 'message', role: 'assistant', model: options.model, content: [], stop_reason: null, stop_sequence: null, usage },
      })
    }
    if (chunk.type === 'block-start') {
      const kind = chunk.blockType === 'reasoning' ? 'thinking' : chunk.blockType === 'tool-call' ? 'tool_use' : 'text'
      // `started` has to be set here: a later delta for the same index must not open
      // the block a second time, which a strict SDK reads as two blocks at one index.
      const block = { kind, started: kind !== 'tool_use' }
      blocks.set(chunk.index, block)
      if (kind === 'thinking') {
        yield sse('content_block_start', { type: 'content_block_start', index: chunk.index, content_block: { type: 'thinking', thinking: '' } })
      } else if (kind === 'tool_use') {
        blocks.get(chunk.index).id = chunk.id || undefined
      } else {
        yield sse('content_block_start', { type: 'content_block_start', index: chunk.index, content_block: { type: 'text', text: '' } })
      }
      continue
    }
    if (chunk.type === 'text-delta') {
      const block = blocks.get(chunk.index)
      if (block && !block.started) {
        block.started = true
        yield sse('content_block_start', { type: 'content_block_start', index: chunk.index, content_block: { type: 'text', text: '' } })
      }
      yield sse('content_block_delta', { type: 'content_block_delta', index: chunk.index, delta: { type: 'text_delta', text: chunk.text } })
      continue
    }
    if (chunk.type === 'reasoning-delta') {
      const block = blocks.get(chunk.index)
      if (block && !block.started) {
        block.started = true
        yield sse('content_block_start', { type: 'content_block_start', index: chunk.index, content_block: { type: 'thinking', thinking: '' } })
      }
      yield sse('content_block_delta', { type: 'content_block_delta', index: chunk.index, delta: { type: 'thinking_delta', thinking: chunk.text } })
      continue
    }
    if (chunk.type === 'block-end') {
      if (chunk.block?.type === 'reasoning') yield sse('content_block_stop', { type: 'content_block_stop', index: chunk.index })
      else if (chunk.block?.type === 'text') yield sse('content_block_stop', { type: 'content_block_stop', index: chunk.index })
      continue
    }
    if (chunk.type === 'tool-call-delta' && chunk.name) {
      const index = start('tool_use')
      blocks.set(index, { kind: 'tool_use', started: true, id: chunk.id, name: chunk.name })
      yield sse('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: chunk.id, name: chunk.name, input: {} },
      })
      if (chunk.argumentsDelta) {
        yield sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: chunk.argumentsDelta } })
      }
      continue
    }
    if (chunk.type === 'tool-call-delta') {
      // A continuation frame without a name: reuse the open tool block.
      const open = [...blocks.entries()].reverse().find(([, block]) => block.kind === 'tool_use' && block.started)
      if (open) {
        yield sse('content_block_delta', { type: 'content_block_delta', index: open[0], delta: { type: 'input_json_delta', partial_json: chunk.argumentsDelta || '' } })
      }
      continue
    }
    if (chunk.type === 'usage') {
      usage = {
        input_tokens: Number(chunk.usage?.inputTokens) || 0,
        output_tokens: Number(chunk.usage?.outputTokens) || 0,
        ...(Number(chunk.usage?.cacheReadTokens) ? { cache_read_input_tokens: chunk.usage.cacheReadTokens } : {}),
      }
      continue
    }
    if (chunk.type === 'finish') {
      lastStop = anthropicStopReason(chunk.reason)
      for (const [index, block] of blocks) {
        if (block.kind === 'tool_use' && block.started) yield sse('content_block_stop', { type: 'content_block_stop', index })
      }
      if (chunk.reason?.failure) {
        yield sse('error', { type: 'error', error: { type: 'upstream_error', message: chunk.reason.failure.message } })
      }
      // Clients bill from this frame, so it carries the input counts as well.
      yield sse('message_delta', { type: 'message_delta', delta: { stop_reason: lastStop, stop_sequence: null }, usage })
      yield sse('message_stop', { type: 'message_stop' })
    }
  }
  if (!messageStarted) {
    yield sse('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: options.model, content: [], stop_reason: null, stop_sequence: null, usage } })
    yield sse('message_delta', { type: 'message_delta', delta: { stop_reason: lastStop, stop_sequence: null }, usage: { output_tokens: 0 } })
    yield sse('message_stop', { type: 'message_stop' })
  }
}

/** Aggregate a chunk stream into one Anthropic `message` JSON answer. */
export async function anthropicJSON(chunks, options) {
  const id = options.id || `msg_${Date.now().toString(36)}`
  const content = []
  let usage = { input_tokens: 0, output_tokens: 0 }
  let stopReason = 'end_turn'
  let failure = null
  const openTool = () => content.find(block => block.type === 'tool_use' && !block.__closed)
  for await (const chunk of chunks) {
    if (chunk.type === 'text-delta') {
      const last = content[content.length - 1]
      if (last?.type === 'text') last.text += chunk.text
      else content.push({ type: 'text', text: chunk.text })
    } else if (chunk.type === 'reasoning-delta') {
      const last = content[content.length - 1]
      if (last?.type === 'thinking') last.thinking += chunk.text
      else content.push({ type: 'thinking', thinking: chunk.text, signature: '' })
    } else if (chunk.type === 'tool-call-delta' && chunk.name) {
      for (const block of content) if (block.type === 'tool_use') block.__closed = true
      content.push({ type: 'tool_use', id: chunk.id, name: chunk.name, input: chunk.argumentsDelta || '{}', __closed: false })
    } else if (chunk.type === 'tool-call-delta') {
      const block = openTool()
      if (block) block.input += chunk.argumentsDelta || ''
    } else if (chunk.type === 'usage') {
      usage = {
        input_tokens: Number(chunk.usage?.inputTokens) || 0,
        output_tokens: Number(chunk.usage?.outputTokens) || 0,
        ...(Number(chunk.usage?.cacheReadTokens) ? { cache_read_input_tokens: chunk.usage.cacheReadTokens } : {}),
      }
    } else if (chunk.type === 'finish') {
      stopReason = anthropicStopReason(chunk.reason)
      if (chunk.reason?.failure) failure = chunk.reason.failure
    }
  }
  const blocks = content.map(({ __closed, ...block }) => {
    if (block.type !== 'tool_use') return block
    let input = block.input
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input)
      } catch {
        // Kiro can stream an argument payload that never completes; an empty
        // object keeps the message valid for the client's own repair path.
        input = {}
      }
    }
    return { ...block, input: input || {} }
  })
  if (failure) {
    return { status: 502, body: { type: 'error', error: { type: 'upstream_error', message: failure.message } } }
  }
  return {
    status: 200,
    body: { id, type: 'message', role: 'assistant', model: options.model, content: blocks, stop_reason: stopReason, stop_sequence: null, usage },
  }
}
