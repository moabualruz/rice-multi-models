import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { StepEvent, StepRequest } from '../../hooks/protocol.ts'
import { codexStep } from '../codex.ts'

const req: StepRequest = { target: 'codex/test', system: 'Test', tools: [{ name: 'echo', description: 'Echo', schema: { type: 'object' } }], transcript: [{ role: 'user', content: 'Hi' }], who: 'main', session: 'retry-test' }
const created = { type: 'response.created', response: { id: 'resp_test' } }
const success = [created, { type: 'response.completed', response: { id: 'resp_test', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }], usage: { input_tokens: 1, output_tokens: 1 } } }]
type Reply = { status?: number; headers?: Record<string, string>; events?: unknown[]; close?: number; body?: unknown }

async function fake(replies: Reply[], transport: 'sse' | 'ws' = 'sse') {
  const dir = mkdtempSync(join(tmpdir(), 'mm-retry-'))
  const authFile = join(dir, 'auth.json')
  writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'test-only', account_id: 'retry-test' } }))
  let calls = 0
  const respond = () => replies[Math.min(calls++, replies.length - 1)]!
  const server = Bun.serve({
    port: 0,
    async fetch(request, server) {
      if (new URL(request.url).pathname === '/ws') {
        if (server.upgrade(request)) return
        return new Response(null, { status: 400 })
      }
      await request.json()
      const reply = respond()
      return new Response(reply.body ? JSON.stringify(reply.body) : (reply.events ?? success).map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { status: reply.status ?? 200, headers: { 'content-type': 'text/event-stream', ...reply.headers } })
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
    for await (const event of codexStep({ ...req, transport }, 'test', new AbortController().signal, { authFile, httpUrl: `http://127.0.0.1:${server.port}/responses`, wsUrl: `ws://127.0.0.1:${server.port}/ws` })) events.push(event)
    return { events, calls }
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
