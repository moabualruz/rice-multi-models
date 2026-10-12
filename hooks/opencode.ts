// OpenCode Zen (pay as you go) and OpenCode Go (subscription) as declared providers. One OpenCode console key
// serves both; each gateway serves a model in its maker's protocol (Chat Completions, Responses, Anthropic
// Messages or Gemini), which the model's own `kind` names. The model list is the gateway's own (`/models`);
// each model's protocol and limits come from the models.dev catalog that OpenCode itself reads, by its AI SDK
// package. A model the catalog does not hold, retired or without tool calls is left out. Pure.
import type { Kind } from './config'

type Json = Record<string, unknown>

export type Tier = 'zen' | 'go'
export const TIERS: Readonly<Record<Tier, { id: string; label: string; base: string; keys: readonly [string, string] }>> = {
  zen: { id: 'opencode', label: 'OpenCode Zen', base: 'https://opencode.ai/inference/v1', keys: ['opencode', 'opencode-go'] },
  go: { id: 'opencode-go', label: 'OpenCode Go', base: 'https://opencode.ai/inference/go/v1', keys: ['opencode-go', 'opencode'] },
}
export const CATALOG_URL = 'https://models.dev/api.json'
// Claude Code's own default output cap; it bounds what an anthropic-kind request reserves from the window.
const OUTPUT_CAP = 32_000
const KIND_OF_PACKAGE: Readonly<Record<string, Kind>> = { '@ai-sdk/openai': 'responses', '@ai-sdk/anthropic': 'anthropic', '@ai-sdk/google': 'gemini' }
const level = (kind: Kind, effort: string): Json | undefined =>
  kind === 'responses' ? { reasoning: { effort } } : kind === 'gemini' ? { generationConfig: { thinkingConfig: { thinkingLevel: effort } } } : undefined

const isJson = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined)

/** The ids a gateway's `/models` answer lists. */
export function liveIds(text: string): string[] {
  try {
    const data = (JSON.parse(text) as { data?: unknown }).data

    return Array.isArray(data) ? data.flatMap(m => (isJson(m) && typeof m['id'] === 'string' ? [m['id']] : [])) : []
  } catch {
    return []
  }
}

/** One model's declaration from its catalog entry, or why it is left out. */
export function modelOf(entry: unknown): { model: Json } | { skip: string } {
  if (!isJson(entry)) return { skip: 'not in the models.dev catalog' }
  if (entry['status'] === 'deprecated') return { skip: 'retired' }
  if (entry['tool_call'] !== true) return { skip: 'no tool calls' }
  const limit = isJson(entry['limit']) ? entry['limit'] : {}
  const context = count(limit['context'])
  if (context === undefined) return { skip: 'no context window in the catalog' }
  const input = count(limit['input'])
  const output = Math.min(count(limit['output']) ?? OUTPUT_CAP, OUTPUT_CAP, Math.floor(context / 2))
  const pkg = isJson(entry['provider']) ? entry['provider']['npm'] : undefined
  const kind = (typeof pkg === 'string' ? KIND_OF_PACKAGE[pkg] : undefined) ?? 'openai'
  const modalities = isJson(entry['modalities']) ? entry['modalities']['input'] : undefined
  const reasons = entry['reasoning'] === true
  const params = !reasons ? undefined : kind === 'responses' ? { reasoning: { summary: 'auto' } } : kind === 'gemini' ? { generationConfig: { thinkingConfig: { includeThoughts: true } } } : undefined
  const levels = kind === 'gemini' ? ['low', 'high'] : ['low', 'medium', 'high']
  const effort = reasons && level(kind, 'low') ? Object.fromEntries(levels.map(l => [l, level(kind, l)])) : undefined

  return {
    model: {
      ...(kind === 'openai' ? {} : { kind }),
      contextWindow: context,
      ...(input !== undefined && input < context ? { maxInputTokens: input } : {}),
      maxOutputTokens: output,
      ...(Array.isArray(modalities) && !modalities.includes('image') ? { vision: false } : {}),
      ...(params ? { params } : {}),
      ...(effort ? { effort } : {}),
    },
  }
}

/**
 * The provider for `tier`: the gateway's listed models found in the catalog, its key read from OpenCode's
 * auth file by jq (the tier's own entry, else the other's: one console key serves both), and the session
 * header the gateway routes by. `skipped` names each listed model left out, and why.
 */
export function opencodeProvider(tier: Tier, catalog: unknown, live: readonly string[], jq: string, authFile: string): { provider: Json; skipped: string[] } {
  const t = TIERS[tier]
  const entry = isJson(catalog) ? catalog[t.id] : undefined
  const known = isJson(entry) && isJson(entry['models']) ? entry['models'] : {}
  const models: Json = {}
  const skipped: string[] = []
  for (const id of [...new Set(live)].sort()) {
    const made = modelOf(Object.hasOwn(known, id) ? known[id] : undefined)
    if ('skip' in made) skipped.push(`${id} (${made.skip})`)
    else models[id] = made.model
  }
  const [mine, other] = t.keys

  return {
    provider: {
      kind: 'openai',
      baseUrl: t.base,
      auth: { command: [jq, '-r', `(.["${mine}"] // .["${other}"] | .key) // empty`, authFile] },
      sessionHeader: 'x-opencode-session',
      headers: { 'x-opencode-client': 'rice-multi-models' },
      models,
    },
    skipped,
  }
}

/** A one-line count of a provider's models by kind. */
export function kindCounts(provider: Json): string {
  const counts = new Map<string, number>()
  for (const model of Object.values(isJson(provider['models']) ? provider['models'] : {})) {
    const kind = isJson(model) && typeof model['kind'] === 'string' ? model['kind'] : 'openai'
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }

  return [...counts].map(([kind, n]) => `${n} ${kind}`).join(', ')
}
