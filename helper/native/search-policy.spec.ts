import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { NativeOwnership } from './ownership.ts'
import { nativeFetch } from './transport.ts'
import { collectSearch, nativeSearchResponse } from './search-policy.ts'
import { providerSearch } from '../search/provider.ts'
import { parseConfig } from '../../hooks/config.ts'
import { resolve } from '../../hooks/names.ts'
import type { StepEvent, StepWire } from '../../hooks/protocol.ts'

const previous = { config: process.env.CLAUDE_CONFIG_DIR, state: process.env.RICE_MULTI_MODELS_NATIVE_STATE, legacy: process.env.RICE_MULTI_MODELS_SEARCH_URL }
const fixtures: string[] = []
afterEach(() => {
  for (const [name, value] of [['CLAUDE_CONFIG_DIR', previous.config], ['RICE_MULTI_MODELS_NATIVE_STATE', previous.state], ['RICE_MULTI_MODELS_SEARCH_URL', previous.legacy]]) {
    if (value === undefined) delete process.env[name!]; else process.env[name!] = value
  }
  fixtures.splice(0).forEach(path => rmSync(path, { recursive: true, force: true }))
})

function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'rice-search-policy-')); fixtures.push(path)
  process.env.CLAUDE_CONFIG_DIR = path; delete process.env.RICE_MULTI_MODELS_NATIVE_STATE; delete process.env.RICE_MULTI_MODELS_SEARCH_URL
  const text = JSON.stringify({ providers: { owned: { kind: 'responses', baseUrl: 'https://selected.example/v1', auth: 'none', models: { main: { webSearch: 'native' } } } } })
  writeFileSync(join(path, 'rice-multi-models.json'), text)
  return { path, text }
}

function scoped(ownership: NativeOwnership, model: string) {
  const worker = {}, host = {}, plugin = {}; ownership.pair(host, plugin)
  ownership.outgoing(worker, { type: 'load', environmentId: 1, port: plugin })
  ownership.outgoing(worker, { type: 'dispatch', id: 1, event: 'turn.step', payload: { model }, environments: [1] })
  return ownership.portOwner(host, { type: 'op', opId: 1, dispatchId: 1, op: 'tool.call', args: { tool: 'WebSearch', query: 'owned original query' } })
}

const request = () => new Request('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer selected-account-b', 'x-claude-code-request-class': 'web_search_tool' }, body: JSON.stringify({ model: 'external-selected-model', messages: [{ role: 'user', content: 'Search the current docs.' }], tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }] }) })
const successfulNative = () => Response.json({ type: 'message', content: [{ type: 'web_search_tool_result', tool_use_id: 'native', content: [] }], stop_reason: 'end_turn' })

test('selected provider search precedes services and native fallback, preserving account and model ownership', async () => {
  fixture()
  const ownership = new NativeOwnership('owned/main'); let fallback = 0
  const adapted = nativeFetch((async () => { fallback++; return successfulNative() }) as typeof fetch, ownership, async function* (wire): AsyncGenerator<StepEvent> {
    expect(wire.req.target).toBe('owned/main')
    expect(wire.req.native?.webSearch).toEqual({ maxUses: 8 })
    yield { type: 'text', text: 'Provider cited answer' }
    yield { type: 'search_sources', searched: true, sources: [{ title: 'Provider source', url: 'https://docs.example/provider' }] }
    yield { type: 'stop', reason: 'end_turn' }
  })
  const response = await ownership.run(scoped(ownership, 'owned/main'), () => adapted(request()))
  expect(response.status).toBe(200)
  expect(await response.text()).toContain('https://docs.example/provider')
  expect(fallback).toBe(0)
})

test.each(['owned/main', 'claude-owned-native'])('provider quota failure uses configured retrieval without another inference and preserves a valid empty search (%s)', async model => {
  const { path } = fixture(); let calls = 0, fallback = 0
  const server = createServer((req, response) => {
    calls++
    expect(new URL(req.url!, 'http://localhost').searchParams.get('q')).toBe('owned original query')
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ results: [] }))
  }).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address() as { port: number }
  mkdirSync(join(path, 'rice-multi-models'))
  writeFileSync(join(path, 'rice-multi-models/search.json'), JSON.stringify({ version: 1, endpoints: [{ name: 'self-hosted', kind: 'searxng', url: `http://127.0.0.1:${address.port}/search`, priority: 1 }] }))
  const ownership = new NativeOwnership(model)
  let inference = 0
  const adapted = nativeFetch((async () => { fallback++; return Response.json({ type: 'error', error: { type: 'rate_limit_error' } }, { status: 429 }) }) as typeof fetch, ownership, async function* (): AsyncGenerator<StepEvent> { inference++; yield { type: 'text', text: 'Partial provider output must be discarded' }; yield { type: 'error', kind: 'response', text: 'quota' } })
  try {
    const response = await ownership.run(scoped(ownership, model), () => adapted(request()))
    const body = await response.text()
    expect(body).toContain('No web search results')
    expect(body).not.toContain('Partial provider')
    expect(calls).toBe(1); expect(fallback).toBe(model.startsWith('claude-') ? 1 : 0)
    expect(inference).toBe(model.startsWith('claude-') ? 0 : 1)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test.each([{ calls: 1, complete: true, fallback: 0 }, { calls: 9, complete: true, fallback: 1 }, { complete: false, fallback: 1 }])('Codex accepts bounded search only with complete identified terminal accounting (%j)', async accounting => {
  fixture(); const ownership = new NativeOwnership('codex/owned'); let fallback = 0
  const adapted = nativeFetch((async () => { fallback++; return successfulNative() }) as typeof fetch, ownership, async function* (): AsyncGenerator<StepEvent> {
    yield { type: 'search_sources', sources: [], searched: true, ...accounting }
    yield { type: 'stop', reason: 'end_turn' }
  }, undefined, async () => 'claude-owned-native')
  const response = await ownership.run(scoped(ownership, 'codex/owned'), () => adapted(request()))
  expect(response.status).toBe(200); await response.text()
  expect(fallback).toBe(accounting.fallback)
})

test('last fallback changes only this search request model and retains selected native account headers', async () => {
  fixture(); const ownership = new NativeOwnership('owned/main'); let calls = 0
  const adapted = nativeFetch((async input => {
    calls++; const sent = new Request(input)
    expect(sent.headers.get('authorization')).toBe('Bearer selected-account-b')
    expect((await sent.json() as { model: string }).model).toBe('claude-owned-native')
    return successfulNative()
  }) as typeof fetch, ownership, async function* (): AsyncGenerator<StepEvent> { yield { type: 'error', kind: 'response', text: 'quota' } }, undefined, async () => 'claude-owned-native')
  const response = await ownership.run(scoped(ownership, 'owned/main'), () => adapted(request()))
  expect(response.status).toBe(200); expect(calls).toBe(1)
  expect(ownership.selection().model).toBe('owned/main')
})

test('native HTTP200 tool failure is unavailable and buffered partial provider search is never accepted', async () => {
  const checked = await nativeSearchResponse(Response.json({ content: [{ type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'too_many_requests' } }] }), new AbortController().signal)
  expect(checked.ok).toBe(false)
  async function* incomplete(): AsyncGenerator<StepEvent> { yield { type: 'text', text: 'Unverified https://example.com' }; yield { type: 'stop', reason: 'end_turn' } }
  await expect(collectSearch(incomplete(), new AbortController().signal, true)).rejects.toThrow('did not complete')
})

test('local inference never implies cloud search and native restrictions are not silently dropped', () => {
  const text = JSON.stringify({ providers: { local: { kind: 'openai', baseUrl: 'http://ollama.local:11434/v1', allowHttp: true, auth: 'none', models: { main: {} } }, google: { kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', auth: 'none', models: { main: {} } } } })
  const config = parseConfig(text).config!
  const local = resolve(config, 'local/main'), google = resolve(config, 'google/main')
  expect(providerSearch('local/main', local?.kind === 'remote' ? local : undefined, {})).toBeUndefined()
  expect(providerSearch('google/main', google?.kind === 'remote' ? google : undefined, {})).toBe('hosted')
  expect(providerSearch('google/main', google?.kind === 'remote' ? google : undefined, { maxUses: 8 })).toBeUndefined()
  expect(providerSearch('codex/owned', undefined, {})).toBe('hosted')
  expect(providerSearch('codex/owned', undefined, { maxUses: 8 })).toBe('hosted')
})
