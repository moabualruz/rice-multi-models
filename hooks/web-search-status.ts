import { orderedSearchEndpoints } from './search-config'
import type { SearchConfig } from './search-config'
import type { Remote } from './providers'
import { DEFAULT_WEB_SEARCH_MAX_USES, nativeSearchDecision } from './web-search-tier'

export type FetchTier = 'provider-native' | 'configured-service' | 'direct-selected-extraction' | 'claude-native'
export type FetchTierStateInput = {
  target: string
  remote?: Remote
  configuredServices: readonly { order: number; name: string; kind: string; priority: number | null }[]
}
export type FetchTierState = { tiers: readonly { order: number; stage: FetchTier; eligible: boolean; reason: string }[] }
export type FetchTierStateFunction = (input: FetchTierStateInput) => FetchTierState

export type WebSearchStatus = {
  selectedModel: string
  providerNative: ReturnType<typeof nativeSearchDecision>
  configuredServices: Array<{ order: number; name: string; kind: string; priority: number | null }>
  configuredServicesAvailable: boolean
  claudeFallback: { available: true; readiness: string }
  fetchTierState: FetchTierState | { available: false; reason: string }
}

/** Safe metadata only. Endpoint URLs, credential references, and credential values stay private. */
export function webSearchStatus(selectedModel: string, remote: Remote | undefined, config: SearchConfig, legacyUrl?: string, configuredServicesAvailable = true, fetchTierState?: FetchTierState): WebSearchStatus {
  const ordered = orderedSearchEndpoints(config)
  const configuredServices: WebSearchStatus['configuredServices'] = ordered.map((endpoint, index) => ({ order: index + 1, name: endpoint.name, kind: endpoint.kind, priority: endpoint.priority }))
  if (legacyUrl && !ordered.some(endpoint => endpoint.url === legacyUrl)) configuredServices.push({
    order: configuredServices.length + 1, name: 'legacy-environment', kind: 'searxng', priority: null,
  })
  const providerNative = nativeSearchDecision(selectedModel, remote, { maxUses: DEFAULT_WEB_SEARCH_MAX_USES })
  return {
    selectedModel,
    providerNative,
    configuredServices,
    configuredServicesAvailable,
    claudeFallback: { available: true, readiness: 'Session authorization and account search support are verified only if this fallback is used.' },
    fetchTierState: fetchTierState ?? { available: false, reason: 'Fetch-tier diagnostics are not exposed by the current fetch integration.' },
  }
}
