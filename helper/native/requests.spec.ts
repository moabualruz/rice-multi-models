import { expect, test } from 'bun:test'
import { nativeRequest } from './requests.ts'
import { NativeResponse, providerResponse } from './responses.ts'
import type { StepEvent } from '../../hooks/protocol.ts'

test('native alias, transcript and output constraints stay separate from a child owner', () => {
  const result = nativeRequest({ model: 'claude-haiku-4-5', system: [{ type: 'text', text: 'Native instruction' }],
    messages: [{ role: 'user', content: 'Owned request' }], tools: [{ name: 'Check', input_schema: { type: 'object' } }],
    max_tokens: 37, stream: true, output_config: { effort: 'low', format: { type: 'json_schema', schema: { type: 'object' } } }, tool_choice: { type: 'tool', name: 'Check' },
  }, { model: 'other/selected', agentId: 'child', sessionId: 'session' })
  expect(result.req).toMatchObject({ target: 'other/selected', who: 'child', session: 'session', system: 'Native instruction', effort: 'low', native: { maxTokens: 37, toolChoice: { type: 'tool', name: 'Check' }, outputSchema: { type: 'object' } } })
  expect(result.model).toBe('claude-haiku-4-5')
  expect(() => nativeRequest({ model: 'codex/model', messages: [] }, { unowned: true })).toThrow('owner')
})

test('native compactor positional system reminders retain their text and ordering', () => {
  const result = nativeRequest({ model: 'codex/native', messages: [{ role: 'user', content: 'Earlier' }, { role: 'system', content: 'Keep the original constraint' }, { role: 'assistant', content: 'Later' }] }, { model: 'codex/owned' })
  expect(result.req.transcript.map(message => message.role)).toEqual(['user', 'user', 'assistant'])
  expect(result.req.transcript[1].content).toBe('<system-reminder>\nKeep the original constraint\n</system-reminder>')
})

test('native SSE closes every block and preserves signed reasoning, tools, usage and stop', () => {
  const response = new NativeResponse('native-alias')
  const events: StepEvent[] = [{ type: 'thinking', text: 'Reason' }, { type: 'signature', thinking: 'Reason', signature: 'sealed' },
    { type: 'text', text: 'Answer' }, { type: 'tool_use', id: 't1', name: 'Check', input: { value: 3 } },
    { type: 'usage', in: 17, out: 8, cacheRead: 2, cacheWrite: 0 }, { type: 'stop', reason: 'tool_use' }]
  const result = [...response.start(), ...events.flatMap(event => response.feed(event)), ...response.end()]
  expect(result.filter(event => event.type === 'content_block_start').map(event => event.index)).toEqual([0, 1, 2])
  expect(result.filter(event => event.type === 'content_block_stop').map(event => event.index)).toEqual([0, 1, 2])
  expect(result.at(-1)?.type).toBe('message_stop')
  expect(response.message()).toMatchObject({ stop_reason: 'tool_use', usage: { input_tokens: 17, output_tokens: 8 }, content: [{ type: 'thinking', thinking: 'Reason', signature: 'sealed' }, { type: 'text', text: 'Answer' }, { type: 'tool_use', id: 't1', name: 'Check', input: { value: 3 } }] })
})

test('provider failure and incomplete streams do not masquerade as successful native answers', async () => {
  const response = new NativeResponse('alias')
  response.feed({ type: 'text', text: 'Partial' })
  expect(response.end().at(-1)?.type).toBe('error')
  expect(response.ok()).toBe(false)
  async function* failed(): AsyncGenerator<StepEvent> { yield { type: 'error', kind: 'request', text: 'private provider bytes' } }
  const result = await providerResponse('alias', failed(), new AbortController().signal, () => {}, false)
  expect(result.status).toBe(400)
  expect(result.headers.get('x-should-retry')).toBe('false')
  expect(await result.text()).not.toContain('private provider bytes')
})

test('abandoning a native stream cancels its owned direct iterator', async () => {
  let cancelled = false, closed = false
  async function* events(): AsyncGenerator<StepEvent> { try { yield { type: 'text', text: 'Owned' }; yield { type: 'stop', reason: 'end_turn' } } finally { closed = true } }
  const response = await providerResponse('alias', events(), new AbortController().signal, () => { cancelled = true }, true)
  const reader = response.body!.getReader()
  await reader.read(); await reader.read(); await reader.cancel()
  expect(cancelled).toBe(true)
  expect(closed).toBe(true)
})

test('native readers progress through accounting events and the terminal stop', async () => {
  async function* events(): AsyncGenerator<StepEvent> {
    yield { type: 'limits', limits: { windows: [] } }
    yield { type: 'text', text: 'Owned complete stream' }
    yield { type: 'usage', in: 3, out: 4, cacheRead: 0, cacheWrite: 0 }
    yield { type: 'stop', reason: 'end_turn' }
    yield { type: 'stats', ttfbMs: 1, totalMs: 2 }
  }
  const response = await providerResponse('alias', events(), new AbortController().signal, () => {}, true)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const value = await Promise.race([response.text(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('native reader stalled on a non-content event')), 200) })])
    expect(value).toContain('Owned complete stream')
    expect(value).toContain('event: message_stop')
  } finally { clearTimeout(timer) }
})

test('unsupported server caps never become silently successful native output overruns', async () => {
  async function* events(): AsyncGenerator<StepEvent> { yield { type: 'text', text: 'Too much' }; yield { type: 'usage', in: 1, out: 20, cacheRead: 0, cacheWrite: 0 }; yield { type: 'stop', reason: 'end_turn' } }
  const response = await providerResponse('codex/owned', events(), new AbortController().signal, () => {}, false, 2)
  expect(response.status).toBe(400)
  expect(response.headers.get('x-should-retry')).toBe('false')
})
