import { expect, test } from 'bun:test'
import { createServer } from 'node:http'
import type { StepEvent, StepWire } from '../hooks/protocol.ts'
import { fingerprint, parseConfig } from '../hooks/config.ts'
import { createDirectWebFetch, createWebFetch, fetchedText, WebFetchUnavailable } from './web-fetch.ts'

const url = 'https://www.google.com/page', prompt = 'What changed?'
const wire: StepWire = { configText: '', approved: ['owned-approval'], req: { target: 'codex/owned-child-model', who: 'child-owned', session: 'owned-session', system: 'Unrelated private prompt', transcript: [{ role: 'user', content: 'Unrelated private context' }], tools: [{ name: 'Bash', description: 'Not offered', schema: {} }] } }
const input = { wire, url, prompt }
const signal = () => new AbortController().signal
const create = (ports: NonNullable<Parameters<typeof createWebFetch>[0]> = {}) => createWebFetch({
  resolve: async () => [{ address: '93.184.216.34', family: 4 }], endpoints: () => [],
  configured: async () => { throw new Error('No configured fetch fixture.') }, ...ports,
})
const createDirect = (ports: NonNullable<Parameters<typeof createDirectWebFetch>[0]> = {}) => createDirectWebFetch({
  resolve: async () => [{ address: '93.184.216.34', family: 4 }], endpoints: () => [],
  configured: async () => { throw new Error('Direct tier must not call configured services.') }, ...ports,
})
const page = async (_url?: unknown, _init?: unknown): Promise<Response> => new Response('<h1>Changed release</h1><p>Actual evidence</p>', { headers: { 'content-type': 'text/html' } })
async function* complete(): AsyncGenerator<StepEvent> { yield { type: 'text', text: 'The release changed.' }; yield { type: 'stop', reason: 'end_turn' } }

test('retrieval sends no account headers and extraction keeps the exact selected child owner', async () => {
  const before = JSON.stringify(input)
  const run = createDirect({ request: async (asked, init) => { expect(String(asked)).toBe(url); expect(init?.redirect).toBe('manual'); expect(init?.headers).not.toHaveProperty('authorization'); expect(init?.headers).not.toHaveProperty('x-api-key'); return page(asked, init) }, step: async function* (selected) {
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
  expect(fetchedText(html, 'text/html', url)).toBe('A & B \u{1f600}\nGuide (https://www.google.com/guide?x=1&y=2)')
  expect(fetchedText('<b>literal</b>', 'text/plain', url)).toBe('<b>literal</b>')
})

test('HTTP input upgrades to HTTPS and same-origin redirects retain the approved origin', async () => {
  const seen: string[] = []
  const run = createDirect({ request: async asked => { seen.push(String(asked)); return seen.length === 1 ? new Response(null, { status: 302, headers: { location: '/new-page' } }) : new Response('Approved content', { headers: { 'content-type': 'text/plain' } }) }, step: complete })
  const answer = await run({ ...input, url: 'http://www.google.com/page' }, signal())
  expect(seen).toEqual(['https://www.google.com/page', 'https://www.google.com/new-page']); expect(answer.url).toBe('https://www.google.com/new-page')
})

test('public cross-origin redirects are rechecked and HTTP failures advance to native fallback', async () => {
  const seen: string[] = []
  const run = createDirect({ request: async asked => {
    seen.push(String(asked))
    return seen.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://www.wikipedia.org/page' } }) : new Response('Public content', { headers: { 'content-type': 'text/plain' } })
  }, step: complete })
  const answer = await run(input, signal())
  expect(seen).toEqual([url, 'https://www.wikipedia.org/page'])
  expect(answer).toMatchObject({ url: 'https://www.wikipedia.org/page', result: 'The release changed.' })
  const failed = await create({ request: async () => new Response('not read', { status: 429 }), step: async function* () { throw new Error('Extraction must not run') } })(input, signal())
  expect(failed).toMatchObject({ kind: 'native-fallback', url, prompt })
})

test('invalid URLs, credentials, offsets and nontext content fail explicitly before provider inference', async () => {
  let requests = 0, extractions = 0
  const run = createDirect({ request: async () => { requests++; return new Response(new Uint8Array([0, 1]), { headers: { 'content-type': 'application/pdf' } }) }, step: async function* () { extractions++; yield* complete() } })
  for (const change of [{ url: 'file:///tmp/private' }, { url: 'https://user:credential@www.google.com' }, { url: 'https://localhost/path' }, { offset: -1 }]) await expect(run({ ...input, ...change }, signal())).rejects.toBeInstanceOf(WebFetchUnavailable)
  expect(requests).toBe(0)
  await expect(run(input, signal())).rejects.toMatchObject({ phase: 'content', terminal: true })
  expect(requests).toBe(1); expect(extractions).toBe(0)
})

test('offset and exact continuation note identify text that was not read', async () => {
  const content = 'x'.repeat(100_020)
  let extraction = 0
  const run = createDirect({ request: async () => new Response(content, { headers: { 'content-type': 'text/plain' } }), step: async function* (selected) { extraction++; const request = JSON.parse(String(selected.req.transcript[0]!.content)); expect(request.offset).toBe(5); expect(request.untrustedPage.length).toBe(100_000); expect(request.totalCharacters).toBe(content.length); yield* complete() } })
  const answer = await run({ ...input, offset: 5 }, signal())
  expect(answer.result).toContain('characters 5 to 100005 of 100020'); expect(answer.result).toContain('offset: 100005')
  const beyond = await run({ ...input, offset: 200_000 }, signal())
  expect(beyond.result).toContain('Nothing left to read'); expect(extraction).toBe(1)
})

test('declared and chunked oversized bodies are refused and their streams closed', async () => {
  for (const declared of [true, false]) {
    let cancelled = false, inference = 0
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(10 * 1024 * 1024 + 1)) }, cancel() { cancelled = true } })
    const run = createDirect({ request: async () => new Response(stream, { headers: declared ? { 'content-length': String(11 * 1024 * 1024) } : {} }), step: async function* () { inference++; yield* complete() } })
    await expect(run(input, signal())).rejects.toMatchObject({ phase: 'retrieval' })
    expect(cancelled).toBe(true); expect(inference).toBe(0)
  }
})

test('partial or truncated provider output is discarded without another provider call', async () => {
  for (const failure of ['quota', 'max_tokens', 'missing_stop']) {
    let calls = 0
    const run = createDirect({ request: page, step: async function* (selected) {
      calls++; expect(selected.req.target).toBe(wire.req.target)
      yield { type: 'text', text: 'Unverified partial answer' }
      if (failure === 'quota') yield { type: 'error', kind: 'request', text: 'quota exhausted' }
      if (failure === 'max_tokens') yield { type: 'stop', reason: 'max_tokens' }
    } })
    await expect(run(input, signal())).rejects.toMatchObject({ phase: 'extraction' })
    expect(calls).toBe(1)
  }
})

test('unsupported native provider fetch does not invoke direct extraction before Claude WebFetch', async () => {
  const calls: string[] = []
  const server = createServer((request, response) => { calls.push(request.url ?? ''); response.writeHead(429, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Owned quota exhausted' } })) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Owned fixture has no port')
    const configText = JSON.stringify({ providers: { selected: { kind: 'responses', baseUrl: `http://127.0.0.1:${address.port}/selected/v1`, allowHttp: true, auth: 'none', models: { owned: {} } } } })
    const parsed = parseConfig(configText); expect(parsed.errors).toEqual([]); if (!parsed.config) throw new Error('Invalid owned provider fixture')
    const selected = { ...wire, configText, approved: [fingerprint(parsed.config.providers.selected!)], req: { ...wire.req, target: 'selected/owned' } }
    const outcome = await create({ request: page })({ ...input, wire: selected }, signal())
    expect(outcome).toMatchObject({ kind: 'native-fallback', url, prompt })
    expect(calls).toEqual([])
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})

test('abort during retrieval or extraction rejects and never starts a replacement call', async () => {
  for (const phase of ['retrieval', 'extraction']) {
    const stop = new AbortController(); let extraction = 0
    const run = createDirect({ request: async (asked, init) => { if (phase === 'retrieval') stop.abort(new Error('owned cancel')); return page(asked, init) }, step: async function* () { extraction++; yield { type: 'text', text: 'buffered only' }; stop.abort(new Error('owned cancel')); yield { type: 'stop', reason: 'end_turn' } } })
    await expect(run(input, stop.signal)).rejects.toThrow('owned cancel'); expect(extraction).toBe(phase === 'extraction' ? 1 : 0)
  }
})

test('private IPv4, alternate numeric IPv4, IPv6 and mapped IPv4 are refused before request', async () => {
  const hosts = ['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.0.0.1', '192.0.2.1', '192.168.0.1', '198.18.0.1', '224.0.0.1', '240.0.0.1', '255.255.255.255', '2130706433', '0177.0.0.1', '0x7f000001', '0x7f.0.0.1', '[::]', '[::1]', '[fe80::1]', '[fc00::1]', '[ff02::1]', '[2001::1]', '[3fff::1]', '[::ffff:8.8.8.8]', '[::ffff:127.0.0.1]', '[::ffff:10.0.0.1]']
  let requests = 0
  const run = create({ request: async () => { requests++; return page() } })
  for (const host of hosts) await expect(run({ ...input, url: `https://${host}/` }, signal())).rejects.toMatchObject({ phase: 'security', terminal: true })
  await expect(run({ ...input, url: 'https://node.internal/' }, signal())).rejects.toMatchObject({ phase: 'security', terminal: true })
  expect(requests).toBe(0)
})

test('private DNS and private redirect targets fail closed before connecting to them', async () => {
  let requests = 0
  const privateName = create({ resolve: async () => [{ address: '192.168.1.8', family: 4 }], request: async () => { requests++; return page() } })
  await expect(privateName(input, signal())).rejects.toMatchObject({ phase: 'security', terminal: true })
  let resolutions = 0
  const redirect = createDirect({ resolve: async () => [{ address: ++resolutions === 1 ? '93.184.216.34' : '10.0.0.8', family: 4 }], request: async () => { requests++; return new Response(null, { status: 302, headers: { location: 'https://www.wikipedia.org/private' } }) } })
  await expect(redirect(input, signal())).rejects.toMatchObject({ phase: 'security', terminal: true })
  expect(requests).toBe(1)
})

test('public DNS is resolved once and the checked address is passed to the connector', async () => {
  let resolutions = 0, checked: unknown
  const run = createDirect({ resolve: async () => { resolutions++; return [{ address: '93.184.216.34', family: 4 }] }, request: async (_asked, _init, destination) => { checked = destination; return new Response('Public evidence', { headers: { 'content-type': 'text/plain' } }) }, step: complete })
  await expect(run(input, signal())).resolves.toMatchObject({ result: 'The release changed.' })
  expect(resolutions).toBe(1); expect(checked).toEqual({ address: '93.184.216.34', family: 4 })
})

test('a provider-native success is terminal and failure advances to configured fetch', async () => {
  const configText = JSON.stringify({ providers: { selected: { kind: 'anthropic', baseUrl: 'https://api.anthropic.com', auth: 'none', models: { owned: {} } } } })
  const parsed = parseConfig(configText); expect(parsed.errors).toEqual([]); if (!parsed.config) throw new Error('Invalid native fetch fixture')
  const selected: StepWire = { ...wire, configText, approved: [fingerprint(parsed.config.providers.selected!)], req: { ...wire.req, target: 'selected/owned' } }
  let configured = 0, direct = 0
  const run = create({ request: async () => { direct++; return page() }, configured: async () => { configured++; throw new Error('Configured stage must not run') }, step: async function* (request) {
    expect(request.req.native?.webFetch).toMatchObject({ url, maxUses: 1 })
    yield { type: 'native_block', block: { type: 'web_fetch_tool_result', content: { type: 'web_fetch_result', url, content: { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'Hosted page text.' } } } } }
    yield { type: 'text', text: 'Hosted answer' }; yield { type: 'stop', reason: 'end_turn' }
  } })
  await expect(run({ ...input, wire: selected }, signal())).resolves.toMatchObject({ result: 'Hosted answer', url })
  expect(configured).toBe(0); expect(direct).toBe(0)

  let extractCalls = 0
  const fallback = create({ request: async () => { direct++; return page() }, configured: async asked => { configured++; return { url: asked, content: '', contentType: 'text/plain', status: 200 } }, step: async function* (request) {
    if (request.req.native?.webFetch) throw new Error('Hosted fetch unsupported')
    extractCalls++; yield* complete()
  } })
  await expect(fallback({ ...input, wire: selected }, signal())).resolves.toMatchObject({ result: '', url })
  expect(configured).toBe(1); expect(direct).toBe(0); expect(extractCalls).toBe(0)
})

test('Gemini URL Context is provider-native only on the official hosted GenerateContent endpoint', async () => {
  const configText = JSON.stringify({ providers: { selected: { kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', auth: 'none', models: { owned: {} } } } })
  const parsed = parseConfig(configText); expect(parsed.errors).toEqual([]); if (!parsed.config) throw new Error('Invalid Gemini URL Context fixture')
  const selected: StepWire = { ...wire, configText, req: { ...wire.req, target: 'selected/owned' } }
  const run = create({ step: async function* (request) {
    expect(request.req.native?.webFetch).toMatchObject({ url, maxUses: 1 })
    yield { type: 'native_block', block: { type: 'gemini_url_context_result', url_metadata: [{ retrieved_url: url, url_retrieval_status: 'URL_RETRIEVAL_STATUS_SUCCESS' }] } }
    yield { type: 'text', text: 'Gemini hosted answer.' }; yield { type: 'stop', reason: 'end_turn' }
  } })
  await expect(run({ ...input, wire: selected }, signal())).resolves.toMatchObject({ result: 'Gemini hosted answer.', url, bytes: 0 })
  const unsafe = create({ step: async function* () {
    yield { type: 'native_block', block: { type: 'gemini_url_context_result', url_metadata: [{ retrieved_url: 'https://127.0.0.1/private', url_retrieval_status: 'URL_RETRIEVAL_STATUS_SUCCESS' }] } }
    yield { type: 'text', text: 'Untrusted result.' }; yield { type: 'stop', reason: 'end_turn' }
  } })
  await expect(unsafe({ ...input, wire: selected }, signal())).rejects.toMatchObject({ phase: 'security', terminal: true })
  const mismatched = create({ configured: async () => { throw new Error('No configured fixture') }, step: async function* () {
    yield { type: 'native_block', block: { type: 'gemini_url_context_result', url_metadata: [{ retrieved_url: 'https://www.wikipedia.org/other-page', url_retrieval_status: 'URL_RETRIEVAL_STATUS_SUCCESS' }] } }
    yield { type: 'text', text: 'Answer from a different URL.' }; yield { type: 'stop', reason: 'end_turn' }
  } })
  await expect(mismatched({ ...input, wire: selected }, signal())).resolves.toMatchObject({ kind: 'native-fallback', url })
})

test('provider-native partial output is terminal and does not switch to another tier', async () => {
  const configText = JSON.stringify({ providers: { selected: { kind: 'anthropic', baseUrl: 'https://api.anthropic.com', auth: 'none', models: { owned: {} } } } })
  const parsed = parseConfig(configText); expect(parsed.config).toBeDefined(); if (!parsed.config) throw new Error('Invalid hosted fetch fixture')
  const selected: StepWire = { ...wire, configText, approved: [fingerprint(parsed.config.providers.selected!)], req: { ...wire.req, target: 'selected/owned' } }
  let configured = 0
  const run = create({ configured: async () => { configured++; throw new Error('Must not switch tiers after output begins') }, step: async function* () {
    yield { type: 'text', text: 'Partial provider response' }
    yield { type: 'error', kind: 'request', text: 'Provider failed' }
  } })
  await expect(run({ ...input, wire: selected }, signal())).rejects.toMatchObject({ phase: 'extraction', terminal: true })
  expect(configured).toBe(0)
})

test('configured-service extraction failure after partial output is terminal', async () => {
  let calls = 0
  const run = create({ configured: async asked => ({ url: asked, content: 'Published page evidence', contentType: 'text/plain', status: 200 }), step: async function* () {
    calls++
    yield { type: 'text', text: 'Partial extraction' }
    yield { type: 'error', kind: 'request', text: 'Provider failed after output' }
  } })
  await expect(run(input, signal())).rejects.toMatchObject({ phase: 'extraction', terminal: true })
  expect(calls).toBe(1)
})

test('engine WebFetch follows configured services and direct selected extraction is the final fallback', async () => {
  let direct = 0, extracted = 0
  const serviceFailure = create({ configured: async () => { throw new Error('service offline') }, request: async () => { direct++; return new Response('unexpected direct request') } })
  await expect(serviceFailure(input, signal())).resolves.toMatchObject({ kind: 'native-fallback', url, prompt })
  expect(direct).toBe(0)

  const finalDirect = createDirect({ request: async () => { direct++; return new Response('Direct evidence', { headers: { 'content-type': 'text/plain' } }) }, step: async function* () { extracted++; yield* complete() } })
  await expect(finalDirect(input, signal())).resolves.toMatchObject({ result: 'The release changed.' })
  expect(direct).toBe(1); expect(extracted).toBe(1)
})
