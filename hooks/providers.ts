// Providers declared in `rice-multi-models.json` (Claude Code's config directory): OpenAI-style, Anthropic-
// style and Bedrock endpoints, validated by claude-styx's parser. A model id `<provider>/<model>`, or an alias,
// routes to one once its provider is approved: its address and key command, as a fingerprint kept in
// `$.store`, so a changed address or command asks again. Pure.
import { fingerprint, inputBudget, parseConfig } from './config'
import type { Config, ModelConfig, ProviderConfig } from './config'
import { resolve } from './names'

export const CONFIG_FILE = 'rice-multi-models.json'
export const TRUST_PREFIX = 'trust:'

/**
 * The config as last read: its text (empty when there is none or it does not validate) and its errors.
 * `claimed` names the provider ids and aliases a file that does not validate still declares, so their
 * models are refused rather than sent to Claude under a provider-prefixed id.
 */
export type Loaded = { path: string; text: string; config?: Config; errors: string[]; claimed?: readonly string[] }

export function emptyLoaded(path: string): Loaded {
  return { path, text: '', errors: [] }
}

/** A file's text validated whole: any error leaves no provider routed, and the errors say why. */
export function loadText(path: string, text: string): Loaded {
  const parsed = parseConfig(text)

  return parsed.config ? { path, text, config: parsed.config, errors: [] } : { path, text: '', errors: parsed.errors, claimed: claimedNames(text) }
}

function claimedNames(text: string): string[] {
  try {
    const raw: unknown = JSON.parse(text)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
    const names = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : []
    return [...names((raw as Record<string, unknown>).providers), ...names((raw as Record<string, unknown>).aliases)]
  } catch {
    return []
  }
}

/** What a model name routes to among the declared providers, with the model's input budget. */
export type Remote = { provider: ProviderConfig; model: ModelConfig; modelId: string; target: string; budget: number | null; fingerprint: string }

export function remoteOf(loaded: Loaded, name: string): Remote | undefined {
  if (!loaded.config) return undefined
  const target = resolve(loaded.config, name)
  if (target?.kind !== 'remote') return undefined

  return {
    provider: target.provider,
    model: target.model,
    modelId: target.target.slice(target.provider.id.length + 1),
    target: target.target,
    budget: inputBudget(target.model),
    fingerprint: fingerprint(target.provider),
  }
}

/** The approval question: where the conversation goes and how its key is read. */
export function approvalQuestion(provider: ProviderConfig): string {
  const key = provider.auth === 'none' ? 'no key' : `the key printed by ${provider.auth.command.join(' ')}`
  const plain = provider.baseUrl.startsWith('http:') ? ' over plain http (readable on the network path)' : ''

  return `Send conversations for ${provider.id} models to ${provider.origin}${plain}, with ${key}?`
}

/** A request's rough size in tokens, for the budget check before it is sent. */
export function estimateTokens(request: unknown): number {
  return Math.ceil(JSON.stringify(request).length / 3.5)
}

/** One line per declared provider: its models' kinds, address, models, and whether it is approved. */
export function providerLines(loaded: Loaded, approved: ReadonlySet<string>): string[] {
  if (!loaded.config) return loaded.errors.length > 0 ? [`${loaded.path}: ${loaded.errors.join('; ')}`] : [`no ${CONFIG_FILE} (see example.rice-multi-models.json in the plugin)`]

  return Object.values(loaded.config.providers).map(provider => {
    const models = Object.keys(provider.models).map(model => `${provider.id}/${model}`)

    const kinds = [...new Set(Object.values(provider.models).map(model => model.kind))].join('+')

    return `${provider.id}: ${kinds} at ${provider.baseUrl}, ${approved.has(fingerprint(provider)) ? 'approved' : `not approved (/rice-models approve ${provider.id})`}; ${models.join(', ')}`
  })
}
