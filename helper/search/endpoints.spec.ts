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
