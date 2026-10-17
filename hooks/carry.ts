// Reasoning a provider returns encrypted, carried back on later steps. The engine shows thinking a hook
// streams but does not record it, so the mod keeps each step's reasoning by the first tool call it led to and
// puts it back, as `thinking` blocks before that call, in the transcript it sends next. Pure.
import type { ApiMessage } from './protocol'
import { setCapped } from './util'

export type Reasoning = { thinking: string; signature: string }
export type Carry = Map<string, readonly Reasoning[]>

const CARRY_MAX = 400

/** Keeps a step's reasoning under its first tool call; the oldest entries go first past the bound. */
export function remember(carry: Carry, firstToolId: string | undefined, reasoning: readonly Reasoning[]): void {
  if (!firstToolId || reasoning.length === 0) return
  carry.set(firstToolId, reasoning)
  while (carry.size > CARRY_MAX) {
    const oldest = carry.keys().next().value
    if (oldest === undefined) break
    carry.delete(oldest)
  }
}

/** The transcript with each kept reasoning put back at the head of the assistant message holding its tool call. */
export function withCarry(messages: readonly ApiMessage[], carry: Carry): readonly ApiMessage[] {
  if (carry.size === 0) return messages
  let changed = false
  const out = messages.map(message => {
    if (message.role !== 'assistant' || typeof message.content === 'string') return message
    const first = message.content.find(block => block.type === 'tool_use' && typeof block['id'] === 'string')
    const kept = first ? carry.get(first['id'] as string) : undefined
    if (!kept) return message
    changed = true
    const thinking = kept.map(item => ({ type: 'thinking', thinking: item.thinking, signature: item.signature }))

    return { ...message, content: [...thinking, ...message.content.filter(block => block.type !== 'thinking' && block.type !== 'redacted_thinking')] }
  })

  return changed ? out : messages
}

const carries = new Map<string, Carry>()

/** The reasoning kept for one conversation (`main`, or a subagent's id). */
export function carryFor(who: string): Carry {
  let carry = carries.get(who)
  if (!carry) {
    carry = new Map()
    setCapped(carries, who, carry)
  }

  return carry
}
