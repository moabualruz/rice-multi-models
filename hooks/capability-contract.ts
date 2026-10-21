import { inputBudget } from './config'
import type { Config, Kind, ModelConfig, ProviderConfig } from './config'
import type { RemoteTool } from './protocol'

export type CapabilityBound = { status: 'known'; tokens: number } | { status: 'unknown'; tokens: null }
export type ModelCapabilityContract = {
  target: string
  protocol: Kind
  tools: {
    enabled: boolean
    allowlist: readonly string[] | 'all'
    cap: number
    configuredCount: number | null
    schemaFidelity: string
  }
  vision: boolean
  documents: string
  contextWindow: CapabilityBound
  inputTokens: CapabilityBound
  outputTokens: CapabilityBound
  parallelCalls: boolean
  reasoning: { status: 'configured' | 'unknown'; effort: string[]; note: string }
  caching: { enabled: boolean; lifetime: ModelConfig['cache'] | null; note: string }
  web: { search: string; fetch: string }
}

const known = (tokens: number | undefined): CapabilityBound => tokens === undefined
  ? { status: 'unknown', tokens: null }
  : { status: 'known', tokens }

const schemaFidelity: Readonly<Record<Kind, string>> = {
  anthropic: 'JSON Schema is passed through in the provider format; strict mode is not enabled.',
  openai: 'JSON Schema is passed through as function parameters; strict mode is not enabled.',
  responses: 'JSON Schema is passed through as function parameters; strict mode is explicitly disabled.',
  gemini: 'JSON Schema is passed through as parametersJsonSchema; provider constraints may differ.',
  bedrock: 'JSON Schema is passed through as Converse inputSchema.json; provider constraints may differ.',
}

const documentContract: Readonly<Record<Kind, string>> = {
  anthropic: 'PDF/base64 and text/plain documents are forwarded as native document blocks; URL sources are omitted explicitly.',
  openai: 'text/plain documents are flattened to text; PDF and URL document sources are omitted explicitly by Chat Completions.',
  responses: 'PDF/base64 and text/plain documents are translated to input_file and input_text; URL sources are omitted explicitly.',
  gemini: 'PDF/base64 documents use inlineData and text/plain documents become text; URL sources are omitted explicitly.',
  bedrock: 'PDF/base64 documents use Converse document bytes and text/plain documents become text; URL sources are omitted explicitly.',
}

const cacheNote: Readonly<Record<Kind, string>> = {
  anthropic: 'Configured cache lifetime uses provider cache points.',
  bedrock: 'Configured cache lifetime uses provider cache points.',
  openai: 'No cache lifetime is configured by this adapter; provider-side caching may be automatic.',
  responses: 'No cache lifetime is configured by this adapter; provider-side caching may be automatic.',
  gemini: 'No cache lifetime is configured by this adapter; provider-side caching may be automatic.',
}

/** Build a deterministic, I/O-free report from the validated configuration, without inferring model metadata. */
export function capabilityContracts(config: Config, webCapabilities: Readonly<Record<string, ModelCapabilityContract['web']>> = {}): ModelCapabilityContract[] {
  return Object.values(config.providers)
    .flatMap(provider => Object.values(provider.models).map(model => capabilityContract(provider, model, webCapabilities[`${provider.id}/${model.id}`])))
    .sort((a, b) => a.target.localeCompare(b.target))
}

export function capabilityContract(provider: ProviderConfig, model: ModelConfig, web = { search: model.webSearch ?? 'unknown', fetch: 'not configured per model' }): ModelCapabilityContract {
  const effort = Object.keys(model.effort ?? {})
  const input = inputBudget(model)
  const configuredCount = Array.isArray(model.tools)
    ? Math.min(model.tools.length, provider.maxTools)
    : model.tools ? null : 0
  return {
    target: `${provider.id}/${model.id}`,
    protocol: model.kind,
    tools: {
      enabled: model.tools !== false,
      allowlist: Array.isArray(model.tools) ? [...model.tools] : model.tools ? 'all' : [],
      cap: provider.maxTools,
      configuredCount,
      schemaFidelity: schemaFidelity[model.kind],
    },
    vision: model.vision,
    documents: documentContract[model.kind],
    contextWindow: known(model.contextWindow),
    inputTokens: known(input === null ? undefined : input),
    outputTokens: known(model.maxOutputTokens),
    parallelCalls: model.parallelToolCalls,
    reasoning: {
      status: effort.length ? 'configured' : 'unknown',
      effort,
      note: effort.length ? 'Configured effort parameters are sent; provider/model support is not independently verified.' : 'No per-model effort levels are configured; reasoning support is unknown.',
    },
    caching: {
      enabled: model.cache !== undefined,
      lifetime: model.cache ?? null,
      note: cacheNote[model.kind],
    },
    web,
  }
}

/** Select tools in session order, applying the model allowlist and provider cap exactly once. */
export function selectTools<T extends Pick<RemoteTool, 'name'>>(tools: readonly T[], provider: Pick<ProviderConfig, 'maxTools'>, model: Pick<ModelConfig, 'tools'>): T[] {
  if (model.tools === false) return []
  const allowed = Array.isArray(model.tools) ? new Set(model.tools) : undefined
  return tools.filter(tool => allowed === undefined || allowed.has(tool.name)).slice(0, provider.maxTools)
}

export function formatCapabilityContracts(contracts: readonly ModelCapabilityContract[]): string {
  if (contracts.length === 0) return 'Configured model capabilities: no valid provider models.'
  const bound = (value: CapabilityBound) => value.status === 'known' ? String(value.tokens) : 'unknown'
  const rows = contracts.map(contract => {
    const allowlist = contract.tools.allowlist === 'all' ? 'all' : contract.tools.allowlist.join(',') || 'none'
    const configured = contract.tools.configuredCount === null ? 'session-dependent' : String(contract.tools.configuredCount)
    return `${contract.target} (${contract.protocol}): tools=${contract.tools.enabled ? 'on' : 'off'}, allowlist=${allowlist}, configured-cap=${contract.tools.cap}, allowlisted-count=${configured}, schema=${contract.tools.schemaFidelity}; vision=${contract.vision ? 'on' : 'off'}; documents=${contract.documents}; context=${bound(contract.contextWindow)}, input=${bound(contract.inputTokens)}, output=${bound(contract.outputTokens)}; parallel=${contract.parallelCalls ? 'on' : 'off'}; reasoning=${contract.reasoning.status} effort=${contract.reasoning.effort.join(',') || 'unknown'} (${contract.reasoning.note}); cache=${contract.caching.enabled ? contract.caching.lifetime : 'off'} (${contract.caching.note}); web-search=${contract.web.search}, web-fetch=${contract.web.fetch}.`
  })
  return `Configured model capabilities:\n${rows.join('\n')}`
}

export function toolCoverageWarning(target: string, sessionToolCount: number, offeredToolCount: number): string | undefined {
  if (offeredToolCount >= sessionToolCount) return undefined
  return `${target} is offered ${offeredToolCount} of ${sessionToolCount} session tools because of its configured model allowlist or provider tool cap.`
}
