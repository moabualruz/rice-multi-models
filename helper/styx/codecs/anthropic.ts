// Copied from Trosfy/claude-styx styxd/codecs/anthropic.ts at 5072384
// (MIT, Copyright (c) 2026 styx contributors; see LICENSES/claude-styx.MIT.txt).
// Modified by Mo Abualruz: import paths for this layout.
// The `anthropic` kind (the Messages API): request bodies from the normalized transcript, and a decoder for
// the provider's SSE stream. Pure. The key's header is the transport's, by the provider's `authHeader`.
import { isObject } from '../../../hooks/config'
import { str } from '../../../hooks/transcript'
import { count, decoderOver, lastUsers, lostThinking, obj, params, parseJson, sseReader, thinkingReader } from '../codec'
import type { Codec, Sink } from '../codec'
import { anthropicFailureCause } from '../errors'
import type { Message } from '../history'
import { uniqueSearchSources } from '../../core/search.ts'

type Json = Record<string, unknown>
type Block = Message['content'][number]

// The transcript as Messages turns. Normalized blocks already have the API's shapes; a tool_result carries
// is_error only when true, an empty text block (the API refuses it) goes, and a turn's tool results come
// first (the API requires it).
export function toMessages(messages: readonly Message[]) {
  const live = (b: Block) => !(b.type === 'text' && b.text === '')
  const wire = (b: Block) => (b.type === 'tool_result' ? { type: b.type, tool_use_id: b.tool_use_id, content: b.content.filter(live), ...(b.is_error ? { is_error: true } : {}) } : b)
  const first = (b: { type: string }) => Number(b.type === 'tool_result')
  return messages
    .map(({ role, content }) => ({ role, content: content.filter(live).map(wire).sort((a, b) => first(b) - first(a)) }))
    .filter(m => m.content.length > 0)
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== ''

// Each usage count and the field that carries it.
const COUNTS = { in: 'input_tokens', out: 'output_tokens', cacheRead: 'cache_read_input_tokens', cacheWrite: 'cache_creation_input_tokens' } as const
type Held = { id?: string; name: string; json: string; input: unknown }

// A decoder for one response, read by each event's own `type`. Text and thinking deltas pass as they arrive;
// a tool call is held, by its block index, until its block stops, and so is each thinking block, which then
// passes whole if it is signed. After an error nothing more is read.
function decoder() {
  const held = new Map<unknown, Held>()
  const thinking = thinkingReader()
  // The latest of each count seen: message_start may carry zeros, message_delta the totals.
  const usage = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }
  let finished = false
  const searchBlocks = new Map<unknown, Json>()
  const fetchBlocks = new Set<unknown>()
  const searchSources: unknown[] = []
  let searched = false

  function searchResult(s: Sink, block: Json): boolean {
    if (block['type'] !== 'web_search_tool_result') return false
    const content = block['content']
    if (isObject(content) && content['type'] === 'web_search_tool_result_error') { s.fail(`Anthropic web search failed: ${str(content['error_code']) || 'unknown'}`); return true }
    if (!Array.isArray(content)) { s.fail('Anthropic web search result is malformed'); return true }
    if (content.some(value => !isObject(value) || value['type'] !== 'web_search_result' || typeof value['url'] !== 'string' || typeof value['title'] !== 'string')) { s.fail('Anthropic web search result is malformed'); return true }
    searched = true
    searchSources.push(...content.map(value => ({ title: value['title'], url: value['url'] })))
    return true
  }

  function fetchResult(s: Sink, block: Json): boolean {
    if (block['type'] !== 'web_fetch_tool_result') return false
    s.out.push({ t: 'native_block', block })
    return true
  }

  function take(u: Json) {
    for (const [key, field] of Object.entries(COUNTS) as [keyof typeof COUNTS, string][]) usage[key] = Math.max(usage[key], count(u[field]))
  }
  function event(s: Sink, data: string) {
    const { out, fail } = s
    const ev = parseJson(data)
    if (!isObject(ev)) return fail(`unparseable stream data: ${data.slice(0, 200)}`)
    const delta = obj(ev['delta'])
    const block = obj(ev['content_block'])
    switch (ev['type']) {
      case 'error':
        return fail(JSON.stringify(ev['error'] ?? ev), anthropicFailureCause(ev['error'] ?? ev))
      case 'message_start':
        return take(obj(obj(ev['message'])['usage']))
      case 'content_block_start':
        if (block['type'] === 'web_fetch_tool_result') { fetchBlocks.add(ev['index']); fetchResult(s, block); return }
        if (block['type'] === 'web_search_tool_result') { searchBlocks.set(ev['index'], block); searchResult(s, block); return }
        if (block['type'] === 'tool_use') held.set(ev['index'], { ...(typeof block['id'] === 'string' ? { id: block['id'] } : {}), name: typeof block['name'] === 'string' ? block['name'] : '', json: '', input: block['input'] })
        else if (block['type'] === 'thinking') thinking.add(ev['index'], { text: str(block['thinking']), signature: str(block['signature']) })
        else if (block['type'] === 'redacted_thinking') thinking.add(ev['index'], { redacted: str(block['data']) })
        return
      case 'content_block_delta': {
        if (delta['type'] === 'citations_delta' && isObject(delta['citation']) && delta['citation']['type'] === 'web_search_result_location') {
          searchSources.push({ title: delta['citation']['title'], url: delta['citation']['url'], content: delta['citation']['cited_text'] })
          return
        }
        if (delta['type'] === 'text_delta' && nonEmpty(delta['text'])) out.push({ t: 'text', text: delta['text'] })
        else if (delta['type'] === 'thinking_delta' && nonEmpty(delta['thinking'])) {
          out.push({ t: 'thinking', text: delta['thinking'] })
          thinking.add(ev['index'], { text: delta['thinking'] })
        } else if (delta['type'] === 'signature_delta') thinking.add(ev['index'], { signature: str(delta['signature']) })
        else if (delta['type'] === 'input_json_delta' && typeof delta['partial_json'] === 'string' && held.has(ev['index'])) (held.get(ev['index']) as Held).json += delta['partial_json']
        return
      }
      case 'content_block_stop': {
        if (fetchBlocks.has(ev['index'])) { fetchBlocks.delete(ev['index']); return }
        if (searchBlocks.has(ev['index'])) { searchBlocks.delete(ev['index']); return }
        const block = thinking.seal(ev['index'])
        if (block !== undefined) return void out.push({ t: 'sealed', block })
        const h = held.get(ev['index'])
        if (h === undefined) return
        held.delete(ev['index'])
        const args = h.json !== '' ? h.json : isObject(h.input) ? h.input : ''
        return void out.push({ t: 'tool', ...(h.id === undefined ? {} : { id: h.id }), name: h.name, args })
      }
      case 'message_delta':
        take(obj(ev['usage']))
        out.push({ t: 'usage', ...usage })
        if (typeof delta['stop_reason'] === 'string') {
          finished = true
          if (searched) out.push({ t: 'search_sources', sources: uniqueSearchSources(searchSources), searched: true })
          out.push({ t: 'finish', reason: delta['stop_reason'] })
        }
    }
  }
  return decoderOver(sseReader(), event, ({ fail }) => {
    if (fetchBlocks.size > 0) fail('the stream ended inside a web fetch result')
    else if (searchBlocks.size > 0) fail('the stream ended inside a web search result')
    else if (held.size > 0) fail('the stream ended inside a tool call')
    else if (!finished) fail('the stream ended with no stop reason')
  })
}

export const anthropic: Codec = {
  encode(n, p, m) {
    if (m.maxOutputTokens === undefined) throw new Error(`rice-multi-models: ${p.id}/${m.id} requires an explicit maxOutputTokens request policy because its output limit was not reported`)
    const tools = m.tools ? n.tools : []
    const base: Json = { max_tokens: m.maxOutputTokens }
    if (!m.parallelToolCalls && tools.length > 0) base['tool_choice'] = { type: 'auto', disable_parallel_tool_use: true }
    const { body, level } = params(base, p, m, n.effort)
    // A tool turn whose signed thinking is lost goes without the thinking param: the API wants the blocks back.
    const lost = lostThinking(body['thinking'], n.messages)
    if (lost) delete body['thinking']
    // The cache mark goes on the last system block, the last tool and the last block of the last two user turns.
    const mark = m.cache === undefined ? {} : { cache_control: { type: 'ephemeral', ttl: m.cache } }
    const messages = toMessages(n.messages)
    for (const turn of lastUsers(messages)) turn.content = turn.content.map((b, i, all) => (i === all.length - 1 ? { ...b, ...mark } : b))
    const sent = {
      ...body,
      model: m.id,
      ...(n.system === '' ? {} : { system: m.cache === undefined ? n.system : [{ type: 'text', text: n.system, ...mark }] }),
      messages,
      ...(tools.length > 0 ? { tools: tools.map((t, i) => ({ name: t.name, description: t.description, input_schema: t.schema, ...(i === tools.length - 1 ? mark : {}) })) } : {}),
      stream: true,
    }
    return { path: '/v1/messages', body: JSON.stringify(sent), headers: { 'anthropic-version': '2023-06-01' }, effort: level ?? 'none', ...(lost ? { lost } : {}) }
  },
  decoder,
  errorCause: anthropicFailureCause,
  stops: { end_turn: 'end_turn', max_tokens: 'max_tokens', tool_use: 'tool_use', stop_sequence: 'end_turn', refusal: 'refusal' },
}
