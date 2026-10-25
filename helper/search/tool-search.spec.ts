import { expect, test } from 'bun:test'
import type { StepEvent, StepWire } from '../../hooks/protocol.ts'
import type { SearchEndpoint } from '../../hooks/search-config.ts'
import { configuredSearch } from './endpoints.ts'
import { createToolSearch } from './tool-search.ts'

const query = 'the exact supplied query'
const source = { title: 'Primary source', url: 'https://docs.example/guide', content: 'Source evidence.' }
const endpoints: SearchEndpoint[] = [{ name: 'owned', kind: 'searxng', url: 'https://search.example/search', priority: 0 }]
function wire(target = 'selected/main', kind = 'responses'): StepWire {
  return { configText: JSON.stringify({ providers: { selected: { kind, baseUrl: 'https://selected.example/v1', auth: 'none', models: { main: { webSearch: 'native' } } } } }), approved: [],
    req: { target, who: 'child-owned', session: 'owned-session', system: 'Private unrelated context', transcript: [{ role: 'user', content: 'Private unrelated transcript' }], tools: [{ name: 'Bash', description: 'Must not be offered to search', schema: {} }] } }
}
const signal = () => new AbortController().signal
async function* completed(sources = [source]): AsyncGenerator<StepEvent> {
  yield { type: 'search_sources', sources, searched: true }
  yield { type: 'stop', reason: 'end_turn' }
}

test('selected provider preserves child/account routing and receives only the exact query', async () => {
  const input = wire(), before = JSON.stringify(input)
  let services = 0, calls = 0
  const search = createToolSearch({
    step: async function* (request) {
      calls++
      expect(request.req.target).toBe('selected/main'); expect(request.req.who).toBe('child-owned'); expect(request.req.session).toBe('owned-session')
      expect(request.approved).toEqual(input.approved)
      expect(request.req.transcript).toEqual([{ role: 'user', content: query }]); expect(request.req.tools).toEqual([])
      expect(request.req.system).not.toContain('Private unrelated')
      expect(request.req.native?.webSearch).toEqual({})
      yield* completed()
    },
    endpoints: () => endpoints,
    configured: async () => { services++; return [] },
  })
  const result = await search({ wire: input, query }, signal())
  expect(result.kind).toBe('answered')
  if (result.kind === 'answered') {
    expect(result.stage).toBe('provider-native')
    expect(result.result).toMatchObject({ query, results: [{ content: [{ title: source.title, url: source.url, snippet: source.content }] }] })
  }
  expect(calls).toBe(1); expect(services).toBe(0); expect(JSON.stringify(input)).toBe(before)
})

test('partial provider output and errors are discarded before configured services see the same query', async () => {
  const order: string[] = []
  const search = createToolSearch({
    step: async function* () { order.push('provider'); yield { type: 'text', text: 'Unverified leaked answer' }; yield { type: 'error', kind: 'response', text: 'quota' } },
    endpoints: () => endpoints,
    configured: async (asked, _signal, selected) => { order.push('configured'); expect(asked).toBe(query); expect(selected).toEqual(endpoints); return [source] },
  })
  const result = await search({ wire: wire(), query }, signal())
  expect(order).toEqual(['provider', 'configured']); expect(JSON.stringify(result)).not.toContain('Unverified')
  expect(result).toMatchObject({ kind: 'answered', stage: 'configured-service' })
})

test('unknown search capability skips inference and valid empty retrieval succeeds', async () => {
  let inference = 0
  const input = wire('selected/main', 'openai')
  const search = createToolSearch({ step: async function* () { inference++; yield* completed() }, endpoints: () => endpoints, configured: async () => [] })
  const result = await search({ wire: input, query }, signal())
  expect(inference).toBe(0); expect(result.kind).toBe('answered')
  if (result.kind === 'answered') expect(result.result).toMatchObject({ query, results: [{ content: [] }], searchCount: 1 })
})

test('sources map onto the native result shape without Rice filtering, deduplicating or truncating them', async () => {
  const many = Array.from({ length: 20 }, (_, index) => ({ title: 'x'.repeat(700), url: `https://sub.docs.example/guide/${index}`, content: 'y'.repeat(5000) }))
  const search = createToolSearch({ step: async function* () { yield* completed([{ title: 'Other domain', url: 'https://other.example/guide' }, source, source, ...many]) } })
  const result = await search({ wire: wire(), query, allowed_domains: ['docs.example/guide'] }, signal())
  expect(result.kind).toBe('answered')
  if (result.kind === 'answered') {
    const rows = result.result.results.flatMap(group => typeof group === 'string' ? [] : group.content)
    expect(rows).toHaveLength(23); expect(rows[0].url).toBe('https://other.example/guide')
    expect(rows[3].title).toHaveLength(700); expect(rows[3].snippet).toHaveLength(5000)
    expect(Object.keys(result.result).sort()).toEqual(['durationSeconds', 'query', 'results', 'searchCount'].filter(key => key in result.result).sort())
  }
})

test('the native input fields reach the provider request and the Claude fallback request unchanged', async () => {
  const input = { query, allowed_domains: ['docs.example'], blocked_domains: ['other.example'], mode: 'extended' as const }
  let seen: unknown
  const search = createToolSearch({ step: async function* (request) { seen = request.req.native?.webSearch; yield* completed() } })
  await search({ wire: wire(), ...input }, signal())
  expect(seen).toEqual({ allowedDomains: ['docs.example'], blockedDomains: ['other.example'], mode: 'extended' })
  const fallback = createToolSearch({ step: async function* () { yield { type: 'error', kind: 'request', text: 'unavailable' } }, configured: async () => { throw new Error('owned unavailable') } })
  expect(await fallback({ wire: wire(), ...input }, signal())).toMatchObject({ kind: 'native-fallback', request: input })
})

test('provider failure plus unavailable configured services returns a safe original-tool fallback', async () => {
  const search = createToolSearch({ step: async function* () { yield { type: 'error', kind: 'request', text: 'Do not expose credentials or query' } }, endpoints: () => endpoints, configured: async () => { throw new Error('owned unavailable') } })
  expect(await search({ wire: wire(), query }, signal())).toEqual({ kind: 'native-fallback', stage: 'claude-native', reason: 'Selected-provider and configured web search are unavailable.', request: { query } })
})

test('cancellation rejects after buffered output without invoking another search stage', async () => {
  const controller = new AbortController(); let configured = 0
  const search = createToolSearch({ step: async function* () { yield { type: 'text', text: 'Discard me' }; controller.abort(new Error('owned cancellation')); yield* completed() }, configured: async () => { configured++; return [] } })
  await expect(search({ wire: wire(), query }, controller.signal)).rejects.toThrow('owned cancellation')
  expect(configured).toBe(0)
})

test('Codex searches with its own account whatever the request restricts; fields it lacks are not sent', async () => {
  let provider = 0, services = 0
  const search = createToolSearch({ step: async function* () { provider++; yield* completed() }, endpoints: () => endpoints, configured: async () => { services++; return [] } })
  const result = await search({ wire: { ...wire('codex/owned'), configText: '' }, query, blocked_domains: ['blocked.example'], mode: 'standard' }, signal())
  expect(result).toMatchObject({ kind: 'answered', stage: 'provider-native' })
  expect(provider).toBe(1); expect(services).toBe(0)
})

test('a text-only answer without search evidence and a malformed source list both advance to retrieval', async () => {
  for (const mode of ['uncited', 'unsafe']) {
    let services = 0
    const search = createToolSearch({ step: async function* () {
      if (mode === 'uncited') yield { type: 'text', text: 'An unsupported claim with a URL' }
      else yield { type: 'search_sources', searched: true, sources: [{ title: 'Bad URL', url: 'javascript:owned()' }] }
      yield { type: 'stop', reason: 'end_turn' }
    }, endpoints: () => endpoints, configured: async () => { services++; return [source] } })
    const result = await search({ wire: wire(), query }, signal())
    expect(services).toBe(1); expect(result.kind).toBe('answered')
  }
})

test('domain lists reach the configured service and an unrestricted-only service hands the call to Claude with both lists', async () => {
  const input = { query, allowed_domains: ['docs.example'], blocked_domains: ['spam.example'] }
  let seen: unknown
  const mapped = createToolSearch({ step: async function* () { yield { type: 'error', kind: 'request', text: 'unavailable' } }, endpoints: () => endpoints,
    configured: async (_asked, _signal, _selected, _request, _observe, domains) => { seen = domains; return [source] } })
  expect(await mapped({ wire: wire(), ...input }, signal())).toMatchObject({ kind: 'answered', stage: 'configured-service' })
  expect(seen).toEqual({ allowed: ['docs.example'], blocked: ['spam.example'] })
  const requested: string[] = []
  const handed = createToolSearch({ step: async function* () { yield { type: 'error', kind: 'request', text: 'unavailable' } }, endpoints: () => endpoints,
    configured: (asked, abort, selected, _request, observe, domains) => configuredSearch(asked, abort, selected, (async (url: URL | RequestInfo) => { requested.push(String(url)); return Response.json({ results: [] }) }) as typeof fetch, observe, domains) })
  expect(await handed({ wire: wire(), ...input }, signal())).toMatchObject({ kind: 'native-fallback', request: { query, allowed_domains: ['docs.example'], blocked_domains: ['spam.example'] } })
  expect(requested).toEqual([])
})
