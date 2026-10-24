// The Codex provider: a ChatGPT subscription's Responses API, over a WebSocket or server-sent events.
// The Anthropic <-> Responses translation and the Codex login are cc-multi-cli-plugin's (helper/core,
// helper/openai); the transports, the event mapping and the request identity are this mod's own.
import { createHash } from 'node:crypto'
import { continuationScope, createContinuation, restoreContinuations, continuationOutput } from './continuation.ts'
import { withCarry } from '../hooks/carry.ts'
import { homedir } from 'node:os'

import type { Limits, SearchEvidence, StepEvent, StepRequest, StopReason, Transport } from '../hooks/protocol.ts'
import type { Emit, MessagesRequest, MessagesResponse, RequestMessage } from './core/messages.ts'
import { fromResponses, toResponses } from './core/responses.ts'
import type { ResponsesRequest } from './core/responses.ts'
import { estimateInputTokens } from './core/tokens.ts'
import { originalToolNames } from './core/tools.ts'
import { CodexAuthError, codexRequest, readCodexAuth } from './openai/auth.ts'
import type { CodexAuthHeaders } from './openai/auth.ts'
import { openaiInstructions } from './openai/instructions.ts'
import { CodexSocket, SocketPool } from './socket.ts'
import { maxAttempts, OVERLOAD_MAX_ATTEMPTS, ProviderFailure, retryAfterMs, retryDelay, waitForRetry } from './core/provider-failure.ts'
import { oneLine } from './styx/errors.ts'
import { codexAccounts, codexStepLimit } from './account-steps.ts'
import { postResponse } from './core/http-stream.ts'

const HTTP_URL = 'https://chatgpt.com/backend-api/codex/responses'
const WS_URL = 'wss://chatgpt.com/backend-api/codex/responses'
/** Who the requests say they come from: this bridge, not the Codex CLI. */
export const ORIGINATOR = 'rice_multi_models'
const WS_BETA = 'responses_websockets=2026-02-06'
const SSE_BETA = 'responses=experimental'

export class UpstreamError extends ProviderFailure {
  constructor(status: number, detail: ProviderFailure, retryAfter?: number) {
    super(detail.message, { ...detail.info, event: 'http.response', status, retryAfterMs: retryAfter })
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
    tools: (req.native?.webSearch ? [] : req.tools).map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.schema,
      ...(tool.deferred ? { defer_loading: true } : {}),
    })),
    stream: true,
    ...(req.native?.maxTokens !== undefined ? { max_tokens: req.native.maxTokens } : {}),
    ...(req.native?.stopSequences ? { stop_sequences: req.native.stopSequences } : {}),
    ...(req.native?.toolChoice && !req.native.webSearch ? { tool_choice: req.native.toolChoice } : {}),
    ...(req.native?.outputSchema && !req.native.webSearch ? { output_format: { type: 'json_schema', schema: req.native.outputSchema } } : {}),
  }
  if (typeof req.effort === 'string') body.output_config = { effort: req.effort }
  else if (typeof req.effort === 'number') body.thinking = { type: 'enabled', budget_tokens: req.effort }

  return body
}

/** The Responses request: cc-multi's translation, its compatibility note, and a cache key per conversation. */
export function responsesRequest(req: StepRequest, model: string, body: MessagesRequest): ResponsesRequest {
  const translated = toResponses(body, model)
  const search = req.native?.webSearch
  // Mirror the official Codex subscription serializer, rather than assuming
  // that public Platform-only search parameters are accepted by this backend.
  if (search?.blockedDomains?.length) throw new Error('Codex search cannot enforce these search restrictions')
  if (search?.maxUses !== undefined && (!Number.isSafeInteger(search.maxUses) || search.maxUses < 1 || search.maxUses > 20)) throw new Error('Codex search use limit must be an integer from 1 to 20')

  return {
    ...translated,
    ...(req.native?.outputSchema && !search && translated.text ? { text: { format: { ...translated.text.format, strict: false } } } : {}),
    ...(search ? { tools: [{ type: 'web_search' as const, external_web_access: true,
      ...(search.allowedDomains?.length ? { filters: { allowed_domains: search.allowedDomains } } : {}),
      ...(search.location ? { user_location: { ...search.location, type: 'approximate' } } : {}),
    }], tool_choice: 'auto' as const, parallel_tool_calls: false } : {}),
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

/** Only structured error metadata crosses this boundary; non-JSON bodies may echo login headers. */
async function httpFailure(response: Response): Promise<UpstreamError> {
  const text = (await response.text().catch(() => '')).slice(0, 4096)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = { message: 'provider returned no structured error' }
  }
  const detail = ProviderFailure.event(parsed)
  return new UpstreamError(response.status, detail, retryAfterMs(response.headers.get('retry-after')))
}

/** One response over HTTP with server-sent events; a 401 renews the Codex login once. */
async function openHttp(url: string, request: ResponsesRequest, authFile: string, sessionId: string, signal: AbortSignal, onAuth: (auth: CodexAuthHeaders) => void): Promise<AsyncIterable<Uint8Array>> {
  const response = await codexRequest(authFile, signal, auth => {
    onAuth(auth)
    return postResponse(url, { ...auth, 'content-type': 'application/json', accept: 'text/event-stream', originator: ORIGINATOR, session_id: sessionId, 'OpenAI-Beta': SSE_BETA }, JSON.stringify(request), signal).catch(error => {
      signal.throwIfAborted()
      if (error && typeof error === 'object' && error.code === 'ECONNRESET') {
        throw new ProviderFailure('the Codex HTTP connection reset before response headers', { event: 'http.connect', code: 'ECONNRESET', transient: true })
      }
      throw error
    })
  })
  if (!response.ok || !response.body) throw await httpFailure(response)

  return httpStream(response.body as unknown as AsyncIterable<Uint8Array>)
}

/** Only iterator failures are transport faults; decoder errors occur outside this wrapper. */
async function* httpStream(stream: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  try {
    yield* stream
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'stream-reset'
    throw new ProviderFailure('the Codex HTTP response connection failed before completion', { event: 'http.stream', code, transient: true })
  }
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

/** A one-response stream whose connection closes when it ends, for a socket nobody keeps. */
async function* closeAfter(stream: AsyncIterable<Uint8Array>, socket: CodexSocket): AsyncGenerator<Uint8Array> {
  try {
    yield* stream
  } finally {
    socket.close()
  }
}

export type CodexOptions = { authFile?: string; env?: Record<string, string | undefined>; httpUrl?: string; wsUrl?: string; pool?: SocketPool; maxInFlight?: number }

/** Milliseconds an open Codex stream may send no bytes before the attempt is abandoned and retried; 0 disables. The default matches the Codex CLI stream_idle_timeout_ms. */
export function streamIdleMs(env: Record<string, string | undefined> = process.env): number {
  const value = env.RICE_CODEX_STREAM_IDLE_MS ?? '300000'
  if (!/^\d{1,7}$/.test(value)) throw new Error('RICE_CODEX_STREAM_IDLE_MS must be 0 (disabled) or a whole number of milliseconds')
  return Number(value)
}

async function* touching(stream: AsyncIterable<Uint8Array>, touch: () => void): AsyncGenerator<Uint8Array> {
  for await (const chunk of stream) {
    touch()
    yield chunk
  }
}

/** Answers one step with a Codex model: streamed text, reasoning and tool calls, then usage and the stop. */
export async function* codexStep(req: StepRequest, model: string, signal: AbortSignal, options: CodexOptions = {}): AsyncGenerator<StepEvent> {
  const started = Date.now()
  let ttfb: number | null = null
  let transport: string = 'none'
  const authFile = options.authFile ?? codexAuthFile(options.env)
  const original = req
  let scope: string | undefined
  let expectedAccount: string | undefined
  if (req.continuation) try {
    // The account id is an opaque identity reference, never an access/refresh token or token-derived hash.
    const auth = await readCodexAuth(authFile)
    expectedAccount = auth['chatgpt-account-id']
    const endpoint = options.httpUrl ?? HTTP_URL
    scope = continuationScope({ providerId: 'codex', providerKind: 'responses', endpointOrigin: new URL(endpoint).origin, modelKind: 'responses', modelId: model, session: req.session, owner: req.who, accountRef: expectedAccount }, endpoint, options.wsUrl ?? WS_URL)
    const restored = restoreContinuations(req, 'codex-responses', scope, Date.now())
    const carry = new Map(restored.flatMap(record => record.calls.map(call => [call.id, record.blocks.flatMap(placed => placed.block.type === 'thinking' ? [{ ...placed.block, at: placed.at }] : [])] as const)))
    req = { ...req, transcript: withCarry(req.transcript.map(message => ({ ...message, content: typeof message.content === 'string' ? message.content : message.content.filter(block => block.type !== 'thinking' && block.type !== 'redacted_thinking') })), carry) }
    yield { type: 'continuation_status', status: restored.length ? 'restored' : 'no-compatible-state' }
  } catch {
    yield { type: 'error', kind: 'request', text: 'codex: durable account scope unavailable; no provider request was sent' }
    yield { type: 'stats', ttfbMs: null, totalMs: Date.now() - started, transport }
    return
  }
  const body = messagesBody(req, model)
  let request: ResponsesRequest
  try {
    request = responsesRequest(req, model, body)
  } catch (error) {
    yield { type: 'error', kind: 'request', text: `codex: cannot translate this conversation: ${error instanceof Error ? error.message : String(error)}` }
    yield { type: 'stats', ttfbMs: null, totalMs: Date.now() - started, transport }

    return
  }
  const controller = new AbortController()
  signal = AbortSignal.any([signal, controller.signal])
  // Each attempt gets its own signal so an idle stream can be abandoned without ending the step.
  let attemptSignal = signal
  const idleMs = streamIdleMs(options.env)
  const queue = new Channel<StepEvent>()
  const sessionId = `${req.session}:${req.who}`
  const choice: Transport = req.transport ?? 'auto'
  const onLimits = (limits: Limits) => queue.push({ type: 'limits', limits })
  const credentials = new Set<string>()
  let accountId: string | undefined
  const onAuth = (auth: CodexAuthHeaders) => {
    credentials.add(auth.authorization.slice('Bearer '.length))
    credentials.add(auth['chatgpt-account-id'])
    if (expectedAccount !== undefined && expectedAccount !== auth['chatgpt-account-id'] || accountId !== undefined && accountId !== auth['chatgpt-account-id']) throw new CodexAuthError('Codex account changed during the step. Retry in the intended account.')
    accountId = auth['chatgpt-account-id']
  }
  const finalText = (failure: ProviderFailure, attempts: number) => {
    let text = failure.finalText(attempts)
    for (const credential of credentials) if (credential) text = text.replaceAll(credential, '[REDACTED]')
    return `codex: ${text}`
  }
  const attemptSocket: { current?: CodexSocket } = {}
  const openSocket = async (): Promise<AsyncIterable<Uint8Array>> => {
    const auth = await readCodexAuth(authFile)
    onAuth(auth)
    const headers = { ...auth, originator: ORIGINATOR, session_id: sessionId, 'OpenAI-Beta': WS_BETA }
    const url = options.wsUrl ?? WS_URL
    const { stream: _stream, ...body } = request
    if (options.pool) {
      const account = createHash('sha256').update(auth['chatgpt-account-id']).digest('hex')
      const taken = await options.pool.take(`${account}:${sessionId}`, url, headers, attemptSignal)
      attemptSocket.current = taken.socket
      transport = taken.reused ? 'ws reused' : 'ws'
      const stream = taken.socket.response(body, attemptSignal, limitsOf, onLimits)

      return options.pool.holds(taken.socket) ? stream : closeAfter(stream, taken.socket)
    }
    const socket = await CodexSocket.open(url, headers, attemptSignal)
    attemptSocket.current = socket
    transport = 'ws'

    return closeAfter(socket.response(body, attemptSignal, limitsOf, onLimits), socket)
  }
  const open = async (): Promise<AsyncIterable<Uint8Array>> => {
    if (choice !== 'sse') {
      try {
        return await openSocket()
      } catch (error) {
        if (choice === 'ws' || attemptSignal.aborted || error instanceof CodexAuthError) throw error
      }
    }
    const stream = await openHttp(options.httpUrl ?? HTTP_URL, request, authFile, sessionId, attemptSignal, onAuth)
    transport = 'sse'

    return stream
  }
  const task = (async () => {
    let release: (() => void) | undefined
    let attempts = 0
    try {
      const limit = options.maxInFlight ?? codexStepLimit(options.env)
      const auth = await readCodexAuth(authFile)
      onAuth(auth)
      signal.throwIfAborted()
      const accountKey = createHash('sha256').update(auth['chatgpt-account-id']).digest('hex')
      release = await codexAccounts.acquire(accountKey, limit, signal)
      for (let attempt = 1; attempt <= OVERLOAD_MAX_ATTEMPTS; attempt++) {
        attempts = attempt
        attemptSocket.current = undefined
        let pending: StepEvent[] = []
        const continuationCalls: { id: string; name: string; input: Record<string, unknown> }[] = []
        const output = scope ? continuationOutput() : undefined
        let committed = false
        const flush = () => {
          for (const event of pending) queue.push(event)
          pending = []
        }
        const attemptControl = new AbortController()
        attemptSignal = AbortSignal.any([signal, attemptControl.signal])
        let idleTimer: ReturnType<typeof setTimeout> | undefined
        const arm = () => {
          if (idleMs <= 0) return
          if (idleTimer) clearTimeout(idleTimer)
          idleTimer = setTimeout(() => attemptControl.abort(new ProviderFailure(`the Codex stream sent nothing for ${idleMs} ms`, { event: 'stream.idle', code: 'stream-idle', transient: true })), idleMs)
        }
        arm()
        const push = (event: StepEvent) => {
          ttfb ??= Date.now() - started
          if (event.type === 'tool_use') continuationCalls.push({ id: event.id, name: event.name, input: event.input })
          output?.feed(event)
          if (event.type === 'text' || event.type === 'thinking' || event.type === 'search_sources' || event.type === 'tool_use') {
            committed = true
            flush()
          }
          if (committed) queue.push(event)
          else pending.push(event)
        }
        const mapper = eventMapper(push)
        try {
          signal.throwIfAborted()
          const response = await fromResponses(touching(await open(), arm), req.target, mapper.emit, {
            toolNames: originalToolNames(body),
            inputTokens: estimateInputTokens(request),
            ...(req.native?.webSearch ? { onSearchSources: (evidence: SearchEvidence) => push({ type: 'search_sources', ...evidence }) } : {}),
          })
          clearTimeout(idleTimer)
          flush()
          const usage = response.usage
          queue.push({
            type: 'usage',
            in: usage.input_tokens,
            out: usage.output_tokens,
            cacheRead: usage.cache_read_input_tokens ?? 0,
            cacheWrite: usage.cache_creation_input_tokens ?? 0,
            reasoning: response.multi_usage?.reasoning_tokens,
          })
          if (scope && stopOf(response, mapper.toolCalls()) === 'tool_use') {
            const record = output?.replayable() ? createContinuation(original, 'codex-responses', scope, request, continuationCalls, output.blocks, Date.now(), output.content) : undefined
            if (record) queue.push({ type: 'continuation', record })
            else if (output?.blocks.length) queue.push({ type: 'continuation_status', status: 'opaque-state-not-retained' })
          }
          queue.push({ type: 'stop', reason: stopOf(response, mapper.toolCalls()) })
          return
        } catch (error) {
          clearTimeout(idleTimer)
          const idleReason = attemptControl.signal.reason
          const idled = !signal.aborted && attemptControl.signal.aborted && idleReason instanceof ProviderFailure
          const failure = idled ? idleReason : error instanceof ProviderFailure ? error : new ProviderFailure(
            error instanceof CodexAuthError ? error.message : signal.aborted ? 'step aborted' : oneLine(error instanceof Error ? error.message : String(error)),
            { event: signal.aborted ? 'request.aborted' : error instanceof CodexAuthError ? 'auth.error' : 'response.decode', code: error instanceof CodexAuthError ? 'codex-auth' : 'stream-error' },
          )
          if (failure.connectionLimit) attemptSocket.current?.close(true)
          const delay = retryDelay(failure, attempt)
          if (!signal.aborted && failure.transient && !committed && attempt < maxAttempts(failure) && delay !== null) {
            await waitForRetry(delay, signal)
            continue
          }
          queue.push({ type: 'error', kind: error instanceof UpstreamError || error instanceof CodexAuthError ? 'request' : 'response', text: finalText(failure, attempt), ...(failure.info.cause ? { cause: failure.info.cause } : {}), ...(failure.info.status === undefined ? {} : { status: failure.info.status }), ...(signal.aborted ? { aborted: true } : {}) })
          return
        }
      }
    } catch (error) {
      const failure = new ProviderFailure(signal.aborted ? 'step aborted' : error instanceof CodexAuthError ? error.message : oneLine(error instanceof Error ? error.message : String(error)), {
        event: signal.aborted ? 'request.aborted' : error instanceof CodexAuthError ? 'auth.error' : 'request.admission',
        code: signal.aborted ? 'aborted' : error instanceof CodexAuthError ? 'codex-auth' : 'account-limit',
      })
      queue.push({ type: 'error', kind: 'request', text: finalText(failure, attempts), ...(signal.aborted ? { aborted: true } : {}) })
    } finally {
      release?.()
      queue.close()
    }
  })()
  try {
    for await (const event of queue) yield event
    yield { type: 'stats', ttfbMs: ttfb, totalMs: Date.now() - started, transport }
  } finally {
    controller.abort()
    await task
  }
}
