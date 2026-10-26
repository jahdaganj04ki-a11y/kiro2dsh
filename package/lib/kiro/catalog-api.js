/**
 * Kiro control-plane calls: the live model catalog and profile discovery.
 *
 * `ListAvailableModels` is what makes per-model settings authoritative instead of
 * guessed: it reports the model ids this account may call, its own display name,
 * the credit multiplier and `tokenLimits.maxInputTokens`. A static table cannot
 * know any of that per account, so the plugin merges this answer over its seed
 * catalog and falls back to the seed when the call fails — a cold cache or a
 * blocked network must not hide the models.
 *
 * @module lib/kiro/catalog-api
 */

import {
  CATALOG_FETCH_TIMEOUT_MS,
  CODEWHISPERER_LIST_MODELS_TARGET,
  CODEWHISPERER_LIST_PROFILES_TARGET,
  CODEWHISPERER_USAGE_PATH,
  DEFAULT_REGION,
  JSON_ACCEPT,
  KIRO_SURFACES,
  KIRO_UA,
} from '../constants.js'
import { KiroError, assertAfterStatus } from '../errors.js'
import { readBodyPrefix } from '../util.js'
import { buildHeaders, surfaceUrl } from './transport.js'

/** Region inside a profile ARN, which the runtime gateway expects to be us-east-1. */
export function regionFromProfileArn(profileArn) {
  if (typeof profileArn !== 'string' || !profileArn) return DEFAULT_REGION
  const parts = profileArn.split(':')
  return parts.length >= 4 && parts[3] ? parts[3] : DEFAULT_REGION
}

async function callJson(url, { headers, body, method = 'POST', fetch = globalThis.fetch, signal, timeoutMs = CATALOG_FETCH_TIMEOUT_MS }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  const merged = signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, controller.signal]) : (signal || controller.signal)
  try {
    const response = await fetch(url, { method, headers, body, signal: merged })
    if (!response.ok) {
      const text = await readBodyPrefix(response, 4096)
      throw KiroError.fromUpstream(response, text, { stage: 'control-plane' })
    }
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fetch the raw catalog for one credential.
 * @param {{ credentials: object, fetch?: Function, signal?: AbortSignal, log?: object, origin?: string }} options
 * @returns {Promise<object[]>} raw `models` array
 */
export async function fetchKiroCatalog(options) {
  const credentials = options.credentials || {}
  const region = credentials.region || regionFromProfileArn(credentials.profileArn)
  const params = new URLSearchParams({ origin: credentials.origin || 'AI_EDITOR' })
  // API keys are account-bound: an unrelated placeholder ARN is a 403 there.
  if (credentials.profileArn) params.set('profileArn', credentials.profileArn)
  const url = `${surfaceUrl('q', region).replace('/generateAssistantResponse', '')}/ListAvailableModels?${params.toString()}`
  const headers = buildHeaders(credentials, {
    url,
    accept: JSON_ACCEPT,
    agentMode: credentials.agentMode || 'vibe',
    extraHeaders: credentials.extraHeaders,
    os: credentials.uaOs,
    osVersion: credentials.uaOsVersion,
    nodeVersion: credentials.uaNodeVersion,
    kiroVersion: credentials.uaKiroVersion,
  })
  try {
    const data = await callJson(url, {
      method: 'GET',
      headers: { ...headers, 'Content-Type': undefined },
      fetch: options.fetch,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    })
    return Array.isArray(data?.models) ? data.models : []
  } catch (error) {
    assertAfterStatus(error, 'catalog')
    throw error
  }
}

/**
 * Resolve the account's own CodeWhisperer profile ARN.
 *
 * API-key credentials must not call this: `ListAvailableProfiles` does not
 * accept `TokenType=API_KEY`, and the Q catalog is used for their validation
 * instead.
 */
export async function fetchProfileArn(options) {
  const credentials = options.credentials || {}
  if (credentials.authMethod === 'api_key') return null
  const region = credentials.region || regionFromProfileArn(credentials.profileArn)
  const url = `https://codewhisperer.${region}.amazonaws.com`
  const headers = buildHeaders(credentials, { url, accept: JSON_ACCEPT, extraHeaders: credentials.extraHeaders })
  headers['x-amz-target'] = CODEWHISPERER_LIST_PROFILES_TARGET
  headers['Content-Type'] = 'application/x-amz-json-1.0'
  let data
  try {
    data = await callJson(url, {
      headers,
      body: JSON.stringify({ maxResults: 10 }),
      fetch: options.fetch,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    })
  } catch (error) {
    options.log?.warn?.(`kiro: ListAvailableProfiles failed: ${error?.message || error}`)
    return null
  }
  const profiles = Array.isArray(data?.profiles) ? data.profiles : []
  const arnOf = profile => profile?.arn || profile?.profileArn || null
  const match = profiles.find(profile => arnOf(profile)?.split(':')[3] === region) || profiles[0]
  return arnOf(match) || null
}

/**
 * Credit and quota facts for one credential.
 * @returns {Promise<{ plan: string, quotas: Record<string, object> } | null>}
 */
export async function fetchUsageLimits(options) {
  const credentials = options.credentials || {}
  const region = credentials.region || DEFAULT_REGION
  const params = new URLSearchParams({
    isEmailRequired: 'true',
    origin: 'AI_EDITOR',
    resourceType: 'AGENTIC_REQUEST',
  })
  const hosts = [
    `https://codewhisperer.${region}.amazonaws.com`,
    `https://q.${region}.amazonaws.com`,
  ]
  let lastError = null
  for (const host of hosts) {
    const url = `${host}${CODEWHISPERER_USAGE_PATH}?${params.toString()}`
    // Attribution headers are mandatory on every provider request, control-plane
    // calls included.
    const headers = buildHeaders(credentials, { url, accept: JSON_ACCEPT, extraHeaders: credentials.extraHeaders })
    headers['x-amz-target'] = undefined
    delete headers['x-amz-target']
    headers['Content-Type'] = undefined
    delete headers['Content-Type']
    try {
      const data = await callJson(url, {
        method: 'GET',
        headers,
        fetch: options.fetch,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      })
      return normalizeUsage(data)
    } catch (error) {
      lastError = error
    }
  }
  options.log?.warn?.(`kiro: usage limits unavailable: ${lastError?.message || 'unknown'}`)
  return null
}

/** Fold Kiro's usage payload into a stable, UI-ready shape. */
export function normalizeUsage(data) {
  const quotas = {}
  const resetAt = parseResetTime(data?.nextDateReset || data?.resetDate)
  for (const breakdown of Array.isArray(data?.usageBreakdownList) ? data.usageBreakdownList : []) {
    const resourceType = String(breakdown?.resourceType || 'unknown').toLowerCase()
    const used = Number(breakdown?.currentUsageWithPrecision ?? breakdown?.currentUsage ?? 0)
    const total = Number(breakdown?.usageLimitWithPrecision ?? breakdown?.usageLimit ?? 0)
    quotas[resourceType] = {
      used,
      total,
      remaining: Math.max(0, total - used),
      unlimited: !Number.isFinite(total) || total <= 0,
      ...(resetAt ? { resetAt } : {}),
    }
    const freeTrial = breakdown?.freeTrialInfo
    if (freeTrial) {
      const freeUsed = Number(freeTrial.currentUsageWithPrecision ?? 0)
      const freeTotal = Number(freeTrial.usageLimitWithPrecision ?? 0)
      quotas[`${resourceType}_freetrial`] = {
        used: freeUsed,
        total: freeTotal,
        remaining: Math.max(0, freeTotal - freeUsed),
        unlimited: false,
        resetAt: parseResetTime(freeTrial.freeTrialExpiry) || resetAt,
      }
    }
  }
  return {
    plan: data?.subscriptionInfo?.subscriptionTitle || data?.subscriptionInfo?.plan || 'Kiro',
    quotas,
  }
}

function parseResetTime(value) {
  if (!value) return undefined
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

/** The `User-Agent` shape reference, exposed so tests can assert the exact tokens. */
export const UA_SHAPE = Object.freeze({
  os: KIRO_UA.os,
  osVersion: KIRO_UA.osVersion,
  sdk: `aws-sdk-js/${KIRO_UA.runtimeSdkVersion}`,
})
