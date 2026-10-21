export type FetchAuth = { env: string } | { command: string[] }
export type FetchEndpoint = { name: string; url: string; priority: number; auth?: FetchAuth }
export type FetchConfig = { version: 1; endpoints: FetchEndpoint[] }
export type FetchConfigResult = { config: FetchConfig; errors: string[] }
export const MAX_FETCH_CONFIG_BYTES = 64 * 1024
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/
const ENV = /^[A-Za-z_][A-Za-z0-9_]*$/
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(value).every(key => allowed.includes(key))
const absoluteCommand = (value: string): boolean => value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value)
export const emptyFetchConfig = (): FetchConfig => ({ version: 1, endpoints: [] })
export const fetchPriority = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

function endpoint(value: unknown): FetchEndpoint | undefined {
  if (!object(value) || !keys(value, ['name', 'url', 'priority', 'auth']) || typeof value.name !== 'string' || !NAME.test(value.name)
    || typeof value.url !== 'string' || !fetchPriority(value.priority)) return undefined
  try {
    const url = new URL(value.url)
    if (!/^https?:\/\//i.test(value.url) || !['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password
      || url.search || url.hash || value.url.trim() !== value.url || /[\\?#\0\r\n]/.test(value.url)) return undefined
  } catch { return undefined }
  let auth: FetchAuth | undefined
  if (value.auth !== undefined) {
    if (!object(value.auth)) return undefined
    if (keys(value.auth, ['env']) && typeof value.auth.env === 'string' && ENV.test(value.auth.env)) auth = { env: value.auth.env }
    else if (keys(value.auth, ['command']) && Array.isArray(value.auth.command) && value.auth.command.length > 0
      && value.auth.command.every(word => typeof word === 'string' && word.length > 0 && !/[\0\r\n]/.test(word))
      && typeof value.auth.command[0] === 'string' && absoluteCommand(value.auth.command[0])) auth = { command: [...value.auth.command] as string[] }
    else return undefined
    if (new URL(value.url).protocol !== 'https:') return undefined
  }
  return { name: value.name, url: value.url, priority: value.priority, ...(auth ? { auth } : {}) }
}

/** Invalid files are rejected as a whole so a bad row never hides saved services. */
export function parseFetchConfig(text: string | undefined): FetchConfigResult {
  if (text === undefined) return { config: emptyFetchConfig(), errors: [] }
  if (new TextEncoder().encode(text).byteLength > MAX_FETCH_CONFIG_BYTES) return { config: emptyFetchConfig(), errors: ['Fetch configuration exceeds its size limit.'] }
  let value: unknown
  try { value = JSON.parse(text) } catch { return { config: emptyFetchConfig(), errors: ['Fetch configuration is not valid JSON.'] } }
  if (!object(value) || !keys(value, ['version', 'endpoints']) || value.version !== 1 || !Array.isArray(value.endpoints)) return { config: emptyFetchConfig(), errors: ['Fetch configuration must contain version 1 and an endpoints array, with no secret fields.'] }
  const endpoints: FetchEndpoint[] = [], names = new Set<string>(), errors: string[] = []
  for (const [index, raw] of value.endpoints.entries()) {
    const row = endpoint(raw)
    if (!row) errors.push(`Fetch endpoint ${index + 1} is invalid. Use a unique name, full HTTP(S) URL without query or fragment, nonnegative integer priority, and an optional HTTPS credential reference.`)
    else if (names.has(row.name)) errors.push(`Fetch endpoint ${index + 1} repeats a saved name.`)
    else { names.add(row.name); endpoints.push(row) }
  }
  return { config: errors.length ? emptyFetchConfig() : { version: 1, endpoints }, errors }
}

export function orderedFetchEndpoints(config: FetchConfig): FetchEndpoint[] {
  return config.endpoints.map((row, index) => ({ row, index })).sort((a, b) => a.row.priority - b.row.priority || a.index - b.index).map(({ row }) => row)
}

export type FetchProviderProtocol = 'anthropic' | 'gemini'
const GEMINI_URL_CONTEXT_MODELS = new Set([
  'gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite',
  'gemini-3.1-pro-preview', 'gemini-3.1-flash-lite', 'gemini-3-flash-preview',
  'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite',
])

/** A route is native-fetch eligible only at the official API origin and for its documented protocol/model. */
export function fetchProviderProtocol(modelKind: string | undefined, baseUrl: string | undefined, modelId?: string): FetchProviderProtocol | undefined {
  let endpoint: URL
  try { endpoint = new URL(baseUrl ?? '') } catch { return undefined }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return undefined
  const origin = endpoint.origin
  if (modelKind === 'anthropic' && origin === 'https://api.anthropic.com' && modelId !== undefined && /^claude-[a-z0-9-]+$/i.test(modelId)) return 'anthropic'
  if (modelKind === 'gemini' && origin === 'https://generativelanguage.googleapis.com' && modelId !== undefined && GEMINI_URL_CONTEXT_MODELS.has(modelId)) return 'gemini'
  return undefined
}

export type FetchTierStage = 'provider-native' | 'configured-service' | 'native-fallback' | 'direct-selected-extraction'
export type FetchTierConfigState = { tiers: Array<{
  order: number
  stage: FetchTierStage
  eligible: boolean
  reason: string
  services?: Array<{ name: string; priority: number }>
  readiness?: string
}> }
export type FetchConfigMetadata = { endpoints: Array<Pick<FetchEndpoint, 'name' | 'priority'>> }

/** Pure, credential-free tier state for hook consumers and status surfaces. */
export function fetchTierConfigState(config: FetchConfigMetadata, providerNative: boolean): FetchTierConfigState {
  const services = [...config.endpoints].sort((a, b) => a.priority - b.priority).map(({ name, priority }) => ({ name, priority }))
  return { tiers: [
    { order: 1, stage: 'provider-native', eligible: providerNative, reason: providerNative
      ? 'The selected route passes local provider protocol checks; model or account support may still be rejected by the provider.'
      : 'The selected route has no confirmed hosted fetch contract and is skipped before request.' },
    { order: 2, stage: 'configured-service', eligible: services.length > 0, reason: services.length
      ? 'Configured services are tried serially by ascending priority; reachability is not checked by status.'
      : 'No configured fetch services are available.', services },
    { order: 3, stage: 'native-fallback', eligible: true, reason: 'Claude Code native WebFetch is attempted before direct retrieval.',
      readiness: 'Session authorization and account WebFetch support are checked only if this tier is used.' },
    { order: 4, stage: 'direct-selected-extraction', eligible: true, reason: 'Final recovery retrieves the page directly, then extracts with the selected model.' },
  ] }
}
