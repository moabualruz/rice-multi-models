import { EXPLORE_PROMPT, GENERAL_PURPOSE_PROMPT, SEARCH_WITH_TOOLS } from './agents'
import type { PickerRow } from './picker'
import type { Limits } from './protocol'
import { unknownMetadata } from './catalogue'
import type { ModelCatalogue, ModelMetadata } from './catalogue'

export type DiscoverySection = { id: string; text: string; scope: 'shared' | 'session' }
export type DiscoveryLimit = { status: 'reported' | 'unavailable'; observedAt?: string; plan?: string; windows: Limits['windows'] }
export type DiscoveryApproval = { provider: string; approved: boolean }

export const DISCOVERY_SECTION_ID = 'rice-multi-models:discovery'
export const DISCOVERY_TOOL = 'mcp__rice-multi-models__models'
export const AGENT_TYPE_TOOL = 'mcp__rice-multi-models__agent_type'

export const DISCOVERY_SCHEMAS = {
  [DISCOVERY_TOOL]: {
    type: 'object',
    properties: { action: { type: 'string', enum: ['models', 'status'] } },
    required: ['action'],
    additionalProperties: false,
  },
  [AGENT_TYPE_TOOL]: {
    type: 'object',
    properties: {
      model: { type: 'string' },
      mode: { type: 'string', enum: ['read', 'write'], default: 'read' },
    },
    required: ['model'],
    additionalProperties: false,
  },
} as const

export const DISCOVERY_GUIDANCE = `Native model discovery for this session:
- This mod routes supplied provider models as native session models and standard Claude Code Agent integrations. Native agents keep Claude Code's tools, permissions and transcript; native routed compaction is unavailable and retains the original transcript without custom summarization or provider fallback; CLI workers run their own tool loops and must be identified as CLI workers.
- Discover the current catalogue and status on demand with ${DISCOVERY_TOOL} (action: models or status). Register a native Agent type for a supplied model with ${AGENT_TYPE_TOOL}; then use that exact type with the standard Agent tool. Registration does not start a worker. Standard Agent dispatch chooses effort and starts it.
- The Agent model field accepts aliases such as haiku, sonnet and opus, but that schema is not a provider restriction. Use the registered native type when selecting a supplied provider model.
- Codex login renewal or refresh is not a CLI worker. Antigravity (agy) and Grok are CLI-backed workers and must remain labelled as such.
- Catalogue entries are candidates, not proof of live entitlement. Every candidate remains subject to provider access, approval and current quota. Missing, stale or unavailable quota information is not unlimited capacity.
- Follow the user's provider and model restrictions for this session. Obey provider quota refusals. Never fall back to another provider implicitly or bypass provider approval.
- Each session startup refreshes supported provider catalogues. Discovery tools read that session snapshot; /rice-models refresh explicitly refreshes it. Do not query providers every turn. Reported metadata is not configured request policy; null means the source did not report the value.
- Discovered limits constrain this mod's requests where supported. For the main routed native-provider model, the mod synchronizes the supported process-local CLAUDE_CODE_MAX_CONTEXT_TOKENS override from fresh exact active contextWindow ?? maxContextWindow metadata for the native context meter and automatic compaction threshold. An existing explicit owner override remains authoritative. Unknown routes, discovery failure and session.end restore the value owned by the mod; ownership state survives hot reload. Unknown metadata does not establish provider capacity.
- Native routed compaction is unavailable because the host API does not expose the actual native summarizer request across all paths. No custom summarization or implicit provider fallback is used; native Claude compaction is unchanged when its model is known. A subagent with an unknown active model after reload refuses compaction until its next observed turn, rather than guessing a provider. Model switches exceeding fresh exact routed destination input/context bounds are denied without compaction. Unknown, stale, worker and native Claude destination bounds are not inferred; passing the guard is not proof of request fit.
- Claude Code 2.1.296's exposed plugin API still cannot register numeric per-model limits or capabilities. The process-global override does not establish independent custom-subagent windows; mixed custom models and restoration on plugin unload remain limitations. Picker metadata and behavesAs guesses do not solve those limitations.
- Local activation runs at session start with Node.js 22+: picker rows are synchronized while custom rows are preserved. Use /rice-models setup repair for a local recheck and /rice-models doctor for read-only diagnostics. /rice-models setup codex explicitly installs a scoped official CLI only; login remains an interactive terminal command, not a provider permission grant.`

export function withDiscoverySection(sections: readonly DiscoverySection[]): DiscoverySection[] {
  return [...sections.filter(section => section.id !== DISCOVERY_SECTION_ID), { id: DISCOVERY_SECTION_ID, text: DISCOVERY_GUIDANCE, scope: 'session' }]
}

export type CandidateRoute = {
  source: string
  execution: 'native provider' | 'CLI worker'
  identity: string
  codexSubscriptionQuota: boolean
}
export type CandidateModel = PickerRow & {
  source: string
  execution: 'native provider' | 'CLI worker'
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
    const provider = row.model.slice(0, row.model.indexOf('/'))
    const builtinWorker = provider === 'agy' || provider === 'grok'
    const resolved = routeFor?.(row.model)
    const execution = resolved?.execution ?? (builtinWorker ? 'CLI worker' : 'native provider')
    const routeIdentity = resolved?.identity ?? JSON.stringify({ execution, model: row.model })
    const source = resolved?.source ?? 'supplied model catalogue'
    const codexSubscriptionQuota = resolved?.codexSubscriptionQuota ?? false
    return [{ ...row, source, execution, routeIdentity, codexSubscriptionQuota }]
  })
}

export function discoveryInput(input: unknown): { action: 'models' | 'status' } | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined
  const value = input as Record<string, unknown>
  if (Object.keys(value).some(key => key !== 'action')) return undefined
  return value.action === 'models' || value.action === 'status' ? { action: value.action } : undefined
}

export function agentTypeInput(input: unknown): { model: string; mode: 'read' | 'write' } | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined
  const value = input as Record<string, unknown>
  if (Object.keys(value).some(key => !['model', 'mode'].includes(key))) return undefined
  if (typeof value.model !== 'string' || value.model.trim() !== value.model || value.model.length === 0) return undefined
  const mode = value.mode === undefined ? 'read' : value.mode
  return mode === 'read' || mode === 'write' ? { model: value.model, mode } : undefined
}

export function modelIsCandidate(model: string, models: readonly CandidateModel[]): boolean {
  return models.some(candidate => candidate.model === model)
}

export function modelExecution(model: string, models: readonly CandidateModel[]): 'native provider' | 'CLI worker' | undefined {
  return models.find(candidate => candidate.model === model)?.execution
}

export type RegisteredAgentSpec = { name: string; description: string; prompt: string; model: string; tools?: readonly string[] }

export function nativeAgentSpec(name: string, model: string, mode: 'read' | 'write'): RegisteredAgentSpec {
  const readOnly = mode === 'read'
  return {
    name,
    description: readOnly
      ? `A read-only native search subagent using ${model}; finds and reports without editing files.`
      : `A general-purpose native subagent using ${model}; inherits the caller's tools and permissions and may edit files.`,
    prompt: readOnly ? EXPLORE_PROMPT.replace('{SEARCH}', SEARCH_WITH_TOOLS) : GENERAL_PURPOSE_PROMPT,
    model,
    ...(readOnly ? { tools: ['Read', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch'] } : {}),
  }
}

export function workerAgentSpec(name: string, model: string, mode: 'read' | 'write', label: string): RegisteredAgentSpec {
  const can = mode === 'write' ? 'reads, runs its own tools and may edit files (accept-edits)' : 'reads and plans only (plan mode)'
  return {
    name,
    description: `Runs ${label} on ${model} as a CLI worker with its own tools; it ${can}.`,
    prompt: `You are ${label} working for a Claude Code session. Do the task you are given with your own tools, then answer with a complete report of what you found or changed; that report is all the caller reads.`,
    model,
    tools: [],
  }
}

export function reserveAgentType(registry: Map<string, string>, key: string, index: number): { name: string; index: number; reused: boolean } {
  const existing = registry.get(key)
  if (existing) return { name: existing, index, reused: true }

  let next = index
  let name: string
  do {
    name = `model-${next++}`
  } while ([...registry.values()].includes(name))
  registry.set(key, name)
  return { name, index: next, reused: false }
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
  return JSON.stringify({ models: entries, discovery: catalogue?.providers ?? [], providerApprovals: approvals, codexLimits: limit, compaction: { routed: 'unavailable', reason: 'host API does not expose the actual native summarizer request across all paths', customSummarization: false, providerFallback: false, nativeClaude: 'unchanged', unknownSubagent: 'skip compaction until its next observed turn identifies the model after reload', modelSwitchGuard: 'deny context exceeding fresh exact routed destination input/context bounds; unknown, stale, worker and native Claude bounds are not inferred; not proof of request fit' }, nativeContextRegistration: 'numeric per-model registration unsupported by the exposed Claude Code 2.1.296 plugin API; main routed native-provider model uses the supported process-local CLAUDE_CODE_MAX_CONTEXT_TOKENS override from fresh exact active contextWindow ?? maxContextWindow metadata for the native context meter and automatic compaction threshold; existing explicit owner override remains authoritative; unknown routes, discovery failure and session.end restore the value owned by the mod; ownership state survives hot reload; the process-global override does not establish independent custom-subagent windows; mixed custom models and restoration on plugin unload remain limitations' }, null, 2)
}
