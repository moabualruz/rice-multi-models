import { expect, test } from 'bun:test'
import { retainedTail, withUserText, type CompactMessage } from '../hooks/compact'

const row = (role: 'user' | 'assistant', text: string, handle: string): CompactMessage => ({ role, text, toolUses: [], handle })

test('the latest user round is retained as the engine\'s own messages, the rest is left to the summary', () => {
  const original = [row('user', 'Edit /repo/a.ts; wait for approval to publish', 'a'), row('assistant', 'Tests passed at abc123; publication pending', 'b'), row('user', 'Correction: /repo/b.ts, then continue', 'c'), row('assistant', 'Reading the corrected path', 'd')]
  const snapshot = JSON.stringify(original)
  const retained = retainedTail(original)
  expect(retained).toEqual(original.slice(2))
  expect(retained[0]).toBe(original[2]!)
  expect(retained[1]).toBe(original[3]!)
  expect(JSON.stringify(original)).toBe(snapshot)
})

test('pending tool calls remain actual engine messages with matching handles', () => {
  const original = [row('user', 'Run checks', 'a'), row('assistant', 'First checks passed', 'b'), { ...row('assistant', '', 'pending'), toolUses: [{ tool_use_id: 'owned-tool', tool: 'Bash', input: { command: 'npm test' } }] }]
  expect(retainedTail(original)).toEqual([original[2]!])
})

test('completed tool evidence is left to the summary; empty histories and an all-pending history fail closed', () => {
  const original = [row('user', 'Check files', 'a'), { ...row('assistant', '', 'b'), toolUses: [{ tool_use_id: 'read-id', tool: 'Read', input: { file_path: '/repo/a.ts' }, text: 'verified contents' }] }]
  expect(retainedTail(original)).toEqual([])
  expect(() => retainedTail([])).toThrow('no conversation')
  expect(() => retainedTail([{ ...row('assistant', '', 'p'), toolUses: [{ tool_use_id: 'pending', tool: 'Bash', input: {} }] }])).toThrow('pending tools')
})

test('interleaved user steering keeps tool calls paired with their later retained results', () => {
  const original: CompactMessage[] = [row('user', 'Run a check', 'a'), { ...row('assistant', '', 'b'), toolUses: [{ tool_use_id: 'interleaved', tool: 'Bash', input: { command: 'npm test' }, text: 'owned result' }] }, row('user', 'Retain this correction too', 'c'), { ...row('user', '', 'd'), toolResults: [{ tool_use_id: 'interleaved', text: 'owned result', isError: false }] }]
  const retained = retainedTail(original)
  expect(retained).toEqual(original.slice(1))
  expect(retained[0]).toBe(original[1]!)
  expect(retained.at(-1)).toBe(original.at(-1)!)
})

const tool = (id: string, output: string, handle: string): CompactMessage[] => [
  { ...row('assistant', '', `${handle}-call`), toolUses: [{ tool_use_id: id, tool: 'Bash', input: { command: `step ${id}` } }] },
  { ...row('user', '', `${handle}-result`), toolResults: [{ tool_use_id: id, text: output, result: { stdout: output }, isError: false }] },
]

test('a long agentic round keeps a bounded tail that starts at an exchange', () => {
  const original: CompactMessage[] = [row('user', 'Fix every failing test', 'task')]
  for (let i = 0; i < 40; i++) original.push(...tool(`t${i}`, `output ${i} `.repeat(200), `h${i}`))
  const retained = retainedTail(original, { retainChars: 20_000 })
  const retainedChars = retained.reduce((sum, message) => sum + JSON.stringify([message.text, message.toolUses, message.toolResults ?? []]).length, 0)
  expect(retainedChars).toBeLessThanOrEqual(20_000)
  expect(retained.length).toBeGreaterThan(0)
  expect(retained[0]!.role).toBe('assistant')
  const kept = new Set(retained.flatMap(message => message.toolUses.map(use => use.tool_use_id)))
  for (const message of retained) for (const result of message.toolResults ?? []) expect(kept.has(result.tool_use_id)).toBe(true)
})

test('the latest user message stays in the tail however long the history before it is', () => {
  const original: CompactMessage[] = [row('user', 'Migrate the service', 'task')]
  for (let i = 0; i < 30; i++) original.push(...tool(`m${i}`, 'x'.repeat(50_000), `g${i}`))
  original.push(row('user', 'Keep going', 'latest'))
  const retained = retainedTail(original, { retainChars: 10_000 })
  expect(retained.at(-1)!.text).toBe('Keep going')
})

test('the prompt is appended to the last user turn, or opens a new one when the transcript ends on the model', () => {
  const ending = withUserText([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }], 'summarize')
  expect(ending.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: 'summarize' }] })
  const open = withUserText([{ role: 'user', content: 'a' }], 'summarize')
  expect(open).toEqual([{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'summarize' }] }])
})
