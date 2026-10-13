import { beforeAll, expect, mock, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { unknownMetadata, type ModelCatalogue } from '../hooks/catalogue'

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '')
const helperBranches: string[] = []
mock.module('claude-code', () => ({
  atom: (_key: unknown, value: unknown) => ({ value }),
  read: async (_host: unknown, atom: { value: unknown }) => atom.value,
  update: async (_host: unknown, atom: { value: unknown }, change: (value: unknown) => unknown) => { atom.value = change(atom.value) },
}))
mock.module(`${root}/helper/codex.ts`, () => ({ codexStep: async function* (_req: unknown, model: string) { helperBranches.push(`codex:${model}`); yield { type: 'text', text: `fixture: codex ${model}` } } }))
mock.module(`${root}/helper/harness.ts`, () => ({ harnessStep: async function* (_req: unknown, provider: string, model: string) { helperBranches.push(`worker:${provider}/${model}`); yield { type: 'text', text: `fixture: worker ${provider}/${model}` } } }))
mock.module(`${root}/helper/styx/step.ts`, () => ({ createStepper: () => ({ step: async function* (wire: any) { helperBranches.push(`configured:${wire.req.target}`); yield { type: 'text', text: `fixture: configured ${wire.req.target}` } } }) }))
const { register } = await import(`${root}/hooks/register.ts`)
const { runStep, offeredTools } = await import(`${root}/helper/run.ts`)

type Hook = { matcher?: Record<string, string>; callback: (...args: any[]) => any }
const hooks = new Map<string, Hook[]>()
const on: any = (event: string, matcherOrCallback: any, callback?: any) => {
  const hook = callback ? { matcher: matcherOrCallback, callback } : { callback: matcherOrCallback }
  hooks.set(event, [...(hooks.get(event) ?? []), hook])
  return { catch: (failed: (...args: any[]) => any) => { const callback = hook.callback; hook.callback = async (...args: any[]) => { try { return await callback(...args) } catch { return failed() } } } }
}
register(on)
const hook = (event: string, name?: string) => {
  const found = hooks.get(event)?.find(item => name === undefined || item.matcher?.tool === name || item.matcher?.command === name)
  if (!found) throw new Error(`Missing hook ${event} ${name ?? ''}`)
  return found.callback
}
const defs = new Map<string, any>()
const toolDefs = new Map<string, any>()
const agents: any[] = []
const wires: any[] = []
const store = new Map<string, unknown>()
const fixtureFiles = new Map<string, string>()
const fixtureDirs = new Map<string, any[]>()
let config = JSON.stringify({ providers: {} })
let failRegistration = false
let approvalAnswer = 'Keep it off'
let processRunCount = 0
const processCalls: string[][] = []
const discoveries: { argv: string[]; input: { configText: string; approved: string[] } }[] = []
let discoveryOverride: ModelCatalogue | undefined
let discoveryUnavailable = false
const observedAt = 1_800_000_000_000
const discoveredModel = (model: string, source = 'Codex authenticated models endpoint', execution: 'native provider' | 'CLI worker' = 'native provider'): ModelCatalogue['models'][number] => ({ model, label: `Fixture ${model}`, execution, source, observedAt, metadata: unknownMetadata() })
const freshCatalogue = (configText: string): ModelCatalogue => {
  const providers = JSON.parse(configText || '{"providers":{}}').providers ?? {}
  const models = Object.keys(providers).includes('codex') ? [] : [discoveredModel('codex/gpt-6.1-sol')]
  for (const [id, declared] of Object.entries(providers)) {
    for (const model of Object.keys((declared as any).models ?? {})) models.push(discoveredModel(`${id}/${model}`, 'configured provider'))
  }
  if (agyInstalled && !Object.hasOwn(providers, 'agy')) models.push(discoveredModel('agy/review-model', 'agy installed worker', 'CLI worker'))
  return { models, providers: [...new Set(models.map(entry => entry.model.split('/')[0]!))].map(provider => ({ provider, status: 'fresh', source: 'fixture discovery boundary', observedAt })) }
}
let approvalAskCount = 0
let agyInstalled = false
let emitLimits = false
const reportedLimits = { plan: 'fixture-subscription', windows: [{ label: 'weekly', usedPercent: 97, resetsAt: 1_800_000_100_000 }] }
const modelRefs = ['mcp__rice-multi-models__models', 'mcp__rice-multi-models__agent_type']
const environment = new Map<string, string>([['HOME', '/fixture-home']])
const sessionState = new Map<string, unknown>()
const host: any = {
  env: { get: async (key: string) => environment.get(key), set: async (key: string, value: string | undefined) => { if (value === undefined) environment.delete(key); else environment.set(key, value) } },
  state: { get: async (ref: { key: string }) => ({ value: sessionState.get(ref.key), version: 0 }), set: async (ref: { key: string }, value: unknown) => { sessionState.set(ref.key, value); return { isSet: true, version: 1 } } },
  plugin: { root },
  fs: {
    exists: async (path: string) => path.endsWith('/dist/helper.mjs') || path.endsWith('rice-multi-models.json') || fixtureFiles.has(path) || fixtureDirs.has(path),
    read: async (path: string) => {
      if (fixtureFiles.has(path)) return fixtureFiles.get(path)
      if (path.endsWith('rice-multi-models.json')) return config
      throw new Error('fixture ENOENT')
    },
    list: async (path: string) => fixtureDirs.get(path) ?? [],
    write: async () => { throw new Error('Fixture forbids filesystem writes') },
  },
  process: {
    run: async (argv: string[], options: any = {}) => {
      processRunCount++
      processCalls.push(argv)
      if (argv[2] === 'discover') {
        const input = JSON.parse(options.stdin)
        discoveries.push({ argv, input })
        if (discoveryUnavailable) return { exitCode: 1, stdout: '', stderr: 'fixture discovery unavailable' }
        return { exitCode: 0, stdout: JSON.stringify(discoveryOverride ?? freshCatalogue(input.configText)), stderr: '' }
      }
      if (argv[0] === 'node') return { exitCode: 0, stdout: JSON.stringify({ executable: '/fixture/node', version: '22.20.0' }), stderr: '' }
      if (argv[2] === 'doctor') return { exitCode: 0, stdout: JSON.stringify({ node: { executable: '/fixture/node', version: '22.20.0', supported: true }, platform: 'linux', home: '/fixture-home', configDir: '/fixture-home/.claude', codexHome: '/fixture-home/.codex', opencodeAuthFile: '/fixture-home/opencode-auth.json', auth: { codex: false, opencode: false }, clis: agyInstalled ? { agy: '/fixture/agy' } : {} }), stderr: '' }
      if (argv[2] === 'sync-picker') return { exitCode: 0, stdout: JSON.stringify({ ok: true, changed: false, count: 1, path: '/fixture-home/.claude/settings.json' }), stderr: '' }
      return { exitCode: 1, stdout: '', stderr: '' }
    },
    spawn: async function* (options: any) {
      if (!options.input) throw new Error('Fixture forbids helper startup')
      wires.push(JSON.parse(options.input))
      if (emitLimits) yield { stream: 'stdout', text: JSON.stringify({ type: 'limits', limits: reportedLimits }) + '\n' }
      yield { stream: 'stdout', text: JSON.stringify({ type: 'text', text: 'fixture response' }) + '\n' + JSON.stringify({ type: 'stop', reason: 'end_turn' }) + '\n' }
      return { code: 0 }
    },
  },
  command: { register: async () => ({}) },
  tool: {
    register: async (spec: any) => { toolDefs.set(`mcp__rice-multi-models__${spec.name}`, spec); return { tool: `mcp__rice-multi-models__${spec.name}` } },
    list: async () => [
      { name: 'Read', description: 'Read', mcp: false },
      { name: 'Bash', description: 'Bash', mcp: false },
      ...[...toolDefs].map(([name, spec]) => ({ name, description: spec.description, mcp: true })),
    ],
  },
  agent: {
    register: async (spec: any) => {
      if (failRegistration) { failRegistration = false; throw new Error('fixture registration refusal') }
      defs.set(`rice-multi-models:${spec.name}`, spec)
      return { agent: `rice-multi-models:${spec.name}` }
    },
    list: async () => agents,
  },
  store: { keys: async () => [...store.keys()], get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => { store.set(key, value) } },
  ui: {
    ask: async () => { approvalAskCount++; return approvalAnswer },
    log: () => {}, status: () => {}, toast: () => {},
  },
  clock: { now: async () => 1_800_000_000_000, sleep: async () => {} },
  session: {
    id: async () => 'fixture-session', cwd: async () => root,
    model: async () => 'codex/gpt-6.1-sol',
    usage: async () => ({ context: { window: Number(environment.get('CLAUDE_CODE_MAX_CONTEXT_TOKENS') ?? 200000) } }),
    version: async () => ({ version: '2.1.296' }),
    messages: async () => [{ role: 'user', content: modelRefs.map(tool_name => ({ type: 'tool_reference', tool_name })) }],
  },
  prompt: { compose: async () => ({ sections: [{ id: 'base', scope: 'shared', text: 'fixture base' }] }) },
}
const tool = async (name: string, input: unknown) => (await hook('tool.call', name)(host, { tool: name, input })).result as string
const registerType = (model: string, mode = 'write') => tool(modelRefs[1]!, { model, mode })
const typeOf = (text: string) => /^type: (.+)$/m.exec(text)?.[1] ?? (() => { throw new Error(`No type in ${text}`) })()
const reload = async (providers: Record<string, unknown>, aliases: Record<string, unknown> = {}) => {
  config = JSON.stringify({ providers, aliases })
  return hook('command.run', 'rice-models')(host, { args: 'reload' })
}
const provider = (model: string, baseUrl = 'https://fixture.invalid/v1') => ({ kind: 'openai', baseUrl, auth: 'none', models: { [model]: { contextWindow: 128000, maxOutputTokens: 4096 } } })
const step = async (type: string, model: string) => {
  const id = `fixture-agent-${agents.length}`
  agents.push({ id, type, description: 'offline review control' })
  let nextCalls = 0
  const generator = hook('turn.step')(host, { agentId: id, model, turnId: 'fixture-turn', index: 0 }, async function* () {
    nextCalls++
    return { passthrough: true }
  })
  let item = await generator.next()
  const chunks: any[] = []
  while (!item.done) { chunks.push(item.value); item = await generator.next() }
  return { result: item.value, chunks, nextCalls, id }
}
const executeHelper = async (wire: any) => {
  const result = []
  for await (const event of runStep(wire, new AbortController().signal)) result.push(event)
  return result
}
beforeAll(async () => { await hook('session.start')(host, {}, async () => ({})) })

test('startup discovers once and models and status read that snapshot without another discovery', async () => {
  expect(discoveries).toEqual([{ argv: ['/fixture/node', `${root}/dist/helper.mjs`, 'discover'], input: { configText: JSON.stringify({ providers: {} }), approved: [] } }])
  for (const action of ['models', 'status']) {
    const report = await tool(modelRefs[0]!, { action })
    expect(report).toContain('codex/gpt-6.1-sol')
    await hook('command.run', 'rice-models')(host, { args: action })
  }
  expect(discoveries.length).toBe(1)
  const report = JSON.parse(await tool(modelRefs[0]!, { action: 'models' }))
  expect(report.models[0]).toMatchObject({ metadata: unknownMetadata(), availability: 'candidate, not live-entitlement proof' })
})

test('explicit refresh replaces discovered IDs and metadata and forwards declared config and approvals', async () => {
  store.clear()
  await reload({})
  const before = JSON.parse(await tool(modelRefs[0]!, { action: 'models' }))
  expect(before.models[0].metadata.contextWindow).toBeNull()
  const model = discoveredModel('codex/gpt-6.1-sol')
  model.metadata = { ...unknownMetadata(), contextWindow: 64000, outputTokenLimit: 2048 }
  model.metadataSources = { contextWindow: 'fixture endpoint limit', outputTokenLimit: 'fixture endpoint limit' }
  discoveryOverride = { models: [model, discoveredModel('codex/fresh-new-model')], providers: [{ provider: 'codex', status: 'fresh', source: 'fixture refreshed endpoint', observedAt }] }
  store.set('trust:fixture-approved-fingerprint', true)
  try {
    const refreshes = discoveries.length
    await hook('command.run', 'rice-models')(host, { args: 'refresh' })
    expect(discoveries.length).toBe(refreshes + 1)
    expect(discoveries.at(-1)?.input).toEqual({ configText: JSON.stringify({ providers: {}, aliases: {} }), approved: ['fixture-approved-fingerprint'] })
    const report = JSON.parse(await tool(modelRefs[0]!, { action: 'models' }))
    expect(report.models.map((entry: any) => entry.model)).toEqual(['codex/gpt-6.1-sol', 'codex/fresh-new-model'])
    expect(report.models[0]).toMatchObject({ metadata: { contextWindow: 64000, inputTokenLimit: null, outputTokenLimit: 2048, tools: null }, metadataSources: { contextWindow: 'fixture endpoint limit', outputTokenLimit: 'fixture endpoint limit' } })
    expect(report.models[1].metadata).toEqual(unknownMetadata())
    await tool(modelRefs[0]!, { action: 'status' })
    expect(discoveries.length).toBe(refreshes + 1)
  } finally {
    store.delete('trust:fixture-approved-fingerprint')
    discoveryOverride = undefined
    await reload({})
  }
})

test('empty or failed discovery removes all candidates without a default or cache fallback', async () => {
  try {
    for (const unavailable of [false, true]) {
      discoveryOverride = { models: [], providers: [{ provider: 'codex', status: 'unavailable', source: 'fixture endpoint', error: 'fixture-unavailable' }] }
      discoveryUnavailable = unavailable
      await hook('command.run', 'rice-models')(host, { args: 'refresh' })
      const report = JSON.parse(await tool(modelRefs[0]!, { action: 'models' }))
      expect(report.models).toEqual([])
      expect(report.discovery[0].status).toBe('unavailable')
      const registrations = defs.size
      const beforeWires = wires.length
      expect(await registerType('codex/gpt-6.1-sol')).toContain('not in the supplied model catalogue')
      expect(defs.size).toBe(registrations)
      expect(wires.length).toBe(beforeWires)
      const status = await tool(modelRefs[0]!, { action: 'status' })
      expect(status).not.toContain('"defaultCodexModel":')
    }
  } finally {
    discoveryUnavailable = false
    discoveryOverride = undefined
    await reload({})
  }
})

test('a registered subscription route refuses a candidate removed by fresh discovery', async () => {
  discoveryOverride = { models: [discoveredModel('codex/catalogue-only-model')], providers: [{ provider: 'codex', status: 'fresh', source: 'fixture endpoint', observedAt }] }
  try {
    await hook('command.run', 'rice-models')(host, { args: 'refresh' })
    const type = typeOf(await registerType('codex/catalogue-only-model'))
    discoveryOverride = { models: [discoveredModel('codex/replacement-model')], providers: [{ provider: 'codex', status: 'fresh', source: 'fixture endpoint', observedAt }] }
    await hook('command.run', 'rice-models')(host, { args: 'refresh' })
    const beforeWires = wires.length
    const beforeApprovals = approvalAskCount
    const refused = await step(type, 'codex/catalogue-only-model')
    expect(refused.nextCalls).toBe(0)
    expect(JSON.stringify(refused.result)).toContain('no longer current')
    expect(wires.length).toBe(beforeWires)
    expect(approvalAskCount).toBe(beforeApprovals)
    const compacted = await hook('session.compact')(host, { agentId: refused.id, trigger: 'auto', instructions: '', messages: [] }, async () => ({ skip: 'fixture fallback' }))
    expect(compacted.skip).toContain('no longer current')
    expect(wires.length).toBe(beforeWires)
    expect(await registerType('codex/catalogue-only-model')).toContain('not in the supplied model catalogue')
  } finally {
    discoveryOverride = undefined
    await reload({})
  }
})

test('fresh discovered input and context bounds refuse oversized routed turns before helper dispatch', async () => {
  const messages = host.session.messages
  host.session.messages = async () => [{ role: 'user', content: 'oversized fixture transcript '.repeat(400) }]
  try {
    for (const bounds of [
      { contextWindow: 512, inputTokenLimit: null },
      { contextWindow: null, inputTokenLimit: 512 },
      { contextWindow: 128000, inputTokenLimit: 512 },
      { contextWindow: 512, inputTokenLimit: 128000 },
    ]) {
      const model = discoveredModel('codex/gpt-6.1-sol')
      model.metadata = { ...unknownMetadata(), ...bounds }
      discoveryOverride = { models: [model], providers: [{ provider: 'codex', status: 'fresh', source: 'fixture input bounds', observedAt }] }
      await reload({})
      const type = typeOf(await registerType(model.model))
      const beforeWires = wires.length
      const refreshes = discoveries.length
      const refused = await step(type, model.model)
      expect(refused.nextCalls).toBe(0)
      expect(JSON.stringify(refused.result)).toContain('512 token input bound')
      expect(JSON.stringify(refused.result)).toContain('native routed compaction is unavailable')
      expect(wires.length).toBe(beforeWires)
      expect(discoveries.length).toBe(refreshes)
    }
  } finally {
    host.session.messages = messages
    discoveryOverride = undefined
    await reload({})
  }
})

test('a smaller freshly refreshed bound applies to the same reusable routed Agent type', async () => {
  const messages = host.session.messages
  host.session.messages = async () => [{ role: 'user', content: 'same request '.repeat(500) }]
  const model = discoveredModel('codex/gpt-6.1-sol')
  model.metadata = { ...unknownMetadata(), contextWindow: 32000 }
  discoveryOverride = { models: [model], providers: [{ provider: 'codex', status: 'fresh', source: 'fixture input bounds', observedAt }] }
  try {
    await reload({})
    const type = typeOf(await registerType(model.model))
    const before = wires.length
    const accepted = await step(type, model.model)
    expect(accepted.nextCalls).toBe(0)
    expect(wires.length).toBe(before + 1)
    expect(JSON.stringify(accepted.result)).toContain('fixture response')
    model.metadata = { ...unknownMetadata(), contextWindow: 32000, inputTokenLimit: 512 }
    await hook('command.run', 'rice-models')(host, { args: 'refresh' })
    expect(typeOf(await registerType(model.model))).toBe(type)
    const refused = await step(type, model.model)
    expect(refused.nextCalls).toBe(0)
    expect(JSON.stringify(refused.result)).toContain('512 token input bound')
    expect(wires.length).toBe(before + 1)
  } finally {
    host.session.messages = messages
    discoveryOverride = undefined
    await reload({})
  }
})

test('oversized complete and fork requests refuse without helper dispatch or native fallback', async () => {
  const messages = host.session.messages
  const sessionModel = host.session.model
  host.session.model = async () => 'codex/gpt-6.1-sol'
  host.session.messages = async () => [{ role: 'user', content: 'fixture conversation' }]
  const model = discoveredModel('codex/gpt-6.1-sol')
  model.metadata = { ...unknownMetadata(), contextWindow: 128000, inputTokenLimit: 512 }
  discoveryOverride = { models: [model], providers: [{ provider: 'codex', status: 'fresh', source: 'fixture input bounds', observedAt }] }
  try {
    await reload({})
    const beforeWires = wires.length
    const refreshes = discoveries.length
    let nativeCalls = 0
    const next = async () => { nativeCalls++; return { value: { isAnswered: true, text: 'unsafe native fallback' } } }
    for (const event of ['model.complete', 'model.fork']) {
      const result = await hook(event)(host, { model: model.model, prompt: 'oversized fixture prompt '.repeat(400), system: 'fixture instructions' }, next)
      expect(result.value).toMatchObject({ isAnswered: false, reason: 'api-error', usage: { input_tokens: 0, output_tokens: 0 } })
      expect(wires.length).toBe(beforeWires)
    }
    expect(nativeCalls).toBe(0)
    expect(discoveries.length).toBe(refreshes)
  } finally {
    host.session.model = sessionModel
    host.session.messages = messages
    discoveryOverride = undefined
    await reload({})
  }
})

test('routed compaction refuses every trigger without reading history, dispatching or native fallback', async () => {
  const messages = host.session.messages
  const sessionModel = host.session.model
  const transcript = [{ role: 'user', content: 'retain the original fixture transcript' }]
  const beforeTranscript = JSON.stringify(transcript)
  host.session.model = async () => 'codex/gpt-6.1-sol'
  host.session.messages = async () => { throw new Error('Compaction must not read history') }
  try {
    for (const contextWindow of [null, 32000]) {
      const model = discoveredModel('codex/gpt-6.1-sol')
      model.metadata = { ...unknownMetadata(), contextWindow }
      discoveryOverride = { models: [model], providers: [{ provider: 'codex', status: 'fresh', source: 'fixture bounds', observedAt }] }
      await reload({})
      const beforeWires = wires.length
      let nativeCalls = 0
      for (const trigger of ['manual', 'auto', 'precompute', 'plugin']) {
        const result = await hook('session.compact')(host, { trigger, instructions: 'retain constraints', messages: transcript }, async () => { nativeCalls++; return { skip: 'unsafe native fallback' } })
        expect(result.skip).toContain('native routed compaction is unavailable')
        expect(result.skip).toContain('original transcript retained')
        expect(result.messages).toBeUndefined()
      }
      expect(wires.length).toBe(beforeWires)
      expect(nativeCalls).toBe(0)
      expect(JSON.stringify(transcript)).toBe(beforeTranscript)
    }
  } finally {
    host.session.model = sessionModel
    host.session.messages = messages
    discoveryOverride = undefined
    await reload({})
  }
})

test('native Claude compaction passes the original request and result through', async () => {
  const sessionModel = host.session.model
  host.session.model = async () => 'sonnet'
  try {
    const input = { trigger: 'manual', instructions: 'native instructions', messages: [{ role: 'user', text: 'native history' }] }
    const native = { messages: [{ role: 'user', text: 'native summary', toolUses: [] }] }
    let calls = 0
    const result = await hook('session.compact')(host, input, async (received: unknown) => { calls++; expect(received).toBe(input); return native })
    expect(result).toBe(native)
    expect(calls).toBe(1)
  } finally { host.session.model = sessionModel }
})

test('subagent compaction fails closed for unknown models and follows the last native or routed turn', async () => {
  const beforeWires = wires.length
  const unknownId = `unobserved-agent-${agents.length}`
  agents.push({ id: unknownId, type: 'general-purpose', description: 'unobserved after reload' })
  let nativeCalls = 0
  const native = { messages: [{ role: 'user', text: 'native summary', toolUses: [] }] }
  const next = async () => { nativeCalls++; return native }
  const unknown = await hook('session.compact')(host, { agentId: unknownId, trigger: 'auto', messages: [] }, next)
  expect(unknown.skip).toContain('active model is unknown')
  expect(nativeCalls).toBe(0)
  expect(wires.length).toBe(beforeWires)
  const routed = await step('general-purpose', 'codex/gpt-6.1-sol')
  const input = { agentId: routed.id, trigger: 'auto', messages: [] }
  const refused = await hook('session.compact')(host, input, next)
  expect(refused.skip).toContain('native routed compaction is unavailable')
  const generator = hook('turn.step')(host, { agentId: routed.id, model: 'sonnet', turnId: 'native-turn', index: 0 }, async function* () { return { native: true } })
  const result = await generator.next()
  expect(result.value).toEqual({ native: true })
  expect(result.done).toBe(true)
  expect(await hook('session.compact')(host, input, next)).toBe(native)
  expect(nativeCalls).toBe(1)
})

test('tagged built-in route switches use the exact inference target bounds', async () => {
  try {
    const model = discoveredModel('codex/small')
    model.metadata = { ...unknownMetadata(), contextWindow: 32000, maxContextWindow: 872000 }
    discoveryOverride = { models: [model], providers: [{ provider: 'codex', status: 'fresh', source: 'fixture tagged bound', observedAt }] }
    await reload({})
    let calls = 0
    const next = async () => { calls++; return { permissionDecision: 'allow' } }
    const denied = await hook('classic.PreModelSwitch')(host, switchInput(`${model.model}[1m]`, 32001), next)
    expect(denied.permissionDecision).toBe('deny')
    expect(denied.permissionDecisionReason).toContain('32000 token')
    expect(calls).toBe(0)
    expect((await hook('classic.PreModelSwitch')(host, switchInput(`${model.model}[1m]`, 32000), next)).permissionDecision).toBe('allow')
    expect(calls).toBe(1)
  } finally { discoveryOverride = undefined; await reload({}) }
})

const switchInput = (to_model: string, context_tokens: number, from_model = 'codex/gpt-6.1-sol') => ({
  from_model, to_model, requested_model: to_model, source: 'sdk', context_tokens,
  prompt_cache_warm: false, cache_ttl: '1h', estimated_cache_write_usd: 0, pricing: 'default',
})

test('model switch denies context exceeding fresh exact destination bounds without compaction or mutation', async () => {
  const sessionModel = host.session.model
  const beforeEnvironment = new Map(environment)
  host.session.model = async () => 'codex/gpt-6.1-sol'
  try {
    for (const metadata of [
      { contextWindow: 32000, maxContextWindow: 872000 },
      { inputTokenLimit: 16000 },
      { contextWindow: 32000, inputTokenLimit: 16000 },
      { maxContextWindow: 64000 },
    ]) {
      const model = discoveredModel('codex/small')
      model.metadata = { ...unknownMetadata(), ...metadata }
      discoveryOverride = { models: [model], providers: [{ provider: 'codex', status: 'fresh', source: 'fixture switch bounds', observedAt }] }
      await reload({})
      const bound = Math.min(model.metadata.inputTokenLimit ?? Infinity, model.metadata.contextWindow ?? model.metadata.maxContextWindow ?? Infinity)
      const beforeWires = wires.length
      const beforeState = JSON.stringify([...sessionState])
      const beforeEnv = JSON.stringify([...environment])
      let nativeCalls = 0
      const next = async () => { nativeCalls++; return { permissionDecision: 'allow' } }
      const denied = await hook('classic.PreModelSwitch')(host, switchInput(model.model, bound + 1), next)
      expect(denied.permissionDecision).toBe('deny')
      expect(denied.permissionDecisionReason).toContain(`${bound} token`)
      expect(denied.permissionDecisionReason).toContain('native routed compaction is unavailable')
      expect(nativeCalls).toBe(0)
      const allowed = await hook('classic.PreModelSwitch')(host, switchInput(model.model, bound), next)
      expect(allowed.permissionDecision).toBe('allow')
      expect(nativeCalls).toBe(1)
      const unchanged = await hook('classic.PreModelSwitch')(host, switchInput(model.model, bound + 1, model.model), next)
      expect(unchanged.permissionDecision).toBe('allow')
      expect(nativeCalls).toBe(2)
      expect(wires.length).toBe(beforeWires)
      expect(JSON.stringify([...sessionState])).toBe(beforeState)
      expect(JSON.stringify([...environment])).toBe(beforeEnv)
      expect(await host.session.model()).toBe('codex/gpt-6.1-sol')
    }
  } finally {
    host.session.model = sessionModel
    discoveryOverride = undefined
    await reload({})
    environment.clear(); for (const [key, value] of beforeEnvironment) environment.set(key, value)
  }
})

test('switch guard does not invent bounds for unknown, stale, worker or native Claude destinations', async () => {
  try {
    for (const [execution, status, metadata] of [
      ['native provider', 'fresh', {}],
      ['native provider', 'unavailable', { contextWindow: 32000 }],
      ['CLI worker', 'fresh', { contextWindow: 32000 }],
    ] as const) {
      const model = discoveredModel('codex/unknown', 'fixture', execution)
      model.metadata = { ...unknownMetadata(), ...metadata }
      discoveryOverride = { models: [model], providers: [{ provider: 'codex', status, source: 'fixture unknown switch bounds', observedAt }] }
      await reload({})
      for (const destination of [model.model, 'codex/missing', 'sonnet']) {
        const input = switchInput(destination, 900000)
        const native = { permissionDecision: 'ask' }
        const result = await hook('classic.PreModelSwitch')(host, input, async (received: unknown) => { expect(received).toBe(input); return native })
        expect(result).toBe(native)
      }
    }
  } finally { discoveryOverride = undefined; await reload({}) }
})

test('switch guard resolves aliases and fails closed if its hook fails', async () => {
  try {
    const model = discoveredModel('fixture/small')
    model.metadata = { ...unknownMetadata(), contextWindow: 32000 }
    discoveryOverride = { models: [model], providers: [{ provider: 'fixture', status: 'fresh', source: 'fixture alias bound', observedAt }] }
    await reload({ fixture: provider('small') }, { small: model.model })
    const denied = await hook('classic.PreModelSwitch')(host, switchInput('small', 32001), async () => { throw new Error('Unsafe switch reached native hook') })
    expect(denied.permissionDecision).toBe('deny')
    expect(denied.permissionDecisionReason).toContain('32000 token')
    const failed = await hook('classic.PreModelSwitch')(host, switchInput('codex/missing', 0), async () => { throw new Error('fixture downstream failure') })
    expect(failed.permissionDecision).toBe('deny')
    expect(failed.permissionDecisionReason).toContain('context check failed')
  } finally { discoveryOverride = undefined; await reload({}) }
})

test('actual prompt hook is idempotent and discovery tool schemas survive native provider dispatch', async () => {
  const compose = hook('prompt.compose')
  const runs = processRunCount
  const base = { sections: [{ id: 'a', scope: 'shared', text: 'a' }] }
  const first = await compose(host, {}, async () => base)
  const second = await compose(host, {}, async () => first)
  expect(second).toEqual(first)
  expect(first.sections.at(-1)).toMatchObject({ id: 'rice-multi-models:discovery', scope: 'session' })
  expect(processRunCount).toBe(runs)
  expect([...toolDefs.keys()]).toEqual(modelRefs)
  for (const spec of toolDefs.values()) { expect(spec.isDeferred).toBe(true); expect(spec.inputSchema.additionalProperties).toBe(false) }
  await reload({})
  const type = typeOf(await registerType('codex/gpt-6.1-sol'))
  approvalAnswer = 'Allow'
  for (const name of modelRefs) {
    const spec = toolDefs.get(name)
    await hook('tool.describe')(host, { tool: name, description: spec.description, provider: { plugin: 'rice-multi-models', tier: 'user' }, isDeferred: true }, async () => ({ description: spec.description, isDeferred: true }))
  }
  await step(type, 'codex/gpt-6.1-sol')
  const offered = offeredTools(wires.at(-1).req)
  for (const name of modelRefs) expect(offered.find((entry: any) => entry.name === name)?.schema).toEqual(toolDefs.get(name).inputSchema)
})

test('configured codex, agy and grok prefixes resolve before built-in helper branches', async () => {
  for (const [providerId, model] of [['codex', 'gpt-6.1-sol'], ['agy', 'review-model'], ['grok', 'review-model']]) {
    await reload({ [providerId!]: provider(model!) })
    const report = JSON.parse(await tool(modelRefs[0]!, { action: 'models' }))
    const candidate = report.models.find((item: any) => item.model === `${providerId}/${model}`)
    expect(candidate.execution).toBe('native provider')
    const type = typeOf(await registerType(`${providerId}/${model}`))
    expect(defs.get(type).description).toContain('native subagent')
    approvalAnswer = 'Allow'
    const accepted = await step(type, `${providerId}/${model}`)
    expect(accepted.nextCalls).toBe(0)
    const wire = wires.at(-1)
    expect(await executeHelper(wire)).toEqual([{ type: 'text', text: `fixture: configured ${providerId}/${model}` }])
    expect(helperBranches.at(-1)).toBe(`configured:${providerId}/${model}`)
  }
})

test('dynamic route bindings reject removal or retarget and register a new reusable type', async () => {
  await reload({ codex: provider('gpt-6.1-sol') })
  const oldType = typeOf(await registerType('codex/gpt-6.1-sol', 'read'))
  const sameType = typeOf(await registerType('codex/gpt-6.1-sol', 'read'))
  expect(sameType).toBe(oldType)
  await reload({})
  const beforeRemoved = wires.length
  const removed = await step(oldType, 'codex/gpt-6.1-sol')
  expect(removed.nextCalls).toBe(0)
  expect(wires.length).toBe(beforeRemoved)
  expect(JSON.stringify(removed.result)).toContain('no longer current')

  await reload({ local: provider('qwen', 'https://first.fixture.invalid/v1') })
  const first = typeOf(await registerType('local/qwen', 'write'))
  await reload({ local: provider('qwen', 'https://second.fixture.invalid/v1') })
  const secondRegistration = await registerType('local/qwen', 'write')
  const second = typeOf(secondRegistration)
  expect(second).not.toBe(first)
  expect(secondRegistration).not.toContain('fixture.invalid')
  const beforeRetarget = wires.length
  const retargeted = await step(first, 'local/qwen')
  expect(retargeted.nextCalls).toBe(0)
  expect(wires.length).toBe(beforeRetarget)
})

test('registration does not approve providers or start workers and provider denial stays before helper', async () => {
  store.clear()
  await reload({ local: provider('qwen') })
  approvalAnswer = 'Keep it off'
  const asks = approvalAskCount
  const before = wires.length
  const refreshes = discoveries.length
  const type = typeOf(await registerType('local/qwen'))
  expect(approvalAskCount).toBe(asks)
  expect(store.size).toBe(0)
  expect(wires.length).toBe(before)
  expect(discoveries.length).toBe(refreshes)
  const refused = await step(type, 'local/qwen')
  expect(approvalAskCount).toBeGreaterThan(0)
  expect(wires.length).toBe(before)
  expect(JSON.stringify(refused.result)).toContain('not approved')
})

test('configured Codex-prefix providers report explicit configured source', async () => {
  await reload({ codex: provider('gpt-6.1-sol') })
  const report = JSON.parse(await tool(modelRefs[0]!, { action: 'models' }))
  const entry = report.models.find((item: any) => item.model === 'codex/gpt-6.1-sol')
  expect(entry).toMatchObject({ source: 'configured provider', execution: 'native provider' })
})

test('configured Codex-prefix providers do not inherit subscription quota', async () => {
  store.clear()
  await reload({})
  const type = typeOf(await registerType('codex/gpt-6.1-sol'))
  approvalAnswer = 'Allow'
  emitLimits = true
  await step(type, 'codex/gpt-6.1-sol')
  emitLimits = false
  await reload({ codex: provider('gpt-6.1-sol') })
  const report = JSON.parse(await tool(modelRefs[0]!, { action: 'models' }))
  const entry = report.models.find((item: any) => item.model === 'codex/gpt-6.1-sol')
  expect(report.codexLimits).toMatchObject({ status: 'reported', plan: 'fixture-subscription' })
  expect(entry.usageLimits).toEqual({ status: 'unavailable', windows: [] })
})

test('dynamic configured turns do not rediscover the installed worker catalogue', async () => {
  agyInstalled = true
  store.clear()
  await hook('command.run', 'rice-models')(host, { args: 'setup repair' })
  await reload({ local: provider('qwen') })
  const type = typeOf(await registerType('local/qwen'))
  const beforeTurn = discoveries.length
  const beforeWires = wires.length
  approvalAnswer = 'Keep it off'
  const refused = await step(type, 'local/qwen')
  expect(discoveries.length).toBe(beforeTurn)
  expect(processCalls.some(argv => argv[0] === '/fixture/agy')).toBe(false)
  expect(wires.length).toBe(beforeWires)
  expect(JSON.stringify(refused.result)).toContain('not approved')
})

test('retargeted dynamic route skips subagent compaction before provider work', async () => {
  store.clear()
  const first = provider('qwen')
  await reload({ local: first })
  const type = typeOf(await registerType('local/qwen'))
  approvalAnswer = 'Allow'
  const accepted = await step(type, 'local/qwen')
  const beforeWires = wires.length
  const beforeApprovals = approvalAskCount
  const second = { ...first, baseUrl: 'https://retarget.fixture.invalid/v1' }
  await reload({ local: second })
  const compacted = await hook('session.compact')(host, { agentId: accepted.id, trigger: 'auto', instructions: '', messages: [] }, async () => ({ skip: 'fixture fallback' }))
  expect(wires.length).toBe(beforeWires)
  expect(approvalAskCount).toBe(beforeApprovals)
  expect(compacted.skip).toContain('no longer current')
})

test('model-callable status returns safe structured diagnostics only', async () => {
  await reload({})
  const directory = `${root}/.claude/agents`
  const name = 'diagnostic-source-review'
  const endpoint = 'https://private-endpoint.fixture.invalid/v1'
  fixtureDirs.set(directory, [{ name: `${name}.md`, kind: 'file' }])
  fixtureFiles.set(`${directory}/${name}.md`, `---\nname: ${name}\ndescription: &endpoint ${endpoint}\nmodel: codex/gpt-6.1-sol\n---\nReview source only.\n`)
  await step(name, 'codex/gpt-6.1-sol')
  const status = await tool(modelRefs[0]!, { action: 'status' })
  expect(status).not.toContain(endpoint)
  expect(status).toContain('"count": 1')
  expect(status).toContain('agent/configuration diagnostics')
})
