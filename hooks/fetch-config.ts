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

/** Pure, credential-free tier state for hook consumers and status surfaces. */
export function fetchTierConfigState(config: FetchConfig, providerNative: boolean) {
  return [
    ...(providerNative ? [{ tier: 'provider-native' as const }] : []),
    { tier: 'configured-service' as const, services: orderedFetchEndpoints(config).map(({ name, priority }) => ({ name, priority })) },
    { tier: 'native-fallback' as const },
    { tier: 'direct-selected-extraction' as const },
  ]
}
