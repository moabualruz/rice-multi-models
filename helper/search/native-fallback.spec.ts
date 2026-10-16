import { expect, test } from 'bun:test'
import { NativeSearchUnavailable, nativeSearchModel, runNativeSearch } from '../../hooks/native-search.ts'
import type { NativeSearchContext } from '../../hooks/native-search.ts'

const query = 'the exact native fallback query'
const model = { id: 'claude-fixture-from-catalogue', lifecycle: 'active', line: 'haiku', max_tokens: 2048, capabilities: { server_tools: { web_search: { supported: true } } } }
const catalogue = { data: [model], has_more: false }
const source = { type: 'web_search_result', title: 'Native primary source', url: 'https://docs.example/native', encrypted_content: 'owned-real-response-opaque-field' }
const use = { type: 'server_tool_use', id: 'srvtoolu_owned', name: 'web_search', input: { query } }
const result = { type: 'web_search_tool_result', tool_use_id: use.id, content: [source] }
const message = (content: unknown[] = [use, result], stop_reason = 'end_turn') => ({ type: 'message', content, stop_reason })
const response = (body: unknown, status = 200) => ({ status, ok: status >= 200 && status < 300, text: JSON.stringify(body) })
const signal = () => new AbortController().signal

test('public fallback discovers model and spends one opaque session handle for catalogue and search', async () => {
  const seen: Array<{ url: string; init: Parameters<NativeSearchContext['fetch']>[1] }> = []
  const answer = await runNativeSearch({ query, allowed_domains: ['docs.example'], maxUses: 2 }, {
    authorize: async () => ({ handle: 'owned-opaque-handle', kind: 'bearer' }),
    fetch: async (url, init) => { seen.push({ url, init }); return response(url.includes('/models?') ? catalogue : message()) },
  }, signal())
  expect(seen.map(row => row.url)).toEqual(['https://api.anthropic.com/v1/models?limit=1000', 'https://api.anthropic.com/v1/messages'])
  expect(seen.every(row => row.init.auth === 'owned-opaque-handle')).toBe(true)
  expect(seen.every(row => !row.init.headers?.authorization && !row.init.headers?.['x-api-key'])).toBe(true)
  const body = JSON.parse(seen[1].init.body!)
  expect(body).toMatchObject({ model: model.id, max_tokens: 2048, stream: false, messages: [{ role: 'user', content: query }], tools: [{ name: 'web_search', max_uses: 2, allowed_domains: ['docs.example'] }] })
  expect(body.system[0]).toEqual({ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." })
  expect(body.system[1].text).toContain('exact user query')
  expect(answer).toMatchObject({ query, searchCount: 1, results: [{ content: [{ title: source.title, url: source.url }] }] })
  expect(JSON.stringify(answer)).not.toContain('opaque'); expect(JSON.stringify(answer)).not.toContain('encrypted')
})

test('catalogue capabilities and native IDs are explicit, with documented line preference', () => {
  const sonnet = { ...model, id: 'claude-other-catalogue-id', line: 'sonnet' }
  expect(nativeSearchModel({ data: [sonnet, model] })).toEqual({ id: model.id, maxTokens: model.max_tokens })
  for (const bad of [{ ...model, capabilities: null }, { ...model, lifecycle: 'retired' }, { ...model, id: 'selected/main' }, { ...model, capabilities: { server_tools: { web_search: { supported: false } } } }]) {
    expect(() => nativeSearchModel({ data: [bad] })).toThrow('no discovered active model with confirmed web search support')
  }
})

test('no first-party account, malformed input and absent capability stop before paid inference', async () => {
  let reads = 0
  const context: NativeSearchContext = { authorize: async () => null, fetch: async () => { reads++; return response(catalogue) } }
  await expect(runNativeSearch({ query }, context, signal())).rejects.toBeInstanceOf(NativeSearchUnavailable)
  await expect(runNativeSearch({ query: '' }, context, signal())).rejects.toBeInstanceOf(TypeError)
  expect(reads).toBe(0)
  context.authorize = async () => ({ handle: 'owned', kind: 'api-key' })
  context.fetch = async () => { reads++; return response({ data: [{ ...model, capabilities: undefined }] }) }
  await expect(runNativeSearch({ query }, context, signal())).rejects.toThrow('no discovered active model')
  expect(reads).toBe(1)
})

test('HTTP errors and HTTP200 search errors produce static errors without unsafe bodies', async () => {
  for (const failure of [response({ private: 'must not be copied' }, 429), response(message([use, { ...result, content: { type: 'web_search_tool_result_error', error_code: 'unavailable' } }]))]) {
    let requests = 0
    try {
      await runNativeSearch({ query }, { authorize: async () => ({ handle: 'owned', kind: 'api-key' }), fetch: async () => ++requests === 1 ? response(catalogue) : failure }, signal())
      throw new Error('unexpected success')
    } catch (error) {
      expect(error).toBeInstanceOf(NativeSearchUnavailable); expect(String(error)).not.toContain('must not be copied')
    }
    expect(requests).toBe(2)
  }
})

test('pause continuation preserves actual opaque blocks and reduces remaining search budget', async () => {
  const bodies: Record<string, unknown>[] = []
  const answer = await runNativeSearch({ query, maxUses: 2 }, {
    authorize: async () => ({ handle: 'owned', kind: 'bearer' }),
    fetch: async (url, init) => {
      if (url.includes('/models?')) return response(catalogue)
      bodies.push(JSON.parse(init.body!))
      return response(bodies.length === 1 ? message([use, result], 'pause_turn') : message([]))
    },
  }, signal())
  expect(bodies[1]).toMatchObject({ messages: [{ role: 'user', content: query }, { role: 'assistant', content: [use, result] }], tools: [{ max_uses: 1 }] })
  expect(bodies[1].tool_choice).toBeUndefined(); expect(answer.searchCount).toBe(1)
})

test('search bounds, domain filtering and malformed native sources are enforced before returning', async () => {
  for (const content of [[use, { ...result, content: [{ ...source, url: 'https://secret:credential@docs.example' }] }], [use, { ...use, id: 'srvtoolu_second' }, result], [{ ...use, input: { query: 'changed query' } }, result]]) {
    await expect(runNativeSearch({ query, maxUses: 1 }, { authorize: async () => ({ handle: 'owned', kind: 'api-key' }), fetch: async url => response(url.includes('/models?') ? catalogue : message(content)) }, signal())).rejects.toBeInstanceOf(Error)
  }
  const answer = await runNativeSearch({ query, blocked_domains: ['docs.example'] }, { authorize: async () => ({ handle: 'owned', kind: 'api-key' }), fetch: async url => response(url.includes('/models?') ? catalogue : message()) }, signal())
  expect(answer.results).toMatchObject([{ content: [] }])
})

test('abort during catalogue prevents subsequent inference and does not emit results', async () => {
  const abort = new AbortController(); let requests = 0
  await expect(runNativeSearch({ query }, { authorize: async () => ({ handle: 'owned', kind: 'api-key' }), fetch: async () => { requests++; abort.abort(new Error('owned cancellation')); return response(catalogue) } }, abort.signal)).rejects.toThrow('owned cancellation')
  expect(requests).toBe(1)
})
