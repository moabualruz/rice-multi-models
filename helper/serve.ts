// The session helper: one per Claude Code session, started by the mod at session start. It serves steps
// over a Unix socket in a private (0700) folder; every call must carry the random token it printed for the
// mod, which travels only in request bodies. It keeps one Codex WebSocket per conversation open between
// steps, carries nothing but routed requests, and exits when Claude Code does.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { StepEvent, StepWire } from '../hooks/protocol.ts'
import { failedStep } from '../hooks/protocol.ts'
import { runStep } from './run.ts'
import { SocketPool } from './socket.ts'

const MAX_IN_FLIGHT = 16
const encoder = new TextEncoder()

function sameToken(given: unknown, token: string): boolean {
  if (typeof given !== 'string' || given.length !== token.length) return false

  return timingSafeEqual(Buffer.from(given), Buffer.from(token))
}

const line = (event: StepEvent) => encoder.encode(`${JSON.stringify(event)}\n`)

export function serve(): void {
  const dir = mkdtempSync(join(tmpdir(), 'rice-mm-'))
  const socketPath = join(dir, 'h.sock')
  const token = randomBytes(32).toString('hex')
  const pool = new SocketPool()
  const parent = process.ppid
  let inFlight = 0
  const options = {
    unix: socketPath,
    // Long reasoning may send nothing for minutes. Bun's types do not take idleTimeout for a Unix socket,
    // though Bun honours it; the keep-alive lines below cover a runtime that would not.
    idleTimeout: 0,
    async fetch(request: Request): Promise<Response> {
      const path = new URL(request.url).pathname
      if (request.method !== 'POST' || (path !== '/step' && path !== '/status')) return new Response('not found', { status: 404 })
      let wire: StepWire
      try {
        wire = (await request.json()) as StepWire
      } catch {
        return new Response('bad request', { status: 400 })
      }
      if (!sameToken(wire.token, token)) return new Response('unauthorized', { status: 401 })
      if (path === '/status') return Response.json({ pid: process.pid, inFlight, sockets: pool.size })
      if (inFlight >= MAX_IN_FLIGHT) return new Response(failedStep('rice-multi-models: too many steps at once; retry').map(event => JSON.stringify(event)).join('\n'))
      const controller = new AbortController()
      request.signal.addEventListener('abort', () => controller.abort(), { once: true })
      inFlight += 1
      const body = new ReadableStream<Uint8Array>({
        async start(sink) {
          const keepAlive = setInterval(() => {
            try {
              sink.enqueue(encoder.encode('\n'))
            } catch {
              clearInterval(keepAlive)
            }
          }, 5_000)
          try {
            for await (const event of runStep({ ...wire, token: undefined }, controller.signal, { pool })) sink.enqueue(line(event))
          } catch (error) {
            for (const event of failedStep(`rice-multi-models: ${error instanceof Error ? error.message : String(error)}`)) sink.enqueue(line(event))
          } finally {
            clearInterval(keepAlive)
            inFlight -= 1
            try {
              sink.close()
            } catch {
              // the caller went away
            }
          }
        },
        cancel() {
          controller.abort()
        },
      })

      return new Response(body, { headers: { 'content-type': 'application/x-ndjson' } })
    },
  }
  // The cast lets idleTimeout through (see above).
  const server = Bun.serve(options as unknown as Parameters<typeof Bun.serve>[0])
  chmodSync(socketPath, 0o600)
  const stop = () => {
    pool.closeAll()
    server.stop(true)
    rmSync(dir, { recursive: true, force: true })
    process.exit(0)
  }
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, stop)
  setInterval(() => {
    pool.sweep()
    // Claude Code gone: this process was reparented.
    if (process.ppid !== parent) stop()
  }, 5_000)
  process.stdout.write(`ready ${socketPath} ${token}\n`)
}
