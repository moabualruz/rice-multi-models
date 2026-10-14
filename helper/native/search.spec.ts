import { expect, test } from 'bun:test'
import { domainMatches, searchStep } from './search.ts'
import type { NativeRequest } from './requests.ts'
import type { StepEvent, StepWire } from '../../hooks/protocol.ts'
import { nativeContracts } from './contracts.ts'

test('direct retrieval enforces native domain and path boundaries', () => {
  expect(domainMatches('https://sub.example.com/blog/one', 'example.com/blog')).toBe(true)
  expect(domainMatches('https://example.com/blogger', 'example.com/blog')).toBe(false)
  expect(domainMatches('https://example.com.attacker.test/blog', 'example.com/blog')).toBe(false)
})

test('native WebSearch keeps provider ownership through retrieval and returns native server blocks', async () => {
  const req = { target: 'owned/model', session: 'session', who: 'child', system: 'Native search instructions', transcript: [{ role: 'user' as const, content: 'Search the owned source' }], tools: [] }
  const native: NativeRequest = { model: 'haiku', stream: true, req, serverTools: [{ type: 'web_search_20250305', name: 'web_search', allowed_domains: ['example.com'], max_uses: 1 }] }
  const wire: StepWire = { req, configText: '', approved: [] }
  const requests: StepWire[] = []
  async function* direct(wire: StepWire): AsyncGenerator<StepEvent> {
    requests.push(wire)
    if (requests.length === 1) yield { type: 'tool_use', id: 't1', name: 'web_search', input: { query: 'owned query' } }
    else yield { type: 'text', text: 'Owned cited answer https://example.com/page' }
    yield { type: 'usage', in: 10, out: 5, cacheRead: 0, cacheWrite: 0 }; yield { type: 'stop', reason: requests.length === 1 ? 'tool_use' : 'end_turn' }
  }
  const events = []
  for await (const event of searchStep(wire, native, new AbortController().signal, direct, async query => { expect(query).toBe('owned query'); return [{ title: 'Owned', url: 'https://example.com/page', content: 'Owned content' }] })) events.push(event)
  expect(requests.map(wire => [wire.req.target, wire.req.who])).toEqual([['owned/model', 'child'], ['owned/model', 'child']])
  expect(events.filter(event => event.type === 'native_block').map(event => event.block.type)).toEqual(['server_tool_use', 'web_search_tool_result'])
  expect(events.find(event => event.type === 'usage')).toMatchObject({ in: 20, out: 10 })
  expect(events.at(-1)).toEqual({ type: 'stop', reason: 'end_turn' })
})

test('native stop strings spanning provider deltas terminate without a different-provider retry', async () => {
  let closed = false
  async function* input(): AsyncGenerator<StepEvent> { try { yield { type: 'text', text: 'Owned an' }; yield { type: 'text', text: 'swer <ST' }; yield { type: 'text', text: 'OP> hidden' }; throw new Error('must not read beyond stop') } finally { closed = true } }
  const events = []
  for await (const event of nativeContracts(input(), { stopSequences: ['<STOP>'] })) events.push(event)
  expect(events.filter(event => event.type === 'text').map(event => event.text).join('')).toBe('Owned answer ')
  expect(events.at(-1)).toEqual({ type: 'stop', reason: 'stop_sequence' })
  expect(closed).toBe(true)
})

test('text-only providers perform native WebSearch without unsupported function declarations', async () => {
  const req = { target: 'text/model', session: 'session', who: 'child', system: 'Native instructions', transcript: [{ role: 'user' as const, content: 'Search' }], tools: [] }
  const native: NativeRequest = { model: 'haiku', stream: true, req, serverTools: [{ type: 'web_search_20250305', name: 'web_search' }] }
  let calls = 0
  async function* direct(wire: StepWire): AsyncGenerator<StepEvent> {
    expect(wire.req.target).toBe('text/model'); expect(wire.req.tools).toEqual([])
    yield { type: 'text', text: calls++ === 0 ? '{"query":"owned search"}' : 'Owned answer https://example.com' }
    yield { type: 'stop', reason: 'end_turn' }
  }
  const events = []
  for await (const event of searchStep({ req, configText: '', approved: [] }, native, new AbortController().signal, direct, async () => [{ title: 'Owned', url: 'https://example.com', content: 'Owned' }], false)) events.push(event)
  expect(calls).toBe(2)
  expect(events.some(event => event.type === 'native_block' && event.block.type === 'web_search_tool_result')).toBe(true)
  expect(events.filter(event => event.type === 'text').map(event => event.text)).toEqual(['Owned answer https://example.com'])
})
