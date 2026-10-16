import { expect, test } from 'bun:test'
import { consumePermissionContext } from '../hooks/permission-context'

const expected = { nonce: 'owned-nonce', sessionId: 'owned-session', toolUseId: 'owned-tool' }
const marker = (changes = {}) => 'RICE_MULTI_MODELS_PERMISSION_CONTEXT:' + JSON.stringify({ ...expected, mode: 'auto', ...changes })
test('only matching native context is consumed, and agent identity remains bound', () => {
  const foreign = marker({ nonce: 'other' })
  const result = consumePermissionContext(['keep this native context', foreign, marker({ agentId: 'child' })], expected)
  expect(result.remaining).toEqual(['keep this native context', foreign])
  expect(result.proof).toEqual({ ...expected, mode: 'auto', agentId: 'child' })
})
test('conflicting and malformed owned mode proofs cannot become permission judgments', () => {
  expect(consumePermissionContext([marker(), marker({ mode: 'default' })], expected).proof).toBeUndefined()
  expect(consumePermissionContext([marker({ mode: 'unknown' })], expected).proof).toBeUndefined()
  expect(consumePermissionContext([marker({ agentId: '\nwrong' })], expected).proof).toBeUndefined()
  expect(consumePermissionContext([], expected).proof).toBeUndefined()
  expect(consumePermissionContext([marker(), marker()], expected).proof?.mode).toBe('auto')
})
