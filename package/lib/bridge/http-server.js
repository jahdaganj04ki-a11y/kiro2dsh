/**
 * Loopback HTTP server for the bridge.
 *
 * The router is format logic; this file is the carrier. It exists as its own
 * module for two reasons: a harness that lets a plugin register a route can call
 * `createBridgeRouter` directly and skip everything below, and the parts that
 * *are* specific to serving sockets — flushing SSE without buffering, aborting
 * the Kiro stream when the client hangs up, refusing to bind a public interface
 * without a token — are exactly the parts you want to be able to read in one place.
 *
 * @module lib/bridge/http-server.js
 */

import { createServer } from 'node:http'

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'content-length'])

/** Response headers every bridge reply carries. */
const CORS_HEADERS = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Api-Key, X-Anthropic-Version, Anthropic-Version, Anthropic-Beta',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Max-Age': '600',
})

/**
 * Convert a Node request into the fetch `Request` the router speaks.
 * @param {import('node:http').IncomingMessage} req
 * @param {Buffer} [body] buffered payload for non-streaming methods
 */
function toRequest(req, baseUrl, body, signal) {
  const url = new URL(req.url || '/', baseUrl)
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    headers.append(name, Array.isArray(value) ? value.join(', ') : value)
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  return new Request(url.toString(), {
    method: req.method,
    headers,
    ...(hasBody ? { body: body && body.length > 0 ? body : undefined } : {}),
    ...(signal ? { signal } : {}),
  })
}

/**
 * Create the bridge server.
 *
 * @param {{
 *   handle: (request: Request) => Promise<Response>,
 *   host?: string,
 *   port?: number,
 *   log?: object,
 *   settings?: () => object,
 * }} options `port: 0` (default) lets the OS pick a free port.
 * @returns {{
 *   start(): Promise<{ host: string, port: number, url: string }>,
 *   stop(): Promise<void>,
 *   address(): { host: string, port: number, url: string } | null,
 *   setHandle(handle: (request: Request) => Promise<Response>): void,
 * }}
 */
export function createBridgeServer(options) {
  const host = options.host || '127.0.0.1'
  const wantedPort = Number.isInteger(options.port) ? options.port : 0
  const log = options.log
  let handle = options.handle
  let server = null
  let bound = null
  /** Requests still writing, so `stop()` can wait for them. */
  const inflight = new Set()

  const assertBindable = () => {
    const settings = options.settings?.() || {}
    const token = String(settings?.bridgeToken || settings?.privateAccessToken || '').trim()
    if (!isLoopbackHost(host) && !token) {
      throw new Error('the Kiro bridge refuses to bind a non-loopback host without a bridge token')
    }
  }

  const dispatch = async (req, res) => {
    const started = Date.now()
    inflight.add(res)
    const controller = new AbortController()
    req.on('aborted', () => controller.abort(new Error('client disconnected')))
    res.on('close', () => {
      if (!res.writableEnded) controller.abort(new Error('client disconnected'))
      inflight.delete(res)
    })
    try {
      const body = req.method === 'GET' || req.method === 'HEAD' ? null : await readPayload(req)
      // The abort signal travels with the request: without it a client that
      // hangs up leaves Kiro generating a turn nobody reads.
      const request = toRequest(req, `http://${authority(req, host)}`, body, controller.signal)
      const response = await handle(request)
      res.writeHead(response.status, plainHeaders(response.headers))
      if (!response.body) {
        res.end()
        return
      }
      const reader = response.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (res.destroyed || !res.write(value)) await once(res, 'drain')
      }
      res.end()
      log?.debug?.(`kiro: bridge ${req.method} ${req.url} ${response.status} in ${Date.now() - started}ms`)
    } catch (error) {
      // Headers may already be out (the usual case for SSE), so the only safe
      // signal left is to end the stream — the client sees a truncated body.
      if (!res.headersSent) {
        const status = statusFor(error)
        res.writeHead(status, { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: { message: error?.message || String(error), type: status >= 500 ? 'upstream_error' : 'invalid_request_error', code: error?.code || null } }))
      } else {
        res.end()
      }
      log?.warn?.(`kiro: bridge ${req.method} ${req.url} failed: ${error?.message || error}`)
    } finally {
      inflight.delete(res)
    }
  }

  return {
    async start() {
      if (server) return bound
      assertBindable()
      server = createServer((req, res) => {
        void dispatch(req, res)
      })
      server.keepAliveTimeout = 5_000
      server.headersTimeout = 60_000
      server.requestTimeout = 0
      await listen(server, wantedPort, host)
      const info = server.address()
      bound = {
        host,
        port: typeof info === 'object' && info ? info.port : wantedPort,
        url: `http://${isLoopbackHost(host) ? '127.0.0.1' : host}:${typeof info === 'object' && info ? info.port : wantedPort}`,
      }
      const settings = options.settings?.() || {}
      log?.info?.(`kiro: bridge listening on ${bound.url} (${isLoopbackHost(host) ? 'loopback' : host}${String(settings.bridgeToken || settings.privateAccessToken || '').trim() ? ', token protected' : ', no token'})`)
      return bound
    },
    async stop() {
      if (!server) return
      const closing = server.closeAllConnections ? Promise.resolve(server.closeAllConnections()) : null
      await Promise.resolve(closing)
      for (const res of inflight) {
        try {
          res.end()
        } catch {
          /* already gone */
        }
      }
      await new Promise(resolve => server.close(() => resolve()))
      server = null
      bound = null
    },
    address: () => bound,
    setHandle(next) {
      handle = next
    },
    assertBindable,
  }
}

/** Wait for `listen`, mapping EADDRINUSE onto the next port when the caller was specific. */
async function listen(server, port, host) {
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.off('error', reject)
        resolve()
      })
    })
  } catch (error) {
    if (error?.code === 'EADDRINUSE' && port > 0) {
      // A fixed port is a user promise, so try a handful above it before giving
      // up: the common cause is another agent holding 52469, not a typo.
      for (let attempt = 1; attempt <= 8; attempt++) {
        try {
          await new Promise((resolve, reject) => {
            server.once('error', reject)
            server.listen(port + attempt, host, () => {
              server.off('error', reject)
              resolve()
            })
          })
          return
        } catch (retry) {
          if (retry?.code !== 'EADDRINUSE') throw retry
        }
      }
    }
    throw error
  }
}

/** Read a request body with a ceiling, so a stray client cannot exhaust memory. */
async function readPayload(req, maxBytes = 32 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new Error('request body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function once(emitter, event) {
  return new Promise(resolve => emitter.once(event, resolve))
}

/** Host used in the synthetic URL — the real one matters for vhost-aware routers. */
function authority(req, fallbackHost) {
  const header = req.headers.host
  if (typeof header === 'string' && header) return header
  return `${isLoopbackHost(fallbackHost) ? '127.0.0.1' : fallbackHost}:0`
}

/** Fetch headers → a plain object, minus what Node's http layer owns. */
function plainHeaders(headers) {
  const out = { ...CORS_HEADERS }
  for (const [name, value] of headers.entries()) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue
    out[name] = value
  }
  return out
}

function statusFor(error) {
  if (Number.isInteger(error?.status)) return error.status
  const code = error?.code
  if (code === 'auth' || code === 'kiro_not_configured' || code === 'kiro_refresh_expired') return 401
  if (code === 'rejected') return 400
  if (code === 'rate_limit') return 429
  return 502
}

/** True for the addresses that cannot be reached from another machine. */
export function isLoopbackHost(host) {
  const value = String(host || '').toLowerCase().replace(/^\[|\]$/g, '')
  return value === 'localhost' || value === '::1' || value.startsWith('127.')
}
