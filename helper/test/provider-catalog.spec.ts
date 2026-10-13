import { expect, test } from 'bun:test'
import { fingerprint, parseConfig } from '../../hooks/config.ts'
import { unknownMetadata } from '../../hooks/catalogue.ts'
import type { Wire } from '../../hooks/protocol.ts'
import { CATALOG_URL, TIERS } from '../../hooks/opencode.ts'
import { discoverProviders } from '../provider-catalog.ts'
import type { ProviderCatalogueOptions } from '../provider-catalog.ts'

const secret = 'provider-catalogue-fixture-key'
const declaration = { contextWindow: 2000, maxOutputTokens: 100, maxInputTokens: 1800, tools: true, vision: true }
const provider = (fields: Record<string, unknown> = {}) => ({ kind: 'openai', baseUrl: 'https://fixture.example/v1', auth: { command: ['/fixture/key-helper'], ttlSeconds: 300 }, models: { 'stale-only': declaration }, ...fields })
const wireOf = (providers: Record<string, unknown> = { fixture: provider() }, approve = true): Wire => {
  const configText = JSON.stringify({ version: 1, providers, aliases: {} })
  const parsed = parseConfig(configText)
  expect(parsed.errors).toEqual([])
  return { configText, approved: approve ? Object.values(parsed.config!.providers).map(fingerprint) : [], userAgent: 'fixture-client' }
}
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
const optionsOf = (respond: (url: URL, init: RequestInit) => Response | Promise<Response>): ProviderCatalogueOptions => ({
  run: async () => ({ exitCode: 0, stdout: secret }),
  fetch: (async (input: string | URL | Request, init?: RequestInit) => respond(new URL(String(input)), init!)) as typeof fetch,
})
const safe = (result: Awaited<ReturnType<typeof discoverProviders>>) => {
  expect(JSON.stringify(result).includes(secret)).toBe(false)
  expect(JSON.stringify(result).includes('/fixture/key-helper')).toBe(false)
}
const failure = (result: Awaited<ReturnType<typeof discoverProviders>>, error: string) => {
  expect(result.models).toEqual([])
  expect(result.providers[0]).toMatchObject({ provider: 'fixture', status: 'unavailable', error })
  safe(result)
}

test('every invocation fetches live lists instead of declared lists or cached metadata', async () => {
  const wire = wireOf()
  let calls = 0
  const options = optionsOf((url, init) => {
    calls++
    expect(url.pathname).toBe('/v1/models')
    expect(init.method).toBe('GET')
    expect(init.redirect).toBe('error')
    expect(init.cache).toBe('no-store')
    return json({ data: [{ id: calls === 1 ? 'current-model' : 'replacement-model', context_window: calls * 100000, limit: { context: 90000 }, tools: true }] })
  })
  const first = await discoverProviders(wire, options)
  const second = await discoverProviders(wire, options)
  expect(calls).toBe(2)
  expect(first.models.map(model => model.model)).toEqual(['fixture/current-model'])
  expect(second.models.map(model => model.model)).toEqual(['fixture/replacement-model'])
  expect(first.models[0]!.metadata).toEqual(unknownMetadata())
  expect(second.models[0]!.metadata).toEqual(unknownMetadata())
  expect(second.providers[0]).toMatchObject({ status: 'fresh', observedAt: second.models[0]!.observedAt, source: 'fixture openai live /models endpoint' })
  safe(second)
})

test('Gemini reported token limits change across invocations, without a guessed window', async () => {
  let calls = 0
  const wire = wireOf({ fixture: provider({ kind: 'gemini' }) })
  const options = optionsOf(() => json({ models: [{ name: ++calls === 1 ? 'models/current' : 'models/new', inputTokenLimit: calls * 10000, outputTokenLimit: calls * 1000, contextWindow: 99999, supportedGenerationMethods: ['generateContent'] }] }))
  const first = await discoverProviders(wire, options)
  const second = await discoverProviders(wire, options)
  expect(first.models[0]!.metadata).toEqual({ ...unknownMetadata(), inputTokenLimit: 10000, outputTokenLimit: 1000 })
  expect(second.models[0]!.metadata).toEqual({ ...unknownMetadata(), inputTokenLimit: 20000, outputTokenLimit: 2000 })
  expect(second.models[0]!.model).toBe('fixture/new')
})

test('missing and malformed optional limits remain null, with unknown fields ignored', async () => {
  const wire = wireOf({ fixture: provider({ kind: 'gemini' }) })
  for (const value of [undefined, null, -1, 0, 1.5, '1000', Number.MAX_SAFE_INTEGER + 1]) {
    const result = await discoverProviders(wire, optionsOf(() => json({ models: [{ name: 'models/current', inputTokenLimit: value, outputTokenLimit: value, context_window: 100000, model_metadata: { context: 99999, secret }, displayName: secret }] })))
    expect(result.models[0]!.metadata).toEqual(unknownMetadata())
    safe(result)
  }
})

test('Responses identities remain listed with no inferred capabilities', async () => {
  const result = await discoverProviders(wireOf({ fixture: provider({ kind: 'responses' }) }), optionsOf(() => json({ data: [{ id: 'gpt-example-tools-1m', max_tokens: 1000, max_output_tokens: 2000, reasoning: true, vision: true }] })))
  expect(result.models[0]!.metadata).toEqual(unknownMetadata())
  expect(result.models[0]!.model).toBe('fixture/gpt-example-tools-1m')
})

test('Anthropic uses supported reported limits and pagination, not declared capability defaults', async () => {
  const urls: URL[] = []
  const wire = wireOf({ fixture: provider({ kind: 'anthropic' }) })
  const result = await discoverProviders(wire, optionsOf((url, init) => {
    urls.push(url)
    const headers = new Headers(init.headers)
    expect(headers.get('x-api-key') === secret).toBe(true)
    expect(headers.get('anthropic-version')).toBe('2023-06-01')
    return urls.length === 1 ? json({ data: [{ id: 'current', max_input_tokens: 200000, max_tokens: 10000 }], has_more: true, last_id: 'current' }) : json({ data: [{ id: 'second' }], has_more: false })
  }))
  expect(urls[1]!.searchParams.get('after_id')).toBe('current')
  expect(result.models[0]!.metadata).toEqual({ ...unknownMetadata(), inputTokenLimit: 200000, outputTokenLimit: 10000 })
  expect(result.models[1]!.metadata).toEqual(unknownMetadata())
  safe(result)
})

test('Anthropic root and versioned bases enumerate /v1/models without duplicating the version', async () => {
  for (const [baseUrl, pathname] of [
    ['https://api.anthropic.com', '/v1/models'],
    ['https://api.anthropic.com/', '/v1/models'],
    ['https://api.anthropic.com/v1', '/v1/models'],
    ['https://fixture.example/inference/v1/', '/inference/v1/models'],
  ]) {
    const urls: URL[] = []
    const result = await discoverProviders(wireOf({ fixture: provider({ kind: 'anthropic', baseUrl }) }), optionsOf((url, init) => {
      urls.push(url)
      expect(url.pathname).toBe(pathname!)
      expect(init.method).toBe('GET')
      expect(new Headers(init.headers).get('x-api-key')).toBe(secret)
      return urls.length === 1 ? json({ data: [{ id: 'first' }], has_more: true, last_id: 'first' }) : json({ data: [{ id: 'second' }], has_more: false })
    }))
    expect(urls).toHaveLength(2)
    expect(urls.every(url => url.origin === new URL(baseUrl!).origin && url.pathname === pathname)).toBe(true)
    expect(urls[1]!.searchParams.get('after_id')).toBe('first')
    expect(result.providers[0]!.status).toBe('fresh')
    expect(result.models.map(model => model.model)).toEqual(['fixture/first', 'fixture/second'])
    safe(result)
  }
})

test('Gemini page tokens are confined to the same endpoint', async () => {
  const urls: URL[] = []
  const result = await discoverProviders(wireOf({ fixture: provider({ kind: 'gemini' }) }), optionsOf((url, init) => {
    urls.push(url)
    expect(new Headers(init.headers).get('x-goog-api-key') === secret).toBe(true)
    return urls.length === 1 ? json({ models: [{ name: 'models/first' }], nextPageToken: 'cursor' }) : json({ models: [{ name: 'models/second' }] })
  }))
  expect(result.models).toHaveLength(2)
  expect(urls[1]!.searchParams.get('pageToken')).toBe('cursor')
  expect(urls.every(url => url.origin === 'https://fixture.example' && url.pathname === '/v1/models')).toBe(true)
})

test('unapproved providers never run key helpers or contact catalogues, including auth none', async () => {
  let runs = 0
  let calls = 0
  const options = optionsOf(() => { calls++; return json({ data: [] }) })
  options.run = async () => { runs++; return { stdout: secret, exitCode: 0 } }
  const result = await discoverProviders(wireOf({ fixture: provider(), plain: provider({ auth: 'none' }) }, false), options)
  expect(result.providers.map(provider => provider.status)).toEqual(['approval-required', 'approval-required'])
  expect(runs).toBe(0)
  expect(calls).toBe(0)
})

test('an approval for another origin or argv never authorizes a helper', async () => {
  let runs = 0
  const wire = wireOf()
  wire.configText = wire.configText.replace('/fixture/key-helper', '/fixture/other-helper')
  const options = optionsOf(() => { throw new Error('must not fetch') })
  options.run = async () => { runs++; return { stdout: secret, exitCode: 0 } }
  expect((await discoverProviders(wire, options)).providers[0]!.status).toBe('approval-required')
  expect(runs).toBe(0)
})

test('provider headers and auth stay in memory, with no per-model declaration overlays', async () => {
  const wire = wireOf({ fixture: provider({ authHeader: 'x-goog-api-key', headers: { 'x-client': 'fixture', 'anthropic-version': 'custom' }, models: { stale: { ...declaration, headers: { 'x-model': 'do-not-send' } } } }) })
  const result = await discoverProviders(wire, optionsOf((_, init) => {
    const headers = new Headers(init.headers)
    expect(headers.get('x-client')).toBe('fixture')
    expect(headers.get('x-goog-api-key') === secret).toBe(true)
    expect(headers.has('authorization')).toBe(false)
    expect(headers.has('x-model')).toBe(false)
    expect(headers.get('user-agent')).toBe('fixture-client')
    return json({ data: [{ id: 'current', owned_by: secret, errors: secret }] })
  }))
  safe(result)
})

test('auth none does not run helpers or send an auth header', async () => {
  const options = optionsOf((_, init) => {
    const headers = new Headers(init.headers)
    expect(headers.has('authorization')).toBe(false)
    return json({ data: [] })
  })
  options.run = async () => { throw new Error('must not run') }
  expect((await discoverProviders(wireOf({ fixture: provider({ auth: 'none' }) }), options)).providers[0]!.status).toBe('fresh')
})

test('Bedrock enumeration is explicitly unsupported, without executing auth', async () => {
  const options = optionsOf(() => { throw new Error('must not fetch') })
  options.run = async () => { throw new Error('must not run') }
  failure(await discoverProviders(wireOf({ fixture: provider({ kind: 'bedrock' }) }), options), 'enumeration-unsupported')
})

test('HTTP failures do not retry, expose response bodies, or fall back to declarations', async () => {
  for (const status of [401, 403, 429, 500]) {
    let calls = 0
    const result = await discoverProviders(wireOf(), optionsOf(() => { calls++; return new Response(secret, { status, headers: { 'x-private': secret } }) }))
    failure(result, `http-${status}`)
    expect(calls).toBe(1)
  }
})

test('helper failures and thrown fetch errors are reduced to safe categories', async () => {
  const options = optionsOf(() => { throw new Error(secret) })
  failure(await discoverProviders(wireOf(), options), 'discovery-failed')
  options.run = async () => { throw new Error(secret) }
  failure(await discoverProviders(wireOf(), options), 'auth-unavailable')
  options.run = async () => ({ stdout: secret, exitCode: 1 })
  failure(await discoverProviders(wireOf(), options), 'auth-unavailable')
})

test('cross-origin, credentialed, fragment and off-path pagination fail without a second request', async () => {
  for (const next of ['https://evil.example/models', 'https://user:password@fixture.example/v1/models', '/other/models', '#fragment']) {
    let calls = 0
    const result = await discoverProviders(wireOf(), optionsOf(() => { calls++; return json({ data: [{ id: 'current' }], links: { next } }) }))
    failure(result, 'pagination-invalid')
    expect(calls).toBe(1)
  }
})

test('valid same-endpoint links and OpenAI-compatible cursors paginate without retry', async () => {
  for (const style of ['link', 'cursor']) {
    const urls: URL[] = []
    const result = await discoverProviders(wireOf(), optionsOf(url => {
      urls.push(url)
      return urls.length === 1 ? json({ data: [{ id: 'first' }], ...(style === 'link' ? { next: '?page=2' } : { has_more: true, last_id: 'first' }) }) : json({ data: [{ id: 'second' }] })
    }))
    expect(result.models).toHaveLength(2)
    expect(urls[1]!.searchParams.get(style === 'link' ? 'page' : 'after')).toBe(style === 'link' ? '2' : 'first')
  }
})

test('pagination loops and more than twenty pages discard partial inventory', async () => {
  failure(await discoverProviders(wireOf(), optionsOf(() => json({ data: [{ id: 'first' }], next: '/v1/models' }))), 'pagination-limit')
  let calls = 0
  failure(await discoverProviders(wireOf(), optionsOf(() => json({ data: [{ id: `model-${++calls}` }], next: `?page=${calls + 1}` }))), 'pagination-limit')
  expect(calls).toBe(20)
})

test('empty catalogue is fresh and invalid payloads never become declared models', async () => {
  expect((await discoverProviders(wireOf(), optionsOf(() => json({ data: [] })))).providers[0]!.status).toBe('fresh')
  for (const payload of [{ models: [] }, { data: {} }, { data: [null] }, { data: [{ id: '' }] }, { data: [{ id: 'first' }, { id: 'first' }] }, { data: [{ id: 'bad\nmodel' }] }]) {
    failure(await discoverProviders(wireOf(), optionsOf(() => json(payload))), 'protocol-invalid')
  }
  failure(await discoverProviders(wireOf(), optionsOf(() => new Response(secret))), 'protocol-invalid')
})

test('bounded response bytes apply to the whole paginated operation', async () => {
  failure(await discoverProviders(wireOf(), optionsOf(() => new Response(' '.repeat(4 * 1024 * 1024 + 1)))), 'protocol-too-large')
  let calls = 0
  failure(await discoverProviders(wireOf(), optionsOf(() => json({ data: [], next: `?page=${++calls}`, ignored: ' '.repeat(3 * 1024 * 1024) }))), 'protocol-too-large')
  expect(calls).toBe(2)
})

test('one deadline bounds helpers, fetches and unfinished bodies; cancellation is sanitized', async () => {
  const wire = wireOf()
  for (const stage of ['helper', 'fetch', 'body']) {
    const options = optionsOf(() => stage === 'fetch' ? new Promise<Response>(() => {}) : new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"data":[')) } })))
    let helperTimeout = 0
    if (stage === 'helper') options.run = async (_, timeout) => { helperTimeout = timeout; return new Promise(() => {}) }
    const start = Date.now()
    failure(await discoverProviders(wire, { ...options, timeoutMs: 30 }), 'deadline-exceeded')
    expect(Date.now() - start).toBeLessThan(1000)
    if (stage === 'helper') expect(helperTimeout > 0 && helperTimeout <= 30).toBe(true)
  }
  const controller = new AbortController()
  const options = optionsOf(() => { controller.abort(secret); return new Promise<Response>(() => {}) })
  failure(await discoverProviders(wire, { ...options, signal: controller.signal }), 'cancelled')
  let calls = 0
  failure(await discoverProviders(wire, { ...optionsOf(() => { calls++; return json({ data: [] }) }), signal: controller.signal }), 'cancelled')
  expect(calls).toBe(0)
})

test('one unavailable provider does not discard another provider fresh catalogue', async () => {
  const wire = wireOf({ fixture: provider(), other: provider({ baseUrl: 'https://other.example/v1' }) })
  const result = await discoverProviders(wire, optionsOf(url => url.hostname === 'fixture.example' ? new Response(secret, { status: 403 }) : json({ data: [{ id: 'live' }] })))
  expect(result.providers.map(provider => provider.status)).toEqual(['unavailable', 'fresh'])
  expect(result.models.map(model => model.model)).toEqual(['other/live'])
  safe(result)
})

test('no config and invalid config do not execute any I/O or surface parser errors', async () => {
  const options = optionsOf(() => { throw new Error('must not fetch') })
  options.run = async () => { throw new Error('must not run') }
  expect(await discoverProviders({ configText: '', approved: [] }, options)).toEqual({ models: [], providers: [] })
  const result = await discoverProviders({ configText: secret, approved: [] }, options)
  expect(result.providers[0]).toMatchObject({ status: 'unavailable', error: 'config-invalid' })
  safe(result)
})

const registryEntry = (context: unknown = 100000, input: unknown = 90000, output: unknown = 75000) => ({ limit: { context, input, output }, modalities: { input: ['text', 'image'] }, tool_call: true, reasoning: true, provider: { npm: '@ai-sdk/openai' } })

test('exact OpenCode tiers receive fresh registry values on every invocation without declaration caps', async () => {
  for (const tier of Object.values(TIERS)) {
    const wire = wireOf({ [tier.id]: provider({ baseUrl: tier.base }) })
    let registryCalls = 0
    let gatewayCalls = 0
    const options = optionsOf((url, init) => {
      if (url.href === CATALOG_URL) {
        registryCalls++
        const headers = new Headers(init.headers)
        expect(headers.has('authorization')).toBe(false)
        expect(headers.has('x-api-key')).toBe(false)
        expect(headers.has('x-goog-api-key')).toBe(false)
        expect(headers.get('accept')).toBe('application/json')
        expect(init.redirect).toBe('error')
        expect(init.cache).toBe('no-store')
        return json({ [tier.id]: { models: { live: registryEntry(registryCalls * 100000, registryCalls * 90000, registryCalls * 75000), 'registry-only': registryEntry() } } })
      }
      gatewayCalls++
      return json({ data: [{ id: 'live' }, { id: 'gateway-only' }] })
    })
    const first = await discoverProviders(wire, options)
    const second = await discoverProviders(wire, options)
    expect(registryCalls).toBe(2)
    expect(gatewayCalls).toBe(2)
    expect(first.models[0]!.metadata).toEqual({ ...unknownMetadata(), contextWindow: 100000, inputTokenLimit: 90000, outputTokenLimit: 75000, inputModalities: ['text', 'image'], tools: true })
    expect(second.models[0]!.metadata).toEqual({ ...unknownMetadata(), contextWindow: 200000, inputTokenLimit: 180000, outputTokenLimit: 150000, inputModalities: ['text', 'image'], tools: true })
    expect(second.models[0]!.source).toContain('+ fresh models.dev registry metadata')
    expect(second.models[0]!.metadataSources).toEqual({ contextWindow: `fresh models.dev registry ${tier.id}/live`, inputTokenLimit: `fresh models.dev registry ${tier.id}/live`, outputTokenLimit: `fresh models.dev registry ${tier.id}/live`, inputModalities: `fresh models.dev registry ${tier.id}/live`, tools: `fresh models.dev registry ${tier.id}/live` })
    expect(second.models.map(model => model.model)).toEqual([`${tier.id}/live`, `${tier.id}/gateway-only`])
    expect(second.models[1]!.metadata).toEqual(unknownMetadata())
    expect(second.models[1]!.metadataSources).toBeUndefined()
    safe(second)
  }
})

test('registry mapping requires the exact OpenCode provider ID and endpoint, not similar names', async () => {
  for (const [id, baseUrl] of [['opencode', 'https://fixture.example/v1'], ['opencode', 'https://opencode.ai/inference/go/v1'], ['opencode-alias', TIERS.zen.base]]) {
    let registryCalls = 0
    const result = await discoverProviders(wireOf({ [id!]: provider({ baseUrl }) }), optionsOf(url => {
      if (url.href === CATALOG_URL) registryCalls++
      return json({ data: [{ id: 'live' }] })
    }))
    expect(registryCalls).toBe(0)
    expect(result.models[0]!.metadata).toEqual(unknownMetadata())
  }
})

test('registry enrichment does not fuzzy-match IDs or borrow another provider metadata', async () => {
  const wire = wireOf({ opencode: provider({ baseUrl: TIERS.zen.base }) })
  const result = await discoverProviders(wire, optionsOf(url => url.href === CATALOG_URL ? json({ opencode: { models: { 'live-similar': registryEntry(), LIVE: registryEntry() } }, openai: { models: { live: registryEntry() } } }) : json({ data: [{ id: 'live' }] })))
  expect(result.models[0]!.metadata).toEqual(unknownMetadata())
  expect(result.models[0]!.metadataSources).toBeUndefined()
})

test('supported endpoint-reported fields win over fresh registry supplements', async () => {
  const wire = wireOf({ opencode: provider({ baseUrl: TIERS.zen.base, kind: 'gemini' }) })
  const result = await discoverProviders(wire, optionsOf(url => url.href === CATALOG_URL ? json({ opencode: { models: { live: registryEntry(400000, 200000, 100000) } } }) : json({ models: [{ name: 'models/live', inputTokenLimit: 12345, outputTokenLimit: 6789 }] })))
  expect(result.models[0]!.metadata).toEqual({ ...unknownMetadata(), contextWindow: 400000, inputTokenLimit: 12345, outputTokenLimit: 6789, inputModalities: ['text', 'image'], tools: true })
  expect(result.models[0]!.metadataSources!.inputTokenLimit).toBeUndefined()
  expect(result.models[0]!.metadataSources!.outputTokenLimit).toBeUndefined()
})

test('missing or malformed registry limits stay null without output/context/protocol defaults', async () => {
  const wire = wireOf({ opencode: provider({ baseUrl: TIERS.zen.base }) })
  const entries = [{}, { limit: { context: 400000 } }, registryEntry(-1, '200000', 1.5), { limit: { output: 100000 }, tool_call: false, modalities: { input: ['text'] }, reasoning: true }]
  const expected = [unknownMetadata(), { ...unknownMetadata(), contextWindow: 400000 }, { ...unknownMetadata(), inputModalities: ['text', 'image'], tools: true }, { ...unknownMetadata(), outputTokenLimit: 100000, inputModalities: ['text'], tools: false }]
  for (let index = 0; index < entries.length; index++) {
    const result = await discoverProviders(wire, optionsOf(url => url.href === CATALOG_URL ? json({ opencode: { models: { live: entries[index] } } }) : json({ data: [{ id: 'live' }] })))
    expect(result.models[0]!.metadata).toEqual(expected[index]!)
  }
})

test('registry failures, invalid bodies and timeouts preserve fresh gateway identities and endpoint metadata', async () => {
  const wire = wireOf({ opencode: provider({ baseUrl: TIERS.zen.base }) })
  for (const respond of [() => new Response(secret, { status: 500 }), () => new Response(secret), () => { throw new Error(secret) }, () => new Promise<Response>(() => {})]) {
    const result = await discoverProviders(wire, { ...optionsOf(url => url.href === CATALOG_URL ? respond() : json({ data: [{ id: 'live' }] })), timeoutMs: 30 })
    expect(result.providers[0]!.status).toBe('fresh')
    expect(result.models[0]!.model).toBe('opencode/live')
    expect(result.models[0]!.metadata).toEqual(unknownMetadata())
    expect(result.models[0]!.metadataSources).toBeUndefined()
    safe(result)
  }
  const geminiWire = wireOf({ opencode: provider({ baseUrl: TIERS.zen.base, kind: 'gemini' }) })
  const result = await discoverProviders(geminiWire, optionsOf(url => url.href === CATALOG_URL ? new Response(secret, { status: 500 }) : json({ models: [{ name: 'models/live', inputTokenLimit: 321 }] })))
  expect(result.models[0]!.metadata.inputTokenLimit).toBe(321)
})

test('unapproved or unavailable OpenCode gateways never trigger registry enrichment', async () => {
  let calls = 0
  const options = optionsOf(() => { calls++; return new Response(secret, { status: 403 }) })
  const wire = wireOf({ opencode: provider({ baseUrl: TIERS.zen.base }) }, false)
  expect((await discoverProviders(wire, options)).providers[0]!.status).toBe('approval-required')
  expect(calls).toBe(0)
  wire.approved = wireOf({ opencode: provider({ baseUrl: TIERS.zen.base }) }).approved
  expect((await discoverProviders(wire, options)).providers[0]!.status).toBe('unavailable')
  expect(calls).toBe(1)
})
