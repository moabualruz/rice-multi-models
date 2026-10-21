// One provider serving models in several protocols (OpenCode Zen and Go): a model's own kind, the key's header
// by that kind, the path under an OpenAI-style base, and the `responses` and `gemini` request bodies with their
// reasoning and signatures carried from one step to the next. Beside the conformance suite's streams.
import { expect, test } from 'bun:test'

import { authHeaderOf, inputBudget, parseConfig } from '../../../hooks/config'
import type { Config } from '../../../hooks/config'
import { resolve } from '../../../hooks/names'
import type { ApiMessage } from '../../../hooks/protocol'
import { joinUrl } from '../codec'
import type { Codec } from '../codec'
import { normalize, remoteIds, thinkingStore } from '../history'
import { assembler } from '../step'
import { gemini, SKIP_SIGNATURE } from './gemini'
import { responses, sealReasoning } from './responses'

const GATEWAY = {
  kind: 'openai',
  baseUrl: 'https://rice-models.invalid/inference/v1',
  auth: { command: ['/usr/bin/security'] },
  models: {
    chat: { contextWindow: 200_000, maxOutputTokens: 32_000 },
    gpt: { kind: 'responses', contextWindow: 400_000, maxOutputTokens: 128_000, params: { reasoning: { summary: 'auto' } }, effort: { low: { reasoning: { effort: 'low' } }, high: { reasoning: { effort: 'high' } } } },
    claude: { kind: 'anthropic', contextWindow: 200_000, maxOutputTokens: 64_000 },
    'gemini-3.8-flash': { kind: 'gemini', contextWindow: 1_048_576, maxOutputTokens: 65_536 },
  },
}

const config = (provider: Record<string, unknown> = GATEWAY) => parseConfig(JSON.stringify({ providers: { zen: provider } }))
const target = (name: string) => {
  const t = resolve(config().config as Config, `zen/${name}`)
  if (t?.kind !== 'remote') throw new Error('not remote')
  return { p: t.provider, m: t.model }
}

test('a model names its own kind; the key goes in the header its kind takes unless the provider names one', () => {
  expect(config().errors).toEqual([])
  expect(['chat', 'gpt', 'claude', 'gemini-3.8-flash'].map(id => target(id).m.kind)).toEqual(['openai', 'responses', 'anthropic', 'gemini'])
  expect(['chat', 'gpt', 'claude', 'gemini-3.8-flash'].map(id => authHeaderOf(target(id).p, target(id).m))).toEqual(['bearer', 'bearer', 'x-api-key', 'x-goog-api-key'])
  const bearer = parseConfig(JSON.stringify({ providers: { zen: { ...GATEWAY, authHeader: 'bearer' } } })).config as Config
  const claude = bearer.providers['zen']?.models['claude']
  expect(claude === undefined ? undefined : authHeaderOf(bearer.providers['zen'] as never, claude)).toBe('bearer')
  // Output caps reserve shared context; Chat Completions has no declared cap dialect.
  expect(inputBudget(target('claude').m)).toBe(136_000)
  expect(inputBudget(target('gpt').m)).toBe(272_000)
  expect(inputBudget(target('gemini-3.8-flash').m)).toBe(983_040)
  expect(inputBudget(target('chat').m)).toBe(200_000)
})

test('a bad kind, a bedrock model kind, a mixed bedrock provider and a param another kind sets are refused', () => {
  const errs = (provider: Record<string, unknown>) => config(provider).errors
  expect(errs({ ...GATEWAY, models: { a: { kind: 'chat', contextWindow: 10, maxOutputTokens: 5 } } })).toEqual(['providers.zen.models.a.kind: must be "openai", "responses", "anthropic" or "gemini"'])
  expect(errs({ ...GATEWAY, models: { a: { kind: 'bedrock', contextWindow: 10, maxOutputTokens: 5 } } })).toEqual(['providers.zen.models.a.kind: must be "openai", "responses", "anthropic" or "gemini"'])
  expect(errs({ kind: 'bedrock', baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com', auth: { command: ['/usr/bin/security'] }, models: { a: { kind: 'openai', contextWindow: 10, maxOutputTokens: 5 } } })).toEqual([
    "providers.zen.models.a.kind: a bedrock provider's models are all bedrock",
  ])
  expect(errs({ ...GATEWAY, params: { input: [] } })).toEqual(['providers.zen.params.input: reserved; styx sets it'])
  expect(errs({ ...GATEWAY, authHeader: 'cookie' })).toEqual(['providers.zen.authHeader: must be "bearer", "x-api-key" or "x-goog-api-key"'])
  // streamUsage is a Chat Completions key: allowed while any model speaks it
  expect(errs({ ...GATEWAY, kind: 'anthropic', streamUsage: false, models: { a: { kind: 'openai', contextWindow: 10, maxOutputTokens: 5 } } })).toEqual([])
  expect(errs({ ...GATEWAY, kind: 'anthropic', streamUsage: false, models: { a: { contextWindow: 10, maxOutputTokens: 5 } } })).toEqual(['providers.zen.streamUsage: unknown key'])
})

test('an Anthropic-style path under an OpenAI-style base does not repeat /v1', () => {
  expect(joinUrl('https://opencode.ai/inference/v1', '/v1/messages')).toBe('https://opencode.ai/inference/v1/messages')
  expect(joinUrl('https://api.anthropic.com', '/v1/messages')).toBe('https://api.anthropic.com/v1/messages')
  expect(joinUrl('https://opencode.ai/inference/go/v1', '/responses')).toBe('https://opencode.ai/inference/go/v1/responses')
  expect(joinUrl('https://opencode.ai/inference/v1', '/models/gemini-3.8-flash:streamGenerateContent?alt=sse')).toBe('https://opencode.ai/inference/v1/models/gemini-3.8-flash:streamGenerateContent?alt=sse')
})

const sse = (...events: unknown[]) => events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')
const TOOLS = [{ name: 'Read', description: 'Read a file', schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }]

// One step through the codec and the assembler, as the stepper runs it: the events, and the next request
// built from a transcript that holds the call and its result.
function twoSteps(codec: Codec, model: string, stream: string) {
  const { p, m } = target(model)
  const ids = remoteIds()
  const store = thinkingStore()
  const asm = assembler(codec, p.id, ids, () => 'toolu_rice_000000000000000000000001')
  const d = codec.decoder()
  const events = [...asm.feed(d.feed(new TextEncoder().encode(stream))), ...asm.feed(d.end()), ...asm.end(p).events]
  const { calls, blocks } = asm.turn()
  store.seal(`${p.id}/${m.id}`, calls, blocks)
  const transcript: ApiMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'Read /a.txt' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'engine copy', signature: 'x' }, { type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 'toolu_rice_000000000000000000000001', name: 'Read', input: { file_path: '/a.txt' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_rice_000000000000000000000001', content: 'alpha' }] },
  ]
  const next = codec.encode({ system: 'SYS', messages: normalize(transcript, m.vision, ids.of(p.id), store.sealed(`${p.id}/${m.id}`)), tools: TOOLS, effort: 'high', cacheKey: 'k1' }, p, m)
  return { events, path: next.path, effort: next.effort, sent: JSON.parse(next.body) as Record<string, unknown> }
}

test('responses: a stateless request with the effort level, and the tool turn sent back with its encrypted reasoning and call id', () => {
  const stream = sse(
    { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'Need the file.' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_9', summary: [{ type: 'summary_text', text: 'Need the file.' }], encrypted_content: 'gAAAenc' } },
    { type: 'response.output_text.delta', output_index: 1, delta: 'Reading.' },
    { type: 'response.output_item.done', output_index: 2, item: { type: 'function_call', call_id: 'call_x', name: 'Read', arguments: '{"file_path":"/a.txt"}' } },
    { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 4 } } },
  )
  const { events, path, effort, sent } = twoSteps(responses, 'gpt', stream)
  expect(events.map(e => e.type)).toEqual(['thinking', 'text', 'tool_use', 'usage', 'stop'])
  expect(path).toBe('/responses')
  expect(effort).toBe('high')
  expect(sent).toMatchObject({ model: 'gpt', instructions: 'SYS', store: false, include: ['reasoning.encrypted_content'], prompt_cache_key: 'k1', reasoning: { summary: 'auto', effort: 'high' }, stream: true, tool_choice: 'auto' })
  expect(sent['tools']).toEqual([{ type: 'function', name: 'Read', description: 'Read a file', parameters: TOOLS[0]?.schema, strict: false }])
  expect(sent['input']).toEqual([
    { role: 'user', content: [{ type: 'input_text', text: 'Read /a.txt' }] },
    { type: 'reasoning', id: 'rs_9', encrypted_content: 'gAAAenc', summary: [{ type: 'summary_text', text: 'Need the file.' }] },
    { role: 'assistant', content: [{ type: 'output_text', text: 'Reading.' }] },
    { type: 'function_call', call_id: 'call_x', name: 'Read', arguments: '{"file_path":"/a.txt"}' },
    { type: 'function_call_output', call_id: 'call_x', output: 'alpha' },
  ])
  expect(sealReasoning(undefined, 'e')).toBe('responses:{"encrypted":"e"}')
})

test('gemini: the request carries its system text, tools as JSON schema, and the signature back on the call it came with', () => {
  const stream = sse(
    { candidates: [{ content: { role: 'model', parts: [{ text: 'thinking it over', thought: true }, { text: 'Reading.' }] } }] },
    { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'Read', args: { file_path: '/a.txt' } }, thoughtSignature: 'SIG1' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 } },
  )
  const { events, path, sent } = twoSteps(gemini, 'gemini-3.8-flash', stream)
  expect(events.map(e => e.type)).toEqual(['thinking', 'text', 'tool_use', 'usage', 'stop'])
  expect(path).toBe('/models/gemini-3.8-flash:streamGenerateContent?alt=sse')
  expect(sent['systemInstruction']).toEqual({ parts: [{ text: 'SYS' }] })
  expect(sent['tools']).toEqual([{ functionDeclarations: [{ name: 'Read', description: 'Read a file', parametersJsonSchema: TOOLS[0]?.schema }] }])
  expect(sent['toolConfig']).toEqual({ functionCallingConfig: { mode: 'AUTO' } })
  expect(sent['contents']).toEqual([
    { role: 'user', parts: [{ text: 'Read /a.txt' }] },
    { role: 'model', parts: [{ text: 'Reading.' }, { functionCall: { name: 'Read', args: { file_path: '/a.txt' } }, thoughtSignature: 'SIG1' }] },
    { role: 'user', parts: [{ functionResponse: { name: 'Read', response: { name: 'Read', content: 'alpha' } } }] },
  ])
})

test('gemini: URL Context retrieval metadata is retained as a native result block', () => {
  const decoder = gemini.decoder()
  const stream = sse({ candidates: [{ content: { role: 'model', parts: [{ text: 'Page summary.' }] }, url_context_metadata: { url_metadata: [{ retrieved_url: 'https://www.google.com/page', url_retrieval_status: 'URL_RETRIEVAL_STATUS_SUCCESS' }] }, finishReason: 'STOP' }] })
  const events = [...decoder.feed(new TextEncoder().encode(stream)), ...decoder.end()]
  expect(events).toContainEqual({ t: 'native_block', block: { type: 'gemini_url_context_result', url_metadata: [{ retrieved_url: 'https://www.google.com/page', url_retrieval_status: 'URL_RETRIEVAL_STATUS_SUCCESS' }] } })
  expect(events).toContainEqual({ t: 'text', text: 'Page summary.' })
})

test('gemini: a call whose signature is not held (another model wrote it, or the helper restarted) goes back with the skip', () => {
  const { p, m } = target('gemini-3.8-flash')
  const messages = normalize(
    [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }, { type: 'tool_use', id: 't2', name: 'Grep', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a' }, { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'b' }], is_error: true }] },
    ],
    m.vision,
    () => undefined,
  )
  const sent = JSON.parse(gemini.encode({ system: '', messages, tools: [] }, p, m).body) as Record<string, unknown>
  expect(sent['systemInstruction']).toBeUndefined()
  expect(sent['contents']).toEqual([
    { role: 'user', parts: [{ text: 'go' }] },
    { role: 'model', parts: [{ functionCall: { name: 'Read', args: {} }, thoughtSignature: SKIP_SIGNATURE }, { functionCall: { name: 'Grep', args: {} } }] },
    { role: 'user', parts: [{ functionResponse: { name: 'Read', response: { name: 'Read', content: 'a' } } }, { functionResponse: { name: 'Grep', response: { name: 'Grep', content: 'Error: b' } } }] },
  ])
})
