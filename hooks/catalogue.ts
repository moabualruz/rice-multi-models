export type ModelMetadata = {
  contextWindow: number | null
  maxContextWindow: number | null
  inputTokenLimit: number | null
  outputTokenLimit: number | null
  autoCompactTokenLimit: number | null
  inputModalities: string[] | null
  reasoningEfforts: string[] | null
  tools: boolean | null
  parallelToolCalls: boolean | null
}

export type DiscoveredModel = {
  model: string
  label: string
  execution: 'native provider'
  source: string
  observedAt: number
  metadata: ModelMetadata
  metadataSources?: Partial<Record<keyof ModelMetadata, string>>
}

export type DiscoveryProvider = {
  provider: string
  status: 'fresh' | 'unavailable' | 'approval-required'
  source: string
  observedAt?: number
  error?: string
}

export type ModelCatalogue = { models: DiscoveredModel[]; providers: DiscoveryProvider[] }

export const unknownMetadata = (): ModelMetadata => ({
  contextWindow: null,
  maxContextWindow: null,
  inputTokenLimit: null,
  outputTokenLimit: null,
  autoCompactTokenLimit: null,
  inputModalities: null,
  reasoningEfforts: null,
  tools: null,
  parallelToolCalls: null,
})
