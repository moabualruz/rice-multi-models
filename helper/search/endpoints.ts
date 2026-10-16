import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MAX_SEARCH_CONFIG_BYTES, orderedSearchEndpoints, parseSearchConfig } from '../../hooks/search-config.ts'
import type { SearchEndpoint } from '../../hooks/search-config.ts'
import { runCommand } from '../core/subprocess.ts'

export type SearchResult = { title: string; url: string; content: string }

export class SearchUnavailable extends Error {}
export type SearchAttempt = { name: string; status: 'unavailable' | 'success'; http?: number }

/** Read configuration at the search boundary, including edits made during this session. */
export function searchEndpoints(environment: NodeJS.ProcessEnv = process.env): SearchEndpoint[] {
  const file = join(environment.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'rice-multi-models/search.json')
  let text: string | undefined
  try {
    if (statSync(file).size > MAX_SEARCH_CONFIG_BYTES) throw new SearchUnavailable('Search configuration exceeds its size limit.')
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new SearchUnavailable('Cannot read search configuration; run /rice-models search setup.')
  }
  const parsed = parseSearchConfig(text)
  if (parsed.errors.length) throw new SearchUnavailable('Invalid search configuration; run /rice-models search setup.')
  const endpoints = orderedSearchEndpoints(parsed.config)
  const legacy = environment.RICE_MULTI_MODELS_SEARCH_URL
  if (legacy && !endpoints.some(endpoint => endpoint.url === legacy)) {
    const checked = parseSearchConfig(JSON.stringify({ version: 1, endpoints: [{ name: 'legacy-environment', kind: 'searxng', url: legacy, priority: 0 }] }))
    if (checked.errors.length) throw new SearchUnavailable('The legacy search endpoint is invalid; run /rice-models search setup.')
    endpoints.push(...checked.config.endpoints)
  }
  return endpoints
}

async function json(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new SearchUnavailable('Search endpoint returned no response body.')
  const parts: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      size += item.value.byteLength
      if (size > 2 * 1024 * 1024) throw new SearchUnavailable('Search response exceeds its size limit.')
      parts.push(item.value)
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'))
  } finally { await reader.cancel() }
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export function searchRecords(value: unknown, kind: SearchEndpoint['kind']): SearchResult[] {
  const rows = object(value) ? kind === 'brave' ? object(value.web) ? value.web.results : undefined : value.results : undefined
  if (!Array.isArray(rows)) throw new SearchUnavailable('Search endpoint returned an invalid result list.')
  const results = rows.filter(object).flatMap(row => {
    if (typeof row.url !== 'string' || typeof row.title !== 'string') return []
    try {
      const url = new URL(row.url)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return []
      const content = kind === 'brave' ? row.description : row.content
      return [{ title: row.title.slice(0, 512), url: url.href, content: typeof content === 'string' ? content.slice(0, 4000) : '' }]
    } catch { return [] }
  }).slice(0, 10)
  if (rows.length && !results.length) throw new SearchUnavailable('Search endpoint returned no valid source records.')
  return results
}

/** Each service gets only its own credential; redirects never receive a search key. */
export async function endpointSearch(endpoint: SearchEndpoint, query: string, signal: AbortSignal, request: typeof fetch = fetch, environment: NodeJS.ProcessEnv = process.env): Promise<{ results: SearchResult[]; http: number }> {
  if (!query.trim() || query.length > 2048) throw new SearchUnavailable('Invalid search query.')
  let key: string | undefined
  if (endpoint.auth) {
    if ('env' in endpoint.auth) key = environment[endpoint.auth.env]
    else {
      const helper = await runCommand(endpoint.auth.command, 15_000)
      if (helper.exitCode === 0 && helper.stdout.length <= 16 * 1024) key = helper.stdout.trim()
    }
    if (!key || /[\0\r\n]/.test(key)) throw new SearchUnavailable('Search endpoint credential is unavailable.')
  }
  if (endpoint.kind !== 'searxng' && !key) throw new SearchUnavailable('Search endpoint requires a credential reference.')
  if (endpoint.kind === 'brave' && (query.length > 600 || query.trim().split(/\s+/).length > 75)) throw new SearchUnavailable('Query exceeds this search service limit.')
  const url = new URL(endpoint.url), headers: Record<string, string> = { accept: 'application/json' }
  let body: string | undefined
  if (endpoint.kind === 'tavily') {
    headers['content-type'] = 'application/json'
    headers.authorization = `Bearer ${key}`
    body = JSON.stringify({ query, search_depth: 'basic', max_results: 10, include_answer: false, include_raw_content: false })
  } else {
    url.searchParams.set('q', query)
    if (endpoint.kind === 'searxng') url.searchParams.set('format', 'json')
    else url.searchParams.set('count', '10')
    if (key) headers[endpoint.kind === 'brave' ? 'x-subscription-token' : 'authorization'] = endpoint.kind === 'brave' ? key : `Bearer ${key}`
  }
  const response = await request(url, { method: body ? 'POST' : 'GET', headers, ...(body ? { body } : {}), redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) })
  const status = response.status
  if (!response.ok) {
    // Status is authoritative. Error bodies stay bounded and are never emitted.
    const reader = response.body?.getReader()
    if (reader) try { await reader.read() } finally { await reader.cancel() }
    throw Object.assign(new SearchUnavailable(`Search endpoint HTTP ${status}.`), { status })
  }
  return { results: searchRecords(await json(response), endpoint.kind), http: status }
}

/** A valid empty result is success. Transport and quota failures advance to the next endpoint. */
export async function configuredSearch(query: string, signal: AbortSignal, endpoints = searchEndpoints(), request: typeof fetch = fetch, observe?: (attempt: SearchAttempt) => void): Promise<SearchResult[]> {
  for (const endpoint of endpoints) {
    try {
      const result = await endpointSearch(endpoint, query, signal, request)
      observe?.({ name: endpoint.name, status: 'success', http: result.http })
      return result.results
    } catch (error) {
      signal.throwIfAborted()
      observe?.({ name: endpoint.name, status: 'unavailable', ...((error as { status?: number }).status ? { http: (error as { status: number }).status } : {}) })
    }
  }
  throw new SearchUnavailable('No configured search service is available.')
}
