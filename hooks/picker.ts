import type { ModelCatalogue } from './catalogue'
import type { LoadedWindows } from '../types'

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
 * Whether Claude reads an id as one of its own models: an id naming a Claude family and version anywhere, such
 * as `opencode/claude-sonnet-4-6`, resolves to that model in Claude's `modelSettings` and gets Claude's own
 * window data, so the mod leaves both alone. Any other id, `my-claude-route` included, stays its own.
 */
const namesClaudeModel = (id: string) => /claude-(?:opus|sonnet|haiku|fable|mythos)-\d|claude-\d(?:-\d)?-(?:opus|sonnet|haiku)/i.test(id)

/** Whether Claude takes a window as a per-model `autoCompactWindow`. */
const perModelWindow = (window: number) => window >= 100_000 && window <= 1_000_000

/**
 * The fold Claude makes over its settings sources, lowest precedence first, when it launches: a source's
 * per-model windows join those below it, and a source with its own top-level `autoCompactWindow` replaces
 * them and the default.
 */
export function loadedWindowsOf(sources: readonly unknown[]): LoadedWindows {
  const windowSetting = (value: unknown) => value === 'auto' || (typeof value === 'number' && Number.isSafeInteger(value)) ? value as number | 'auto' : undefined
  let loaded: LoadedWindows = { byModel: {} }
  for (const source of sources) {
    const settings = typeof source === 'object' && source !== null ? source as Record<string, unknown> : {}
    const entries = typeof settings.modelSettings === 'object' && settings.modelSettings !== null ? Object.entries(settings.modelSettings) : []
    const own: Record<string, number | 'auto'> = {}
    for (const [id, entry] of entries) {
      const window = windowSetting((entry as { autoCompactWindow?: unknown } | null)?.autoCompactWindow)
      const key = id.toLowerCase()
      if (window !== undefined && (id === key || !Object.hasOwn(own, key))) own[key] = window
    }
    const top = windowSetting(settings.autoCompactWindow)
    loaded = top === undefined ? { ...loaded, byModel: { ...loaded.byModel, ...own } } : { byModel: own, default: top }
  }
  return loaded
}

/** Each model's real window as its compaction window (Claude's range is 100000 to 1000000), and its top effort when it caps below xhigh. */
export function nativeModelSettings(catalogue: ModelCatalogue, aliases: AliasTargets = {}): Record<string, NativeModelSettings> {
  const settings: Record<string, NativeModelSettings> = {}
  for (const [id, metadata] of nativeIds(catalogue, aliases)) {
    if (namesClaudeModel(id)) continue
    const window = windowOf(metadata.contextWindow)
    const top = EFFORTS.filter(level => metadata.reasoningEfforts?.includes(level)).at(-1)
    const entry: NativeModelSettings = {
      ...(window !== undefined && perModelWindow(window) ? { autoCompactWindow: window } : {}),
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
 *
 * Claude loads per-model windows when it launches (`loaded`, see loadedWindowsOf), so one written later
 * applies from its next launch: until then a model without a loaded window at or below its own bounds the largest.
 */
export function nativeModelEnv(catalogue: ModelCatalogue, aliases: AliasTargets = {}, loaded: LoadedWindows = { byModel: {} }): Record<string, string> {
  const ids = nativeIds(catalogue, aliases)
  const windows = ids.flatMap(([id, metadata]) => namesClaudeModel(id) ? [] : windowOf(metadata.contextWindow) ?? [])
  const unloaded = ids.flatMap(([id, metadata]) => {
    const window = windowOf(metadata.contextWindow)
    if (namesClaudeModel(id) || window === undefined || !perModelWindow(window)) return []
    const key = id.toLowerCase()
    const own = Object.hasOwn(loaded.byModel, key) ? loaded.byModel[key] : loaded.default
    return typeof own === 'number' && own <= window ? [] : [window]
  })
  const capabilities = ids.flatMap(([id, { reasoningEfforts: efforts }]) => {
    if (efforts === null) return []
    return [`${id}=${efforts.length === 0 ? '-effort' : ['effort', efforts.includes('xhigh') ? 'xhigh_effort' : '-xhigh_effort', efforts.includes('max') ? 'max_effort' : '-max_effort'].join(',')}`]
  })
  return {
    ...(windows.length ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(Math.min(Math.max(...windows), ...unloaded)) } : {}),
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
