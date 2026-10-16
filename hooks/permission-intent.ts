import type { ApiMessage } from './protocol'

/** The native transcript-row form, not the rendered Messages API form. */
export type PermissionMessage = {
  role: 'user' | 'assistant'
  text: string
  toolUses: readonly unknown[]
  toolResults?: readonly unknown[]
}

export type PermissionLoadedContext = {
  blocks: readonly { name: string; text: string }[]
  instructionFiles?: readonly { path: string; kind: string; content: string; parent?: string }[]
}

/**
 * Native 301 omits attachments and isMeta/isVirtual user rows from this form.
 * Its tool-result text lives in toolResults, never in the row's text field.
 * Read only user text: do not inspect or serialize tool arguments or outcomes.
 * This is a transcript projection, not attestation that a peer or plugin's
 * user-role message was a new approval from a person.
 */
export function permissionIntent(messages: readonly PermissionMessage[]): ApiMessage[] {
  const intent: ApiMessage[] = []
  for (const message of messages) {
    if (message.role !== 'user') continue
    if (typeof message.text !== 'string' || !Array.isArray(message.toolUses)) {
      throw new Error('Permission intent requires native transcript rows, not rendered API messages.')
    }
    if (message.text.trim()) intent.push({ role: 'user', content: message.text })
  }
  return intent
}

/** Preserve every loaded constraint separately; none is promoted to user intent. */
export function permissionContext(context: PermissionLoadedContext): string {
  if (!Array.isArray(context.blocks) || context.blocks.some(block => typeof block.name !== 'string' || typeof block.text !== 'string')) {
    throw new Error('The loaded permission context has no valid native context blocks.')
  }
  if (context.instructionFiles !== undefined && (!Array.isArray(context.instructionFiles) || context.instructionFiles.some(file =>
    typeof file.path !== 'string' || typeof file.kind !== 'string' || typeof file.content !== 'string' || file.parent !== undefined && typeof file.parent !== 'string'))) {
    throw new Error('The loaded permission context has no valid instruction files.')
  }
  // Select the public fields explicitly so unrelated data cannot reach the judge.
  return JSON.stringify({
    blocks: context.blocks.map(block => ({ name: block.name, text: block.text })),
    ...(context.instructionFiles === undefined ? {} : { instructionFiles: context.instructionFiles.map(file => ({
      path: file.path, kind: file.kind, content: file.content, ...(file.parent === undefined ? {} : { parent: file.parent }),
    })) }),
  })
}
