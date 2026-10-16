import type { SearchSource, WebSearch } from './protocol.ts'

export type PublicWebSearchInput = {
  query: string
  allowed_domains?: string[]
  blocked_domains?: string[]
  maxUses?: number
}

/** The native WebSearch output contract, without a dependency on generated engine types. */
export type PublicWebSearchResult = {
  query: string
  results: Array<{ tool_use_id: string; content: Array<{ title: string; url: string; snippet?: string }> } | string>
  durationSeconds: number
  searchCount?: number
}

/** Shared by helper routing and the public host fallback, before either does I/O. */
export function webSearchPolicy(input: PublicWebSearchInput): WebSearch {
  if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 2048) throw new TypeError('Invalid web search query.')
  const domains = (value: unknown): string[] | undefined => {
    if (value === undefined) return undefined
    if (!Array.isArray(value) || value.length > 100 || !value.every(rule => {
      if (typeof rule !== 'string' || !rule || rule.length > 2048 || /^[a-z]+:\/\//i.test(rule) || /[?#@\s]/.test(rule)) return false
      try { const url = new URL(`https://${rule}`); return !!url.hostname && !url.username && !url.password } catch { return false }
    })) throw new TypeError('Invalid web search domain policy.')
    return value
  }
  const allowedDomains = domains(input.allowed_domains), blockedDomains = domains(input.blocked_domains)
  if (allowedDomains?.length && blockedDomains?.length) throw new TypeError('Web search accepts one domain policy.')
  if (input.maxUses !== undefined && (!Number.isSafeInteger(input.maxUses) || input.maxUses < 1 || input.maxUses > 20)) throw new TypeError('Invalid web search use bound.')
  return { ...(allowedDomains ? { allowedDomains } : {}), ...(blockedDomains ? { blockedDomains } : {}), ...(input.maxUses === undefined ? {} : { maxUses: input.maxUses }) }
}

function matches(value: URL, rule: string): boolean {
  const domain = new URL(`https://${rule}`)
  return (value.hostname === domain.hostname || value.hostname.endsWith(`.${domain.hostname}`))
    && (domain.pathname === '/' || value.pathname === domain.pathname || value.pathname.startsWith(`${domain.pathname.replace(/\/$/, '')}/`))
}

export function boundedSearchSources(sources: readonly SearchSource[], policy: WebSearch): SearchSource[] {
  const seen = new Set<string>(), kept: SearchSource[] = []
  let valid = 0
  for (const source of sources) {
    if (!source || typeof source.title !== 'string' || typeof source.url !== 'string' || source.url.length > 8192) continue
    let url: URL
    try { url = new URL(source.url) } catch { continue }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue
    valid++
    if (policy.allowedDomains?.length && !policy.allowedDomains.some(rule => matches(url, rule)) || policy.blockedDomains?.some(rule => matches(url, rule)) || seen.has(url.href)) continue
    seen.add(url.href)
    kept.push({ title: source.title.slice(0, 512), url: url.href, ...(typeof source.content === 'string' && source.content ? { content: source.content.slice(0, 4000) } : {}) })
    if (kept.length === 10) break
  }
  if (sources.length && !valid) throw new Error('Search returned no valid sources.')
  return kept
}

export function publicWebSearchResult(query: string, sources: readonly SearchSource[], policy: WebSearch, durationSeconds: number, calls?: number): PublicWebSearchResult {
  return {
    query, results: [{ tool_use_id: `toolu_rice_search_${crypto.randomUUID().replaceAll('-', '')}`, content: boundedSearchSources(sources, policy).map(source => ({ title: source.title, url: source.url, ...(source.content ? { snippet: source.content } : {}) })) }],
    durationSeconds: Math.max(0, durationSeconds), ...(Number.isSafeInteger(calls) && Number(calls) >= 0 ? { searchCount: calls } : {}),
  }
}
