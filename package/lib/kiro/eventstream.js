/**
 * AWS EventStream framing (`application/vnd.amazon.eventstream`).
 *
 * Kiro does not answer with JSON or SSE: the streamed reply is a sequence of
 * binary prefixed messages, each with two CRC-32 checksums. A silently
 * truncated or spliced frame becomes a silently truncated model answer, so
 * every frame is validated here and a mismatch is a hard failure rather than a
 * partial result.
 *
 * Frame layout:
 *   [totalLength u32][headersLength u32][preludeCrc u32][headers][payload][messageCrc u32]
 *
 * @module lib/kiro/eventstream
 */

import { EVENTSTREAM_MAX_HEADERS_BYTES, EVENTSTREAM_MAX_MESSAGE_BYTES } from '../constants.js'

const decoder = new TextDecoder()

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) {
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  }
  return value >>> 0
})

/** CRC-32 (IEEE) over bytes, as the EventStream prelude and trailer require. */
export function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Decode exactly one complete frame.
 * @param {Uint8Array} data one frame, `totalLength` bytes long
 * @param {{maxMessageBytes?: number, maxHeadersBytes?: number}} [limits]
 * @returns {{ headers: Record<string, unknown>, payload: object | null }}
 * @throws on any length, bounds, CRC, duplicate-header or payload-JSON problem
 */
export function parseEventFrame(data, limits = {}) {
  const maxMessageBytes = limits.maxMessageBytes ?? EVENTSTREAM_MAX_MESSAGE_BYTES
  const maxHeadersBytes = limits.maxHeadersBytes ?? EVENTSTREAM_MAX_HEADERS_BYTES

  if (!(data instanceof Uint8Array) || data.byteLength < 16) {
    throw new Error('AWS EventStream frame is shorter than 16 bytes')
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const totalLength = view.getUint32(0, false)
  const headersLength = view.getUint32(4, false)
  if (totalLength !== data.byteLength) {
    throw new Error('AWS EventStream frame length does not match its prelude')
  }
  if (totalLength > maxMessageBytes || headersLength > maxHeadersBytes || headersLength > totalLength - 16) {
    throw new Error('AWS EventStream frame bounds are invalid')
  }
  if (view.getUint32(8, false) !== crc32(data.subarray(0, 8))) {
    throw new Error('AWS EventStream prelude CRC mismatch')
  }
  if (view.getUint32(totalLength - 4, false) !== crc32(data.subarray(0, totalLength - 4))) {
    throw new Error('AWS EventStream message CRC mismatch')
  }

  const headers = Object.create(null)
  const names = new Set()
  let offset = 12
  const headerEnd = 12 + headersLength
  const requireBytes = count => {
    if (offset + count > headerEnd) throw new Error('AWS EventStream header exceeds its declared bounds')
  }

  while (offset < headerEnd) {
    requireBytes(1)
    const nameLength = data[offset++]
    requireBytes(nameLength + 1)
    const name = decoder.decode(data.subarray(offset, offset + nameLength))
    offset += nameLength
    if (names.has(name)) throw new Error(`AWS EventStream contains duplicate header: ${name}`)
    names.add(name)
    const type = data[offset++]
    if (type === 0 || type === 1) {
      headers[name] = type === 0
    } else if (type === 2) {
      requireBytes(1)
      headers[name] = view.getInt8(offset)
      offset += 1
    } else if (type === 3) {
      requireBytes(2)
      headers[name] = view.getInt16(offset, false)
      offset += 2
    } else if (type === 4) {
      requireBytes(4)
      headers[name] = view.getInt32(offset, false)
      offset += 4
    } else if (type === 5 || type === 8) {
      // byte[]/timestamp values carry no meaning for the model response.
      requireBytes(8)
      offset += 8
    } else if (type === 6 || type === 7) {
      requireBytes(2)
      const valueLength = view.getUint16(offset, false)
      offset += 2
      requireBytes(valueLength)
      const bytes = data.subarray(offset, offset + valueLength)
      headers[name] = type === 7 ? decoder.decode(bytes) : bytes
      offset += valueLength
    } else if (type === 9) {
      requireBytes(16)
      offset += 16
    } else {
      throw new Error(`AWS EventStream header ${name} has unknown type ${type}`)
    }
  }

  const payloadBytes = data.subarray(headerEnd, totalLength - 4)
  if (payloadBytes.byteLength === 0) return { headers, payload: null }
  const payloadText = decoder.decode(payloadBytes)
  if (!payloadText.trim()) return { headers, payload: null }
  try {
    return { headers, payload: JSON.parse(payloadText) }
  } catch (error) {
    throw new Error(`AWS EventStream payload is not valid JSON (${error.message})`)
  }
}

/**
 * Encode one frame. Test fixtures and the fake upstream use this; nothing on
 * the request path emits EventStream. It lives beside the decoder so the two
 * cannot drift apart.
 */
export function encodeEventFrame(headers = {}, payload = null) {
  const encoder = new TextEncoder()
  const headerChunks = Object.entries(headers).map(([name, value]) => {
    const nameBytes = encoder.encode(name)
    const valueBytes = encoder.encode(String(value))
    const chunk = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length)
    const chunkView = new DataView(chunk.buffer)
    let cursor = 0
    chunk[cursor++] = nameBytes.length
    chunk.set(nameBytes, cursor)
    cursor += nameBytes.length
    chunk[cursor++] = 7
    chunkView.setUint16(cursor, valueBytes.length, false)
    cursor += 2
    chunk.set(valueBytes, cursor)
    return chunk
  })
  const headersLength = headerChunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const payloadBytes = payload === null ? new Uint8Array(0) : encoder.encode(JSON.stringify(payload))
  const totalLength = 16 + headersLength + payloadBytes.length

  const frame = new Uint8Array(totalLength)
  const view = new DataView(frame.buffer)
  view.setUint32(0, totalLength, false)
  view.setUint32(4, headersLength, false)
  view.setUint32(8, crc32(frame.subarray(0, 8)), false)
  let offset = 12
  for (const chunk of headerChunks) {
    frame.set(chunk, offset)
    offset += chunk.length
  }
  frame.set(payloadBytes, offset)
  view.setUint32(totalLength - 4, crc32(frame.subarray(0, totalLength - 4)), false)
  return frame
}

/**
 * Incremental frame splitter.
 *
 * TCP gives the reader arbitrary slices, so buffering, bounds checking and
 * CRC validation of the 12-byte prelude happen before a length is trusted. The
 * splitter yields complete frames only and reports the first corrupt position
 * as an error, because skipping a frame would silently drop model content.
 */
export class EventStreamParser {
  /**
   * @param {{maxMessageBytes?: number, maxHeadersBytes?: number, onFrame?: (frame: {headers: object, payload: object|null}) => boolean | void}} [options]
   */
  constructor(options = {}) {
    this.options = options
    this.maxMessageBytes = options.maxMessageBytes ?? EVENTSTREAM_MAX_MESSAGE_BYTES
    this.maxHeadersBytes = options.maxHeadersBytes ?? EVENTSTREAM_MAX_HEADERS_BYTES
    this.buffer = new Uint8Array(0)
    this.failed = null
  }

  /** Feed one network chunk; returns the frames completed by it. */
  push(chunk) {
    const frames = []
    if (this.failed) return frames
    if (chunk && chunk.byteLength > 0) {
      const combined = new Uint8Array(this.buffer.byteLength + chunk.byteLength)
      combined.set(this.buffer)
      combined.set(chunk, this.buffer.byteLength)
      if (combined.byteLength > this.maxMessageBytes * 2) {
        return this.fail('AWS EventStream buffered bytes exceed the protocol bound', frames)
      }
      this.buffer = combined
    }

    while (this.buffer.byteLength >= 12) {
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset)
      if (view.getUint32(8, false) !== crc32(this.buffer.subarray(0, 8))) {
        return this.fail('AWS EventStream prelude CRC mismatch', frames)
      }
      const totalLength = view.getUint32(0, false)
      const headersLength = view.getUint32(4, false)
      if (
        totalLength < 16
        || totalLength > this.maxMessageBytes
        || headersLength > this.maxHeadersBytes
        || headersLength > totalLength - 16
      ) {
        return this.fail('AWS EventStream frame bounds are invalid', frames)
      }
      if (this.buffer.byteLength < totalLength) break
      const frameBytes = this.buffer.slice(0, totalLength)
      this.buffer = this.buffer.slice(totalLength)
      let frame
      try {
        frame = parseEventFrame(frameBytes, {
          maxMessageBytes: this.maxMessageBytes,
          maxHeadersBytes: this.maxHeadersBytes,
        })
      } catch (error) {
        return this.fail(error.message, frames)
      }
      this.options.onFrame?.(frame)
      frames.push(frame)
    }
    return frames
  }

  /**
   * Signal that the transport ended: a leftover partial frame is truncation, and
   * an earlier failure stays reported.
   *
   * The sticky case is the important one. A frame that broke the size bound has
   * already discarded its buffer, so if `finish()` reported success the caller
   * would read a truncated answer as a complete turn — the one failure mode this
   * protocol must never allow.
   */
  finish() {
    if (this.failed) return this.failed
    if (this.buffer.byteLength > 0) {
      this.fail('AWS EventStream ended with a truncated frame', [])
      return this.failed
    }
    return null
  }

  fail(message, frames) {
    this.failed = { message }
    this.buffer = new Uint8Array(0)
    return frames
  }
}
