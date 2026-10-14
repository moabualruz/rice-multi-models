import type { StepEvent, StopReason } from '../../hooks/protocol.ts'

type Block = Record<string, unknown>
type Event = Record<string, unknown> & { type: string }
const usage = () => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
const error = () => ({ type: 'error', error: { type: 'invalid_request_error', message: 'rice-multi-models: direct native inference failed; no provider fallback or native replay was attempted' } })

/** Builds both native JSON and a complete native SSE sequence from direct provider events. */
export class NativeResponse {
  private readonly content: Block[] = []
  private open: { type: 'text' | 'thinking'; index: number } | undefined
  private readonly tokens = usage()
  private stop: StopReason | undefined
  private failed = false
  readonly id = `msg_rice_${crypto.randomUUID().replaceAll('-', '')}`
  constructor(readonly model: string, private readonly maxTokens?: number) {}

  message() { return { id: this.id, type: 'message', role: 'assistant', model: this.model, content: this.content, stop_reason: this.stop ?? null, stop_sequence: null, usage: { ...this.tokens } } }
  start(): Event[] { return [{ type: 'message_start', message: { ...this.message(), content: [] } }] }

  private close(): Event[] {
    if (!this.open) return []
    const index = this.open.index
    this.open = undefined
    return [{ type: 'content_block_stop', index }]
  }

  feed(event: StepEvent): Event[] {
    if (this.failed) return []
    if (event.type === 'error') { this.failed = true; return [...this.close(), error()] }
    if (event.type === 'usage') {
      if (this.maxTokens !== undefined && event.out > this.maxTokens) { this.failed = true; return [...this.close(), error()] }
      Object.assign(this.tokens, { input_tokens: event.in, output_tokens: event.out, cache_read_input_tokens: event.cacheRead, cache_creation_input_tokens: event.cacheWrite }); return []
    }
    if (event.type === 'stop') { this.stop = event.reason; return [] }
    if (event.type === 'text' || event.type === 'thinking') {
      const out: Event[] = []
      if (this.open?.type !== event.type) {
        out.push(...this.close())
        const block = event.type === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '', signature: '' }
        this.open = { type: event.type, index: this.content.length }
        this.content.push(block)
        out.push({ type: 'content_block_start', index: this.open.index, content_block: { ...block } })
      }
      const index = this.open.index, key = event.type === 'text' ? 'text' : 'thinking'
      this.content[index][key] = String(this.content[index][key]) + event.text
      out.push({ type: 'content_block_delta', index, delta: { type: `${event.type}_delta`, [key]: event.text } })
      return out
    }
    if (event.type === 'signature') {
      if (this.open?.type === 'thinking') {
        this.content[this.open.index].signature = event.signature
        return [{ type: 'content_block_delta', index: this.open.index, delta: { type: 'signature_delta', signature: event.signature } }]
      }
      // Some clients emit signed reasoning whole, without preceding deltas.
      const out = this.close(), index = this.content.length
      const block = { type: 'thinking', thinking: event.thinking, signature: event.signature }
      this.content.push(block)
      return [...out, { type: 'content_block_start', index, content_block: block }, { type: 'content_block_stop', index }]
    }
    if (event.type === 'tool_use') {
      const out = this.close(), index = this.content.length
      this.content.push({ ...event })
      return [...out, { type: 'content_block_start', index, content_block: { type: 'tool_use', id: event.id, name: event.name, input: {} } },
        { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(event.input) } }, { type: 'content_block_stop', index }]
    }
    if (event.type === 'native_block') {
      const out = this.close(), index = this.content.length
      this.content.push(event.block)
      if (event.block.type === 'server_tool_use') return [...out,
        { type: 'content_block_start', index, content_block: { ...event.block, input: {} } },
        { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(event.block.input) } },
        { type: 'content_block_stop', index }]
      return [...out, { type: 'content_block_start', index, content_block: event.block }, { type: 'content_block_stop', index }]
    }
    return []
  }

  end(): Event[] {
    if (this.failed) return []
    if (!this.stop) { this.failed = true; return [...this.close(), error()] }
    return [...this.close(), { type: 'message_delta', delta: { stop_reason: this.stop, stop_sequence: null }, usage: { ...this.tokens } }, { type: 'message_stop' }]
  }
  ok() { return !this.failed && this.stop !== undefined }
}

const encoder = new TextEncoder()
export const sse = (events: Event[]): Uint8Array => encoder.encode(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))

export function nativeFailure(message?: string): Response {
  const failure = error()
  if (message) failure.error.message = message
  return Response.json(failure, { status: 400, headers: { 'x-should-retry': 'false' } })
}

export async function providerResponse(model: string, events: AsyncIterable<StepEvent>, signal: AbortSignal, cancel: () => void, stream: boolean, maxTokens?: number): Promise<Response> {
  const response = new NativeResponse(model, maxTokens)
  const iterator = events[Symbol.asyncIterator]()
  if (!stream) {
    try {
      for await (const event of { [Symbol.asyncIterator]: () => iterator }) { signal.throwIfAborted(); response.feed(event) }
      response.end()
      return response.ok() ? Response.json(response.message(), { headers: { 'x-should-retry': 'false' } }) : nativeFailure()
    } finally { cancel() }
  }
  let started = false, ended = false
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        signal.throwIfAborted()
        if (!started) { started = true; controller.enqueue(sse(response.start())); return }
        // A pending native read needs bytes or close. Accounting-only events must
        // be drained in this pull; returning without either would leave it waiting.
        while (true) {
          const next = await iterator.next()
          signal.throwIfAborted()
          if (next.done) { controller.enqueue(sse(response.end())); ended = true; controller.close(); cancel(); return }
          const bytes = sse(response.feed(next.value))
          if (bytes.length) { controller.enqueue(bytes); return }
        }
      } catch (failure) { ended = true; controller.error(signal.aborted ? signal.reason : new Error('rice-multi-models: native direct response failed')); cancel(); await iterator.return?.() }
    },
    async cancel() { if (!ended) { ended = true; cancel(); await iterator.return?.() } },
  })
  return new Response(body, { headers: { 'content-type': 'text/event-stream', 'x-should-retry': 'false', 'request-id': response.id } })
}
