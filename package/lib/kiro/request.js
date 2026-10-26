/**
 * Harness `GenerateOptions` → Kiro `GenerateAssistantResponse` payload.
 *
 * The translation is where the per-model settings become wire behaviour: which
 * reasoning field the model accepts, whether images may be attached at all,
 * how large `maxTokens` may be, whether the agentic chunked-write prompt is
 * prepended, and which `origin`/`modelId` the turn declares. Everything Kiro
 * rejects is refused here instead of upstream, so a failure names the model
 * rather than surfacing as an opaque 400.
 *
 * @module lib/kiro/request
 */

import { ACCOUNT_BOUND_AUTH, AGENTIC_SYSTEM_PROMPT, DEFAULT_PROFILE_ARNS, FORBIDDEN_BODY_FIELDS, THINKING_BUDGET_DEFAULT, THINKING_BUDGET_MAX, THINKING_BUDGET_MIN, defaultProfileArn } from '../constants.js'
import { effortWireValue, resolveMaxTokens } from '../catalog.js'
import { clamp } from '../util.js'
import { emptyUserContent, normalizeToolSpecs, canonicalizeConversation } from './conversation.js'

/** `<thinking_mode>` prefix for models whose only reasoning switch is the prompt tag. */
export function buildThinkingPrefix(budget) {
  const safe = clamp(budget ?? THINKING_BUDGET_DEFAULT, THINKING_BUDGET_MIN, THINKING_BUDGET_MAX)
  return `<thinking_mode>enabled</thinking_mode>\n<max_thinking_length>${safe}</max_thinking_length>`
}

/** Wrap an instruction block the way Kiro's own agent prompts are marked up. */
function instructions(content) {
  return `<instructions>\n${content}\n</instructions>`
}

/**
 * Flatten harness content blocks into Kiro turn fragments.
 * @param {readonly object[]} content
 * @param {{ images: boolean, resolveImage?: (block: object) => Promise<object | undefined> | object }} options
 * @returns {Promise<{ text: string[], images: object[], toolCalls: object[], toolResults: object[] }>}
 */
export async function projectBlocks(content, options) {
  // toolResults stays a separate channel: Kiro wants them in the turn's
  // `userInputMessageContext`, not as text, and a turn that mixes both must keep
  // the text as the user's own words.
  const out = { text: [], images: [], toolCalls: [], toolResults: [] }
  for (const block of Array.isArray(content) ? content : []) {
    if (!block || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string' && block.text.length > 0) out.text.push(block.text)
        break
      case 'reasoning':
        // Reasoning is never replayed: Kiro has no assistant reasoning field and
        // re-feeding prior thinking text corrupts the turn alternation it checks.
        break
      case 'image': {
        if (!options.images) break
        const image = options.resolveImage ? await options.resolveImage(block) : undefined
        if (image) out.images.push(image)
        break
      }
      case 'file':
        if (typeof block.handle === 'string') out.text.push(block.handle)
        break
      case 'tool-call':
        out.toolCalls.push({ toolUseId: block.id, name: block.name, input: block.arguments })
        break
      case 'tool-result':
        out.toolResults.push({
          toolUseId: block.tool_use_id ?? block.toolUseId ?? block.callId,
          status: block.isError ? 'error' : 'success',
          content: [{ text: typeof block.content === 'string' ? block.content : text(block.content) }],
        })
        break
      case 'tool-addition':
      case 'tool-removal':
        // The declaration list is rebuilt per request; update blocks carry no wire meaning.
        break
      default:
        break
    }
  }
  return out
}

/**
 * Convert the harness message list into Kiro history plus the current turn.
 *
 * `system` and `developer` messages have no Kiro counterpart: the system prompt
 * becomes an `<instructions>` block on the first user turn (a top-level
 * `systemPrompt` field is answered with 400), and developer notices are folded
 * into the same user turn so the model still reads them in order.
 */
export async function convertMessages(messages, context) {
  const history = []
  let pendingUserText = []
  let pendingImages = []
  let pendingToolResults = []
  let pendingAssistantText = []
  let pendingToolUses = []
  let currentRole = null
  let instructionsBlock = null

  const flush = () => {
    if (currentRole === 'user') {
      const content = [...pendingUserText].join('\n\n').trim() || emptyUserContent(pendingToolResults.length > 0)
      const turn = { userInputMessage: { content, modelId: context.modelId } }
      if (pendingImages.length > 0) turn.userInputMessage.images = [...pendingImages]
      if (pendingToolResults.length > 0) {
        turn.userInputMessage.userInputMessageContext = { toolResults: [...pendingToolResults] }
      }
      history.push(turn)
      pendingUserText = []
      pendingImages = []
      pendingToolResults = []
    } else if (currentRole === 'assistant') {
      const turn = { assistantResponseMessage: { content: [...pendingAssistantText].join('\n\n').trim() } }
      if (pendingToolUses.length > 0) turn.assistantResponseMessage.toolUses = [...pendingToolUses]
      history.push(turn)
      pendingAssistantText = []
      pendingToolUses = []
    }
    currentRole = null
  }

  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue
    const projected = await projectBlocks(message.content, context)
    if (message.role === 'system') {
      instructionsBlock = instructions(projected.text.join('\n\n').trim())
      continue
    }
    for (const result of projected.toolResults) {
      if (currentRole !== null && currentRole !== 'user') flush()
      currentRole = 'user'
      pendingToolResults.push(result)
    }
    if (message.role === 'tool') {
      if (currentRole !== null && currentRole !== 'tool') flush()
      currentRole = 'user'
      pendingToolResults.push({
        toolUseId: typeof message.toolCallId === 'string' ? message.toolCallId : message.source?.callId,
        status: message.isError ? 'error' : 'success',
        content: [{ text: projected.text.join('\n\n') }],
      })
      continue
    }
    if (message.role === 'developer') {
      if (currentRole !== null && currentRole !== 'developer') flush()
      currentRole = 'user'
      if (projected.text.join('').trim()) pendingUserText.push(instructions(projected.text.join('\n\n').trim()))
      continue
    }
    if (message.role === 'assistant') {
      if (currentRole !== null && currentRole !== 'assistant') flush()
      currentRole = 'assistant'
      if (projected.text.join('\n\n').trim()) pendingAssistantText.push(projected.text.join('\n\n').trim())
      for (const call of projected.toolCalls) {
        pendingToolUses.push({
          toolUseId: call.toolUseId,
          name: call.name,
          input: typeof call.input === 'string' ? call.input : call.input,
        })
      }
      continue
    }
    // user (and anything unknown) reads as a user turn
    if (currentRole !== null && currentRole !== 'user') flush()
    currentRole = 'user'
    if (projected.text.join('\n\n').trim()) pendingUserText.push(projected.text.join('\n\n').trim())
    pendingImages.push(...projected.images)
  }
  flush()

  // The last user turn is the current message on the wire, not history.
  let currentMessage = null
  for (let index = history.length - 1; index >= 0; index--) {
    if (history[index].userInputMessage) {
      currentMessage = history.splice(index, 1)[0]
      break
    }
  }
  if (!currentMessage) {
    currentMessage = { userInputMessage: { content: emptyUserContent(false), modelId: context.modelId } }
  }
  if (instructionsBlock) {
    const content = currentMessage.userInputMessage.content
    currentMessage.userInputMessage.content = content
      ? `${instructionsBlock}\n\n${content}`
      : instructionsBlock
  }
  return { history, currentMessage }
}

/**
 * Decide which thinking effort this turn asks for, or `null` for none.
 *
 * Precedence is the explicit call argument, then an id-level override
 * (`model(high)` / `model(none)`), then the `-thinking` variant, then the model
 * default. An explicit `none` has to switch thinking *off* even on a model whose
 * default is on, which is why the caller's answer outranks both the suffix and the
 * default rather than merely filling them in.
 *
 * @param {string} [reasoningEffort] effort the caller named
 * @param {{ thinking?: boolean, thinkingOverride?: {mode: string, level?: string} }} intent
 * @param {object} model catalog entry
 * @returns {string|null} the effort id to send, or null for no thinking
 */
function pickThinking(reasoningEffort, intent, model) {
  const explicit = normalizeEffortWord(reasoningEffort)
  if (explicit !== undefined) return explicit
  const override = intent?.thinkingOverride
  if (override) return override.mode === 'none' ? null : override.level
  if (!intent?.thinking && !model?.thinkingDefault) return null
  return model?.defaultEffort || 'medium'
}

/**
 * Map the effort spellings a caller may use onto our ids; `none` means no thinking.
 * @param {string} [value]
 * @returns {string|null|undefined} the mapped id, null for off, undefined when unrecognized
 */
function normalizeEffortWord(value) {
  if (typeof value !== 'string' || value === '') return undefined
  const word = value.toLowerCase()
  if (word === 'none' || word === 'off' || word === 'disabled' || word === 'false') return null
  if (word === 'minimal' || word === 'low' || word === 'medium' || word === 'high') return word
  if (word === 'xhigh' || word === 'max') return word
  return undefined
}

/**
 * Build the request body.
 * @param {object} input
 * @param {string} input.model model id as the caller named it (may carry `-thinking`/`-agentic`)
 * @param {object} input.modelSettings resolved catalog record for that model
 * @param {import('../model-id.js').resolveModelIntent} input.intent
 * @param {readonly object[]} input.messages harness request messages
 * @param {readonly object[]} [input.tools]
 * @param {number} [input.maxTokens]
 * @param {number} [input.temperature]
 * @param {string[]} [input.stop]
 * @param {string} [input.reasoningEffort]
 * @param {object} [input.credentials] active account (authMethod, profileArn, region)
 * @param {(block: object) => Promise<object|undefined>} [input.resolveImage]
 * @param {string} [input.conversationId]
 * @returns {Promise<{ payload: object, nameMap: Map<string,string>, meta: object }>}
 */
export async function buildKiroPayload(input) {
  const model = input.modelSettings
  const intent = input.intent
  const upstream = model.upstream
  const wantThinking = pickThinking(input.reasoningEffort, intent, model)

  const { specs, nameMap } = normalizeToolSpecs(model.tools ? input.tools : [])
  const { history, currentMessage } = await convertMessages(input.messages, {
    modelId: upstream,
    images: Boolean(model.vision),
    resolveImage: input.resolveImage,
  })

  // Reasoning: each family has exactly one accepted carrier. Sending the wrong
  // one is a 400, so the choice is made from the model record, never from what
  // the caller asked for.
  let systemPromptParts = []
  let additionalModelRequestFields
  if (wantThinking && model.reasoning === 'output_config') {
    const effort = effortWireValue(model, wantThinking)
    if (effort) {
      additionalModelRequestFields = {
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort },
      }
    }
  } else if (wantThinking && model.reasoning === 'reasoning') {
    const effort = effortWireValue(model, wantThinking)
    if (effort) additionalModelRequestFields = { reasoning: { effort } }
  } else if (wantThinking && model.reasoning === 'tag' && model.thinkingTag !== false) {
    systemPromptParts.push(buildThinkingPrefix(effortWireValue(model, wantThinking)))
  }

  // The chunked-write protocol prompt is opt-in per variant or per model: it
  // changes how the model writes files, so it is never implied by reasoning.
  if (model.agentic !== false && (intent.agentic || model.agenticDefault === true)) {
    systemPromptParts.push(AGENTIC_SYSTEM_PROMPT)
  }

  const profileArn = resolveProfileArn(input.credentials)
  const contentPrefix = systemPromptParts.filter(Boolean).join('\n\n')
  if (contentPrefix) {
    // Prefix the current turn: Kiro reads no top-level system field, and the
    // first user turn may be a replayed one from the session cache.
    currentMessage.userInputMessage.content = [contentPrefix, currentMessage.userInputMessage.content]
      .filter(Boolean)
      .join('\n\n')
  }

  const canonical = canonicalizeConversation({
    history,
    currentMessage,
    modelId: upstream,
    toolSpecs: specs,
    nameMap,
  })
  if (!canonical.valid) {
    const error = new Error(`Kiro conversation rejected before sending: ${canonical.errors.join(', ') || 'unknown'} (model ${upstream})`)
    error.code = 'KIRO_INVALID_PAYLOAD'
    throw error
  }

  const maxTokens = resolveMaxTokens(model, input.maxTokens)
  const payload = {
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId: input.conversationId,
      currentMessage: canonical.currentMessage,
      history: canonical.history,
    },
    inferenceConfig: { maxTokens },
  }
  if (profileArn) payload.profileArn = profileArn
  if (additionalModelRequestFields) payload.additionalModelRequestFields = additionalModelRequestFields
  if (typeof input.temperature === 'number' && Number.isFinite(input.temperature)) {
    payload.inferenceConfig.temperature = input.temperature
  }
  if (Number.isFinite(input.topP)) payload.inferenceConfig.topP = input.topP
  if (Array.isArray(input.stop) && input.stop.length > 0) payload.inferenceConfig.stopSequences = input.stop.slice(0, 4)
  for (const forbidden of FORBIDDEN_BODY_FIELDS) delete payload[forbidden]

  return {
    payload,
    nameMap,
    meta: {
      upstream,
      modelId: model.id,
      turns: canonical.history.length + 1,
      toolSpecs: specs.length,
      repairs: canonical.repairs,
      thinking: wantThinking ? { path: model.reasoning, effort: wantThinking } : null,
      agentic: Boolean(intent.agentic),
      images: canonical.currentMessage.userInputMessage?.images?.length || 0,
      profileArn: profileArn ? 'set' : 'default',
    },
  }
}

/**
 * Profile ARN selection.
 *
 * `builder-id`/social tokens are bound to the shared placeholder profiles, so a
 * missing ARN must fall back to it. Account-bound methods (API key, IDC,
 * external IdP) must never receive another account's ARN — CodeWhisperer
 * answers that combination with 403 "bearer token invalid" — so they send the
 * ARN they resolved for themselves, or none at all.
 */
export function resolveProfileArn(credentials) {
  const own = typeof credentials?.profileArn === 'string' ? credentials.profileArn.trim() : ''
  if (own) return own
  const method = credentials?.authMethod
  if (ACCOUNT_BOUND_AUTH.includes(method)) return ''
  // An imported token records only "import", but its prefix says who issued it:
  // `aor` is a Kiro social login, which the IDE runs on a different shared
  // placeholder profile than Builder ID. Choosing by prefix keeps the ARN that the
  // token is actually entitled to.
  if (method === 'import' || method === 'auto-import') {
    return String(credentials?.refreshToken || '').startsWith('aor')
      ? DEFAULT_PROFILE_ARNS.social
      : DEFAULT_PROFILE_ARNS['builder-id']
  }
  return defaultProfileArn(method)
}
