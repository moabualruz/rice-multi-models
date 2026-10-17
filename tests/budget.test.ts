import { expect, test } from 'bun:test'
import { anchoredEstimate, reportedInput } from '../hooks/budget'
import { estimateTokens } from '../hooks/providers'

test('reported input counts fresh input plus cache reads and writes', () => {
  expect(reportedInput({ input_tokens: 532, cache_read_input_tokens: 126464, cache_creation_input_tokens: 0 })).toBe(126996)
  expect(reportedInput({ input_tokens: 0 })).toBeUndefined()
  expect(reportedInput(null)).toBeUndefined()
})

test('a long tool-heavy transcript is measured from the provider report, not the 2x character heuristic', () => {
  const transcript = Array.from({ length: 150 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: 'tool output '.repeat(500) }))
  const whole = () => estimateTokens({ transcript })
  const anchor = { model: 'codex/gpt', tokens: 127000, messages: 148 }
  const anchored = anchoredEstimate(anchor, 'codex/gpt', transcript, whole)
  expect(anchored).toBe(127000 + estimateTokens(transcript.slice(148)))
  expect(anchored).toBeLessThan(whole())
})

test('no anchor, another model or a shrunken transcript falls back to the whole heuristic', () => {
  const transcript = [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }]
  const whole = () => 999
  expect(anchoredEstimate(undefined, 'a/m', transcript, whole)).toBe(999)
  expect(anchoredEstimate({ model: 'b/m', tokens: 5, messages: 1 }, 'a/m', transcript, whole)).toBe(999)
  expect(anchoredEstimate({ model: 'a/m', tokens: 5, messages: 3 }, 'a/m', transcript, whole)).toBe(999)
  expect(anchoredEstimate({ model: 'a/m', tokens: 5, messages: 2 }, 'a/m', transcript, whole)).toBe(5)
})

test('per-agent state keeps only the newest entries', async () => {
  const { setCapped } = await import('../hooks/util')
  const map = new Map<string, number>()
  for (let i = 0; i < 12; i++) setCapped(map, `agent-${i}`, i, 5)
  expect([...map.keys()]).toEqual(['agent-7', 'agent-8', 'agent-9', 'agent-10', 'agent-11'])
  setCapped(map, 'agent-8', 80, 5)
  expect([...map.keys()].at(-1)).toBe('agent-8')
  expect(map.get('agent-8')).toBe(80)
})
