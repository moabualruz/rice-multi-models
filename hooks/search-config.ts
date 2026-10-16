export type SearchKind = 'searxng' | 'brave' | 'tavily'
export type SearchAuth = { env: string } | { command: string[] }
export type SearchEndpoint = { name: string; kind: SearchKind; url: string; priority: number; auth?: SearchAuth }
export type SearchConfig = { version: 1; endpoints: SearchEndpoint[] }
export type SearchConfigResult = { config: SearchConfig; errors: string[] }
export type SearchEdit = { op: 'add'; endpoint: SearchEndpoint } | { op: 'remove'; name: string } | { op: 'priority'; name: string; priority: number }
export const SEARCH_KINDS: readonly SearchKind[] = ['searxng', 'brave', 'tavily']
export const MAX_SEARCH_CONFIG_BYTES = 64 * 1024
export const DEFAULT_SEARCH_PRIORITY = 10
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/
const ENV = /^[A-Za-z_][A-Za-z0-9_]*$/
const absoluteCommand = (value: string): boolean => value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value)
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(value).every(key => allowed.includes(key))
export const emptySearchConfig = (): SearchConfig => ({ version: 1, endpoints: [] })
export const searchPriority = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

function endpoint(value: unknown): SearchEndpoint | undefined {
  if (!object(value) || !keys(value, ['name', 'kind', 'url', 'priority', 'auth']) || typeof value.name !== 'string' || !NAME.test(value.name)
    || !SEARCH_KINDS.includes(value.kind as SearchKind) || typeof value.url !== 'string' || !searchPriority(value.priority)) return undefined
  try {
    const url = new URL(value.url)
    if (!/^https?:\/\//i.test(value.url) || !['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || /[\\?#]/.test(value.url)
      || value.url.trim() !== value.url || /[\0\r\n]/.test(value.url)) return undefined
  } catch { return undefined }
  let auth: SearchAuth | undefined
  if (value.auth !== undefined) {
    if (!object(value.auth)) return undefined
    if (keys(value.auth, ['env']) && typeof value.auth.env === 'string' && ENV.test(value.auth.env)) auth = { env: value.auth.env }
    else if (keys(value.auth, ['command']) && Array.isArray(value.auth.command) && value.auth.command.length > 0
      && value.auth.command.every(word => typeof word === 'string' && word.length > 0 && !/[\0\r\n]/.test(word))
      && typeof value.auth.command[0] === 'string' && absoluteCommand(value.auth.command[0])) auth = { command: [...value.auth.command] }
    else return undefined
  }
  return { name: value.name, kind: value.kind as SearchKind, url: value.url, priority: value.priority, ...(auth ? { auth } : {}) }
}

/** Reject an invalid document as a whole, so editing cannot discard saved endpoints. */
export function parseSearchConfig(text: string | undefined): SearchConfigResult {
  if (text === undefined) return { config: emptySearchConfig(), errors: [] }
  const errors: string[] = []
  if (new TextEncoder().encode(text).byteLength > MAX_SEARCH_CONFIG_BYTES) return { config: emptySearchConfig(), errors: ['Search configuration exceeds its size limit.'] }
  let value: unknown
  try { value = JSON.parse(text) } catch { return { config: emptySearchConfig(), errors: ['Search configuration is not valid JSON.'] } }
  if (!object(value) || !keys(value, ['version', 'endpoints']) || value.version !== 1 || !Array.isArray(value.endpoints)) return { config: emptySearchConfig(), errors: ['Search configuration must contain version 1 and an endpoints array, with no secret fields.'] }
  const endpoints: SearchEndpoint[] = [], names = new Set<string>()
  for (const [index, raw] of value.endpoints.entries()) {
    const row = endpoint(raw)
    if (!row) errors.push(`Search endpoint ${index + 1} is invalid. Use a name, supported kind, full HTTP(S) URL without credentials or query parameters, nonnegative integer priority, and an optional credential reference.`)
    else if (names.has(row.name)) errors.push(`Search endpoint ${index + 1} repeats a saved name.`)
    else { names.add(row.name); endpoints.push(row) }
  }
  return { config: errors.length ? emptySearchConfig() : { version: 1, endpoints }, errors }
}

/** Equal priorities keep their saved order. Legacy environment configuration is separate. */
export function orderedSearchEndpoints(config: SearchConfig): SearchEndpoint[] {
  return config.endpoints.map((row, index) => ({ row, index })).sort((a, b) => a.row.priority - b.row.priority || a.index - b.index).map(({ row }) => row)
}

export function editSearchConfig(config: SearchConfig, edit: SearchEdit): SearchConfigResult {
  const checked = parseSearchConfig(JSON.stringify(config))
  if (checked.errors.length) return checked
  const endpoints = checked.config.endpoints
  if (edit.op === 'add') {
    const row = endpoint(edit.endpoint)
    if (!row) return { config, errors: ['The new search endpoint is invalid.'] }
    if (endpoints.some(saved => saved.name === row.name)) return { config, errors: ['That search endpoint name is already saved.'] }
    return { config: { version: 1, endpoints: [...endpoints, row] }, errors: [] }
  }
  const index = endpoints.findIndex(row => row.name === edit.name)
  if (index < 0) return { config, errors: ['That search endpoint name is not saved.'] }
  if (edit.op === 'remove') return { config: { version: 1, endpoints: endpoints.filter((_, position) => position !== index) }, errors: [] }
  if (!searchPriority(edit.priority)) return { config, errors: ['Search priority must be a nonnegative safe integer.'] }
  return { config: { version: 1, endpoints: endpoints.map((row, position) => position === index ? { ...row, priority: edit.priority } : row) }, errors: [] }
}

export type ParsedSearchCommand = { action: 'status' | 'setup' } | { action: 'edit'; edit: SearchEdit } | { error: string }
const USAGE = 'Usage: /rice-models search [setup | add NAME searxng|brave|tavily URL [priority=N] [key-env=ENV_NAME] | remove NAME | priority NAME N]'

export function parseSearchCommand(args: string): ParsedSearchCommand {
  const words = args.trim() ? args.trim().split(/\s+/) : []
  if (words.length === 0) return { action: 'status' }
  if (words[0] === 'setup' && words.length === 1) return { action: 'setup' }
  if (words[0] === 'remove' && words.length === 2 && NAME.test(words[1])) return { action: 'edit', edit: { op: 'remove', name: words[1] } }
  if (words[0] === 'priority' && words.length === 3 && NAME.test(words[1]) && /^\d+$/.test(words[2]) && searchPriority(Number(words[2]))) return { action: 'edit', edit: { op: 'priority', name: words[1], priority: Number(words[2]) } }
  if (words[0] !== 'add' || words.length < 4) return { error: USAGE }
  const options = new Map<string, string>()
  for (const word of words.slice(4)) {
    const equals = word.indexOf('=')
    if (equals <= 0) return { error: 'Expected priority=N or key-env=ENV_NAME. Never enter a credential value.' }
    const key = word.slice(0, equals), value = word.slice(equals + 1)
    if (!['priority', 'key-env'].includes(key) || options.has(key)) return { error: 'Unknown or repeated search option. Use priority=N or key-env=ENV_NAME.' }
    options.set(key, value)
  }
  const priority = options.has('priority') ? Number(options.get('priority')) : DEFAULT_SEARCH_PRIORITY
  if (options.has('priority') && !/^\d+$/.test(options.get('priority') ?? '')) return { error: 'Search priority must be a nonnegative safe integer.' }
  const row = endpoint({ name: words[1], kind: words[2], url: words[3], priority, ...(options.has('key-env') ? { auth: { env: options.get('key-env') } } : {}) })
  return row ? { action: 'edit', edit: { op: 'add', endpoint: row } } : { error: 'Invalid search endpoint. Use a full HTTP(S) endpoint URL without credentials or query parameters and only the environment variable name for key-env.' }
}

export function parseSearchEdit(value: unknown): SearchEdit | undefined {
  if (!object(value)) return undefined
  if (value.op === 'add' && keys(value, ['op', 'endpoint'])) {
    const row = endpoint(value.endpoint)
    return row ? { op: 'add', endpoint: row } : undefined
  }
  if (typeof value.name !== 'string' || !NAME.test(value.name)) return undefined
  if (value.op === 'remove' && keys(value, ['op', 'name'])) return { op: 'remove', name: value.name }
  if (value.op === 'priority' && keys(value, ['op', 'name', 'priority']) && searchPriority(value.priority)) return { op: 'priority', name: value.name, priority: value.priority }
  return undefined
}

export type SearchConfigurationResult = { ok: boolean; config?: SearchConfig; changed?: boolean; errors?: string[]; error?: string }
export type SearchConfigurationPort = {
  read: () => Promise<SearchConfigurationResult>
  edit: (edit: SearchEdit) => Promise<SearchConfigurationResult>
  ask: (question: string, options: readonly string[]) => Promise<string>
}

export function searchConfigurationText(config: SearchConfig): string {
  const rows = orderedSearchEndpoints(config).map(row => `${row.name}: ${row.kind}, priority ${row.priority}, ${row.url}; credentials: ${row.auth ? 'env' in row.auth ? row.auth.env : 'command reference' : 'none'}`)
  return `${rows.length ? rows.join('\n') : 'No search services are saved.'}\nSearch order: selected provider first, saved services by priority, then the native Claude search fallback. A legacy search URL follows saved services.\n/rice-models search setup adds a service; search add, remove, and priority also work without a dialog. Never enter a key value into this session.`
}

function resultText(result: SearchConfigurationResult): string {
  return result.ok && result.config ? searchConfigurationText(result.config) : `Search configuration was not changed: ${result.error ?? result.errors?.join(' ') ?? 'the helper returned an invalid result.'}`
}

/** UI calls remain in the registering module; this port also supports headless edits. */
export async function searchConfigurationCommand(args: string, port: SearchConfigurationPort): Promise<string> {
  const parsed = parseSearchCommand(args)
  if ('error' in parsed) return parsed.error
  if (parsed.action === 'edit') return resultText(await port.edit(parsed.edit))
  const current = await port.read()
  if (!current.ok || !current.config) return resultText(current)
  if (parsed.action === 'status') return searchConfigurationText(current.config)
  try {
    const kind = await port.ask('Which search service should receive searches after the selected provider (Other cancels)?', SEARCH_KINDS)
    if (!SEARCH_KINDS.includes(kind as SearchKind)) return 'Search setup cancelled; nothing was saved.'
    let suggestion = kind
    for (let n = 2; current.config.endpoints.some(row => row.name === suggestion); n++) suggestion = `${kind}-${n}`
    const name = await port.ask('What saved name should this service use (Other enters a name)?', [suggestion, 'Cancel'])
    if (name === 'Cancel') return 'Search setup cancelled; nothing was saved.'
    const defaultUrl = kind === 'brave' ? 'https://api.search.brave.com/res/v1/web/search' : kind === 'tavily' ? 'https://api.tavily.com/search' : undefined
    const url = await port.ask(defaultUrl ? 'Which request endpoint URL should be used (Other enters your endpoint)?' : 'Which full SearXNG search URL should be used (choose Other to type it)?', [defaultUrl ?? 'Enter URL using Other', 'Cancel'])
    if (url === 'Cancel') return 'Search setup cancelled; nothing was saved.'
    const priority = await port.ask('What priority should this service use (lower runs first; Other enters a nonnegative integer)?', ['10', '20', '30'])
    const suggestedEnv = kind === 'brave' ? 'BRAVE_SEARCH_API_KEY' : kind === 'tavily' ? 'TAVILY_API_KEY' : undefined
    const credential = await port.ask('Which environment variable NAME only holds the key (Other enters its name, never the key value)?', suggestedEnv ? [suggestedEnv, 'No credentials'] : ['No credentials', 'Enter ENV NAME using Other'])
    const command = parseSearchCommand(`add ${name} ${kind} ${url} priority=${priority}${credential === 'No credentials' ? '' : ` key-env=${credential}`}`)
    if ('error' in command) return `${command.error}\nNothing was saved. /rice-models search add also accepts these values directly.`
    if (command.action !== 'edit' || command.edit.op !== 'add') return 'Search setup cancelled; nothing was saved.'
    const row = command.edit.endpoint
    const confirmation = await port.ask(`Searches may be sent directly to this endpoint. Save ${row.name} (${row.kind}) at ${row.url}, priority ${row.priority}?`, ['Save endpoint', 'Cancel'])
    if (confirmation !== 'Save endpoint') return 'Search setup cancelled; nothing was saved.'
    return resultText(await port.edit(command.edit))
  } catch { return 'Search setup needs an interactive session. Use /rice-models search add NAME KIND URL [priority=N] [key-env=ENV_NAME], with an environment variable name and no key value. Nothing was saved.' }
}
