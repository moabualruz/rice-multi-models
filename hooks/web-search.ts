import type { SearchSource, WebSearch } from './protocol.ts'

/** The native WebSearch input, as the tool call carries it. */
export type PublicWebSearchInput = {
  query: string
  allowed_domains?: string[]
  blocked_domains?: string[]
  mode?: 'standard' | 'extended'
}

/** The native WebSearch output contract, without a dependency on generated engine types. */
export type PublicWebSearchResult = {
  query: string
  results: Array<{ tool_use_id: string; content: Array<{ title: string; url: string; snippet?: string }> } | string>
  durationSeconds: number
  searchCount?: number
}

/** The native input's fields under the wire's names. Nothing is validated or bounded: that stays Claude's. */
export function webSearchMapping(input: PublicWebSearchInput): WebSearch {
  const list = (value: unknown): string[] | undefined => Array.isArray(value) && value.length ? value as string[] : undefined
  const allowedDomains = list(input.allowed_domains), blockedDomains = list(input.blocked_domains)
  return {
    ...(allowedDomains ? { allowedDomains } : {}), ...(blockedDomains ? { blockedDomains } : {}),
    ...(input.mode === 'standard' || input.mode === 'extended' ? { mode: input.mode } : {}),
  }
}

/** Sources that map onto the native result: a title and a web address each. */
export function mappedSearchSources(sources: readonly SearchSource[]): SearchSource[] {
  const kept: SearchSource[] = []
  for (const source of sources) {
    if (!source || typeof source.title !== 'string' || typeof source.url !== 'string') continue
    let url: URL
    try { url = new URL(source.url) } catch { continue }
    if (!['http:', 'https:'].includes(url.protocol)) continue
    kept.push({ title: source.title, url: url.href, ...(typeof source.content === 'string' && source.content ? { content: source.content } : {}) })
  }
  if (sources.length && !kept.length) throw new Error('Search returned no valid sources.')
  return kept
}

export function publicWebSearchResult(query: string, sources: readonly SearchSource[], durationSeconds: number, calls?: number): PublicWebSearchResult {
  return {
    query, results: [{ tool_use_id: `toolu_rice_search_${crypto.randomUUID().replaceAll('-', '')}`, content: mappedSearchSources(sources).map(source => ({ title: source.title, url: source.url, ...(source.content ? { snippet: source.content } : {}) })) }],
    durationSeconds: Math.max(0, durationSeconds), ...(Number.isSafeInteger(calls) && Number(calls) >= 0 ? { searchCount: calls } : {}),
  }
}
