/**
 * Small shared helpers: text plumbing, header plumbing, digests, and the JWT peek
 * the credential flows use. Kept free of harness imports so every module under
 * `lib/` can be unit-tested on its own. The failure taxonomy lives in
 * {@link module:lib/errors}.
 *
 * @module lib/util
 */

import { createHash } from 'node:crypto'

/**
 * Render any value as model-facing text.
 * Objects fall back to JSON so a structured tool result never arrives as
 * `[object Object]`, which Kiro would answer with an unusable turn.
 */
export function text(value) {
  if (typeof value === 'string') return value
  if (value == null) return ''
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join('\n')
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Truncate by code points, never splitting an emoji in half. */
export function trimCodePoints(value, limit) {
  return [...String(value ?? '')].slice(0, limit).join('')
}

/** Clamp to an inclusive integer range. */
export function clamp(value, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return min
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

/** Positive-integer coercion, with a fallback for garbage configuration values. */
export function positiveInt(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.trunc(number)
}

/** Case-insensitive header lookup over plain objects, `Map`s and `Headers`. */
export function pickHeader(headers, name) {
  if (!headers) return undefined
  if (typeof headers.get === 'function') return headers.get(name) ?? undefined
  if (typeof headers.entries === 'function') {
    for (const [key, value] of headers.entries()) if (key.toLowerCase() === name.toLowerCase()) return value
    return undefined
  }
  const lower = String(name).toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key]
  }
  return undefined
}

/** Merge header records, dropping case-insensitive collisions from earlier entries. */
export function mergeHeaders(...records) {
  const merged = {}
  const seen = new Map()
  for (const record of records) {
    if (!record) continue
    for (const [name, value] of Object.entries(record)) {
      if (value === undefined || value === null || value === '') continue
      const lower = name.toLowerCase()
      if (seen.has(lower)) delete merged[seen.get(lower)]
      merged[name] = String(value)
      seen.set(lower, name)
    }
  }
  return merged
}

/** Parse JSON without throwing; used for model-supplied tool arguments. */
export function parseJson(value, fallback = null) {
  if (value && typeof value === 'object') return value
  if (typeof value !== 'string') return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

/** SHA-256 hex digest; used for the stable machine id and cache keys. */
export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

/** First 32 hex chars of a digest — enough entropy for a fingerprint, short enough for a UA. */
export function fingerprint(value) {
  return sha256(value).slice(0, 32)
}

/** Decode a JWT payload without verifying it (display and expiry hints only). */
export function decodeJwtPayload(jwt) {
  if (typeof jwt !== 'string') return null
  const parts = jwt.split('.')
  if (parts.length !== 3) return null
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padding = (4 - (base64.length % 4)) % 4
    return JSON.parse(Buffer.from(`${base64}${'='.repeat(padding)}`, 'base64').toString('utf8'))
  } catch {
    return null
  }
}

/** Account identity for a credential record, preferring a real mailbox. */
export function identityFromAccessToken(accessToken) {
  const payload = decodeJwtPayload(accessToken)
  if (!payload) return null
  return payload.email || payload.preferred_username || payload.upn || payload.sub || null
}

/** `exp` claim in epoch milliseconds, when the token carries one. */
export function expiryFromAccessToken(accessToken) {
  const payload = decodeJwtPayload(accessToken)
  const exp = Number(payload?.exp)
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : undefined
}

/** RFC 3339 timestamp from epoch milliseconds. */
export function toIso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

/** Base64 of bytes or a base64 string, without re-encoding when already encoded. */
export function toBase64(value) {
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  if (Buffer.isBuffer(value)) return value.toString('base64')
  throw new TypeError('expected a string, Buffer or Uint8Array')
}

/** Await `promise` but settle as soon as `signal` aborts. */
export async function withAbort(promise, signal, message = 'aborted') {
  if (!signal) return promise
  if (signal.aborted) throw Object.assign(new Error(message), { name: 'AbortError' })
  return await new Promise((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error(message), { name: 'AbortError' }))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/** Delay that respects cancellation, so backoff never outlives the caller's signal. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve(false)
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/**
 * Parse a `retry-after` header into milliseconds.
 * Capped so an absurd upstream value cannot stall a turn: a client that waits
 * five minutes looks like a hung harness, not like backoff.
 */
export function retryAfterHeaderMs(response, maxMs = 20_000) {
  const header = typeof response?.headers?.get === 'function' ? response.headers.get('retry-after') : null
  if (!header) return 0
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.round(seconds * 1000), maxMs)
  const date = Date.parse(header)
  if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), maxMs)
  return 0
}

/** Bounded text read of an error response body: never let a 40 MB page reach a log. */
export async function readBodyPrefix(response, maxBytes = 4096) {
  if (!response?.body) return ''
  try {
    const cap = Math.max(0, Math.trunc(maxBytes))
    if (typeof response.text === 'function' && response.bodyUsed === false) {
      const clone = response.clone?.() ?? response
      const raw = await clone.text()
      return raw.length > cap ? `${raw.slice(0, cap)}…` : raw
    }
    const reader = response.body.getReader()
    const chunks = []
    let total = 0
    while (total < cap) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value?.byteLength ?? 0
    }
    await reader.cancel().catch(() => {})
    return Buffer.concat(chunks.map(chunk => Buffer.from(chunk ?? new Uint8Array(0)))).subarray(0, cap).toString('utf8')
  } catch {
    return ''
  }
}

/** Strip obvious secrets from a value before it is logged or shown in the UI. */
export function redact(value) {
  if (typeof value !== 'string') return value
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gu, '$1[redacted]')
    .replace(/("?(?:accessToken|access_token|refreshToken|refresh_token|clientSecret|client_secret|apiKey|api_key|token)"?\s*[:=]\s*")[^"]{6,}("[^,}]*)/giu, '$1[redacted]$2')
}

/** Deep-plain-JSON clone: configuration snapshots must not alias live objects. */
export function detach(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/** Structural JSON equality, used to skip no-op re-registrations. */
export function deepEqualJson(left, right) {
  if (left === right) return true
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}
