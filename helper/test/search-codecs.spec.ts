// Provider-documented schemas, with synthetic IDs/URLs and no account data.
// https://developers.openai.com/api/docs/guides/tools-web-search
// https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
// https://ai.google.dev/gemini-api/docs/google-search
import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseConfig } from '../../hooks/config.ts'
import type { SearchSource, StepEvent, StepRequest } from '../../hooks/protocol.ts'
import { codexStep, messagesBody, responsesRequest } from '../codex.ts'
import { fromResponses } from '../core/responses.ts'
import { responsesSearchAccounting, responsesSearchEvidence } from '../core/search.ts'
import { nativeConstraints } from '../native/constraints.ts'
import { responses } from '../styx/codecs/responses.ts'
import { anthropic } from '../styx/codecs/anthropic.ts'
import { gemini } from '../styx/codecs/gemini.ts'
import type { Codec, Decoded } from '../styx/codec.ts'

const tool = { name: 'Read', description: 'Read', schema: { type: 'object' } }
const step: StepRequest = { target: 'codex/test-model', system: 'Search for the supplied query.', tools: [tool], transcript: [{ role: 'user', content: 'search fixture query' }], who: 'main', session: 'fixture', native: { webSearch: {} } }
const source = { title: 'Search result', url: 'https://source.example/article' }
const call = { id: 'ws_fixture', type: 'web_search_call', status: 'completed', action: { type: 'search', queries: ['fixture query'], sources: [{ type: 'url', url: source.url }] } }
const message = { id: 'msg_fixture', type: 'message', content: [{ type: 'output_text', text: 'Documented answer.', annotations: [{ type: 'url_citation', ...source, start_index: 0, end_index: 10 }] }] }
const sse = (...events: unknown[]): Uint8Array => new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
async function* stream(...events: unknown[]) { yield sse(...events) }
function decode(codec: Codec, ...events: unknown[]): Decoded[] {
  const decoder = codec.decoder(), bytes = sse(...events)
  // Exercise the actual byte framing across an arbitrary split.
  return [...decoder.feed(bytes.slice(0, 23)), ...decoder.feed(bytes.slice(23)), ...decoder.end()]
}
function model(kind: 'responses' | 'anthropic' | 'gemini' | 'openai' | 'bedrock') {
  const parsed = parseConfig(JSON.stringify({ providers: { fixture: { kind, baseUrl: 'https://provider.example', auth: kind === 'bedrock' ? { command: ['/fixture/auth'] } : 'none', models: { test: { maxOutputTokens: 2048 } } } } }))
  if (!parsed.config) throw new Error(parsed.errors.join('; '))
  return parsed.config.providers.fixture.models.test
}

test('dedicated search constraints replace function tools and honor only proven provider restrictions', () => {
  const normal = JSON.stringify({ tools: [{ type: 'function', name: 'Read' }], parallel_tool_calls: true, toolConfig: {}, thinking: { type: 'enabled' }, text: { format: {} } })
  const search = { allowedDomains: ['source.example'], location: { city: 'London' }, mode: 'extended' as const }
  const publicResponse = JSON.parse(nativeConstraints(normal, model('responses'), { webSearch: search }))
  expect(publicResponse.tools).toEqual([{ type: 'web_search', external_web_access: true, filters: { allowed_domains: ['source.example'] }, user_location: { city: 'London', type: 'approximate' }, search_context_size: 'high' }])
  expect(publicResponse.tool_choice).toEqual({ type: 'web_search' })
  expect(publicResponse.include).toContain('web_search_call.action.sources')
  expect(publicResponse.max_tool_calls).toBeUndefined()
  expect(publicResponse.parallel_tool_calls).toBeUndefined()
  expect(publicResponse.text).toBeUndefined()
  const claude = JSON.parse(nativeConstraints(normal, model('anthropic'), { webSearch: search }))
  expect(claude.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search', allowed_domains: ['source.example'], user_location: { city: 'London', type: 'approximate' } }])
  expect(claude.thinking).toBeUndefined()
  expect(JSON.parse(nativeConstraints(normal, model('gemini'), { webSearch: {} })).tools).toEqual([{ googleSearch: {} }])
  expect(JSON.parse(nativeConstraints(normal, model('gemini'), { webSearch: search })).tools).toEqual([{ googleSearch: {} }])
  for (const kind of ['openai', 'bedrock'] as const) expect(() => nativeConstraints(normal, model(kind), { webSearch: {} })).toThrow('no supported hosted search')
  expect(nativeConstraints(normal, model('responses'), undefined)).toBe(normal)
})

test('Codex search uses its subscription serializer and sends only the fields it has', () => {
  const request = responsesRequest(step, 'test-model', messagesBody(step, 'test-model'))
  expect(request.tools).toEqual([{ type: 'web_search', external_web_access: true }])
  expect(request.tool_choice).toBe('auto')
  expect(request.include).toEqual(['reasoning.encrypted_content'])
  expect(request.max_tool_calls).toBeUndefined()
  const mapped = { ...step, native: { webSearch: { blockedDomains: ['blocked.example'], mode: 'extended' as const } } }
  expect(responsesRequest(mapped, 'test-model', messagesBody(mapped, 'test-model')).tools).toEqual([{ type: 'web_search', external_web_access: true }])
  const ordinary = { ...step, native: undefined }
  expect(responsesRequest(ordinary, 'test-model', messagesBody(ordinary, 'test-model')).tools[0]).toHaveProperty('name', 'Read')
})

test('Responses translator accepts server search items, terminal source enrichment and real citations', async () => {
  const evidence: { sources: SearchSource[]; searched: boolean }[] = []
  const incrementalCall = { ...call, action: { type: 'search', queries: ['fixture query'] } }
  const incrementalMessage = { ...message, content: [{ type: 'output_text', text: 'Documented answer.' }] }
  const response = await fromResponses(stream(
    { type: 'response.created', response: { id: 'resp_fixture' } },
    { type: 'response.output_item.done', output_index: 0, item: incrementalCall },
    { type: 'response.output_item.done', output_index: 1, item: incrementalMessage },
    { type: 'response.output_text.annotation.added', output_index: 1, annotation: message.content[0].annotations[0] },
    { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [call, message], usage: { input_tokens: 20, output_tokens: 4 } } },
  ), 'test-model', () => {}, { onSearchSources: result => evidence.push(result) })
  expect(response.content).toEqual([{ type: 'text', text: 'Documented answer.' }])
  expect(evidence).toEqual([{ sources: [source], searched: true, calls: 1, complete: true }])
})

test('Responses in-band search failure produces no successful evidence and valid empty search remains a search', async () => {
  const evidence: unknown[] = []
  await expect(fromResponses(stream(
    { type: 'response.created', response: { id: 'resp_fixture' } },
    { type: 'response.completed', response: { id: 'resp_fixture', output: [{ ...call, status: 'failed' }] } },
  ), 'test-model', () => {}, { onSearchSources: result => evidence.push(result) })).rejects.toThrow('web search')
  expect(evidence).toEqual([])
  await fromResponses(stream(
    { type: 'response.created', response: { id: 'resp_empty' } },
    { type: 'response.completed', response: { id: 'resp_empty', output: [{ ...call, action: { type: 'search', sources: [] } }] } },
  ), 'test-model', () => {}, { onSearchSources: result => evidence.push(result) })
  expect(evidence).toEqual([{ sources: [], searched: true, calls: 1, complete: true }])
})

test('Responses codec reads authoritative search metadata rather than URLs from generated prose', () => {
  const decoded = decode(responses,
    { type: 'response.output_item.done', output_index: 0, item: call },
    { type: 'response.output_item.done', output_index: 1, item: message },
    { type: 'response.completed', response: { status: 'completed', output: [call, message], usage: { input_tokens: 1, output_tokens: 1 } } },
  )
  expect(decoded.find(event => event.t === 'search_sources')).toEqual({ t: 'search_sources', sources: [source], searched: true })
  expect(responsesSearchEvidence([{ type: 'message', content: [{ type: 'output_text', text: source.url }] }])).toEqual({ sources: [], searched: false })
  expect(responsesSearchEvidence([message])).toEqual({ sources: [], searched: false })
  expect(decode(responses, { type: 'response.output_item.done', output_index: 0, item: { ...call, status: 'failed' } }).some(event => event.t === 'error')).toBe(true)
})

test('Anthropic codec preserves server-result and citation evidence, including200 tool errors', () => {
  const start = { type: 'content_block_start', index: 0, content_block: { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_fixture', content: [{ type: 'web_search_result', ...source, encrypted_content: 'opaque-native-fixture' }] } }
  const end = { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }
  const result = decode(anthropic, start, { type: 'content_block_stop', index: 0 }, { type: 'content_block_delta', index: 1, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', ...source, cited_text: 'Actual cited text.' } } }, end)
  expect(result.find(event => event.t === 'search_sources')).toEqual({ t: 'search_sources', sources: [{ ...source, content: 'Actual cited text.' }], searched: true })
  const failed = decode(anthropic, { ...start, content_block: { ...start.content_block, content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } } }, end)
  expect(failed.some(event => event.t === 'error')).toBe(true)
  expect(failed.some(event => event.t === 'search_sources' || event.t === 'finish')).toBe(false)
  expect(decode(anthropic, { ...start, content_block: { ...start.content_block, content: [] } }, { type: 'content_block_stop', index: 0 }, end).find(event => event.t === 'search_sources')).toEqual({ t: 'search_sources', sources: [], searched: true })
})

test('Gemini codec uses grounding chunks and support indices; normal text carries no searched evidence', () => {
  const chunk = { candidates: [{ content: { parts: [{ text: 'Grounded answer.' }] }, groundingMetadata: { webSearchQueries: ['fixture query'], groundingChunks: [{ web: { title: source.title, uri: source.url } }], groundingSupports: [{ segment: { text: 'Grounded answer.' }, groundingChunkIndices: [0] }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }
  expect(decode(gemini, chunk).find(event => event.t === 'search_sources')).toEqual({ t: 'search_sources', sources: [{ ...source, content: 'Grounded answer.' }], searched: true })
  expect(decode(gemini, { candidates: [{ content: { parts: [{ text: source.url }] }, finishReason: 'STOP' }] }).some(event => event.t === 'search_sources')).toBe(false)
  expect(decode(gemini, { error: { code: 403, message: 'Search unavailable' } }).some(event => event.t === 'search_sources')).toBe(false)
})

test('Codex transport publishes search evidence through the selected subscription auth and same request endpoint', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rice-codex-search-'))
  const authFile = path.join(directory, 'auth.json')
  const fakeAccess = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"exp":4102444800}').toString('base64url')}.fixture`
  await writeFile(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: fakeAccess, account_id: 'acct_search_fixture', refresh_token: 'fixture' } }))
  let requests = 0
  const server = Bun.serve({ port: 0, async fetch(request) {
    requests++
    expect(new URL(request.url).pathname).toBe('/owned-subscription-responses')
    expect(request.headers.get('chatgpt-account-id')).toBe('acct_search_fixture')
    expect(request.headers.get('authorization') === `Bearer ${fakeAccess}`).toBe(true)
    expect((await request.json()).tools).toEqual([{ type: 'web_search', external_web_access: true }])
    return new Response(sse(
      { type: 'response.created', response: { id: 'resp_fixture' } },
      { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [call, message], usage: { input_tokens: 20, output_tokens: 4 } } },
    ), { headers: { 'content-type': 'text/event-stream' } })
  } })
  try {
    const events: StepEvent[] = []
    for await (const event of codexStep({ ...step, transport: 'sse' }, 'test-model', new AbortController().signal, { authFile, httpUrl: `http://127.0.0.1:${server.port}/owned-subscription-responses` })) events.push(event)
    expect(requests).toBe(1)
    expect(events.find(event => event.type === 'search_sources')).toEqual({ type: 'search_sources', sources: [source], searched: true, calls: 1, complete: true })
    expect(events.some(event => event.type === 'tool_use' || event.type === 'error')).toBe(false)
    expect(events.find(event => event.type === 'stop')).toEqual({ type: 'stop', reason: 'end_turn' })
  } finally { server.stop(true); await rm(directory, { recursive: true, force: true }) }
})

test('reported search-call accounting deduplicates stream/terminal IDs and never counts annotations', () => {
  expect(responsesSearchAccounting([call, message], [call, call, message])).toEqual({ calls: 1, complete: true })
  const calls = Array.from({ length: 9 }, (_, index) => ({ ...call, id: `ws_${index}` }))
  expect(responsesSearchAccounting(calls, calls)).toEqual({ calls: 9, complete: true })
  expect(responsesSearchAccounting([message], [message])).toEqual({ calls: 0, complete: true })
  for (const terminal of [undefined, [], [{ ...call, id: undefined }], [{ ...call, id: '' }], [call, call], [{ ...call, status: 'in_progress' }]]) {
    expect(responsesSearchAccounting(terminal, [call])).toEqual({ complete: false })
  }
})

test('successful terminal omission uses fully finished stream accounting; ambiguous IDs stay unknown', async () => {
  const evidence: unknown[] = []
  await fromResponses(stream(
    { type: 'response.created', response: { id: 'resp_fixture' } },
    { type: 'response.output_item.done', output_index: 0, item: call },
    { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed' } },
  ), 'test-model', () => {}, { onSearchSources: result => evidence.push(result) })
  expect(evidence).toEqual([{ sources: [{ title: 'source.example', url: source.url }], searched: true, calls: 1, complete: true }])
  const ambiguous: unknown[] = []
  await fromResponses(stream(
    { type: 'response.created', response: { id: 'resp_fixture' } },
    { type: 'response.completed', response: { id: 'resp_fixture', output: [{ ...call, id: undefined }] } },
  ), 'test-model', () => {}, { onSearchSources: result => ambiguous.push(result) })
  expect(ambiguous).toEqual([{ sources: [{ title: 'source.example', url: source.url }], searched: true, complete: false }])
})

test('actual Codex empty terminal output accounts two completed hosted invocations and never counts citations', async () => {
  const open = { ...call, id: 'ws_open_fixture', action: { type: 'open_page', url: source.url } }
  const evidence: unknown[] = []
  await fromResponses(stream(
    { type: 'response.created', response: { id: 'resp_fixture' } },
    { type: 'response.output_item.added', output_index: 0, item: { id: call.id, type: 'web_search_call', status: 'in_progress' } },
    { type: 'response.web_search_call.completed', output_index: 0, item_id: call.id },
    { type: 'response.output_item.done', output_index: 0, item: call },
    { type: 'response.output_item.added', output_index: 1, item: { id: open.id, type: 'web_search_call', status: 'in_progress' } },
    { type: 'response.web_search_call.completed', output_index: 1, item_id: open.id },
    { type: 'response.output_item.done', output_index: 1, item: open },
    { type: 'response.output_item.done', output_index: 2, item: message },
    { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [] } },
  ), 'test-model', () => {}, { onSearchSources: result => evidence.push(result) })
  expect(evidence).toEqual([{ sources: [source], searched: true, calls: 2, complete: true }])
})

test('unfinished, gapped, duplicated or uncorrelated stream accounting remains unknown; cut streams never emit success', async () => {
  const slots = [{ index: 0, done: true }]
  for (const context of [
    { successful: false, slots },
    { successful: true, slots: [{ index: 0, done: false }] },
    { successful: true, slots: [{ index: 1, done: true }] },
    { successful: true, slots, completedIds: ['wrong-id'] },
  ]) expect(responsesSearchAccounting([], [call], context)).toEqual({ complete: false })
  expect(responsesSearchAccounting([], [call, call], { successful: true, slots: [{ index: 0, done: true }, { index: 1, done: true }] })).toEqual({ complete: false })
  const evidence: unknown[] = []
  await expect(fromResponses(stream(
    { type: 'response.created', response: { id: 'resp_fixture' } },
    { type: 'response.output_item.done', output_index: 0, item: call },
  ), 'test-model', () => {}, { onSearchSources: result => evidence.push(result) })).rejects.toThrow('before completion')
  expect(evidence).toEqual([])
})
