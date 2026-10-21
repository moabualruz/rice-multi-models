// Copied from Trosfy/claude-styx styxd/history.ts at 5072384
// (MIT, Copyright (c) 2026 styx contributors; see LICENSES/claude-styx.MIT.txt).
// Modified by Mo Abualruz: import paths for this layout; Effort comes from hooks/protocol.
// The engine transcript as every codec reads it. Supported text, images, documents, tool calls and results
// are retained or translated by a codec. Unsupported blocks, reasoning, malformed documents and orphaned
// tool results become explicit text notes. Signed reasoning held for a routed turn is reinserted only for
// its owning model; cache metadata and unrelated fields are not replayed. Pure.
import { isObject } from '../../hooks/config'
import type { ApiMessage } from '../../hooks/protocol'
import { blocksOf, str } from '../../hooks/transcript'

export type Text = { type: 'text'; text: string }
export type Image = { type: 'image'; source: { type: 'url'; url: string } | { type: 'base64'; media_type: string; data: string } }
export type Document = { type: 'document'; title?: string; source: { type: 'base64'; media_type: 'application/pdf'; data: string } | { type: 'text'; media_type: 'text/plain'; data: string } }
type ToolUse = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
type ToolResult = { type: 'tool_result'; tool_use_id: string; content: (Text | Image | Document)[]; is_error: boolean }
// A thinking block as the model sent it, to be sent back whole: its text and signature, or the data of a
// redacted one.
export type Thinking = { type: 'thinking'; thinking: string; signature: string } | { type: 'redacted_thinking'; data: string }
// A thinking block and its place in its turn: how many of the turn's text and tool_use blocks came before it.
export type Placed = { at: number; block: Thinking }
// `unsealed` marks an assistant turn with tool calls whose thinking blocks were asked for and not held.
export type Message = { role: 'user' | 'assistant'; content: (Text | Image | Document | ToolUse | ToolResult | Thinking)[]; unsealed?: true }

// A block with a safe transcript representation. Documents support inline PDF and text only; every other
// source is named with the exact unsupported shape, without copying its URL, id or payload into the note.
function part(b: Record<string, unknown>, vision: boolean): Text | Image | Document {
  const type = str(b['type']) || 'unknown'
  if (type === 'text') {
    if (typeof b['text'] !== 'string') return { type: 'text', text: '[text block omitted: its text field is not a string]' }
    const text = b['text']
    return { type: 'text', text: Array.isArray(b['citations']) && b['citations'].length > 0 ? `${text}\n[citation metadata omitted: provider-specific annotations are not replayed]` : text }
  }
  if (type === 'image') {
    if (!vision) return { type: 'text', text: '[image omitted: model has no vision]' }
    const s = isObject(b['source']) ? b['source'] : {}
    if (s['type'] === 'url' && typeof s['url'] === 'string' && s['url'] !== '') return { type: 'image', source: { type: 'url', url: s['url'] } }
    if (s['type'] === 'base64' && typeof s['media_type'] === 'string' && typeof s['data'] === 'string' && s['data'] !== '') return { type: 'image', source: { type: 'base64', media_type: s['media_type'], data: s['data'] } }
    return { type: 'text', text: '[image omitted: source must contain a URL or inline base64 data with a media type]' }
  }
  if (type === 'document') {
    const source = isObject(b['source']) ? b['source'] : {}
    const title = typeof b['title'] === 'string' ? b['title'] : undefined
    if (source['type'] === 'base64' && source['media_type'] === 'application/pdf' && typeof source['data'] === 'string' && source['data'] !== '') {
      return { type: 'document', ...(title === undefined ? {} : { title }), source: { type: 'base64', media_type: 'application/pdf', data: source['data'] } }
    }
    if (source['type'] === 'text' && source['media_type'] === 'text/plain' && typeof source['data'] === 'string' && source['data'] !== '') {
      return { type: 'document', ...(title === undefined ? {} : { title }), source: { type: 'text', media_type: 'text/plain', data: source['data'] } }
    }
    if (source['type'] === 'url') return { type: 'text', text: '[document omitted: remote URL sources are not fetched by this adapter]' }
    if (source['type'] === 'file') return { type: 'text', text: '[document omitted: provider-scoped file identifiers cannot be replayed across routes]' }
    const mediaType = typeof source['media_type'] === 'string' ? source['media_type'] : 'unknown media type'
    return { type: 'text', text: `[document omitted: ${mediaType} source is unsupported; only inline application/pdf and text/plain are replayed]` }
  }
  if (type === 'tool_reference') return { type: 'text', text: `[tool loaded: ${str(b['tool_name']) || 'unknown'}]` }
  if (type === 'server_tool_use') return { type: 'text', text: `[server tool call ${str(b['name']) || 'unknown'} represented as text: this request exposes client tools only; the call was not reissued]` }
  if (type === 'web_search_tool_result') return { type: 'text', text: '[web_search_tool_result omitted: the routed request has no matching Claude-hosted server tool result block]' }
  return { type: 'text', text: `[${type} block omitted: no safe representation is defined for this routed provider request]` }
}

// `content` with each thinking block placed after the blocks it came after; one placed past the end goes last.
const interleave = (content: Message['content'], held: readonly Placed[]): Message['content'] => [
  ...content.flatMap((b, i) => [...held.filter(p => p.at === i).map(p => p.block), b]),
  ...held.filter(p => p.at >= content.length).map(p => p.block),
]

// The transcript normalized. `remoteId` gives the provider's own id behind an id styx minted for one of its
// calls, which goes out in its place. `sealed`, when given, gives the thinking blocks of the turn that made a
// call; a turn with calls and none held is marked `unsealed`.
export function normalize(messages: readonly ApiMessage[], vision: boolean, remoteId: (id: string) => string | undefined, sealed?: (id: string) => readonly Placed[] | undefined): Message[] {
  const out: Message[] = []
  const seen = new Set<string>()
  for (const msg of messages) {
    const content: Message['content'] = []
    let call: string | undefined
    let omittedThinking = false
    for (const b of blocksOf(msg)) {
      const type = b['type']
      if (type === 'thinking' || type === 'redacted_thinking') {
        omittedThinking = true
      } else if (msg.role === 'assistant' && type === 'tool_use') {
        const id = str(b['id'])
        const name = str(b['name'])
        if (id === '' || name === '' || !isObject(b['input'])) {
          content.push({ type: 'text', text: '[tool_use omitted: call id, name and object input are required for replay]' })
          continue
        }
        seen.add(id)
        call ??= id
        content.push({ type: 'tool_use', id: remoteId(id) ?? id, name, input: b['input'] })
      } else if (msg.role === 'user' && type === 'tool_result') {
        const id = str(b['tool_use_id'])
        if (!seen.has(id)) {
          content.push({ type: 'text', text: '[tool_result omitted: its matching tool_use is outside the normalized transcript window]' })
          continue
        }
        const raw = b['content']
        const parts: (Text | Image | Document)[] = typeof raw === 'string'
          ? [{ type: 'text', text: raw }]
          : Array.isArray(raw)
            ? raw.filter(isObject).map(c => part(c, vision))
            : []
        if (Array.isArray(raw) && raw.some(c => !isObject(c))) parts.push({ type: 'text', text: '[tool result content item omitted: content items must be objects]' })
        else if (raw !== undefined && (raw === null || typeof raw !== 'string' && !Array.isArray(raw))) parts.push({ type: 'text', text: '[tool result content omitted: content must be text or an array of content blocks]' })
        content.push({ type: 'tool_result', tool_use_id: remoteId(id) ?? id, content: parts, is_error: b['is_error'] === true })
      } else content.push(part(b, vision))
    }
    const blocks = call === undefined ? undefined : sealed?.(call)
    if (omittedThinking && (blocks === undefined || blocks.length === 0)) {
      content.unshift({ type: 'text', text: '[thinking omitted: provider-specific reasoning cannot be replayed without a held signature]' })
    }
    if (content.length > 0) out.push({ role: msg.role, content: blocks === undefined ? content : interleave(content, blocks), ...(call !== undefined && sealed !== undefined && blocks === undefined ? { unsealed: true as const } : {}) })
  }
  return out
}

// A map of the latest 256 entries within `limit` summed `size`; a key is set once.
function recent<V>(size: (v: V) => number, limit: number) {
  const map = new Map<string, V>()
  let total = 0
  return {
    get: (key: string) => map.get(key),
    set(key: string, v: V) {
      map.set(key, v)
      total += size(v)
      for (const [oldest, gone] of map) if (map.size > 256 || total > limit) (map.delete(oldest), (total -= size(gone)))
    },
  }
}

// The provider's own id behind each tool call styx minted, the latest 256, given back only to the provider
// that made it (another kind may reject its form).
export function remoteIds() {
  const ids = recent<{ provider: string; id: string }>(() => 0, Infinity)
  return {
    remember: (provider: string, minted: string, id: string) => ids.set(minted, { provider, id }),
    of: (provider: string) => (minted: string) => {
      const hit = ids.get(minted)
      return hit?.provider === provider ? hit.id : undefined
    },
  }
}

const THINKING_MAX_BYTES = 8 * 1024 * 1024
const bytesOf = (blocks: readonly Placed[]) => blocks.reduce((n, { block: b }) => n + (b.type === 'thinking' ? b.thinking.length + b.signature.length : b.data.length), 0)

// The thinking blocks of the turn that made each tool call styx minted (none, when the model did not think),
// the latest 256 calls within 8 MiB (counted once per call), given back only to the model that wrote them.
export function thinkingStore() {
  const turns = recent<{ owner: string; blocks: readonly Placed[] }>(t => bytesOf(t.blocks), THINKING_MAX_BYTES)
  return {
    seal: (owner: string, calls: readonly string[], blocks: readonly Placed[]) => calls.forEach(c => turns.set(c, { owner, blocks })),
    sealed: (owner: string) => (minted: string) => {
      const hit = turns.get(minted)
      return hit?.owner === owner ? hit.blocks : undefined
    },
  }
}
