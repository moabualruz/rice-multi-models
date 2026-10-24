import type { CompactionReceipt } from '../types'
import type { CompactMessage } from './compact'

export const RECEIPT_TTL_MS = 30 * 60_000
export const RECEIPT_MAX = 32
export const compactOwner = (agentId?: string) => agentId === undefined ? 'main' : `agent:${agentId}`

/** Fingerprints only, never transcript text, tool payloads or opaque handles in receipt state. */
export async function historyDigest(messages: readonly CompactMessage[]): Promise<string> {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value
  // Public reads enrich Agent calls from the live task registry; compact events do not.
  // Only that lookup is non-transcript identity. Stored result/input identities still count.
  const rows = messages.map(({ role, text, toolUses, toolResults }) => ({ role, text, toolUses: toolUses.map(({ agentId, ...tool }) => tool), ...(toolResults?.length ? { toolResults } : {}) }))
  const bytes = await crypto.subtle.digest('SHA-256', new Uint8Array(new TextEncoder().encode(JSON.stringify(canonical(rows)))))
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Session reads can include pre-boundary history; require a whole newly persisted segment. */
export async function historyContains(messages: readonly CompactMessage[], digest: string, count: number): Promise<boolean> {
  if (!Number.isSafeInteger(count) || count < 1) return false
  for (let i = messages.length - count; i >= 0; i--) if (await historyDigest(messages.slice(i, i + count)) === digest) return true
  return false
}

export function putReceipt(entries: readonly CompactionReceipt[], receipt: CompactionReceipt): readonly CompactionReceipt[] {
  return [...entries.filter(row => row.id !== receipt.id).map(row => row.owner === receipt.owner && row.session === receipt.session && ['preparing', 'prepared'].includes(row.status) && receipt.status === 'preparing'
    ? { ...row, status: 'aborted' as const, reason: 'superseded' as const } : row), receipt].slice(-RECEIPT_MAX)
}

/** A successful hook return is prepared, not a core installation receipt. */
export async function observedReceipt(receipt: CompactionReceipt, active: readonly CompactMessage[], session: string, model: string | undefined, now: number): Promise<CompactionReceipt> {
  if (receipt.status !== 'prepared' && receipt.status !== 'preparing') return receipt
  const abort = (reason: CompactionReceipt['reason']): CompactionReceipt => ({ ...receipt, status: 'aborted', reason, at: now })
  if (receipt.session !== session) return abort('session-changed')
  if (now < receipt.at || now > receipt.expiresAt) return abort('expired')
  if (model !== receipt.model) return abort('model-changed')
  if (receipt.status === 'prepared' && receipt.expected && receipt.expectedCount !== undefined && receipt.expectedWasPresent === false
    && receipt.expected !== receipt.source && await historyContains(active, receipt.expected, receipt.expectedCount)) {
    return { ...receipt, status: 'installed', observedAt: 'persisted-history', at: now }
  }
  // An unchanged precompute source is still eligible, but any changed context is
  // stale unless the prepared prefix is actually present. No timing correlation.
  if (await historyDigest(active) !== receipt.source) return abort('stale-context')
  return receipt
}

/** Configured classic policy cannot be safely dispatched through a replacement. */
export function compactionPolicyBlock(hooks: unknown): boolean {
  if (hooks === undefined) return false
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return true
  const pre = (hooks as Record<string, unknown>).PreCompact
  return pre !== undefined && (!Array.isArray(pre) || pre.length > 0)
}

export function receiptText(row: CompactionReceipt): string {
  return `rice-multi-models: mod-owned compaction ${JSON.stringify({ id: row.id, owner: row.owner, model: row.model, trigger: row.trigger, status: row.status === 'installed' ? 'installed-observed' : row.status, reason: row.reason, observedAt: row.observedAt, providerUsage: row.usage, accounting: 'separate from native ledger', classicHooks: 'not dispatched by replacement' })}`
}
