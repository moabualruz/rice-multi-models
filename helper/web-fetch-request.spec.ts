import { expect, test } from 'bun:test'
import { fingerprint, parseConfig } from '../hooks/config.ts'
import type { StepWire } from '../hooks/protocol.ts'
import { createStepper } from './styx/step.ts'
import { createWebFetch } from './web-fetch.ts'

type Protocol = 'anthropic' | 'gemini'
const url = 'https://www.google.com/guide'
const utf8 = (value: string) => new TextEncoder().encode(value)
const stream = (...events: unknown[]) => `data: ${events.map(event => JSON.stringify(event)).join('\n\ndata: ')}\n\n`

function fixture(protocol: Protocol, modelId: string) {
  const configText = JSON.stringify({ providers: { selected: {
    kind: protocol, baseUrl: protocol === 'anthropic' ? 'https://api.anthropic.com' : 'https://generativelanguage.googleapis.com/v1beta',
    auth: 'none', models: { [modelId]: { maxOutputTokens: 4096 } },
  } } })
  const parsed = parseConfig(configText)
  expect(parsed.errors).toEqual([])
  if (!parsed.config) throw new Error('Invalid provider-native fetch fixture')
  const provider = parsed.config.providers.selected!
  const wire: StepWire = { configText, approved: [fingerprint(provider)], req: {
    target: `selected/${modelId}`, who: 'web-fetch-test', session: 'web-fetch-session', system: 'Original system text',
    transcript: [{ role: 'user', content: 'Original prompt' }], tools: [],
  } }
  let sent: { url: string; body: string } | undefined
  const response = protocol === 'anthropic'
    ? stream(
      { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'web_fetch_tool_result', tool_use_id: 'srvtoolu_fetch', content: { type: 'web_fetch_result', url, content: { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'Hosted evidence.' } } } } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hosted answer.' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    )
    : stream({ candidates: [{ content: { role: 'model', parts: [{ text: 'Hosted answer.' }] }, url_context_metadata: { url_metadata: [{ retrieved_url: url, url_retrieval_status: 'URL_RETRIEVAL_STATUS_SUCCESS' }] }, finishReason: 'STOP' }] })
  const stepper = createStepper({
    post: async request => {
      sent = { url: request.url, body: request.body }
      return { status: 200, body: (async function* () { yield utf8(response) })(), cancel: () => {} }
    },
    run: async () => ({ exitCode: 1, stdout: '' }), now: () => 1, log: () => {},
  })
  let errorEvent: unknown
  const fetch = createWebFetch({
    resolve: async () => [{ address: '93.184.216.34', family: 4 }], endpoints: () => [],
    configured: async () => { throw new Error('Native provider success must not advance to configured services.') },
    step: async function* (request, signal) {
      for await (const event of stepper.step(request, signal)) {
        if (event.type === 'error') errorEvent = event
        yield event
      }
    },
  })
  return { wire, fetch, get sent() { return sent }, get errorEvent() { return errorEvent } }
}

test('Anthropic WebFetch builds the actual Messages request body and consumes its hosted result', async () => {
  const run = fixture('anthropic', 'claude-sonnet-4-6')
  const outcome = await run.fetch({ wire: run.wire, url, prompt: 'Summarize the guide.' }, new AbortController().signal)
  expect(run.errorEvent).toBeUndefined()
  const sent = run.sent
  expect(sent?.url).toBe('https://api.anthropic.com/v1/messages')
  const body = JSON.parse(sent?.body ?? '{}')
  expect(body.tools).toEqual([{ type: 'web_fetch_20260318', name: 'web_fetch', max_uses: 1, max_content_tokens: 8192 }])
  expect(body.tool_choice).toEqual({ type: 'auto' })
  expect(body.model).toBe('claude-sonnet-4-6')
  expect(JSON.stringify(body.messages)).toContain(url)
  expect(outcome).toMatchObject({ url, result: 'Hosted answer.' })
})

test('Gemini URL Context builds the actual GenerateContent request body and consumes retrieval metadata', async () => {
  const run = fixture('gemini', 'gemini-2.5-flash')
  const outcome = await run.fetch({ wire: run.wire, url, prompt: 'Summarize the guide.' }, new AbortController().signal)
  const sent = run.sent
  expect(sent?.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse')
  const body = JSON.parse(sent?.body ?? '{}')
  expect(body.tools).toEqual([{ url_context: {} }])
  expect(body.model).toBeUndefined()
  expect(JSON.stringify(body.contents)).toContain(url)
  expect(outcome).toMatchObject({ url, result: 'Hosted answer.' })
})
