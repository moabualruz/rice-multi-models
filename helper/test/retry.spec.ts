import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { StepEvent, StepRequest } from '../../hooks/protocol.ts'
import { codexStep, streamIdleMs } from '../codex.ts'
import { SocketPool } from '../socket.ts'
import { MAX_ATTEMPTS, MAX_RETRY_WAIT_MS, maxAttempts, OVERLOAD_MAX_ATTEMPTS, ProviderFailure, retryAfterMs, retryDelay, waitForRetry } from '../core/provider-failure.ts'

const req: StepRequest = { target: 'codex/test', system: 'Test', tools: [{ name: 'echo', description: 'Echo', schema: { type: 'object' } }], transcript: [{ role: 'user', content: 'Hi' }], who: 'main', session: 'retry-test' }
const created = { type: 'response.created', response: { id: 'resp_test' } }
const success = [created, { type: 'response.completed', response: { id: 'resp_test', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }], usage: { input_tokens: 1, output_tokens: 1 } } }]
type Reply = { status?: number; headers?: Record<string, string>; events?: unknown[]; close?: number; body?: unknown; rawSse?: string }

async function fake(replies: Reply[], transport: 'sse' | 'ws' | 'auto' = 'sse', pool?: SocketPool) {
  const dir = mkdtempSync(join(tmpdir(), 'mm-retry-'))
  const authFile = join(dir, 'auth.json')
  writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'test-only', account_id: 'retry-test' } }))
  let calls = 0
  let connections = 0
  const respond = () => replies[Math.min(calls++, replies.length - 1)]!
  const server = Bun.serve({
    port: 0,
    async fetch(request, server) {
      if (new URL(request.url).pathname === '/ws') {
        if (replies[Math.min(calls, replies.length - 1)]?.status) {
          const reply = respond()
          return new Response(JSON.stringify(reply.body), { status: reply.status, headers: reply.headers })
        }
        if (server.upgrade(request)) {
          connections++
          return
        }
        return new Response(null, { status: 400 })
      }
      await request.json()
      const reply = respond()
      return new Response(reply.body ? JSON.stringify(reply.body) : reply.rawSse ?? (reply.events ?? success).map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { status: reply.status ?? 200, headers: { 'content-type': 'text/event-stream', ...reply.headers } })
    },
    websocket: {
      message(socket) {
        const reply = respond()
        for (const event of reply.events ?? success) socket.send(JSON.stringify(event))
        if (reply.close) socket.close(reply.close)
      },
    },
  })
  try {
    const events: StepEvent[] = []
    for await (const event of codexStep({ ...req, transport }, 'test', new AbortController().signal, { authFile, pool, httpUrl: `http://127.0.0.1:${server.port}/responses`, wsUrl: `ws://127.0.0.1:${server.port}/ws` })) events.push(event)
    return { events, calls, connections }
  } finally {
    server.stop(true)
    rmSync(dir, { recursive: true, force: true })
  }
}

for (const transport of ['sse', 'ws'] as const) {
  test(`${transport}: a failed event with no message restarts the step`, async () => {
    const result = await fake([{ events: [{ type: 'response.failed' }] }, {}], transport)
    expect(result.calls).toBe(2)
    expect(result.events.find(event => event.type === 'stop')).toEqual({ type: 'stop', reason: 'end_turn' })
    expect(result.events.some(event => event.type === 'error')).toBe(false)
  })
}

test('WebSocket close 1000 before completion retries on a new connection', async () => {
  const result = await fake([{ events: [created], close: 1000 }, {}], 'ws')
  expect(result.calls).toBe(2)
  expect(result.events.some(event => event.type === 'stop')).toBe(true)
})

test('repeated transient 1011 closes exhaust three attempts, report the count and emit no tool_use', async () => {
  const result = await fake([{ events: [created], close: 1011 }], 'ws')
  expect(result.calls).toBe(3)
  expect(result.events.filter(event => event.type === 'tool_use')).toHaveLength(0)
  const error = result.events.find(event => event.type === 'error')
  if (error?.type !== 'error') throw new Error('missing error')
  expect(error.text).toContain('close=1011')
  expect(error.text).toContain('3 attempts')
})

test('a 60-minute WebSocket refusal retries once on a fresh pooled connection without duplicating tool_use', async () => {
  const tool = { type: 'function_call', call_id: 'call_once', name: 'echo', arguments: '{}' }
  const completed = [created,
    { type: 'response.output_item.added', output_index: 0, item: tool },
    { type: 'response.output_item.done', output_index: 0, item: tool },
    { type: 'response.completed', response: { id: 'resp_test', status: 'completed', output: [tool], usage: { input_tokens: 1, output_tokens: 1 } } },
  ]
  const refused = { type: 'error', code: 'websocket_connection_limit_reached', message: 'Responses websocket connection limit reached (60 minutes). Create a new websocket connection to continue.' }
  const result = await fake([{ events: [refused] }, { events: completed }], 'ws', new SocketPool())
  expect(result.calls).toBe(2)
  expect(result.connections).toBe(2)
  expect(result.events.filter(event => event.type === 'tool_use')).toHaveLength(1)
  expect(result.events.find(event => event.type === 'stop')).toEqual({ type: 'stop', reason: 'tool_use' })
  expect(result.events.some(event => event.type === 'error')).toBe(false)
})

test('HTTP 429 honors Retry-After and retries', async () => {
  const started = Date.now()
  const result = await fake([{ status: 429, headers: { 'retry-after': '1' }, body: { error: { code: 'rate_limit_exceeded' } } }, {}])
  expect(result.calls).toBe(2)
  expect(Date.now() - started).toBeGreaterThanOrEqual(1000)
  expect(result.events.some(event => event.type === 'stop')).toBe(true)
})

test('HTTP 401 is permanent and its final error identifies the attempt', async () => {
  const result = await fake([{ status: 401, body: { error: { type: 'authentication_error', code: 'invalid_api_key', message: 'Bearer fake-credential' } } }])
  expect(result.calls).toBe(1)
  const error = result.events.find(event => event.type === 'error')
  expect(error).toMatchObject({ type: 'error', kind: 'request' })
  if (error?.type !== 'error') throw new Error('missing error')
  expect(error.text).toContain('http.response')
  expect(error.text).toContain('invalid_api_key')
  expect(error.text).toContain('1 attempt')
  expect(error.text).not.toContain('fake-credential')
})

test('transient failure exhausts exactly three attempts and retains event/code/type', async () => {
  const result = await fake([{ events: [{ type: 'error', error: { code: 'rate_limit_exceeded', type: 'server_error' } }] }])
  expect(result.calls).toBe(3)
  const error = result.events.find(event => event.type === 'error')
  if (error?.type !== 'error') throw new Error('missing error')
  expect(error.text).toContain('event=error')
  expect(error.text).toContain('rate_limit_exceeded')
  expect(error.text).toContain('server_error')
  expect(error.text).toContain('3 attempts')
})

test('an emitted tool call prevents replay even on a transient error', async () => {
  const tool = { type: 'function_call', call_id: 'call_test', name: 'echo', arguments: '{}' }
  const result = await fake([{ events: [created, { type: 'response.output_item.added', output_index: 0, item: tool }, { type: 'response.output_item.done', output_index: 0, item: tool }, { type: 'response.failed', response: { error: { code: 'server_error' } } }] }])
  expect(result.calls).toBe(1)
  expect(result.events.filter(event => event.type === 'tool_use')).toHaveLength(1)
  expect(result.events.some(event => event.type === 'error')).toBe(true)
})

test('malformed function arguments from the model resample the step before any tool call is emitted', async () => {
  const broken = { type: 'function_call', call_id: 'call_test', name: 'echo', arguments: '{"text":' }
  const result = await fake([{ events: [created, { type: 'response.output_item.added', output_index: 0, item: broken }, { type: 'response.output_item.done', output_index: 0, item: broken }] }, {}])
  expect(result.calls).toBe(2)
  expect(result.events.some(event => event.type === 'tool_use')).toBe(false)
  expect(result.events.find(event => event.type === 'stop')).toEqual({ type: 'stop', reason: 'end_turn' })
})

for (const reply of [
  { events: [{ type: 'error', code: 'invalid_api_key' }] },
  { events: [{ type: 'response.failed', response: { error: { type: 'invalid_request_error' } } }] },
] satisfies Reply[]) {
  test(`permanent streamed rejection is not retried: ${JSON.stringify(reply.events)}`, async () => {
    const result = await fake([reply])
    expect(result.calls, JSON.stringify({ calls: result.calls, events: result.events })).toBe(1)
    expect(result.events.some(event => event.type === 'error')).toBe(true)
  })
}

test('HTTP 429 with a permanent billing code does not retry', async () => {
  for (const code of ['insufficient_quota', 'billing_hard_limit_reached']) {
    const result = await fake([{ status: 429, body: { error: { code } } }])
    expect(result.calls).toBe(1)
  }
})

test('an abruptly reset HTTP body retries without treating malformed JSON as transient', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mm-reset-'))
  const authFile = join(dir, 'auth.json')
  writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'test-only', account_id: 'reset-test' } }))
  let calls = 0
  const server = Bun.listen<{ responded: boolean }>({
    hostname: '127.0.0.1',
    port: 0,
    data: { responded: false },
    socket: {
      open(socket) { socket.data = { responded: false } },
      data(socket) {
        if (socket.data.responded) return
        socket.data.responded = true
        const reset = ++calls === 1
        const body = (reset ? [created] : success).map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
        const length = reset ? 10000 : Buffer.byteLength(body)
        socket.end(`HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: ${length}\r\nConnection: close\r\n\r\n${body}`)
      },
    },
  })
  try {
    const events: StepEvent[] = []
    for await (const event of codexStep({ ...req, transport: 'sse' }, 'test', new AbortController().signal, { authFile, httpUrl: `http://127.0.0.1:${server.port}` })) events.push(event)
    expect(calls, JSON.stringify({ calls, events })).toBe(2)
    expect(events.some(event => event.type === 'stop')).toBe(true)
    const malformed = await fake([{ rawSse: 'data: {invalid\n\n' }])
    expect(malformed.calls).toBe(1)
    expect(malformed.events.some(event => event.type === 'error')).toBe(true)
  } finally {
    server.stop(true)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an HTTP connection reset before response headers retries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mm-opening-reset-'))
  const authFile = join(dir, 'auth.json')
  writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'test-only', account_id: 'opening-reset-test' } }))
  let calls = 0
  const server = Bun.listen<{ responded: boolean }>({
    hostname: '127.0.0.1', port: 0, data: { responded: false },
    socket: {
      open(socket) { socket.data = { responded: false } },
      data(socket) {
        if (socket.data.responded) return
        socket.data.responded = true
        if (++calls === 1) { socket.end(); return }
        const body = success.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
        socket.end(`HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)
      },
    },
  })
  try {
    const events: StepEvent[] = []
    for await (const event of codexStep({ ...req, transport: 'sse' }, 'test', new AbortController().signal, { authFile, httpUrl: `http://127.0.0.1:${server.port}` })) events.push(event)
    expect(calls, JSON.stringify({ calls, events })).toBe(2)
    expect(events.find(event => event.type === 'stop')).toEqual({ type: 'stop', reason: 'end_turn' })
  } finally {
    server.stop(true)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('HTTP 503 and a truncated SSE response are transient', async () => {
  for (const reply of [{ status: 503, body: { error: { type: 'server_error' } } }, { events: [created] }] satisfies Reply[]) {
    const result = await fake([reply, {}])
    expect(result.calls, JSON.stringify({ calls: result.calls, events: result.events })).toBe(2)
    expect(result.events.some(event => event.type === 'stop')).toBe(true)
  }
})

test('WebSocket policy close 1008 is permanent', async () => {
  const result = await fake([{ events: [created], close: 1008 }], 'ws')
  expect(result.calls).toBe(1)
  const error = result.events.find(event => event.type === 'error')
  if (error?.type !== 'error') throw new Error('missing error')
  expect(error.text).toContain('websocket.close')
  expect(error.text).toContain('close=1008')
  expect(error.text).toContain('1 attempt')
})

test('visible attempt text is preserved and a transient failure is not replayed', async () => {
  const result = await fake([{ events: [created,
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message' } },
    { type: 'response.output_text.delta', output_index: 0, delta: 'partial' },
    { type: 'response.failed' },
  ] }, {}])
  expect(result.calls).toBe(1)
  expect(result.events.filter(event => event.type === 'text')).toEqual([{ type: 'text', text: 'partial' }])
  expect(result.events.some(event => event.type === 'error')).toBe(true)
  expect(result.events.some(event => event.type === 'stop')).toBe(false)
})

test('final stream failures redact the actual login even when echoed as a short unlabelled value', async () => {
  const result = await fake([{ events: [{ type: 'error', code: 'invalid_api_key', message: 'Rejected test-only for retry-test' }] }])
  const error = result.events.find(event => event.type === 'error')
  if (error?.type !== 'error') throw new Error('missing error')
  expect(error.text).not.toContain('test-only')
  expect(error.text).not.toContain('retry-test')
  expect(error.text).toContain('[REDACTED]')
})

test('an out-of-budget Retry-After is not shortened or retried early', async () => {
  const result = await fake([{ status: 429, headers: { 'retry-after': '60' }, body: { error: { code: 'rate_limit_exceeded' } } }])
  expect(result.calls).toBe(1)
  expect(result.events.some(event => event.type === 'error')).toBe(true)
})

test('auto transport recovers a rejected handshake through HTTP and does not retry a permanent 401', async () => {
  const result = await fake([{ status: 401, body: { error: { code: 'invalid_api_key' } } }], 'auto')
  expect(result.calls).toBe(2)
  const error = result.events.find(event => event.type === 'error')
  if (error?.type !== 'error') throw new Error('missing error')
  expect(error.text).toContain('HTTP 401')
  expect(error.text).toContain('invalid_api_key')
  expect(error.text).toContain('1 attempt')
})

test('classification and exponential jitter preserve bounded retry semantics', async () => {
  for (const code of ['server_error', 'rate_limit_exceeded', 'concurrency_limit_exceeded']) expect(ProviderFailure.event({ type: 'error', error: { code } }).transient).toBe(true)
  for (const code of ['invalid_api_key', 'insufficient_quota', 'unknown_error']) expect(ProviderFailure.event({ type: 'error', error: { code } }).transient).toBe(false)
  for (const status of [429, 500, 503]) expect(new ProviderFailure('', { event: 'http.response', status }).transient).toBe(true)
  for (const status of [401, 403, 400]) expect(new ProviderFailure('', { event: 'http.response', status, code: 'server_error' }).transient).toBe(false)
  const failure = ProviderFailure.event({ type: 'response.failed' })
  expect(retryDelay(failure, 1, () => 0)).toBe(500)
  expect(retryDelay(failure, 1, () => 1)).toBe(1000)
  expect(retryDelay(failure, 2, () => 0)).toBe(1000)
  expect(retryDelay(failure, 2, () => 1)).toBe(2000)
  expect(retryDelay(new ProviderFailure('', { event: 'error', retryAfterMs: 3000 }), 1, () => 0)).toBe(3000)
  expect(retryDelay(new ProviderFailure('', { event: 'error', retryAfterMs: MAX_RETRY_WAIT_MS + 1 }), 1)).toBe(null)
  expect(retryAfterMs('2')).toBe(2000)
  expect(retryAfterMs('Thu, 01 Jan 1970 00:00:03 GMT', 1000)).toBe(2000)
  expect(retryAfterMs('invalid')).toBeUndefined()
  const controller = new AbortController()
  const pending = waitForRetry(30_000, controller.signal)
  controller.abort(new Error('cancelled'))
  await expect(pending).rejects.toThrow('cancelled')
})

test('provider overload is transient with a longer, capped schedule', () => {
  const overloaded = new ProviderFailure('Our servers are currently overloaded. Please try again later.', { event: 'error', code: 'server_is_overloaded' })
  expect(overloaded.overloaded).toBe(true)
  expect(overloaded.transient).toBe(true)
  expect(maxAttempts(overloaded)).toBe(OVERLOAD_MAX_ATTEMPTS)
  expect(retryDelay(overloaded, 1, () => 0)).toBe(2000)
  expect(retryDelay(overloaded, 4, () => 0)).toBe(16000)
  expect(retryDelay(overloaded, 5, () => 1)).toBe(MAX_RETRY_WAIT_MS)
  const capacity = new ProviderFailure('Selected model is at capacity. Please try a different model.', { event: 'error' })
  expect(capacity.overloaded).toBe(true)
  expect(new ProviderFailure('', { event: 'http.response', status: 503 }).overloaded).toBe(true)
  const ordinary = new ProviderFailure('', { event: 'error', code: 'rate_limit_exceeded' })
  expect(ordinary.overloaded).toBe(false)
  expect(maxAttempts(ordinary)).toBe(MAX_ATTEMPTS)
  const connectionLimit = ProviderFailure.event({ type: 'error', code: 'websocket_connection_limit_reached', message: 'Responses websocket connection limit reached (60 minutes). Create a new websocket connection to continue.' })
  expect(connectionLimit.transient).toBe(true)
  expect(connectionLimit.overloaded).toBe(false)
  expect(maxAttempts(connectionLimit)).toBe(2)
  const permanent = new ProviderFailure('model unavailable for this account', { event: 'error', code: 'model_not_found' })
  expect(permanent.overloaded).toBe(false)
  expect(permanent.transient).toBe(false)
})

test('stream idle timeout parses its setting and rejects invalid values', () => {
  expect(streamIdleMs({})).toBe(300_000)
  expect(streamIdleMs({ RICE_CODEX_STREAM_IDLE_MS: '0' })).toBe(0)
  expect(streamIdleMs({ RICE_CODEX_STREAM_IDLE_MS: '200' })).toBe(200)
  for (const value of ['-1', 'soon', '1.5', '', '99999999']) expect(() => streamIdleMs({ RICE_CODEX_STREAM_IDLE_MS: value })).toThrow()
})

test('a stream that goes silent is abandoned and the step retried', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mm-idle-'))
  const authFile = join(dir, 'auth.json')
  writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'test-only', account_id: 'idle-test' } }))
  const encoder = new TextEncoder()
  let calls = 0
  let cancelled = 0
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      await request.json()
      if (calls++ === 0) {
        return new Response(new ReadableStream<Uint8Array>({
          start(sink) { sink.enqueue(encoder.encode(`data: ${JSON.stringify(created)}\n\n`)) },
          cancel() { cancelled++ },
        }), { headers: { 'content-type': 'text/event-stream' } })
      }
      return new Response(success.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    const events: StepEvent[] = []
    for await (const event of codexStep({ ...req, transport: 'sse' }, 'test', new AbortController().signal, { authFile, env: { RICE_CODEX_STREAM_IDLE_MS: '200' }, httpUrl: `http://127.0.0.1:${server.port}/responses` })) events.push(event)
    expect(calls).toBe(2)
    expect(events.find(event => event.type === 'stop')).toEqual({ type: 'stop', reason: 'end_turn' })
    expect(events.some(event => event.type === 'error')).toBe(false)
    await Bun.sleep(50)
    expect(cancelled).toBe(1)
  } finally {
    server.stop(true)
    rmSync(dir, { recursive: true, force: true })
  }
})
