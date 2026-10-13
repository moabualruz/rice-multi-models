// One authenticated local HTTP server per Claude Code session. Requests use a private Unix socket
// on macOS/Linux or a random Windows named pipe; the random token travels only in request bodies.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { StepEvent, StepWire } from '../hooks/protocol.ts'
import { failedStep } from '../hooks/protocol.ts'
import { runStep } from './run.ts'
import { SocketPool } from './socket.ts'
import { withLocalSocketPath } from './core/local-socket.ts'

const MAX_IN_FLIGHT = 64

function sameToken(given: unknown, token: string): boolean {
  if (typeof given !== 'string') return false
  const bytes = Buffer.from(given)
  const expected = Buffer.from(token)
  return bytes.length === expected.length && timingSafeEqual(bytes, expected)
}

async function writeEvent(response: ServerResponse, event: StepEvent): Promise<void> {
  if (response.destroyed) throw new Error('caller disconnected')
  if (response.write(`${JSON.stringify(event)}\n`)) return
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { response.off('drain', drained); response.off('close', closed); response.off('error', failed) }
    const drained = () => { cleanup(); resolve() }
    const closed = () => { cleanup(); reject(new Error('caller disconnected')) }
    const failed = (error: Error) => { cleanup(); reject(error) }
    response.once('drain', drained)
    response.once('close', closed)
    response.once('error', failed)
  })
}

export function serve(lifetime?: AbortSignal): void {
  const dir = process.platform === 'win32' ? undefined : mkdtempSync(join(tmpdir(), 'rice-mm-'))
  if (dir) chmodSync(dir, 0o700)
  const socketPath = dir ? join(dir, 'h.sock') : `\\\\.\\pipe\\rice-mm-${process.pid}-${randomBytes(16).toString('hex')}`
  const token = randomBytes(32).toString('hex')
  const pool = new SocketPool()
  const parent = process.ppid
  const active = new Map<AbortController, Promise<void>>()
  let inFlight = 0
  const server = createServer(async (request, response) => {
    try {
      const path = request.url?.split('?')[0]
      if (request.method !== 'POST' || (path !== '/step' && path !== '/status')) {
        response.writeHead(404).end('not found')
        return
      }
      let wire: StepWire
      try {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        wire = JSON.parse(Buffer.concat(chunks).toString('utf8')) as StepWire
        if (!wire || typeof wire !== 'object') throw new Error('not an object')
      } catch {
        response.writeHead(400).end('bad request')
        return
      }
      if (!sameToken(wire.token, token)) { response.writeHead(401).end('unauthorized'); return }
      if (path === '/status') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ pid: process.pid, inFlight, sockets: pool.size }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/x-ndjson' })
      response.flushHeaders()
      if (inFlight >= MAX_IN_FLIGHT) {
        for (const event of failedStep('rice-multi-models: too many steps at once; retry')) await writeEvent(response, event)
        response.end()
        return
      }
      const controller = new AbortController()
      const abort = () => { if (!response.writableEnded) controller.abort() }
      response.on('close', abort)
      let finished!: () => void
      active.set(controller, new Promise<void>(resolve => { finished = resolve }))
      inFlight += 1
      const keepAlive = setInterval(() => { if (!response.destroyed) response.write('\n') }, 5_000)
      try {
        for await (const event of runStep({ ...wire, token: undefined }, controller.signal, { pool })) await writeEvent(response, event)
      } catch (error) {
        if (!response.destroyed) for (const event of failedStep(`rice-multi-models: ${error instanceof Error ? error.message : String(error)}`)) await writeEvent(response, event)
      } finally {
        clearInterval(keepAlive)
        inFlight -= 1
        active.delete(controller)
        finished()
        response.off('close', abort)
        response.end()
      }
    } catch {
      // The peer may disappear while either the request or streamed response is being read.
      response.destroy()
    }
  })
  // Long reasoning streams may be quiet for minutes; provider timers, not HTTP idle timers, own them.
  server.requestTimeout = 0
  server.timeout = 0
  const cleanup = () => { if (dir) rmSync(dir, { recursive: true, force: true }) }
  let stopped = false
  const stop = async (exitCode = 0) => {
    if (stopped) return
    stopped = true
    const pending = [...active.values()]
    for (const controller of active.keys()) controller.abort()
    pool.closeAll()
    server.closeAllConnections()
    withLocalSocketPath(socketPath, () => server.close())
    await Promise.all(pending)
    cleanup()
    process.exit(exitCode)
  }
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => { void stop() })
  lifetime?.addEventListener('abort', () => { void stop(1) }, { once: true })
  server.once('error', () => {
    cleanup()
    process.stderr.write('rice-multi-models: local helper could not listen\n')
    process.exit(2)
  })
  withLocalSocketPath(socketPath, path => server.listen(path, () => {
    if (dir) chmodSync(socketPath, 0o600)
    setInterval(() => {
      pool.sweep()
      if (process.ppid !== parent) stop()
    }, 5_000)
    process.stdout.write(`ready ${JSON.stringify({ socketPath, token })}\n`)
  }))
}
