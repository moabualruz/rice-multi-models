import { expect, test } from 'bun:test'
import { createToolGate, type ToolGateTicket } from '../hooks/tool-gate'
import type { PermissionVerdict } from '../hooks/permission'

const call = { tool: 'WebFetch', tool_use_id: 'toolu_owned', agentId: 'owned-agent' }
const checked = { ...call, input: { url: 'https://rewritten.example/page', prompt: 'Use the rewritten prompt' } }
const errorFor = (verdict: PermissionVerdict) => ({ isError: true, text: `Permission denied by plugin: ${verdict.reason}` })
const neverAsk = async () => { throw new Error('must not ask') }

test('native allow is stopped then replaced with exactly the checked post-classic input', async () => {
  const gate = createToolGate(), ticket = gate.begin(call)
  const verdict = gate.check(checked, { decision: 'allow', rule: 'WebFetch(domain:rewritten.example)' })
  expect(verdict.decision).toBe('deny')
  expect(await gate.finish(ticket, errorFor(verdict), neverAsk)).toEqual({ approved: true, input: checked.input })
  expect(await gate.finish(ticket, errorFor(verdict), neverAsk)).toEqual({ approved: false })
  gate.end(ticket)
})

test('native deny is returned unchanged and never becomes a replacement approval', async () => {
  const gate = createToolGate(), ticket = gate.begin(call), verdict = { decision: 'deny' as const, reason: 'Managed denial', rule: 'WebFetch(domain:*)' }
  expect(gate.check(checked, verdict)).toBe(verdict)
  expect(await gate.finish(ticket, { isError: true, text: verdict.reason }, neverAsk)).toEqual({ approved: false })
  const later = gate.begin(call), stopped = gate.check(checked, { decision: 'allow' })
  expect(gate.check(checked, verdict)).toBe(verdict)
  expect(await gate.finish(later, errorFor(stopped), neverAsk)).toEqual({ approved: false })
})

test('an ordinary ask names the exact action and accepts only one explicit Allow once response', async () => {
  for (const answer of ['Allow once', 'Deny', 'Other', 'allow once', ' Allow once', '']) {
    const gate = createToolGate(), ticket = gate.begin(call)
    const verdict = gate.check(checked, { decision: 'ask', reason: 'User requested a checkpoint', rule: 'WebFetch(domain:rewritten.example)' })
    let asked = 0
    const result = await gate.finish(ticket, errorFor(verdict), async (question, options) => {
      asked++
      expect(question).toContain(JSON.stringify(checked.input)); expect(question).toContain('User requested a checkpoint')
      expect(options).toEqual(['Allow once', 'Deny'])
      return answer
    })
    expect(result.approved).toBe(answer === 'Allow once')
    expect(await gate.finish(ticket, errorFor(verdict), neverAsk)).toEqual({ approved: false })
    expect(asked).toBe(1)
  }
})

test('host and organization asks fail closed without substituting the mod prompt', async () => {
  for (const restriction of [{ ceiling: 'ask' as const }, { ceiling: 'deny' as const }, { decider: 'host' }]) {
    const gate = createToolGate(), ticket = gate.begin(call)
    const stopped = gate.check(checked, { decision: 'ask', ...restriction })
    const result = await gate.finish(ticket, errorFor(stopped), neverAsk)
    expect(result.approved).toBe(false)
    expect('reason' in result && result.reason).toContain('organization or host')
  }
})

test('queries and mismatched tool, call or agent identities do not capture another call', async () => {
  const gate = createToolGate(), ticket = gate.begin(call), native = { decision: 'allow' as const }
  for (const identity of [{ ...checked, tool_use_id: undefined }, { ...checked, tool: 'WebSearch' }, { ...checked, tool_use_id: 'other-call' }, { ...checked, agentId: undefined }, { ...checked, agentId: 'other-agent' }]) expect(gate.check(identity, native)).toBe(native)
  expect(await gate.finish(ticket, { isError: true, text: 'not owned' }, neverAsk)).toEqual({ approved: false })
})

test('concurrent tickets cannot consume each other or accept an overridden native result', async () => {
  const gate = createToolGate(), a = gate.begin(call), bCall = { ...call, tool_use_id: 'second-call' }, b = gate.begin(bCall)
  const aStop = gate.check(checked, { decision: 'allow' }), bStop = gate.check({ ...checked, ...bCall, input: { query: 'second' } }, { decision: 'allow' })
  expect(a.nonce).not.toBe(b.nonce)
  expect(await gate.finish(a, errorFor(bStop), neverAsk)).toEqual({ approved: false })
  expect(await gate.finish(a, errorFor(aStop), neverAsk)).toEqual({ approved: false })
  expect(await gate.finish(b, errorFor(bStop), neverAsk)).toEqual({ approved: true, input: { query: 'second' } })
  for (const native of [{ isError: false, text: 'ignored' }, { deny: 'refused' }, { isError: true }, { isError: true, text: 'unrelated error' }]) {
    const ticket = gate.begin(call), stopped = gate.check(checked, { decision: 'allow' })
    expect(await gate.finish(ticket, { ...native, ...(native.isError === false ? { text: stopped.reason } : {}) }, neverAsk)).toEqual({ approved: false })
  }
})

test('cleanup is idempotent and stale tickets cannot remove a reused call identity', async () => {
  const gate = createToolGate(), stale = gate.begin(call)
  expect(() => gate.begin(call)).toThrow('already active')
  gate.end(stale); gate.end(stale)
  const current = gate.begin(call), stopped = gate.check(checked, { decision: 'allow' })
  gate.end(stale)
  expect(await gate.finish(current, errorFor(stopped), neverAsk)).toEqual({ approved: true, input: checked.input })
  expect(() => gate.begin({ tool: 'WebFetch', tool_use_id: '' })).toThrow('real tool call')
})

test('aborts before or during a prompt and dismissed prompts never approve a replacement', async () => {
  for (const phase of ['before', 'during', 'during-pending', 'dismissed']) {
    const gate = createToolGate(), ticket = gate.begin(call), controller = new AbortController()
    const stopped = gate.check(checked, { decision: 'ask' })
    if (phase === 'before') controller.abort()
    let asked = 0
    const result = await gate.finish(ticket, errorFor(stopped), async () => {
      asked++
      if (phase === 'during') { controller.abort(); return 'Allow once' }
      if (phase === 'during-pending') { controller.abort(); return new Promise<string>(() => {}) }
      throw new Error('dismissed')
    }, controller.signal)
    expect(result.approved).toBe(false)
    expect(asked).toBe(phase === 'before' ? 0 : 1)
  }
})

test('the checked action is snapshotted before approval and later aliases cannot change it', async () => {
  const gate = createToolGate(), ticket = gate.begin(call)
  const input = { url: 'https://approved.example/page', extra: { prompt: 'original checked text' } }
  const stopped = gate.check({ ...call, input }, { decision: 'ask' })
  input.url = 'https://unapproved.example/page'
  input.extra.prompt = 'changed outside the gate'
  const result = await gate.finish(ticket, errorFor(stopped), async question => {
    expect(question).toContain('https://approved.example/page'); expect(question).not.toContain('unapproved')
    return 'Allow once'
  })
  expect(result).toEqual({ approved: true, input: { url: 'https://approved.example/page', extra: { prompt: 'original checked text' } } })
})

test('repeated checks or an action too large to display cannot obtain partial approval', async () => {
  const gate = createToolGate(), ticket = gate.begin(call), stopped = gate.check(checked, { decision: 'allow' })
  gate.check(checked, { decision: 'allow' })
  expect(await gate.finish(ticket, errorFor(stopped), neverAsk)).toEqual({ approved: false })
  const big = gate.begin(call), bigStop = gate.check({ ...checked, input: { text: 'x'.repeat(12001) } }, { decision: 'ask' })
  expect((await gate.finish(big, errorFor(bigStop), neverAsk)).approved).toBe(false)
})

test('a structurally copied ticket cannot consume the real ticket', async () => {
  const gate = createToolGate(), ticket = gate.begin(call), stopped = gate.check(checked, { decision: 'allow' })
  expect(await gate.finish({ ...ticket } as ToolGateTicket, errorFor(stopped), neverAsk)).toEqual({ approved: false })
  expect(await gate.finish(ticket, errorFor(stopped), neverAsk)).toEqual({ approved: true, input: checked.input })
})
