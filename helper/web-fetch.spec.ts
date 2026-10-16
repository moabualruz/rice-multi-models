import { expect, test } from 'bun:test'
import { createServer } from 'node:http'
import type { StepEvent, StepWire } from '../hooks/protocol.ts'
import { fingerprint, parseConfig } from '../hooks/config.ts'
import { createWebFetch, fetchedText, WebFetchUnavailable } from './web-fetch.ts'

const url = 'https://docs.example/page', prompt = 'What changed?'
const wire: StepWire = { configText: '', approved: ['owned-approval'], req: { target: 'codex/owned-child-model', who: 'child-owned', session: 'owned-session', system: 'Unrelated private prompt', transcript: [{ role: 'user', content: 'Unrelated private context' }], tools: [{ name: 'Bash', description: 'Not offered', schema: {} }] } }
const input = { wire, url, prompt }
const signal = () => new AbortController().signal
const page = async (_url?: unknown, _init?: unknown): Promise<Response> => new Response('<h1>Changed release</h1><p>Actual evidence</p>', { headers: { 'content-type': 'text/html' } })
async function* complete(): AsyncGenerator<StepEvent> { yield { type: 'text', text: 'The release changed.' }; yield { type: 'stop', reason: 'end_turn' } }

test('retrieval sends no account headers and extraction keeps the exact selected child owner', async () => {
  const before = JSON.stringify(input)
  const run = createWebFetch({ request: async (asked, init) => { expect(String(asked)).toBe(url); expect(init?.redirect).toBe('manual'); expect(init?.headers).not.toHaveProperty('authorization'); expect(init?.headers).not.toHaveProperty('x-api-key'); return page(asked, init) }, step: async function* (selected) {
    expect(selected.req.target).toBe(wire.req.target); expect(selected.req.who).toBe('child-owned'); expect(selected.req.session).toBe('owned-session')
    expect(selected.approved).toEqual(wire.approved); expect(selected.configText).toBe(wire.configText); expect(selected.req.tools).toEqual([])
    expect(JSON.stringify(selected.req.transcript)).not.toContain('Unrelated private')
    expect(JSON.parse(String(selected.req.transcript[0]!.content))).toMatchObject({ request: prompt, sourceUrl: url, untrustedPage: 'Changed release\n\nActual evidence' })
    yield* complete()
  } })
  const answer = await run(input, signal())
  expect(answer).toMatchObject({ url, code: 200, codeText: 'OK', result: 'The release changed.' }); expect(answer.bytes).toBeGreaterThan(0); expect(answer.durationMs).toBeGreaterThanOrEqual(0)
  expect(answer.artifactRead).toBeUndefined(); expect(JSON.stringify(input)).toBe(before)
})

test('HTML conversion strips executable content without evaluating it and preserves textual links', () => {
  const html = '<script>throw Error("must never run")</script><style>secret CSS</style><noscript>hidden</noscript><iframe>foreign doc</iframe><p>A &amp; B &#x1f600;</p><a href="/guide?x=1&amp;y=2">Guide</a>'
  expect(fetchedText(html, 'text/html', url)).toBe('A & B \u{1f600}\nGuide (https://docs.example/guide?x=1&y=2)')
  expect(fetchedText('<b>literal</b>', 'text/plain', url)).toBe('<b>literal</b>')
})

test('HTTP input upgrades to HTTPS and same-origin redirects retain the approved origin', async () => {
  const seen: string[] = []
  const run = createWebFetch({ request: async asked => { seen.push(String(asked)); return seen.length === 1 ? new Response(null, { status: 302, headers: { location: '/new-page' } }) : new Response('Approved content', { headers: { 'content-type': 'text/plain' } }) }, step: complete })
  const answer = await run({ ...input, url: 'http://docs.example/page' }, signal())
  expect(seen).toEqual(['https://docs.example/page', 'https://docs.example/new-page']); expect(answer.url).toBe('http://docs.example/page')
})

test('cross-origin redirects are returned unfetched, and HTTP errors never invoke extraction', async () => {
  let extraction = 0, fetches = 0
  for (const response of [new Response(null, { status: 302, headers: { location: 'https://other.example/private' } }), new Response('not read', { status: 429, headers: { 'retry-after': '15' } })]) {
    const run = createWebFetch({ request: async () => { fetches++; return response }, step: async function* () { extraction++; yield* complete() } })
    const answer = await run(input, signal())
    expect(answer.code).toBe(response.status)
    expect(answer.result).toContain(response.status === 302 ? 'not fetched automatically' : 'Retry-After: 15')
  }
  expect(fetches).toBe(2); expect(extraction).toBe(0)
})

test('invalid URLs, credentials, offsets and nontext content fail explicitly before provider inference', async () => {
  let requests = 0, extractions = 0
  const run = createWebFetch({ request: async () => { requests++; return new Response(new Uint8Array([0, 1]), { headers: { 'content-type': 'application/pdf' } }) }, step: async function* () { extractions++; yield* complete() } })
  for (const change of [{ url: 'file:///tmp/private' }, { url: 'https://user:credential@docs.example' }, { url: 'https://localhost/path' }, { offset: -1 }]) await expect(run({ ...input, ...change }, signal())).rejects.toBeInstanceOf(WebFetchUnavailable)
  expect(requests).toBe(0)
  await expect(run(input, signal())).rejects.toThrow('requires textual content')
  expect(extractions).toBe(0)
})

test('offset and exact continuation note identify text that was not read', async () => {
  const content = 'x'.repeat(100_020)
  let extraction = 0
  const run = createWebFetch({ request: async () => new Response(content, { headers: { 'content-type': 'text/plain' } }), step: async function* (selected) { extraction++; const request = JSON.parse(String(selected.req.transcript[0]!.content)); expect(request.offset).toBe(5); expect(request.untrustedPage.length).toBe(100_000); expect(request.totalCharacters).toBe(content.length); yield* complete() } })
  const answer = await run({ ...input, offset: 5 }, signal())
  expect(answer.result).toContain('characters 5 to 100005 of 100020'); expect(answer.result).toContain('offset: 100005')
  const beyond = await run({ ...input, offset: 200_000 }, signal())
  expect(beyond.result).toContain('Nothing left to read'); expect(extraction).toBe(1)
})

test('declared and chunked oversized bodies are refused and their streams closed', async () => {
  for (const declared of [true, false]) {
    let cancelled = false, inference = 0
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(10 * 1024 * 1024 + 1)) }, cancel() { cancelled = true } })
    const run = createWebFetch({ request: async () => new Response(stream, { headers: declared ? { 'content-length': String(11 * 1024 * 1024) } : {} }), step: async function* () { inference++; yield* complete() } })
    await expect(run(input, signal())).rejects.toThrow('10 MiB limit')
    expect(cancelled).toBe(true); expect(inference).toBe(0)
  }
})

test('partial or truncated provider output is discarded without another provider call', async () => {
  for (const failure of ['quota', 'max_tokens', 'missing_stop']) {
    let calls = 0
    const run = createWebFetch({ request: page, step: async function* (selected) {
      calls++; expect(selected.req.target).toBe(wire.req.target)
      yield { type: 'text', text: 'Unverified partial answer' }
      if (failure === 'quota') yield { type: 'error', kind: 'request', text: 'quota exhausted' }
      if (failure === 'max_tokens') yield { type: 'stop', reason: 'max_tokens' }
    } })
    await expect(run(input, signal())).rejects.toBeInstanceOf(WebFetchUnavailable)
    expect(calls).toBe(1)
  }
})

test('real selected-provider HTTP429 fails without a native Claude extraction request', async () => {
  const calls: string[] = []
  const server = createServer((request, response) => { calls.push(request.url ?? ''); response.writeHead(429, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Owned quota exhausted' } })) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Owned fixture has no port')
    const configText = JSON.stringify({ providers: { selected: { kind: 'responses', baseUrl: `http://127.0.0.1:${address.port}/selected/v1`, allowHttp: true, auth: 'none', models: { owned: {} } } } })
    const parsed = parseConfig(configText); expect(parsed.errors).toEqual([]); if (!parsed.config) throw new Error('Invalid owned provider fixture')
    const selected = { ...wire, configText, approved: [fingerprint(parsed.config.providers.selected!)], req: { ...wire.req, target: 'selected/owned' } }
    await expect(createWebFetch({ request: page })({ ...input, wire: selected }, signal())).rejects.toThrow('No Claude fallback was attempted')
    expect(calls).toEqual(['/selected/v1/responses'])
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})

test('abort during retrieval or extraction rejects and never starts a replacement call', async () => {
  for (const phase of ['retrieval', 'extraction']) {
    const stop = new AbortController(); let extraction = 0
    const run = createWebFetch({ request: async (asked, init) => { if (phase === 'retrieval') stop.abort(new Error('owned cancel')); return page(asked, init) }, step: async function* () { extraction++; yield { type: 'text', text: 'buffered only' }; stop.abort(new Error('owned cancel')); yield { type: 'stop', reason: 'end_turn' } } })
    await expect(run(input, stop.signal)).rejects.toThrow('owned cancel'); expect(extraction).toBe(phase === 'extraction' ? 1 : 0)
  }
})
