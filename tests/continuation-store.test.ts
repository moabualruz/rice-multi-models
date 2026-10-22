import { expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { clearContinuations, continuationRecords, saveContinuation } from '../hooks/continuation-store'
import type { ContinuationStorePort } from '../hooks/continuation-store'
import { CONTINUATION_BUDGET, continuationOwnerPrefix } from '../hooks/continuation'
import type { ContinuationRecord } from '../hooks/continuation'
import { contextDigest, createContinuation, restoreContinuations } from '../helper/continuation'
const now = 1000
const value: ContinuationRecord = { version: 1, owner: contextDigest('owner'), scope: contextDigest('scope'), adapter: 'gemini', createdAt: now, expiresAt: now + 60000, boundary: { turnId: 'native-turn', index: 0 }, prefixLength: 1, prefixDigest: contextDigest('prefix'), contextDigest: contextDigest('context'), dispatchedDigest: contextDigest('dispatched'), callsDigest: contextDigest('calls'), assistantDigest: contextDigest('assistant'), calls: [{ id: 'native-tool-call' }], blocks: [], integrity: contextDigest('record') }
function memory() {
  const map = new Map<string, unknown>()
  const store: ContinuationStorePort = { async keys() { return [...map.keys()] }, async get(key) { return map.get(key) }, async set(key, value) { map.set(key, structuredClone(value)) }, async delete(key) { map.delete(key) } }
  return { map, store }
}
test('native store namespace separates owners/sessions and deletes expired records under the caller lock', async () => {
  const { map, store } = memory()
  expect(await saveContinuation(store, 'session-a', 'agent-a', value, now)).toBe('saved')
  expect(await continuationRecords(store, 'session-a', 'agent-a', now)).toEqual([value])
  expect(await continuationRecords(store, 'session-b', 'agent-a', now)).toEqual([])
  expect(await continuationRecords(store, 'session-a', 'agent-b', now)).toEqual([])
  expect(await continuationRecords(store, 'session-a', 'agent-a', now + 60000)).toEqual([])
  expect(map.size).toBe(0)
})
test('size budget refuses admission, never evicts another active owner or unrelated native data', async () => {
  const { map, store } = memory()
  map.set('unrelated-native-capture', { keep: true })
  for (let i = 0; i < 25; i++) map.set(continuationOwnerPrefix('other', 'owner') + i, { ...value, blocks: [{ at: 0, block: { type: 'redacted_thinking', data: 'x'.repeat(90000) } }] })
  expect(JSON.stringify([...map]).length).toBeGreaterThan(CONTINUATION_BUDGET)
  const before = JSON.stringify([...map])
  expect(await saveContinuation(store, 'session', 'owner', value, now)).toBe('budget-full')
  expect(JSON.stringify([...map])).toBe(before)
})
test('the owner count limit refuses a new staged record instead of storing one the bounded lookup cannot restore', async () => {
  const { map, store } = memory()
  for (let index = 0; index < 256; index++) map.set(continuationOwnerPrefix('session', 'owner') + index, value)
  expect(await saveContinuation(store, 'session', 'owner', value, now)).toBe('budget-full')
  expect(map.size).toBe(256)
})
test('clear awaits deletion of the old session, does not affect peers, and prevents late in-flight resurrection', async () => {
  const { store } = memory()
  await saveContinuation(store, 'old-session', 'agent-a', value, now)
  await saveContinuation(store, 'old-session', 'agent-b', value, now)
  await saveContinuation(store, 'peer', 'agent-a', value, now)
  expect(await clearContinuations(store, 'old-session')).toBe(2)
  expect(await continuationRecords(store, 'old-session', 'agent-a', now)).toEqual([])
  expect(await continuationRecords(store, 'peer', 'agent-a', now)).toEqual([value])
  expect(await saveContinuation(store, 'old-session', 'agent-a', value, now)).toBe('cleared')
})
test('retirement metadata is budgeted; exhaustion blocks late writes instead of silently evicting protection', async () => {
  const { map, store } = memory()
  map.set('continuation-retired:v1:synthetic-budget-fill', 'x'.repeat(CONTINUATION_BUDGET - 1100))
  await clearContinuations(store, 'a'.repeat(250))
  expect(await saveContinuation(store, 'another-active-session', 'owner', value, now)).toBe('budget-full')
  await expect(continuationRecords(store, 'another-active-session', 'owner', now)).rejects.toThrow('budget exhausted')
  expect(JSON.stringify(Object.fromEntries(map)).length).toBeLessThan(CONTINUATION_BUDGET)
})
test('a write that committed then failed still cannot restore an incomplete/cancelled native tool boundary', async () => {
  const { store } = memory()
  const request = { session: 'session', who: 'main', target: 'custom/model', system: 'not persisted', tools: [], transcript: [{ role: 'user' as const, content: 'synthetic' }], continuation: { boundary: { turnId: 'native-turn', index: 0 }, maxAgeSeconds: 60, records: [] } }
  const record = createContinuation(request, 'gemini', value.scope, {}, [{ id: 'native-call', name: 'Read', input: {} }], [{ at: 0, block: { type: 'thinking', thinking: '', signature: 'gemini:' + randomBytes(64).toString('base64') } }], now)!
  const set = store.set
  store.set = async (key, value) => { await set(key, value); throw new Error('synthetic after-write failure') }
  await expect(saveContinuation(store, 'session', 'main', record, now)).rejects.toThrow('after-write failure')
  const records = await continuationRecords(store, 'session', 'main', now)
  expect(records).toHaveLength(1)
  expect(restoreContinuations({ ...request, continuation: { ...request.continuation, records } }, 'gemini', value.scope, now + 1)).toEqual([])
})
test('failed deletion is a failed clear, not a success receipt or best-effort claim', async () => {
  const { store } = memory()
  await saveContinuation(store, 'session', 'owner', value, now)
  store.delete = async () => { throw new Error('synthetic native delete failure') }
  await expect(clearContinuations(store, 'session')).rejects.toThrow('synthetic native delete failure')
})
