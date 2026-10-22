// A session's discovered facts over its configured request policies. Pure: no source file is changed.
import { isObject, own, parseConfig } from './config'
import type { ModelCatalogue } from './catalogue'
import type { Loaded } from './providers'

type Json = Record<string, unknown>
const limit = (value: number | null): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined

/** Derive helper configText from a fresh session snapshot, preserving auth and request params verbatim. */
export function runtimeConfig(loaded: Loaded, catalogue: ModelCatalogue): Loaded {
  if (loaded.config === undefined) return loaded
  // Use the validated source, not normalized ModelConfig defaults: protocol-specific keys stay absent.
  const raw: Json = JSON.parse(loaded.text)
  const providers = raw['providers']
  if (!isObject(providers)) return loaded
  const fresh = new Set(catalogue.providers.filter(provider => provider.status === 'fresh').map(provider => provider.provider))
  for (const discovered of catalogue.models) {
    if (discovered.execution !== 'native provider') continue
    const slash = discovered.model.indexOf('/')
    if (slash <= 0) continue
    const pid = discovered.model.slice(0, slash)
    const mid = discovered.model.slice(slash + 1)
    const provider = own(providers, pid)
    if (mid === '' || !fresh.has(pid) || !isObject(provider) || own(loaded.config.providers, pid) === undefined) continue
    const models: Json = isObject(provider['models']) ? provider['models'] : {}
    const declared = own(models, mid)
    const model: Json = isObject(declared) ? { ...declared } : {}
    const metadata = discovered.metadata
    const active = limit(metadata.contextWindow)
    const maximum = limit(metadata.maxContextWindow)
    // The advertised maximum only caps an active or explicitly configured window. It never
    // supplies an active window on its own, or enlarges one.
    const configuredContext = limit(model['contextWindow'] as number | null)
    const context = active !== undefined
      ? Math.min(active, maximum ?? Infinity)
      : configuredContext !== undefined && maximum !== undefined ? Math.min(configuredContext, maximum) : configuredContext
    const input = limit(metadata.inputTokenLimit)
    const output = limit(metadata.outputTokenLimit)
    if (context !== undefined) model['contextWindow'] = context
    if (input !== undefined) model['maxInputTokens'] = input
    // A discovered input limit cannot exceed the effective active context.
    if (typeof model['contextWindow'] === 'number' && typeof model['maxInputTokens'] === 'number') model['maxInputTokens'] = Math.min(model['maxInputTokens'], model['contextWindow'])
    if (output !== undefined) model['maxOutputTokens'] = typeof model['maxOutputTokens'] === 'number' ? Math.min(model['maxOutputTokens'], output) : output
    // Provider support only removes capabilities. It never enables a user-denied feature or allowlist.
    if (metadata.tools === false) model['tools'] = false
    if (metadata.parallelToolCalls === false && ['openai', 'responses', 'anthropic'].includes(String(model['kind'] ?? provider['kind']))) model['parallelToolCalls'] = false
    if (metadata.inputModalities !== null && !metadata.inputModalities.includes('image')) model['vision'] = false
    Object.defineProperty(models, mid, { value: model, enumerable: true, writable: true, configurable: true })
    provider['models'] = models
  }
  const text = JSON.stringify(raw)
  const parsed = parseConfig(text)
  return { ...loaded, text: parsed.config === undefined ? '' : text, config: parsed.config, errors: parsed.errors }
}
