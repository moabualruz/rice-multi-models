import type { ApiMessage } from './protocol'

/** Public compaction rows. Handles stay local and are never sent to a provider. */
export type CompactMessage = {
  role: 'user' | 'assistant'
  text: string
  toolUses: { tool_use_id: string; tool: string; input: Record<string, unknown>; result?: unknown; text?: string; isError?: true; agentId?: string; durationMs?: number }[]
  toolResults?: { tool_use_id: string; text: string; result?: unknown; isError: boolean }[]
  handle?: string
}

/** Character bound for the verbatim tail one compaction keeps. */
export type CompactionLimits = { retainChars?: number }

const rowChars = (message: CompactMessage) => JSON.stringify([message.text, message.toolUses, message.toolResults ?? []]).length
/** A message that can start the retained tail: never a tool result whose call would be summarized. */
const startsExchange = (message: CompactMessage) => message.role === 'assistant' || !message.toolResults?.length

/**
 * The messages one compaction keeps verbatim after the summary, which covers the whole conversation. The tail
 * starts at the latest user round, moved forward to an exchange boundary while it exceeds `retainChars`,
 * so a long agentic turn is summarized too. Pending calls and calls whose results are retained stay real
 * engine messages (they keep their handles); a user steer that arrived while a tool ran keeps both halves.
 */
export function retainedTail(messages: readonly CompactMessage[], limits: CompactionLimits = {}): readonly CompactMessage[] {
  if (!messages.length) throw new Error('there is no conversation to compact')
  let boundary = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role === 'user' && !message.toolResults?.length) { boundary = i; break }
  }
  let split = boundary > 0 ? boundary : messages.length
  if (limits.retainChars !== undefined) {
    // One long round from the first message keeps a bounded tail of itself.
    if (boundary === 0) split = 0
    let retained = messages.slice(split).reduce((sum, message) => sum + rowChars(message), 0)
    while (split < messages.length && retained > limits.retainChars) {
      retained -= rowChars(messages[split]!)
      split++
      while (split < messages.length && !startsExchange(messages[split]!)) retained -= rowChars(messages[split++]!)
    }
    // A conversation that fits whole is summarized whole, as before.
    if (split === 0) split = messages.length
  }
  // A pending invocation must remain an actual tool block, not become a summary claim.
  const resolved = new Set(messages.flatMap(message => message.toolResults?.map(result => result.tool_use_id) ?? []))
  for (let i = 0; i < split; i++) {
    if (messages[i]!.toolUses.some(tool => !resolved.has(tool.tool_use_id) && tool.result === undefined && tool.text === undefined && tool.isError !== true)) { split = i; break }
  }
  // A user can steer while a tool is still running. Keep both halves when its
  // result arrived after that newer user round, including chained tool rounds.
  const calls = new Map(messages.flatMap((message, index) => message.toolUses.map(tool => [tool.tool_use_id, index] as const)))
  let closed = false
  while (!closed) {
    closed = true
    for (const message of messages.slice(split)) for (const result of message.toolResults ?? []) {
      const index = calls.get(result.tool_use_id)
      if (index !== undefined && index < split) { split = index; closed = false }
    }
  }
  if (split === 0) throw new Error('pending tools leave no completed history to compact')

  return messages.slice(split)
}

/**
 * Recover a capped source, not a transcript branch: the compact event supplies the
 * complete order and each native UUID. Disk is context only; the caller still owns
 * cancellation, current public/API snapshots and model checks. Only plain text and
 * completed native tool exchanges are supported, with exact event/suffix agreement.
 */
export function persistedCompactSource(jsonl: string, messages: readonly CompactMessage[], session: string, api: readonly ApiMessage[]): ApiMessage[] {
  const fail = (reason: string): never => { throw new Error(`persisted compaction context ${reason}`) }
  const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  const textBlocks = (content: unknown): { type: 'text'; text: string }[] => {
    if (typeof content === 'string') return [{ type: 'text', text: content }]
    if (!Array.isArray(content)) return fail('has unsupported message content')
    return content.map(value => {
      const block = object(value)
      if (block?.type !== 'text' || typeof block.text !== 'string' || Object.keys(block).some(key => !['type', 'text', 'citations'].includes(key)) || block.citations != null && (!Array.isArray(block.citations) || block.citations.length > 0)) return fail('has unsupported non-text or annotated content')
      return { type: 'text', text: block.text }
    })
  }
  const same = (left: unknown, right: unknown) => {
    const encode = (value: unknown) => JSON.stringify(value, (_, item) => object(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
    return encode(left) === encode(right)
  }
  const blocks = (content: unknown, role: CompactMessage['role']): ({ type: string } & Record<string, unknown>)[] => {
    if (typeof content === 'string') return textBlocks(content)
    if (!Array.isArray(content)) return fail('has unsupported message content')
    return content.map(value => {
      const block = object(value)
      if (block?.type === 'text') return textBlocks([block])[0]!
      if (role === 'assistant' && block?.type === 'tool_use' && typeof block.id === 'string' && block.id && typeof block.name === 'string' && block.name && object(block.input) && Object.keys(block).every(key => ['type', 'id', 'name', 'input'].includes(key))) return { ...block, type: 'tool_use' }
      if (role === 'user' && block?.type === 'tool_result' && typeof block.tool_use_id === 'string' && block.tool_use_id && (block.is_error === undefined || typeof block.is_error === 'boolean') && Object.keys(block).every(key => ['type', 'tool_use_id', 'content', 'is_error'].includes(key))) {
        const text = textBlocks(block.content)
        return { ...block, type: 'tool_result', content: typeof block.content === 'string' ? block.content : text }
      }
      return fail('has unsupported tool, media or annotated content')
    })
  }
  const handles = new Set(messages.map(message => message.handle))
  if (handles.has(undefined) || handles.has('') || handles.size !== messages.length) return fail('has missing or duplicate event UUIDs')
  if (!jsonl.endsWith('\n')) return fail('has an incomplete or unflushed row')
  const records = new Map<string, Record<string, unknown>>()
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    let row: Record<string, unknown> | undefined
    try { row = object(JSON.parse(line)) } catch { return fail('contains an unreadable or partial row') }
    if (!row) return fail('contains an unsupported record')
    if (row.type === 'content-replacement' && row.sessionId === session) return fail('has unsupported content replacements')
    if (typeof row.uuid !== 'string' || !handles.has(row.uuid)) continue
    const previous = records.get(row.uuid)
    if (previous && JSON.stringify(previous) !== JSON.stringify(row)) return fail('has conflicting records for an event UUID')
    records.set(row.uuid, row)
  }
  const calls = new Map<string, CompactMessage['toolUses'][number]>()
  const results = new Map<string, NonNullable<CompactMessage['toolResults']>[number]>()
  const projected: CompactMessage[] = []
  const recovered = messages.map(message => {
    const row = records.get(message.handle!)
    if (!row) return fail('is missing an event UUID (not persisted or no longer readable)')
    if (row.sessionId !== session || row.agentId !== undefined || row.isSidechain === true || row.isMeta === true || row.isVirtual === true || object(row.mcpMeta)?._meta !== undefined) return fail('has an unsupported session or message scope')
    const native = object(row.message)
    if (row.type !== message.role || native?.role !== message.role) return fail('does not match the event role')
    const content = blocks(native.content, message.role)
    const projection: CompactMessage = { role: message.role, text: content.filter(block => block.type === 'text').map(block => block.text).join(''), toolUses: [] }
    for (const block of content) {
      if (block.type === 'tool_use') {
        const id = block.id as string
        if (calls.has(id)) return fail('has ambiguous duplicate tool calls')
        const call = { tool_use_id: id, tool: block.name as string, input: block.input as Record<string, unknown> }
        calls.set(id, call); projection.toolUses.push(call)
      } else if (block.type === 'tool_result') {
        const id = block.tool_use_id as string
        if (!calls.has(id) || results.has(id)) return fail('has missing or ambiguous tool results')
        const result = { tool_use_id: id, text: textBlocks(block.content).map(text => text.text).join('\n'), isError: block.is_error === true, ...(row.toolUseResult !== undefined && { result: row.toolUseResult }) }
        results.set(id, result); (projection.toolResults ??= []).push(result)
      }
    }
    projected.push(projection)
    return { role: message.role, content }
  })
  for (const [id, call] of calls) {
    const result = results.get(id)
    if (!result) return fail('has pending or missing tool results')
    Object.assign(call, { text: result.text, ...(result.result !== undefined && { result: result.result }), ...(result.isError && { isError: true }) })
    // Native Agent/Task enrichment derives these fields from the stored result,
    // not the live task lookup. The latter alone is excluded from identity.
    if (['Agent', 'Task'].includes(call.tool)) {
      const stored = object(result.result)
      if (typeof stored?.totalDurationMs === 'number') call.durationMs = stored.totalDurationMs
    }
  }
  const identity = ({ role, text, toolUses, toolResults }: CompactMessage) => ({ role, text, toolUses: toolUses.map(({ agentId, ...tool }) => tool), ...(toolResults?.length && { toolResults }) })
  if (!same(projected.map(identity), messages.map(identity))) return fail('does not match the event text/tool projection')
  if (!api.length || api.length >= recovered.length) return fail('does not have a capped native API suffix')
  const normalized = api.map(message => ({ role: message.role, content: blocks(message.content, message.role) }))
  if (!same(recovered.slice(-api.length), normalized)) return fail('does not match the native API suffix')
  // Preserve native API normalization for the available suffix, with only its
  // missing prefix supplied by the UUID-checked persisted API records.
  return [...recovered.slice(0, -api.length), ...api]
}

/** The transcript with `text` as the last user turn's final block (a new user turn when it ends on the model). */
export function withUserText(messages: readonly ApiMessage[], text: string): readonly ApiMessage[] {
  const last = messages.at(-1)
  if (last?.role === 'user') {
    const blocks = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content

    return [...messages.slice(0, -1), { role: 'user', content: [...blocks, { type: 'text', text }] }]
  }

  return [...messages, { role: 'user', content: [{ type: 'text', text }] }]
}
