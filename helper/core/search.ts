import type { SearchSource } from '../../hooks/protocol.ts'
import { isRecord } from './record.ts'

/** Sources come only from provider search metadata, never generated prose. */
export function searchSource(value: unknown): SearchSource | undefined {
  if (!isRecord(value) || typeof value.url !== 'string') return undefined
  try {
    const url = new URL(value.url)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined
    return { title: typeof value.title === 'string' && value.title ? value.title.slice(0, 512) : url.hostname, url: url.href,
      ...(typeof value.content === 'string' ? { content: value.content.slice(0, 4000) } : {}) }
  } catch { return undefined }
}

export function uniqueSearchSources(values: readonly unknown[]): SearchSource[] {
  const rows = new Map<string, SearchSource>()
  for (const value of values) {
    const source = searchSource(value)
    if (!source) continue
    const previous = rows.get(source.url)
    if (previous) rows.set(source.url, { ...previous, ...(isRecord(value) && typeof value.title === 'string' && value.title ? { title: source.title } : {}), ...(source.content ? { content: source.content } : {}) })
    else if (rows.size < 100) rows.set(source.url, source)
  }
  return [...rows.values()]
}

/** Both complete output and finished incremental items use this documented shape. */
export function responsesSearchEvidence(items: readonly unknown[]): { sources: SearchSource[]; searched: boolean; error?: string } {
  const sources: unknown[] = []
  let searched = false
  for (const item of items) {
    if (!isRecord(item)) continue
    if (item.type === 'web_search_call') {
      if (item.status !== 'completed' || item.error !== undefined) return { sources: [], searched: false, error: 'Provider web search did not complete successfully' }
      searched = true
      if (isRecord(item.action) && item.action.sources !== undefined) {
        if (!Array.isArray(item.action.sources)) return { sources: [], searched: false, error: 'Provider web search sources are malformed' }
        sources.push(...item.action.sources)
      }
    } else if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) if (isRecord(part) && part.type === 'output_text' && Array.isArray(part.annotations)) {
        sources.push(...part.annotations.filter(annotation => isRecord(annotation) && annotation.type === 'url_citation'))
      }
    }
  }
  return { sources: searched ? uniqueSearchSources(sources) : [], searched }
}

/** Terminal output must enumerate every streamed call with an unambiguous ID.
 * This validates reported invocations after buffering, not provider-side spend. */
export function responsesSearchAccounting(terminal: unknown, streamed: readonly unknown[]): { calls?: number; complete: boolean } {
  if (!Array.isArray(terminal) || terminal.some(item => !isRecord(item) || typeof item.type !== 'string')) return { complete: false }
  const calls = new Set<string>()
  for (const item of terminal) {
    if (item.type !== 'web_search_call') continue
    if (typeof item.id !== 'string' || !item.id.trim() || item.status !== 'completed' || calls.has(item.id)) return { complete: false }
    calls.add(item.id)
  }
  for (const item of streamed) {
    if (!isRecord(item) || item.type !== 'web_search_call') continue
    if (typeof item.id !== 'string' || !item.id.trim() || item.status !== 'completed' || !calls.has(item.id)) return { complete: false }
  }
  return { calls: calls.size, complete: true }
}
