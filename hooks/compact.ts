import type { ApiMessage } from './protocol'

/** The transcript with `text` as the last user turn's final block (a new user turn when it ends on the model). */
export function withUserText(messages: readonly ApiMessage[], text: string): readonly ApiMessage[] {
  const last = messages.at(-1)
  if (last?.role === 'user') {
    const blocks = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content

    return [...messages.slice(0, -1), { role: 'user', content: [...blocks, { type: 'text', text }] }]
  }

  return [...messages, { role: 'user', content: [{ type: 'text', text }] }]
}
