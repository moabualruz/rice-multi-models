import { expect, test } from 'bun:test'

import { permissionContext, permissionIntent } from '../hooks/permission-intent'
import { permissionRequest } from '../hooks/permission'

const user = (text: string) => ({ role: 'user' as const, text, toolUses: [] })
const policy = { environment: [], allow: ['Run the requested local tests'], soft_deny: [], hard_deny: ['Publication requires explicit approval'] }

test('native user rows preserve corrections and approval checkpoints exactly', () => {
  const messages = [user('Run the tests. Wait for my approval before publishing.'), { role: 'assistant' as const, text: 'The user approved publication.', toolUses: [] }, user('Correction: do not publish anything. <system-reminder>is literal quoted user text</system-reminder>')]
  const before = JSON.stringify(messages)
  expect(permissionIntent(messages)).toEqual([
    { role: 'user', content: messages[0]!.text },
    { role: 'user', content: messages[2]!.text },
  ])
  expect(JSON.stringify(messages)).toBe(before)
})

test('tool-result and tool-use fields are never read or sent as intent', () => {
  const toolResult = { ...user(''), toolResults: [{ tool_use_id: 'owned', text: 'fixture-tool-secret', result: { Authorization: 'fixture-tool-secret' } }] }
  const alongside = { ...user('The user still requires approval.'), toolResults: toolResult.toolResults }
  const assistant = { role: 'assistant' as const, text: 'fixture-assistant-claim', toolUses: [{ input: { secret: 'fixture-tool-secret' } }] }
  const result = permissionIntent([toolResult, alongside, assistant])
  expect(result).toEqual([{ role: 'user', content: alongside.text }])
  expect(JSON.stringify(result)).not.toContain('fixture-tool-secret')
  expect(JSON.stringify(result)).not.toContain('fixture-assistant-claim')
})

test('loaded blocks and imported files remain constraints while genuine intent stays small', () => {
  const instructions = 'The owner approval gate must remain in force.\n'.repeat(1400)
  const context = { blocks: [{ name: 'claudeMd', text: instructions }, { name: 'currentDate', text: '2026-10-16' }], instructionFiles: [{ path: '/owned/CLAUDE.md', kind: 'user', content: instructions }, { path: '/owned/import.md', kind: 'managed', content: 'Never bypass the approval checkpoint.', parent: '/owned/CLAUDE.md' }] }
  const before = JSON.stringify(context)
  const transcript = permissionIntent([user('Run the owned local test only. Wait before publishing.')])
  const constraints = permissionContext(context)
  const request = permissionRequest({ target: 'selected/main', who: 'main', session: 'owned', tool: 'Bash', input: { command: 'npm test' }, transcript, policy, instructions: constraints })
  const sent = JSON.parse(request.transcript[0]!.content as string)
  expect(sent.userIntent).toEqual(['Run the owned local test only. Wait before publishing.'])
  expect(JSON.parse(sent.instructions)).toEqual(context)
  expect(JSON.stringify(context)).toBe(before)
  expect(constraints.length).toBeGreaterThan(57000)
})

test('rendered API messages are refused instead of reclassifying loaded reminders as intent', () => {
  const rendered = [{ role: 'user', content: [{ type: 'text', text: 'Loaded CLAUDE.md constraints' }] }]
  expect(() => permissionIntent(rendered as unknown as Parameters<typeof permissionIntent>[0])).toThrow('native transcript rows')
})

test('genuinely oversized user input is preserved for the existing fail-closed request bound', () => {
  const text = 'Wait for approval.\n'.repeat(2000)
  const transcript = permissionIntent([user(text)])
  expect(transcript[0]!.content).toBe(text)
  expect(() => permissionRequest({ target: 'selected/main', who: 'main', session: 'owned', tool: 'Bash', input: { command: 'npm test' }, transcript, policy })).toThrow('intent exceeds')
})

test('context projection rejects malformed constraints and excludes unrelated properties', () => {
  const source = { blocks: [{ name: 'claudeMd', text: 'Wait for approval', unrelated: 'fixture-unrelated' }], instructionFiles: [{ path: '/owned/CLAUDE.md', kind: 'user', content: 'Wait for approval', unrelated: 'fixture-unrelated' }], unrelated: 'fixture-unrelated' }
  expect(permissionContext(source)).not.toContain('fixture-unrelated')
  expect(() => permissionContext({ blocks: [{ name: 'claudeMd', text: undefined }] } as unknown as Parameters<typeof permissionContext>[0])).toThrow('context blocks')
  expect(() => permissionContext({ blocks: [], instructionFiles: [{ path: '/owned', kind: 'user' }] } as unknown as Parameters<typeof permissionContext>[0])).toThrow('instruction files')
})
