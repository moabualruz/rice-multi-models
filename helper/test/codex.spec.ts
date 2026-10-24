// The Codex provider against local fakes: the event mapping, the request it builds, and both transports
// (server-sent events and a WebSocket) replaying event streams captured from the real backend, with the
// encrypted reasoning replaced. Run: bun test helper
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { StepEvent, StepRequest } from '../../hooks/protocol.ts'
import { codexStep, eventMapper, limitsOf, messagesBody, ORIGINATOR, responsesRequest } from '../codex.ts'
import { SocketPool } from '../socket.ts'

const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, 'fixtures', `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>)

const step: StepRequest = {
  target: 'codex/gpt-6.1-sol',
  system: 'You are a test.',
  tools: [
    { name: 'echo_tool', description: 'Echo text', schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    { name: 'mcp__far__away', description: 'A deferred MCP tool', schema: { type: 'object' }, deferred: true },
  ],
  transcript: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  effort: 'medium',
  who: 'main',
  session: 'session-1',
}

let dir = ''
let authFile = ''
let server: ReturnType<typeof Bun.serve>
let seen: { headers: Record<string, string>; body: Record<string, unknown> }[] = []
let replay: Record<string, unknown>[] = []

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mm-codex-test-'))
  authFile = join(dir, 'auth.json')
  const jwt = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"exp":4102444800}').toString('base64url')}.sig`
  writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: jwt, account_id: 'acct_test', refresh_token: 'rt_test' } }))
  server = Bun.serve({
    port: 0,
    async fetch(request, srv) {
      const headers = Object.fromEntries(request.headers.entries())
      if (new URL(request.url).pathname === '/ws') {
        if (srv.upgrade(request, { data: { headers } })) return undefined

        return new Response('upgrade failed', { status: 400 })
      }
      seen.push({ headers, body: (await request.json()) as Record<string, unknown> })
      const sse = replay.filter(event => event.type !== 'codex.rate_limits').map(event => `data: ${JSON.stringify(event)}\n\n`).join('')

      return new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
    },
    websocket: {
      message(socket, message) {
        const body = JSON.parse(String(message)) as Record<string, unknown>
        seen.push({ headers: (socket.data as { headers: Record<string, string> }).headers, body })
        for (const event of replay) socket.send(JSON.stringify(event))
      },
    },
  })
})

afterAll(() => {
  server.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

async function run(transport: 'ws' | 'sse' | 'auto', wsUrl?: string, pool?: SocketPool): Promise<StepEvent[]> {
  const events: StepEvent[] = []
  for await (const event of codexStep({ ...step, transport }, 'gpt-6.1-sol', new AbortController().signal, {
    authFile,
    pool,
    httpUrl: `http://127.0.0.1:${server.port}/responses`,
    wsUrl: wsUrl ?? `ws://127.0.0.1:${server.port}/ws`,
  })) {
    events.push(event)
  }

  return events
}

test('the request is the translated conversation, our originator, a stable cache key and no deferred tool', () => {
  const body = messagesBody(step, 'gpt-6.1-sol')
  expect(body.output_config).toEqual({ effort: 'medium' })
  expect(messagesBody({ ...step, effort: 4000 }, 'gpt-6.1-sol').thinking).toEqual({ type: 'enabled', budget_tokens: 4000 })
  const request = responsesRequest(step, 'gpt-6.1-sol', body)
  expect(request.store).toBe(false)
  expect(request.tools.map(tool => (tool as { name?: string }).name)).toEqual(['echo_tool'])
  expect(request.instructions.startsWith('You are a test.')).toBe(true)
  expect(request.instructions.includes('OpenAI provider instructions')).toBe(true)
  expect(request.prompt_cache_key).toBe(responsesRequest(step, 'gpt-6.1-sol', body).prompt_cache_key)
  expect(request.prompt_cache_key).not.toBe(responsesRequest({ ...step, who: 'agent-1' }, 'gpt-6.1-sol', body).prompt_cache_key)
})

test('rate limits read as labelled windows', () => {
  const limits = limitsOf({ plan_type: 'pro', rate_limits: { primary: { used_percent: 76, window_minutes: 10080, reset_at: 1_800_000_000 }, secondary: { used_percent: 3, window_minutes: 300 } } })
  expect(limits).toEqual({ plan: 'pro', windows: [{ label: 'wk', usedPercent: 76, resetsAt: 1_800_000_000_000 }, { label: '5h', usedPercent: 3, resetsAt: undefined }] })
  expect(limitsOf({})).toBe(null)
})

test('the event mapper streams text and thinking, closes a reasoning block with its signature, and emits whole tool calls', () => {
  const events: StepEvent[] = []
  const mapper = eventMapper(event => events.push(event))
  mapper.emit('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } })
  mapper.emit('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } })
  mapper.emit('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'multi-openai:abc' } })
  mapper.emit('content_block_stop', { index: 0 })
  mapper.emit('content_block_start', { index: 1, content_block: { type: 'text', text: '' } })
  mapper.emit('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'Hi' } })
  mapper.emit('content_block_stop', { index: 1 })
  mapper.emit('content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'call_1', name: 'Read', input: {} } })
  mapper.emit('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '{"file_path":' } })
  mapper.emit('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '"/x"}' } })
  mapper.emit('content_block_stop', { index: 2 })
  expect(events).toEqual([
    { type: 'thinking', text: 'plan' },
    { type: 'signature', thinking: 'plan', signature: 'multi-openai:abc' },
    { type: 'text', text: 'Hi' },
    { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: '/x' } },
  ])
  expect(mapper.toolCalls()).toBe(1)
})

test('over server-sent events a captured text answer streams and stops with its usage', async () => {
  seen = []
  replay = fixture('text')
  const events = await run('sse')
  expect(events.filter(event => event.type === 'text').map(event => (event as { text: string }).text).join('')).toBe('two words')
  expect(events.find(event => event.type === 'stop')).toEqual({ type: 'stop', reason: 'end_turn' })
  expect(events.find(event => event.type === 'usage')).toMatchObject({ type: 'usage', out: expect.any(Number) })
  expect(events.at(-1)).toMatchObject({ type: 'stats', transport: 'sse' })
  expect(seen[0]?.headers.originator).toBe(ORIGINATOR)
  expect(seen[0]?.headers['chatgpt-account-id']).toBe('acct_test')
  expect(seen[0]?.headers.authorization?.startsWith('Bearer ')).toBe(true)
  expect(seen[0]?.body.store).toBe(false)
})

test('over a WebSocket reasoning, its signature, the tool call and the rate limits all arrive', async () => {
  seen = []
  replay = fixture('reasoning-tool')
  const events = await run('ws')
  expect(events.some(event => event.type === 'limits')).toBe(true)
  expect(events.filter(event => event.type === 'thinking').map(event => (event as { text: string }).text).join('')).toBe('Hat rhymes with cat.')
  const signature = events.find(event => event.type === 'signature') as { signature: string } | undefined
  expect(signature?.signature.startsWith('multi-openai:')).toBe(true)
  expect(events.find(event => event.type === 'tool_use')).toMatchObject({ type: 'tool_use', name: 'echo_tool', input: { text: 'hi' } })
  expect(events.find(event => event.type === 'stop')).toEqual({ type: 'stop', reason: 'tool_use' })
  expect(events.at(-1)).toMatchObject({ type: 'stats', transport: 'ws' })
  expect(seen[0]?.headers['openai-beta']).toBe('responses_websockets=2026-02-06')
  expect(seen[0]?.body.type).toBe('response.create')
  expect('stream' in (seen[0]?.body ?? {})).toBe(false)
})

test('auto falls back to server-sent events when the WebSocket cannot open', async () => {
  seen = []
  replay = fixture('text')
  const events = await run('auto', 'ws://127.0.0.1:9/ws')
  expect(events.at(-1)).toMatchObject({ type: 'stats', transport: 'sse' })
  expect(events.find(event => event.type === 'stop')).toEqual({ type: 'stop', reason: 'end_turn' })
})

test('a pooled connection answers the next step of the same conversation without a new handshake', async () => {
  seen = []
  replay = fixture('text')
  const pool = new SocketPool()
  const first = await run('ws', undefined, pool)
  const second = await run('ws', undefined, pool)
  expect(first.at(-1)).toMatchObject({ type: 'stats', transport: 'ws' })
  expect(second.at(-1)).toMatchObject({ type: 'stats', transport: 'ws reused' })
  expect(second.filter(event => event.type === 'text').map(event => (event as { text: string }).text).join('')).toBe('two words')
  expect(pool.size).toBe(1)
  pool.closeAll()
  expect(pool.size).toBe(0)
})

test('a pooled socket is retired at 55 minutes rather than reused', async () => {
  seen = []
  replay = fixture('text')
  let now = Date.now()
  const pool = new SocketPool(5 * 60_000, () => now)
  const first = await run('ws', undefined, pool)
  now += 55 * 60_000
  const second = await run('ws', undefined, pool)
  expect(first.at(-1)).toMatchObject({ type: 'stats', transport: 'ws' })
  expect(second.at(-1)).toMatchObject({ type: 'stats', transport: 'ws' })
  expect(seen).toHaveLength(2)
  expect(pool.size).toBe(1)
  now += 55 * 60_000
  pool.sweep()
  expect(pool.size).toBe(0)
  pool.closeAll()
})

test('rotating an aged busy socket preserves its active response and retires it afterward', async () => {
  let now = Date.now()
  let releaseFirst: (() => void) | undefined
  let sendFirstCompletion: (() => void) | undefined
  const firstMessage = new Promise<void>(resolve => { releaseFirst = resolve })
  const server = Bun.serve({
    port: 0,
    fetch(request, srv) {
      if (srv.upgrade(request)) return undefined

      return new Response('upgrade failed', { status: 400 })
    },
    websocket: {
      message(socket) {
        sendFirstCompletion ??= () => socket.send(JSON.stringify({ type: 'response.completed' }))
        releaseFirst?.()
        releaseFirst = undefined
      },
    },
  })
  const pool = new SocketPool(5 * 60_000, () => now)
  const url = `ws://127.0.0.1:${server.port}/ws`
  try {
    const first = await pool.take('active', url, {})
    const iterator = first.socket.response({}, new AbortController().signal, () => null, () => {})[Symbol.asyncIterator]()
    const firstEvent = iterator.next()
    await firstMessage
    now += 55 * 60_000
    const second = await pool.take('active', url, {})
    expect(first.socket.closed).toBe(false)
    expect(second.reused).toBe(false)
    expect(second.socket).not.toBe(first.socket)
    expect(pool.size).toBe(1)
    sendFirstCompletion?.()
    expect((await firstEvent).done).toBe(false)
    expect((await iterator.next()).done).toBe(true)
    expect(first.socket.closed).toBe(true)
  } finally {
    pool.closeAll()
    server.stop(true)
  }
})
