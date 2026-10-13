import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeConversation } from '../core/conversation.ts'
import type { ContentBlock, RequestMessage } from '../core/messages.ts'
import { toResponses } from '../core/responses.ts'

const searchCall: ContentBlock = {
  type: 'server_tool_use', id: 'srvtoolu_search', name: 'web_search',
  input: { query: 'translator history', allowed_domains: ['example.com'] },
}
const searchResult: ContentBlock = {
  type: 'web_search_tool_result', tool_use_id: 'srvtoolu_search',
  content: [{
    type: 'web_search_result', title: 'Translator documentation',
    url: 'https://example.com/docs?q=history', encrypted_content: 'fixture-search-content',
    page_age: 'October 12, 2026',
  }],
}
const fetchCall: ContentBlock = {
  type: 'server_tool_use', id: 'srvtoolu_fetch', name: 'web_fetch',
  input: { url: 'https://example.com/docs?q=history' },
}
const fetchResult: ContentBlock = {
  type: 'web_fetch_tool_result', tool_use_id: 'srvtoolu_fetch',
  content: {
    type: 'web_fetch_result', url: 'https://example.com/docs?q=history',
    retrieved_at: '2026-10-13T00:00:00Z',
    content: {
      type: 'document', title: 'Translator documentation',
      source: { type: 'text', media_type: 'text/plain', data: 'Keep the search history.\nKeep result IDs and URLs.' },
      citations: { enabled: true },
    },
  },
}

function historical(blocks: ContentBlock[], role = 'assistant') {
  const input = toResponses({ messages: [{ role, content: blocks }] }, 'fixture-model').input
  assert.equal(input.length, blocks.length)
  return input.map((item, index) => {
    assert.ok('role' in item, 'server tools must not become function calls or outputs')
    assert.equal(item.role, role)
    assert.equal(item.content.length, 1)
    const part = item.content[0]!
    assert.equal(part.type, role === 'assistant' ? 'output_text' : 'input_text')
    assert.ok('text' in part)
    assert.match(part.text, /^Historical server tool transcript \(/)
    const serialized = part.text.slice(part.text.indexOf('\n') + 1)
    assert.deepEqual(JSON.parse(serialized), blocks[index])
    return part.text
  })
}

test('server search and fetch history survives Codex translation without executable tool calls', () => {
  const blocks = [searchCall, searchResult, fetchCall, fetchResult]
  const texts = historical(blocks)
  assert.ok(texts[0]!.includes('web_search'))
  assert.ok(texts[0]!.includes('translator history'))
  assert.ok(texts[1]!.includes('https://example.com/docs?q=history'))
  assert.ok(texts[3]!.includes('Keep result IDs and URLs.'))
})

test('server results alone remain historical text, including user-role transcripts', () => {
  historical([searchResult, fetchResult])
  historical([searchResult, fetchResult], 'user')
})

test('server result error objects and empty search results are preserved', () => {
  historical([
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_empty', content: [] },
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_search_error', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
    { type: 'web_fetch_tool_result', tool_use_id: 'srvtoolu_fetch_error', content: { type: 'web_fetch_tool_result_error', error_code: 'url_not_accessible' } },
  ])
})

test('fetched PDF documents and nullable document titles are preserved without input files', () => {
  historical([{
    type: 'web_fetch_tool_result', tool_use_id: 'srvtoolu_pdf',
    content: {
      type: 'web_fetch_result', url: 'https://example.com/docs.pdf', retrieved_at: null,
      content: { type: 'document', title: null, source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } },
    },
  }])
})

test('mixed history keeps text order and ordinary client tool calls unchanged', () => {
  const messages: RequestMessage[] = [
    { role: 'user', content: 'Research this.' },
    { role: 'assistant', content: [
      { type: 'text', text: 'Searching.' }, searchCall, searchResult,
      { type: 'text', text: 'Reading the local file.' },
      { type: 'tool_use', id: 'toolu_local', name: 'Read', input: { file_path: '/fixture.txt' } },
    ] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_local', content: 'Local text.' }] },
    { role: 'user', content: 'Summarize this conversation.' },
  ]
  const input = toResponses({ messages }, 'fixture-model').input
  assert.equal(input.length, 8)
  assert.deepEqual(input[0], { role: 'user', content: [{ type: 'input_text', text: 'Research this.' }] })
  assert.deepEqual(input[1], { role: 'assistant', content: [{ type: 'output_text', text: 'Searching.' }] })
  assert.deepEqual(input[4], { role: 'assistant', content: [{ type: 'output_text', text: 'Reading the local file.' }] })
  assert.deepEqual(input.filter(item => 'type' in item), [
    { type: 'function_call', call_id: 'toolu_local', name: 'Read', arguments: '{"file_path":"/fixture.txt"}' },
    { type: 'function_call_output', call_id: 'toolu_local', output: 'Local text.' },
  ])
  assert.deepEqual(input.at(-1), { role: 'user', content: [{ type: 'input_text', text: 'Summarize this conversation.' }] })
})

test('unknown outer and server result block types still reject', () => {
  for (const role of ['assistant', 'user', 'system']) {
    assert.throws(() => normalizeConversation([{ role, content: [{ type: 'future_unknown_block' }] }]), /Unsupported native worker content: future_unknown_block/)
  }
  for (const block of [
    { type: 'web_search_tool_result', tool_use_id: 'srv', content: [{ type: 'future_search_result' }] },
    { type: 'web_fetch_tool_result', tool_use_id: 'srv', content: { type: 'future_fetch_result' } },
    { type: 'web_fetch_tool_result', tool_use_id: 'srv', content: { type: 'web_fetch_result', url: 'https://example.com', content: { type: 'future_document' } } },
  ]) {
    assert.throws(() => normalizeConversation([{ role: 'assistant', content: [block] }]), /Unsupported.*content/)
  }
  assert.throws(() => normalizeConversation([{ role: 'user', content: [searchCall] }]), /Unsupported native worker content: server_tool_use/)
})

test('malformed recognized server blocks reject rather than dropping their content', () => {
  for (const block of [
    { type: 'server_tool_use', name: 'web_search', input: {} },
    { type: 'server_tool_use', id: 'srv', name: 'web_search', input: [] },
    { type: 'web_search_tool_result', content: [] },
    { type: 'web_search_tool_result', tool_use_id: 'srv', content: 'not a result array' },
    { type: 'web_search_tool_result', tool_use_id: 'srv', content: [{ type: 'web_search_result', title: 'missing URL and content' }] },
    { type: 'web_fetch_tool_result', tool_use_id: 'srv', content: [] },
    { type: 'web_fetch_tool_result', tool_use_id: 'srv', content: { type: 'web_fetch_tool_result_error', error_code: 3 } },
    { type: 'web_fetch_tool_result', tool_use_id: 'srv', content: { type: 'web_fetch_result', url: 'https://example.com', content: { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 3 } } } },
  ]) {
    assert.throws(() => normalizeConversation([{ role: 'assistant', content: [block] }]))
  }
})
