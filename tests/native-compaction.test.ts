import { expect, test } from 'bun:test'
import { compactionPrompt, deriveTemplate, fitTranscript, INSTRUCTIONS_MARK, isTemplate, SUMMARY_MARK, summaryBody, summaryMessage, TRANSCRIPT_TOKEN } from '../hooks/native-compaction'
import type { CompactionCapture } from '../hooks/native-compaction'
import type { ApiMessage } from '../hooks/protocol'

// The engine's texts are stood in for by owned fixtures with the same structure.
const HEAD = 'Summarize the conversation.\n\nIf instructions follow, obey them.\n'
const TAIL = '\nREMINDER: text only.'
const plain = `${HEAD}${TAIL}`
const custom = `${HEAD}\nAdditional Instructions:\n${INSTRUCTIONS_MARK}\n${TAIL}`
const path = '/tmp/owned/session.jsonl'
const summary = `This session is being continued.\n\nSummary:\n${SUMMARY_MARK}\n\nRead the full transcript at: ${path}\nResume directly.`
const capture: CompactionCapture = { version: '9.9.9', plain, custom, summaryMessage: summary, transcriptPath: path }

test('a capture becomes a template that renders both engine texts exactly', () => {
  const template = deriveTemplate(capture)
  expect(isTemplate(template)).toBe(true)
  expect(template.version).toBe('9.9.9')
  expect(compactionPrompt(template)).toBe(plain)
  expect(compactionPrompt(template, INSTRUCTIONS_MARK)).toBe(custom)
  expect(compactionPrompt(template, '  Retain the approval gate  ')).toBe(`${HEAD}\nAdditional Instructions:\nRetain the approval gate\n${TAIL}`)
  expect(compactionPrompt(template, '   ')).toBe(plain)
  expect(template.summaryTail).toContain(TRANSCRIPT_TOKEN)
  expect(template.summaryTail).not.toContain(path)
  expect(summaryMessage(template, 'BODY', path)).toBe(summary.replace(SUMMARY_MARK, 'BODY'))
})

test('without a transcript path only the line that cites it is left out', () => {
  const template = deriveTemplate(capture)
  expect(summaryMessage(template, 'BODY')).toBe('This session is being continued.\n\nSummary:\nBODY\n\nResume directly.')
})

test('a capture that is not what the engine is expected to produce is refused, not guessed', () => {
  expect(() => deriveTemplate({ ...capture, custom: plain })).toThrow('not longer')
  expect(() => deriveTemplate({ ...capture, custom: `${HEAD}x${TAIL}Y` })).toThrow()
  expect(() => deriveTemplate({ ...capture, custom: `${HEAD}\nAdditional Instructions:\nother\n${TAIL}` })).toThrow('do not appear')
  expect(() => deriveTemplate({ ...capture, summaryMessage: 'no body here' })).toThrow('summary body')
  expect(isTemplate({ version: '1' })).toBe(false)
  expect(isTemplate(null)).toBe(false)
})

test('the summary is the inside of the summary block, else the reply without its analysis', () => {
  expect(summaryBody('<analysis>thinking</analysis>\n<summary>\n1. Primary Request\n</summary>')).toBe('1. Primary Request')
  expect(summaryBody('<analysis>thinking</analysis>\nJust the summary text')).toBe('Just the summary text')
  expect(summaryBody('<summary>cut off')).toBe('cut off')
  expect(summaryBody('<analysis>only analysis</analysis>')).toBeUndefined()
  expect(summaryBody('   ')).toBeUndefined()
})

const user = (text: string): ApiMessage => ({ role: 'user', content: [{ type: 'text', text }] })
const call = (id: string): ApiMessage => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: {} }] })
const result = (id: string, text: string): ApiMessage => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] })

test('a transcript that fits is sent whole', () => {
  const messages = [user('task'), call('a'), result('a', 'ok'), user('next')]
  expect(fitTranscript(messages, 100_000)).toMatchObject({ messages, omitted: 0, clipped: 0, fits: true, explanation: 'no transcript content excluded' })
})

test('long tool outputs are shortened before anything is left out', () => {
  const messages = [user('task'), call('a'), result('a', 'x'.repeat(60_000)), user('next')]
  const fitted = fitTranscript(messages, 12_000)
  expect(fitted.omitted).toBe(0)
  expect(fitted.clipped).toBeGreaterThan(0)
  expect(fitted.fits).toBe(true)
  expect(fitted.explanation).toContain('tool-result blocks clipped')
  expect(JSON.stringify(fitted.messages).length).toBeLessThanOrEqual(12_000)
  expect(JSON.stringify(fitted.messages)).toContain('characters omitted')
})

test('repeated fitting reports omissions against original content, not a prior clipped marker', () => {
  const messages = [user('task'), call('a'), result('a', 'x'.repeat(100_000)), user('next')]
  const fitted = fitTranscript(messages, 12_000)
  expect(fitted.fits).toBe(true)
  expect(fitted.omitted).toBe(0)
  expect(fitted.clipped).toBe(1)
  expect(JSON.stringify(fitted.messages)).toContain('94000 characters omitted')
  expect(JSON.stringify(messages)).not.toContain('characters omitted')
})

test('the oldest exchanges are left out whole, the task stays, and no result loses its call', () => {
  const messages: ApiMessage[] = [user('the task')]
  for (let i = 0; i < 20; i++) messages.push(call(`c${i}`), result(`c${i}`, `out ${i} ${'y'.repeat(1_500)}`))
  messages.push(user('latest'))
  const fitted = fitTranscript(messages, 6_000)
  expect(fitted.omitted).toBeGreaterThan(0)
  expect(fitted.messages[0]).toEqual(user('the task'))
  expect(fitted.messages.at(-1)).toEqual(user('latest'))
  expect(fitted.fits).toBe(true)
  expect(fitted.explanation).toContain(`${fitted.omitted} messages excluded from this request copy`)
  expect(fitted.excluded.length).toBe(fitted.omitted)
  const calls = new Set(fitted.messages.flatMap(message => typeof message.content === 'string' ? [] : message.content.filter(block => block.type === 'tool_use').map(block => block.id as string)))
  for (const message of fitted.messages) if (typeof message.content !== 'string') for (const block of message.content) if (block.type === 'tool_result') expect(calls.has(block.tool_use_id as string)).toBe(true)
})

test('request fitting preserves opaque handles and leaves the source transcript untouched', () => {
  const original = [
    { ...user('task'), handle: 'whole-first-handle' },
    { ...call('pair'), handle: 'whole-call-handle' },
    { ...result('pair', 'z'.repeat(30_000)), handle: 'whole-result-handle' },
    { ...user('latest'), handle: 'whole-latest-handle' },
  ] as ApiMessage[]
  const before = JSON.stringify(original)
  const fitted = fitTranscript(original, 5_000)
  expect(fitted.fits).toBe(true)
  expect(JSON.stringify(original)).toBe(before)
  expect(fitted.messages.map(message => (message as ApiMessage & { handle?: string }).handle)).toEqual(['whole-first-handle', 'whole-call-handle', 'whole-result-handle', 'whole-latest-handle'])
  expect((fitted.messages[0] as ApiMessage & { handle?: string }).handle).toBe('whole-first-handle')
  expect((fitted.messages.at(-1) as ApiMessage & { handle?: string }).handle).toBe('whole-latest-handle')
})

test('rejects an orphan tool result instead of forwarding a broken tool exchange', () => {
  const fitted = fitTranscript([user('task'), result('missing', 'result')], 10_000)
  expect(fitted.fits).toBe(false)
  expect(fitted.messages).toHaveLength(2)
  expect(fitted.explanation).toContain('1 unpaired tool-result blocks')
})

test('reports when the protected first and latest messages cannot fit without dropping history silently', () => {
  const messages = [user('x'.repeat(4_000)), user('y'.repeat(4_000))]
  const fitted = fitTranscript(messages, 100)
  expect(fitted.fits).toBe(false)
  expect(fitted.messages).toHaveLength(2)
  expect(fitted.omitted).toBe(0)
  expect(fitted.explanation).toBe('no transcript content excluded')
})
