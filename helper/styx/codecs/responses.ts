// The `responses` kind: OpenAI Responses API request bodies from the normalized transcript, and a decoder for
// its SSE stream. Nothing is stored upstream (`store: false`), so each request carries the whole conversation;
// a tool turn's reasoning goes back as the encrypted item the model wrote, kept meanwhile as a thinking block's
// signature. Pure. Written for rice-multi-models on the shape of claude-styx's codecs (see ./openai.ts).
import { isObject } from '../../../hooks/config'
import { decoderOver, isIndex, params, parseJson, sseReader } from '../codec'
import type { Codec, Neutral, Sink } from '../codec'
import type { Image, Text, Thinking } from '../history'

type Json = Record<string, unknown>
type Content = { type: 'input_text' | 'output_text'; text: string } | { type: 'input_image'; image_url: string; detail: 'auto' }
type Item =
  | { role: 'user' | 'assistant'; content: Content[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }
  | { type: 'reasoning'; id?: string; encrypted_content: string; summary: { type: 'summary_text'; text: string }[] }

// A reasoning item kept as a thinking block's signature: its id and encrypted content, behind a prefix no
// Anthropic signature carries.
const SEAL = 'responses:'
export const sealReasoning = (id: string | undefined, encrypted: string) => `${SEAL}${JSON.stringify({ id, encrypted })}`

function reasoningItem(b: Thinking): Item | undefined {
  if (b.type !== 'thinking' || !b.signature.startsWith(SEAL)) return undefined
  const held = parseJson(b.signature.slice(SEAL.length))
  if (!isObject(held) || typeof held['encrypted'] !== 'string') return undefined
  return {
    type: 'reasoning',
    ...(typeof held['id'] === 'string' ? { id: held['id'] } : {}),
    encrypted_content: held['encrypted'],
    summary: b.thinking === '' ? [] : [{ type: 'summary_text', text: b.thinking }],
  }
}

const toContent = (b: Text | Image): Content =>
  b.type === 'text' ? { type: 'input_text', text: b.text } : { type: 'input_image', image_url: b.source.type === 'url' ? b.source.url : `data:${b.source.media_type};base64,${b.source.data}`, detail: 'auto' }

// The request's input items: an assistant turn's text, calls and held reasoning in their order; tool results as
// `function_call_output` items ahead of their message's other content, and their images in a user message after them.
export function toInput(n: Neutral): Item[] {
  const out: Item[] = []
  for (const msg of n.messages) {
    if (msg.role === 'assistant') {
      let text = ''
      const flush = () => {
        if (text !== '') out.push({ role: 'assistant', content: [{ type: 'output_text', text }] })
        text = ''
      }
      for (const b of msg.content) {
        if (b.type === 'text') text += b.text
        else if (b.type === 'tool_use') {
          flush()
          out.push({ type: 'function_call', call_id: b.id, name: b.name, arguments: JSON.stringify(b.input) })
        } else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
          const item = reasoningItem(b)
          if (item !== undefined) (flush(), out.push(item))
        }
      }
      flush()
      continue
    }
    const parts: Content[] = []
    const moved: Content[] = []
    for (const b of msg.content) {
      if (b.type === 'tool_result') {
        const body = b.content.flatMap(c => (c.type === 'text' ? [c.text] : [])).join('\n')
        moved.push(...b.content.filter(c => c.type === 'image').map(toContent))
        out.push({ type: 'function_call_output', call_id: b.tool_use_id, output: b.is_error ? `Error: ${body}` : body })
      } else if (b.type === 'text' || b.type === 'image') parts.push(toContent(b))
    }
    const all = [...moved, ...parts]
    if (all.length > 0) out.push({ role: 'user', content: all })
  }
  return out
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

// A decoder for one response. Text and reasoning deltas pass as they arrive; a call is read whole at its
// item's end, and a reasoning item with encrypted content is sealed there. The response's end gives the usage
// and the finish: `tool_calls` after any call, `stop`, or why it was incomplete.
function decoder() {
  const args = new Map<unknown, string>()
  const thought = new Set<unknown>()
  let calls = 0
  let ended = false

  function item(s: Sink, it: Json, index: unknown) {
    if (it['type'] === 'function_call') {
      const name = str(it['name'])
      const whole = typeof it['arguments'] === 'string' && it['arguments'] !== '' ? it['arguments'] : (args.get(index) ?? '')
      calls++
      s.out.push({ t: 'tool', ...(typeof it['call_id'] === 'string' ? { id: it['call_id'] } : {}), name, args: whole })
    } else if (it['type'] === 'reasoning') {
      const summary = Array.isArray(it['summary']) ? it['summary'].flatMap(p => (isObject(p) && typeof p['text'] === 'string' ? [p['text']] : [])).join('\n\n') : ''
      if (!thought.has(index) && summary !== '') s.out.push({ t: 'thinking', text: summary })
      const encrypted = it['encrypted_content']
      if (typeof encrypted === 'string' && encrypted !== '') {
        s.out.push({ t: 'sealed', block: { type: 'thinking', thinking: summary, signature: sealReasoning(typeof it['id'] === 'string' ? it['id'] : undefined, encrypted) } })
      }
    }
  }
  function done(s: Sink, r: Json, status: string) {
    ended = true
    const u = r['usage']
    if (isObject(u) && isIndex(u['input_tokens']) && isIndex(u['output_tokens'])) {
      const cached = isObject(u['input_tokens_details']) && isIndex(u['input_tokens_details']['cached_tokens']) ? u['input_tokens_details']['cached_tokens'] : 0
      const reasoning = isObject(u['output_tokens_details']) ? u['output_tokens_details']['reasoning_tokens'] : undefined
      s.out.push({ t: 'usage', in: Math.max(0, u['input_tokens'] - cached), out: u['output_tokens'], cacheRead: cached, cacheWrite: 0, ...(isIndex(reasoning) ? { reasoning } : {}) })
    }
    const why = isObject(r['incomplete_details']) ? str(r['incomplete_details']['reason']) : ''
    s.out.push({ t: 'finish', reason: status === 'incomplete' ? why || 'incomplete' : calls > 0 ? 'tool_calls' : 'stop' })
  }
  function event(s: Sink, data: string) {
    const e = parseJson(data)
    if (!isObject(e)) return s.fail(`unparseable stream data: ${data.slice(0, 200)}`)
    const type = str(e['type'])
    const index = e['output_index'] ?? e['item_id']
    if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
      if (str(e['delta']) !== '') s.out.push({ t: 'text', text: str(e['delta']) })
    } else if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
      thought.add(index)
      if (str(e['delta']) !== '') s.out.push({ t: 'thinking', text: str(e['delta']) })
    } else if (type === 'response.reasoning_summary_part.added') {
      if (isIndex(e['summary_index']) && e['summary_index'] > 0) s.out.push({ t: 'thinking', text: '\n\n' })
    } else if (type === 'response.function_call_arguments.delta') {
      args.set(index, (args.get(index) ?? '') + str(e['delta']))
    } else if (type === 'response.output_item.done') {
      if (isObject(e['item'])) item(s, e['item'], index)
    } else if (type === 'response.completed' || type === 'response.incomplete') {
      done(s, isObject(e['response']) ? e['response'] : {}, type === 'response.incomplete' ? 'incomplete' : 'completed')
    } else if (type === 'response.failed') {
      const r = isObject(e['response']) ? e['response'] : {}
      s.fail(JSON.stringify(r['error'] ?? { message: 'the response failed' }))
    } else if (type === 'error') s.fail(JSON.stringify(isObject(e['error']) ? e['error'] : { message: str(e['message']) || 'stream error', code: e['code'] }))
  }
  return decoderOver(
    sseReader(),
    (s, data) => (data.trim() === '[DONE]' ? undefined : event(s, data)),
    s => (ended ? undefined : s.fail('the stream ended with no response.completed')),
  )
}

export const responses: Codec = {
  encode(n, p, m) {
    const tools = m.tools ? n.tools : []
    const base: Json = { store: false, include: ['reasoning.encrypted_content'], ...(n.cacheKey === undefined ? {} : { prompt_cache_key: n.cacheKey }) }
    if (!m.parallelToolCalls && tools.length > 0) base['parallel_tool_calls'] = false
    const { body, level } = params(base, p, m, n.effort)
    const sent = {
      ...body,
      model: m.id,
      instructions: n.system,
      input: toInput(n),
      ...(tools.length > 0 ? { tools: tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.schema, strict: false })), tool_choice: 'auto' } : {}),
      stream: true,
    }
    return { path: '/responses', body: JSON.stringify(sent), effort: level ?? 'none' }
  },
  decoder,
  stops: { stop: 'end_turn', tool_calls: 'tool_use', max_output_tokens: 'max_tokens', content_filter: 'refusal' },
}
