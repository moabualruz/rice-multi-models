import type { PickerRow } from './picker'
import type { Limits } from './protocol'
import { NATIVE_MODEL_LIMITATIONS, NATIVE_WINDOW_EXPLANATION, unknownMetadata } from './catalogue'
import type { ModelCatalogue, ModelMetadata } from './catalogue'

export type DiscoverySection = { id: string; text: string; scope: 'shared' | 'session' }
export type DiscoveryLimit = { status: 'reported' | 'unavailable'; observedAt?: string; plan?: string; windows: Limits['windows'] }
export type DiscoveryApproval = { provider: string; approved: boolean }

export const DISCOVERY_SECTION_ID = 'rice-multi-models:discovery'
export type FamilyLine = { family: string; label: string; model?: string; tiers?: Partial<Record<string, string>> }

/** The model-facing guidance: native agents, same-family defaults and exact model ids in agent definitions. No mod tools. */
export function discoveryGuidance(families: readonly FamilyLine[]): string {
  const lines = families.map(entry => {
    const tiers = Object.entries(entry.tiers ?? {}).filter(([, model]) => model).map(([tier, model]) => `${tier} -> ${model}`)
    const runs = entry.family === 'claude' ? 'native Claude models' : entry.model ?? 'no discovered model'
    return `- ${entry.label}: ${runs}${tiers.length ? ` (tiers: ${tiers.join(', ')})` : ''}`
  })
  return [
    'Model families in this session (rice-multi-models):',
    '- Each conversation stays on its own provider family. Subagents, forked skills, skill model aliases and background work (compaction, titles, permission judgments, web search and fetch, evaluators) use the family of the conversation that owns them.',
    "- The Agent tool accepts every exact provider/model id in this session's catalogue, preserving the real model name and version. Claude tier aliases are optional selection metadata inside the current family, never an external model's identity. Leave model out to inherit the owning conversation unless instructions configured a default.",
    '- Use another provider only when the user or session instructions ask for it, by passing the exact provider/model id to the native Agent tool. Project agent files belong to the project and Claude applies them as written; a model they name, from a provider here or Claude, runs the same way. This mod ships none.',
    ...lines,
    '- Catalogue entries are candidates, not proof of entitlement or quota. Report provider refusals and quota limits; never switch providers to get around them. The user can list every model with /rice-models models.',
  ].join('\n')
}

export function withDiscoverySection(sections: readonly DiscoverySection[], text: string): DiscoverySection[] {
  return [...sections.filter(section => section.id !== DISCOVERY_SECTION_ID), { id: DISCOVERY_SECTION_ID, text, scope: 'session' }]
}

export type CandidateRoute = {
  source: string
  execution: 'native provider'
  identity: string
  codexSubscriptionQuota: boolean
}
export type CandidateModel = PickerRow & {
  source: string
  execution: 'native provider'
  routeIdentity: string
  codexSubscriptionQuota: boolean
  metadata?: ModelMetadata
  metadataSources?: Partial<Record<keyof ModelMetadata, string>>
  observedAt?: number
}

export function candidates(
  rows: readonly PickerRow[],
  routeFor?: (model: string) => CandidateRoute | undefined,
): CandidateModel[] {
  const seen = new Set<string>()
  return rows.flatMap(row => {
    if (seen.has(row.model)) return []
    seen.add(row.model)
    const resolved = routeFor?.(row.model)
    const execution = resolved?.execution ?? 'native provider'
    const routeIdentity = resolved?.identity ?? JSON.stringify({ execution, model: row.model })
    const source = resolved?.source ?? 'supplied model catalogue'
    const codexSubscriptionQuota = resolved?.codexSubscriptionQuota ?? false
    return [{ ...row, source, execution, routeIdentity, codexSubscriptionQuota }]
  })
}

export function modelIsCandidate(model: string, models: readonly CandidateModel[]): boolean {
  return models.some(candidate => candidate.model === model)
}

export function modelExecution(model: string, models: readonly CandidateModel[]): 'native provider' | undefined {
  return models.find(candidate => candidate.model === model)?.execution
}

export function limitsReport(limits: Limits | undefined, observedAt: number | undefined): DiscoveryLimit {
  if (!limits || limits.windows.length === 0 || observedAt === undefined) return { status: 'unavailable', windows: [] }
  return {
    status: 'reported',
    observedAt: new Date(observedAt).toISOString(),
    ...(limits.plan === undefined ? {} : { plan: limits.plan }),
    windows: limits.windows.map(window => ({ ...window })),
  }
}

export function modelsReport(models: readonly CandidateModel[], approvals: readonly DiscoveryApproval[], limit: DiscoveryLimit, catalogue?: ModelCatalogue): string {
  const entries = models.map(model => ({
    model: model.model,
    source: model.source,
    execution: model.execution,
    availability: 'candidate, not live-entitlement proof',
    observedAt: model.observedAt === undefined ? null : new Date(model.observedAt).toISOString(),
    metadata: model.metadata ?? unknownMetadata(),
    metadataSources: model.metadataSources ?? {},
    usageLimits: model.codexSubscriptionQuota ? limit : { status: 'unavailable', windows: [] },
  }))
  return JSON.stringify({ models: entries, discovery: catalogue?.providers ?? [], providerApprovals: approvals, codexLimits: limit, compaction: { routed: 'session.compact', reason: 'the engine cannot send its own summary request to another provider, so the supported lifecycle hook sends the engine\'s own prompt and summary format, read from the installed claude, over the conversation to the selected provider; native transcript persistence', customSummarization: false, providerFallback: false, nativeClaude: 'unchanged', unknownSubagent: 'skip compaction until its next observed turn identifies the model after reload', modelSwitchGuard: false, inputBudgetGuard: false, contextWindowData: 'CLAUDE_CODE_MAX_CONTEXT_TOKENS carries the smallest reported window among the routed main model and live routed subagents; native accounting and automatic compaction act on it; an explicit owner override stays authoritative', automaticChildCompaction: 'native, driven by that window data; no per-agent window and no provider-error recovery seam are public' }, nativeContextRegistration: NATIVE_WINDOW_EXPLANATION, nativeModelLimitations: NATIVE_MODEL_LIMITATIONS }, null, 2)
}
