import type { PickerRow } from './picker'
import type { Limits } from './protocol'
import { unknownMetadata } from './catalogue'
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
    "- The Agent tool's model argument accepts only haiku, sonnet, opus or fable; the host rejects other ids before hooks. These aliases pick a tier inside the current family and never switch provider. Leave model out to use the family default (the parent's model unless the user configured a default tier).",
    '- Use another family only when the user or session instructions ask for it, by setting a custom agent definition\'s model to an exact provider/model id, such as model: codex/gpt-6.1-sol.',
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
  return JSON.stringify({ models: entries, discovery: catalogue?.providers ?? [], providerApprovals: approvals, codexLimits: limit, compaction: { routed: 'session.compact', reason: 'the engine cannot send its own summary request to another provider, so the supported lifecycle hook sends the engine\'s own prompt and summary format, read from the installed claude, over the conversation to the selected provider; native transcript persistence', customSummarization: false, providerFallback: false, nativeClaude: 'unchanged', unknownSubagent: 'skip compaction until its next observed turn identifies the model after reload', modelSwitchGuard: 'deny context exceeding fresh exact routed destination input/context bounds; unknown, stale and native Claude bounds are not inferred; not proof of request fit' }, nativeContextRegistration: 'numeric per-model registration unsupported by the exposed Claude Code plugin API (2.1.301 and 2.1.302); main routed native-provider model uses the supported process-local CLAUDE_CODE_MAX_CONTEXT_TOKENS override from fresh exact active contextWindow ?? maxContextWindow metadata for the native context meter and automatic compaction threshold; existing explicit owner override remains authoritative; unknown routes, discovery failure and session.end restore the value owned by the mod; ownership state survives hot reload; the process-global override does not establish independent custom-subagent windows; mixed custom models and restoration on plugin unload remain limitations' }, null, 2)
}
