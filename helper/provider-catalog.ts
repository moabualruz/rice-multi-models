// Fresh configured-provider inventory. Declarations supply routing and auth policy, never metadata.
import { authHeaderOf, fingerprint, isObject, parseConfig } from '../hooks/config.ts'
import type { ProviderConfig } from '../hooks/config.ts'
import { unknownMetadata } from '../hooks/catalogue.ts'
import type { DiscoveredModel, ModelCatalogue, ModelMetadata } from '../hooks/catalogue.ts'
import type { Wire } from '../hooks/protocol.ts'
import { CATALOG_URL, TIERS } from '../hooks/opencode.ts'
import { runCommand } from './core/subprocess.ts'
import { createKeys } from './styx/auth.ts'
import type { Runner } from './styx/auth.ts'

const MAX_BYTES = 4 * 1024 * 1024
const MAX_PAGES = 20
const MAX_MODELS = 10000
const positive = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,255}$/.test(value) && !value.includes('..')
class CatalogueFailure extends Error {}

export type ProviderCatalogueOptions = {
  signal?: AbortSignal
  timeoutMs?: number
  /** Test seams only. Production uses native fetch and the existing shell-free runner. */
  fetch?: typeof fetch
  run?: Runner
}

function metadataOf(raw: Record<string, unknown>, kind: ProviderConfig['kind']): ModelMetadata {
  const metadata = unknownMetadata()
  if (kind === 'gemini') {
    // These are independent reported limits, not a combined context window.
    metadata.inputTokenLimit = positive(raw.inputTokenLimit)
    metadata.outputTokenLimit = positive(raw.outputTokenLimit)
  } else if (kind === 'anthropic') {
    metadata.inputTokenLimit = positive(raw.max_input_tokens)
    metadata.outputTokenLimit = positive(raw.max_tokens)
  }
  // The OpenAI Models API reports identity only. Gateway extensions and SDK defaults are not a schema.
  return metadata
}

async function payloadOf(response: Response, signal: AbortSignal, budget: { bytes: number }, maxBytes = MAX_BYTES): Promise<Record<string, unknown>> {
  if (!response.body) throw new CatalogueFailure('protocol-invalid')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      budget.bytes += chunk.value.byteLength
      if (budget.bytes > maxBytes) throw new CatalogueFailure('protocol-too-large')
      chunks.push(chunk.value)
    }
    signal.throwIfAborted()
    let payload: unknown
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown } catch { throw new CatalogueFailure('protocol-invalid') }
    if (!isObject(payload)) throw new CatalogueFailure('protocol-invalid')
    return payload
  } finally {
    signal.removeEventListener('abort', cancel)
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function nextPage(payload: Record<string, unknown>, provider: ProviderConfig, endpoint: URL): URL | undefined {
  if (provider.kind === 'gemini') {
    const token = payload.nextPageToken
    if (token === undefined || token === '') return undefined
    if (typeof token !== 'string' || token.length > 4096) throw new CatalogueFailure('pagination-invalid')
    const next = new URL(endpoint)
    next.searchParams.set('pageToken', token)
    return next
  }
  // Standard Anthropic pagination, also used by compatible OpenAI catalogues.
  if (payload.has_more !== undefined && typeof payload.has_more !== 'boolean') throw new CatalogueFailure('pagination-invalid')
  if (payload.has_more === true) {
    if (!validId(payload.last_id)) throw new CatalogueFailure('pagination-invalid')
    const next = new URL(endpoint)
    next.searchParams.set(provider.kind === 'anthropic' ? 'after_id' : 'after', payload.last_id)
    return next
  }
  // Some compatible catalogues report an explicit next page. Never send credentials off endpoint.
  const link = payload.next ?? (isObject(payload.links) ? payload.links.next : undefined)
  if (link === undefined || link === null || link === '') return undefined
  if (typeof link !== 'string' || link.length > 4096) throw new CatalogueFailure('pagination-invalid')
  let next: URL
  try { next = new URL(link, endpoint) } catch { throw new CatalogueFailure('pagination-invalid') }
  if (next.origin !== endpoint.origin || next.pathname !== endpoint.pathname || next.username || next.password || next.hash) throw new CatalogueFailure('pagination-invalid')
  return next
}

async function inventory(provider: ProviderConfig, endpoint: URL, source: string, headers: Headers, signal: AbortSignal, fetcher: typeof fetch): Promise<ModelCatalogue> {
  const models: DiscoveredModel[] = []
  const ids = new Set<string>()
  const pages = new Set<string>()
  const budget = { bytes: 0 }
  let url: URL | undefined = endpoint
  for (let page = 0; url; page++) {
    signal.throwIfAborted()
    if (page >= MAX_PAGES || pages.has(url.href)) throw new CatalogueFailure('pagination-limit')
    pages.add(url.href)
    const response = await fetcher(url, { method: 'GET', headers, signal, redirect: 'error', cache: 'no-store' })
    signal.throwIfAborted()
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      throw new CatalogueFailure(`http-${response.status}`)
    }
    const payload = await payloadOf(response, signal, budget)
    const entries = provider.kind === 'gemini' ? payload.models : payload.data
    if (!Array.isArray(entries)) throw new CatalogueFailure('protocol-invalid')
    if (models.length + entries.length > MAX_MODELS) throw new CatalogueFailure('protocol-too-large')
    for (const entry of entries) {
      if (!isObject(entry)) throw new CatalogueFailure('protocol-invalid')
      const rawId = provider.kind === 'gemini' ? entry.name : entry.id
      if (!validId(rawId)) throw new CatalogueFailure('protocol-invalid')
      const id = provider.kind === 'gemini' && rawId.startsWith('models/') ? rawId.slice(7) : rawId
      if (!validId(id) || ids.has(id)) throw new CatalogueFailure('protocol-invalid')
      ids.add(id)
      models.push({ model: `${provider.id}/${id}`, label: `${id} (${provider.id})`, execution: 'native provider', source, observedAt: 0, metadata: metadataOf(entry, provider.kind) })
    }
    url = nextPage(payload, provider, endpoint)
  }
  signal.throwIfAborted()
  const observedAt = Date.now()
  for (const model of models) model.observedAt = observedAt
  return { models, providers: [{ provider: provider.id, status: 'fresh', source, observedAt }] }
}

function registryMetadata(entry: Record<string, unknown>): Partial<ModelMetadata> {
  const limit = isObject(entry.limit) ? entry.limit : {}
  const modalities = isObject(entry.modalities) ? entry.modalities.input : undefined
  return {
    contextWindow: positive(limit.context),
    inputTokenLimit: positive(limit.input),
    outputTokenLimit: positive(limit.output),
    inputModalities: Array.isArray(modalities) && modalities.every(value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(value)) ? [...new Set(modalities as string[])] : null,
    tools: typeof entry.tool_call === 'boolean' ? entry.tool_call : null,
  }
}

async function enrichOpenCode(catalogue: ModelCatalogue, providers: readonly ProviderConfig[], fetcher: typeof fetch, signal: AbortSignal, aborted: Promise<never>): Promise<void> {
  // Exact configured tier and endpoint only. IDs are then matched byte-for-byte in that tier's registry.
  const tiers = providers.flatMap(provider => {
    const tier = Object.values(TIERS).find(tier => tier.id === provider.id && tier.base === provider.baseUrl)
    return tier && catalogue.providers.some(status => status.provider === provider.id && status.status === 'fresh') && catalogue.models.some(model => model.model.startsWith(`${provider.id}/`)) ? [tier] : []
  })
  if (!tiers.length || signal.aborted) return
  let registry: Record<string, unknown>
  try {
    const load = async () => {
      signal.throwIfAborted()
      // A public registry never receives any configured provider credentials or headers.
      const response = await fetcher(CATALOG_URL, { method: 'GET', headers: { accept: 'application/json' }, signal, redirect: 'error', cache: 'no-store' })
      if (!response.ok) {
        void response.body?.cancel().catch(() => {})
        throw new CatalogueFailure('registry-unavailable')
      }
      return payloadOf(response, signal, { bytes: 0 }, 16 * 1024 * 1024)
    }
    registry = await Promise.race([load(), aborted])
  } catch {
    // Supplemental failure must not erase freshly discovered gateway IDs or endpoint metadata.
    return
  }
  for (const tier of tiers) {
    const entry = Object.hasOwn(registry, tier.id) ? registry[tier.id] : undefined
    const known = isObject(entry) && isObject(entry.models) ? entry.models : undefined
    if (!known) continue
    for (const model of catalogue.models) {
      const prefix = `${tier.id}/`
      if (!model.model.startsWith(prefix)) continue
      const id = model.model.slice(prefix.length)
      const raw = Object.hasOwn(known, id) ? known[id] : undefined
      if (!isObject(raw)) continue
      const supplement = registryMetadata(raw)
      let applied = false
      for (const field of Object.keys(supplement) as (keyof ModelMetadata)[]) {
        const value = supplement[field]
        if (model.metadata[field] !== null || value === undefined || value === null) continue
        // Both operands are projections of the same metadata contract; keep each field's reported type.
        Object.assign(model.metadata, { [field]: value })
        const sources = model.metadataSources ??= {}
        sources[field] = `fresh models.dev registry ${tier.id}/${id}`
        applied = true
      }
      if (applied) model.source += ' + fresh models.dev registry metadata'
    }
  }
}

/** Each invocation refreshes all approved supported providers under one total startup deadline. */
export async function discoverProviders(wire: Pick<Wire, 'configText' | 'approved' | 'userAgent'>, options: ProviderCatalogueOptions = {}): Promise<ModelCatalogue> {
  if (!wire.configText.trim()) return { models: [], providers: [] }
  const { config } = parseConfig(wire.configText)
  if (!config) return { models: [], providers: [{ provider: 'configured', status: 'unavailable', source: 'configured provider discovery', error: 'config-invalid' }] }
  const timeoutMs = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(options.timeoutMs, 30000)) : 8000
  const deadline = Date.now() + timeoutMs
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  const cancel = () => controller.abort()
  options.signal?.addEventListener('abort', cancel, { once: true })
  if (options.signal?.aborted) cancel()
  const signal = controller.signal
  const approved = new Set(wire.approved)
  const keys = createKeys((argv, requestedMs) => {
    signal.throwIfAborted()
    return (options.run ?? runCommand)(argv, Math.max(1, Math.min(requestedMs, deadline - Date.now())))
  }, Date.now)
  // Race each provider so one stalled fetch/body/helper cannot hold startup past cancellation.
  let rejectAbort: () => void = () => {}
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(new CatalogueFailure(timedOut ? 'deadline-exceeded' : 'cancelled'))
    signal.addEventListener('abort', rejectAbort, { once: true })
    if (signal.aborted) rejectAbort()
  })
  // Even an empty provider map or entirely unapproved inventory must consume abort rejection safely.
  void aborted.catch(() => {})
  try {
    const results = await Promise.all(Object.values(config.providers).map(async provider => {
      const endpoint = new URL(`${provider.baseUrl}${provider.kind === 'anthropic' && !provider.baseUrl.endsWith('/v1') ? '/v1/models' : '/models'}`)
      const source = `${provider.id} ${provider.kind} live /models endpoint`
      if (!approved.has(fingerprint(provider))) return { models: [], providers: [{ provider: provider.id, status: 'approval-required', source }] } satisfies ModelCatalogue
      if (provider.kind === 'bedrock') return { models: [], providers: [{ provider: provider.id, status: 'unavailable', source: 'bedrock configured provider', error: 'enumeration-unsupported' }] } satisfies ModelCatalogue
      try {
        const discover = async () => {
          signal.throwIfAborted()
          const key = await keys.get(provider, approved)
          signal.throwIfAborted()
          if ('error' in key) throw new CatalogueFailure('auth-unavailable')
          const headers = new Headers(provider.headers)
          headers.set('accept', 'application/json')
          if (wire.userAgent) headers.set('user-agent', wire.userAgent)
          if (provider.kind === 'anthropic' && !headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01')
          if (key.key !== null) {
            const auth = authHeaderOf(provider, provider)
            headers.set(auth === 'bearer' ? 'authorization' : auth, auth === 'bearer' ? `Bearer ${key.key}` : key.key)
          }
          return inventory(provider, endpoint, source, headers, signal, options.fetch ?? fetch)
        }
        return await Promise.race([discover(), aborted])
      } catch (error) {
        // Only controlled categories leave this boundary, never provider/runner response text or abort reasons.
        const failure = signal.aborted ? timedOut ? 'deadline-exceeded' : 'cancelled' : error instanceof CatalogueFailure ? error.message : 'discovery-failed'
        return { models: [], providers: [{ provider: provider.id, status: 'unavailable', source, error: failure }] } satisfies ModelCatalogue
      }
    }))
    const catalogue = { models: results.flatMap(result => result.models), providers: results.flatMap(result => result.providers) }
    await enrichOpenCode(catalogue, Object.values(config.providers), options.fetch ?? fetch, signal, aborted)
    return catalogue
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', rejectAbort)
    options.signal?.removeEventListener('abort', cancel)
  }
}
