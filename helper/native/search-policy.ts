import type { SearchSource, StepEvent, StepWire, WebSearch } from '../../hooks/protocol.ts'
import type { Target } from '../../hooks/config.ts'
import type { NativeRequest } from './requests.ts'
import type { NativeSearchInput } from './ownership.ts'
import { record } from './ownership.ts'
import { domainMatches, retrieve, searchStep } from './search.ts'
import { providerSearch, ollamaSearch } from '../search/provider.ts'
import { searchEndpoints, SearchUnavailable } from '../search/endpoints.ts'
import { splitTarget } from '../../hooks/protocol.ts'

type Direct = (wire: StepWire, signal: AbortSignal) => AsyncIterable<StepEvent>
type Remote = Pick<Extract<Target, { kind: 'remote' }>, 'provider' | 'model' | 'target'>
export type SearchObservation = { phase: 'search'; stage: 'query'; queryKnown: boolean }
  | { phase: 'search'; stage: 'provider' | 'configured' | 'claude'; status: 'success' | 'unavailable' }

export function searchRestrictions(tool: Record<string, unknown>): WebSearch {
  const list = (key: string): string[] | undefined => {
    const value = tool[key]
    if (value === undefined) return undefined
    if (!Array.isArray(value) || !value.every(rule => typeof rule === 'string' && !!rule && !/^[a-z]+:\/\//i.test(rule) && !/[?#@\s]/.test(rule))) throw new SearchUnavailable('Invalid native search domain filter.')
    return value
  }
  const max = tool.max_uses
  if (max !== undefined && (!Number.isSafeInteger(max) || Number(max) < 1 || Number(max) > 20)) throw new SearchUnavailable('Invalid native search use bound.')
  const allowedDomains = list('allowed_domains'), blockedDomains = list('blocked_domains')
  if (allowedDomains?.length && blockedDomains?.length) throw new SearchUnavailable('Native search supports one domain filter list.')
  return { ...(allowedDomains ? { allowedDomains } : {}), ...(blockedDomains ? { blockedDomains } : {}), ...(typeof max === 'number' ? { maxUses: max } : {}), ...(record(tool.user_location) ? { location: tool.user_location } : {}) }
}

/** No output is visible until an entire bounded search attempt has succeeded. */
export async function collectSearch(events: AsyncIterable<StepEvent>, signal: AbortSignal, evidenceRequired: boolean): Promise<StepEvent[]> {
  const found: StepEvent[] = []; let bytes = 0, stopped = false, searched = false
  for await (const event of events) {
    signal.throwIfAborted()
    bytes += Buffer.byteLength(JSON.stringify(event))
    if (found.length >= 2048 || bytes > 2 * 1024 * 1024) throw new SearchUnavailable('Search response exceeds its size limit.')
    if (event.type === 'error') throw new SearchUnavailable('Provider search is unavailable.')
    if (event.type === 'search_sources' && event.searched) searched = true
    if (event.type === 'stop') stopped = true
    found.push(event)
  }
  if (!stopped || evidenceRequired && !searched) throw new SearchUnavailable('Provider did not complete a web search.')
  return found
}

export function searchBlocks(query: string, sources: SearchSource[], text?: string): StepEvent[] {
  const id = `srvtoolu_rice_${crypto.randomUUID().replaceAll('-', '')}`
  return [
    { type: 'native_block', block: { type: 'server_tool_use', id, name: 'web_search', input: { query } } },
    { type: 'native_block', block: { type: 'web_search_tool_result', tool_use_id: id, content: sources.map(source => ({ type: 'web_search_result', title: source.title, url: source.url, encrypted_content: '' })) } },
    { type: 'text', text: text || (sources.length ? sources.map(source => `${source.title}\n${source.url}${source.content ? `\n${source.content}` : ''}`).join('\n\n') : 'No web search results were found.') },
    { type: 'stop', reason: 'end_turn' },
  ]
}

export async function directSearch(wire: StepWire, native: NativeRequest, input: NativeSearchInput | undefined, remote: Remote | undefined, signal: AbortSignal, direct: Direct, observe?: (event: SearchObservation) => void): Promise<StepEvent[]> {
  const tool = native.serverTools[0], restrictions = searchRestrictions(tool)
  observe?.({ phase: 'search', stage: 'query', queryKnown: !!input })
  const method = providerSearch(wire.req.target, remote, restrictions)
  if (method) {
    try {
      let events: StepEvent[]
      if (method === 'ollama') {
        if (!input || !remote || restrictions.location) throw new SearchUnavailable('Selected cloud search cannot execute this request.')
        events = await ollamaSearch(wire, remote, input.query, signal)
      } else {
        const req = { ...wire.req, tools: [], native: { ...wire.req.native, webSearch: restrictions, toolChoice: undefined, outputSchema: undefined } }
        const attempt = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        events = await collectSearch(direct({ ...wire, req }, attempt), attempt, true)
        if (!remote && splitTarget(wire.req.target)?.provider === 'codex' && restrictions.maxUses !== undefined) {
          const accounting = events.findLast(event => event.type === 'search_sources')
          if (accounting?.type !== 'search_sources' || accounting.complete !== true || !Number.isSafeInteger(accounting.calls) || Number(accounting.calls) < 1 || Number(accounting.calls) > restrictions.maxUses) throw new SearchUnavailable('Provider search invocation accounting cannot satisfy the native bound.')
        }
      }
      const sources = events.flatMap(event => event.type === 'search_sources' && event.searched ? event.sources : [])
        .filter(source => (!restrictions.allowedDomains?.length || restrictions.allowedDomains.some(rule => domainMatches(source.url, rule))) && !restrictions.blockedDomains?.some(rule => domainMatches(source.url, rule)))
      const answer = restrictions.allowedDomains?.length || restrictions.blockedDomains?.length ? undefined : events.filter(event => event.type === 'text').map(event => event.text).join('')
      observe?.({ phase: 'search', stage: 'provider', status: 'success' })
      return [...events.filter(event => ['usage', 'limits', 'stats'].includes(event.type)), ...searchBlocks(input?.query ?? 'Web search', sources, answer)]
    } catch { signal.throwIfAborted(); observe?.({ phase: 'search', stage: 'provider', status: 'unavailable' }) }
  }
  try {
    if (!searchEndpoints().length) throw new SearchUnavailable('No search service is configured.')
    const events = input ? searchBlocks(input.query, await retrieve(input.query, tool, signal))
      : await collectSearch(searchStep(wire, native, signal, direct, retrieve, remote?.model.tools !== false), signal, false)
    observe?.({ phase: 'search', stage: 'configured', status: 'success' })
    return events
  } catch { signal.throwIfAborted(); observe?.({ phase: 'search', stage: 'configured', status: 'unavailable' }) }
  throw new SearchUnavailable('Provider and configured web search are unavailable.')
}

/** Detect native server-tool failures inside HTTP200 before making that response visible. */
export async function nativeSearchResponse(response: Response, signal: AbortSignal): Promise<{ response: Response; ok: boolean }> {
  if (!response.ok) return { response, ok: false }
  const reader = response.body?.getReader()
  if (!reader) return { response, ok: false }
  const chunks: Uint8Array[] = []; let size = 0
  try {
    while (true) { signal.throwIfAborted(); const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > 4 * 1024 * 1024) throw new SearchUnavailable('Native search response exceeds its size limit.'); chunks.push(item.value) }
  } finally { await reader.cancel() }
  const bytes = Buffer.concat(chunks), text = bytes.toString('utf8')
  let failed = false, searched = false, completed = false
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return }
    if (!record(value)) return
    if (value.type === 'error' || value.type === 'web_search_tool_result_error') failed = true
    if (value.type === 'message_stop' || value.type === 'message' && typeof value.stop_reason === 'string') completed = true
    if (value.type === 'web_search_tool_result' && Array.isArray(value.content)) searched = true
    if (value.type === 'message_delta' && value.delta && record(value.delta) && value.delta.stop_reason === 'refusal') failed = true
    for (const key of ['message', 'content', 'content_block']) if (value[key]) visit(value[key])
  }
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    for (const line of text.split('\n')) if (line.startsWith('data: ')) { try { visit(JSON.parse(line.slice(6))) } catch { failed = true } }
  } else { try { visit(JSON.parse(text)) } catch { failed = true } }
  return { response: new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers }), ok: searched && completed && !failed }
}
