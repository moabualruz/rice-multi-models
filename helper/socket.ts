// Codex WebSocket connections that answer one response at a time and stay open between responses, as the
// Codex CLI keeps its own. A pool keeps one per conversation for the session helper; the one-shot helper
// opens one per request and closes it after.
import type { Limits } from '../hooks/protocol.ts'
import { ProviderFailure } from './core/provider-failure.ts'

const OPEN_MS = 15_000
const ENDS = new Set(['response.completed', 'response.failed', 'response.incomplete', 'error'])
const encoder = new TextEncoder()

export class SocketError extends ProviderFailure {
  constructor(message: string, event = 'websocket.error', closeCode?: number, status?: number) {
    super(message, { event, code: 'websocket-error', closeCode, status, transient: closeCode === undefined && status === undefined })
  }
}

type Parsed = Record<string, unknown>

/** What a `codex.rate_limits` event says, read by the caller (codex.ts owns the format). */
export type LimitsReader = (event: Parsed) => Limits | null

/** One WebSocket to the Codex backend. */
export class CodexSocket {
  busy = false
  closed = false
  lastUsed = Date.now()
  private route: ((parsed: Parsed, text: string) => void) | undefined
  private drop: ((error: Error) => void) | undefined

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', event => {
      const text = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data as ArrayBuffer)
      let parsed: Parsed
      try {
        parsed = JSON.parse(text) as Parsed
      } catch {
        return
      }
      this.route?.(parsed, text)
    })
    const lost = (error: SocketError) => {
      this.closed = true
      this.drop?.(error)
    }
    socket.addEventListener('close', event => lost(new SocketError(`the Codex WebSocket closed mid-response (${event.code})`, 'websocket.close', event.code)))
    socket.addEventListener('error', () => lost(new SocketError('the Codex WebSocket failed mid-response')))
  }

  /** A connection once the handshake is done; headers carry the login, which the backend checks here. */
  static open(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<CodexSocket> {
    signal?.throwIfAborted()
    const socket = new WebSocket(url, { headers } as unknown as string[])

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        socket.removeEventListener('open', opened)
        socket.removeEventListener('error', refused)
        socket.removeEventListener('close', closed)
      }
      const fail = (error: unknown) => {
        cleanup()
        reject(error)
        socket.close()
      }
      const abort = () => fail(signal?.reason)
      const opened = () => {
        cleanup()
        resolve(new CodexSocket(socket))
      }
      const refused = (event: Event) => {
        const message = 'message' in event && typeof event.message === 'string' ? event.message : ''
        const status = /(?:server response|HTTP)[^0-9]*(\d{3})/i.exec(message)?.[1]
        fail(new SocketError('the Codex WebSocket was refused', 'websocket.open', undefined, status ? Number(status) : undefined))
      }
      const closed = (event: CloseEvent) => fail(new SocketError(`the Codex WebSocket closed before it opened (${event.code})`, 'websocket.close', event.code))
      const timer = setTimeout(() => fail(new SocketError('the Codex WebSocket did not open in time', 'websocket.open')), OPEN_MS)
      socket.addEventListener('open', opened)
      socket.addEventListener('error', refused)
      socket.addEventListener('close', closed)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
  }

  get isUsable(): boolean {
    return !this.closed && !this.busy && this.socket.readyState === WebSocket.OPEN
  }

  close(): void {
    this.closed = true
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) this.socket.close(1000)
  }

  /**
   * Sends one `response.create` and yields its events as server-sent-event frames for the decoder, the
   * rate-limit report going to `onLimits` instead. An aborted or abandoned response closes the connection,
   * since the backend would go on streaming it; a finished one leaves it open for the next.
   */
  response(body: Parsed, signal: AbortSignal, readLimits: LimitsReader, onLimits: (limits: Limits) => void): AsyncIterable<Uint8Array> {
    signal.throwIfAborted()
    if (!this.isUsable) throw new SocketError('the Codex WebSocket is not open')
    this.busy = true
    const frames: Uint8Array[] = []
    let wake: (() => void) | undefined
    let done = false
    let failure: Error | undefined
    const notify = () => {
      wake?.()
      wake = undefined
    }
    const finish = (error?: Error) => {
      if (done) return
      done = true
      failure = error
      this.route = undefined
      this.drop = undefined
      notify()
    }
    this.route = (parsed, text) => {
      if (parsed.type === 'codex.rate_limits') {
        const limits = readLimits(parsed)
        if (limits) onLimits(limits)

        return
      }
      frames.push(encoder.encode(`data: ${text}\n\n`))
      notify()
      if (typeof parsed.type === 'string' && ENDS.has(parsed.type)) finish()
    }
    this.drop = error => finish(error)
    const abort = () => {
      finish(new SocketError('aborted', 'request.aborted', 1008))
      this.close()
    }
    signal.addEventListener('abort', abort, { once: true })
    this.socket.send(JSON.stringify({ type: 'response.create', ...body }))
    const self = this

    return {
      async *[Symbol.asyncIterator]() {
        try {
          while (true) {
            const frame = frames.shift()
            if (frame) {
              yield frame
              continue
            }
            if (done) break
            await new Promise<void>(resolve => {
              wake = resolve
            })
          }
          if (failure) throw failure
        } finally {
          signal.removeEventListener('abort', abort)
          if (!done) {
            finish(new SocketError('abandoned'))
            self.close()
          }
          self.busy = false
          self.lastUsed = Date.now()
        }
      },
    }
  }
}

/** One open connection per conversation key, closed after it has been idle `idleMs`. */
export class SocketPool {
  private readonly sockets = new Map<string, CodexSocket>()

  constructor(private readonly idleMs = 5 * 60_000) {}

  /** The conversation's open, idle connection, or a new one (kept for next time unless the old one is busy). */
  async take(key: string, url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<{ socket: CodexSocket; reused: boolean }> {
    const kept = this.sockets.get(key)
    if (kept?.isUsable) return { socket: kept, reused: true }
    const socket = await CodexSocket.open(url, headers, signal)
    if (!kept || kept.closed) this.sockets.set(key, socket)

    return { socket, reused: false }
  }

  /** Whether `socket` belongs to the pool (a spare opened beside a busy one does not). */
  holds(socket: CodexSocket): boolean {
    return [...this.sockets.values()].includes(socket)
  }

  sweep(now = Date.now()): void {
    for (const [key, socket] of this.sockets) {
      if (socket.closed || (!socket.busy && now - socket.lastUsed > this.idleMs)) {
        socket.close()
        this.sockets.delete(key)
      }
    }
  }

  get size(): number {
    return [...this.sockets.values()].filter(socket => !socket.closed).length
  }

  closeAll(): void {
    for (const socket of this.sockets.values()) socket.close()
    this.sockets.clear()
  }
}
