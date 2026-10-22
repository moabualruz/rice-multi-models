import type { EngineInterface } from 'claude-code'
import { CONTINUATION_BUDGET, CONTINUATION_PREFIX, CONTINUATION_RECORD_MAX, CONTINUATION_OWNER_MAX, continuationOwnerPrefix, continuationSessionPrefix } from './continuation'
import type { ContinuationRecord } from './continuation'
import { helperFile } from './setup'

export type ContinuationStorePort = {
  keys(): Promise<string[]>
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
}
const RETIRED_PREFIX = 'continuation-retired:v1:'
const BLOCKED_KEY = 'continuation-budget-blocked:v1'
const retiredKey = (session: string) => RETIRED_PREFIX + encodeURIComponent(session)
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) ?? 'null').length
const record = (value: unknown): value is ContinuationRecord => !!value && typeof value === 'object' && !Array.isArray(value) && (value as ContinuationRecord).version === 1 && Number.isFinite((value as ContinuationRecord).expiresAt)
const owns = (key: string) => key.startsWith(CONTINUATION_PREFIX) || key.startsWith(RETIRED_PREFIX) || key === BLOCKED_KEY
async function usedBytes(store: ContinuationStorePort, except?: string): Promise<number> {
  let used = 2
  for (const key of await store.keys()) if (owns(key) && key !== except) used += bytes(key) + bytes(await store.get(key)) + 2
  return used
}

// Caller holds the cross-process lock over enumeration, cleanup, admission and mutation. Never a racy CAS.
export async function continuationRecords(store: ContinuationStorePort, session: string, owner: string, now: number, expired?: () => void): Promise<unknown[]> {
  if (await store.get(BLOCKED_KEY)) throw new Error('Continuation metadata budget exhausted; durable mode is blocked pending policy review')
  if (await store.get(retiredKey(session)) !== undefined) return []
  const prefix = continuationOwnerPrefix(session, owner)
  const out: unknown[] = []
  for (const key of await store.keys()) {
    if (!key.startsWith(CONTINUATION_PREFIX)) continue
    const value = await store.get(key)
    if (record(value) && value.expiresAt <= now) { await store.delete(key); expired?.() }
    else if (key.startsWith(prefix) && bytes(value) <= CONTINUATION_RECORD_MAX && out.length < CONTINUATION_OWNER_MAX) out.push(value)
  }
  return out
}

export async function saveContinuation(store: ContinuationStorePort, session: string, owner: string, value: ContinuationRecord, now: number): Promise<'saved' | 'expired' | 'budget-full' | 'cleared'> {
  if (await store.get(BLOCKED_KEY)) return 'budget-full'
  if (await store.get(retiredKey(session)) !== undefined) return 'cleared'
  if (value.expiresAt <= now) return 'expired'
  if (bytes(value) > CONTINUATION_RECORD_MAX) return 'budget-full'
  await continuationRecords(store, session, owner, now)
  const prefix = continuationOwnerPrefix(session, owner)
  const key = prefix + value.scope + ':' + value.integrity
  const keys = await store.keys()
  if (!keys.includes(key) && keys.filter(existing => existing.startsWith(prefix)).length >= CONTINUATION_OWNER_MAX) return 'budget-full'
  const used = await usedBytes(store, key) + bytes(key) + bytes(value) + 2
  // Reserve room for a fixed fail-closed latch if session-retirement metadata eventually fills its budget.
  if (used > CONTINUATION_BUDGET - 1024) return 'budget-full'
  // Immutable per-dispatch keys: another active owner's state is never evicted to make room.
  await store.set(key, value)
  return 'saved'
}

export async function clearContinuations(store: ContinuationStorePort, session: string): Promise<number> {
  const prefix = continuationSessionPrefix(session)
  let count = 0
  for (const key of await store.keys()) if (key.startsWith(prefix)) { await store.delete(key); count++ }
  // A late dispatch cannot resurrect a cleared session. Reference-only retirement markers do not expire.
  // If their bounded allowance fills, block all later durable writes rather than evict an active owner.
  const retired = retiredKey(session)
  if (await usedBytes(store, retired) + bytes(retired) + 6 > CONTINUATION_BUDGET - 1024) await store.set(BLOCKED_KEY, true)
  else await store.set(retired, true)
  // A successful return means deletion was awaited, not scheduled as best effort.
  if ((await store.keys()).some(key => key.startsWith(prefix))) throw new Error('Continuation clear verification failed')
  return count
}

export async function withContinuationStore<T>($: EngineInterface, executable: string, operation: (store: ContinuationStorePort) => Promise<T>): Promise<T> {
  const config = await $.env.get('CLAUDE_CONFIG_DIR') || `${await $.env.get('HOME') || await $.env.get('USERPROFILE') || ''}/.claude`
  const child = $.process.spawn({ argv: [executable, helperFile($.plugin.root), 'continuation-lock', config] })
  let output = ''
  try {
    for (;;) {
      const piece = await child.next()
      if (piece.done) throw new Error('Continuation store lock unavailable; durable mode is blocked')
      if (piece.value.stream === 'stdout') output = (output + piece.value.text).slice(-1000)
      if (output.includes('continuation-lock-acquired\n')) break
    }
    return await operation({ keys: () => $.store.keys(), get: key => $.store.get(key), set: (key, value) => $.store.set(key, value), delete: key => $.store.delete(key) })
  } finally { await child.return({ code: null, signal: null }) }
}
