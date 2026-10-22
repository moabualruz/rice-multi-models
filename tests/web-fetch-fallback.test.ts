import { expect, test } from 'bun:test'
import { NativeFetchUnavailable } from '../hooks/native-fetch'
import { runFinalNativeFetch } from '../hooks/web-fetch-fallback'
import { createToolGate } from '../hooks/tool-gate'

const neverAsk = async (): Promise<string> => { throw new Error('approval prompt must not run') }
const failureFor = (reason?: string) => ({ isError: true, text: reason ?? 'permission stopped the native implementation' })

test('final native WebFetch returns valid results, including an empty terminal result', async () => {
  for (const result of ['native-result', '']) expect(await runFinalNativeFetch(async () => result, new AbortController().signal)).toBe(result)
})

test('every native failure is terminal, not a signal for hidden direct retrieval', async () => {
  for (const code of ['authorization', 'security', 'response'] as const) {
    const failure = new NativeFetchUnavailable(code, 'owned terminal failure')
    await expect(runFinalNativeFetch(async () => { throw failure }, new AbortController().signal)).rejects.toBe(failure)
  }
})

test('public WebFetch keeps the approved exact checked input through its final native tier', async () => {
  const gate = createToolGate(), ticket = gate.begin({ tool: 'WebFetch', tool_use_id: 'web-fetch-call' })
  const checkedInput = { url: 'https://checked.example/page', prompt: 'Extract the title', offset: 12 }
  const stopped = gate.check({ tool: 'WebFetch', tool_use_id: 'web-fetch-call', input: checkedInput }, { decision: 'allow' })
  const permission = await gate.finish(ticket, failureFor(stopped.reason), neverAsk)
  expect(permission).toEqual({ approved: true, input: checkedInput })
  if (!permission.approved) throw new Error('native allow was not approved')
  const seen: unknown[] = []
  expect(await runFinalNativeFetch(async () => { seen.push(permission.input); return 'selected-result' }, new AbortController().signal)).toBe('selected-result')
  expect(seen).toEqual([checkedInput])
})

test('deny and ask decisions never enter retrieval before explicit approval', async () => {
  for (const decision of ['deny', 'ask'] as const) {
    const gate = createToolGate(), ticket = gate.begin({ tool: 'WebFetch', tool_use_id: `web-fetch-${decision}` })
    const input = { url: 'https://checked.example/page', prompt: 'Extract the title' }
    const verdict = gate.check({ tool: 'WebFetch', tool_use_id: `web-fetch-${decision}`, input }, { decision })
    const permission = await gate.finish(ticket, failureFor(verdict.reason), decision === 'ask' ? async () => 'Deny' : neverAsk)
    expect(permission.approved).toBe(false)
    let calls = 0
    if (permission.approved) await runFinalNativeFetch(async () => { calls++; return 'native' }, new AbortController().signal)
    expect(calls).toBe(0)
  }
})

test('cancellation before or during the native request never publishes its partial result', async () => {
  const before = new AbortController(); before.abort(new Error('before'))
  let calls = 0
  await expect(runFinalNativeFetch(async () => { calls++; return '' }, before.signal)).rejects.toThrow('before')
  expect(calls).toBe(0)
  const during = new AbortController(), failure = new Error('during')
  await expect(runFinalNativeFetch(async () => { during.abort(failure); return 'partial' }, during.signal)).rejects.toBe(failure)
})
