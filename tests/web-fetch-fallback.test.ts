import { expect, test } from 'bun:test'
import { NativeFetchUnavailable } from '../hooks/native-fetch'
import { runNativeThenDirect } from '../hooks/web-fetch-fallback'
import { createToolGate } from '../hooks/tool-gate'

const neverDirect = async (): Promise<string> => { throw new Error('direct tier must not run') }
const neverAsk = async (): Promise<string> => { throw new Error('approval prompt must not run') }
const failureFor = (reason?: string) => ({ isError: true, text: reason ?? 'permission stopped the native implementation' })

test('public WebFetch returns only the successful native result', async () => {
  const controller = new AbortController()
  const result = await runNativeThenDirect(async () => 'native-result', neverDirect, controller.signal)
  expect(result).toEqual({ tier: 'native-fallback', result: 'native-result' })
})

test('public WebFetch uses direct selected extraction only when native authorization is unavailable', async () => {
  const controller = new AbortController(), calls: string[] = []
  const result = await runNativeThenDirect(async () => {
    calls.push('native')
    throw new NativeFetchUnavailable('authorization', 'host authorization unavailable')
  }, async () => { calls.push('direct'); return 'selected-extraction-result' }, controller.signal)
  expect(calls).toEqual(['native', 'direct'])
  expect(result).toEqual({ tier: 'direct-selected-extraction', result: 'selected-extraction-result' })
})

test('public WebFetch does not use direct retrieval after an unsafe native destination', async () => {
  const controller = new AbortController()
  let directCalls = 0
  await expect(runNativeThenDirect(async () => {
    throw new NativeFetchUnavailable('security', 'unsafe destination')
  }, async () => { directCalls++; return 'must-not-leak' }, controller.signal)).rejects.toThrow('unsafe destination')
  expect(directCalls).toBe(0)
})

test('public WebFetch keeps an approved exact checked input through native and direct tiers', async () => {
  const gate = createToolGate(), ticket = gate.begin({ tool: 'WebFetch', tool_use_id: 'web-fetch-call' })
  const checkedInput = { url: 'https://checked.example/page', prompt: 'Extract the title', offset: 12 }
  const stopped = gate.check({ tool: 'WebFetch', tool_use_id: 'web-fetch-call', input: checkedInput }, { decision: 'allow' })
  const permission = await gate.finish(ticket, failureFor(stopped.reason), neverAsk)
  expect(permission).toEqual({ approved: true, input: checkedInput })
  if (!permission.approved) throw new Error('native allow was not approved')

  const seen: unknown[] = [], controller = new AbortController()
  const result = await runNativeThenDirect(async () => {
    seen.push(['native', permission.input])
    throw new NativeFetchUnavailable('authorization', 'host authorization unavailable')
  }, async () => { seen.push(['direct', permission.input]); return 'selected-result' }, controller.signal)
  expect(seen).toEqual([['native', checkedInput], ['direct', checkedInput]])
  expect(result.result).toBe('selected-result')
})

test('public WebFetch deny and ask decisions do not enter retrieval before explicit approval', async () => {
  for (const decision of ['deny', 'ask'] as const) {
    const gate = createToolGate(), ticket = gate.begin({ tool: 'WebFetch', tool_use_id: `web-fetch-${decision}` })
    const input = { url: 'https://checked.example/page', prompt: 'Extract the title' }
    const verdict = gate.check({ tool: 'WebFetch', tool_use_id: `web-fetch-${decision}`, input }, { decision })
    const permission = await gate.finish(ticket, failureFor(verdict.reason), decision === 'ask'
      ? async () => 'Deny'
      : neverAsk)
    expect(permission.approved).toBe(false)
    let retrievalCalls = 0
    if (permission.approved) await runNativeThenDirect(async () => { retrievalCalls++; return 'native' }, async () => { retrievalCalls++; return 'direct' }, new AbortController().signal)
    expect(retrievalCalls).toBe(0)
  }
})

test('public WebFetch cancellation never starts direct retrieval or leaks a partial native result', async () => {
  const controller = new AbortController(), partial = new Error('cancelled')
  let directCalls = 0
  await expect(runNativeThenDirect(async () => {
    controller.abort(partial)
    throw new NativeFetchUnavailable('authorization', 'host authorization unavailable')
  }, async () => { directCalls++; return 'must-not-leak' }, controller.signal)).rejects.toBe(partial)
  expect(directCalls).toBe(0)
})
