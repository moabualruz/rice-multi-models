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

test('tier state is pure, priority ordered and never reveals authentication references', () => {
  const parsed = parseFetchConfig(source)
  expect(fetchTierConfigState(parsed.config, true)).toEqual([
    { tier: 'provider-native' },
    { tier: 'configured-service', services: [{ name: 'first', priority: 10 }, { name: 'second', priority: 20 }] },
    { tier: 'native-fallback' },
    { tier: 'direct-selected-extraction' },
  ])
  expect(JSON.stringify(fetchTierConfigState(parsed.config, true))).not.toContain('FETCH_SECOND_KEY')
  expect(fetchTierConfigState(parsed.config, false)[0]).toEqual({ tier: 'configured-service', services: [{ name: 'first', priority: 10 }, { name: 'second', priority: 20 }] })
})
