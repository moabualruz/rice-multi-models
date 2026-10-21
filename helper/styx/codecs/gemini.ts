// The `gemini` kind: Google generateContent request bodies from the normalized transcript, and a decoder for
// its SSE stream (`:streamGenerateContent?alt=sse`). A part's thought signature, which Gemini 3 needs back on
// the first function call of each model turn, is kept as a thinking block's signature placed before the part;
// a call whose signature is not held goes back with the validator skip Google documents
// (https://ai.google.dev/gemini-api/docs/thought-signatures). Tool schemas go as `parametersJsonSchema`, as the
// AI SDK's Google provider sends them. Pure. Written for rice-multi-models on the shape of claude-styx's codecs.
import { isObject } from '../../../hooks/config'
import type { ModelConfig } from '../../../hooks/config'
import { decoderOver, isIndex, params, parseJson, sseReader } from '../codec'
import type { Codec, Neutral, Sink } from '../codec'
import { uniqueSearchSources } from '../../core/search.ts'

type Json = Record<string, unknown>
type Part =
  | { text: string; thoughtSignature?: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args: Json }; thoughtSignature?: string }
  | { functionResponse: { name: string; response: { name: string; content: string } } }
type Content = { role: 'user' | 'model'; parts: Part[] }

const SEAL = 'gemini:'
export const SKIP_SIGNATURE = 'skip_thought_signature_validator'
export const sealSignature = (signature: string) => `${SEAL}${signature}`
// The models that refuse a function call replayed without its turn's signature.
const signs = (m: Pick<ModelConfig, 'id'>) => /gemini-(?:[3-9]|\d{2,})/.test(m.id)

// The request's contents. A model turn's first call carries the signature held before it, else the skip; a
// text part carries one held before it. A tool result answers by its call's name, with its images after it.
export function toContents(n: Neutral, m: Pick<ModelConfig, 'id'>): Content[] {
  const names = new Map<string, string>()
  const out: Content[] = []
  for (const msg of n.messages) {
    const parts: Part[] = []
    if (msg.role === 'assistant') {
      let held: string | undefined
      let called = false
      for (const b of msg.content) {
        if (b.type === 'thinking' && b.signature.startsWith(SEAL)) held = b.signature.slice(SEAL.length)
        else if (b.type === 'text' && b.text !== '') {
          parts.push({ text: b.text, ...(held === undefined ? {} : { thoughtSignature: held }) })
          held = undefined
        } else if (b.type === 'tool_use') {
          names.set(b.id, b.name)
          const signature = held ?? (!called && signs(m) ? SKIP_SIGNATURE : undefined)
          parts.push({ functionCall: { name: b.name, args: b.input }, ...(signature === undefined ? {} : { thoughtSignature: signature }) })
          held = undefined
          called = true
        }
      }
      if (parts.length > 0) out.push({ role: 'model', parts })
      continue
    }
    const images: Part[] = []
    for (const b of msg.content) {
      if (b.type === 'tool_result') {
        const body = b.content.flatMap(c => (c.type === 'text' ? [c.text] : [])).join('\n')
        const name = names.get(b.tool_use_id) ?? 'tool'
        parts.push({ functionResponse: { name, response: { name, content: b.is_error ? `Error: ${body}` : body || 'Tool executed successfully.' } } })
        for (const c of b.content) if (c.type === 'image') images.push(c.source.type === 'base64' ? { inlineData: { mimeType: c.source.media_type, data: c.source.data } } : { text: `[image: ${c.source.url}]` })
      } else if (b.type === 'text') parts.push({ text: b.text })
      else if (b.type === 'image') parts.push(b.source.type === 'base64' ? { inlineData: { mimeType: b.source.media_type, data: b.source.data } } : { text: `[image: ${b.source.url}]` })
    }
    const all = [...parts.filter(p => 'functionResponse' in p), ...images, ...parts.filter(p => !('functionResponse' in p))]
    if (all.length > 0) out.push({ role: 'user', parts: all })
  }
  return out
}

const count = (v: unknown) => (isIndex(v) ? v : 0)

// A decoder for one response: each chunk's parts in order (a signature sealed ahead of its part, thoughts as
// thinking, text, whole calls), the last usage seen, and the finish when the stream ends.
function decoder() {
  let finish: string | undefined
  let usage: Json | undefined
  let calls = 0
  let searched = false
  const searchSources: unknown[] = []
  const fetchSources = new Map<string, string>()

  function chunk(s: Sink, data: string) {
    const c = parseJson(data)
    if (!isObject(c)) return s.fail(`unparseable stream data: ${data.slice(0, 200)}`)
    if (c['error'] !== undefined) return s.fail(JSON.stringify(c['error']))
    if (isObject(c['usageMetadata'])) usage = c['usageMetadata']
    const blocked = isObject(c['promptFeedback']) ? c['promptFeedback']['blockReason'] : undefined
    if (typeof blocked === 'string') finish = 'safety'
    const candidate = Array.isArray(c['candidates']) ? c['candidates'][0] : undefined
    if (!isObject(candidate)) return
    const fetched = candidate['url_context_metadata']
    if (fetched !== undefined) {
      if (!isObject(fetched) || !Array.isArray(fetched['url_metadata']) || fetched['url_metadata'].length > 20) return s.fail('Gemini URL Context metadata is malformed')
      for (const row of fetched['url_metadata']) {
        if (!isObject(row) || typeof row['retrieved_url'] !== 'string' || typeof row['url_retrieval_status'] !== 'string') return s.fail('Gemini URL Context metadata is malformed')
        fetchSources.set(row['retrieved_url'], row['url_retrieval_status'])
      }
    }
    const grounding = candidate['groundingMetadata']
    if (isObject(grounding)) {
      const queries = grounding['webSearchQueries']
      const chunks = grounding['groundingChunks']
      if (Array.isArray(queries) && queries.some(query => typeof query === 'string' && query.trim())) searched = true
      if (Array.isArray(chunks)) for (const [index, chunk] of chunks.entries()) {
        if (isObject(chunk) && isObject(chunk['web'])) {
          searched = true
          const supports = Array.isArray(grounding['groundingSupports']) ? grounding['groundingSupports'] : []
          const snippets = supports.flatMap(support => isObject(support) && Array.isArray(support['groundingChunkIndices']) && support['groundingChunkIndices'].includes(index) && isObject(support['segment']) && typeof support['segment']['text'] === 'string' ? [support['segment']['text']] : [])
          searchSources.push({ title: chunk['web']['title'], url: chunk['web']['uri'], ...(snippets.length ? { content: snippets.join('\n') } : {}) })
        }
      }
    }
    const content = isObject(candidate['content']) ? candidate['content'] : {}
    for (const part of Array.isArray(content['parts']) ? content['parts'] : []) {
      if (!isObject(part)) return s.fail('a part is not an object')
      if (typeof part['thoughtSignature'] === 'string' && part['thoughtSignature'] !== '') s.out.push({ t: 'sealed', block: { type: 'thinking', thinking: '', signature: sealSignature(part['thoughtSignature']) } })
      const call = part['functionCall']
      if (isObject(call)) {
        if (typeof call['name'] !== 'string') return s.fail('a function call has no name')
        calls++
        s.out.push({ t: 'tool', ...(typeof call['id'] === 'string' ? { id: call['id'] } : {}), name: call['name'], args: isObject(call['args']) ? call['args'] : {} })
      } else if (typeof part['text'] === 'string' && part['text'] !== '') s.out.push({ t: part['thought'] === true ? 'thinking' : 'text', text: part['text'] })
    }
    const reason = candidate['finishReason']
    if (typeof reason === 'string' && reason !== '' && reason !== 'FINISH_REASON_UNSPECIFIED') finish = reason.toLowerCase()
  }
  function end(s: Sink) {
    if (finish === undefined) return s.fail('the stream ended with no finish reason')
    if (finish === 'malformed_function_call' || finish === 'unexpected_tool_call') return s.fail(`Gemini ended the response with ${finish.toUpperCase()}`)
    if (usage !== undefined) {
      const cached = count(usage['cachedContentTokenCount'])
      const thoughts = count(usage['thoughtsTokenCount'])
      const input = count(usage['promptTokenCount']) + count(usage['toolUsePromptTokenCount'])
      s.out.push({ t: 'usage', in: Math.max(0, input - cached), out: count(usage['candidatesTokenCount']) + thoughts, cacheRead: cached, cacheWrite: 0, ...(thoughts > 0 ? { reasoning: thoughts } : {}) })
    }
    if (searched) s.out.push({ t: 'search_sources', sources: uniqueSearchSources(searchSources), searched: true })
    if (fetchSources.size > 0) s.out.push({ t: 'native_block', block: { type: 'gemini_url_context_result', url_metadata: [...fetchSources].map(([retrieved_url, url_retrieval_status]) => ({ retrieved_url, url_retrieval_status })) } })
    s.out.push({ t: 'finish', reason: finish === 'stop' && calls > 0 ? 'tool_calls' : finish })
  }
  return decoderOver(sseReader(), chunk, end)
}

export const gemini: Codec = {
  encode(n, p, m) {
    const tools = m.tools ? n.tools : []
    const { body, level } = params({}, p, m, n.effort)
    const generation = isObject(body['generationConfig']) ? body['generationConfig'] : {}
    const sent = {
      ...body,
      ...(m.maxOutputTokens === undefined ? {} : { generationConfig: { ...generation, maxOutputTokens: Math.min(m.maxOutputTokens, typeof generation['maxOutputTokens'] === 'number' ? generation['maxOutputTokens'] : Infinity) } }),
      contents: toContents(n, m),
      ...(n.system.trim() === '' ? {} : { systemInstruction: { parts: [{ text: n.system }] } }),
      ...(tools.length > 0
        ? { tools: [{ functionDeclarations: tools.map(t => ({ name: t.name, description: t.description, parametersJsonSchema: t.schema })) }], toolConfig: { functionCallingConfig: { mode: 'AUTO' } } }
        : {}),
    }
    return { path: `/models/${encodeURIComponent(m.id)}:streamGenerateContent?alt=sse`, body: JSON.stringify(sent), effort: level ?? 'none' }
  },
  decoder,
  stops: {
    stop: 'end_turn',
    tool_calls: 'tool_use',
    max_tokens: 'max_tokens',
    safety: 'refusal',
    recitation: 'refusal',
    blocklist: 'refusal',
    prohibited_content: 'refusal',
    spii: 'refusal',
    image_safety: 'refusal',
  },
}
