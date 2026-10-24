import type { ApiMessage } from './protocol'

/** Public compaction rows. Handles stay local and are never sent to a provider. */
export type CompactMessage = {
  role: 'user' | 'assistant'
  text: string
  toolUses: { tool_use_id: string; tool: string; input: Record<string, unknown>; result?: unknown; text?: string; isError?: true; agentId?: string }[]
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

/** The transcript with `text` as the last user turn's final block (a new user turn when it ends on the model). */
export function withUserText(messages: readonly ApiMessage[], text: string): readonly ApiMessage[] {
  const last = messages.at(-1)
  if (last?.role === 'user') {
    const blocks = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content

    return [...messages.slice(0, -1), { role: 'user', content: [...blocks, { type: 'text', text }] }]
  }

  return [...messages, { role: 'user', content: [{ type: 'text', text }] }]
}
