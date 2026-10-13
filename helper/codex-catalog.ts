// Fresh Codex metadata only: never infer availability or limits from a native cache or bundled list.
import { unknownMetadata } from '../hooks/catalogue.ts'
import type { DiscoveredModel, ModelCatalogue, ModelMetadata } from '../hooks/catalogue.ts'
import { codexAuthFile } from './codex.ts'
import { CodexAuthError, codexRequest } from './openai/auth.ts'
import { isRecord } from './core/record.ts'
import { startProcess } from './core/subprocess.ts'
import { setupInfo } from './setup-info.ts'

const SOURCE = 'Codex authenticated models endpoint'
const MODELS_URL = 'https://chatgpt.com/backend-api/codex/models'
const MAX_BODY_BYTES = 4 * 1024 * 1024

export type CodexCatalogueOptions = {
  signal?: AbortSignal
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  /** Local test endpoint; production discovery always uses the Codex backend. */
  url?: string
}

class CatalogueFailure extends Error {}
const positiveTokens = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
const strings = (value: unknown): string[] | null => Array.isArray(value) && value.every(item => typeof item === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(item)) ? [...new Set(value)] : null

function metadataOf(model: Record<string, unknown>): ModelMetadata {
  const metadata = unknownMetadata()
  metadata.contextWindow = positiveTokens(model.context_window)
  metadata.maxContextWindow = positiveTokens(model.max_context_window)
  metadata.autoCompactTokenLimit = positiveTokens(model.auto_compact_token_limit)
  const percent = model.effective_context_window_percent
  if (metadata.contextWindow !== null && typeof percent === 'number' && Number.isInteger(percent) && percent > 0 && percent <= 100) {
    metadata.inputTokenLimit = Math.floor(metadata.contextWindow * (percent / 100))
  }
  metadata.inputModalities = strings(model.input_modalities)
  if (Array.isArray(model.supported_reasoning_levels) && model.supported_reasoning_levels.every(level => isRecord(level) && typeof level.effort === 'string')) {
    metadata.reasoningEfforts = strings(model.supported_reasoning_levels.map(level => (level as Record<string, unknown>).effort))
  }
  // ModelInfo reports neither a maximum output limit nor generic tools/parallel-tools flags.
  // Tool truncation limits and experimental tool names are not those capabilities.
  return metadata
}

function modelsOf(payload: unknown, observedAt: number): DiscoveredModel[] {
  if (!isRecord(payload) || !Array.isArray(payload.models)) throw new CatalogueFailure('protocol-invalid')
  const models: DiscoveredModel[] = []
  const seen = new Set<string>()
  for (const raw of payload.models) {
    if (!isRecord(raw) || typeof raw.slug !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(raw.slug) || !['list', 'hide', 'none'].includes(String(raw.visibility))) throw new CatalogueFailure('protocol-invalid')
    if (raw.visibility !== 'list') continue
    if (seen.has(raw.slug)) throw new CatalogueFailure('protocol-invalid')
    seen.add(raw.slug)
    const label = typeof raw.display_name === 'string' && raw.display_name.length > 0 && raw.display_name.length <= 200 && !/[\u0000-\u001f\u007f]/.test(raw.display_name) ? raw.display_name : raw.slug
    models.push({ model: `codex/${raw.slug}`, label: `${label} (Codex)`, execution: 'native provider', source: SOURCE, observedAt, metadata: metadataOf(raw) })
  }
  return models
}

async function installedVersion(executable: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const argv = executable.endsWith('.js') ? [process.execPath, executable, '--version'] : [executable, '--version']
  const running = startProcess(argv)
  const stop = () => running.stop()
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted) stop()
  try {
    let stdout = ''
    for await (const chunk of running.child.stdout) {
      stdout += String(chunk)
      if (Buffer.byteLength(stdout) > 4096) throw new CatalogueFailure('cli-version-invalid')
      signal.throwIfAborted()
    }
    const code = await running.exited
    signal.throwIfAborted()
    const version = /^codex-cli (\d+\.\d+\.\d+)(?:[-+][a-zA-Z0-9.-]+)?\s*$/.exec(stdout)?.[1]
    if (code !== 0 || !version) throw new CatalogueFailure('cli-version-invalid')
    return version
  } finally {
    signal.removeEventListener('abort', stop)
    if (running.child.exitCode === null) running.stop()
  }
}

async function payloadOf(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new CatalogueFailure('protocol-invalid')
  const reader = response.body.getReader()
  let bytes = 0
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_BODY_BYTES) throw new CatalogueFailure('protocol-too-large')
      chunks.push(chunk.value)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown } catch { throw new CatalogueFailure('protocol-invalid') }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** Every invocation contacts the authenticated models endpoint under one startup deadline. */
export async function discoverCodex(options: CodexCatalogueOptions = {}): Promise<ModelCatalogue> {
  const controller = new AbortController()
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 8000, 30000))
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  const signal = controller.signal
  let rejectAbort: () => void = () => {}
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(new CatalogueFailure(timedOut ? 'deadline-exceeded' : 'cancelled'))
    signal.addEventListener('abort', rejectAbort, { once: true })
    if (signal.aborted) rejectAbort()
  })
  try {
    const discover = async (): Promise<ModelCatalogue> => {
      signal.throwIfAborted()
      const env = options.env ?? process.env
      const info = await setupInfo(env)
      signal.throwIfAborted()
      if (!info.clis.codex) throw new CatalogueFailure('cli-unavailable')
      const version = await installedVersion(info.clis.codex, signal)
      const url = new URL(options.url ?? MODELS_URL)
      url.searchParams.set('client_version', version)
      const response = await codexRequest(codexAuthFile(env), signal, headers => fetch(url, { method: 'GET', headers: { ...headers, accept: 'application/json' }, signal, redirect: 'error', cache: 'no-store' }), { env, executable: info.clis.codex })
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        throw new CatalogueFailure(`http-${response.status}`)
      }
      const payload = await payloadOf(response, signal)
      signal.throwIfAborted()
      const observedAt = Date.now()
      return { models: modelsOf(payload, observedAt), providers: [{ provider: 'codex', status: 'fresh', source: SOURCE, observedAt }] }
    }
    return await Promise.race([discover(), aborted])
  } catch (error) {
    const failure = signal.aborted ? timedOut ? 'deadline-exceeded' : 'cancelled' : error instanceof CatalogueFailure ? error.message : error instanceof CodexAuthError ? 'auth-unavailable' : 'discovery-failed'
    return { models: [], providers: [{ provider: 'codex', status: 'unavailable', source: SOURCE, error: failure }] }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', rejectAbort)
    options.signal?.removeEventListener('abort', abort)
  }
}
