import { expect, test } from 'bun:test'

import { fingerprint, parseConfig } from '../../hooks/config'
import type { Config, Kind } from '../../hooks/config'
import type { StepEvent, StepRequest } from '../../hooks/protocol'
import { cacheIdentityKey } from './cache-identity'
import { createStepper } from './step'
import type { UpstreamRequest } from './step'

type Options = {
  providerId?: string
  providerKind?: Kind
  endpoint?: string
  cacheScope?: { endpoint: string; account: string }
  modelId?: string
  modelKind?: Kind
  session?: string
  owner?: string
  providerParams?: Record<string, unknown>
  modelParams?: Record<string, unknown>
  aliasParams?: Record<string, unknown>
  reply?: { status: number; body: string }
}

const emptyBody = async function* (): AsyncGenerator<Uint8Array, undefined> {}

async function invoke(options: Options = {}) {
  const providerId = options.providerId ?? 'gateway'
  const modelId = options.modelId ?? 'model-a'
  const providerKind = options.providerKind ?? 'responses'
  const endpoint = options.endpoint ?? 'https://gateway.example/v1'
  const auth = providerKind === 'bedrock' ? { command: ['/fixture/auth'] } : 'none'
  const configText = JSON.stringify({
    providers: {
      [providerId]: {
        kind: providerKind,
        baseUrl: endpoint,
        ...(options.cacheScope ? { cacheScope: options.cacheScope } : {}),
        auth,
        ...(options.providerParams === undefined ? {} : { params: options.providerParams }),
        models: {
          [modelId]: {
            maxOutputTokens: 1024,
            ...((options.modelKind ?? providerKind) === 'openai' ? { maxTokensParam: 'max_tokens' } : {}),
            ...(options.modelKind === undefined ? {} : { kind: options.modelKind }),
            ...(options.modelParams === undefined ? {} : { params: options.modelParams }),
          },
        },
      },
    },
    ...(options.aliasParams === undefined ? {} : { aliases: { selected: { target: `${providerId}/${modelId}`, params: options.aliasParams } } }),
  })
  const parsed = parseConfig(configText)
  expect(parsed.errors).toEqual([])
  const config = parsed.config as Config
  const provider = config.providers[providerId]!
  const posted: UpstreamRequest[] = []
  const stepper = createStepper({
    post: async request => {
      posted.push(request)
      const body = async function* () { yield new TextEncoder().encode(options.reply!.body); return undefined }
      return { status: options.reply?.status ?? 200, body: options.reply ? body() : emptyBody(), cancel() {} }
    },
    run: async () => ({ exitCode: 0, stdout: 'synthetic-key' }),
    now: () => 1,
    log: () => undefined,
  })
  const req: StepRequest = {
    target: options.aliasParams === undefined ? `${providerId}/${modelId}` : 'selected',
    system: 'system',
    tools: [],
    transcript: [{ role: 'user', content: 'hello' }],
    who: options.owner ?? 'main',
    session: options.session ?? 'session-a',
  }
  const events: StepEvent[] = []
  for await (const event of stepper.step({ req, configText, approved: [fingerprint(provider)] }, new AbortController().signal)) events.push(event)
  return { body: posted[0] === undefined ? undefined : JSON.parse(posted[0].body) as Record<string, unknown>, posted, events }
}

test('codec-owned HTTP context overflow survives the helper boundary without retrying the unchanged request', async () => {
  for (const providerKind of ['openai', 'responses', 'anthropic'] as const) {
    const error = providerKind === 'anthropic'
      ? { type: 'invalid_request_error', message: 'prompt is too long: 34000 tokens > 32768 maximum' }
      : { type: 'invalid_request_error', code: 'context_length_exceeded', message: 'Owned input does not fit.' }
    const result = await invoke({ providerKind, owner: 'owned-child', reply: { status: 400, body: JSON.stringify({ error }) } })
    expect(result.events.find(event => event.type === 'error')).toMatchObject({ kind: 'request', status: 400, cause: 'context_overflow' })
    expect(result.posted).toHaveLength(1)
    expect(result.events.some(event => event.type === 'stop')).toBe(false)
  }
})

test('codec-owned in-stream context overflow survives decoding and assembly, unlike unrelated or quoted errors', async () => {
  for (const providerKind of ['openai', 'responses', 'anthropic'] as const) {
    const error = providerKind === 'anthropic'
      ? { type: 'invalid_request_error', message: 'prompt is too long: 34000 tokens > 32768 maximum' }
      : { type: 'invalid_request_error', code: 'context_length_exceeded', message: 'Owned input does not fit.' }
    const event = providerKind === 'responses' ? { type: 'response.failed', response: { error } } : { type: 'error', error }
    const result = await invoke({ providerKind, reply: { status: 200, body: `data: ${JSON.stringify(event)}\n\n` } })
    expect(result.events.find(event => event.type === 'error')).toMatchObject({ kind: 'response', cause: 'context_overflow' })
    expect(result.posted).toHaveLength(1)
  }
  for (const providerKind of ['openai', 'responses', 'anthropic', 'gemini', 'bedrock'] as const) {
    for (const body of [
      JSON.stringify({ error: { type: 'invalid_request_error', code: 'bad_parameter', message: 'The user wrote context_length_exceeded in a prompt.' } }),
      JSON.stringify({ error: { type: 'rate_limit_error', code: 'rate_limit_exceeded', message: 'Too many tokens per minute.' } }),
      '<html><body>context_length_exceeded</body></html>',
    ]) {
      const result = await invoke({ providerKind, reply: { status: 400, body } })
      expect(result.events.find(event => event.type === 'error')).not.toHaveProperty('cause')
    }
  }
})

test('runtime Responses bodies use a stable key scoped by provider, endpoint, exact model, session, and owner', async () => {
  const baseline = await invoke()
  const stable = await invoke()
  const key = baseline.body?.prompt_cache_key
  expect(key).toMatch(/^[a-f0-9]{64}$/)
  expect(stable.body?.prompt_cache_key).toBe(key)

  const variants: Options[] = [
    { providerId: 'other-gateway' },
    { providerKind: 'openai', modelKind: 'responses' },
    { endpoint: 'https://other.example/v1' },
    { modelId: 'model-b' },
    { session: 'session-b' },
    { owner: 'agent-1' },
  ]
  for (const variant of variants) {
    const changed = await invoke(variant)
    expect(changed.body?.prompt_cache_key).not.toBe(key)
  }
})

test('runtime same-origin account and endpoint references produce distinct stable keys without hashing credentials or URL paths', async () => {
  const scope = { endpoint: 'tenant-a', account: 'account-a' }
  const first = await invoke({ cacheScope: scope })
  expect((await invoke({ cacheScope: scope })).body?.prompt_cache_key).toBe(first.body?.prompt_cache_key)
  for (const cacheScope of [{ ...scope, endpoint: 'tenant-b' }, { ...scope, account: 'account-b' }]) expect((await invoke({ cacheScope })).body?.prompt_cache_key).not.toBe(first.body?.prompt_cache_key)
  expect(first.body?.prompt_cache_key).not.toContain('account-a')
  for (const cacheScope of [null, {}, { endpoint: 'tenant-a' }, { endpoint: 'https://invalid.example', account: 'a' }, { endpoint: 'a', account: 'b', unknown: 'c' }]) {
    const result = parseConfig(JSON.stringify({ providers: { gateway: { kind: 'responses', baseUrl: 'https://gateway.example/v1', auth: 'none', cacheScope, models: {} } } }))
    expect(result.config).toBeUndefined()
    expect(result.errors.join(' ')).toContain('cacheScope')
  }
})

test('each identity field changes the digest without serializing its raw value', () => {
  const identity = {
    providerId: 'gateway',
    providerKind: 'responses' as const,
    endpointOrigin: 'https://gateway.example',
    modelKind: 'responses' as const,
    modelId: 'model-a',
    session: 'session-a',
    owner: 'main',
  }
  const key = cacheIdentityKey(identity)
  expect(key).toMatch(/^[a-f0-9]{64}$/)
  expect(key).not.toContain('gateway')
  expect(key).not.toContain('session-a')
  for (const field of Object.keys(identity) as (keyof typeof identity)[]) {
    const value = identity[field]
    const changed = field === 'providerKind' || field === 'modelKind'
      ? value === 'responses' ? 'openai' : 'responses'
      : `${value}-different`
    expect(cacheIdentityKey({ ...identity, [field]: changed } as typeof identity)).not.toBe(key)
  }
})

test('protocols without a generated prompt cache key keep their request shape', async () => {
  for (const providerKind of ['openai', 'anthropic', 'bedrock', 'gemini'] as const) {
    const result = await invoke({ providerKind })
    expect(result.posted).toHaveLength(1)
    expect(result.body).not.toHaveProperty('prompt_cache_key')
  }
})

test('provider, model, and alias prompt_cache_key overrides are refused before transport', async () => {
  const configurations: Options[] = [
    { providerParams: { prompt_cache_key: 'manual-provider-key' } },
    { modelParams: { prompt_cache_key: 'manual-model-key' } },
    { aliasParams: { prompt_cache_key: 'manual-alias-key' } },
    { providerParams: { prompt_cache_key: null } },
    { modelParams: { prompt_cache_key: null } },
    { aliasParams: { prompt_cache_key: null } },
  ]
  for (const configuration of configurations) {
    const result = await invoke(configuration)
    expect(result.posted).toHaveLength(0)
    expect(result.events.find(event => event.type === 'error')).toMatchObject({
      kind: 'request',
      text: 'rice-multi-models: prompt_cache_key overrides are not accepted; cache identity is scoped automatically',
    })
  }
})
