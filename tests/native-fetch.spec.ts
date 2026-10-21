import { expect, test } from 'bun:test'
import { nativeFetchModel, runNativeFetch } from '../hooks/native-fetch.ts'
import { webFetchToolType } from '../helper/native/web-fetch.ts'

const url = 'https://www.google.com/guide'
const authHandle = ['fixture', 'authorization'].join('-')
const modelList = { data: [{ id: 'claude-haiku-5-5', max_tokens: 8192 }] }
const documentResult = (text: string, sourceUrl = url) => ({ type: 'web_fetch_tool_result', tool_use_id: 'srvtoolu_fixture_fetch', content: { type: 'web_fetch_result', url: sourceUrl, content: { type: 'document', source: { type: 'text', media_type: 'text/plain', data: text } } } })
const answer = { type: 'message', stop_reason: 'end_turn', content: [
  { type: 'server_tool_use', id: 'srvtoolu_fixture_fetch', name: 'web_fetch', input: { url } },
  documentResult('Fetched source text.'),
  { type: 'text', text: 'The source says this.' },
] }
const context = (messages: unknown[] = [answer], models: unknown = modelList) => ({
  authorize: async () => ({ handle: authHandle, kind: 'bearer' as const }),
  resolve: async () => [{ address: '93.184.216.34', family: 4 as const }],
  fetch: async (asked: string, init: { method?: string; body?: string; auth?: string }) => {
    expect(init.auth).toBe(authHandle)
    if (asked.endsWith('/v1/models?limit=1000')) return { status: 200, ok: true, text: JSON.stringify(models) }
    const body = JSON.parse(init.body ?? '{}')
    expect(body.tools).toEqual([{ type: 'web_fetch_20260318', name: 'web_fetch', max_uses: 1, max_content_tokens: 8192 }])
    expect(body.tool_choice).toEqual({ type: 'auto' })
    expect(body.messages[0].content).toContain(url)
    return { status: 200, ok: true, text: JSON.stringify(messages.shift()) }
  },
})

test('native model selection does not depend on undocumented WebFetch capability fields', () => {
  expect(nativeFetchModel(modelList)).toEqual({ id: 'claude-haiku-5-5', maxTokens: 4096 })
  expect(nativeFetchModel({ data: [{ id: 'claude-opus-4-5', max_tokens: 4096, lifecycle: 'active' }] })).toEqual({ id: 'claude-opus-4-5', maxTokens: 4096 })
  expect(nativeFetchModel({ data: [{ id: 'claude-mythos-preview-202610', max_tokens: 4096 }] })).toEqual({ id: 'claude-mythos-preview-202610', maxTokens: 4096 })
  expect(() => nativeFetchModel({ data: [{ id: 'claude-haiku-5-5', lifecycle: 'active', capabilities: { server_tools: { web_fetch: { supported: false } } } }] })).toThrow('No supported Claude API model')
  expect(() => nativeFetchModel({ data: [{ id: 'not-a-claude-model', lifecycle: 'active' }] })).toThrow('No supported Claude API model')
})

test('native WebFetch tool type follows model generation support', () => {
  expect(webFetchToolType('claude-opus-4-5')).toBe('web_fetch_20250910')
  expect(webFetchToolType('claude-sonnet-4-6')).toBe('web_fetch_20260318')
  expect(webFetchToolType('claude-haiku-5-5')).toBe('web_fetch_20260318')
  expect(webFetchToolType('claude-mythos-preview-202610')).toBe('web_fetch_20260318')
})

test('native fallback authorizes through the host, fetches the exact URL and preserves final source attribution', async () => {
  const finalUrl = 'https://www.google.com/guide/current'
  const fixture = context([{ ...answer, content: [answer.content[0], documentResult('Fetched source text.', finalUrl), answer.content[2]] }])
  const result = await runNativeFetch({ url, prompt: 'Extract the conclusion.' }, fixture, new AbortController().signal)
  expect(result).toMatchObject({ url: finalUrl, code: 200, codeText: 'OK', result: 'The source says this.', bytes: Buffer.byteLength('Fetched source text.') })
})

test('valid empty native content remains terminal', async () => {
  const empty = { type: 'message', stop_reason: 'end_turn', content: [
    { type: 'server_tool_use', id: 'srvtoolu_fixture_fetch', name: 'web_fetch', input: { url } },
    documentResult(''),
    { type: 'text', text: '' },
  ] }
  const result = await runNativeFetch({ url, prompt: 'Extract the conclusion.' }, context([empty]), new AbortController().signal)
  expect(result.result).toBe('')
})

test('native fallback rejects malformed result URLs, missing authorization, mismatched tools and cancellation', async () => {
  const noLogin = { ...context(), authorize: async () => null }
  await expect(runNativeFetch({ url, prompt: 'Read.' }, noLogin, new AbortController().signal)).rejects.toThrow('without a first-party session login')
  const wrongUrl = structuredClone(answer)
  const toolUse = wrongUrl.content[0]
  if (!('input' in toolUse)) throw new Error('Fixture has no server tool use')
  toolUse.input.url = 'https://other.example/page'
  await expect(runNativeFetch({ url, prompt: 'Read.' }, context([wrongUrl]), new AbortController().signal)).rejects.toThrow('did not use the requested URL')
  const unsafeSource = { ...answer, content: [answer.content[0], documentResult('Private source', 'https://127.0.0.1/'), answer.content[2]] }
  await expect(runNativeFetch({ url, prompt: 'Read.' }, context([unsafeSource]), new AbortController().signal)).rejects.toMatchObject({ code: 'security' })
  await expect(runNativeFetch({ url: 'https://127.0.0.1/private', prompt: 'Read.' }, context(), new AbortController().signal)).rejects.toMatchObject({ code: 'security' })
  const stop = new AbortController()
  const pending = { ...context(), fetch: async () => new Promise<never>(() => {}) }
  const operation = runNativeFetch({ url, prompt: 'Read.' }, pending, stop.signal)
  stop.abort(new Error('fixture cancellation'))
  await expect(operation).rejects.toThrow('fixture cancellation')
})
