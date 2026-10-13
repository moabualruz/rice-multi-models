// OpenCode Zen (pay as you go) and OpenCode Go (subscription) as declared providers. One OpenCode console key
// serves both; each gateway serves a model in its maker's protocol (Chat Completions, Responses, Anthropic
// Messages or Gemini), which the model's own `kind` names. The model list is the gateway's own (`/models`);
// each model's protocol and limits come from the models.dev catalog that OpenCode itself reads, by its AI SDK
// package. Models absent from the catalog, retired, without tool calls, or without a supported reported SDK
// are left out. Unknown limits stay absent; a reasoning boolean does not establish supported effort levels. Pure.
import type { Kind } from './config'

type Json = Record<string, unknown>

export type Tier = 'zen' | 'go'
export const TIERS: Readonly<Record<Tier, { id: string; label: string; base: string; keys: readonly [string, string] }>> = {
  zen: { id: 'opencode', label: 'OpenCode Zen', base: 'https://opencode.ai/inference/v1', keys: ['opencode', 'opencode-go'] },
  go: { id: 'opencode-go', label: 'OpenCode Go', base: 'https://opencode.ai/inference/go/v1', keys: ['opencode-go', 'opencode'] },
}
export const CATALOG_URL = 'https://models.dev/api.json'
// Only explicitly reported SDK packages select a protocol. models.dev declares openai-compatible at the
// provider level for Zen and Go; a model's provider.npm overrides that declaration when present.
const KIND_OF_PACKAGE: Readonly<Record<string, Kind>> = {
  '@ai-sdk/openai-compatible': 'openai',
  '@ai-sdk/openai': 'responses',
  '@ai-sdk/anthropic': 'anthropic',
  '@ai-sdk/google': 'gemini',
}

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

/** Catalog facts only. providerPackage is the enclosing catalog provider's explicitly reported npm. */
export function modelOf(entry: unknown, providerPackage?: unknown): { model: Json } | { skip: string } {
  if (!isJson(entry)) return { skip: 'not in the models.dev catalog' }
  if (entry['status'] === 'deprecated') return { skip: 'retired' }
  if (entry['tool_call'] !== true) return { skip: 'no tool calls' }
  const provider = entry['provider']
  const pkg = isJson(provider) && Object.hasOwn(provider, 'npm') ? provider['npm'] : providerPackage
  if (typeof pkg !== 'string' || !Object.hasOwn(KIND_OF_PACKAGE, pkg)) return { skip: 'no supported protocol SDK package in the catalog' }
  const kind = KIND_OF_PACKAGE[pkg]!
  const limit = isJson(entry['limit']) ? entry['limit'] : {}
  const context = count(limit['context'])
  const input = count(limit['input'])
  const output = count(limit['output'])
  const modalities = isJson(entry['modalities']) ? entry['modalities']['input'] : undefined
  const inputModalities = Array.isArray(modalities) && modalities.length > 0 && modalities.every(v => typeof v === 'string') ? modalities : undefined

  return {
    model: {
      ...(kind === 'openai' ? {} : { kind }),
      ...(context !== undefined ? { contextWindow: context } : {}),
      ...(input !== undefined && (context === undefined || input <= context) ? { maxInputTokens: input } : {}),
      ...(output !== undefined ? { maxOutputTokens: output } : {}),
      ...(inputModalities ? { vision: inputModalities.includes('image') } : {}),
    },
  }
}

/**
 * The provider for `tier`: the gateway's listed models found in the catalog, its key read from OpenCode's
 * auth file by the shipped Node helper (tier first, then the other's: one console key serves both), and the session
 * header the gateway routes by. `skipped` names each listed model left out, and why.
 */
export function opencodeProvider(tier: Tier, catalog: unknown, live: readonly string[], node: string, authFile: string, helper: string): { provider: Json; skipped: string[] } {
  const t = TIERS[tier]
  const entry = isJson(catalog) ? catalog[t.id] : undefined
  const known = isJson(entry) && isJson(entry['models']) ? entry['models'] : {}
  const providerPackage = isJson(entry) ? entry['npm'] : undefined
  const models: Json = {}
  const skipped: string[] = []
  for (const id of [...new Set(live)].sort()) {
    const made = modelOf(Object.hasOwn(known, id) ? known[id] : undefined, providerPackage)
    if ('skip' in made) skipped.push(`${id} (${made.skip})`)
    else models[id] = made.model
  }
  return {
    provider: {
      kind: 'openai',
      baseUrl: t.base,
      auth: { command: [node, helper, 'opencode-key', tier, authFile] },
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
