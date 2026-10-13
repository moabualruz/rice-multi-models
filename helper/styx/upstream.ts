// Copied from Trosfy/claude-styx styxd/upstream.ts at 5072384
// (MIT, Copyright (c) 2026 styx contributors; see LICENSES/claude-styx.MIT.txt).
// Modified by mkh: import paths for this layout; Node TCP/fetch transport and cancellable connect probes.
// The provider transport: one POST per request over Node's keep-alive pool. https only (http too where the
// provider allows it), no redirect followed, a TCP connect check bounded at 15 s, a stall window from the
// request until the headers and between reads, and a bound on the whole request. Aborting `signal` (the
// client went away), even before the request starts, cancels it; `cancel` ends an answer whose body was
// never read. Native HTTP avoids Node fetch's hidden 300 s header/body cut.
import { createConnection } from 'node:net'
import { postStream } from '../core/http-stream.ts'
import { MAX_TIMEOUT_MS } from '../../hooks/config'
import { CONNECT_TIMEOUT_S } from './errors'
import type { Cut } from './errors'
import type { Answer, UpstreamRequest } from './step'

// Whether the origin takes a TCP connection within the connect timeout.
async function reachable(hostname: string, port: number, signal: AbortSignal): Promise<Cut | undefined> {
  if (signal.aborted) return { kind: 'reset', detail: 'aborted' }
  return new Promise(resolve => {
    const socket = createConnection({ host: hostname.replace(/^\[|\]$/g, ''), port })
    let done = false
    const finish = (cut?: Cut) => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      socket.destroy()
      resolve(cut)
    }
    const abort = () => finish({ kind: 'reset', detail: 'aborted' })
    const timer = setTimeout(() => finish({ kind: 'connect-timeout', detail: '' }), CONNECT_TIMEOUT_S * 1000)
    socket.once('connect', () => finish())
    socket.once('error', (err: NodeJS.ErrnoException) => finish({ kind: 'connect', detail: `${hostname}:${port} ${err.code ?? String(err)}` }))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

export async function post(r: UpstreamRequest, signal: AbortSignal): Promise<Answer> {
  const url = new URL(r.url)
  if (url.protocol !== 'https:' && !(r.allowHttp && url.protocol === 'http:')) return { cut: { kind: 'connect', detail: `${url.protocol} is refused: https only, unless the provider sets allowHttp` } }
  if (signal.aborted) return { cut: { kind: 'reset', detail: 'aborted' } }
  const reach = await reachable(url.hostname, Number(url.port) || (url.protocol === 'https:' ? 443 : 80), signal)
  if (reach !== undefined) return { cut: reach }
  const ac = new AbortController()
  let why: Cut | undefined
  const cutBy = (c: Cut) => ((why ??= c), ac.abort())
  const total = setTimeout(() => cutBy({ kind: 'total', detail: String(r.totalS) }), Math.min(r.totalS * 1000, MAX_TIMEOUT_MS))
  let stall: ReturnType<typeof setTimeout> | undefined
  const arm = () => (clearTimeout(stall), (stall = setTimeout(() => cutBy({ kind: 'stall', detail: String(r.stallS) }), r.stallS * 1000)))
  const release = () => (clearTimeout(stall), clearTimeout(total))
  arm()
  let res: Awaited<ReturnType<typeof postStream>>
  try {
    res = await postStream(r.url, r.headers, r.body, AbortSignal.any([signal, ac.signal]))
  } catch (err) {
    release()
    return { cut: why ?? { kind: 'reset', detail: String(err) } }
  }
  if (res.status >= 300 && res.status < 400) {
    release()
    res.cancel()
    return { cut: { kind: 'redirect', detail: String(res.status) } }
  }
  // End the native request and stream together, including answers whose body was never read.
  const cancel = () => (release(), res.cancel(), ac.abort())
  async function* body(): AsyncGenerator<Uint8Array, Cut | undefined> {
    try {
      arm()
      for await (const chunk of res.body ?? []) {
        if (chunk.length > 0) yield chunk
        arm()
      }
      return why
    } catch (err) {
      return why ?? (signal.aborted ? undefined : { kind: 'reset', detail: String(err) })
    } finally {
      cancel()
    }
  }
  return { status: res.status, body: body(), cancel }
}
