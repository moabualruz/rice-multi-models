import type { ApiMessage } from './protocol'

/** Public compaction rows. Handles stay local and are never sent to a provider. */
export type CompactMessage = {
  role: 'user' | 'assistant'
  text: string
  toolUses: { tool_use_id: string; tool: string; input: Record<string, unknown>; result?: unknown; text?: string; isError?: true; agentId?: string; durationMs?: number }[]
  toolResults?: { tool_use_id: string; text: string; result?: unknown; isError: boolean }[]
  handle?: string
}

/**
 * Recover a capped source, not a transcript branch: the compact event supplies the
 * complete order and each native UUID. Disk is context only; the caller still owns
 * cancellation, current public/API snapshots and model checks. Only plain text and
 * completed native tool exchanges are supported, with exact event/suffix agreement.
 * Same-session meta/virtual context is unsupported, even when potentially archived.
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
    // Native projection can omit contextual rows. Missing UUIDs cannot prove them inactive.
    if (row.sessionId === session && (row.type === 'user' || row.type === 'assistant') && (row.isMeta === true || row.isVirtual === true)) return fail('has unsupported meta or virtual context')
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
