import type { ModelCatalogue } from './catalogue'

export type PickerRow = { model: string; label: string; description?: string; behavesAs?: string }

export function catalogueRows(catalogue: ModelCatalogue): PickerRow[] {
  return catalogue.models.map(({ model, label, execution, metadata }) => ({
    model,
    label,
    description: `${execution}; reported context ${metadata.contextWindow ?? 'unknown'}, input ${metadata.inputTokenLimit ?? 'unknown'}, output ${metadata.outputTokenLimit ?? 'unknown'}, maximum context ${metadata.maxContextWindow ?? 'unknown'}, auto-compact ${metadata.autoCompactTokenLimit ?? 'unknown'}; effort ${metadata.reasoningEfforts?.join('|') ?? 'unknown'}; modalities ${metadata.inputModalities?.join('|') ?? 'unknown'}; tools ${metadata.tools ?? 'unknown'}, parallel ${metadata.parallelToolCalls ?? 'unknown'}; native context registration unsupported`,
  }))
}

/** The picker's rows with every routed row replaced by `ours`, the person's own rows kept first. */
export function mergeRows(existing: unknown, ours: readonly PickerRow[], isRouted: (model: string) => boolean): unknown[] {
  const kept = (Array.isArray(existing) ? existing : []).filter(row => {
    const model = (row as { model?: unknown } | null)?.model

    return typeof model !== 'string' || !isRouted(model)
  })

  return [...kept, ...ours]
}
