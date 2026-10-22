import { createHash } from 'node:crypto'
import type { ApiMessage, StepEvent, StepRequest } from '../hooks/protocol.ts'
import type { ContinuationAdapter, ContinuationRecord } from '../hooks/continuation.ts'
import { CONTINUATION_RECORD_MAX, CONTINUATION_OWNER_MAX } from '../hooks/continuation.ts'
import type { CacheIdentity } from './styx/cache-identity.ts'
import { cacheIdentityKey } from './styx/cache-identity.ts'
import type { Placed, Thinking } from './styx/history.ts'
import { isObject } from '../hooks/config.ts'

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : isObject(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
export const contextDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const withoutThinking = (messages: readonly ApiMessage[]) => messages.map(message => ({ ...message, content: typeof message.content === 'string' ? message.content : message.content.filter(block => block.type !== 'thinking' && block.type !== 'redacted_thinking') }))
const context = (req: StepRequest) => ({ system: req.system, tools: req.tools, effort: req.effort ?? null, native: req.native ?? null })
const content = (message: ApiMessage | undefined) => message && typeof message.content !== 'string' ? message.content : []
const tools = (message: ApiMessage | undefined) => content(message).filter(block => block.type === 'tool_use')
const toolDigest = (blocks: readonly Record<string, unknown>[]) => contextDigest(blocks.map(block => ({ id: block['id'], name: block['name'], input: block['input'] })))
const assistantContent = (blocks: readonly Record<string, unknown>[]) => blocks.filter(block => block['type'] !== 'thinking' && block['type'] !== 'redacted_thinking').map(block => block['type'] === 'tool_use' ? { type: 'tool_use', id: block['id'], name: block['name'], input: block['input'] } : block['type'] === 'text' ? { type: 'text', text: block['text'] } : block)

/** The same visible block boundaries the native assembler records, without retaining thinking text in history. */
export function continuationOutput() {
  const content: ({ type: string } & Record<string, unknown>)[] = []
  const blocks: Placed[] = []
  let text: { type: 'text'; text: string } | undefined
  return { content, blocks, feed(event: StepEvent) {
    if (event.type === 'text') {
      if (text) text.text += event.text
      else { text = { type: 'text', text: event.text }; content.push(text) }
    } else if (event.type === 'thinking') text = undefined
    else if (event.type === 'tool_use') { text = undefined; content.push({ type: 'tool_use', id: event.id, name: event.name, input: event.input }) }
    else if (event.type === 'signature') blocks.push({ at: content.length, block: { type: 'thinking', thinking: event.thinking, signature: event.signature } })
  } }
}
const hex = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\0\r\n]/.test(value)

/** Reuses cache scope, additionally binding the actual endpoint path without authentication/query material. */
export function continuationScope(identity: CacheIdentity, endpoint: string, alternateEndpoint?: string): string {
  const location = (value: string) => { const url = new URL(value); return [url.protocol, url.hostname, url.port, url.pathname] }
  return contextDigest(['continuation:v1', cacheIdentityKey(identity), location(endpoint), alternateEndpoint === undefined ? null : location(alternateEndpoint)])
}
export const continuationOwner = (req: StepRequest) => contextDigest(['owner:v1', req.session, req.who])

// Signed text cannot be detached from its signature. Do not persist it as plaintext or invent a replacement.
// Responses summaries are not required for encrypted replay and are deliberately absent from this record.
export function opaqueBlocks(adapter: ContinuationAdapter, blocks: readonly Placed[]): readonly Placed[] | undefined {
  const out: Placed[] = []
  for (const placed of blocks) {
    const block = placed.block
    if (!block || Object.keys(placed).some(key => key !== 'at' && key !== 'block') || Object.keys(block).some(key => !['type', 'thinking', 'signature', 'data'].includes(key))) return undefined
    if (!Number.isSafeInteger(placed.at) || placed.at < 0) return undefined
    let safe: Thinking
    if (adapter === 'responses' && block.type === 'thinking' && block.signature.startsWith('responses:')) {
      let raw: unknown
      try { raw = JSON.parse(block.signature.slice('responses:'.length)) } catch { return undefined }
      if (!isObject(raw) || (typeof raw['encrypted'] !== 'string' || raw['encrypted'].length === 0) || Object.keys(raw).some(key => key !== 'id' && key !== 'encrypted') || raw['id'] !== undefined && !id(raw['id'])) return undefined
      safe = { ...block, thinking: '' }
    } else if (adapter === 'codex-responses' && block.type === 'thinking' && block.signature.startsWith('multi-openai:')) {
      let raw: unknown
      try { raw = JSON.parse(Buffer.from(block.signature.slice('multi-openai:'.length), 'base64').toString('utf8')) } catch { return undefined }
      if (!isObject(raw) || raw['type'] !== 'reasoning' || typeof raw['encrypted_content'] !== 'string' || !raw['encrypted_content'] || raw['id'] !== undefined && !id(raw['id'])) return undefined
      const signature = 'multi-openai:' + Buffer.from(JSON.stringify({ type: 'reasoning', ...(raw['id'] === undefined ? {} : { id: raw['id'] }), encrypted_content: raw['encrypted_content'], summary: [] })).toString('base64url')
      safe = { type: 'thinking', thinking: '', signature }
    } else if (adapter === 'gemini' && block.type === 'thinking' && block.signature.startsWith('gemini:') && block.signature.length > 7 && block.signature !== 'gemini:skip_thought_signature_validator') {
      safe = { ...block, thinking: '' }
    } else if ((adapter === 'anthropic' || adapter === 'bedrock') && block.type === 'redacted_thinking' && typeof block.data === 'string' && block.data) safe = block
    else if ((adapter === 'anthropic' || adapter === 'bedrock') && block.type === 'thinking' && block.thinking === '' && block.signature && !/^(?:gemini:|responses:|multi-openai:)/.test(block.signature)) safe = block
    else return undefined
    out.push({ at: placed.at, block: safe })
  }
  return out
}

export function createContinuation(req: StepRequest, adapter: ContinuationAdapter, scope: string, dispatched: unknown, calls: readonly { id: string; name: string; input: Record<string, unknown>; providerId?: string }[], blocks: readonly Placed[], now: number, assistant?: readonly Record<string, unknown>[]): ContinuationRecord | undefined {
  const mode = req.continuation
  if (!mode || adapter === 'openai' || !calls.length || !blocks.length || !id(mode.boundary.turnId) || !Number.isSafeInteger(mode.boundary.index) || mode.boundary.index < 0 || !hex(scope)) return undefined
  const opaque = opaqueBlocks(adapter, blocks)
  if (!opaque) return undefined
  const record = {
    version: 1 as const, owner: continuationOwner(req), scope, adapter, createdAt: now,
    expiresAt: now + mode.maxAgeSeconds * 1000, boundary: mode.boundary,
    prefixLength: req.transcript.length, prefixDigest: contextDigest(withoutThinking(req.transcript)),
    contextDigest: contextDigest(context(req)), dispatchedDigest: contextDigest(dispatched),
    callsDigest: toolDigest(calls), assistantDigest: contextDigest(assistantContent(assistant ?? calls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.input })))), calls: calls.map(call => ({ id: call.id, ...(call.providerId === undefined ? {} : { providerId: call.providerId }) })), blocks: opaque,
  }
  const result = { ...record, integrity: contextDigest(record) }
  return Buffer.byteLength(JSON.stringify(result)) <= CONTINUATION_RECORD_MAX ? result : undefined
}

/** No migration/fallback: schema, exact scope, native prefix, call inputs and every successful tool result must agree. */
export function restoreContinuations(req: StepRequest, adapter: ContinuationAdapter, scope: string, now: number): ContinuationRecord[] {
  if (!req.continuation || adapter === 'openai') return []
  const accepted: ContinuationRecord[] = []
  for (const value of req.continuation.records.slice(0, CONTINUATION_OWNER_MAX)) {
    if (!isObject(value) || Buffer.byteLength(JSON.stringify(value)) > CONTINUATION_RECORD_MAX) continue
    if (Object.keys(value).some(key => !['version', 'owner', 'scope', 'adapter', 'createdAt', 'expiresAt', 'boundary', 'prefixLength', 'prefixDigest', 'contextDigest', 'dispatchedDigest', 'callsDigest', 'assistantDigest', 'calls', 'blocks', 'integrity'].includes(key))) continue
    const { integrity, ...unsigned } = value
    if (value['version'] !== 1 || !hex(integrity) || integrity !== contextDigest(unsigned) || value['adapter'] !== adapter || value['scope'] !== scope || value['owner'] !== continuationOwner(req)) continue
    const created = value['createdAt'], expires = value['expiresAt'], prefix = value['prefixLength']
    if (typeof created !== 'number' || typeof expires !== 'number' || created > now || created >= expires || expires <= now || expires - created > req.continuation.maxAgeSeconds * 1000 || !Number.isSafeInteger(prefix) || Number(prefix) < 0) continue
    if (!isObject(value['boundary']) || !id(value['boundary']['turnId']) || !Number.isSafeInteger(value['boundary']['index']) || Number(value['boundary']['index']) < 0 || !hex(value['dispatchedDigest'])) continue
    if (!Array.isArray(value['calls']) || !value['calls'].length || !value['calls'].every(call => isObject(call) && id(call['id']) && (call['providerId'] === undefined || id(call['providerId'])) && Object.keys(call).every(key => key === 'id' || key === 'providerId'))) continue
    if (value['prefixDigest'] !== contextDigest(withoutThinking(req.transcript.slice(0, Number(prefix)))) || value['contextDigest'] !== contextDigest(context(req))) continue
    const assistant = req.transcript[Number(prefix)]
    const called = tools(assistant)
    if (assistant?.role !== 'assistant' || value['assistantDigest'] !== contextDigest(assistantContent(content(assistant))) || toolDigest(called) !== value['callsDigest'] || JSON.stringify(called.map(call => call['id'])) !== JSON.stringify(value['calls'].map(call => call.id))) continue
    const results = new Set<string>()
    let compatible = true
    for (const message of req.transcript.slice(Number(prefix) + 1)) {
      if (message.role === 'assistant') continue
      const completed = () => called.every(call => typeof call['id'] === 'string' && results.has(call['id']))
      if (typeof message.content === 'string') { if (!completed()) compatible = false; continue }
      for (const block of message.content) {
        if (block.type !== 'tool_result') { if (!completed()) compatible = false; continue }
        if (block['is_error'] === true || typeof block['tool_use_id'] !== 'string') { compatible = false; break }
        results.add(block['tool_use_id'])
      }
    }
    if (!compatible || !value['calls'].every(call => results.has(call.id))) continue
    if (!Array.isArray(value['blocks']) || !value['blocks'].every(placed => isObject(placed) && isObject(placed['block']))) continue
    const candidate = value as unknown as ContinuationRecord
    let opaque: readonly Placed[] | undefined
    try { opaque = opaqueBlocks(adapter, candidate.blocks) } catch { continue }
    if (!opaque || JSON.stringify(opaque) !== JSON.stringify(candidate.blocks)) continue
    accepted.push(candidate)
  }
  return accepted
}
