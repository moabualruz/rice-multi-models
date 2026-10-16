const PREFIX = 'RICE_MULTI_MODELS_PERMISSION_CONTEXT:'
const MODES = new Set(['default', 'manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'])
export type PermissionModeProof = { nonce: string; sessionId: string; toolUseId: string; agentId?: string; mode: string }

/** Consume this call's native command-hook metadata before context reaches a model. */
export function consumePermissionContext(contexts: readonly string[], expected: { nonce: string; sessionId: string; toolUseId: string }) {
  const remaining: string[] = []
  let proof: PermissionModeProof | undefined, conflict = false
  for (const text of contexts) {
    let value: unknown
    try { if (text.startsWith(PREFIX)) value = JSON.parse(text.slice(PREFIX.length)) } catch { /* Unrelated or malformed text stays context. */ }
    if (!value || typeof value !== 'object' || Array.isArray(value)) { remaining.push(text); continue }
    const row = value as Record<string, unknown>
    if (row.nonce !== expected.nonce || row.sessionId !== expected.sessionId || row.toolUseId !== expected.toolUseId) { remaining.push(text); continue }
    if (typeof row.mode !== 'string' || !MODES.has(row.mode) || row.agentId !== undefined && (typeof row.agentId !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(row.agentId))) { conflict = true; continue }
    const current = { ...expected, mode: row.mode, ...(row.agentId === undefined ? {} : { agentId: row.agentId as string }) }
    if (proof && (proof.mode !== current.mode || proof.agentId !== current.agentId)) conflict = true
    proof = current
  }
  return { remaining, proof: conflict ? undefined : proof }
}
