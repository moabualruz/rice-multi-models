// The worker CLIs' streams, as recorded by cc-multi-cli-plugin (fixtures/workers/NOTICE.txt), read by the
// Antigravity and Grok parsers; the prompt and argument shapes. Run: bun test helper
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { StepRequest } from '../../hooks/protocol.ts'
import { agyArgs, agyEvents, grokArgs, grokParser, promptFor } from '../harness.ts'
import type { HarnessEvent } from '../harness.ts'

const lines = (name: string) =>
  readFileSync(join(import.meta.dir, 'fixtures', 'workers', `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as unknown)

const req: StepRequest = {
  target: 'agy/gemini-3.8-flash-high',
  system: '',
  tools: [],
  transcript: [
    { role: 'user', content: [{ type: 'text', text: '<system-reminder>\nnoise\n</system-reminder>' }, { type: 'text', text: 'Read note.txt and say what it holds.' }] },
  ],
  who: 'main',
  session: 's1',
  cwd: '/work/project',
}

test('Antigravity: the session, every action as progress, the response as the answer, usage, and success', () => {
  const events: HarnessEvent[] = lines('agy-calls').flatMap(agyEvents)
  expect(events[0]).toEqual({ kind: 'session', id: expect.any(String) })
  const actions = events.filter(event => event.kind === 'progress' && event.text.includes('▸')).map(event => (event as { text: string }).text.trim())
  expect(actions[0]).toBe('▸ view_file /work/project/note.txt')
  expect(actions.some(action => action.startsWith('▸ run_command echo a'))).toBe(true)
  expect(events.some(event => event.kind === 'answer')).toBe(true)
  expect(events.find(event => event.kind === 'usage')).toMatchObject({ kind: 'usage', out: expect.any(Number) })
  expect(events.at(-1)).toEqual({ kind: 'done', ok: true })
  const success = lines('agy-success').flatMap(agyEvents)
  expect(success.find(event => event.kind === 'answer')).toEqual({ kind: 'answer', text: 'probe' })
})

test('Grok: thoughts as progress, narration before a tool call as progress, the text after it as the answer', () => {
  const parser = grokParser()
  const events = lines('grok-tool').flatMap(parser.feed)
  const actions = events.filter(event => event.kind === 'progress' && event.text.includes('▸')).map(event => (event as { text: string }).text.trim())
  expect(actions).toEqual(['▸ run_terminal_command echo probe-ok Echo probe-ok to stdout'])
  expect(events.find(event => event.kind === 'session')).toEqual({ kind: 'session', id: '01a0bdb5-1ca3-7cf1-9a16-a3a9d5e2223c' })
  expect(events.some(event => event.kind === 'answer')).toBe(true)
  expect(events.at(-1)).toEqual({ kind: 'done', ok: true })
})

test('Grok: a stream cut before its end gives no answer and no done, so the step reports the exit instead', () => {
  const parser = grokParser()
  const events = lines('grok-cancelled').flatMap(parser.feed)
  expect(events.some(event => event.kind === 'done')).toBe(false)
  expect(events.some(event => event.kind === 'answer')).toBe(false)
})

test('the prompt is the user text without reminders; a resumed run sends only the turns after the last answer', () => {
  expect(promptFor(req)).toBe('Read note.txt and say what it holds.')
  expect(promptFor({ ...req, system: 'Be brief.' })).toBe('Be brief.\n\n# Task\n\nRead note.txt and say what it holds.')
  const resumed: StepRequest = {
    ...req,
    resume: 'c1',
    system: 'Be brief.',
    transcript: [...req.transcript, { role: 'assistant', content: [{ type: 'text', text: 'It holds two lines.' }] }, { role: 'user', content: 'Now count them.' }],
  }
  expect(promptFor(resumed)).toBe('Now count them.')
})

test('reading runs plan, writing runs accept edits; a resumed run names its conversation', () => {
  const agy = agyArgs({ ...req, effort: 'xhigh' }, 'gemini-3.8-flash-high', 'p')
  expect(agy).toEqual(['-p', 'p', '--output-format', 'stream-json', '--disable-slash-commands', '--model', 'gemini-3.8-flash-high', '--add-dir', '/work/project', '--effort', 'high', '--new-project', '--mode', 'plan'])
  expect(agyArgs({ ...req, resume: 'c1', workerWrite: true }, 'm', 'p').slice(-4)).toEqual(['--conversation', 'c1', '--mode', 'accept-edits'])
  const grok = grokArgs({ ...req, workerWrite: true, resume: 's9' }, 'grok-build', 'p')
  expect(grok.slice(0, 10)).toEqual(['-p', 'p', '--output-format', 'streaming-json', '--no-auto-update', '--model', 'grok-build', '--permission-mode', 'acceptEdits', '--cwd'])
  expect(grok.slice(-2)).toEqual(['--resume', 's9'])
  expect(grokArgs(req, 'grok-build', 'p')).toContain('--session-id')
  expect(grokArgs(req, 'grok-build', 'p')).toContain('plan')
})
