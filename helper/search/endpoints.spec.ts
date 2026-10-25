import { expect, test } from 'bun:test'
import { configuredSearch, endpointSearch, searchEndpoints } from './endpoints.ts'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('configured service priority is stable and the legacy instance follows explicit services', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rice-search-order-'))
  try {
    mkdirSync(join(directory, 'rice-multi-models'))
    writeFileSync(join(directory, 'rice-multi-models/search.json'), JSON.stringify({ version: 1, endpoints: [
      { name: 'cloud', kind: 'brave', url: 'https://cloud.example/search', priority: 20 },
      { name: 'home', kind: 'searxng', url: 'http://home.example/search', priority: 1 },
      { name: 'other', kind: 'tavily', url: 'https://other.example/search', priority: 20 },
    ] }))
    expect(searchEndpoints({ CLAUDE_CONFIG_DIR: directory, RICE_MULTI_MODELS_SEARCH_URL: 'http://legacy.example/search' }).map(row => row.name)).toEqual(['home', 'cloud', 'other', 'legacy-environment'])
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('search service failure advances in order without leaking credentials and a valid empty result stops', async () => {
  const attempts: string[] = []
  const request = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input), headers = new Headers(init?.headers)
    attempts.push(url)
    if (url.startsWith('https://first.example')) {
      expect(headers.get('authorization')).toBeNull()
      return new Response('{"error":"private response bytes"}', { status: 429 })
    }
    expect(headers.get('x-subscription-token')).toBeNull()
    expect(headers.get('authorization')).toBeNull()
    return Response.json({ results: [] })
  }) as typeof fetch
  const found = await configuredSearch('owned query', new AbortController().signal, [
    { name: 'first', kind: 'searxng', url: 'https://first.example/search', priority: 1 },
    { name: 'second', kind: 'searxng', url: 'https://second.example/search', priority: 2 },
    { name: 'third', kind: 'searxng', url: 'https://third.example/search', priority: 3 },
  ], request)
  expect(found).toEqual([])
  expect(attempts.length).toBe(2)
})

test('cloud adapters send only their own auth and normalize the actual API result envelopes', async () => {
  const request = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    expect(init?.redirect).toBe('error')
    if (String(input).includes('brave.example')) {
      expect(headers.get('x-subscription-token')).toBe('owned-brave')
      expect(headers.get('authorization')).toBeNull()
      expect(init?.method).toBe('GET')
      return Response.json({ web: { results: [{ title: 'Brave source', url: 'https://source.example/brave', description: 'Brave snippet' }] } })
    }
    expect(headers.get('authorization')).toBe('Bearer owned-tavily')
    expect(headers.get('x-subscription-token')).toBeNull()
    expect(JSON.parse(String(init?.body))).toMatchObject({ include_answer: false, include_raw_content: false, search_depth: 'basic', query: 'owned' })
    return Response.json({ results: [{ title: 'Tavily source', url: 'https://source.example/tavily', content: 'Tavily snippet' }, { title: 'Refused', url: 'https://key@source.example/private', content: 'Hidden' }] })
  }) as typeof fetch
  const signal = new AbortController().signal
  expect((await endpointSearch({ name: 'brave', kind: 'brave', url: 'https://brave.example/search', priority: 1, auth: { env: 'OWNED_BRAVE' } }, 'owned', signal, request, { OWNED_BRAVE: 'owned-brave' })).results).toEqual([{ title: 'Brave source', url: 'https://source.example/brave', content: 'Brave snippet' }])
  expect((await endpointSearch({ name: 'tavily', kind: 'tavily', url: 'https://tavily.example/search', priority: 1, auth: { env: 'OWNED_TAVILY' } }, 'owned', signal, request, { OWNED_TAVILY: 'owned-tavily' })).results).toEqual([{ title: 'Tavily source', url: 'https://source.example/tavily', content: 'Tavily snippet' }])
})

test('cancellation does not trigger another search service', async () => {
  const controller = new AbortController()
  let calls = 0
  const request = (async () => { calls++; controller.abort(new Error('owned stop')); throw controller.signal.reason }) as typeof fetch
  await expect(configuredSearch('owned', controller.signal, [
    { name: 'first', kind: 'searxng', url: 'https://first.example/search', priority: 1 },
    { name: 'second', kind: 'searxng', url: 'https://second.example/search', priority: 2 },
  ], request)).rejects.toThrow('owned stop')
  expect(calls).toBe(1)
})

test('domain lists map to Tavily include and exclude fields and omit them when absent', async () => {
  const bodies: Record<string, unknown>[] = []
  const request = (async (_input: URL | RequestInfo, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return Response.json({ results: [] }) }) as typeof fetch
  const tavily = { name: 'tavily', kind: 'tavily', url: 'https://tavily.example/search', priority: 1, auth: { env: 'OWNED_TAVILY' } } as const
  const signal = new AbortController().signal, environment = { OWNED_TAVILY: 'owned-tavily' }
  await endpointSearch(tavily, 'owned', signal, request, environment, { allowed: ['docs.example'], blocked: ['spam.example'] })
  await endpointSearch(tavily, 'owned', signal, request, environment, { allowed: ['docs.example'] })
  await endpointSearch(tavily, 'owned', signal, request, environment)
  expect(bodies[0]).toMatchObject({ include_domains: ['docs.example'], exclude_domains: ['spam.example'] })
  expect(bodies[1]).toMatchObject({ include_domains: ['docs.example'] }); expect('exclude_domains' in bodies[1]!).toBe(false)
  expect('include_domains' in bodies[2]! || 'exclude_domains' in bodies[2]!).toBe(false)
})

test('a service without native domain fields is skipped when domains are set, so Claude searches instead', async () => {
  const attempts: string[] = []
  const request = (async (input: URL | RequestInfo) => { attempts.push(String(input)); return Response.json({ results: [] }) }) as typeof fetch
  const signal = new AbortController().signal
  const brave = { name: 'brave', kind: 'brave', url: 'https://brave.example/search', priority: 1 } as const
  const searx = { name: 'searx', kind: 'searxng', url: 'https://searx.example/search', priority: 2 } as const
  await expect(configuredSearch('owned', signal, [brave, searx], request, undefined, { blocked: ['spam.example'] })).rejects.toThrow('No configured search service is available.')
  expect(attempts).toEqual([])
  await configuredSearch('owned', signal, [brave, searx], request, undefined, {})
  expect(attempts).toHaveLength(1)
  await configuredSearch('owned', signal, [brave, searx], request, undefined, { allowed: [] })
  expect(attempts).toHaveLength(2)
})

test('a configured service result is mapped whole and a long query is sent as given', async () => {
  const hits = Array.from({ length: 12 }, (_, index) => ({ title: `T${index}`.padEnd(600, 'x'), url: `https://source.example/${index}`, content: 'c'.repeat(5000) }))
  const queries: string[] = []
  const request = (async (input: URL | RequestInfo) => { queries.push(new URL(String(input)).searchParams.get('q') ?? ''); return Response.json({ results: hits }) }) as typeof fetch
  const long = 'q'.repeat(3000)
  const { results } = await endpointSearch({ name: 'owned', kind: 'searxng', url: 'https://searx.example/search', priority: 1 }, long, new AbortController().signal, request)
  expect(queries).toEqual([long])
  expect(results).toHaveLength(12)
  expect(results[0]).toEqual({ title: hits[0]!.title, url: 'https://source.example/0', content: hits[0]!.content })
})
