/**
 * The plugin's error taxonomy.
 *
 * Failure codes are the harness vocabulary (`AUTH`, `RATE_LIMIT`, `MISSING_CREDENTIAL`, …)
 * because that is what a retry policy, a session log entry and the recovery UI
 * route on. Consumer code must never branch on message text: upstream wording
 * changes, codes do not. Every code below therefore also names the repair a
 * user can perform, and `detailsFrom` carries the facts needed to find it.
 *
 * @module lib/errors
 */

/** Stable machine codes; the adapter maps these onto harness failure codes. */
export const ERROR_CODES = Object.freeze({
  /** No usable Kiro credential is stored yet. */
  notConfigured: 'KIRO_NOT_CONFIGURED',
  /** Token rejected and refresh failed: the account must sign in again. */
  auth: 'AUTH',
  /** Credential record is unreadable or malformed. */
  invalidCredential: 'INVALID_CREDENTIAL',
  /** Refresh token is expired, rotated away, or reused. */
  refreshExpired: 'KIRO_REFRESH_EXPIRED',
  /** Provider asked us to back off. */
  rateLimit: 'RATE_LIMIT',
  /** Credit balance or subscription limit exhausted. */
  quota: 'QUOTA',
  /** The conversation could not be made shippable; refused before the network. */
  invalidPayload: 'KIRO_INVALID_PAYLOAD',
  /** Model id is not in this account's catalog. */
  modelUnavailable: 'KIRO_MODEL_UNAVAILABLE',
  /** Upstream 5xx or an unexpected answer. */
  upstream: 'KIRO_UPSTREAM',
  /** Every data-plane surface failed to answer. */
  endpoint: 'KIRO_ENDPOINT_UNREACHABLE',
  /** Timeout at connect, first chunk, or mid-stream stall. */
  timeout: 'TIMEOUT',
  /** EventStream framing failed: the answer is incomplete by construction. */
  corruptStream: 'KIRO_CORRUPT_STREAM',
  /** 400 that is not a model or payload-class error we can name. */
  badRequest: 'KIRO_BAD_REQUEST',
  /** The caller cancelled. */
  aborted: 'ABORTED',
  /** A settings or bridge request the plugin refuses to serve. */
  rejected: 'KIRO_REQUEST_REJECTED',
})

/** An error carrying a machine code plus the serializable facts a log needs. */
export class KiroError extends Error {
  /**
   * @param {string} message human-readable summary; never contains a secret
   * @param {string} [code] one of {@link ERROR_CODES}
   * @param {object} [details] `status`, `reason`, `requestId`, `providerRetryAfterMs`, `stage`
   */
  constructor(message, code = ERROR_CODES.upstream, details = {}) {
    super(message)
    this.name = 'KiroError'
    this.code = code
    for (const [key, value] of Object.entries(details)) {
      if (value !== undefined) this[key] = value
    }
  }

  /**
   * Build one failure from an upstream HTTP response.
   *
   * The body text is truncated and secret-redacted before it reaches the
   * message: Kiro answers with a JSON error object, and that object is the only
   * part of a failed request that tells a user which setting to change.
   * @param {Response} response
   * @param {string} bodyText
   * @param {{classify?: Function, stage?: string}} [options]
   */
  static fromUpstream(response, bodyText, options = {}) {
    const status = Number(response?.status) || 0
    const verdict = options.classify ? options.classify(status, bodyText) : classifyUpstream(status, bodyText)
    const details = {
      status,
      stage: options.stage,
      ...(verdict.reason ? { reason: verdict.reason } : {}),
      ...(response?.headers?.get?.('x-amzn-requestid') ? { requestId: response.headers.get('x-amzn-requestid') } : {}),
      ...(status === 429 ? { providerRetryAfterMs: verdict.retryAfterMs ?? 0 } : {}),
    }
    return new KiroError(summarize(status, verdict.message, details), verdict.code, details)
  }

  /** Failure record shaped like the harness `LlmFailure`. */
  toFailure() {
    const failure = { message: this.message, code: this.code }
    if (Number.isInteger(this.status)) failure.status = this.status
    if (Number.isFinite(this.providerRetryAfterMs) && this.providerRetryAfterMs > 0) {
      failure.providerRetryAfterMs = this.providerRetryAfterMs
    }
    if (typeof this.requestId === 'string' && this.requestId) failure.requestId = this.requestId
    return failure
  }

  /** JSON view used by the HTTP routes; safe to show a user directly. */
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.status ? { status: this.status } : {}),
      ...(this.reason ? { reason: this.reason } : {}),
      ...(this.stage ? { stage: this.stage } : {}),
      ...(this.requestId ? { requestId: this.requestId } : {}),
    }
  }
}

/**
 * Classify an upstream HTTP answer into the plugin taxonomy.
 *
 * The `fallback` flag is the one the surface walk acts on, and it is narrower
 * than `retryable`: a 429 is retryable on the same host after a wait, while a
 * 401/403/404 says the credential and the host do not belong together. Only
 * `fallback` moves to the next surface.
 */
export function classifyUpstream(status, body) {
  const text = typeof body === 'string' ? body : ''
  // A gateway error page is not a diagnosis: keep the first line and a bounded
  // length, because this message is what the user reads in the error toast.
  const summarize = value => String(value || '').replace(/\s+/gu, ' ').trim().slice(0, 400)
  let reason = ''
  let message = text || `HTTP ${status}`
  try {
    const parsed = JSON.parse(text)
    reason = String(parsed?.reason || parsed?.reasonCode || parsed?.__type || parsed?.code || parsed?.message || '').toUpperCase()
    message = summarize(parsed?.message || parsed?.Message || message)
  } catch {
    reason = /accessunauthorizedexception|unauthorized/iu.test(text) ? 'UNAUTHORIZED' : ''
  }
  const base = { message: summarize(message), reason }
  if (status === 401 || status === 403 || reason.includes('UNAUTHORIZED') || /bearer token invalid/iu.test(message)) {
    return { ...base, code: ERROR_CODES.auth, retryable: true, fallback: true }
  }
  if (status === 404) return { ...base, code: ERROR_CODES.endpoint, retryable: true, fallback: true }
  if (status === 429 || reason.includes('THROTTL')) return { ...base, code: ERROR_CODES.rateLimit, retryable: true, fallback: true }
  if (status === 402 || /quota|insufficient|credit balance/iu.test(message)) {
    return { ...base, code: ERROR_CODES.quota, retryable: false, fallback: false }
  }
  // Kiro names a rejected model id in the message rather than a reason code, and
  // "this model id does not exist here" deserves its own diagnosis: the caller can
  // pick another model instead of retrying a body every host will refuse.
  if (status === 400 && (reason.includes('INVALID_MODEL') || /model.*(not|unavailable|invalid)|invalid model identifier/iu.test(message))) {
    return { ...base, code: ERROR_CODES.modelUnavailable, retryable: false, fallback: false }
  }
  // A 400 naming a payload problem is terminal: the next host would refuse the
  // same body, and walking every surface only buries the real cause.
  if (status === 400) return { ...base, code: ERROR_CODES.badRequest, retryable: false, fallback: false }
  if (status >= 500) return { ...base, code: ERROR_CODES.upstream, retryable: true, fallback: true }
  return { ...base, code: ERROR_CODES.upstream, retryable: false, fallback: false }
}

/** Keep the message one line and bounded: a full HTML error page is not a diagnosis. */
function summarize(status, message, details) {
  const firstLine = String(message || '').replace(/\s+/gu, ' ').trim().slice(0, 400)
  const stage = details.stage ? `${details.stage}: ` : ''
  const reason = details.reason ? ` [${details.reason}]` : ''
  return `${stage}Kiro answered ${status}${reason}: ${firstLine || 'no message'}`
}

/** Wrap any thrown value as a KiroError, preserving the original as `cause`. */
export function asKiroError(error, fallbackCode = ERROR_CODES.upstream) {
  if (error instanceof KiroError) return error
  const code = error?.name === 'AbortError' ? ERROR_CODES.aborted : fallbackCode
  const wrapped = new KiroError(error?.message || String(error), code, {
    ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
    ...(typeof error?.requestId === 'string' ? { requestId: error.requestId } : {}),
  })
  return Object.assign(wrapped, { cause: error })
}

/**
 * Attach a stage to an already-built error so a log line says which phase broke.
 * A control-plane failure must not read as "the model is unavailable".
 */
export function assertAfterStatus(error, stage) {
  if (!error || typeof error !== 'object') return error
  if (error instanceof KiroError) {
    if (!error.stage) error.stage = stage
    if (/Kiro answered \d+/u.test(error.message) === false && !error.message.startsWith(`${stage}:`)) {
      error.message = `${stage}: ${error.message}`
    }
    return error
  }
  throw error
}

/** Plain-object form for HTTP replies, so a client never sees a stack. */
export function errorPayload(error) {
  if (error instanceof KiroError) return error.toJSON()
  return {
    code: error?.code || ERROR_CODES.upstream,
    message: String(error?.message || error || 'unknown error').slice(0, 500),
    ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
  }
}
