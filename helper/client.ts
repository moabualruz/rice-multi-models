// Local session transport. Exit 3 means the socket was never reached, so no request could have
// started. Once connected, never replay through a one-shot fallback, even before the first event.
import { request } from 'node:http'
import { once } from 'node:events'
import { withLocalSocketPath } from './core/local-socket.ts'

export const CLIENT_UNAVAILABLE = 3

export async function client(socketPath: string, body: string, lifetime?: AbortSignal): Promise<number> {
  let delivered = false
  let connected = false
  let outgoing: ReturnType<typeof request>
  try {
    outgoing = withLocalSocketPath(socketPath, path => request({ socketPath: path, path: '/step', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }))
  } catch {
    return CLIENT_UNAVAILABLE
  }
  const stop = () => outgoing.destroy(new Error('client stopped'))
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, stop)
  const timer = setTimeout(() => outgoing.destroy(new Error('local helper did not connect')), 1500)
  outgoing.once('socket', socket => {
    const reached = () => { connected = true; clearTimeout(timer) }
    if (!socket.connecting) reached()
    else socket.once('connect', reached)
  })
  try {
    const incoming = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      outgoing.once('response', resolve)
      outgoing.once('error', reject)
      lifetime?.addEventListener('abort', stop, { once: true })
      if (lifetime?.aborted) stop()
      else outgoing.end(body)
    })
    if (incoming.statusCode !== 200) {
      incoming.resume()
      return 1
    }
    for await (const chunk of incoming) {
      const bytes = Buffer.from(chunk)
      if (bytes.toString('utf8').trim() !== '') delivered = true
      if (!process.stdout.write(bytes)) await once(process.stdout, 'drain', { signal: lifetime })
    }
    return delivered ? 0 : 1
  } catch {
    return connected ? 1 : CLIENT_UNAVAILABLE
  } finally {
    clearTimeout(timer)
    outgoing.destroy()
    lifetime?.removeEventListener('abort', stop)
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.off(signal, stop)
  }
}
