// Node's native HTTP agents have no hidden 300-second fetch header/body timeout. The caller's
// connect, stall and total timers therefore remain authoritative for long provider streams.
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage } from 'node:http'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { Readable } from 'node:stream'

export async function postStream(url: string, headers: Record<string, string>, body: string, signal: AbortSignal): Promise<{ status: number; headers: Headers; body: Readable; cancel: () => void }> {
  signal.throwIfAborted()
  const parsed = new URL(url)
  const send = parsed.protocol === 'https:' ? httpsRequest : httpRequest
  let incoming: IncomingMessage | undefined
  let stream: Readable | undefined
  const outgoing = send(parsed, { method: 'POST', headers, signal })
  const abort = () => { stream?.destroy(); incoming?.destroy(); outgoing.destroy() }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  try {
    incoming = await new Promise<IncomingMessage>((resolve, reject) => {
      outgoing.once('response', resolve)
      outgoing.once('error', reject)
      outgoing.end(body)
    })
    const encoding = incoming.headers['content-encoding']?.trim().toLowerCase()
    const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : undefined
    stream = decoder ? incoming.pipe(decoder) : incoming
    if (decoder) incoming.on('error', error => decoder.destroy(error))
    stream.once('close', () => signal.removeEventListener('abort', abort))
    const responseHeaders = new Headers()
    for (let index = 0; index < incoming.rawHeaders.length; index += 2) responseHeaders.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!)
    const cancel = () => { signal.removeEventListener('abort', abort); abort() }
    return { status: incoming.statusCode ?? 0, headers: responseHeaders, body: stream, cancel }
  } catch (error) {
    signal.removeEventListener('abort', abort)
    abort()
    throw error
  }
}

/** A standard Response for the existing Codex auth-renewal and SSE decoder contracts. */
export async function postResponse(url: string, headers: Record<string, string>, body: string, signal: AbortSignal): Promise<Response> {
  const response = await postStream(url, headers, body, signal)
  if ([204, 205, 304].includes(response.status)) {
    response.cancel()
    return new Response(null, { status: response.status, headers: response.headers })
  }
  return new Response(Readable.toWeb(response.body) as unknown as ReadableStream<Uint8Array>, { status: response.status, headers: response.headers })
}
