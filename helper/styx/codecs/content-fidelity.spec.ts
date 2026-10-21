import { expect, test } from 'bun:test'

import { parseConfig } from '../../../hooks/config'
import type { ApiMessage } from '../../../hooks/protocol'
import { normalize } from '../history'
import { CODECS } from './index'

const parsed = parseConfig(JSON.stringify({
  providers: {
    anthropic: { kind: 'anthropic', baseUrl: 'https://anthropic.example', auth: 'none', models: { m: { vision: true, maxOutputTokens: 1024 } } },
    chat: { kind: 'openai', baseUrl: 'https://chat.example', auth: 'none', models: { m: { vision: true, maxOutputTokens: 1024, maxTokensParam: 'max_tokens' } } },
    responses: { kind: 'responses', baseUrl: 'https://responses.example', auth: 'none', models: { m: { vision: true, maxOutputTokens: 1024 } } },
    gemini: { kind: 'gemini', baseUrl: 'https://gemini.example', auth: 'none', models: { m: { vision: true, maxOutputTokens: 1024 } } },
    bedrock: { kind: 'bedrock', baseUrl: 'https://bedrock.example', auth: { command: ['/usr/bin/false'] }, models: { m: { vision: true, maxOutputTokens: 1024 } } },
  },
}))

const config = parsed.config!
const messages: ApiMessage[] = [
  { role: 'user', content: [
    { type: 'text', text: 'Review these files.' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } },
    { type: 'document', title: 'report.pdf', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } },
    { type: 'document', title: 'notes.txt', source: { type: 'text', media_type: 'text/plain', data: 'important note' } },
  ] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: { path: 'report.pdf' } }] },
  { role: 'user', content: [{
    type: 'tool_result', tool_use_id: 'call-1', content: [
      { type: 'text', text: 'read complete' },
      { type: 'document', title: 'result.pdf', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } },
      { type: 'document', title: 'result.txt', source: { type: 'text', media_type: 'text/plain', data: 'tool text' } },
    ],
  }] },
]

function body(id: string): Record<string, unknown> {
  const provider = config.providers[id]!
  const model = provider.models['m']!
  const encoded = CODECS[model.kind].encode({
    system: 'system',
    messages: normalize(messages, model.vision, () => undefined),
    tools: [],
  }, provider, model)
  return JSON.parse(encoded.body) as Record<string, unknown>
}

const has = (items: unknown, expected: unknown): boolean => Array.isArray(items) && items.some(item => JSON.stringify(item) === JSON.stringify(expected))

test('Anthropic request body forwards image, native PDF and text document blocks, including tool-result documents', () => {
  const sent = body('anthropic')
  const turns = sent['messages'] as { role: string; content: Record<string, unknown>[] }[]
  expect(has(turns[0]?.content, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } })).toBe(true)
  expect(has(turns[0]?.content, { type: 'document', title: 'report.pdf', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } })).toBe(true)
  expect(has(turns[0]?.content, { type: 'document', title: 'notes.txt', source: { type: 'text', media_type: 'text/plain', data: 'important note' } })).toBe(true)
  expect(has(turns[2]?.content[0]?.['content'], { type: 'document', title: 'result.pdf', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } })).toBe(true)
})

test('Chat Completions translates plain-text documents and explicitly notes PDF omissions', () => {
  const sent = body('chat')
  const turns = sent['messages'] as { role: string; content: unknown }[]
  expect(JSON.stringify(turns)).toContain('Review these files.')
  expect(JSON.stringify(turns)).toContain('important note')
  expect(JSON.stringify(turns)).toContain('data:image/png;base64,aW1hZ2U=')
  expect(JSON.stringify(turns)).toContain('[document omitted: Chat Completions does not accept PDF document blocks]')
  expect(JSON.stringify(turns)).toContain('read complete')
  expect(JSON.stringify(turns)).toContain('tool text')
})

test('Responses request body translates PDF files, text documents and images into input items', () => {
  const sent = body('responses')
  const input = sent['input'] as Record<string, unknown>[]
  expect(JSON.stringify(input)).toContain('data:application/pdf;base64,JVBERi0=')
  expect(JSON.stringify(input)).toContain('important note')
  expect(JSON.stringify(input)).toContain('data:image/png;base64,aW1hZ2U=')
  expect(JSON.stringify(input)).toContain('tool text')
  expect(JSON.stringify(input)).toContain('result.pdf')
})

test('Gemini request body translates PDF files to inlineData and plain-text documents to text', () => {
  const sent = body('gemini')
  const contents = sent['contents'] as Record<string, unknown>[]
  expect(JSON.stringify(contents)).toContain('"mimeType":"application/pdf","data":"JVBERi0="')
  expect(JSON.stringify(contents)).toContain('important note')
  expect(JSON.stringify(contents)).toContain('"mimeType":"image/png","data":"aW1hZ2U="')
  expect(JSON.stringify(contents)).toContain('tool text')
})

test('Bedrock Converse request body translates PDF documents to document bytes and text documents to text', () => {
  const sent = body('bedrock')
  const turns = sent['messages'] as { role: string; content: Record<string, unknown>[] }[]
  expect(JSON.stringify(turns)).toContain('"format":"pdf","name":"report.pdf","source":{"bytes":"JVBERi0="}')
  expect(JSON.stringify(turns)).toContain('important note')
  expect(JSON.stringify(turns)).toContain('"format":"png","source":{"bytes":"aW1hZ2U="}')
  expect(JSON.stringify(turns)).toContain('read complete')
  expect(JSON.stringify(turns)).toContain('tool text')
  expect(JSON.stringify(turns)).toContain('"format":"pdf","name":"result.pdf"')
})
