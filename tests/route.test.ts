import { expect, test } from 'claude-code/testing'

import { remember, withCarry } from '../hooks/carry'
import type { Carry } from '../hooks/carry'
import { compactRequest, summaryMessage, withUserText } from '../hooks/compact'
import { splitTarget } from '../hooks/protocol'
import type { ApiMessage } from '../hooks/protocol'
import { createAssembler } from '../hooks/step'
import { remoteTools } from '../hooks/tools'

test('a routed id splits into provider and model, a 1M tag dropped', async () => {
  expect(splitTarget('codex/gpt-6.1-sol')).toEqual({ provider: 'codex', model: 'gpt-6.1-sol' })
  expect(splitTarget('codex/gpt-6.1-sol[1m]')).toEqual({ provider: 'codex', model: 'gpt-6.1-sol' })
  expect(splitTarget('claude-opus-5-5')).toBe(null)
})

test('reasoning is put back before the tool call it led to, replacing any engine thinking', async () => {
  const carry: Carry = new Map()
  remember(carry, 'call_1', [{ thinking: 'plan', signature: 'multi-openai:x' }])
  remember(carry, undefined, [{ thinking: 'lost', signature: 's' }])
  const transcript: ApiMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'engine', signature: 'anthropic' }, { type: 'tool_use', id: 'call_1', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }] },
  ]
  const out = withCarry(transcript, carry)
  expect(out[1]?.content).toEqual([
    { type: 'thinking', thinking: 'plan', signature: 'multi-openai:x' },
    { type: 'tool_use', id: 'call_1', name: 'Read', input: {} },
  ])
  expect(withCarry(transcript, new Map())).toBe(transcript)
})

test('tools carry the generated schema for built-ins, a loose one otherwise, and MCP tools start deferred', async () => {
  const tools = remoteTools(
    [
      { name: 'Read', description: 'Read a file', mcp: false },
      { name: 'mcp__x__y', description: 'An MCP tool', mcp: true },
      { name: 'Hidden', description: 'Not offered', mcp: false },
    ],
    new Map([['Read', { description: 'Read a file, in full words', isDeferred: false }]]),
    name => name !== 'Hidden',
  )
  expect(tools.map(tool => tool.name)).toEqual(['Read', 'mcp__x__y'])
  expect(tools[0]?.description).toBe('Read a file, in full words')
  expect((tools[0]?.schema.properties as Record<string, unknown>).file_path).toBeDefined()
  expect(tools[1]?.deferred).toBe(true)
  expect(tools[1]?.schema).toEqual({ type: 'object', additionalProperties: true })
})

test('compaction asks for a summary on the last user turn and wraps the answer for continuation', async () => {
  const onUser: ApiMessage[] = [{ role: 'user', content: 'hello' }]
  const asked = compactRequest(onUser, 'the file names')
  expect(asked.length).toBe(1)
  expect(JSON.stringify(asked[0]?.content)).toContain('stressing: the file names')
  const onModel: ApiMessage[] = [...onUser, { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }]
  expect(withUserText(onModel, 'q').at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: 'q' }] })
  expect(summaryMessage('  done  ').endsWith('\n\ndone')).toBe(true)
})

test('the assembler turns events into numbered chunks and ends a tool step on tool_use', async () => {
  const assembler = createAssembler('codex/gpt-6.1-sol')
  const chunks = [
    ...assembler.feed({ type: 'thinking', text: 'a' }),
    ...assembler.feed({ type: 'text', text: 'b' }),
    ...assembler.feed({ type: 'text', text: 'c' }),
    ...assembler.feed({ type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: '/x' } }),
    ...assembler.feed({ type: 'usage', in: 10, out: 5, cacheRead: 2, cacheWrite: 0 }),
    ...assembler.feed({ type: 'stop', reason: 'tool_use' }),
  ]
  expect(chunks.map(chunk => `${chunk.kind}:${'index' in chunk ? chunk.index : ''}`)).toEqual(['thinking:0', 'text:1', 'text:1', 'tool:2', 'input:2'])
  const end = assembler.end()
  expect(end.stopReason).toBe('tool_use')
  expect(end.usage?.input_tokens).toBe(10)
  expect(end.toolUses).toEqual([{ name: 'Read', input: { file_path: '/x' } }])
})

test('a failed step answers its failure as text and reports no usage', async () => {
  const assembler = createAssembler('codex/gpt-6.1-sol')
  assembler.feed({ type: 'error', kind: 'request', text: 'codex: HTTP 429' })
  const end = assembler.end()
  expect(end.failure).toBe('codex: HTTP 429')
  expect(end.usage).toBe(null)
  expect(end.chunks.at(-1)).toEqual({ kind: 'stop', stopReason: 'end_turn', usage: null })
})
