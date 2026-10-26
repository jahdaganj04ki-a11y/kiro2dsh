/**
 * Harness conversation → Kiro `conversationState`.
 *
 * Kiro's data plane validates the conversation shape strictly and answers any
 * deviation with `400 {"reason":"REQUEST_BODY_INVALID"}` — the single most
 * common reason a general-purpose client "cannot use" Kiro models. The rules it
 * enforces, all implemented here:
 *
 * - turns alternate `user`, `assistant`, … and the **last** turn is the current
 *   user message (it is not part of `history`);
 * - the first turn must be a user turn, so a history that opens with an
 *   assistant message gets a `"continue"` primer;
 * - a user turn may not have empty `content`, so a tool-result-only turn gets
 *   a placeholder that does not read like an instruction;
 * - every `toolUse` in an assistant turn needs exactly one matching
 *   `toolResult` in the immediately following user turn, sharing one id;
 * - tool names are `[a-zA-Z0-9_-]{1,64}`, ids `[a-zA-Z0-9_-]{1,64}`,
 *   descriptions ≤ 10237 code points, and the id must be unique per request;
 * - tool declarations ride on the **current** user message's
 *   `userInputMessageContext.tools`, never on historical turns;
 * - `inputSchema` must be a root object schema without `additionalProperties`,
 *   and `required` may only name declared properties;
 * - a top-level `systemPrompt` field is rejected outright, so the harness
 *   system prompt is folded into the first user turn as `<instructions>`.
 *
 * Anything that cannot be repaired by that table is flattened to text (a tool
 * turn the model can still read) instead of being sent upstream, because a
 * refused request costs a full turn.
 *
 * @module lib/kiro/conversation
 */

import {
  EMPTY_USER_PLACEHOLDER,
  TOOL_DESCRIPTION_MAX_LENGTH,
  TOOL_ID_MAX_LENGTH,
  TOOL_ID_PATTERN,
  TOOL_NAME_MAX_LENGTH,
  TOOL_NAME_SANITIZE,
  TOOL_RESULTS_PLACEHOLDER,
} from '../constants.js'
import { parseJson, text, trimCodePoints } from '../util.js'

/** Placeholder content for a user turn that carries nothing else. */
export function emptyUserContent(hasToolResults) {
  return hasToolResults ? TOOL_RESULTS_PLACEHOLDER : EMPTY_USER_PLACEHOLDER
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function appendText(target, extra) {
  if (!extra) return
  target.content = target.content ? `${target.content}\n\n${extra}` : extra
}

function uniqueName(rawName, index, used) {
  const cleaned = String(rawName || '').trim().replace(TOOL_NAME_SANITIZE, '_').replace(/^_+|_+$/gu, '')
  const base = trimCodePoints(cleaned || `tool_${index + 1}`, TOOL_NAME_MAX_LENGTH)
  let candidate = base
  let suffix = 2
  while (used.has(candidate)) {
    const tail = `_${suffix++}`
    candidate = `${base.slice(0, TOOL_NAME_MAX_LENGTH - tail.length)}${tail}`
  }
  used.add(candidate)
  return candidate
}

/** Kiro rejects `additionalProperties` and empty `required` arrays outright. */
function cleanSchemaValue(value) {
  if (Array.isArray(value)) return value.map(cleanSchemaValue)
  if (!value || typeof value !== 'object') return value
  const cleaned = {}
  for (const [key, child] of Object.entries(value)) {
    if (key === 'additionalProperties') continue
    if (key === 'required' && Array.isArray(child) && child.length === 0) continue
    cleaned[key] = cleanSchemaValue(child)
  }
  return cleaned
}

function normalizeRootSchema(schema) {
  const cleaned = cleanSchemaValue(schema && typeof schema === 'object' && !Array.isArray(schema) ? clone(schema) : {})
  cleaned.type = 'object'
  if (!cleaned.properties || typeof cleaned.properties !== 'object' || Array.isArray(cleaned.properties)) {
    cleaned.properties = {}
  }
  if (Array.isArray(cleaned.required)) {
    cleaned.required = [...new Set(cleaned.required.filter(
      name => typeof name === 'string' && Object.hasOwn(cleaned.properties, name),
    ))]
    if (cleaned.required.length === 0) delete cleaned.required
  }
  return cleaned
}

/**
 * Turn harness `ToolSchema[]` into Kiro tool specs.
 * @param {readonly object[] | undefined} tools
 * @returns {{ specs: object[], nameMap: Map<string,string> }}
 */
export function normalizeToolSpecs(tools) {
  const specs = []
  const nameMap = new Map()
  const usedNames = new Set()
  for (const [index, tool] of (Array.isArray(tools) ? tools : []).entries()) {
    if (!tool || typeof tool !== 'object') continue
    const rawName = typeof tool.name === 'string' ? tool.name : tool.function?.name
    if (typeof rawName !== 'string' || !rawName.trim()) continue
    // A repeated definition of the same name describes the same tool.
    if (nameMap.has(rawName)) continue
    const name = uniqueName(rawName, index, usedNames)
    nameMap.set(rawName, name)
    const description = trimCodePoints(
      String(tool.description ?? tool.function?.description ?? `Tool: ${rawName}`),
      TOOL_DESCRIPTION_MAX_LENGTH,
    )
    specs.push({
      toolSpecification: {
        name,
        description,
        inputSchema: { json: normalizeRootSchema(tool.parameters ?? tool.input_schema ?? {}) },
      },
    })
  }
  return { specs, nameMap }
}

function toolCallText(call) {
  return `[Tool call: ${call?.name || 'unknown'}(${text(call?.input ?? {})})]`
}

function toolResultText(result) {
  const content = Array.isArray(result?.content)
    ? result.content.map(part => text(part?.text ?? part)).filter(Boolean).join('\n')
    : text(result?.content)
  return `[Tool result${result?.status === 'error' ? ' (error)' : ''}: ${content}]`
}

function reserveToolId(value, turnIndex, callIndex, name, usedIds) {
  const sanitized = typeof value === 'string' ? value.replace(/[^a-zA-Z0-9_-]/gu, '') : ''
  const generated = `call_msg${turnIndex}_tc${callIndex}_${name || 'tool'}`
  const base = trimCodePoints(TOOL_ID_PATTERN.test(sanitized) && sanitized ? sanitized : generated, TOOL_ID_MAX_LENGTH)
  let candidate = base
  let suffix = 2
  while (usedIds.has(candidate)) {
    const tail = `_${suffix++}`
    candidate = `${base.slice(0, TOOL_ID_MAX_LENGTH - tail.length)}${tail}`
  }
  usedIds.add(candidate)
  return candidate
}

function normalizeToolInput(input) {
  if (input && typeof input === 'object' && !Array.isArray(input)) return clone(input)
  if (typeof input === 'string') {
    const parsed = parseJson(input, null)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    return input.trim() === '' ? {} : null
  }
  return input == null ? {} : null
}

function normalizeToolResult(result) {
  const content = Array.isArray(result?.content)
    ? result.content.map(part => ({ text: text(part?.text ?? part) }))
    : [{ text: text(result?.content) }]
  return {
    toolUseId: typeof result?.toolUseId === 'string' ? result.toolUseId : '',
    status: result?.status === 'error' ? 'error' : 'success',
    content: content.length > 0 ? content : [{ text: '' }],
  }
}

function flattenResults(userMessage, results) {
  for (const result of results) appendText(userMessage, toolResultText(result))
}

function cleanUserContext(userMessage) {
  const context = userMessage.userInputMessageContext
  if (!context) return
  if (!context.toolResults?.length) delete context.toolResults
  if (!context.tools?.length) delete context.tools
  if (Object.keys(context).length === 0) delete userMessage.userInputMessageContext
}

/**
 * Make one assistant/user pair agree: keep only calls that have a matching
 * result and a declared tool spec, give the kept pairs a shared legal id, and
 * flatten everything else into readable text.
 */
function reconcileToolPair(assistant, user, turnIndex, nameMap, specNames, usedIds, repairs) {
  const calls = Array.isArray(assistant.toolUses) ? assistant.toolUses : []
  const results = Array.isArray(user.userInputMessageContext?.toolResults)
    ? user.userInputMessageContext.toolResults.map(normalizeToolResult)
    : []
  if (calls.length === 0) {
    if (results.length > 0) {
      flattenResults(user, results)
      repairs.orphanResults += results.length
    }
    if (user.userInputMessageContext) delete user.userInputMessageContext.toolResults
    cleanUserContext(user)
    return
  }

  const callQueues = new Map()
  const records = calls.map((call, callIndex) => {
    const key = typeof call?.toolUseId === 'string' ? call.toolUseId : ''
    const mappedName = nameMap.get(call?.name) || call?.name
    const record = { call, callIndex, key, mappedName, input: normalizeToolInput(call?.input), result: null }
    const queue = callQueues.get(key) || []
    queue.push(record)
    callQueues.set(key, queue)
    return record
  })

  const orphanResults = []
  for (const result of results) {
    const queue = callQueues.get(typeof result.toolUseId === 'string' ? result.toolUseId : '')
    const match = queue?.find(candidate => !candidate.result)
    if (match) match.result = result
    else orphanResults.push(result)
  }

  const keptCalls = []
  const keptResults = []
  for (const record of records) {
    const hasSpec = typeof record.mappedName === 'string' && specNames.has(record.mappedName)
    const valid = !!record.result && hasSpec && record.input !== null
    if (!valid) {
      appendText(assistant, toolCallText({ name: record.mappedName, input: record.call?.input }))
      repairs.missingResults += record.result ? 0 : 1
      repairs.invalidToolUses += hasSpec && record.input !== null ? 0 : 1
      if (record.result) {
        flattenResults(user, [record.result])
        repairs.orphanResults++
      }
      continue
    }
    const toolUseId = reserveToolId(record.key, turnIndex, record.callIndex, record.mappedName, usedIds)
    keptCalls.push({ toolUseId, name: record.mappedName, input: record.input })
    keptResults.push({ ...record.result, toolUseId })
  }

  if (orphanResults.length > 0) {
    flattenResults(user, orphanResults)
    repairs.orphanResults += orphanResults.length
  }

  if (keptCalls.length > 0) assistant.toolUses = keptCalls
  else delete assistant.toolUses
  user.userInputMessageContext ||= {}
  if (keptResults.length > 0) user.userInputMessageContext.toolResults = keptResults
  else delete user.userInputMessageContext.toolResults
  cleanUserContext(user)
}

/** Final wire check, without mutation. Returns the failing positions, if any. */
export function validateConversation(history, currentMessage, toolSpecs = []) {
  const errors = []
  const turns = [...(history || []), currentMessage].filter(Boolean)
  const specNames = new Set(toolSpecs.map(spec => spec?.toolSpecification?.name).filter(Boolean))
  const usedIds = new Set()

  for (let index = 0; index < turns.length; index++) {
    const isUser = !!turns[index]?.userInputMessage
    if (isUser !== index % 2 === 0) errors.push(`role:${index}`)
    if (!isUser) {
      const calls = turns[index].assistantResponseMessage?.toolUses || []
      const results = turns[index + 1]?.userInputMessage?.userInputMessageContext?.toolResults || []
      const resultIds = results.map(result => result.toolUseId)
      if (calls.length !== results.length || calls.some(call => !resultIds.includes(call.toolUseId))) {
        errors.push(`pair:${index}`)
      }
      for (const call of calls) {
        if (!call.toolUseId || usedIds.has(call.toolUseId)) errors.push(`id:${index}`)
        usedIds.add(call.toolUseId)
        if (!specNames.has(call.name)) errors.push(`spec:${index}`)
      }
    } else if (index === 0 && turns[index].userInputMessage?.userInputMessageContext?.toolResults?.length) {
      errors.push('orphan:0')
    }
  }
  if (!currentMessage?.userInputMessage?.content) errors.push('current')
  return { valid: errors.length === 0, errors }
}

function flattenAllStructuredTools(turns, repairs) {
  for (const turn of turns) {
    if (turn.assistantResponseMessage?.toolUses?.length) {
      for (const call of turn.assistantResponseMessage.toolUses) {
        appendText(turn.assistantResponseMessage, toolCallText(call))
      }
      repairs.invalidToolUses += turn.assistantResponseMessage.toolUses.length
      delete turn.assistantResponseMessage.toolUses
    }
    const user = turn.userInputMessage
    const results = user?.userInputMessageContext?.toolResults
    if (results?.length) {
      flattenResults(user, results)
      repairs.orphanResults += results.length
      delete user.userInputMessageContext.toolResults
      cleanUserContext(user)
    }
  }
}

function mergeUser(target, source) {
  appendText(target, source.content)
  if (Array.isArray(source.images) && source.images.length > 0) {
    target.images = [...(target.images || []), ...source.images]
  }
  const results = source.userInputMessageContext?.toolResults
  if (Array.isArray(results) && results.length > 0) {
    target.userInputMessageContext ||= {}
    target.userInputMessageContext.toolResults = [
      ...(target.userInputMessageContext.toolResults || []),
      ...results,
    ]
  }
}

function mergeAssistant(target, source) {
  appendText(target, source.content)
  if (Array.isArray(source.toolUses) && source.toolUses.length > 0) {
    target.toolUses = [...(target.toolUses || []), ...source.toolUses]
  }
}

/** Collapse to strict alternation, priming and closing with a user turn. */
function normalizeTurns(turns, modelId) {
  const out = []
  for (const raw of turns) {
    const isUser = !!raw?.userInputMessage
    const isAssistant = !!raw?.assistantResponseMessage
    if (isUser === isAssistant) continue
    const turn = isUser
      ? { userInputMessage: clone(raw.userInputMessage) }
      : { assistantResponseMessage: clone(raw.assistantResponseMessage) }
    const previous = out[out.length - 1]
    if (turn.userInputMessage && previous?.userInputMessage) {
      mergeUser(previous.userInputMessage, turn.userInputMessage)
    } else if (turn.assistantResponseMessage && previous?.assistantResponseMessage) {
      mergeAssistant(previous.assistantResponseMessage, turn.assistantResponseMessage)
    } else {
      out.push(turn)
    }
  }
  if (out[0]?.assistantResponseMessage) {
    out.unshift({ userInputMessage: { content: EMPTY_USER_PLACEHOLDER, modelId } })
  }
  if (out.length === 0 || out[out.length - 1]?.assistantResponseMessage) {
    out.push({ userInputMessage: { content: EMPTY_USER_PLACEHOLDER, modelId } })
  }
  for (const turn of out) {
    if (turn.userInputMessage) {
      turn.userInputMessage.content = text(turn.userInputMessage.content).trim()
        || emptyUserContent(turn.userInputMessage.userInputMessageContext?.toolResults?.length > 0)
      turn.userInputMessage.modelId ||= modelId
      if (turn.userInputMessage.userInputMessageContext?.tools) {
        delete turn.userInputMessage.userInputMessageContext.tools
      }
    } else {
      turn.assistantResponseMessage.content = text(turn.assistantResponseMessage.content).trim() || '...'
    }
  }
  return out
}

/**
 * Canonicalize a raw `{ history, currentMessage }` pair into a shippable Kiro
 * conversation.
 * @param {{ history: object[], currentMessage: object, modelId: string, toolSpecs?: object[], nameMap?: Map<string,string> }} input
 * @returns {{ history: object[], currentMessage: object, repairs: object, valid: boolean, errors: string[] }}
 */
export function canonicalizeConversation({ history = [], currentMessage, modelId, toolSpecs = [], nameMap = new Map() }) {
  const turns = normalizeTurns([...(Array.isArray(history) ? history : []), currentMessage], modelId)
  const repairs = { missingResults: 0, orphanResults: 0, invalidToolUses: 0, primed: 0 }
  const specNames = new Set(toolSpecs.map(spec => spec?.toolSpecification?.name).filter(Boolean))
  const usedIds = new Set()

  for (let index = 0; index < turns.length; index += 2) {
    const user = turns[index].userInputMessage
    if (index === 0 && user.userInputMessageContext?.toolResults?.length > 0) {
      flattenResults(user, user.userInputMessageContext.toolResults)
      repairs.orphanResults += user.userInputMessageContext.toolResults.length
      delete user.userInputMessageContext.toolResults
      cleanUserContext(user)
    }
    const assistant = turns[index + 1]?.assistantResponseMessage
    const nextUser = turns[index + 2]?.userInputMessage
    if (assistant && nextUser) {
      reconcileToolPair(assistant, nextUser, index + 1, nameMap, specNames, usedIds, repairs)
    }
  }

  const finalCurrent = turns[turns.length - 1]
  finalCurrent.userInputMessage.userInputMessageContext ||= {}
  if (toolSpecs.length > 0) {
    finalCurrent.userInputMessage.userInputMessageContext.tools = clone(toolSpecs)
  }
  cleanUserContext(finalCurrent.userInputMessage)

  let finalHistory = turns.slice(0, -1)
  let validation = validateConversation(finalHistory, finalCurrent, toolSpecs)
  if (!validation.valid) {
    // Second and last chance: a structured tool turn we cannot pair is turned
    // into text, because the alternative is a request Kiro refuses outright.
    flattenAllStructuredTools(turns, repairs)
    finalHistory = turns.slice(0, -1)
    validation = validateConversation(finalHistory, finalCurrent, toolSpecs)
  }

  return {
    history: finalHistory,
    currentMessage: finalCurrent,
    repairs,
    valid: validation.valid,
    errors: validation.errors,
  }
}
