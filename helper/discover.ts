import type { ModelCatalogue } from '../hooks/catalogue.ts'
import { unknownMetadata } from '../hooks/catalogue.ts'
import type { Wire } from '../hooks/protocol.ts'
import { parseConfig } from '../hooks/config.ts'
import { discoverCodex } from './codex-catalog.ts'
import { discoverProviders } from './provider-catalog.ts'
import { setupInfo } from './setup-info.ts'
import { startProcess } from './core/subprocess.ts'

export function workerModelIds(provider: 'agy' | 'grok', output: string): string[] | null {
  const text = output.replace(/\x1b\[[0-9;]*m/g, '')
  if (/not authenticated|not logged in|login required/i.test(text)) return null
  const lines = text.split(/\r?\n/)
  const listed = provider === 'grok' ? lines.slice(lines.findIndex(line => line.trim() === 'Available models:') + 1) : lines
  if (provider === 'grok' && !lines.some(line => line.trim() === 'Available models:')) return null
  const ids = listed.flatMap(line => {
    const id = (provider === 'agy' ? line.split('\t')[0] : line.replace(/\s+\(default\)\s*$/, '')).trim()
    return /^[a-z0-9][a-z0-9._:-]{1,199}$/.test(id) ? [id] : []
  })
  return ids.length ? [...new Set(ids)] : null
}

async function workerCatalogue(provider: 'agy' | 'grok', executable: string | undefined, signal: AbortSignal): Promise<ModelCatalogue> {
  const source = `${provider} models CLI`
  const unavailable = (error: string): ModelCatalogue => ({ models: [], providers: [{ provider, status: 'unavailable', source, error }] })
  if (!executable) return unavailable('cli-unavailable')
  let running: ReturnType<typeof startProcess> | undefined
  const stop = () => running?.stop()
  signal.addEventListener('abort', stop, { once: true })
  try {
    signal.throwIfAborted()
    running = startProcess([executable, 'models'])
    if (signal.aborted) stop()
    let text = ''
    for await (const chunk of running.child.stdout) {
      text += String(chunk)
      if (Buffer.byteLength(text) > 1024 * 1024) return unavailable('protocol-too-large')
      signal.throwIfAborted()
    }
    const code = await running.exited
    signal.throwIfAborted()
    if (code !== 0) return unavailable(`cli-exit-${code}`)
    const ids = workerModelIds(provider, text)
    if (!ids) return unavailable('model-list-unavailable')
    const observedAt = Date.now()
    return { models: ids.map(id => ({ model: `${provider}/${id}`, label: `${id} (${provider})`, execution: 'CLI worker', source, observedAt, metadata: unknownMetadata() })), providers: [{ provider, status: 'fresh', source, observedAt }] }
  } catch { return unavailable(signal.aborted ? 'deadline-or-cancellation' : 'discovery-failed') } finally {
    signal.removeEventListener('abort', stop)
    if (running?.child.exitCode === null) { running.stop(); await running.exited.catch(() => {}) }
  }
}

export async function discover(wire: Wire, lifetime?: AbortSignal): Promise<ModelCatalogue> {
  const signal = AbortSignal.any([AbortSignal.timeout(10_000), ...(lifetime ? [lifetime] : [])])
  const config = parseConfig(wire.configText || '{"providers":{}}').config
  const info = await setupInfo()
  const tasks: Promise<ModelCatalogue>[] = [discoverProviders(wire, { signal, timeoutMs: 8000 })]
  if (!config?.providers.codex) tasks.push(discoverCodex({ signal }))
  for (const provider of ['agy', 'grok'] as const) if (!config?.providers[provider]) tasks.push(workerCatalogue(provider, info.clis[provider], signal))
  const results = await Promise.all(tasks)
  return { models: results.flatMap(result => result.models), providers: results.flatMap(result => result.providers) }
}
