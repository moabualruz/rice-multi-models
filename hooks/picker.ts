import type { ModelCatalogue } from './catalogue'

export type PickerRow = { model: string; label: string; description?: string; behavesAs?: string }

export function catalogueRows(catalogue: ModelCatalogue): PickerRow[] {
  return catalogue.models.map(({ model, label, execution, metadata }) => ({
    model,
    label,
    description: `${execution}; reported context ${metadata.contextWindow ?? 'unknown'}, input ${metadata.inputTokenLimit ?? 'unknown'}, output ${metadata.outputTokenLimit ?? 'unknown'}, maximum context ${metadata.maxContextWindow ?? 'unknown'}, auto-compact ${metadata.autoCompactTokenLimit ?? 'unknown'}; effort ${metadata.reasoningEfforts?.join('|') ?? 'unknown'}; modalities ${metadata.inputModalities?.join('|') ?? 'unknown'}; tools ${metadata.tools ?? 'unknown'}, parallel ${metadata.parallelToolCalls ?? 'unknown'}; native context registration unsupported`,
  }))
}

/** Claude's native per-model settings (`modelSettings.<id>`): only keys its own schema has. */
export type NativeModelSettings = { autoCompactWindow?: number; maxEffortLevel?: 'low' | 'medium' | 'high' }

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const windowOf = (value: number | null) => value !== null && Number.isSafeInteger(value) && value > 0 ? value : undefined

/** Configured aliases and the `provider/model` each names: Claude sees an alias as its own model id. */
export type AliasTargets = Readonly<Record<string, string>>

type Metadata = ModelCatalogue['models'][number]['metadata']

/** Every model id Claude can be given and its data: each catalogue model, and each alias with its target's. */
function nativeIds(catalogue: ModelCatalogue, aliases: AliasTargets): [string, Metadata][] {
  const byId = new Map(catalogue.models.map(({ model, metadata }) => [model, metadata] as [string, Metadata]))
  for (const [alias, target] of Object.entries(aliases)) {
    const metadata = byId.get(target)
    if (metadata) byId.set(alias, metadata)
  }
  return [...byId]
}

/**
 * Whether Claude reads an id as one of its own models, such as `opencode/claude-sonnet-4-6`: its
 * `modelSettings` resolve to that Claude model and Claude's own window data applies, so the mod leaves both alone.
 */
const namesClaudeModel = (id: string) => /claude-/i.test(id)

/** Each model's real window as its compaction window (Claude's range is 100000 to 1000000), and its top effort when it caps below xhigh. */
export function nativeModelSettings(catalogue: ModelCatalogue, aliases: AliasTargets = {}): Record<string, NativeModelSettings> {
  const settings: Record<string, NativeModelSettings> = {}
  for (const [id, metadata] of nativeIds(catalogue, aliases)) {
    if (namesClaudeModel(id)) continue
    const window = windowOf(metadata.contextWindow)
    const top = EFFORTS.filter(level => metadata.reasoningEfforts?.includes(level)).at(-1)
    const entry: NativeModelSettings = {
      ...(window !== undefined && window >= 100_000 && window <= 1_000_000 ? { autoCompactWindow: window } : {}),
      ...(top === 'low' || top === 'medium' || top === 'high' ? { maxEffortLevel: top } : {}),
    }
    if (Object.keys(entry).length) settings[id] = entry
  }
  return settings
}

/**
 * Claude's process environment for non-Claude models: the largest reported window among the ids it applies
 * to, which each model's own `autoCompactWindow` then lowers to its real size, and each id's effort levels in
 * Claude's capability syntax (matched to the exact id). Unknown data adds nothing, so Claude's native defaults stay.
 */
export function nativeModelEnv(catalogue: ModelCatalogue, aliases: AliasTargets = {}): Record<string, string> {
  const ids = nativeIds(catalogue, aliases)
  const windows = ids.flatMap(([id, metadata]) => namesClaudeModel(id) ? [] : windowOf(metadata.contextWindow) ?? [])
  const capabilities = ids.flatMap(([id, { reasoningEfforts: efforts }]) => {
    if (efforts === null) return []
    return [`${id}=${efforts.length === 0 ? '-effort' : ['effort', efforts.includes('xhigh') ? 'xhigh_effort' : '-xhigh_effort', efforts.includes('max') ? 'max_effort' : '-max_effort'].join(',')}`]
  })
  return {
    ...(windows.length ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(Math.max(...windows)) } : {}),
    ...(capabilities.length ? { CLAUDE_CODE_MODEL_CAPABILITIES: capabilities.join(';') } : {}),
  }
}

/** The picker's rows with every routed row replaced by `ours`, the person's own rows kept first. */
export function mergeRows(existing: unknown, ours: readonly PickerRow[], isRouted: (model: string) => boolean): unknown[] {
  const kept = (Array.isArray(existing) ? existing : []).filter(row => {
    const model = (row as { model?: unknown } | null)?.model

    return typeof model !== 'string' || !isRouted(model)
  })

  return [...kept, ...ours]
}
