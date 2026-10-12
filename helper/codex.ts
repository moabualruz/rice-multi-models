// The Codex provider: a ChatGPT subscription's Responses API, over a WebSocket or server-sent events.
// The Anthropic <-> Responses translation and the Codex login are cc-multi-cli-plugin's (helper/core,
// helper/openai); the transports, the event mapping and the request identity are this mod's own.
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'

import type { Limits, StepEvent, StepRequest, StopReason, Transport } from '../hooks/protocol.ts'
import type { Emit, MessagesRequest, MessagesResponse, RequestMessage } from './core/messages.ts'
import { fromResponses, toResponses } from './core/responses.ts'
import type { ResponsesRequest } from './core/responses.ts'
import { estimateInputTokens } from './core/tokens.ts'
import { originalToolNames } from './core/tools.ts'
import { CodexAuthError, codexRequest, readCodexAuth } from './openai/auth.ts'
import type { CodexAuthHeaders } from './openai/auth.ts'
import { openaiInstructions } from './openai/instructions.ts'

const HTTP_URL = 'https://chatgpt.com/backend-api/codex/responses'
const WS_URL = 'wss://chatgpt.com/backend-api/codex/responses'
/** Who the requests say they come from: this bridge, not the Codex CLI. */
export const ORIGINATOR = 'rice_multi_models'
const WS_BETA = 'responses_websockets=2026-02-06'
const SSE_BETA = 'responses=experimental'
const WS_OPEN_MS = 15_000
const ENDS = new Set(['response.completed', 'response.failed', 'response.incomplete', 'error'])

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

export function codexAuthFile(env: Record<string, string | undefined> = process.env): string {
  return `${env.CODEX_HOME || `${homedir()}/.codex`}/auth.json`
}

/** The step as the Anthropic Messages body the translator reads. */
export function messagesBody(req: StepRequest, model: string): MessagesRequest {
  const body: MessagesRequest = {
    model,
    system: req.system,
    messages: req.transcript as unknown as RequestMessage[],
    tools: req.tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.schema,
      ...(tool.deferred ? { defer_loading: true } : {}),
    })),
    stream: true,
  }
  if (typeof req.effort === 'string') body.output_config = { effort: req.effort }
  else if (typeof req.effort === 'number') body.thinking = { type: 'enabled', budget_tokens: req.effort }

  return body
}

/** The Responses request: cc-multi's translation, its compatibility note, and a cache key per conversation. */
export function responsesRequest(req: StepRequest, model: string, body: MessagesRequest): ResponsesRequest {
  const translated = toResponses(body, model)

  return {
    ...translated,
    instructions: openaiInstructions(translated.instructions),
    prompt_cache_key: createHash('sha256').update(JSON.stringify(['codex', req.session, req.who, model])).digest('hex'),
  }
}

function windowLabel(minutes: unknown): string {
  if (minutes === 300) return '5h'
  if (minutes === 10080) return 'wk'

  return typeof minutes === 'number' ? (minutes % 1440 === 0 ? `${minutes / 1440}d` : `${minutes}m`) : '?'
}

/** A `codex.rate_limits` event as windows; null when it carries none. */
export function limitsOf(event: Record<string, unknown>): Limits | null {
  const limits = event.rate_limits as Record<string, { used_percent?: unknown; window_minutes?: unknown; reset_at?: unknown } | null> | undefined
  if (!limits) return null
  const windows = (['primary', 'secondary'] as const).flatMap(key => {
    const window = limits[key]
    if (!window || typeof window.used_percent !== 'number') return []

    return [{ label: windowLabel(window.window_minutes), usedPercent: window.used_percent, resetsAt: typeof window.reset_at === 'number' ? window.reset_at * 1000 : undefined }]
  })

  return { plan: typeof event.plan_type === 'string' ? event.plan_type : undefined, windows }
}

/** What a failed response says, kept short; provider error bodies hold no credentials. */
async function failureText(response: Response): Promise<string> {
  const text = (await response.text().catch(() => '')).slice(0, 2000)
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } | string; detail?: string; message?: string }
    const said = typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? parsed.detail ?? parsed.message)
    if (said) return said.slice(0, 300)
  } catch {
    // not JSON: fall through
  }

  return text.replace(/\s+/g, ' ').trim().slice(0, 300)
}

const encoder = new TextEncoder()

/** One response over a fresh WebSocket, its events re-framed as server-sent events for the decoder. */
async function openSocket(url: string, request: ResponsesRequest, auth: CodexAuthHeaders, sessionId: string, signal: AbortSignal, onLimits: (limits: Limits) => void): Promise<AsyncIterable<Uint8Array>> {
  const socket = new WebSocket(url, {
    headers: { ...auth, originator: ORIGINATOR, session_id: sessionId, 'OpenAI-Beta': WS_BETA },
  } as unknown as string[])
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
    notify()
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new UpstreamError('the Codex WebSocket did not open in time')), WS_OPEN_MS)
    socket.addEventListener('open', () => {
      clearTimeout(timer)
      resolve()
    })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new UpstreamError('the Codex WebSocket was refused'))
    })
    socket.addEventListener('close', event => {
      clearTimeout(timer)
      reject(new UpstreamError(`the Codex WebSocket closed before it opened (${event.code})`))
    })
  })
  socket.addEventListener('message', event => {
    const text = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data as ArrayBuffer)
    let parsed: Record<string, unknown> | undefined
    try {
      parsed = JSON.parse(text) as Record<string, unknown>
    } catch {
      return
    }
    if (parsed.type === 'codex.rate_limits') {
      const limits = limitsOf(parsed)
      if (limits) onLimits(limits)

      return
    }
    frames.push(encoder.encode(`data: ${text}\n\n`))
    notify()
    if (typeof parsed.type === 'string' && ENDS.has(parsed.type)) {
      finish()
      socket.close(1000)
    }
  })
  socket.addEventListener('close', event => finish(done ? undefined : new UpstreamError(`the Codex WebSocket closed mid-response (${event.code})`)))
  socket.addEventListener('error', () => finish(new UpstreamError('the Codex WebSocket failed mid-response')))
  const abort = () => {
    finish(new UpstreamError('aborted'))
    socket.close(1000)
  }
  signal.addEventListener('abort', abort, { once: true })
  const { stream: _stream, ...rest } = request
  socket.send(JSON.stringify({ type: 'response.create', ...rest }))

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
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(1000)
      }
    },
  }
}

/** One response over HTTP with server-sent events; a 401 renews the Codex login once. */
async function openHttp(url: string, request: ResponsesRequest, authFile: string, sessionId: string, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>> {
  const response = await codexRequest(authFile, signal, auth =>
    fetch(url, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json', accept: 'text/event-stream', originator: ORIGINATOR, session_id: sessionId, 'OpenAI-Beta': SSE_BETA },
      body: JSON.stringify(request),
      signal,
      redirect: 'error',
    }),
  )
  if (!response.ok || !response.body) throw new UpstreamError(`Codex answered HTTP ${response.status}: ${await failureText(response)}`, response.status)

  return response.body as unknown as AsyncIterable<Uint8Array>
}

/** Maps the translator's Anthropic stream events onto step events. */
type Delta =
  | { type: 'text_delta'; text: string }
  | { type: 'input_json_delta'; partial_json: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'signature_delta'; signature: string }

export function eventMapper(push: (event: StepEvent) => void): { emit: Emit; toolCalls: () => number } {
  type Open = { kind: string; id?: string; name?: string; json: string; thinking: string; signature: string }
  const blocks = new Map<number, Open>()
  let calls = 0
  const emit: Emit = (type, value) => {
    if (type === 'content_block_start' && 'content_block' in value) {
      const block = value.content_block
      const open: Open = { kind: block.type, json: '', thinking: '', signature: '' }
      if (block.type === 'tool_use') {
        open.id = block.id
        open.name = block.name
        if (block.input && typeof block.input === 'object' && Object.keys(block.input).length > 0) open.json = JSON.stringify(block.input)
      }
      if (block.type === 'thinking') {
        open.thinking = block.thinking
        open.signature = block.signature
        if (block.thinking) push({ type: 'thinking', text: block.thinking })
      }
      if (block.type === 'text' && block.text) push({ type: 'text', text: block.text })
      blocks.set(value.index, open)

      return
    }
    if (type === 'content_block_delta' && 'index' in value && 'delta' in value) {
      const open = blocks.get(value.index)
      const delta = value.delta as Delta
      if (delta.type === 'text_delta') push({ type: 'text', text: delta.text })
      else if (delta.type === 'thinking_delta') {
        push({ type: 'thinking', text: delta.thinking })
        if (open) open.thinking += delta.thinking
      } else if (delta.type === 'signature_delta' && open) open.signature += delta.signature
      else if (delta.type === 'input_json_delta' && open) open.json += delta.partial_json

      return
    }
    if (type === 'content_block_stop' && 'index' in value) {
      const open = blocks.get(value.index)
      blocks.delete(value.index)
      if (open?.kind === 'tool_use' && open.id && open.name) {
        calls += 1
        let input: Record<string, unknown> = {}
        try {
          input = open.json ? (JSON.parse(open.json) as Record<string, unknown>) : {}
        } catch {
          input = {}
        }
        push({ type: 'tool_use', id: open.id, name: open.name, input })
      }
      if (open?.kind === 'thinking' && open.signature) push({ type: 'signature', thinking: open.thinking, signature: open.signature })
    }
  }

  return { emit, toolCalls: () => calls }
}

function stopOf(response: MessagesResponse, toolCalls: number): StopReason {
  if (toolCalls > 0) return 'tool_use'
  if (response.stop_reason === 'max_tokens' || response.stop_reason === 'stop_sequence' || response.stop_reason === 'tool_use') return response.stop_reason

  return 'end_turn'
}

/** A queue the generator drains while the translator runs. */
class Channel<T> {
  private items: T[] = []
  private wake: (() => void) | undefined
  private closed = false
  push(item: T): void {
    this.items.push(item)
    this.wake?.()
    this.wake = undefined
  }
  close(): void {
    this.closed = true
    this.wake?.()
    this.wake = undefined
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      const item = this.items.shift()
      if (item !== undefined) {
        yield item
        continue
      }
      if (this.closed) return
      await new Promise<void>(resolve => {
        this.wake = resolve
      })
    }
  }
}

export type CodexOptions = { authFile?: string; env?: Record<string, string | undefined>; httpUrl?: string; wsUrl?: string }

/** Answers one step with a Codex model: streamed text, reasoning and tool calls, then usage and the stop. */
export async function* codexStep(req: StepRequest, model: string, signal: AbortSignal, options: CodexOptions = {}): AsyncGenerator<StepEvent> {
  const started = Date.now()
  let ttfb: number | null = null
  let transport: string = 'none'
  const authFile = options.authFile ?? codexAuthFile(options.env)
  const body = messagesBody(req, model)
  let request: ResponsesRequest
  try {
    request = responsesRequest(req, model, body)
  } catch (error) {
    yield { type: 'error', kind: 'request', text: `codex: cannot translate this conversation: ${error instanceof Error ? error.message : String(error)}` }
    yield { type: 'stats', ttfbMs: null, totalMs: Date.now() - started, transport }

    return
  }
  const queue = new Channel<StepEvent>()
  const mapper = eventMapper(event => {
    ttfb ??= Date.now() - started
    queue.push(event)
  })
  const sessionId = `${req.session}:${req.who}`
  const choice: Transport = req.transport ?? 'auto'
  const open = async (): Promise<AsyncIterable<Uint8Array>> => {
    if (choice !== 'sse') {
      try {
        const auth = await readCodexAuth(authFile)
        const stream = await openSocket(options.wsUrl ?? WS_URL, request, auth, sessionId, signal, limits => queue.push({ type: 'limits', limits }))
        transport = 'ws'

        return stream
      } catch (error) {
        if (choice === 'ws' || signal.aborted || error instanceof CodexAuthError) throw error
      }
    }
    const stream = await openHttp(options.httpUrl ?? HTTP_URL, request, authFile, sessionId, signal)
    transport = 'sse'

    return stream
  }
  void (async () => {
    try {
      const response = await fromResponses(await open(), req.target, mapper.emit, {
        toolNames: originalToolNames(body),
        inputTokens: estimateInputTokens(request),
      })
      const usage = response.usage
      queue.push({
        type: 'usage',
        in: usage.input_tokens,
        out: usage.output_tokens,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        cacheWrite: usage.cache_creation_input_tokens ?? 0,
        reasoning: response.multi_usage?.reasoning_tokens,
      })
      queue.push({ type: 'stop', reason: stopOf(response, mapper.toolCalls()) })
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      queue.push({ type: 'error', kind: error instanceof UpstreamError || error instanceof CodexAuthError ? 'request' : 'response', text: `codex: ${text}` })
    } finally {
      queue.close()
    }
  })()
  for await (const event of queue) yield event
  yield { type: 'stats', ttfbMs: ttfb, totalMs: Date.now() - started, transport }
}
