import { expect, test } from 'bun:test'
import { webSearchStatus } from '../hooks/web-search-status'
import type { SearchConfig } from '../hooks/search-config'
import type { FetchTierState } from '../hooks/web-search-status'

const config: SearchConfig = { version: 1, endpoints: [
  { name: 'later', kind: 'brave', url: 'https://search.example/later', priority: 20, auth: { env: 'SEARCH_SECRET_NAME' } },
  { name: 'first', kind: 'searxng', url: 'https://search.example/first', priority: 1 },
  { name: 'tie', kind: 'tavily', url: 'https://search.example/tie', priority: 20, auth: { command: ['/safe/credential-helper'] } },
] }

test('doctor web-search metadata uses configured order and never returns endpoint or credential details', () => {
  const status = webSearchStatus('codex/selected', undefined, config, 'https://search.example/legacy')
  expect(status.selectedModel).toBe('codex/selected')
  expect(status.providerNative.recognized).toBe(true)
  expect(status.providerNative.method).toBeUndefined()
  expect(status.providerNative.constraints).toContain('Codex cannot enforce a maximum number of search uses before making its provider call.')
  expect(status.configuredServices).toEqual([
    { order: 1, name: 'first', kind: 'searxng', priority: 1 },
    { order: 2, name: 'later', kind: 'brave', priority: 20 },
    { order: 3, name: 'tie', kind: 'tavily', priority: 20 },
    { order: 4, name: 'legacy-environment', kind: 'searxng', priority: null },
  ])
  expect(status.claudeFallback).toMatchObject({ available: true })
  expect(status.fetchTierState).toMatchObject({ available: false })
  const safe = JSON.stringify(status)
  for (const secretDetail of ['search.example', 'SEARCH_SECRET_NAME', '/safe/credential-helper']) expect(safe).not.toContain(secretDetail)
})

test('doctor accepts the documented pure fetch-tier state shape', () => {
  const fetchState: FetchTierState = { tiers: [
    { order: 1, stage: 'provider-native', eligible: false, reason: 'The selected route has no native fetch contract.' },
    { order: 2, stage: 'configured-service', eligible: true, reason: 'A configured service is eligible.' },
  ] }
  const status = webSearchStatus('selected/main', undefined, { version: 1, endpoints: [] }, undefined, true, fetchState)
  expect(status.fetchTierState).toEqual(fetchState)
})

test('doctor status recognizes native contracts and names disabling constraints', () => {
  const gemini = webSearchStatus('local/main', {
    provider: { baseUrl: 'https://generativelanguage.googleapis.com', auth: 'none' },
    model: { kind: 'gemini', webSearch: 'auto' },
  }, { version: 1, endpoints: [] })
  expect(gemini.providerNative.recognized).toBe(true)
  expect(gemini.providerNative.method).toBeUndefined()
  expect(gemini.providerNative.constraints).toContain('Gemini grounding cannot enforce a maximum number of search uses.')

  const custom = webSearchStatus('custom/main', {
    provider: { baseUrl: 'https://compatible.example/v1', auth: 'none' },
    model: { kind: 'responses', webSearch: 'auto' },
  }, { version: 1, endpoints: [] })
  expect(custom.providerNative.recognized).toBe(false)
  expect(custom.providerNative.method).toBeUndefined()
})
