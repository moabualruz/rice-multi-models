/** Metadata added by the early native adapter, after the host's caller arguments. */
export type NativeCaller = { version: 1; model?: string; agentId?: string; sessionId?: string; unowned?: true }

export function nativeCaller(input: unknown): NativeCaller | undefined {
  if (!input || typeof input !== 'object') return undefined
  const value = (input as Record<string, unknown>).riceMultiModelsCaller
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const caller = value as Record<string, unknown>
  if (caller.version !== 1 || caller.model !== undefined && typeof caller.model !== 'string' || caller.agentId !== undefined && typeof caller.agentId !== 'string') throw new Error('invalid native caller metadata')
  return caller as NativeCaller
}
