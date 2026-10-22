import { expect, test } from 'bun:test'
import { runtimeConfig } from '../hooks/catalogue-runtime'
import { unknownMetadata, type DiscoveredModel, type ModelCatalogue, type ModelMetadata } from '../hooks/catalogue'
import { fingerprint, inputBudget, parseConfig, type Kind } from '../hooks/config'
import { resolve } from '../hooks/names'
import { loadText } from '../hooks/providers'
import { CODECS } from '../helper/styx/codecs'
import { nativeConstraints } from '../helper/native/constraints'
import { requestInputBudget } from '../hooks/budget'

const provider = { kind: 'openai', baseUrl: 'https://gateway.example/v1', auth: { command: ['/usr/bin/security', 'find-generic-password', '-w'], ttlSeconds: 90 } }
const source = (models?: Record<string, unknown>, extra: Record<string, unknown> = {}) => loadText('/unchanged/rice-multi-models.json', JSON.stringify({ version: 1, providers: { gateway: { ...provider, ...extra, ...(models === undefined ? {} : { models }) } } }))
const discovered = (id: string, metadata: Partial<ModelMetadata> = {}, extra: Partial<DiscoveredModel> = {}): DiscoveredModel => ({ model: `gateway/${id}`, label: id, execution: 'native provider', source: 'live provider response', observedAt: 123, metadata: { ...unknownMetadata(), ...metadata }, ...extra })
const snapshot = (...models: DiscoveredModel[]): ModelCatalogue => ({ models, providers: [{ provider: 'gateway', status: 'fresh', source: 'live provider response', observedAt: 123 }] })
const neutral = { system: 'system', messages: [], tools: [] }

function remote(loaded: ReturnType<typeof source>, id: string) {
  const target = loaded.config && resolve(loaded.config, `gateway/${id}`)
  if (target?.kind !== 'remote') throw new Error(`missing route ${id}: ${loaded.errors.join('; ')}`)
  return target
}

test('routing-only providers and models without limits validate; explicit invalid policies still fail', () => {
  expect(source().errors).toEqual([])
  expect(source({}).errors).toEqual([])
  expect(source({ m: {} }).errors).toEqual([])
  expect(inputBudget(remote(source({ m: {} }), 'm').model)).toBeNull()
  expect(source({ m: { contextWindow: 0 } }).errors.join()).toContain('positive integer')
  expect(source({ m: { maxOutputTokens: null } }).errors.join()).toContain('positive integer')
  expect(source(undefined, { models: null }).errors.join()).toContain('map of model ids')
})

test('fresh facts replace stale limits, clamp output policy, add IDs, and retain manual routes', () => {
  const loaded = source({ stale: { contextWindow: 1_000, maxInputTokens: 700, maxOutputTokens: 400, maxTokensParam: 'max_tokens' }, manual: { contextWindow: 2_000, maxOutputTokens: 200 } })
  const before = loaded.text
  const live = snapshot(discovered('stale', { contextWindow: 100_000, inputTokenLimit: 90_000, outputTokenLimit: 300 }), discovered('new', { contextWindow: 200_000, outputTokenLimit: 32_768 }))
  const effective = runtimeConfig(loaded, live)
  expect(effective.errors).toEqual([])
  expect(remote(effective, 'stale').model).toMatchObject({ contextWindow: 100_000, maxInputTokens: 90_000, maxOutputTokens: 300 })
  expect(inputBudget(remote(effective, 'stale').model)).toBe(90_000)
  expect(remote(effective, 'new').model).toMatchObject({ contextWindow: 200_000, maxOutputTokens: 32_768 })
  expect(remote(effective, 'manual').model).toEqual(remote(loaded, 'manual').model)
  expect(live.models.map(model => model.model)).not.toContain('gateway/manual')
  expect(loaded.text).toBe(before)
  expect(remote(loaded, 'stale').model.contextWindow).toBe(1_000)
  const changed = runtimeConfig(loaded, snapshot(discovered('stale', { contextWindow: 300_000, inputTokenLimit: 250_000, outputTokenLimit: 1_000 })))
  expect(remote(changed, 'stale').model).toMatchObject({ contextWindow: 300_000, maxInputTokens: 250_000, maxOutputTokens: 400 })
})

test('active context remains the effective window when the model advertises a larger maximum', () => {
  const effective = runtimeConfig(source({ m: {} }), snapshot(discovered('m', { contextWindow: 32_000, maxContextWindow: 872_000 })))
  expect(remote(effective, 'm').model.contextWindow).toBe(32_000)
})

test('fresh active context uses the maximum only as an upper ceiling and invalid facts stay unknown', () => {
  const active = runtimeConfig(source({ m: {} }), snapshot(discovered('m', { contextWindow: 64_000, maxContextWindow: 32_000 })))
  expect(remote(active, 'm').model.contextWindow).toBe(32_000)
  const invalid = runtimeConfig(source({ m: {} }), snapshot(discovered('m', { contextWindow: 64_000.5, maxContextWindow: 128_000 })))
  expect(remote(invalid, 'm').model.contextWindow).toBeUndefined()
  const configured = runtimeConfig(source({ m: { contextWindow: 200_000 } }), snapshot(discovered('m', { maxContextWindow: 128_000 })))
  expect(remote(configured, 'm').model.contextWindow).toBe(128_000)
})

test('smaller discovered context constrains an existing input policy without dropping new routes', () => {
  const effective = runtimeConfig(source({ m: { contextWindow: 100_000, maxInputTokens: 90_000 } }), snapshot(discovered('m', { contextWindow: 50_000 }), discovered('new')))
  expect(effective.errors).toEqual([])
  expect(inputBudget(remote(effective, 'm').model)).toBe(50_000)
  expect(remote(effective, 'new').model.maxOutputTokens).toBeUndefined()
})

test('Responses and Gemini shared-context input budgets reserve output before applying independent input limits', () => {
  const cases = [
    { facts: { contextWindow: 400_000, inputTokenLimit: 350_000, outputTokenLimit: 128_000 }, budget: 272_000 },
    { facts: { contextWindow: 400_000, inputTokenLimit: 200_000, outputTokenLimit: 128_000 }, budget: 200_000 },
    { facts: { contextWindow: 400_000, outputTokenLimit: 128_000 }, budget: 272_000 },
    { facts: { contextWindow: 400_000 }, budget: 400_000 },
    { facts: { inputTokenLimit: 350_000, outputTokenLimit: 128_000 }, budget: 350_000 },
    { facts: { outputTokenLimit: 128_000 }, budget: null },
  ]
  for (const kind of ['responses', 'gemini'] as const) {
    const cap = (body: { max_output_tokens?: number; generationConfig?: { maxOutputTokens?: number } }) => kind === 'responses' ? body.max_output_tokens : body.generationConfig?.maxOutputTokens
    for (const { facts, budget } of cases) {
      const loaded = source({ m: {} }, { kind })
      const { provider: p, model } = remote(runtimeConfig(loaded, snapshot(discovered('m', facts))), 'm')
      expect(inputBudget(model)).toBe(budget)
      expect(model.maxTokensParam).toBeUndefined()
      expect(cap(JSON.parse(CODECS[kind].encode(neutral, p, model).body))).toBe(facts.outputTokenLimit)
    }
    const declared = remote(source({ m: { contextWindow: 10_000, maxOutputTokens: 2_000 } }, { kind }), 'm')
    expect(inputBudget(declared.model)).toBe(8_000)
    const refreshed = remote(runtimeConfig(source({ m: { maxOutputTokens: 2_000 } }, { kind }), snapshot(discovered('m', { contextWindow: 10_000, outputTokenLimit: 4_000 }))), 'm')
    expect(inputBudget(refreshed.model)).toBe(8_000)
    expect(cap(JSON.parse(CODECS[kind].encode(neutral, refreshed.provider, refreshed.model).body))).toBe(2_000)
  }
})

test('unknown limits stay unknown and model names never infer a protocol', () => {
  const effective = runtimeConfig(source(), snapshot(discovered('claude-looks-anthropic'), discovered('gemini-looks-google')))
  for (const id of ['claude-looks-anthropic', 'gemini-looks-google']) {
    const { model } = remote(effective, id)
    expect(model.kind).toBe('openai')
    expect(model.contextWindow).toBeUndefined()
    expect(model.maxInputTokens).toBeUndefined()
    expect(model.maxOutputTokens).toBeUndefined()
    expect(inputBudget(model)).toBeNull()
  }
  const inputOnly = runtimeConfig(source(), snapshot(discovered('input-only', { inputTokenLimit: 123_456 })))
  expect(inputBudget(remote(inputOnly, 'input-only').model)).toBe(123_456)
  expect(remote(inputOnly, 'input-only').model.contextWindow).toBeUndefined()
})

test('known unsupported features disable capabilities without lifting restrictions', () => {
  const effective = runtimeConfig(source({ denied: { tools: false, vision: false, parallelToolCalls: false }, list: { tools: ['Read'], vision: false }, unsupported: {}, protocol: { kind: 'anthropic' } }), snapshot(
    discovered('denied', { tools: true, parallelToolCalls: true, inputModalities: ['text', 'image'] }),
    discovered('list', { tools: true, inputModalities: ['image'] }),
    discovered('unsupported', { tools: false, parallelToolCalls: false, inputModalities: ['text'] }),
    discovered('protocol', { outputTokenLimit: 1_000 }),
  ))
  expect(remote(effective, 'denied').model).toMatchObject({ tools: false, vision: false, parallelToolCalls: false })
  expect(remote(effective, 'list').model).toMatchObject({ tools: ['Read'], vision: false })
  expect(remote(effective, 'unsupported').model).toMatchObject({ tools: false, vision: false, parallelToolCalls: false })
  expect(remote(effective, 'protocol').model.kind).toBe('anthropic')
})

test('runtime text reparses exactly with safe params, aliases, auth and approval fingerprint preserved', () => {
  const loaded = loadText('/unchanged/config.json', JSON.stringify({ providers: { gateway: { ...provider, authHeader: 'bearer', sessionHeader: 'x-route-id', headers: { 'x-safe': 'hello' }, params: { temperature: 0.4 }, models: { m: { params: { nested: { a: 2 } }, effort: { high: { top_p: 0.8 } }, headers: { 'x-model': 'yes' }, maxOutputTokens: 2_000 } } } }, aliases: { chosen: { target: 'gateway/m', params: { nested: { b: 3 } } } } }))
  const original = remote(loaded, 'm')
  const effective = runtimeConfig(loaded, snapshot(discovered('m', { contextWindow: 100_000, outputTokenLimit: 1_000 }), discovered('new')))
  expect(effective.path).toBe(loaded.path)
  expect(parseConfig(effective.text)).toEqual({ config: effective.config, errors: [] })
  const current = remote(effective, 'm')
  expect(fingerprint(current.provider)).toBe(fingerprint(original.provider))
  expect(current.provider.auth).toEqual(original.provider.auth)
  expect(current.provider.params).toEqual(original.provider.params)
  expect(current.provider.headers).toEqual(original.provider.headers)
  expect(current.model.params).toEqual(original.model.params)
  expect(current.model.effort).toEqual(original.model.effort)
  expect(current.model.headers).toEqual(original.model.headers)
  expect(effective.config?.aliases).toEqual(loaded.config?.aliases)
  expect(effective.text).not.toContain('Bearer ')
})

test('only a fresh provider catalogue replaces cached model limits, and refresh can recover', () => {
  const loaded = source({ m: { contextWindow: 1_000, maxOutputTokens: 100 } })
  const stale = snapshot(discovered('m', { contextWindow: 80_000, outputTokenLimit: 4_000 }))
  stale.providers[0]!.status = 'unavailable'
  expect(remote(runtimeConfig(loaded, stale), 'm').model).toEqual(remote(loaded, 'm').model)
  const refreshed = runtimeConfig(loaded, snapshot(discovered('m', { contextWindow: 80_000, outputTokenLimit: 4_000 })))
  expect(remote(refreshed, 'm').model).toMatchObject({ contextWindow: 80_000, maxOutputTokens: 100 })
})

test('unavailable snapshots and unconfigured providers add no routes', () => {
  const loaded = source({ manual: {} })
  const unavailable = snapshot(discovered('stale'))
  unavailable.providers[0]!.status = 'unavailable'
  expect(runtimeConfig(loaded, unavailable).config).toEqual(loaded.config)
  const effective = runtimeConfig(loaded, snapshot(discovered('alien', {}, { model: 'other/alien' })))
  expect(effective.config).toEqual(loaded.config)
  const invalid = loadText('/invalid/config.json', '{')
  expect(runtimeConfig(invalid, snapshot(discovered('m')))).toBe(invalid)
})

test('optional encoders omit unknown caps and send discovered or configured caps', () => {
  for (const kind of ['openai', 'responses', 'gemini'] as const) {
    const extra = kind === 'openai' ? { maxTokensParam: 'max_completion_tokens' } : {}
    const loaded = source({ m: extra }, { kind })
    const unknown = remote(loaded, 'm')
    const body = JSON.parse(CODECS[kind].encode(neutral, unknown.provider, unknown.model).body)
    expect(body.max_completion_tokens).toBeUndefined()
    expect(body.max_output_tokens).toBeUndefined()
    expect(body.generationConfig?.maxOutputTokens).toBeUndefined()
    const known = remote(runtimeConfig(loaded, snapshot(discovered('m', { outputTokenLimit: 777 }))), 'm')
    const capped = JSON.parse(CODECS[kind].encode(neutral, known.provider, known.model).body)
    expect(kind === 'openai' ? capped.max_completion_tokens : kind === 'responses' ? capped.max_output_tokens : capped.generationConfig.maxOutputTokens).toBe(777)
  }
})

test('OpenAI discovered output ceilings require an explicit dialect without dropping manual routes', () => {
  const loaded = source({ m: {}, manual: { maxOutputTokens: 200, maxTokensParam: 'max_tokens' } })
  const unknown = remote(loaded, 'm')
  const uncapped = JSON.parse(CODECS.openai.encode(neutral, unknown.provider, unknown.model).body)
  expect(uncapped.max_tokens).toBeUndefined()
  expect(uncapped.max_completion_tokens).toBeUndefined()
  const effective = runtimeConfig(loaded, snapshot(discovered('m', { outputTokenLimit: 777 })))
  expect(effective.errors).toEqual([])
  const known = remote(effective, 'm')
  expect(known.model.maxTokensParam).toBeUndefined()
  expect(() => CODECS.openai.encode(neutral, known.provider, known.model)).toThrow('requires an explicit maxTokensParam request policy (max_tokens or max_completion_tokens)')
  const manual = remote(effective, 'manual')
  expect(manual.model).toEqual(remote(loaded, 'manual').model)
  expect(JSON.parse(CODECS.openai.encode(neutral, manual.provider, manual.model).body).max_tokens).toBe(200)
  for (const maxTokensParam of ['max_tokens', 'max_completion_tokens'] as const) {
    const explicit = remote(runtimeConfig(source({ m: { maxTokensParam } }), snapshot(discovered('m', { outputTokenLimit: 777 }))), 'm')
    const capped = JSON.parse(CODECS.openai.encode(neutral, explicit.provider, explicit.model).body)
    expect(capped[maxTokensParam]).toBe(777)
    expect(['max_tokens', 'max_completion_tokens'].filter(key => key in capped)).toEqual([maxTokensParam])
  }
})

test('OpenAI native output caps retain the configured request dialect and input reservation', () => {
  const declaredParams = remote(source({ m: { contextWindow: 32_000, params: { max_tokens: 512 } } }), 'm')
  const declaredEncoded = CODECS.openai.encode(neutral, declaredParams.provider, declaredParams.model)
  const declaredBody = JSON.parse(nativeConstraints(declaredEncoded.body, declaredParams.model, { maxTokens: 2_048 }))
  expect(declaredBody.max_tokens).toBe(512)
  expect(declaredBody.max_completion_tokens).toBeUndefined()
  expect(inputBudget(declaredParams.model)).toBe(31_488)
  expect(requestInputBudget({ contextWindow: 32_000, outputTokenLimit: 2_048 }, { outputReserve: 2_048 })).toBe(27_904)

  const explicit = remote(source({ m: { contextWindow: 32_000, maxOutputTokens: 2_048, maxTokensParam: 'max_completion_tokens', params: { max_tokens: 512 } } }), 'm')
  const explicitEncoded = CODECS.openai.encode(neutral, explicit.provider, explicit.model)
  const explicitBody = JSON.parse(nativeConstraints(explicitEncoded.body, explicit.model, { maxTokens: 2_048 }))
  expect(explicitBody.max_completion_tokens).toBe(2_048)
  expect(explicitBody.max_tokens).toBeUndefined()
  expect(inputBudget(explicit.model)).toBe(29_952)

  const fallback = remote(source({ m: { contextWindow: 32_000 } }), 'm')
  const fallbackEncoded = CODECS.openai.encode(neutral, fallback.provider, fallback.model)
  const fallbackBody = JSON.parse(nativeConstraints(fallbackEncoded.body, fallback.model, { maxTokens: 2_048 }))
  expect(fallbackBody.max_completion_tokens).toBe(2_048)
  expect(fallbackBody.max_tokens).toBeUndefined()
  expect(inputBudget(fallback.model)).toBe(32_000)
  expect(requestInputBudget({ contextWindow: 32_000, outputTokenLimit: 2_048 }, { outputReserve: 2_048 })).toBe(27_904)
})

test('provider params cannot lift a discovered output ceiling, while lower request policies stay intact', () => {
  type CapBody = { max_tokens: number; max_completion_tokens: number; max_output_tokens: number; inferenceConfig: { maxTokens: number }; generationConfig: { maxOutputTokens: number } }
  const cases = [
    { kind: 'openai', params: { max_tokens: 1_000 }, declaration: { maxTokensParam: 'max_tokens' }, read: (body: CapBody) => body.max_tokens },
    { kind: 'openai', params: { max_completion_tokens: 1_000 }, declaration: { maxTokensParam: 'max_completion_tokens' }, read: (body: CapBody) => body.max_completion_tokens },
    { kind: 'bedrock', params: { inferenceConfig: { maxTokens: 1_000, temperature: 0.2 } }, declaration: {}, read: (body: CapBody) => body.inferenceConfig.maxTokens },
    { kind: 'responses', params: { max_output_tokens: 1_000 }, declaration: {}, read: (body: CapBody) => body.max_output_tokens },
    { kind: 'gemini', params: { generationConfig: { maxOutputTokens: 1_000, temperature: 0.2 } }, declaration: {}, read: (body: CapBody) => body.generationConfig.maxOutputTokens },
  ] as const
  for (const entry of cases) {
    const loaded = source({ m: entry.declaration }, { kind: entry.kind, params: entry.params })
    const lower = remote(runtimeConfig(loaded, snapshot(discovered('m', { outputTokenLimit: 500 }))), 'm')
    expect(entry.read(JSON.parse(CODECS[entry.kind].encode(neutral, lower.provider, lower.model).body))).toBe(500)
    const higher = remote(runtimeConfig(loaded, snapshot(discovered('m', { outputTokenLimit: 2_000 }))), 'm')
    expect(entry.read(JSON.parse(CODECS[entry.kind].encode(neutral, higher.provider, higher.model).body))).toBe(1_000)
    expect(lower.provider.params).toEqual(entry.params)
  }
})

test('required-cap codecs refuse unknown output limits with a clear request-policy error', () => {
  for (const kind of ['anthropic', 'bedrock'] satisfies Kind[]) {
    const loaded = source({ m: {} }, { kind })
    const { provider: p, model } = remote(loaded, 'm')
    expect(() => CODECS[kind].encode(neutral, p, model)).toThrow('requires an explicit maxOutputTokens request policy')
    const known = remote(runtimeConfig(loaded, snapshot(discovered('m', { outputTokenLimit: 888 }))), 'm')
    const body = JSON.parse(CODECS[kind].encode(neutral, known.provider, known.model).body)
    expect(kind === 'anthropic' ? body.max_tokens : body.inferenceConfig.maxTokens).toBe(888)
  }
})

test('manual declared request policies retain their input budget behavior', () => {
  const m = remote(source({ m: { contextWindow: 10_000, maxOutputTokens: 2_000, maxTokensParam: 'max_tokens' } }), 'm').model
  expect(inputBudget(m)).toBe(8_000)
  expect(inputBudget({ ...m, maxTokensParam: undefined })).toBe(10_000)
  expect(inputBudget({ ...m, contextWindow: undefined, maxInputTokens: 5_000 })).toBe(5_000)
  expect(inputBudget({ ...m, contextWindow: undefined, maxInputTokens: undefined })).toBeNull()
})
