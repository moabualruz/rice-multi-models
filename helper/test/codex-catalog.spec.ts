import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverCodex } from '../codex-catalog.ts'
import { unknownMetadata } from '../../hooks/catalogue.ts'

let dir: string
let cli: string
let auth: string
let env: NodeJS.ProcessEnv
let server: ReturnType<typeof Bun.serve>
let requests: URL[] = []
let response: () => Response
const fixtureSecret = 'catalogue-fixture-secret-do-not-echo'
const model = (fields: Record<string, unknown> = {}) => ({ slug: 'fixture-model', display_name: 'Fixture', visibility: 'list', context_window: 100000, max_context_window: 200000, effective_context_window_percent: 95, input_modalities: ['text', 'image'], supported_reasoning_levels: [{ effort: 'low', description: 'Low' }, { effort: 'high', description: 'High' }], ...fields })
const json = (models: unknown[]) => new Response(JSON.stringify({ models }), { headers: { 'content-type': 'application/json' } })
const discover = (options: Parameters<typeof discoverCodex>[0] = {}) => discoverCodex({ env, url: `http://127.0.0.1:${server.port}/models`, ...options })
const unavailable = (result: Awaited<ReturnType<typeof discover>>, error: string) => {
  expect(result.models).toEqual([])
  expect(result.providers).toEqual([{ provider: 'codex', status: 'unavailable', source: 'Codex authenticated models endpoint', error }])
  expect(JSON.stringify(result)).not.toContain(fixtureSecret)
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mm-codex-catalogue-'))
  auth = join(dir, '.codex', 'auth.json')
  cli = join(dir, '.claude', 'rice-multi-models', 'cli', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  mkdirSync(join(dir, '.codex'), { recursive: true })
  mkdirSync(join(cli, '..'), { recursive: true })
  env = { ...process.env, HOME: dir, USERPROFILE: dir, CODEX_HOME: join(dir, '.codex'), CLAUDE_CONFIG_DIR: join(dir, '.claude'), PATH: '' }
  server = Bun.serve({ port: 0, fetch(request) {
    requests.push(new URL(request.url))
    expect(request.method).toBe('GET')
    expect(request.headers.get('authorization')).toBe(`Bearer ${fixtureSecret}`)
    expect(request.headers.get('chatgpt-account-id')).toBe('fixture-account')
    return response()
  } })
})

beforeEach(() => {
  requests = []
  response = () => json([model()])
  writeFileSync(cli, 'if (process.argv[2] !== "--version") process.exit(9); process.stdout.write("codex-cli 0.162.1\\n")')
  // No refresh token: the tests cannot start an auth-renewal process or touch real auth.
  writeFileSync(auth, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: fixtureSecret, account_id: 'fixture-account' } }))
})

afterAll(() => { server.stop(true); rmSync(dir, { recursive: true, force: true }) })

test('every call fetches fresh lists and limits despite an existing stale native cache', async () => {
  writeFileSync(join(dir, '.codex', 'models_cache.json'), JSON.stringify({ fetched_at: '2000-01-01T00:00:00Z', models: [model({ slug: 'stale-only', context_window: 999 })] }))
  const first = await discover()
  response = () => json([model({ slug: 'new-only', context_window: 250000, max_context_window: 500000 })])
  const second = await discover()
  expect(requests).toHaveLength(2)
  expect(requests.every(url => url.searchParams.get('client_version') === '0.162.1')).toBe(true)
  expect(first.models.map(m => m.model)).toEqual(['codex/fixture-model'])
  expect(second.models.map(m => m.model)).toEqual(['codex/new-only'])
  expect(first.models[0]!.metadata.contextWindow).toBe(100000)
  expect(second.models[0]!.metadata).toMatchObject({ contextWindow: 250000, maxContextWindow: 500000, inputTokenLimit: 237500, outputTokenLimit: null, tools: null, parallelToolCalls: null })
  expect(second.providers[0]).toMatchObject({ provider: 'codex', status: 'fresh', observedAt: second.models[0]!.observedAt })
})

test('maps reported limits and capabilities only; hidden and non-picker models stay out', async () => {
  response = () => json([model({ auto_compact_token_limit: 75000, truncation_policy: { mode: 'tokens', limit: 4000 }, max_output_tokens: 8192, experimental_supported_tools: ['shell'], supports_parallel_tool_calls: true }), model({ slug: 'hidden', visibility: 'hide' }), model({ slug: 'non-picker', visibility: 'none' })])
  const result = await discover()
  expect(result.models).toHaveLength(1)
  expect(result.models[0]!.metadata).toEqual({ contextWindow: 100000, maxContextWindow: 200000, inputTokenLimit: 95000, outputTokenLimit: null, autoCompactTokenLimit: 75000, inputModalities: ['text', 'image'], reasoningEfforts: ['low', 'high'], tools: null, parallelToolCalls: null })
  expect(JSON.stringify(result)).not.toContain(fixtureSecret)
})

test('unreported metadata remains unknown and maximum context is not a default', async () => {
  response = () => json([{ slug: 'minimal', visibility: 'list', max_context_window: 872000, effective_context_window_percent: 95 }])
  const result = await discover()
  expect(result.models[0]!.metadata).toEqual({ ...unknownMetadata(), maxContextWindow: 872000 })
})

test('malformed optional metadata cannot become a numeric or capability guess', async () => {
  response = () => json([model({ context_window: -1, max_context_window: '872000', effective_context_window_percent: 101, auto_compact_token_limit: 1.5, input_modalities: ['text', {}], supported_reasoning_levels: [{ effort: 123, description: fixtureSecret }] })])
  const result = await discover()
  expect(result.models[0]!.metadata).toEqual(unknownMetadata())
  expect(JSON.stringify(result)).not.toContain(fixtureSecret)
  response = () => json([model({ effective_context_window_percent: undefined })])
  expect((await discover()).models[0]!.metadata.inputTokenLimit).toBeNull()
})

test('empty catalogue is fresh; malformed catalogue is unavailable, never a fallback', async () => {
  response = () => json([])
  expect((await discover()).providers[0]!.status).toBe('fresh')
  for (const payload of ['not json ' + fixtureSecret, JSON.stringify({ models: {} }), JSON.stringify({ models: [null] }), JSON.stringify({ models: [{ slug: 'model-without-visibility' }] })]) {
    response = () => new Response(payload)
    unavailable(await discover(), 'protocol-invalid')
  }
})

test('missing auth is unavailable without contacting the server', async () => {
  rmSync(auth)
  unavailable(await discover(), 'auth-unavailable')
  expect(requests).toHaveLength(0)
})

test('HTTP refusals never expose response headers or bodies, and do not retry except native auth renewal', async () => {
  for (const status of [401, 403, 429, 500]) {
    const before = requests.length
    response = () => new Response(fixtureSecret, { status, headers: { 'x-private': fixtureSecret } })
    unavailable(await discover(), `http-${status}`)
    expect(requests.length).toBe(before + 1)
  }
})

test('catalogue query uses the installed CLI version rather than a pinned discovery version', async () => {
  writeFileSync(cli, 'process.stdout.write("codex-cli 0.200.7-beta.2\\n")')
  const result = await discover()
  expect(result.providers[0]!.status).toBe('fresh')
  expect(requests[0]!.searchParams.get('client_version')).toBe('0.200.7')
})

test('oversized and duplicate metadata responses fail closed', async () => {
  response = () => new Response(' '.repeat(4 * 1024 * 1024 + 1))
  unavailable(await discover(), 'protocol-too-large')
  response = () => json([model(), model()])
  unavailable(await discover(), 'protocol-invalid')
})

test('CLI absence and malformed versions are safe unavailable reports, not invented versions', async () => {
  rmSync(cli)
  unavailable(await discover(), 'cli-unavailable')
  writeFileSync(cli, `process.stdout.write(${JSON.stringify(fixtureSecret)})`)
  unavailable(await discover(), 'cli-version-invalid')
  expect(requests).toHaveLength(0)
})

test('one total deadline bounds CLI discovery before any metadata request', async () => {
  writeFileSync(cli, 'setInterval(() => {}, 1000)')
  const start = Date.now()
  unavailable(await discover({ timeoutMs: 60 }), 'deadline-exceeded')
  expect(Date.now() - start).toBeLessThan(1000)
  expect(requests).toHaveLength(0)
})

test('deadline and cancellation bound an unfinished metadata response body', async () => {
  response = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"models":[')) } }))
  const start = Date.now()
  unavailable(await discover({ timeoutMs: 300 }), 'deadline-exceeded')
  expect(Date.now() - start).toBeLessThan(1200)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(fixtureSecret), 300)
  try { unavailable(await discover({ signal: controller.signal }), 'cancelled') } finally { clearTimeout(timer) }
  const already = new AbortController()
  already.abort(fixtureSecret)
  const before = requests.length
  unavailable(await discover({ signal: already.signal }), 'cancelled')
  expect(requests.length).toBe(before)
})
