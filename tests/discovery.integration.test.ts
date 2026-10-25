import { beforeAll, expect, mock, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { unknownMetadata, type ModelCatalogue } from '../hooks/catalogue'
import { deriveTemplate, INSTRUCTIONS_MARK, SUMMARY_MARK } from '../hooks/native-compaction'
import { markDescription } from '../hooks/agent-model'
import { BODY_MARK, deriveCapture, MARKER_AGENT } from '../hooks/native-tools'

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '')
const helperBranches: string[] = []
mock.module('claude-code', () => ({
  atom: (ref: { key: string }, value: unknown) => ({ ref, value }),
  read: async (host: any, atom: any) => host.__atoms.get(atom.ref.key) ?? atom.value,
  update: async (host: any, atom: any, change: (value: unknown) => unknown) => { host.__atoms.set(atom.ref.key, change(host.__atoms.get(atom.ref.key) ?? atom.value)) },
}))
mock.module(`${root}/helper/codex.ts`, () => ({ codexStep: async function* (_req: unknown, model: string) { helperBranches.push(`codex:${model}`); yield { type: 'text', text: `fixture: codex ${model}` } } }))
mock.module(`${root}/helper/styx/step.ts`, () => ({ createStepper: () => ({ step: async function* (wire: any) { helperBranches.push(`configured:${wire.req.target}`); yield { type: 'text', text: `fixture: configured ${wire.req.target}` } } }) }))
const { register } = await import(`${root}/hooks/register.ts`)
const { runStep, offeredTools } = await import(`${root}/helper/run.ts`)

type Hook = { matcher?: Record<string, unknown>; callback: (...args: any[]) => any }
const hooks = new Map<string, Hook[]>()
const catches = new Map<string, (...args: any[]) => any>()
const on: any = (event: string, matcherOrCallback: any, callback?: any) => {
  const hook = callback ? { matcher: matcherOrCallback, callback } : { callback: matcherOrCallback }
  hooks.set(event, [...(hooks.get(event) ?? []), hook])
  return { catch: (failed: (...args: any[]) => any) => {
    catches.set(event, failed)
    const callback = hook.callback
    // Like the host: a failed hook's catch receives next with called and error.
    const failure = (next: any, error: unknown) => Object.assign(typeof next === 'function' ? next : () => undefined, { called: false, error: { kind: 'error', message: error instanceof Error ? error.message : String(error) } })
    hook.callback = callback.constructor?.name === 'AsyncGeneratorFunction'
      ? async function* (...args: any[]) { try { return yield* callback(...args) } catch (error) { return yield* failed(args[0], args[1], failure(args[2], error)) } }
      : async (...args: any[]) => { try { const next = args[2]; if (next && !next.signal) next.signal = new AbortController().signal; return await callback(...args) } catch (error) { return failed(args[0], args[1], failure(args[2], error)) } }
  } }
}
register(on)
let compactRows: readonly any[] | undefined
const hook = (event: string, name?: string) => {
  // This fixture targets the unfiltered routing callback. Other modules can
  // register an earlier, filtered callback for the same native event.
  const found = hooks.get(event)?.find(item => name === undefined ? item.matcher === undefined : item.matcher?.tool === name || item.matcher?.command === name)
  if (!found) throw new Error(`Missing hook ${event} ${name ?? ''}`)
  if (event !== 'session.compact') return found.callback
  return async (...args: any[]) => {
    const previous = compactRows
    compactRows = args[1].messages
    try { return await found.callback(...args) } finally { compactRows = previous }
  }
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
const discoveredModel = (model: string, source = 'Codex authenticated models endpoint'): ModelCatalogue['models'][number] => ({ model, label: `Fixture ${model}`, execution: 'native provider', source, observedAt, metadata: unknownMetadata() })
const freshCatalogue = (configText: string): ModelCatalogue => {
  const providers = JSON.parse(configText || '{"providers":{}}').providers ?? {}
  const models = Object.keys(providers).includes('codex') ? [] : [discoveredModel('codex/gpt-6.1-sol')]
  for (const [id, declared] of Object.entries(providers)) {
    for (const model of Object.keys((declared as any).models ?? {})) models.push(discoveredModel(`${id}/${model}`, 'configured provider'))
  }
  return { models, providers: [...new Set(models.map(entry => entry.model.split('/')[0]!))].map(provider => ({ provider, status: 'fresh', source: 'fixture discovery boundary', observedAt })) }
}
let approvalAskCount = 0
let emitLimits = false
let completionStop = 'end_turn'
// The engine's compaction text as the helper would capture it, stood in for by an owned fixture of the same structure.
const FIXTURE_PLAIN = 'FIXTURE SUMMARY PROMPT <analysis> <summary>\n\nREMINDER: text only.'
const fixtureTemplate = deriveTemplate({
  version: '2.1.296', plain: FIXTURE_PLAIN, custom: FIXTURE_PLAIN.replace('\n\nREMINDER', `\n\nAdditional Instructions:\n${INSTRUCTIONS_MARK}\n\nREMINDER`),
  summaryMessage: `FIXTURE CONTINUED SESSION\n\nSummary:\n${SUMMARY_MARK}\n\nRead the full transcript at: /fixture/transcript.jsonl\nResume directly.`, transcriptPath: '/fixture/transcript.jsonl',
})
let captureFails = false
// The engine's tool definitions and agent prompts as the helper would capture them, stood in for by owned fixtures
// of the same structure: an identity preamble block, then the agent's own prompt between a head and a tail.
const FIXTURE_TAIL = '\n\nFIXTURE SUBAGENT NOTES'
const requestOf = (tools: string[], prompt: string) => ({
  system: [{ type: 'text', text: 'FIXTURE IDENTITY PREAMBLE' }, { type: 'text', text: prompt }],
  tools: tools.map(name => ({ name, description: `FIXTURE ${name} DEFINITION IN FULL`, input_schema: { type: 'object', properties: { [`fixture_${name.toLowerCase()}`]: { type: 'string' } }, additionalProperties: false } })),
})
const spawnedAs = (type: string, prompt: string, tools: string[]) => [false, true].map(background => ({ type, background, body: requestOf(tools, prompt + FIXTURE_TAIL) }))
const fixtureTools = deriveCapture({
  version: '2.1.296',
  listed: ['general-purpose', 'Explore'],
  main: requestOf(['Agent', 'Bash', 'Read'], 'FIXTURE MAIN PROMPT'),
  spawned: [...spawnedAs(MARKER_AGENT, BODY_MARK, ['Bash', 'Read']), ...spawnedAs('general-purpose', 'FIXTURE GENERAL PURPOSE PROMPT', ['Bash', 'Read']), ...spawnedAs('Explore', 'FIXTURE EXPLORE PROMPT', ['Read'])],
})
let toolCaptureFails = false
let toolCaptureRuns = 0
let completionText = 'fixture response'
let captures = 0
const reportedLimits = { plan: 'fixture-subscription', windows: [{ label: 'weekly', usedPercent: 97, resetsAt: 1_800_000_100_000 }] }
const diagnostics: string[] = []
const environment = new Map<string, string>([['HOME', '/fixture-home']])
const sessionState = new Map<string, unknown>()
const host: any = {
  __atoms: sessionState,
  env: { get: async (key: string) => environment.get(key), set: async (key: string, value: string | undefined) => { if (value === undefined) environment.delete(key); else environment.set(key, value) } },
  state: { get: async (ref: { key: string }) => ({ value: sessionState.get(ref.key), version: 0 }), set: async (ref: { key: string }, value: unknown) => { sessionState.set(ref.key, value); return { isSet: true, version: 1 } } },
  plugin: { root },
  settings: { read: async () => ({}) },
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
      if (argv[2] === 'capture-compaction') {
        captures++
        return captureFails ? { exitCode: 1, stdout: JSON.stringify({ ok: false, error: 'fixture capture failure' }), stderr: '' } : { exitCode: 0, stdout: JSON.stringify({ ok: true, template: fixtureTemplate }), stderr: '' }
      }
      if (argv[2] === 'capture-tools') {
        toolCaptureRuns++
        return toolCaptureFails ? { exitCode: 1, stdout: JSON.stringify({ ok: false, error: 'fixture tool capture failure' }), stderr: '' } : { exitCode: 0, stdout: JSON.stringify({ ok: true, capture: fixtureTools }), stderr: '' }
      }
      if (argv[0] === 'node') return { exitCode: 0, stdout: JSON.stringify({ executable: '/fixture/node', version: '22.20.0' }), stderr: '' }
      if (argv[2] === 'doctor') return { exitCode: 0, stdout: JSON.stringify({ node: { executable: '/fixture/node', version: '22.20.0', supported: true }, platform: 'linux', home: '/fixture-home', configDir: '/fixture-home/.claude', codexHome: '/fixture-home/.codex', opencodeAuthFile: '/fixture-home/opencode-auth.json', auth: { codex: false, opencode: false }, clis: {} }), stderr: '' }
      if (argv[2] === 'sync-picker') return { exitCode: 0, stdout: JSON.stringify({ ok: true, changed: false, count: 1, path: '/fixture-home/.claude/settings.json' }), stderr: '' }
      return { exitCode: 1, stdout: '', stderr: '' }
    },
    spawn: async function* (options: any) {
      if (!options.input) throw new Error('Fixture forbids helper startup')
      wires.push(JSON.parse(options.input))
      if (emitLimits) yield { stream: 'stdout', text: JSON.stringify({ type: 'limits', limits: reportedLimits }) + '\n' }
      yield { stream: 'stdout', text: JSON.stringify({ type: 'text', text: completionText }) + '\n' + JSON.stringify({ type: 'stop', reason: completionStop }) + '\n' }
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
    log: (text: string, options: any) => { if (options?.to === 'transcript') diagnostics.push(text) }, status: () => {}, toast: () => {},
  },
  clock: { now: async () => 1_800_000_000_000, sleep: async () => {} },
  session: {
    id: async () => 'fixture-session', cwd: async () => root,
    model: async () => 'codex/gpt-6.1-sol',
    usage: async () => ({ context: { window: Number(environment.get('CLAUDE_CODE_MAX_CONTEXT_TOKENS') ?? 200000) } }),
    version: async () => ({ version: '2.1.296' }),
    messages: async (args: any = {}) => args.as === 'api' ? [{ role: 'user', content: 'fixture conversation' }] : (compactRows ?? []).map(({ handle, ...row }) => row),
    append: async ({ message }: any) => { expect(message.type).toBe('system'); return { message, uuid: 'owned-receipt' } },
  },
  prompt: { compose: async () => ({ sections: [{ id: 'base', scope: 'shared', text: 'fixture base' }] }) },
}
const command = async (args: string) => (await hook('command.run', 'rice-models')(host, { args })).text as string
const models = async () => JSON.parse((await command('models')).split('\n\nUse a discovered candidate')[0]!)
const spawnInput = (parentModel: string, subagentType: string, model?: string, parentAgentId?: string) => ({ tool_use_id: `toolu_spawn_${agents.length}`, prompt: 'Owned spawn fixture', description: 'owned spawn', subagentType, provider: { plugin: 'engine', tier: 'core' }, parentModel, fork: false, background: false, ...(model ? { model } : {}), ...(parentAgentId ? { parentAgentId } : {}) })
const spawn = async (parentModel: string, subagentType: string, model?: string, parentAgentId?: string) => {
  let received: any
  const id = `spawned-agent-${agents.length}`
  const result = await hook('agent.spawn')(host, spawnInput(parentModel, subagentType, model, parentAgentId), async (e: any) => { received = e; agents.push({ id, type: e.subagentType, description: e.description, status: 'running' }); return { model: e.model ?? 'native-resolved', agentId: id } })
  return { received, result, id }
}
const reload = async (providers: Record<string, unknown>, aliases: Record<string, unknown> = {}) => {
  config = JSON.stringify({ providers, aliases })
  return hook('command.run', 'rice-models')(host, { args: 'reload' })
}
const provider = (model: string, baseUrl = 'https://fixture.invalid/v1') => ({ kind: 'openai', baseUrl, auth: 'none', models: { [model]: { contextWindow: 128000, maxOutputTokens: 4096 } } })
const step = async (type: string, model: string) => {
  const id = `fixture-agent-${agents.length}`
  const agent = { id, type, description: 'offline review control', status: 'running' }
  agents.push(agent)
  // Establish the native dispatch receipt before testing its subsequent loop request.
  await hook('agent.spawn')(host, { ...spawnInput(await host.session.model(), type, model), background: false }, async (event: any) => ({ model: event.model ?? model, agentId: id }))
  let nextCalls = 0
  const diagnosticStart = diagnostics.length
  const generator = hook('turn.step')(host, { agentId: id, model, turnId: 'fixture-turn', index: 0 }, async function* () {
    nextCalls++
    return { passthrough: true }
  })
  let item = await generator.next()
  const chunks: any[] = []
  while (!item.done) { chunks.push(item.value); item = await generator.next() }
  agent.status = 'completed'
  return { result: item.value, chunks, nextCalls, id, diagnostics: diagnostics.slice(diagnosticStart) }
}
const executeHelper = async (wire: any) => {
  const result = []
  for await (const event of runStep(wire, new AbortController().signal)) result.push(event)
  return result
}
beforeAll(async () => { await hook('session.start')(host, {}, async () => ({})) })

test('startup discovers once and models and status read that snapshot without another discovery', async () => {
  expect(discoveries).toEqual([{ argv: ['/fixture/node', `${root}/dist/helper.mjs`, 'discover'], input: { configText: JSON.stringify({ providers: {} }), approved: [] } }])
  expect(await command('models')).toContain('codex/gpt-6.1-sol')
  expect(await command('status')).toContain('Codex session candidate: codex/gpt-6.1-sol')
  expect(discoveries.length).toBe(1)
  const report = await models()
  expect(report.models[0]).toMatchObject({ metadata: unknownMetadata(), availability: 'candidate, not live-entitlement proof' })
})

test('explicit refresh replaces discovered IDs and metadata and forwards declared config and approvals', async () => {
  store.clear()
  await reload({})
  const before = await models()
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
    const report = await models()
    expect(report.models.map((entry: any) => entry.model)).toEqual(['codex/gpt-6.1-sol', 'codex/fresh-new-model'])
    expect(report.models[0]).toMatchObject({ metadata: { contextWindow: 64000, inputTokenLimit: null, outputTokenLimit: 2048, tools: null }, metadataSources: { contextWindow: 'fixture endpoint limit', outputTokenLimit: 'fixture endpoint limit' } })
    expect(report.models[1].metadata).toEqual(unknownMetadata())
    await command('status')
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
      await command('refresh')
      const report = await models()
      expect(report.models).toEqual([])
      expect(report.discovery[0].status).toBe('unavailable')
      expect(await command('status')).toContain('Codex session candidate: none discovered')
      const compose = await hook('prompt.compose')(host, {}, async () => ({ sections: [] }))
      expect(compose.sections).toEqual([])
    }
  } finally {
    discoveryUnavailable = false
    discoveryOverride = undefined
    await reload({})
  }
})

test('subagents and aliases of a routed parent stay in its family', async () => {
  await reload({})
  const explore = await spawn('codex/gpt-6.1-sol', 'Explore', 'haiku')
  expect(explore.received.model).toBe('codex/gpt-6.1-sol')
  const plain = await spawn('codex/gpt-6.1-sol', 'general-purpose')
  expect(plain.received.model).toBe('codex/gpt-6.1-sol')
  // The engine reports a remapped child's own alias as the parent model; its
  // effective family decides its children.
  for await (const _chunk of hook('turn.step')(host, { agentId: explore.id, model: 'haiku', turnId: 'explore-parent', index: 0 }, async function* () { throw new Error('unsafe native step') })) { /* drain */ }
  const grandchild = await spawn('haiku', 'general-purpose', undefined, explore.id)
  expect(grandchild.received.model).toBe('codex/gpt-6.1-sol')
  const fork = await hook('agent.spawn')(host, { ...spawnInput('codex/gpt-6.1-sol', 'fork', 'haiku'), fork: true }, async (e: any) => ({ model: e.model, agentId: 'fork-agent' }))
  expect(fork.model).toBe('haiku')
})

test('fresh input and context metadata never pre-abort native routed turns', async () => {
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
      const beforeWires = wires.length
      const refreshes = discoveries.length
      const accepted = await step('general-purpose', model.model)
      expect(accepted.nextCalls).toBe(0)
      expect(accepted.diagnostics.join('\n')).not.toContain('token input bound')
      expect(wires.length).toBe(beforeWires + 1)
      expect(wires.at(-1).req.target).toBe(model.model)
      expect(JSON.stringify(wires.at(-1).req.transcript)).toContain('oversized fixture transcript')
      expect(discoveries.length).toBe(refreshes)
    }
  } finally {
    host.session.messages = messages
    discoveryOverride = undefined
    await reload({})
  }
})

test('refreshing smaller metadata does not install a child request guard', async () => {
  const messages = host.session.messages
  host.session.messages = async () => [{ role: 'user', content: 'same request '.repeat(500) }]
  const model = discoveredModel('codex/gpt-6.1-sol')
  model.metadata = { ...unknownMetadata(), contextWindow: 32000 }
  discoveryOverride = { models: [model], providers: [{ provider: 'codex', status: 'fresh', source: 'fixture input bounds', observedAt }] }
  try {
    await reload({})
    const before = wires.length
    const accepted = await step('general-purpose', model.model)
    expect(accepted.nextCalls).toBe(0)
    expect(wires.length).toBe(before + 1)
    expect(JSON.stringify(accepted.result)).toContain('fixture response')
    model.metadata = { ...unknownMetadata(), contextWindow: 32000, inputTokenLimit: 512 }
    await hook('command.run', 'rice-models')(host, { args: 'refresh' })
    const refreshed = await step('general-purpose', model.model)
    expect(refreshed.nextCalls).toBe(0)
    expect(refreshed.diagnostics.join('\n')).not.toContain('token input bound')
    expect(wires.length).toBe(before + 2)
    expect((await models()).models[0].metadata.inputTokenLimit).toBe(512)
  } finally {
    host.session.messages = messages
    discoveryOverride = undefined
    await reload({})
  }
})

test('large explicit completions dispatch once without a plugin input guard or native fallback', async () => {
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
      expect(result.value).toMatchObject(event === 'model.fork' ? { isAnswered: false, reason: 'nothing-to-fork' } : { isAnswered: true, text: 'fixture response' })
      expect(wires.length).toBe(beforeWires + 1)
      expect(wires.at(-1).req.target).toBe(model.model)
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

test('compaction is refused, visibly and with the transcript kept, when the engine\'s own text cannot be read', async () => {
  const sessionModel = host.session.model
  host.session.model = async () => 'codex/gpt-6.1-sol'
  // First in the file on purpose: the template is kept in memory for the session once it has been read.
  const transcript = [{ role: 'user', text: 'Approval still pending', toolUses: [], handle: 'original' }]
  let nativeCalls = 0
  const before = wires.length
  try {
    captureFails = true
    const refused = await hook('session.compact')(host, { trigger: 'auto', messages: transcript }, async (input: any) => { nativeCalls++; expect(input.messages.length).toBeLessThanOrEqual(1); return {} })
    expect(refused.messages).toBeUndefined()
    expect(refused.skip).toContain('fixture capture failure')
    expect(refused.skip).toContain('original transcript retained')
    expect(wires.length).toBe(before)
    expect(nativeCalls).toBe(1)
    // A failed capture is retried at the next compaction, then kept per Claude Code version.
    captureFails = false
    const used = captures
    const first = await hook('session.compact')(host, { trigger: 'auto', messages: transcript }, async (input: any) => { nativeCalls++; expect(input.messages.length).toBeLessThanOrEqual(1); return {} })
    expect(first.messages[0].text).toContain('FIXTURE CONTINUED SESSION')
    expect(captures).toBe(used + 1)
    expect(store.get('native-compaction:2.1.296')).toEqual(fixtureTemplate)
    await hook('session.compact')(host, { trigger: 'auto', messages: transcript }, async (input: any) => { nativeCalls++; expect(input.messages.length).toBeLessThanOrEqual(1); return {} })
    expect(captures).toBe(used + 1)
    expect(nativeCalls).toBe(1)
  } finally { captureFails = false; host.session.model = sessionModel }
})

test('routed compaction uses its selected provider for every native trigger and returns only the summary message', async () => {
  const sessionModel = host.session.model
  host.session.model = async () => 'codex/gpt-6.1-sol'
  const transcript = [{ role: 'user', text: 'Original goal and constraints', toolUses: [], handle: 'old-user' }, { role: 'assistant', text: 'Verified pending work', toolUses: [], handle: 'old-assistant' }, { role: 'user', text: 'Continue now', toolUses: [], handle: 'recent-user' }]
  const snapshot = JSON.stringify(transcript)
  try {
    let nativeCalls = 0
    for (const trigger of ['manual', 'auto', 'precompute', 'plugin']) {
      const before = wires.length
      const result = await hook('session.compact')(host, { trigger, instructions: 'retain constraints', messages: transcript }, async () => { nativeCalls++; throw new Error('unsafe native fallback') })
      expect(result.messages[0].text).toContain('fixture response')
      expect(result.messages).toHaveLength(1)
      expect(wires.length).toBe(before + 1)
      expect(wires.at(-1).req).toMatchObject({ target: 'codex/gpt-6.1-sol', tools: [], who: 'main' })
      // The request is the conversation as the engine holds it, then the engine's own prompt with the instructions in its slot.
      const sent = JSON.stringify(wires.at(-1).req.transcript)
      expect(sent).toContain('fixture conversation')
      expect(sent).toContain('FIXTURE SUMMARY PROMPT')
      expect(sent).toContain('Additional Instructions:\\nretain constraints')
      expect(sent).not.toContain('old-user')
      expect(result.messages[0].text).toContain('FIXTURE CONTINUED SESSION')
    }
    expect(nativeCalls).toBe(0)
    expect(JSON.stringify(transcript)).toBe(snapshot)
  } finally { host.session.model = sessionModel }
})

test('the summary keeps only the summary block, in the engine\'s wording, and cites the transcript for the main conversation alone', async () => {
  const sessionModel = host.session.model
  host.session.model = async () => 'codex/gpt-6.1-sol'
  const transcript = [{ role: 'user', text: 'Goal', toolUses: [], handle: 'a' }, { role: 'assistant', text: 'Done', toolUses: [], handle: 'b' }, { role: 'user', text: 'Next', toolUses: [], handle: 'c' }]
  try {
    completionText = '<analysis>private reasoning</analysis>\n<summary>\n1. Primary Request: ship it\n</summary>'
    // Startup, resume and compaction name the transcript file to the classic SessionStart hook.
    await hook('classic.SessionStart')(host, { source: 'resume', transcript_path: '/fixture/session.jsonl' }, async () => ({}))
    const main = await hook('session.compact')(host, { trigger: 'manual', messages: transcript }, async () => ({}))
    expect(main.messages[0].text).toBe('FIXTURE CONTINUED SESSION\n\nSummary:\n1. Primary Request: ship it\n\nRead the full transcript at: /fixture/session.jsonl\nResume directly.')
    expect(main.messages[0].text).not.toContain('private reasoning')
    expect(main.messages).toHaveLength(1)
    const child = await step('general-purpose', 'codex/gpt-6.1-sol')
    const sub = await hook('session.compact')(host, { agentId: child.id, trigger: 'auto', messages: [{ role: 'user', text: 'Child task', toolUses: [] }] }, async () => ({}))
    expect(sub.messages[0].text).toBe('FIXTURE CONTINUED SESSION\n\nSummary:\n1. Primary Request: ship it\n\nResume directly.')
    completionText = '<analysis>only reasoning, no summary</analysis>'
    const empty = await hook('session.compact')(host, { trigger: 'manual', messages: transcript }, async () => ({}))
    expect(empty.messages).toBeUndefined()
    expect(empty.skip).toContain('returned no summary')
  } finally { completionText = 'fixture response'; host.session.model = sessionModel }
})

test('truncated or refused compaction never replaces history or falls back to Claude', async () => {
  const transcript = [{ role: 'user', text: 'Approval still pending', toolUses: [], handle: 'original' }]
  let nativeCalls = 0
  try {
    for (const reason of ['max_tokens', 'refusal', 'tool_use']) {
      completionStop = reason
      const result = await hook('session.compact')(host, { trigger: 'auto', messages: transcript }, async (input: any) => { nativeCalls++; expect(input.messages.length).toBeLessThanOrEqual(1); return {} })
      expect(result.messages).toBeUndefined()
      expect(result.skip).toContain('original transcript retained')
      expect(transcript[0].handle).toBe('original')
    }
    expect(nativeCalls).toBe(3)
  } finally { completionStop = 'end_turn' }
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

test('subagent compaction refuses an unobserved loop visibly in a routed conversation and follows the last native or routed turn', async () => {
  const beforeWires = wires.length
  const unknownId = `unobserved-agent-${agents.length}`
  agents.push({ id: unknownId, type: 'general-purpose', description: 'unobserved after reload' })
  let nativeCalls = 0
  const native = { messages: [{ role: 'user', text: 'native summary', toolUses: [] }] }
  const next = async () => { nativeCalls++; return native }
  const unknown = await hook('session.compact')(host, { agentId: unknownId, trigger: 'auto', messages: [] }, next)
  expect(unknown.skip).toContain('not observed in a routed conversation')
  expect(nativeCalls).toBe(0)
  expect(wires.length).toBe(beforeWires)
  const routed = await step('general-purpose', 'codex/gpt-6.1-sol')
  const input = { agentId: routed.id, trigger: 'auto', messages: [{ role: 'user', text: 'Child-only task', toolUses: [] }] }
  const compacted = await hook('session.compact')(host, input, next)
  expect(compacted.messages[0].text).toContain('fixture response')
  expect(wires.at(-1).req.who).toBe(routed.id)
})

test('tagged exact model switches retain native decisions rather than plugin bounds', async () => {
  try {
    const model = discoveredModel('codex/small')
    model.metadata = { ...unknownMetadata(), contextWindow: 32000, maxContextWindow: 872000 }
    discoveryOverride = { models: [model], providers: [{ provider: 'codex', status: 'fresh', source: 'fixture tagged bound', observedAt }] }
    await reload({})
    let calls = 0
    const next = async () => { calls++; return { permissionDecision: 'allow' } }
    const input = switchInput(`${model.model}[1m]`, 27905)
    const allowed = await hook('classic.PreModelSwitch')(host, input, async (received: unknown) => { expect(received).toBe(input); return next() })
    expect(allowed.permissionDecision).toBe('allow')
    expect(allowed.permissionDecisionReason).toBeUndefined()
    expect(calls).toBe(1)
    expect((await hook('classic.PreModelSwitch')(host, switchInput(`${model.model}[1m]`, 27904), next)).permissionDecision).toBe('allow')
    expect(calls).toBe(2)
  } finally { discoveryOverride = undefined; await reload({}) }
})

const switchInput = (to_model: string, context_tokens: number, from_model = 'codex/gpt-6.1-sol') => ({
  from_model, to_model, requested_model: to_model, source: 'sdk', context_tokens,
  prompt_cache_warm: false, cache_ttl: '1h', estimated_cache_write_usd: 0, pricing: 'default',
})

test('native model switch owns its context decision without plugin compaction or mutation', async () => {
  const sessionModel = host.session.model
  const beforeEnvironment = new Map(environment)
  host.session.model = async () => 'codex/gpt-6.1-sol'
  try {
    for (const [metadata, bound] of [
      [{ contextWindow: 32000, maxContextWindow: 872000 }, 27904],
      [{ inputTokenLimit: 16000 }, 8192],
      [{ contextWindow: 32000, inputTokenLimit: 16000 }, 13952],
    ] as const) {
      const model = discoveredModel('codex/small')
      model.metadata = { ...unknownMetadata(), ...metadata }
      discoveryOverride = { models: [model], providers: [{ provider: 'codex', status: 'fresh', source: 'fixture switch bounds', observedAt }] }
      await reload({})
      const beforeWires = wires.length
      const beforeState = JSON.stringify([...sessionState])
      const beforeEnv = JSON.stringify([...environment])
      let nativeCalls = 0
      const next = async () => { nativeCalls++; return { permissionDecision: 'allow' } }
      const native = await hook('classic.PreModelSwitch')(host, switchInput(model.model, bound + 1), next)
      expect(native.permissionDecision).toBe('allow')
      expect(native.permissionDecisionReason).toBeUndefined()
      expect(nativeCalls).toBe(1)
      const allowed = await hook('classic.PreModelSwitch')(host, switchInput(model.model, bound), next)
      expect(allowed.permissionDecision).toBe('allow')
      expect(nativeCalls).toBe(2)
      const unchanged = await hook('classic.PreModelSwitch')(host, switchInput(model.model, bound + 1, model.model), next)
      expect(unchanged.permissionDecision).toBe('allow')
      expect(nativeCalls).toBe(3)
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

test('native switch decisions are retained for unknown, stale and native Claude destinations', async () => {
  try {
    for (const [status, metadata] of [
      ['fresh', {}],
      ['fresh', { maxContextWindow: 64000 }],
      ['unavailable', { contextWindow: 32000 }],
    ] as const) {
      const model = discoveredModel('codex/unknown', 'fixture')
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

test('aliases keep native switch decisions and downstream failures are not rewritten by a plugin guard', async () => {
  try {
    const model = discoveredModel('fixture/small')
    model.metadata = { ...unknownMetadata(), contextWindow: 32000 }
    discoveryOverride = { models: [model], providers: [{ provider: 'fixture', status: 'fresh', source: 'fixture alias bound', observedAt }] }
    await reload({ fixture: provider('small') }, { small: model.model })
    const native = { permissionDecision: 'deny', permissionDecisionReason: 'Owned native decision' }
    expect(await hook('classic.PreModelSwitch')(host, switchInput('small', 32001), async () => native)).toBe(native)
    await expect(hook('classic.PreModelSwitch')(host, switchInput('codex/missing', 0), async () => { throw new Error('fixture downstream failure') })).rejects.toThrow('fixture downstream failure')
  } finally { discoveryOverride = undefined; await reload({}) }
})

test('the mod registers no tools and its family guidance is idempotent and native', async () => {
  const compose = hook('prompt.compose')
  const runs = processRunCount
  const base = { sections: [{ id: 'a', scope: 'shared', text: 'a' }] }
  const first = await compose(host, {}, async () => base)
  const second = await compose(host, {}, async () => first)
  expect(second).toEqual(first)
  const section = first.sections.at(-1)
  expect(section).toMatchObject({ id: 'rice-multi-models:discovery', scope: 'session' })
  expect(section.text).toContain('accepts every exact provider/model id')
  expect(section.text).not.toContain('mcp__')
  expect(processRunCount).toBe(runs)
  expect(toolDefs.size).toBe(0)
  await reload({})
  approvalAnswer = 'Allow'
  await step('general-purpose', 'codex/gpt-6.1-sol')
  const offered = offeredTools(wires.at(-1).req)
  expect(offered.some((entry: any) => entry.name.startsWith('mcp__rice-multi-models__'))).toBe(false)
})

test('configured provider ids resolve through the generic provider stepper', async () => {
  for (const [providerId, model] of [['codex', 'gpt-6.1-sol'], ['fixture', 'review-model'], ['local', 'review-model']]) {
    await reload({ [providerId!]: provider(model!) })
    const report = await models()
    const candidate = report.models.find((item: any) => item.model === `${providerId}/${model}`)
    expect(candidate.execution).toBe('native provider')
    approvalAnswer = 'Allow'
    const accepted = await step('general-purpose', `${providerId}/${model}`)
    expect(accepted.nextCalls).toBe(0)
    const wire = wires.at(-1)
    expect(await executeHelper(wire)).toEqual([{ type: 'text', text: `fixture: configured ${providerId}/${model}` }])
    expect(helperBranches.at(-1)).toBe(`configured:${providerId}/${model}`)
  }
})

test('routes the exact custom agent frontmatter model through agent.spawn', async () => {
  store.clear()
  await reload({ local: provider('qwen') })
  const name = 'local-review'
  const oldCwd = host.session.cwd
  const project = `${root}/fixture-${name}`
  host.session.cwd = async () => project
  const directory = `${project}/.claude/agents`
  fixtureDirs.set(directory, [{ name: `${name}.md`, kind: 'file' }])
  fixtureFiles.set(`${directory}/${name}.md`, `---\nname: ${name}\ndescription: Review source\nmodel: local/qwen\n---\nReview source only.\n`)
  try {
    approvalAnswer = 'Keep it off'
    const asks = approvalAskCount
    const before = wires.length
    const refreshes = discoveries.length
    let received: any
    const agentId = `spawned-agent-${agents.length}`
    const chosen = await hook('agent.spawn')(host, spawnInput('codex/gpt-6.1-sol', name), async (event: any) => {
      received = event
      agents.push({ id: agentId, type: event.subagentType, description: event.description, status: 'running' })
      return { model: 'local/qwen', agentId }
    })
    expect(received.model).toBe('local/qwen')
    // The exact provider model in native frontmatter is forwarded to the host.
    expect(chosen.model).toBe('local/qwen')
    expect(approvalAskCount).toBe(asks)
    expect(store.size).toBe(0)
    expect(wires.length).toBe(before)
    expect(discoveries.length).toBe(refreshes)
    const refused = await step(name, 'local/qwen')
    expect(approvalAskCount).toBeGreaterThan(asks)
    expect(wires.length).toBe(before)
    expect(refused.diagnostics.join('\n')).toContain('not approved')
  } finally {
    host.session.cwd = oldCwd
  }
})

test('configured Codex-prefix providers report explicit configured source', async () => {
  await reload({ codex: provider('gpt-6.1-sol') })
  const report = await models()
  const entry = report.models.find((item: any) => item.model === 'codex/gpt-6.1-sol')
  expect(entry).toMatchObject({ source: 'configured provider', execution: 'native provider' })
})

test('configured Codex-prefix providers do not inherit subscription quota', async () => {
  store.clear()
  await reload({})
  approvalAnswer = 'Allow'
  emitLimits = true
  await step('general-purpose', 'codex/gpt-6.1-sol')
  emitLimits = false
  await reload({ codex: provider('gpt-6.1-sol') })
  const report = await models()
  const entry = report.models.find((item: any) => item.model === 'codex/gpt-6.1-sol')
  expect(report.codexLimits).toMatchObject({ status: 'reported', plan: 'fixture-subscription' })
  expect(entry.usageLimits).toEqual({ status: 'unavailable', windows: [] })
})

test('declared provider turns do not repeat discovery', async () => {
  store.clear()
  await reload({ local: provider('qwen') })
  const beforeTurn = discoveries.length
  const beforeWires = wires.length
  approvalAnswer = 'Keep it off'
  const refused = await step('general-purpose', 'local/qwen')
  expect(discoveries.length).toBe(beforeTurn)
  expect(wires.length).toBe(beforeWires)
  expect(refused.diagnostics.join('\n')).toContain('not approved')
})

test('a retargeted declared provider asks for approval again before compaction', async () => {
  store.clear()
  const first = provider('qwen')
  await reload({ local: first })
  approvalAnswer = 'Allow'
  const accepted = await step('general-purpose', 'local/qwen')
  const beforeWires = wires.length
  const beforeApprovals = approvalAskCount
  await reload({ local: { ...first, baseUrl: 'https://retarget.fixture.invalid/v1' } })
  approvalAnswer = 'Keep it off'
  const compacted = await hook('session.compact')(host, { agentId: accepted.id, trigger: 'auto', instructions: '', messages: [{ role: 'user', text: 'Child task', toolUses: [] }] }, async () => { throw new Error('unsafe native fallback') })
  expect(approvalAskCount).toBe(beforeApprovals + 1)
  expect(wires.length).toBe(beforeWires)
  expect(compacted.skip).toContain('original transcript retained')
})

test('status diagnostics never expose provider endpoints', async () => {
  await reload({})
  const directory = `${root}/.claude/agents`
  const name = 'diagnostic-source-review'
  const endpoint = 'https://private-endpoint.fixture.invalid/v1'
  fixtureDirs.set(directory, [{ name: `${name}.md`, kind: 'file' }])
  fixtureFiles.set(`${directory}/${name}.md`, `---\nname: ${name}\ndescription: &endpoint ${endpoint}\nmodel: codex/gpt-6.1-sol\n---\nReview source only.\n`)
  await step(name, 'codex/gpt-6.1-sol')
  const status = await command('status')
  expect(status).not.toContain(endpoint)
})

test('plugin registration creates no rice-multi-models agent definitions', async () => {
  await reload({ fixture: provider('model') })
  expect([...defs.keys()].filter(name => name.startsWith('rice-multi-models:'))).toEqual([])
})

test('a declared model whose config does not validate is refused instead of sent to Claude', async () => {
  config = JSON.stringify({ providers: { fixture: provider('model') }, tiers: { fixture: { default: 'gpt' } } })
  await hook('command.run', 'rice-models')(host, { args: 'reload' })
  const sessionModel = host.session.model
  host.session.model = async () => 'fixture/model'
  try {
    let nativeCalls = 0
    const chunks: any[] = []
    const generator = hook('turn.step')(host, { model: 'fixture/model', turnId: 'invalid-config', index: 0 }, async function* () { nativeCalls++; return { native: true } })
    let item = await generator.next()
    while (!item.done) { chunks.push(item.value); item = await generator.next() }
    expect(nativeCalls).toBe(0)
    expect(chunks).toEqual([{ kind: 'stop', stopReason: null, usage: null }])
    expect(diagnostics.at(-1)).toContain('does not validate')
  } finally {
    host.session.model = sessionModel
    await reload({})
  }
})

test('a failing title hook leaves the naming of a routed session to the host', async () => {
  const model = host.session.model
  host.session.model = async () => 'codex/gpt-6.1-sol'
  try {
    let calls = 0
    // The lower chain fails once, as a throwing hook would; the host then runs the catch with the rest of the chain.
    const result = await hook('classic.UserPromptSubmit')(host, { prompt: 'Fix the flaky picker test', source: 'user' }, async () => { if (calls++ === 0) throw new Error('lower hook failed'); return {} })
    expect(result.sessionTitle).toBeUndefined()
  } finally {
    host.session.model = model
  }
})

const mainStep = async () => {
  for await (const _chunk of hook('turn.step')(host, { model: 'codex/gpt-6.1-sol', turnId: 'fixture-main', index: 0 }, async function* () { throw new Error('unsafe native step') })) { /* drain */ }
  return wires.at(-1).req
}

test("routed steps send the installed claude's tool definitions, and a subagent its type's own prompt and tools", async () => {
  await reload({})
  approvalAnswer = 'Allow'
  const main = await mainStep()
  expect(main.who).toBe('main')
  // Not the session list's short summary ('Read'): the definition the engine sends, its schema included.
  expect(main.tools.find((tool: any) => tool.name === 'Read')).toMatchObject({ description: 'FIXTURE Read DEFINITION IN FULL', schema: fixtureTools.tools.find(tool => tool.name === 'Read')!.input_schema })
  const general = (await step('general-purpose', 'codex/gpt-6.1-sol'), wires.at(-1).req)
  // Exactly the engine's subagent prompt: no identity preamble, no environment or closing line added here.
  expect(general.system).toBe(`FIXTURE GENERAL PURPOSE PROMPT${FIXTURE_TAIL}`)
  expect(general.tools.map((tool: any) => tool.name)).toEqual(['Bash', 'Read'])
  const explore = (await step('Explore', 'codex/gpt-6.1-sol'), wires.at(-1).req)
  expect(explore.system).toBe(`FIXTURE EXPLORE PROMPT${FIXTURE_TAIL}`)
  // Explore is offered what the engine offers Explore.
  expect(explore.tools.map((tool: any) => tool.name)).toEqual(['Read'])
  expect(JSON.stringify([general, explore].map(req => req.system))).not.toContain('styx')
  const status = await command('status')
  expect(status).toContain("Tool definitions and agent prompts: Claude Code's own, read from the installed claude 2.1.296 (built-in agent types Explore, general-purpose)")
})

test('workflow and resumed native spawns retain exact ownership and pinned permissions', async () => {
  await reload({ local: provider('qwen') })
  for (const shape of [
    { workflow: { runId: 'owned-workflow', agentIndex: 1 }, background: true },
    { isTeammate: true, name: 'owned-peer', background: true },
    { background: false },
  ]) {
    const input = { ...spawnInput('codex/gpt-6.1-sol', 'general-purpose', 'local/qwen'), ...shape, permissionMode: 'plan' }
    let dispatched: any
    const result = await hook('agent.spawn')(host, input, async (e: any) => { dispatched = e; return { model: 'local/qwen', agentId: `owned-lifecycle-${agents.length}` } })
    expect(dispatched).toMatchObject({ model: 'local/qwen', permissionMode: 'plan', background: shape.background, provider: input.provider })
    expect(result.model).toBe('local/qwen')
  }
  const resumedId = 'owned-resumed-exact'
  agents.push({ id: resumedId, type: 'general-purpose', description: 'owned resumed context' })
  const input = { ...spawnInput('codex/gpt-6.1-sol', 'general-purpose'), resume: { agentId: resumedId }, permissionMode: 'plan' }
  let seen: any
  await hook('agent.spawn')(host, input, async (e: any) => { seen = e; return { model: 'local/qwen', agentId: resumedId } })
  expect(seen).toBe(input)
  const output: any[] = []
  const generator = hook('turn.step')(host, { agentId: resumedId, model: 'haiku', turnId: 'resumed-turn', index: 0 }, async function* () { throw new Error('must not borrow native or main model') })
  for await (const chunk of generator) output.push(chunk)
  expect(wires.at(-1).req).toMatchObject({ target: 'local/qwen', who: resumedId })
  await reload({})
})

test('a nested spawn with unknown alias ownership never chooses a native or main provider', async () => {
  for (const fork of [false, true]) {
    let nativeCalls = 0
    const input = { ...spawnInput('haiku', fork ? 'fork' : 'general-purpose', undefined, 'owned-unobserved-spawn-parent'), fork }
    const result = await hook('agent.spawn')(host, input, async () => { nativeCalls++; return { model: 'haiku', agentId: 'must-not-start' } })
    expect(nativeCalls).toBe(0)
    expect(result.deny).toContain('parent model is unknown')
  }
})

test('a child with an unknown parent never borrows the main model', async () => {
  const id = 'owned-unknown-parent-child'
  agents.push({ id, parentId: 'unobserved-parent', type: 'general-purpose', description: 'owned unknown lineage' })
  const before = wires.length
  const start = diagnostics.length
  let nativeCalls = 0
  const chunks: any[] = []
  for await (const chunk of hook('turn.step')(host, { agentId: id, model: 'haiku', turnId: 'unknown-owner', index: 0 }, async function* () { nativeCalls++; return {} })) chunks.push(chunk)
  expect(wires.length).toBe(before)
  expect(nativeCalls).toBe(0)
  expect(chunks.at(-1)).toEqual({ kind: 'stop', stopReason: null, usage: null })
  expect(chunks.filter(chunk => chunk.kind === 'text').map(chunk => chunk.text).join('')).toContain('child request failed')
  expect(diagnostics.slice(start).join('\n')).toContain('no observed model or verified parent model')
})

test('an unowned root child is not assigned the main provider from its list row', async () => {
  const id = 'owned-unobserved-root-child'
  agents.push({ id, type: 'general-purpose', description: 'owned unobserved root child' })
  const before = wires.length
  let nativeCalls = 0
  const chunks: any[] = []
  for await (const chunk of hook('turn.step')(host, { agentId: id, model: 'haiku', turnId: 'unknown-root-owner', index: 0 }, async function* () { nativeCalls++; return {} })) chunks.push(chunk)
  expect(wires.length).toBe(before)
  expect(nativeCalls).toBe(0)
  expect(chunks.at(-1)).toEqual({ kind: 'stop', stopReason: null, usage: null })
  expect(chunks.filter(chunk => chunk.kind === 'text').map(chunk => chunk.text).join('')).toContain('child request failed')
})

test('a built-in agent type the installed claude did not start is refused, never sent with a made-up prompt', async () => {
  const before = wires.length
  const refused = await step('claude-code-guide', 'codex/gpt-6.1-sol')
  expect(refused.nextCalls).toBe(0)
  expect(wires.length).toBe(before)
  expect(refused.diagnostics.join('\n')).toContain('did not start a claude-code-guide agent')
})

test("without the installed claude's definitions a main step falls back and says so, and a subagent step is refused", async () => {
  const list = host.tool.list
  // A combination of built-in tools not read yet, whose read fails.
  host.tool.list = async () => [...(await list()), { name: 'Write', description: 'Writes a', mcp: false }]
  toolCaptureFails = true
  try {
    const main = await mainStep()
    expect(main.tools.find((tool: any) => tool.name === 'Read').description).toBe('Read')
    const write = main.tools.find((tool: any) => tool.name === 'Write')
    expect(write.description).toBe('Writes a')
    expect(write.schema.properties.file_path).toBeDefined()
    expect(await command('status')).toContain("the installed claude's could not be read (fixture tool capture failure); built-in tools use the schema table generated for")
    expect(JSON.parse(await command('doctor')).integration.toolDefinitions).toMatchObject({ source: expect.stringContaining('generated schema table'), error: 'fixture tool capture failure' })
    const before = wires.length
    const refused = await step('general-purpose', 'codex/gpt-6.1-sol')
    expect(refused.nextCalls).toBe(0)
    expect(wires.length).toBe(before)
    expect(refused.diagnostics.join('\n')).toContain("Claude Code's own prompt for the general-purpose agent could not be read from the installed claude (fixture tool capture failure)")
    // A failed read is not run again for every step; a refresh tries it again.
    const runs = toolCaptureRuns
    await step('general-purpose', 'codex/gpt-6.1-sol')
    expect(toolCaptureRuns).toBe(runs)
    toolCaptureFails = false
    await command('refresh')
    const general = (await step('general-purpose', 'codex/gpt-6.1-sol'), wires.at(-1).req)
    expect(toolCaptureRuns).toBe(runs + 1)
    expect(general.system).toBe(`FIXTURE GENERAL PURPOSE PROMPT${FIXTURE_TAIL}`)
  } finally {
    host.tool.list = list
    toolCaptureFails = false
  }
})

// Exact model ids through the Agent tool's `model`: the engine's order is tool.call, its own check of the
// argument against four values, then agent.spawn with the same tool_use_id.
const ENGINE_MODELS = ['fable', 'haiku', 'opus', 'sonnet']
type EngineRun = { result: any; spawned: any[]; checked: unknown[] }
const agentCall = async (toolUseId: string, input: Record<string, unknown>, options: { spawnModelFrom?: (e: any) => string | undefined; fork?: boolean; skipSpawn?: boolean; parent?: string } = {}): Promise<EngineRun> => {
  const spawned: any[] = []
  const checked: unknown[] = []
  const result = await hook('tool.call')(host, { tool: 'Agent', tool_use_id: toolUseId, description: 'fixture', prompt: 'fixture task', ...input }, async (e: any) => {
    checked.push(e.model)
    if (e.model !== undefined && !ENGINE_MODELS.includes(e.model)) return { error: `validation: ${e.model}` }
    if (options.skipSpawn) return { result: 'abandoned' }
    const outcome = await hook('agent.spawn')(host, { ...spawnInput(options.parent ?? 'codex/gpt-6.1-sol', (input['subagent_type'] as string | undefined) ?? 'general-purpose', e.model), tool_use_id: toolUseId, description: e.description, fork: options.fork ?? false }, async (s: any) => {
      spawned.push(s)
      return { model: s.model, agentId: `agent-${toolUseId}` }
    })
    spawned.push({ outcome })
    return { result: outcome }
  })
  return { result, spawned, checked }
}
const describeAgent = async () => (await hook('tool.describe')(host, { tool: 'Agent', description: 'Engine Agent text.', provider: { plugin: 'engine', tier: 'core' } }, async (e: any) => ({ description: e.description }))).description as string

test('an exact discovered id passed as Agent model runs the subagent on exactly that id', async () => {
  await reload({ local: provider('qwen') }, { fast: { target: 'local/qwen' } })
  for (const parent of ['codex/gpt-6.1-sol', 'sonnet']) {
    for (const id of ['codex/gpt-6.1-sol', 'local/qwen', 'fast']) {
      const run = await agentCall(`toolu_exact_${parent}_${id}`, { model: id }, { parent })
      expect(run.checked).toEqual(['haiku'])
      const received = run.spawned[0]
      expect(received.model).toBe(id)
      expect(run.spawned.at(-1).outcome.model).toBe(id)
    }
  }
})

test('an unknown id is denied visibly with the valid ids and starts nothing', async () => {
  await reload({ local: provider('qwen') })
  const run = await agentCall('toolu_unknown', { model: 'codex/gpt-9-imaginary' })
  expect(run.checked).toEqual([])
  expect(run.spawned).toEqual([])
  expect(run.result.deny).toContain('"codex/gpt-9-imaginary"')
  for (const valid of ['haiku', 'sonnet', 'opus', 'fable', 'codex/gpt-6.1-sol', 'local/qwen']) expect(run.result.deny).toContain(valid)
})

test('an inherited child is labelled with the model Claude resolves for it, in Claude\'s own order', async () => {
  await reload({ local: provider('qwen') })
  const sessionModel = host.session.model
  const oldCwd = host.session.cwd
  // A native Claude session: the child inherits through Claude's own resolution, not the mod's.
  host.session.model = async () => 'opus'
  try {
    const inherited = await spawn('opus', 'general-purpose')
    expect(inherited.received.description).toBe('owned spawn (opus)')
    expect(inherited.received.model).toBeUndefined()
    // CLAUDE_CODE_SUBAGENT_MODEL comes before the parent's model, as Claude resolves it.
    environment.set('CLAUDE_CODE_SUBAGENT_MODEL', 'haiku')
    const configured = await spawn('opus', 'general-purpose')
    expect(configured.received.description).toBe('owned spawn (haiku)')
    expect(configured.received.model).toBeUndefined()
    // A built-in type's own model is its definition's, before the variable (statusline-setup runs on sonnet).
    const builtin = await spawn('opus', 'statusline-setup')
    expect(builtin.received.description).toBe('owned spawn (sonnet)')
    expect(builtin.received.model).toBeUndefined()
    // Explore's own definition says inherit, so it runs on the parent's model and the variable does not apply.
    const explore = await spawn('opus', 'Explore')
    expect(explore.received.description).toBe('owned spawn (opus)')
    expect(explore.received.model).toBeUndefined()
    // A definition's own "inherit" decides before the variable, as the parent's model.
    const name = 'inheriting-review'
    const directory = `${root}/fixture-${name}/.claude/agents`
    host.session.cwd = async () => `${root}/fixture-${name}`
    fixtureDirs.set(directory, [{ name: `${name}.md`, kind: 'file' }])
    fixtureFiles.set(`${directory}/${name}.md`, `---\nname: ${name}\ndescription: Review source\nmodel: inherit\n---\nReview source only.\n`)
    const declared = await spawn('opus', name)
    expect(declared.received.description).toBe('owned spawn (opus)')
    expect(declared.received.model).toBeUndefined()
    host.session.cwd = oldCwd
    // Claude reads an empty or "inherit" variable as the parent's model, not as a model name.
    for (const value of ['', 'inherit']) {
      environment.set('CLAUDE_CODE_SUBAGENT_MODEL', value)
      expect((await spawn('opus', 'general-purpose')).received.description).toBe('owned spawn (opus)')
    }
  } finally { host.session.model = sessionModel; host.session.cwd = oldCwd; environment.delete('CLAUDE_CODE_SUBAGENT_MODEL') }
})

test('a forced subagent model and a workflow model label rows in Claude\'s own order', async () => {
  await reload({ local: provider('qwen') })
  const sessionModel = host.session.model
  host.session.model = async () => 'opus'
  // A spawn with extra native fields (a workflow agent, a teammate); `ran` is the model the engine reports.
  const spawnWith = async (extra: Record<string, unknown>, parentModel: string, model?: string, parentAgentId?: string, ran = 'sonnet') => {
    let received: any
    const id = `spawned-agent-${agents.length}`
    await hook('agent.spawn')(host, { ...spawnInput(parentModel, 'general-purpose', model, parentAgentId), ...extra }, async (e: any) => { received = e; agents.push({ id, type: e.subagentType, description: e.description, status: 'running' }); return { model: ran, agentId: id } })
    return { received, id }
  }
  const workflow = { workflow: { runId: 'wf_fixture', agentIndex: 1 } }
  try {
    // A forced CLAUDE_CODE_SUBAGENT_MODEL outranks the call's model and an agent's own; the call's model still reaches Claude.
    environment.set('CLAUDE_CODE_SUBAGENT_MODEL_FORCE', 'true')
    environment.set('CLAUDE_CODE_SUBAGENT_MODEL', 'haiku')
    const forced = await spawn('opus', 'general-purpose', 'sonnet')
    expect(forced.received.description).toBe('owned spawn (haiku)')
    expect(forced.received.model).toBe('sonnet')
    expect((await spawn('opus', 'statusline-setup')).received.description).toBe('owned spawn (haiku)')
    // It outranks a workflow model too, which Claude keeps under it only from managed policy.
    environment.set('CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL', 'sonnet')
    expect((await spawnWith(workflow, 'opus', 'opus')).received.description).toBe('owned spawn')
    // Forced with no model set, the call's model is dropped and the child runs on its parent's.
    environment.delete('CLAUDE_CODE_SUBAGENT_MODEL')
    expect((await spawn('opus', 'general-purpose', 'sonnet')).received.description).toBe('owned spawn (opus)')
    environment.set('CLAUDE_CODE_SUBAGENT_MODEL_FORCE', '0')
    expect((await spawn('opus', 'general-purpose', 'haiku')).received.description).toBe('owned spawn (haiku)')
    // A workflow agent takes the workflow model over the call's, and so does a non-teammate it starts.
    const agent = await spawnWith(workflow, 'opus', 'haiku')
    expect(agent.received.description).toBe('owned spawn')
    expect(agent.received.model).toBe('haiku')
    const nested = await spawn('sonnet', 'general-purpose', 'opus', agent.id)
    expect(nested.received.description).toBe('owned spawn (sonnet)')
    expect(nested.received.model).toBe('opus')
    expect((await spawnWith({ isTeammate: true }, 'sonnet', 'opus', agent.id)).received.description).toBe('owned spawn (opus)')
    // An agent outside a run keeps its call's model, and an "inherit" workflow model is no workflow model.
    expect((await spawn('opus', 'general-purpose', 'haiku')).received.description).toBe('owned spawn (haiku)')
    environment.set('CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL', 'Inherit')
    expect((await spawnWith(workflow, 'opus', 'haiku')).received.description).toBe('owned spawn')
  } finally {
    host.session.model = sessionModel
    for (const name of ['CLAUDE_CODE_SUBAGENT_MODEL_FORCE', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL']) environment.delete(name)
  }
})

test('workflow agent descriptions stay native while nested agents remain labelled', async () => {
  await reload({})
  const sessionModel = host.session.model
  host.session.model = async () => 'opus'
  const workflow = { workflow: { runId: 'wf_native_label_fixture', agentIndex: 0 } }
  const id = `spawned-agent-${agents.length}`
  let received: any
  try {
    await hook('agent.spawn')(host, { ...spawnInput('opus', 'general-purpose'), ...workflow }, async (event: any) => {
      received = event
      agents.push({ id, type: event.subagentType, description: event.description, status: 'running' })
      return { model: 'sonnet', agentId: id }
    })
    expect(received.description).toBe('owned spawn')
    const nested = await spawn('sonnet', 'general-purpose', 'haiku', id)
    expect(nested.received.description).toBe('owned spawn (haiku)')
  } finally {
    host.session.model = sessionModel
  }
})

test('Claude aliases and an absent model behave as without the carrier, and an engine haiku is not a lost carrier', async () => {
  await reload({ local: provider('qwen') })
  for (const model of ['sonnet', 'opus', 'fable', 'haiku', undefined]) {
    const run = await agentCall(`toolu_alias_${model}`, model === undefined ? {} : { model })
    const plain = await spawn('codex/gpt-6.1-sol', 'general-purpose', model)
    expect(run.result.deny).toBeUndefined()
    expect(run.checked).toEqual([model])
    expect(run.spawned[0].description).toBe(`fixture (${run.spawned[0].model})`)
    expect(run.spawned[0].model).toBe(plain.received.model)
  }
})

test('parallel calls keep their own ids and leave no record behind', async () => {
  await reload({ local: provider('qwen') })
  const [a, b, c] = await Promise.all([
    agentCall('toolu_par_a', { model: 'codex/gpt-6.1-sol' }),
    agentCall('toolu_par_b', { model: 'local/qwen' }),
    agentCall('toolu_par_c', { model: 'sonnet' }),
  ])
  expect(a.spawned[0].model).toBe('codex/gpt-6.1-sol')
  expect(b.spawned[0].model).toBe('local/qwen')
  expect(c.spawned[0].model).toBe((await spawn('codex/gpt-6.1-sol', 'general-purpose', 'sonnet')).received.model)
  expect(a.spawned[0].description).toBe('fixture (codex/gpt-6.1-sol)')
  const missing = await hook('agent.spawn')(host, { ...spawnInput('codex/gpt-6.1-sol', 'general-purpose', 'haiku'), tool_use_id: 'toolu_par_a', description: markDescription('fixture', 'local/qwen') }, async () => { throw new Error('must not start') })
  expect(missing.deny).toContain('could not be recovered')
})

test('a marked spawn with no record is refused, never run as haiku', async () => {
  let started = false
  const refused = await hook('agent.spawn')(host, { ...spawnInput('codex/gpt-6.1-sol', 'general-purpose', 'haiku'), tool_use_id: 'toolu_lost', description: markDescription('fixture', 'local/qwen') }, async () => { started = true; return { model: 'haiku', agentId: 'x' } })
  expect(started).toBe(false)
  expect(refused.deny).toContain('not run as haiku')
})

test('the record is removed when the call ends without a spawn, and when the engine rejects it', async () => {
  await reload({ local: provider('qwen') })
  const abandoned = await agentCall('toolu_abandoned', { model: 'local/qwen' }, { skipSpawn: true })
  expect(abandoned.spawned).toEqual([])
  const late = await hook('agent.spawn')(host, { ...spawnInput('codex/gpt-6.1-sol', 'general-purpose', 'haiku'), tool_use_id: 'toolu_abandoned', description: markDescription('fixture', 'local/qwen') }, async () => ({ model: 'haiku', agentId: 'x' }))
  expect(late.deny).toContain('could not be recovered')
  const thrown = await hook('tool.call')(host, { tool: 'Agent', tool_use_id: 'toolu_thrown', model: 'local/qwen' }, async () => { throw new Error('engine failure') }).catch((error: unknown) => error)
  expect(JSON.stringify(thrown)).toContain('Agent model could not be resolved')
  const afterThrow = await hook('agent.spawn')(host, { ...spawnInput('codex/gpt-6.1-sol', 'general-purpose', 'haiku'), tool_use_id: 'toolu_thrown', description: markDescription('fixture', 'local/qwen') }, async () => ({ model: 'haiku', agentId: 'x' }))
  expect(afterThrow.deny).toContain('could not be recovered')
})

test('a fork with an exact id is refused and consumes the record', async () => {
  await reload({ local: provider('qwen') })
  const run = await agentCall('toolu_fork', { model: 'local/qwen' }, { fork: true })
  expect(run.spawned.at(-1).outcome.deny).toContain('fork')
  expect(run.spawned.length).toBe(1)
})

test('spawn failure handling denies before dispatch and preserves a settled dispatch without replay', async () => {
  const failed = catches.get('agent.spawn')
  expect(failed).toBeDefined()
  let calls = 0
  const result = { model: 'local/qwen', agentId: 'settled-spawn' }
  const next = Object.assign(async () => { calls++; return result }, { called: false, error: { kind: 'error', message: 'owned state failure' } })
  const denied = await failed!(host, spawnInput('sonnet', 'general-purpose', 'haiku'), next)
  expect(denied.deny).toContain('no subagent was started')
  expect(calls).toBe(0)
  next.called = true
  expect(await failed!(host, spawnInput('sonnet', 'general-purpose', 'haiku'), next)).toBe(result)
  expect(calls).toBe(1)
})

test('exact-model permission asks identify the real model without changing the decision or pinned input', async () => {
  await reload({ local: provider('qwen') })
  let observed: any
  const result = await hook('tool.call')(host, { tool: 'Agent', tool_use_id: 'toolu_approval_exact', model: 'local/qwen', description: 'owned task' }, async (rewritten: any) => {
    const nativeHost = { ...host, session: { ...host.session, model: async () => 'sonnet' } }
    const input = { model: rewritten.model, description: rewritten.description }
    let receivedInput: unknown
    const verdict = await hook('tool.check')(nativeHost, { tool: 'Agent', tool_use_id: 'toolu_approval_exact', input }, async (received: any) => {
      receivedInput = received.input
      return { decision: 'ask', reason: 'native ask', decider: 'person' }
    })
    observed = { rewritten, input, receivedInput, verdict }
    return { result: 'owned denied fixture' }
  })
  expect(result.deny).toBeUndefined()
  expect(observed).toBeDefined()
  expect(observed.rewritten.description).toContain('exact Agent model "local/qwen"')
  expect([...observed.rewritten.description].every(character => character.codePointAt(0)! < 128)).toBe(true)
  expect(observed.receivedInput).toBe(observed.input)
  expect(observed.verdict).toMatchObject({ decision: 'ask', decider: 'person' })
  expect(observed.verdict.reason).toContain('native ask')
  expect(observed.verdict.reason).toContain('exact model "local/qwen"')
  expect(observed.verdict.reason).toContain('haiku is validation only')
  expect(observed.input.model).toBe('haiku')
})

test('the Agent tool description names the discovered ids, and only once', async () => {
  await reload({ local: provider('qwen') })
  const text = await describeAgent()
  expect(text.startsWith('Engine Agent text.\n\n[rice-multi-models]')).toBe(true)
  expect(text).toContain('codex/gpt-6.1-sol')
  expect(text).toContain('local/qwen')
  expect(text.match(/\[rice-multi-models\]/g)?.length).toBe(1)
  await reload({})
  expect(await describeAgent()).toContain('codex/gpt-6.1-sol')
})
