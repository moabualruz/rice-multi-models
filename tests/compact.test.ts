import { expect, test } from 'bun:test'
import { persistedCompactSource, retainedTail, withUserText, type CompactMessage } from '../hooks/compact'

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

test('persisted context uses event UUID order and native API normalization, never file or branch order', () => {
  const event = [row('user', 'Approval required.', 'a'), row('assistant', 'Pending.', 'b'), row('user', 'Continue.', 'c'), row('assistant', 'Checking.', 'd')]
  const records = event.map(message => ({ type: message.role, uuid: message.handle, sessionId: 'owned', message: { role: message.role, content: message.text } }))
  const api = event.slice(-2).map(message => ({ role: message.role, content: [{ type: 'text', text: message.text }] }))
  const jsonl = [...records].reverse().concat({ ...records[0]!, uuid: 'archived', message: { role: 'user', content: 'Not active.' } }).map(record => JSON.stringify(record)).join('\n') + '\n'
  const recovered = persistedCompactSource(jsonl, event, 'owned', api)
  expect(recovered.map(message => JSON.stringify(message.content))).toEqual(event.map(message => JSON.stringify([{ type: 'text', text: message.text }])))
  expect(recovered.at(-1)).toBe(api.at(-1))
  expect(JSON.stringify(recovered)).not.toContain('Not active.')
  for (const [source, messages, session, suffix, reason] of [
    [jsonl.trimEnd(), event, 'owned', api, 'unflushed'],
    [jsonl + '{partial\n', event, 'owned', api, 'partial'],
    [jsonl, [{ ...event[0]!, handle: undefined }, ...event.slice(1)], 'owned', api, 'UUID'],
    [jsonl, event, 'other', api, 'session'],
    [jsonl, event, 'owned', [{ role: 'user', content: 'newer native content' }], 'API suffix'],
  ] as const) expect(() => persistedCompactSource(source, messages, session, suffix)).toThrow(reason)
})

test.each(['isMeta', 'isVirtual'] as const)('persisted context refuses an unprojected %s constraint outside the API suffix', flag => {
  const event = Array.from({ length: 4098 }, (_, i) => row(i % 2 ? 'assistant' : 'user', `owned ${i}`, `visible-${i}`))
  const visible = event.map(message => ({ type: message.role, uuid: message.handle, sessionId: 'owned', isSidechain: false, message: { role: message.role, content: message.role === 'user' ? message.text : [{ type: 'text', text: message.text }] } }))
  const constraint = { type: 'user', uuid: 'hidden-constraint', sessionId: 'owned', isSidechain: false, [flag]: true, message: { role: 'user', content: 'HIDDEN_APPROVAL: do not publish without approval.' } }
  const records = [visible[0]!, constraint, ...visible.slice(1)].map((record, i, all) => ({ ...record, parentUuid: i ? all[i - 1]!.uuid : null }))
  const api = visible.slice(-4096).map(record => ({ role: record.message.role, content: typeof record.message.content === 'string' ? [{ type: 'text', text: record.message.content }] : record.message.content }))
  const jsonl = (rows: unknown[]) => rows.map(record => JSON.stringify(record)).join('\n') + '\n'
  expect(event).toHaveLength(4098)
  expect(JSON.stringify(event)).not.toContain('HIDDEN_APPROVAL')
  expect(JSON.stringify(api)).not.toContain('HIDDEN_APPROVAL')
  expect(JSON.stringify(records)).toContain('HIDDEN_APPROVAL')
  const control = persistedCompactSource(jsonl(visible), event, 'owned', api)
  expect(control).toHaveLength(4098)
  expect(control.at(-1)).toBe(api.at(-1))
  expect(() => persistedCompactSource(jsonl(records), event, 'owned', api)).toThrow('unsupported meta or virtual context')
})

test.each(['isMeta', 'isVirtual'] as const)('unmatched %s flags on another session or non-context records do not change event authority', flag => {
  const event = [row('user', 'Approval required.', 'a'), row('assistant', 'Pending.', 'b')]
  const records = event.map(message => ({ type: message.role, uuid: message.handle, sessionId: 'owned', message: { role: message.role, content: message.text } }))
  const ignored = [
    { type: 'user', uuid: 'other-session', sessionId: 'other', [flag]: true, message: { role: 'user', content: 'Other session context.' } },
    { type: 'queue-operation', sessionId: 'owned', operation: 'enqueue', [flag]: true, content: 'Queued, not contextual.' },
    { type: 'progress', uuid: 'progress', sessionId: 'owned', [flag]: true, data: { type: 'hook_progress' } },
  ]
  const api = [{ role: 'assistant' as const, content: [{ type: 'text' as const, text: 'Pending.' }] }]
  const jsonl = [...ignored, ...records].map(record => JSON.stringify(record)).join('\n') + '\n'
  expect(persistedCompactSource(jsonl, event, 'owned', api)).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Approval required.' }] }, ...api])
})

const cappedToolSource = () => {
  const readInput = { file_path: '/owned/task.ts' }, readResult = { type: 'text', file: { content: 'approval pending' } }
  const agentInput = { description: 'Check approval', prompt: 'Inspect the owned task', subagent_type: 'general-purpose' }
  const agentResult = { agentId: 'stored-child', totalDurationMs: 17, content: [{ type: 'text', text: 'Approval pending.' }] }
  const records: any[] = [
    { type: 'user', uuid: 'approval', message: { role: 'user', content: 'Publication requires approval.' } },
    { type: 'assistant', uuid: 'agent-call', message: { role: 'assistant', content: [{ type: 'text', text: 'Checking. ' }, { type: 'text', text: 'Delegating.' }, { type: 'tool_use', id: 'agent', name: 'Agent', input: agentInput }] } },
    { type: 'user', uuid: 'agent-result', toolUseResult: agentResult, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'agent', content: [{ type: 'text', text: 'Approval pending.' }] }] } },
    { type: 'assistant', uuid: 'read-call', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'read', name: 'Read', input: readInput }] } },
    { type: 'user', uuid: 'read-result', toolUseResult: readResult, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read', content: 'approval pending' }] } },
    ...Array.from({ length: 4097 }, (_, i) => ({ type: i % 2 ? 'user' : 'assistant', uuid: `filler-${i}`, message: { role: i % 2 ? 'user' : 'assistant', content: [{ type: 'text', text: `owned ${i}` }] } })),
  ].map(record => ({ ...record, sessionId: 'owned', isSidechain: false }))
  const event: CompactMessage[] = [
    row('user', 'Publication requires approval.', 'approval'),
    { ...row('assistant', 'Checking. Delegating.', 'agent-call'), toolUses: [{ tool_use_id: 'agent', tool: 'Agent', input: agentInput, text: 'Approval pending.', result: agentResult, agentId: 'stored-child', durationMs: 17 }] },
    { ...row('user', '', 'agent-result'), toolResults: [{ tool_use_id: 'agent', text: 'Approval pending.', isError: false, result: agentResult }] },
    { ...row('assistant', '', 'read-call'), toolUses: [{ tool_use_id: 'read', tool: 'Read', input: readInput, text: 'approval pending', result: readResult }] },
    { ...row('user', '', 'read-result'), toolResults: [{ tool_use_id: 'read', text: 'approval pending', isError: false, result: readResult }] },
    ...records.slice(5).map(record => row(record.type as 'user' | 'assistant', record.message.content[0].text, record.uuid)),
  ]
  const api = records.slice(-4096).map(record => ({ role: record.message.role, content: record.message.content }))
  return { records, event, api, jsonl: () => [...records].reverse().map(record => JSON.stringify(record)).join('\n') + '\n' }
}

test('capped persisted context recovers native Agent and Read exchanges outside the API suffix', () => {
  const f = cappedToolSource()
  const recovered = persistedCompactSource(f.jsonl(), f.event, 'owned', f.api)
  expect(recovered).toHaveLength(f.event.length)
  expect(recovered[1]!.content).toEqual(f.records[1]!.message.content)
  expect(recovered[2]!.content).toEqual(f.records[2]!.message.content)
  expect(recovered[3]!.content).toEqual(f.records[3]!.message.content)
  expect(recovered[4]!.content).toEqual(f.records[4]!.message.content)
  expect(recovered.at(-1)).toBe(f.api.at(-1))
})

test.each(['input', 'result-text', 'stored-result', 'event-result', 'error', 'pending', 'duplicate-call', 'duplicate-result', 'orphan-result', 'missing', 'conflicting', 'unflushed', 'annotated', 'replacement'] as const)('persisted native tool recovery fails closed on %s', boundary => {
  const f = cappedToolSource()
  if (boundary === 'input') f.records[1].message.content[2].input = { ...f.records[1].message.content[2].input, prompt: 'Publish now' }
  if (boundary === 'result-text') f.records[2].message.content[0].content[0].text = 'Approved.'
  if (boundary === 'stored-result') f.records[2].toolUseResult = { ...f.records[2].toolUseResult, agentId: 'different-child' }
  if (boundary === 'event-result') f.event[1]!.toolUses[0]!.result = { changed: true }
  if (boundary === 'error') f.records[4].message.content[0].is_error = true
  if (boundary === 'pending') { f.records[4].message.content = []; f.event[4]!.toolResults = []; delete f.event[3]!.toolUses[0]!.result; delete f.event[3]!.toolUses[0]!.text }
  if (boundary === 'duplicate-call') f.records[3].message.content.push(structuredClone(f.records[1].message.content[2]))
  if (boundary === 'duplicate-result') f.records[4].message.content.push(structuredClone(f.records[4].message.content[0]))
  if (boundary === 'orphan-result') f.records[4].message.content[0].tool_use_id = 'unknown'
  if (boundary === 'missing') f.records.splice(2, 1)
  if (boundary === 'conflicting') f.records.push({ ...f.records[2], toolUseResult: { different: true } })
  if (boundary === 'annotated') f.records[2].message.content[0].content[0].citations = [{ type: 'char_location' }]
  if (boundary === 'replacement') f.records.push({ type: 'content-replacement', sessionId: 'owned', replacements: [] })
  expect(() => persistedCompactSource(boundary === 'unflushed' ? f.jsonl().trimEnd() : f.jsonl(), f.event, 'owned', f.api)).toThrow('persisted compaction context')
})

test('persisted native tool blocks agree with the available API suffix and retain error identity', () => {
  const f = cappedToolSource()
  f.records[4].message.content[0].is_error = true
  f.event[4]!.toolResults![0]!.isError = true
  f.event[3]!.toolUses[0]!.isError = true
  const api = f.records.slice(1).map(record => ({ role: record.message.role, content: record.message.content }))
  expect(persistedCompactSource(f.jsonl(), f.event, 'owned', api).at(1)).toBe(api[0])
  const changed = structuredClone(api)
  changed[2]!.content[0].input.file_path = '/owned/different.ts'
  expect(() => persistedCompactSource(f.jsonl(), f.event, 'owned', changed)).toThrow('API suffix')
})

test('the prompt is appended to the last user turn, or opens a new one when the transcript ends on the model', () => {
  const ending = withUserText([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }], 'summarize')
  expect(ending.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: 'summarize' }] })
  const open = withUserText([{ role: 'user', content: 'a' }], 'summarize')
  expect(open).toEqual([{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'summarize' }] }])
})
