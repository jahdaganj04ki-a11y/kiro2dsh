/**
 * AWS EventStream framing — the binary half of why this protocol is hard to reuse.
 *
 * Kiro answers with `application/vnd.amazon.eventstream`: a length-prefixed binary
 * frame per event, CRC-32 checked twice, delivered over HTTP in chunks that do not
 * respect frame boundaries. A JSON parser cannot read it, and a naive reader that
 * assumes one chunk is one event breaks on every real connection.
 *
 * @module test/eventstream.test.js
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { EventStreamParser, crc32, encodeEventFrame, parseEventFrame } from '../lib/kiro/eventstream.js'
import { EVENTSTREAM_MAX_MESSAGE_BYTES } from '../lib/constants.js'
import { concat, frame } from './helpers.js'

test('crc32 matches the standard vector', () => {
  // The frame check is CRC-32 as AWS specifies it: if this drifts, every frame
  // rejects and no turn ever starts.
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926)
  assert.equal(crc32(new Uint8Array(0)), 0)
})

test('a frame round-trips through encode and parse', () => {
  const bytes = encodeEventFrame({ ':message-type': 'event', ':event-type': 'assistantResponseEvent' }, { content: 'hallo' })
  const parsed = parseEventFrame(bytes)
  assert.equal(parsed.headers[':event-type'], 'assistantResponseEvent')
  assert.deepEqual(parsed.payload, { content: 'hallo' })
})

test('a corrupted payload CRC is rejected', () => {
  const bytes = encodeEventFrame({ ':message-type': 'event' }, { content: 'hallo' })
  bytes[bytes.length - 5] ^= 0xff
  assert.throws(() => parseEventFrame(bytes), /CRC/iu)
})

test('frames are split out of arbitrary chunk boundaries', () => {
  const stream = concat([
    frame('assistantResponseEvent', { content: 'a' }),
    frame('assistantResponseEvent', { content: 'b' }),
    frame('messageStopEvent', { stopReason: 'end_turn' }),
  ])
  const parser = new EventStreamParser()
  const seen = []
  // One byte at a time: the worst case a socket can hand over.
  for (let index = 0; index < stream.byteLength; index++) {
    for (const item of parser.push(stream.subarray(index, index + 1))) seen.push(item.payload)
  }
  assert.deepEqual(seen, [{ content: 'a' }, { content: 'b' }, { stopReason: 'end_turn' }])
  assert.equal(parser.finish(), null)
})

test('an empty frame carries no payload', () => {
  const parser = new EventStreamParser()
  const [first] = parser.push(frame('pingEvent', null))
  assert.equal(first.payload, null)
  assert.equal(first.headers[':event-type'], 'pingEvent')
})

test('a truncated tail is dropped, not guessed at', () => {
  const parser = new EventStreamParser()
  const good = frame('assistantResponseEvent', { content: 'x' })
  const cut = concat([good, good]).subarray(0, good.byteLength + 8)
  const frames = parser.push(cut)
  assert.equal(frames.length, 1, 'only the complete frame may be delivered')
  assert.match(parser.finish().message, /truncated|incomplete|bounds|CRC/iu)
})

test('an oversized declared frame fails instead of buffering forever', () => {
  const parser = new EventStreamParser({ maxMessageBytes: 64 })
  const bytes = encodeEventFrame({ ':message-type': 'event', ':event-type': 'assistantResponseEvent' }, { content: 'x'.repeat(500) })
  const frames = parser.push(bytes.subarray(0, 16))
  assert.equal(frames.length, 0)
  assert.match(parser.finish().message, /bound|exceed/iu)
})

test('a hostile prelude length is refused before allocation', () => {
  const bytes = new Uint8Array(16)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0xfffffff0, false)
  view.setUint32(4, 0xfffffff0, false)
  view.setUint32(8, crc32(bytes.subarray(0, 8)), false)
  const parser = new EventStreamParser({ maxMessageBytes: EVENTSTREAM_MAX_MESSAGE_BYTES })
  parser.push(bytes)
  assert.match(parser.finish().message, /bound|exceed|invalid/iu)
})

test('a duplicate header is rejected', () => {
  const name = new TextEncoder().encode(':message-type')
  const header = (valueLength, value) => {
    const out = new Uint8Array(1 + name.byteLength + 1 + 2 + valueLength)
    const view = new DataView(out.buffer)
    out[0] = name.byteLength
    out.set(name, 1)
    out[1 + name.byteLength] = 7
    view.setUint16(2 + name.byteLength, valueLength, false)
    out.set(new TextEncoder().encode(value), 4 + name.byteLength)
    return out
  }
  const headers = concat([header(5, 'event'), header(5, 'event')])
  const payload = new Uint8Array(0)
  const total = 16 + headers.byteLength + payload.byteLength + 4
  const bytes = new Uint8Array(total)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, total, false)
  view.setUint32(4, headers.byteLength, false)
  view.setUint32(8, crc32(bytes.subarray(0, 8)), false)
  bytes.set(headers, 12)
  const preCrc = 16 + headers.byteLength + payload.byteLength
  view.setUint32(total - 4, crc32(bytes.subarray(0, preCrc)), false)
  assert.throws(() => parseEventFrame(bytes), /duplicate header/iu)
})
