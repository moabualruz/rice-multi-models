import { expect, test } from 'bun:test'
import { fetchTierConfigState, orderedFetchEndpoints, parseFetchConfig } from '../hooks/fetch-config.ts'

const source = JSON.stringify({ version: 1, endpoints: [
  { name: 'second', url: 'https://fetch.example/b', priority: 20, auth: { env: 'FETCH_SECOND_KEY' } },
  { name: 'first', url: 'https://fetch.example/a', priority: 10, auth: { command: ['/usr/bin/credential-helper', 'read'] } },
] })

test('fetch configuration validates independently and sorts stable priorities', () => {
  const parsed = parseFetchConfig(source)
  expect(parsed.errors).toEqual([])
  expect(orderedFetchEndpoints(parsed.config).map(endpoint => endpoint.name)).toEqual(['first', 'second'])
})

test('bad schema, duplicate names, inline credentials and URL query values fail closed', () => {
  const rows = [
    { name: 'dup', url: 'https://fetch.example/a', priority: 0 },
    { name: 'dup', url: 'https://fetch.example/b', priority: 1 },
  ]
  expect(parseFetchConfig(JSON.stringify({ version: 1, endpoints: rows })).config.endpoints).toEqual([])
  for (const endpoint of [
    { name: 'inline', url: 'https://user@fetch.example/a', priority: 0 },
    { name: 'query', url: 'https://fetch.example/a?key=', priority: 0 },
    { name: 'bad-auth', url: 'http://fetch.example/a', priority: 0, auth: { env: 'FETCH_KEY' } },
    { name: 'bad-command', url: 'https://fetch.example/a', priority: 0, auth: { command: ['credential-helper'] } },
  ]) expect(parseFetchConfig(JSON.stringify({ version: 1, endpoints: [endpoint] })).config.endpoints).toEqual([])
})

test('tier state is pure, priority ordered and never reveals endpoints or authentication references', () => {
  const parsed = parseFetchConfig(source)
  const state = fetchTierConfigState(parsed.config, true)
  expect(state.tiers.map(tier => tier.stage)).toEqual(['provider-native', 'configured-service', 'native-fallback'])
  expect(state.tiers[0]).toMatchObject({ order: 1, eligible: true })
  expect(state.tiers[1]).toMatchObject({ order: 2, eligible: true, services: [{ name: 'first', priority: 10 }, { name: 'second', priority: 20 }] })
  expect(state.tiers[2]).toMatchObject({ order: 3, eligible: true, readiness: expect.any(String) })
  expect(state.tiers).toHaveLength(3)
  const safe = JSON.stringify(state)
  for (const sensitive of ['FETCH_SECOND_KEY', '/usr/bin/credential-helper', 'fetch.example']) expect(safe).not.toContain(sensitive)
  expect(fetchTierConfigState(parsed.config, false).tiers[0]).toMatchObject({ order: 1, stage: 'provider-native', eligible: false })
})
