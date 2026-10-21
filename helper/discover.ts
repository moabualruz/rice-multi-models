import type { ModelCatalogue } from '../hooks/catalogue.ts'
import type { Wire } from '../hooks/protocol.ts'
import { parseConfig } from '../hooks/config.ts'
import { discoverCodex } from './codex-catalog.ts'
import { discoverProviders } from './provider-catalog.ts'

export async function discover(wire: Wire, lifetime?: AbortSignal): Promise<ModelCatalogue> {
  const signal = AbortSignal.any([AbortSignal.timeout(10_000), ...(lifetime ? [lifetime] : [])])
  const config = parseConfig(wire.configText || '{"providers":{}}').config
  const tasks: Promise<ModelCatalogue>[] = [discoverProviders(wire, { signal, timeoutMs: 8000 })]
  if (!config?.providers.codex) tasks.push(discoverCodex({ signal }))
  const results = await Promise.all(tasks)
  return { models: results.flatMap(result => result.models), providers: results.flatMap(result => result.providers) }
}
