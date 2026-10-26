/**
 * Client wire formats → the plugin's canonical request.
 *
 * The bridge accepts OpenAI Chat Completions and Anthropic Messages because
 * those are what other agents and harnesses speak, but neither format is fed to
 * Kiro directly: both are folded into the same canonical block list the harness
 * adapter produces. That is deliberate — one conversation shape, one set of
 * Kiro rules applied to it, so a fix to the turn alternation, the tool pairing or
 * the tool-name limits cannot land for the desktop app and miss the bridge.
 *
 * Unknown fields are dropped rather than passed through: Kiro validates its
 * request body strictly, and an ignored `presence_penalty` is harmless while a
 * forwarded one would fail the whole turn.
 *
 * @module lib/bridge/formats
 */

import { KiroError, ERROR_CODES } from '../errors.js'

const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** Parse a `data:image/png;base64,…` URI. */
export function parseDataUri(url) {
  if (typeof url !== 'string') return null
  const match = /^data:([^;,]+)(?:;charset=[^;,]+)?;base64,([\s\S]+)$/iu.exec(url)
  if (!match) return null
  return { mimeType: match[1].toLowerCase(), base64: match[2] }
}

function textPart(value) {
  return typeof value === 'string' && value.length > 0 ? [{ type: 'text', text: value }] : []
}

/**
 * An image block, or null when Kiro would not accept the bytes as an image.
 *
 * Relabelling `image/bmp` as `image/png` is not a fix: the decoder reads the
 * payload, not the label, and the turn fails with an opaque decode error. An
 * attachment we cannot carry is said out loud instead.
 */
function imageBlock(mimeType, base64) {
  const mediaType = String(mimeType || '').toLowerCase()
  if (!IMAGE_MEDIA_TYPES.has(mediaType)) return null
  return { type: 'image', mediaType, data: base64 }
}

/**
 * Map a `reasoning_effort` / `thinking` request onto a canonical effort id.
 * `output_config.effort` is accepted too, so a client already shaped for Kiro
 * is not flattened to the middle of the range.
 */
export function resolveEffort(body) {
  const direct = body?.reasoning_effort
    ?? (body?.reasoning && typeof body.reasoning === 'object' ? body.reasoning.effort : undefined)
    ?? body?.output_config?.effort
    ?? body?.thinking?.level
  if (typeof direct === 'string') {
    const value = direct.toLowerCase()
    if (['none', 'off', 'disabled'].includes(value)) return 'none'
    if (['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value)) return value
  }
  if (body?.thinking && typeof body.thinking === 'object') {
    if (body.thinking.type === 'disabled') return 'none'
    const budget = Number(body.thinking.budget_tokens)
    if (Number.isFinite(budget)) {
      if (budget >= 24000) return 'xhigh'
      if (budget >= 12000) return 'high'
      if (budget >= 4000) return 'medium'
      return 'low'
    }
    return 'medium'
  }
  if (typeof body?.max_thinking_tokens === 'number') {
    return body.max_thinking_tokens >= 24000 ? 'xhigh' : body.max_thinking_tokens > 0 ? 'medium' : 'none'
  }
  return undefined
}

/** OpenAI-style content (string or parts) → canonical blocks. */
function openaiContent(content) {
  if (typeof content === 'string') return textPart(content)
  if (!Array.isArray(content)) return []
  const blocks = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    if (part.type === 'text' || typeof part.text === 'string') {
      if (part.text) blocks.push({ type: 'text', text: part.text })
      continue
    }
    if (part.type === 'image_url' || part.type === 'input_image') {
      const url = part.image_url?.url || part.url || part.image_url
      const parsed = typeof url === 'string' ? parseDataUri(url) : null
      if (parsed) {
        blocks.push(imageBlock(parsed.mimeType, parsed.base64) || { type: 'text', text: `[Unsupported attachment: ${parsed.mimeType}]` })
      } else if (typeof url === 'string' && /^https?:/iu.test(url)) {
        // Kiro takes base64 only; a remote URL is preserved as text so the model
        // can still cite it instead of the request failing on an empty turn.
        blocks.push({ type: 'text', text: `[Image: ${url}]` })
      }
      continue
    }
    if (part.type === 'input_audio' || part.type === 'audio') {
      blocks.push({ type: 'text', text: '[Audio input is not supported by Kiro models]' })
    }
  }
  return blocks
}

/** Anthropic-style content (string or blocks) → canonical blocks. */
function anthropicContent(content) {
  if (typeof content === 'string') return textPart(content)
  if (!Array.isArray(content)) return []
  const blocks = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    switch (part.type) {
      case 'text':
        if (part.text) blocks.push({ type: 'text', text: part.text })
        break
      case 'image': {
        const base64 = part.source?.type === 'base64' ? part.source.data : undefined
        const block = base64 ? imageBlock(part.source?.media_type, base64) : null
        blocks.push(block || { type: 'text', text: `[Image: ${base64 ? `unsupported media type ${part.source?.media_type || 'unknown'}` : part.source?.url || 'unsupported source'}]` })
        break
      }
      case 'tool_use':
        blocks.push({ type: 'tool-call', id: part.id, name: part.name, arguments: JSON.stringify(part.input ?? {}) })
        break
      case 'tool_result':
        blocks.push({
          type: 'tool-result',
          tool_use_id: part.tool_use_id,
          isError: part.is_error === true,
          content: Array.isArray(part.content)
            ? part.content.map(inner => (typeof inner === 'string' ? inner : inner?.text || '')).filter(Boolean).join('\n')
            : typeof part.content === 'string' ? part.content : '',
        })
        break
      case 'thinking':
      case 'redacted_thinking':
        // Prior chain-of-thought is never replayed to Kiro.
        break
      default:
        break
    }
  }
  return blocks
}

/** Group flat canonical blocks into the roles the turn builder expects. */
function toMessages(rawMessages, format) {
  const parse = format === 'anthropic' ? anthropicContent : openaiContent
  const messages = []
  for (const message of Array.isArray(rawMessages) ? rawMessages : []) {
    if (!message || typeof message !== 'object') continue
    const role = String(message.role || 'user')
    if (format === 'openai' && role === 'tool') {
      messages.push({
        role: 'tool',
        toolCallId: message.tool_call_id,
        isError: message.status === 'error',
        content: textPart(typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '')),
      })
      continue
    }
    const content = parse(message.content ?? message.parts)
    if (format === 'openai' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        content.push({
          type: 'tool-call',
          id: call.id,
          name: call.function?.name,
          arguments: call.function?.arguments ?? '{}',
        })
      }
    }
    const mapped = role === 'function' ? 'user' : role
    messages.push({ role: ['system', 'developer', 'assistant', 'user', 'tool'].includes(mapped) ? mapped : 'user', content })
  }
  return messages
}

/** OpenAI and Anthropic tool declarations → the shared `ToolSchema` shape. */
export function toToolSchemas(body, format) {
  const source = format === 'anthropic' ? body?.tools : (Array.isArray(body?.tools) ? body.tools.filter(tool => tool?.type === 'function' || tool?.function) .map(tool => ({ name: tool.function?.name ?? tool.name, description: tool.function?.description ?? tool.description, parameters: tool.function?.parameters ?? tool.parameters })) : [])
  const tools = []
  for (const tool of Array.isArray(source) ? source : []) {
    if (!tool || typeof tool !== 'object') continue
    const name = typeof tool.name === 'string' ? tool.name : tool.function?.name
    if (!name) continue
    tools.push({
      name,
      description: typeof tool.description === 'string' ? tool.description : '',
      parameters: tool.parameters || tool.input_schema || tool.function?.parameters || { type: 'object', properties: {} },
    })
  }
  // `tool_choice: "none"` must remove the declarations, not just discourage them:
  // Kiro has no tool_choice field at all.
  if (body?.tool_choice === 'none') return []
  return tools
}

/**
 * Normalize one inbound request.
 * @param {object} body parsed JSON request body
 * @param {'openai'|'anthropic'} format
 * @returns {{ model: string, messages: object[], tools: object[], maxTokens?: number, temperature?: number, reasoningEffort?: string, stream: boolean, stop?: string[] }}
 */
export function toCanonicalRequest(body, format) {
  if (!body || typeof body !== 'object') throw new KiroError('a JSON request body is required', ERROR_CODES.rejected)
  const model = String(body.model || '').trim()
  if (!model) throw new KiroError('a model id is required', ERROR_CODES.rejected)
  const maxTokens = Number(body.max_tokens ?? body.max_completion_tokens ?? body.maxOutputTokens)
  const temperature = Number(body.temperature)
  const stop = Array.isArray(body.stop) ? body.stop : typeof body.stop === 'string' ? [body.stop] : Array.isArray(body.stop_sequences) ? body.stop_sequences : undefined
  const effort = resolveEffort(body)
  let rawMessages = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : []
  if (format === 'anthropic' && body.system !== undefined && !rawMessages.some(entry => entry?.role === 'system')) {
    // Claude Code and the Anthropic SDK send the instructions as a top-level field.
    // Folding it in as a system message is what keeps them from arriving as nothing.
    // `messages[]` wins when a client sends both, so nothing is said twice.
    rawMessages = [{ role: 'system', content: body.system }, ...rawMessages]
  }
  return {
    model,
    messages: toMessages(rawMessages, format),
    tools: toToolSchemas(body, format),
    ...(Number.isInteger(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
    ...(Number.isFinite(temperature) ? { temperature } : {}),
    ...(effort && effort !== 'none' ? { reasoningEffort: effort } : {}),
    ...(effort === 'none' ? { reasoningEffort: undefined, thinkingDisabled: true } : {}),
    // `stream` is opt-in on both formats: an absent field means a JSON answer,
    // and guessing from the format would break non-streaming SDK calls.
    stream: body.stream === true,
    ...(stop ? { stop: stop.filter(value => typeof value === 'string' && value) } : {}),
  }
}

/** Collect text from canonical message content, for `count_tokens` estimates. */
export function requestText(messages) {
  let text = ''
  for (const message of messages) {
    for (const block of message.content || []) {
      if (block.type === 'text') text += block.text + '\n'
      else if (block.type === 'image') text += `[image ${block.mediaType || ''}]\n`
      else if (block.type === 'tool-call') text += `${block.name}(${block.arguments})\n`
      else if (block.type === 'tool-result') text += `${block.content}\n`
    }
  }
  return text
}

/** Rough token count for the endpoints that only need an order of magnitude. */
export function estimateTokens(value) {
  return Math.max(1, Math.ceil(String(value || '').length / 4))
}
