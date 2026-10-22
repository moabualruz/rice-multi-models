import { expect, test } from 'bun:test'
import { compactOwner, compactionPolicyBlock, historyDigest, observedReceipt, putReceipt, RECEIPT_MAX, receiptText } from '../hooks/compaction-receipt'
import type { CompactionReceipt } from '../types'

const row = (text: string) => ({ role: 'user' as const, text, toolUses: [] })
async function prepared(trigger: CompactionReceipt['trigger'] = 'manual'): Promise<CompactionReceipt> {
  return { id: 'owned-attempt', session: 'owned-session', owner: 'main', model: 'owned/exact', trigger, status: 'prepared', at: 10, expiresAt: 100, source: await historyDigest([row('old')]), expected: await historyDigest([row('summary'), row('tail')]), expectedCount: 2, expectedWasPresent: false }
}

test('only observed exact prepared context confirms installation; handles are not persistence identity', async () => {
  const receipt = await prepared()
  expect(await observedReceipt(receipt, [row('old')], 'owned-session', 'owned/exact', 20)).toBe(receipt)
  const active = [{ ...row('summary'), handle: 'native-only' }, row('tail'), row('new user')]
  expect(await observedReceipt(receipt, active, 'owned-session', 'owned/exact', 20)).toMatchObject({ status: 'installed', observedAt: 'persisted-history' })
  expect(await historyDigest(active)).toBe(await historyDigest(active.map(({ handle, ...rest }: any) => rest)))
})

test('precompute preparation is not installation; stale, cancelled, expired, session and model changes cannot confirm', async () => {
  const receipt = await prepared('precompute')
  expect(await observedReceipt(receipt, [row('old')], 'owned-session', 'owned/exact', 20)).toBe(receipt)
  for (const [active, session, model, now, reason] of [
    [[row('old'), row('new')], 'owned-session', 'owned/exact', 20, 'stale-context'],
    [[row('summary'), row('tail')], 'other-session', 'owned/exact', 20, 'session-changed'],
    [[row('summary'), row('tail')], 'owned-session', 'owned/other', 20, 'model-changed'],
    [[row('summary'), row('tail')], 'owned-session', 'owned/exact', 101, 'expired'],
    [[row('summary'), row('tail')], 'owned-session', 'owned/exact', 9, 'expired'],
  ] as const) expect(await observedReceipt(receipt, active, session, model, now)).toMatchObject({ status: 'aborted', reason })
  const cancelled = { ...receipt, status: 'aborted' as const, reason: 'cancelled' as const }
  expect(await observedReceipt(cancelled, [row('summary'), row('tail')], 'owned-session', 'owned/exact', 20)).toBe(cancelled)
})

test('new persisted segment can follow historical rows but an already present or corrupted receipt cannot confirm', async () => {
  const receipt = await prepared()
  const stored = [row('old task'), row('old answer'), row('summary'), row('tail'), row('new request')]
  expect(await observedReceipt(receipt, stored, 'owned-session', 'owned/exact', 20)).toMatchObject({ status: 'installed', observedAt: 'persisted-history' })
  for (const expectedWasPresent of [true, undefined]) expect(await observedReceipt({ ...receipt, expectedWasPresent }, stored, 'owned-session', 'owned/exact', 20)).toMatchObject({ status: 'aborted', reason: 'stale-context' })
})

test('preparing and identical old context cannot masquerade as a newly installed result', async () => {
  const receipt = await prepared()
  expect(await observedReceipt({ ...receipt, status: 'preparing' }, [row('summary'), row('tail')], 'owned-session', 'owned/exact', 20)).toMatchObject({ status: 'aborted' })
  const identical = { ...receipt, source: receipt.expected! }
  expect(await observedReceipt(identical, [row('summary'), row('tail')], 'owned-session', 'owned/exact', 20)).toBe(identical)
})

test('owner isolation, supersession and bounds hold across parallel child/main transactions', async () => {
  const receipt = await prepared()
  const child = { ...receipt, id: 'child-attempt', owner: compactOwner('child') }
  let entries = putReceipt([receipt, child], { ...receipt, id: 'new-main', status: 'preparing' })
  expect(entries.find(item => item.id === receipt.id)).toMatchObject({ status: 'aborted', reason: 'superseded' })
  expect(entries.find(item => item.id === child.id)).toBe(child)
  for (let i = 0; i < 100; i++) entries = putReceipt(entries, { ...child, id: String(i), status: 'aborted' })
  expect(entries).toHaveLength(RECEIPT_MAX)
  expect(compactOwner('main')).not.toBe(compactOwner())
})

test('receipts are bounded metadata without summary, payload or handle text, and usage is explicitly separate', async () => {
  const receipt = await prepared()
  const text = receiptText({ ...receipt, usage: { input_tokens: 123, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
  expect(text).toContain('mod-owned compaction')
  expect(text).toContain('separate from native ledger')
  expect(text).toContain('"input_tokens":123')
  expect(text).not.toContain('summary')
  expect(text).not.toContain(receipt.source)
})

test('configured or unreadable PreCompact policy is never silently bypassed', () => {
  for (const hooks of [undefined, {}, { PreCompact: [] }, { PostCompact: [{ hooks: [] }] }]) expect(compactionPolicyBlock(hooks)).toBe(false)
  for (const hooks of [null, [], 'invalid', { PreCompact: {} }, { PreCompact: [{ hooks: [{ type: 'command', command: 'owned-blocker' }] }] }]) expect(compactionPolicyBlock(hooks)).toBe(true)
})
