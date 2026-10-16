import { expect, test } from 'bun:test'
import { compactionPlan, compactedMessages, type CompactMessage } from '../hooks/compact'

const row = (role: 'user' | 'assistant', text: string, handle: string): CompactMessage => ({ role, text, toolUses: [], handle })

test('summary input preserves completed work and corrections while retaining the latest opaque round', () => {
  const original = [row('user', 'Edit /repo/a.ts; wait for approval to publish', 'a'), row('assistant', 'Tests passed at abc123; publication pending', 'b'), row('user', 'Correction: /repo/b.ts, then continue', 'c'), row('assistant', 'Reading the corrected path', 'd')]
  const snapshot = JSON.stringify(original)
  const plan = compactionPlan(original, 'Retain the approval gate')
  const sent = JSON.parse(plan.prompt)
  expect(sent.continuationInstructions).toBe('Retain the approval gate')
  expect(sent.conversation.map((message: any) => message.text)).toEqual(original.slice(0, 2).map(message => message.text))
  expect(plan.prompt).not.toContain('"handle"')
  const result = compactedMessages('Verified abc123; await publication approval', plan.retained)
  expect(result[1]).toBe(original[2])
  expect(result[2]).toBe(original[3])
  expect(JSON.stringify(original)).toBe(snapshot)
})

test('pending tool calls remain actual engine messages with matching handles', () => {
  const original = [row('user', 'Run checks', 'a'), row('assistant', 'First checks passed', 'b'), { ...row('assistant', '', 'pending'), toolUses: [{ tool_use_id: 'owned-tool', tool: 'Bash', input: { command: 'npm test' } }] }]
  const plan = compactionPlan(original)
  expect(plan.retained).toEqual([original[2]!])
  expect(plan.prompt).not.toContain('owned-tool')
})

test('completed tool evidence is summarized, empty histories and empty replies fail closed', () => {
  const original = [row('user', 'Check files', 'a'), { ...row('assistant', '', 'b'), toolUses: [{ tool_use_id: 'read-id', tool: 'Read', input: { file_path: '/repo/a.ts' }, text: 'verified contents' }] }]
  const plan = compactionPlan(original)
  expect(plan.prompt).toContain('verified contents')
  expect(plan.retained).toEqual([])
  expect(() => compactionPlan([])).toThrow('no conversation')
  expect(() => compactedMessages('  ', [])).toThrow('empty summary')
  expect(() => compactionPlan([{ ...row('assistant', '', 'p'), toolUses: [{ tool_use_id: 'pending', tool: 'Bash', input: {} }] }])).toThrow('pending tools')
})

test('interleaved user steering keeps tool calls paired with their later retained results', () => {
  const original: CompactMessage[] = [row('user', 'Run a check', 'a'), { ...row('assistant', '', 'b'), toolUses: [{ tool_use_id: 'interleaved', tool: 'Bash', input: { command: 'npm test' }, text: 'owned result' }] }, row('user', 'Retain this correction too', 'c'), { ...row('user', '', 'd'), toolResults: [{ tool_use_id: 'interleaved', text: 'owned result', isError: false }] }]
  const plan = compactionPlan(original)
  expect(plan.retained).toEqual(original.slice(1))
  expect(plan.retained[0]).toBe(original[1])
  expect(plan.retained.at(-1)).toBe(original.at(-1))
  expect(JSON.parse(plan.prompt).conversation).toHaveLength(1)
})

const tool = (id: string, output: string, handle: string): CompactMessage[] => [
  { ...row('assistant', '', `${handle}-call`), toolUses: [{ tool_use_id: id, tool: 'Bash', input: { command: `step ${id}` } }] },
  { ...row('user', '', `${handle}-result`), toolResults: [{ tool_use_id: id, text: output, result: { stdout: output }, isError: false }] },
]

test('a long agentic round is summarized down to a bounded tail that starts at an exchange', () => {
  const original: CompactMessage[] = [row('user', 'Fix every failing test', 'task')]
  for (let i = 0; i < 40; i++) original.push(...tool(`t${i}`, `output ${i} `.repeat(200), `h${i}`))
  const plan = compactionPlan(original, undefined, { retainChars: 20_000 })
  const retainedChars = plan.retained.reduce((sum, message) => sum + JSON.stringify([message.text, message.toolUses, message.toolResults ?? []]).length, 0)
  expect(retainedChars).toBeLessThanOrEqual(20_000)
  expect(plan.retained.length).toBeGreaterThan(0)
  expect(plan.retained[0]!.role).toBe('assistant')
  const kept = new Set(plan.retained.flatMap(message => message.toolUses.map(use => use.tool_use_id)))
  for (const message of plan.retained) for (const result of message.toolResults ?? []) expect(kept.has(result.tool_use_id)).toBe(true)
  const sent = JSON.parse(plan.prompt)
  expect(sent.conversation[0].text).toBe('Fix every failing test')
  // Each output appears once, as text, not again as a structured result.
  expect(plan.prompt).not.toContain('"stdout"')
})

test('the summary request is fitted to its bound, keeping the task and saying what was left out', () => {
  const original: CompactMessage[] = [row('user', 'Migrate the service', 'task')]
  for (let i = 0; i < 30; i++) original.push(...tool(`m${i}`, 'x'.repeat(50_000), `g${i}`))
  original.push(row('user', 'Keep going', 'latest'))
  const plan = compactionPlan(original, 'Keep the deploy gate', { promptChars: 60_000, retainChars: 10_000 })
  expect(plan.prompt.length).toBeLessThanOrEqual(60_000)
  const sent = JSON.parse(plan.prompt)
  expect(sent.conversation[0].text).toBe('Migrate the service')
  expect(plan.prompt).toContain('characters omitted for compaction')
  expect(plan.retained.at(-1)!.text).toBe('Keep going')
  expect(() => compactionPlan([row('user', 'y'.repeat(10_000), 'a'), row('user', 'next', 'b')], undefined, { promptChars: 100 })).toThrow('does not fit')
})
