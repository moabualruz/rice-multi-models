import { expect, test } from 'bun:test'
import { titleAnswer, titleRequest, TITLE_SYSTEM } from '../hooks/titles'

test('title request is bounded and belongs to the selected main conversation', () => {
  const request = titleRequest('selected/actual', 'owned-session', 'x'.repeat(13_000))
  expect(request.target).toBe('selected/actual')
  expect(request.session).toBe('owned-session')
  expect(request.who).toBe('main')
  expect(request.system).toBe(TITLE_SYSTEM)
  expect(request.tools).toEqual([])
  expect(request.transcript).toEqual([{ role: 'user', content: 'x'.repeat(12_000) }])
  expect(request.native).toEqual({ maxTokens: 128, toolChoice: { type: 'none' } })
})

test('only a plain bounded title is accepted', () => {
  expect(titleAnswer('  Fix account switching  ')).toBe('Fix account switching')
  for (const text of ['', 'x'.repeat(81), 'two\nlines', 'Title: hi', '# hi', '"quoted"', 'bad\u0000title']) expect(titleAnswer(text)).toBeUndefined()
})
