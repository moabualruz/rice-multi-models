import { expect, test } from 'bun:test'
import { compactionPrompt, deriveTemplate, INSTRUCTIONS_MARK, isTemplate, SUMMARY_MARK, summaryBody, summaryMessage, TRANSCRIPT_TOKEN } from '../hooks/native-compaction'
import type { CompactionCapture } from '../hooks/native-compaction'

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

