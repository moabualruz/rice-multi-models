// Compaction for a conversation on a routed model: the engine's own compaction request would go to Anthropic
// with the routed model id and fail, so the mod answers `session.compact` with a summary the routed model
// writes. Pure: the prompt, and the summary as the message the conversation continues from.
import type { ApiMessage } from './protocol'

export const COMPACT_SYSTEM = `You write the summary a coding session continues from after its earlier messages are dropped. Keep what the work needs: the user's requests and constraints in their own words where they matter, decisions made and why, files and code touched (paths, functions, key snippets), commands run and their outcomes, errors met and how they were resolved, what is done, what is in progress and the exact next step. Leave out pleasantries and repetition. Write plain prose and short lists. Do not call tools.`

export function compactRequest(messages: readonly ApiMessage[], instructions: string | undefined): readonly ApiMessage[] {
  const ask = `Summarize the conversation above for continuing the work${instructions ? `, stressing: ${instructions}` : ''}. Answer with the summary only.`
  const last = messages.at(-1)
  // The request must end on a user turn: one that ends on one gets the ask appended to it.
  if (last?.role === 'user') {
    const blocks = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content

    return [...messages.slice(0, -1), { role: 'user', content: [...blocks, { type: 'text', text: ask }] }]
  }

  return [...messages, { role: 'user', content: [{ type: 'text', text: ask }] }]
}

export function summaryMessage(summary: string): string {
  return `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n${summary.trim()}`
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
