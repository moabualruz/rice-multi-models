import { emptyFetchConfig, fetchTierConfigState } from './fetch-config'
import type { FetchTierConfigState } from './fetch-config'
import { orderedSearchEndpoints } from './search-config'
import type { SearchConfig } from './search-config'
import type { Remote } from './providers'
import { DEFAULT_WEB_SEARCH_MAX_USES, nativeSearchDecision } from './web-search-tier'

export type FetchTierState = FetchTierConfigState
export type FetchConfigurationStatus = { available: boolean; error: string | null }

export type WebSearchStatus = {
  selectedModel: string
  providerNative: ReturnType<typeof nativeSearchDecision>
  configuredServices: Array<{ order: number; name: string; kind: string; priority: number | null }>
  configuredServicesAvailable: boolean
  claudeFallback: { available: true; readiness: string }
  fetchConfiguration: FetchConfigurationStatus
  fetchTierState: FetchTierState
}

/** Safe metadata only. Endpoint URLs, credential references, and credential values stay private. */
export function webSearchStatus(selectedModel: string, remote: Remote | undefined, config: SearchConfig, legacyUrl?: string, configuredServicesAvailable = true,
  fetchTierState: FetchTierState = fetchTierConfigState(emptyFetchConfig(), false), fetchConfiguration: FetchConfigurationStatus = { available: true, error: null }): WebSearchStatus {
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
    fetchConfiguration,
    fetchTierState,
  }
}
