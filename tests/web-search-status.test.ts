import { expect, test } from 'bun:test'
import { fetchProviderProtocol, fetchTierConfigState } from '../hooks/fetch-config'
import type { FetchConfig } from '../hooks/fetch-config'
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
  expect(status.providerNative.method).toBe('hosted')
  expect(status.configuredServices).toEqual([
    { order: 1, name: 'first', kind: 'searxng', priority: 1 },
    { order: 2, name: 'later', kind: 'brave', priority: 20 },
    { order: 3, name: 'tie', kind: 'tavily', priority: 20 },
    { order: 4, name: 'legacy-environment', kind: 'searxng', priority: null },
  ])
  expect(status.claudeFallback).toMatchObject({ available: true })
  expect(status.fetchTierState.tiers.map(tier => tier.stage)).toEqual(['provider-native', 'configured-service', 'native-fallback'])
  expect(status.fetchConfiguration).toEqual({ available: true, error: null })
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

test('fetch diagnostics expose safe configured services and honest fallback readiness', () => {
  const fetchConfig: FetchConfig = { version: 1, endpoints: [
    { name: 'later', url: 'https://fetch.example/later', priority: 20, auth: { env: 'FETCH_SECRET_NAME' } },
    { name: 'first', url: 'https://fetch.example/first', priority: 1 },
  ] }
  const state = fetchTierConfigState(fetchConfig, true)
  const status = webSearchStatus('anthropic/selected', undefined, { version: 1, endpoints: [] }, undefined, true, state, { available: false, error: 'Fetch configuration could not be read.' })
  expect(state.tiers).toEqual([
    { order: 1, stage: 'provider-native', eligible: true, reason: 'The selected route passes local provider protocol checks; model or account support may still be rejected by the provider.' },
    { order: 2, stage: 'configured-service', eligible: true, reason: 'Configured services are tried serially by ascending priority; reachability is not checked by status.', services: [{ name: 'first', priority: 1 }, { name: 'later', priority: 20 }] },
    { order: 3, stage: 'native-fallback', eligible: true, reason: 'Claude Code native WebFetch is the final fallback. Failure is terminal; no hidden retrieval runs afterward.', readiness: 'Session authorization and account WebFetch support are checked only if this tier is used.' },
  ])
  expect(status.fetchConfiguration).toEqual({ available: false, error: 'Fetch configuration could not be read.' })
  const safe = JSON.stringify(status)
  for (const secretDetail of ['fetch.example', 'FETCH_SECRET_NAME']) expect(safe).not.toContain(secretDetail)
})

test('provider-native fetch eligibility is restricted to confirmed official contracts and supported Gemini models', () => {
  expect(fetchProviderProtocol('anthropic', 'https://api.anthropic.com/v1', 'claude-sonnet-4-6')).toBe('anthropic')
  expect(fetchProviderProtocol('anthropic', 'https://api.anthropic.com/v1', 'not-a-claude-model')).toBeUndefined()
  expect(fetchProviderProtocol('gemini', 'https://generativelanguage.googleapis.com/v1beta', 'gemini-2.5-flash')).toBe('gemini')
  expect(fetchProviderProtocol('gemini', 'https://generativelanguage.googleapis.com', 'gemini-2.0-flash')).toBeUndefined()
  expect(fetchProviderProtocol('gemini', 'https://user@generativelanguage.googleapis.com', 'gemini-2.5-flash')).toBeUndefined()
  expect(fetchProviderProtocol('gemini', 'https://generativelanguage.googleapis.com?proxy=1', 'gemini-2.5-flash')).toBeUndefined()
  expect(fetchProviderProtocol('gemini', 'https://compatible.example', 'gemini-2.5-flash')).toBeUndefined()
  expect(fetchProviderProtocol('openai', 'https://api.anthropic.com', 'claude-sonnet-4-6')).toBeUndefined()
})

test('doctor status recognizes native contracts', () => {
  const gemini = webSearchStatus('local/main', {
    provider: { baseUrl: 'https://generativelanguage.googleapis.com', auth: 'none' },
    model: { kind: 'gemini', webSearch: 'auto' },
  }, { version: 1, endpoints: [] })
  expect(gemini.providerNative.recognized).toBe(true)
  expect(gemini.providerNative.method).toBe('hosted')

  const custom = webSearchStatus('custom/main', {
    provider: { baseUrl: 'https://compatible.example/v1', auth: 'none' },
    model: { kind: 'responses', webSearch: 'auto' },
  }, { version: 1, endpoints: [] })
  expect(custom.providerNative.recognized).toBe(false)
  expect(custom.providerNative.method).toBeUndefined()
})
