// The `/model` picker rows for routed models (Claude Code's `modelPicker` setting): Codex models from the Codex
// CLI's cache, every declared provider's models, and the worker CLIs' models. `behavesAs` lends each row a
// known model's capabilities (the effort control) without changing the id that is sent. Rows the person wrote
// themselves are kept when the routed ones are written. Pure.
import type { Config } from './config'

export type PickerRow = { model: string; label: string; description?: string; behavesAs?: string }

export const BEHAVES_AS = 'claude-sonnet-4-6'

type CodexCache = { models?: { slug?: string; display_name?: string; context_window?: number; visibility?: string }[] }

const window = (tokens: number | undefined) => (tokens ? `, ${Math.round(tokens / 1000)}k context` : '')

export function codexRows(cache: CodexCache): PickerRow[] {
  return (cache.models ?? [])
    .filter(model => model.slug && model.visibility !== 'hide')
    .map(model => ({
      model: `codex/${model.slug}`,
      label: `${model.display_name ?? model.slug} (Codex)`,
      description: `ChatGPT subscription via rice-multi-models${window(model.context_window)}`,
      behavesAs: BEHAVES_AS,
    }))
}

export function providerRows(config: Config | undefined): PickerRow[] {
  if (!config) return []

  return Object.values(config.providers).flatMap(provider =>
    Object.entries(provider.models).map(([id, model]) => ({
      model: `${provider.id}/${id}`,
      label: `${id} (${provider.id})`,
      description: `${model.kind} endpoint ${provider.origin} via rice-multi-models${window(model.contextWindow)}`,
      behavesAs: BEHAVES_AS,
    })),
  )
}

export function workerRows(worker: string, label: string, models: readonly string[]): PickerRow[] {
  return models.map(model => ({ model: `${worker}/${model}`, label: `${model} (${label})`, description: `${label} CLI as a worker with its own tools, via rice-multi-models`, behavesAs: BEHAVES_AS }))
}

/** `agy models` output: one `<id>\t<name>` per line after its header. */
export function agyModelIds(output: string): string[] {
  return output
    .split('\n')
    .map(line => line.split('\t')[0]?.trim() ?? '')
    .filter(id => /^[a-z0-9][a-z0-9.-]+$/.test(id))
}

/** The picker's rows with every routed row replaced by `ours`, the person's own rows kept first. */
export function mergeRows(existing: unknown, ours: readonly PickerRow[], isRouted: (model: string) => boolean): unknown[] {
  const kept = (Array.isArray(existing) ? existing : []).filter(row => {
    const model = (row as { model?: unknown } | null)?.model

    return typeof model !== 'string' || !isRouted(model)
  })

  return [...kept, ...ours]
}
