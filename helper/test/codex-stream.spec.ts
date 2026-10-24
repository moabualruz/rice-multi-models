// Deterministic Codex stream/retry contracts over loopback SSE, through codexStep.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'

import type { StepEvent, StepRequest } from '../../hooks/protocol.ts'
import { codexStep } from '../codex.ts'

const step: StepRequest = {
  target: 'codex/gpt-6.1-sol',
  system: 'Test stream behavior.',
  tools: [{ name: 'echo_tool', description: 'Echo text', schema: { type: 'object' } }],
  transcript: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  who: 'main',
  session: 'codex-stream-test',
  transport: 'sse',
}

let authDir = ''
let authFile = ''

beforeAll(() => {
  authDir = mkdtempSync(join(tmpdir(), 'mm-codex-stream-test-'))
  authFile = join(authDir, 'auth.json')
  const jwt = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"exp":4102444800}').toString('base64url')}.sig`
  writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: jwt, account_id: 'acct_test', refresh_token: 'rt_test' } }))
})

afterAll(() => {
  rmSync(authDir, { recursive: true, force: true })
})

type Send = (event: Record<string, unknown>) => void
type Plan = (attempt: number, send: Send, cancelled: Promise<void>) => Promise<void>

async function serve(plan: Plan) {
  let requests = 0
  const server = createServer((request, response) => {
    requests += 1
    request.resume()
    request.once('end', () => {
      let cancelResponse!: () => void
      const responseCancelled = new Promise<void>(resolve => {
        cancelResponse = resolve
      })
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      response.on('close', cancelResponse)
      const send: Send = event => response.write(`data: ${JSON.stringify(event)}\n\n`)
      void plan(requests, send, responseCancelled).then(
        () => response.end(),
        error => response.destroy(error instanceof Error ? error : new Error(String(error))),
      )
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('loopback server did not bind a TCP port')

  return {
    url: `http://127.0.0.1:${address.port}/responses`,
    requests: () => requests,
    close: () => {
      server.closeAllConnections()
      server.close()
    },
  }
}

function stepEvents(url: string, signal = new AbortController().signal) {
  return codexStep(step, 'gpt-6.1-sol', signal, { authFile, httpUrl: url })[Symbol.asyncIterator]()
}

function sendTextStart(send: Send, text = 'early text') {
  send({ type: 'response.created', response: { id: 'resp_1' } })
  send({ type: 'response.output_item.added', output_index: 0, item: { id: 'msg_1', type: 'message', content: [] } })
  send({ type: 'response.output_text.delta', output_index: 0, delta: text })
}

function sendTextItemDone(send: Send, text = 'early text') {
  send({ type: 'response.output_item.done', output_index: 0, item: { id: 'msg_1', type: 'message', content: [{ type: 'output_text', text }] } })
}

function sendTextCompletion(send: Send, text = 'early text') {
  sendTextItemDone(send, text)
  send({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [{ id: 'msg_1', type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 4, output_tokens: 2 } } })
}

function failed(send: Send, code = 'server_error') {
  send({ type: 'response.failed', response: { error: { code, message: 'synthetic provider failure' } } })
}

test('a typed context overflow is terminal once, even when its message resembles transient overload', async () => {
  const server = await serve(async (_attempt, send) => {
    send({ type: 'response.failed', response: { error: { code: 'context_length_exceeded', message: 'Owned input exceeds context capacity.' } } })
  })
  try {
    const events = await collect(stepEvents(server.url))
    expect(events.find(event => event.type === 'error')).toMatchObject({ cause: 'context_overflow' })
    expect(events.some(event => event.type === 'stop')).toBe(false)
    expect(server.requests()).toBe(1)
  } finally { server.close() }
})

async function nextWithDeadlockGuard<T>(iterator: AsyncIterator<T>): Promise<IteratorResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('stream did not yield before its completion handshake')), 3000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function collect(iterator: AsyncIterator<StepEvent>): Promise<StepEvent[]> {
  const events: StepEvent[] = []
  for (;;) {
    const next = await iterator.next()
    if (next.done) return events
    events.push(next.value)
  }
}

function acknowledgeOnText() {
  let acknowledge!: () => void
  const received = new Promise<void>(resolve => {
    acknowledge = resolve
  })

  return { received, acknowledge }
}

test('yields first text before response completion using a consumer acknowledgement handshake', async () => {
  const handshake = acknowledgeOnText()
  const server = await serve(async (_attempt, send, cancelled) => {
    sendTextStart(send)
    await Promise.race([handshake.received, cancelled])
    if (!handshakeWasReceived) return
    sendTextCompletion(send)
  })
  let handshakeWasReceived = false
  const abort = new AbortController()
  const iterator = stepEvents(server.url, abort.signal)
  try {
    const first = await nextWithDeadlockGuard(iterator)
    expect(first).toEqual({ done: false, value: { type: 'text', text: 'early text' } })
    handshakeWasReceived = true
    handshake.acknowledge()
    const rest = await collect(iterator)
    expect(rest.find(event => event.type === 'usage')).toMatchObject({ type: 'usage', in: 4, out: 2 })
    expect(rest.find(event => event.type === 'stop')).toEqual({ type: 'stop', reason: 'end_turn' })
    expect(server.requests()).toBe(1)
  } finally {
    handshake.acknowledge()
    abort.abort()
    await iterator.return?.()
    server.close()
  }
})

test('yields documented reasoning summaries before completion without exposing signatures as text', async () => {
  const handshake = acknowledgeOnText()
  let handshakeWasReceived = false
  const server = await serve(async (_attempt, send, cancelled) => {
    send({ type: 'response.created', response: { id: 'resp_1' } })
    send({ type: 'response.output_item.added', output_index: 0, item: { id: 'reason_1', type: 'reasoning', encrypted_content: null, summary: [] } })
    send({ type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'visible summary' })
    await Promise.race([handshake.received, cancelled])
    if (!handshakeWasReceived) return
    const reasoning = { id: 'reason_1', type: 'reasoning', encrypted_content: 'opaque-signature-payload', summary: [{ type: 'summary_text', text: 'visible summary' }] }
    send({ type: 'response.output_item.done', output_index: 0, item: reasoning })
    send({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [reasoning], usage: { input_tokens: 4, output_tokens: 2 } } })
  })
  const iterator = stepEvents(server.url)
  try {
    const first = await nextWithDeadlockGuard(iterator)
    expect(first).toEqual({ done: false, value: { type: 'thinking', text: 'visible summary' } })
    handshakeWasReceived = true
    handshake.acknowledge()
    const rest = await collect(iterator)
    expect(rest.some(event => event.type === 'signature')).toBe(true)
    expect(rest.some(event => event.type === 'text' && event.text.includes('opaque-signature-payload'))).toBe(false)
    expect(server.requests()).toBe(1)
  } finally {
    handshake.acknowledge()
    await iterator.return?.()
    server.close()
  }
})

test('preserves text and does not retry a retryable failure after visible output', async () => {
  const handshake = acknowledgeOnText()
  let handshakeWasReceived = false
  const server = await serve(async (_attempt, send, cancelled) => {
    sendTextStart(send, 'partial')
    await Promise.race([handshake.received, cancelled])
    if (!handshakeWasReceived) return
    failed(send)
  })
  const iterator = stepEvents(server.url)
  try {
    const first = await nextWithDeadlockGuard(iterator)
    expect(first.value).toEqual({ type: 'text', text: 'partial' })
    handshakeWasReceived = true
    handshake.acknowledge()
    const rest = await collect(iterator)
    expect(rest.find(event => event.type === 'error')).toMatchObject({ type: 'error', kind: 'response' })
    expect(server.requests()).toBe(1)
  } finally {
    handshake.acknowledge()
    await iterator.return?.()
    server.close()
  }
})

test('retries a retryable failure before visible output', async () => {
  const server = await serve(async (attempt, send) => {
    if (attempt === 1) {
      send({ type: 'response.created', response: { id: 'resp_1' } })
      failed(send)
      return
    }
    sendTextStart(send, 'retried answer')
    sendTextCompletion(send, 'retried answer')
  })
  const iterator = stepEvents(server.url)
  try {
    const events = await collect(iterator)
    expect(events.filter(event => event.type === 'text')).toEqual([{ type: 'text', text: 'retried answer' }])
    expect(events.find(event => event.type === 'error')).toBeUndefined()
    expect(server.requests()).toBe(2)
  } finally {
    await iterator.return?.()
    server.close()
  }
})

test('orders visible text before a complete validated tool call', async () => {
  const handshake = acknowledgeOnText()
  let handshakeWasReceived = false
  const server = await serve(async (_attempt, send, cancelled) => {
    sendTextStart(send, 'before tool')
    await Promise.race([handshake.received, cancelled])
    if (!handshakeWasReceived) return
    sendTextItemDone(send, 'before tool')
    send({ type: 'response.output_item.added', output_index: 1, item: { id: 'call_item', type: 'function_call', call_id: 'call_1', name: 'echo_tool' } })
    send({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"text":"ok"}' })
    const call = { id: 'call_item', type: 'function_call', call_id: 'call_1', name: 'echo_tool', arguments: '{"text":"ok"}' }
    send({ type: 'response.output_item.done', output_index: 1, item: call })
    send({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [{ id: 'msg_1', type: 'message', content: [{ type: 'output_text', text: 'before tool' }] }, call], usage: { input_tokens: 4, output_tokens: 5 } } })
  })
  const iterator = stepEvents(server.url)
  try {
    const first = await nextWithDeadlockGuard(iterator)
    expect(first.value).toEqual({ type: 'text', text: 'before tool' })
    handshakeWasReceived = true
    handshake.acknowledge()
    const rest = await collect(iterator)
    const textIndex = rest.findIndex(event => event.type === 'text')
    const toolIndex = rest.findIndex(event => event.type === 'tool_use')
    expect(toolIndex).toBeGreaterThan(textIndex)
    expect(rest[toolIndex]).toEqual({ type: 'tool_use', id: 'call_1', name: 'echo_tool', input: { text: 'ok' } })
    expect(server.requests()).toBe(1)
  } finally {
    handshake.acknowledge()
    await iterator.return?.()
    server.close()
  }
})

test('withholds an incomplete tool call on provider failure', async () => {
  const server = await serve(async (_attempt, send) => {
    send({ type: 'response.created', response: { id: 'resp_1' } })
    send({ type: 'response.output_item.added', output_index: 0, item: { id: 'call_item', type: 'function_call', call_id: 'call_1', name: 'echo_tool' } })
    send({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"text":' })
    failed(send, 'invalid_request_error')
  })
  const iterator = stepEvents(server.url)
  try {
    const events = await collect(iterator)
    expect(events.some(event => event.type === 'tool_use')).toBe(false)
    expect(events.find(event => event.type === 'error')).toBeDefined()
    expect(server.requests()).toBe(1)
  } finally {
    await iterator.return?.()
    server.close()
  }
})

test('withholds malformed completed tool arguments after text without replay', async () => {
  const handshake = acknowledgeOnText()
  let handshakeWasReceived = false
  const server = await serve(async (_attempt, send, cancelled) => {
    sendTextStart(send, 'answer before malformed call')
    await Promise.race([handshake.received, cancelled])
    if (!handshakeWasReceived) return
    sendTextItemDone(send, 'answer before malformed call')
    send({ type: 'response.output_item.added', output_index: 1, item: { id: 'call_item', type: 'function_call', call_id: 'call_1', name: 'echo_tool' } })
    send({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"text":' })
    const call = { id: 'call_item', type: 'function_call', call_id: 'call_1', name: 'echo_tool', arguments: '{"text":' }
    send({ type: 'response.output_item.done', output_index: 1, item: call })
    send({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [{ id: 'msg_1', type: 'message', content: [{ type: 'output_text', text: 'answer before malformed call' }] }, call], usage: { input_tokens: 4, output_tokens: 3 } } })
  })
  const iterator = stepEvents(server.url)
  try {
    const first = await nextWithDeadlockGuard(iterator)
    expect(first.value).toEqual({ type: 'text', text: 'answer before malformed call' })
    handshakeWasReceived = true
    handshake.acknowledge()
    const rest = await collect(iterator)
    expect(rest.some(event => event.type === 'tool_use')).toBe(false)
    expect(rest.find(event => event.type === 'error')).toBeDefined()
    expect(server.requests()).toBe(1)
  } finally {
    handshake.acknowledge()
    await iterator.return?.()
    server.close()
  }
})
