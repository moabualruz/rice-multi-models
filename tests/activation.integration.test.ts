import { expect, mock, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { unknownMetadata, type ModelCatalogue } from '../hooks/catalogue'

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '')
mock.module('claude-code', () => ({
  atom: (_key: unknown, value: unknown) => ({ value }),
  read: async (_host: unknown, state: { value: unknown }) => state.value,
  update: async (_host: unknown, state: { value: unknown }, change: (value: unknown) => unknown) => { state.value = change(state.value) },
}))
const { register } = await import('../hooks/register')
const callbacks = new Map<string, (...args: any[]) => any>()
register(((event: string, match: any, callback: any) => {
  callbacks.set(event, callback ?? match)
  return { catch: () => undefined }
}) as any)

function fixture() {
  const files = new Map<string, string>()
  const calls: string[][] = []
  const notices: string[] = []
  const commands: any[] = []
  const store = new Map<string, unknown>()
  const syncs: any[] = []
  const env = new Map<string, string>([['HOME', '/empty-home']])
  const envWrites: { key: string; value: string | undefined }[] = []
  const state = new Map<string, unknown>()
  const selection = { model: 'sonnet' }
  const discoveries: { configText: string; approved: string[] }[] = []
  const discovery: { catalogue: ModelCatalogue; unavailable: boolean } = { catalogue: { models: [], providers: [{ provider: 'codex', status: 'unavailable', source: 'fixture authenticated models endpoint', error: 'fixture-no-login' }] }, unavailable: false }
  const fetchStatus: { result: unknown } = { result: { ok: true, config: { endpoints: [{ name: 'docs-fetch', priority: 4 }] } } }
  const info = { node: { executable: '/fixture/node', version: '22.20.0', supported: true }, platform: 'linux', home: '/empty-home', configDir: '/empty-home/.claude', codexHome: '/empty-home/.codex', opencodeAuthFile: '/empty-home/.local/share/opencode/auth.json', clis: {}, auth: { codex: false, opencode: false }, opencodeEntries: [] }
  const host: any = {
    env: {
      get: async (key: string) => env.get(key),
      set: async (key: string, value: string | undefined) => {
        envWrites.push({ key, value })
        if (value === undefined) env.delete(key)
        else env.set(key, value)
      },
    },
    state: {
      get: async (ref: { key: string }) => ({ value: state.get(ref.key), version: 0 }),
      set: async (ref: { key: string }, value: unknown) => { state.set(ref.key, value); return { isSet: true, version: 1 } },
    },
    plugin: { root },
    process: {
      run: async (argv: string[], options: any = {}) => {
        calls.push(argv)
        if (argv[0] === 'node') return { exitCode: 0, stdout: JSON.stringify({ executable: '/fixture/node', version: info.node.version }), stderr: '' }
        if (argv[2] === 'doctor') return { exitCode: 0, stdout: JSON.stringify(info), stderr: '' }
        if (argv[2] === 'discover') {
          discoveries.push(JSON.parse(options.stdin))
          return discovery.unavailable ? { exitCode: 1, stdout: '', stderr: 'fixture unavailable' } : { exitCode: 0, stdout: JSON.stringify(discovery.catalogue), stderr: '' }
        }
        if (argv[2] === 'search-config') return { exitCode: 0, stdout: JSON.stringify({ ok: true, config: { version: 1, endpoints: [] } }), stderr: '' }
        if (argv[2] === 'fetch-config-status') return { exitCode: 0, stdout: JSON.stringify(fetchStatus.result), stderr: '' }
        if (argv[2] === 'sync-picker') {
          const input = JSON.parse(options.stdin)
          syncs.push(input)
          files.set(`${input.configDir}/settings.json`, JSON.stringify({ modelPicker: { options: input.rows } }))
          return { exitCode: 0, stdout: JSON.stringify({ ok: true, changed: syncs.length === 1, count: input.rows.length, path: `${input.configDir}/settings.json`, preserved: 0 }), stderr: '' }
        }
        return { exitCode: 127, stdout: '', stderr: 'not installed' }
      },
      spawn: async function* (options: any) {
        calls.push(options.argv)
        if (options.argv[2] === 'sync-picker') {
          const input = JSON.parse(options.input)
          syncs.push(input)
          files.set(`${input.configDir}/settings.json`, JSON.stringify({ modelPicker: { options: input.rows } }))
          yield { stream: 'stdout', text: JSON.stringify({ ok: true, changed: true, count: input.rows.length, path: `${input.configDir}/settings.json` }) }
        } else if (options.argv[2] === 'serve') {
          yield { stream: 'stdout', text: 'ready {"socketPath":"/tmp/rice fixture.sock","token":"' + 'a'.repeat(64) + '"}\n' }
          await new Promise(() => {})
        }
        return { code: 0 }
      },
    },
    fs: { exists: async (path: string) => path.endsWith('/dist/helper.mjs') || files.has(path), read: async (path: string) => { const text = files.get(path); if (text === undefined) throw new Error('ENOENT'); return text }, list: async () => [], write: async () => { throw new Error('Hook must not write settings directly') } },
    command: { register: async (spec: any) => { commands.push(spec) } },
    tool: { register: async () => ({}), list: async () => [] },
    agent: { register: async () => ({}), list: async () => [] },
    store: { keys: async () => [...store.keys()], get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => { store.set(key, value) } },
    ui: { log: (text: string, options: any) => { if (options?.to !== 'debug') notices.push(text) }, ask: async () => { throw new Error('Onboarding must never ask') }, status: () => {}, toast: () => {} },
    clock: { now: async () => Date.now(), sleep: async () => {} },
    session: { id: async () => 'empty-session', model: async () => selection.model, usage: async () => ({ context: { window: Number(env.get('CLAUDE_CODE_MAX_CONTEXT_TOKENS') ?? 200000) } }), version: async () => ({ version: '2.1.296' }), isInteractive: async () => true },
  }
  return { host, files, calls, notices, commands, store, syncs, info, discoveries, discovery, env, envWrites, state, selection,
    get contextWrites() { return envWrites.filter(write => write.key === 'CLAUDE_CODE_MAX_CONTEXT_TOKENS') }, fetchStatus,
  }
}

test('actual session.start activates an empty Node-only picker and explains unavailable discovery without inventing a default', async () => {
  const f = fixture()
  const result = await callbacks.get('session.start')!(f.host, { isInteractive: true }, async () => ({ fixture: true }))
  expect(result).toEqual({ fixture: true })
  expect({ automaticPicker: f.files.has('/empty-home/.claude/settings.json'), visibleSetupNotice: f.notices.length > 0 }).toEqual({ automaticPicker: true, visibleSetupNotice: true })
  expect(JSON.parse(f.files.get('/empty-home/.claude/settings.json')!).modelPicker.options).toEqual([])
  expect(f.discoveries).toEqual([{ configText: '', approved: [] }])
  expect(f.calls.filter(argv => argv[2] === 'discover')).toEqual([['/fixture/node', `${root}/dist/helper.mjs`, 'discover']])
  expect(f.notices.join('\n')).toContain('codex login')
  expect(f.notices.join('\n')).toContain('No Codex model was discovered')
  expect(f.notices.join('\n')).not.toContain('/model codex/')
  expect(f.calls.some(argv => argv[0]?.includes('bun'))).toBe(false)
  expect(f.calls.some(argv => argv[2] === 'setup-codex')).toBe(false)
})

test('unchanged startup is idempotent and persists its one-time interactive notice', async () => {
  const f = fixture()
  for (let i = 0; i < 3; i++) await callbacks.get('session.start')!(f.host, { isInteractive: true }, async () => ({}))
  expect(f.notices.length).toBe(1)
  expect([...f.store.keys()].some(key => key.startsWith('setup-notice-'))).toBe(true)
  expect(f.calls.filter(argv => argv[2] === 'serve').length).toBeLessThanOrEqual(1)
  expect(f.syncs.map(input => input.rows)).toEqual([[], [], []])
  expect(f.discoveries.length).toBe(3)
  f.info.auth.codex = true
  await callbacks.get('session.start')!(f.host, { isInteractive: true }, async () => ({}))
  expect(f.notices.length).toBe(2)
  expect(f.notices.at(-1)).toContain('Codex login file is present')
})

test('headless activation syncs deterministically without asking or consuming the interactive notice', async () => {
  const f = fixture()
  await callbacks.get('session.start')!(f.host, { isInteractive: false }, async () => ({}))
  expect(f.syncs.length).toBe(1)
  expect(f.notices).toEqual([])
  expect([...f.store.keys()].some(key => key.startsWith('setup-notice-'))).toBe(false)
  await callbacks.get('session.start')!(f.host, { isInteractive: true }, async () => ({}))
  expect(f.notices.length).toBe(1)
})

test('commands register before missing or outdated Node checks and no unsafe settings fallback runs', async () => {
  for (const version of ['missing', '20.19.0']) {
    const f = fixture()
    f.info.node.version = version
    const run = f.host.process.run
    f.host.process.run = async (argv: string[], options: any) => {
      expect(f.commands.map(spec => spec.name)).toContain('rice-models')
      return version === 'missing' ? { exitCode: 127, stdout: '', stderr: '' } : run(argv, options)
    }
    await callbacks.get('session.start')!(f.host, { isInteractive: true }, async () => ({}))
    expect(f.syncs).toEqual([])
    expect(f.files.size).toBe(0)
    expect(f.notices.join('\n')).toContain('Node.js 22+')
    const report = await callbacks.get('command.run')!(f.host, { args: 'doctor' })
    expect(report.text).toContain('/rice-models setup repair')
  }
})

test('doctor is read-only and shipped-helper absence gives actionable reinstall diagnostics', async () => {
  const f = fixture()
  const before = f.files.size
  const report = await callbacks.get('command.run')!(f.host, { args: 'doctor' })
  expect(JSON.parse(report.text).runtime.auth).toEqual({ codex: false, opencode: false })
  expect(f.files.size).toBe(before)
  expect(f.syncs).toEqual([])
  expect(f.calls.some(argv => ['serve', 'sync-picker', 'setup-codex'].includes(argv[2]!))).toBe(false)
  f.host.fs.exists = async () => false
  const missing = await callbacks.get('command.run')!(f.host, { args: 'setup repair' })
  expect(missing.text).toContain('dist/helper.mjs is missing')
  expect(missing.text).toContain('Reinstall or update')
  expect(f.syncs).toEqual([])
})

test('fetch configuration read failures are reported generically without returned details', async () => {
  const f = fixture()
  f.fetchStatus.result = { ok: false, config: { endpoints: [], url: 'https://private.example/fetch' }, error: 'credential at https://private.example/?key=secret' }
  const report = await callbacks.get('command.run')!(f.host, { args: 'doctor' })
  const web = JSON.parse(report.text).integration.webSearch
  expect(web.fetchConfiguration).toEqual({ available: false, error: 'Fetch configuration could not be read.' })
  expect(JSON.stringify(web)).not.toMatch(/private\.example|key=secret|https?:/i)
})

test('doctor and status expose credential-free fetch tier diagnostics', async () => {
  const f = fixture()
  f.fetchStatus.result = { ok: true, config: { endpoints: [{ name: 'docs-fetch', priority: 4, url: 'https://private.example/fetch', auth: { env: 'FETCH_PRIVATE_KEY' } }] }, token: 'must-not-cross-status' }
  const report = await callbacks.get('command.run')!(f.host, { args: 'doctor' })
  const web = JSON.parse(report.text).integration.webSearch
  expect(web.fetchConfiguration).toEqual({ available: true, error: null })
  expect(web.fetchTierState.tiers.map((tier: { stage: string }) => tier.stage)).toEqual([
    'provider-native', 'configured-service', 'native-fallback', 'direct-selected-extraction',
  ])
  expect(web.fetchTierState.tiers[1].services).toEqual([{ name: 'docs-fetch', priority: 4 }])
  expect(JSON.stringify(web)).not.toMatch(/https?:|FETCH_PRIVATE_KEY|must-not-cross-status|credential-helper|api\.example/i)
  await callbacks.get('session.start')!(f.host, { isInteractive: false }, async () => ({}))
  const status = await callbacks.get('command.run')!(f.host, { args: 'status' })
  expect(status.text).toContain('docs-fetch')
  expect(status.text).toContain('direct-selected-extraction')
  expect(f.calls.filter(argv => argv[2] === 'fetch-config-status')).toHaveLength(2)
})

test('freshly discovered Codex models and limits are shared by the picker and visible guide', async () => {
  const f = fixture()
  f.files.set('/empty-home/.codex/config.toml', 'model = "custom-default"\n')
  f.discovery.catalogue = {
    models: [{ model: 'codex/custom-default', label: 'Fixture custom model', execution: 'native provider', source: 'fixture authenticated models endpoint', observedAt: 1_800_000_000_000, metadata: { ...unknownMetadata(), contextWindow: 64000, outputTokenLimit: 2048 } }],
    providers: [{ provider: 'codex', status: 'fresh', source: 'fixture authenticated models endpoint', observedAt: 1_800_000_000_000 }],
  }
  await callbacks.get('session.start')!(f.host, { isInteractive: true }, async () => ({}))
  expect(f.discoveries.length).toBe(1)
  expect(f.syncs.at(-1).rows).toEqual([{ model: 'codex/custom-default', label: 'Fixture custom model', description: 'native provider; reported context 64000, input unknown, output 2048; native context registration unsupported' }])
  expect(f.notices.join('\n')).toContain('/model codex/custom-default')
})

test('empty or unavailable discovery never uses configured defaults or old model cache entries', async () => {
  for (const unavailable of [false, true]) {
    const f = fixture()
    f.files.set('/empty-home/.codex/config.toml', 'model = "custom-default"\n')
    f.files.set('/empty-home/.codex/models_cache.json', JSON.stringify({ models: [{ slug: 'cached-model', visibility: 'list' }] }))
    f.discovery.catalogue = { models: [], providers: [{ provider: 'codex', status: 'fresh', source: 'fixture empty endpoint', observedAt: 1_800_000_000_000 }] }
    f.discovery.unavailable = unavailable
    await callbacks.get('session.start')!(f.host, { isInteractive: true }, async () => ({}))
    expect(f.discoveries.length).toBe(1)
    expect(f.syncs.at(-1).rows).toEqual([])
    expect(f.notices.join('\n')).toContain('No Codex model was discovered')
    expect(f.notices.join('\n')).not.toContain('/model codex/')
  }
})

function contextFixture(contextWindow: number | null = 500000, maxContextWindow: number | null = 872000) {
  const f = fixture()
  f.selection.model = 'codex/fresh'
  f.discovery.catalogue = {
    models: [{ model: 'codex/fresh', label: 'Fresh model', execution: 'native provider', source: 'fixture live endpoint', observedAt: 1_800_000_000_000, metadata: { ...unknownMetadata(), contextWindow, maxContextWindow, inputTokenLimit: 470000 } }],
    providers: [{ provider: 'codex', status: 'fresh', source: 'fixture live endpoint', observedAt: 1_800_000_000_000 }],
  }
  return f
}
const startContext = (f: ReturnType<typeof fixture>) => callbacks.get('session.start')!(f.host, { isInteractive: false }, async () => ({ started: true }))

test('auxiliary Claude completions use the selected routed session provider without native fallback', async () => {
  const f = contextFixture()
  await startContext(f)
  const requests: any[] = []
  f.host.process.spawn = async function* (input: any) {
    requests.push(JSON.parse(input.input).req)
    yield { stream: 'stdout', text: JSON.stringify({ type: 'text', text: 'routed completion' }) + '\n' + JSON.stringify({ type: 'stop', reason: 'end_turn' }) + '\n' }
    return { code: 0 }
  }
  let nativeCalls = 0
  const complete = callbacks.get('model.complete')!
  const result = await complete(f.host, { model: 'haiku', prompt: 'Classify this request', system: 'Preserve this instruction' }, async () => { nativeCalls++; return { value: { isAnswered: true, text: 'native' } } })
  expect(result.value).toMatchObject({ isAnswered: true, text: 'routed completion' })
  expect(requests[0]).toMatchObject({ target: 'codex/fresh', system: 'Preserve this instruction', who: 'complete' })
  expect(nativeCalls).toBe(0)
  f.host.process.spawn = async function* () {
    yield { stream: 'stdout', text: JSON.stringify({ type: 'error', kind: 'request', text: 'fixture provider unavailable' }) + '\n' }
    return { code: 1 }
  }
  expect((await complete(f.host, { model: 'haiku', prompt: 'Again' }, async () => { nativeCalls++; return {} })).value.isAnswered).toBe(false)
  expect(nativeCalls).toBe(0)
  f.selection.model = 'sonnet'
  await complete(f.host, { model: 'haiku', prompt: 'Native session' }, async () => { nativeCalls++; return {} })
  expect(nativeCalls).toBe(1)
})

test('unreadable routed fork transcript cannot fall back to the native provider', async () => {
  const f = contextFixture()
  await startContext(f)
  f.host.session.messages = async () => ({ deny: 'fixture-unreadable' })
  let nativeCalls = 0
  const result = await callbacks.get('model.fork')!(f.host, { prompt: 'Summarize' }, async () => { nativeCalls++; return {} })
  expect(result.value.isAnswered).toBe(false)
  expect(nativeCalls).toBe(0)
})

test('classification uses the selected routed provider and accepts only a supplied label', async () => {
  const f = contextFixture()
  await startContext(f)
  const requests: any[] = []
  let answer = 'bug'
  f.host.process.spawn = async function* (input: any) {
    requests.push(JSON.parse(input.input).req)
    yield { stream: 'stdout', text: JSON.stringify({ type: 'text', text: answer }) + '\n' + JSON.stringify({ type: 'stop', reason: 'end_turn' }) + '\n' }
    return { code: 0 }
  }
  let nativeCalls = 0
  const classify = callbacks.get('model.classify')!
  const input = { text: 'An error', labels: ['bug', 'question'] }
  const next = async () => { nativeCalls++; return { value: 'native' } }
  expect(await classify(f.host, input, next)).toEqual({ value: 'bug' })
  expect(requests[0].target).toBe('codex/fresh')
  answer = 'invented label'
  expect(await classify(f.host, input, next)).toEqual({ value: undefined })
  expect(nativeCalls).toBe(0)
  f.selection.model = 'sonnet'
  expect(await classify(f.host, input, next)).toEqual({ value: 'native' })
  expect(nativeCalls).toBe(1)
})
const switchContext = (f: ReturnType<typeof fixture>, model: string) => {
  const from_model = f.selection.model
  f.selection.model = model
  return callbacks.get('classic.PostModelSwitch')!(f.host, { from_model, to_model: model, source: 'sdk' }, async () => ({ switched: true }))
}

test('native primary context uses the fresh active window, not maximum ceiling or input bound', async () => {
  const f = contextFixture()
  expect(await startContext(f)).toEqual({ started: true })
  expect(f.env.get('CLAUDE_CODE_MAX_CONTEXT_TOKENS')).toBe('500000')
  expect(f.contextWrites).toEqual([{ key: 'CLAUDE_CODE_MAX_CONTEXT_TOKENS', value: '500000' }])
  const report = await callbacks.get('command.run')!(f.host, { args: 'status' })
  expect(report.text).toContain('active context 500000')
  expect(report.text).toContain('maximum context 872000')
  expect(report.text).toContain('input bound 470000')
  expect(report.text).toContain('native window 500000')
})

test('native window accepts maximum-only metadata but does not infer missing or invalid context', async () => {
  for (const [context, maximum, expected] of [[null, 64000, '64000'], [null, null, undefined], [0, 64000, undefined], [1.5, null, undefined], [-1, null, undefined]] as const) {
    const f = contextFixture(context, maximum)
    await startContext(f)
    expect(f.env.get('CLAUDE_CODE_MAX_CONTEXT_TOKENS')).toBe(expected)
  }
})

test('native context requires fresh native-provider metadata for the exact selected model', async () => {
  for (const kind of ['unavailable', 'unknown']) {
    const f = contextFixture()
    if (kind === 'unavailable') f.discovery.catalogue.providers[0]!.status = 'unavailable'
    if (kind === 'unknown') f.selection.model = 'codex/undiscovered'
    await startContext(f)
    expect(f.contextWrites).toEqual([])
  }
})

test('native context refresh and model switch use current metadata and preserve hook results', async () => {
  const f = contextFixture()
  await startContext(f)
  f.discovery.catalogue.models[0]!.metadata.contextWindow = 64000
  await callbacks.get('command.run')!(f.host, { args: 'refresh' })
  expect(f.env.get('CLAUDE_CODE_MAX_CONTEXT_TOKENS')).toBe('64000')
  expect(await switchContext(f, 'sonnet')).toEqual({ switched: true })
  expect(f.env.has('CLAUDE_CODE_MAX_CONTEXT_TOKENS')).toBe(false)
  await switchContext(f, 'codex/fresh')
  expect(f.env.get('CLAUDE_CODE_MAX_CONTEXT_TOKENS')).toBe('64000')
})

test('native context resolves configured aliases to their exact fresh model', async () => {
  const f = contextFixture()
  f.files.set('/empty-home/.claude/rice-multi-models.json', JSON.stringify({ providers: { fixture: { kind: 'openai', baseUrl: 'https://fixture.invalid/v1', auth: 'none', models: { fresh: { contextWindow: 128000, maxOutputTokens: 4096 } } } }, aliases: { preferred: 'fixture/fresh' } }))
  f.selection.model = 'preferred'
  f.discovery.catalogue.models[0]!.model = 'fixture/fresh'
  f.discovery.catalogue.providers[0]!.provider = 'fixture'
  await startContext(f)
  expect(f.env.get('CLAUDE_CODE_MAX_CONTEXT_TOKENS')).toBe('500000')
})

test('failed discovery and missing runtime restore the plugin-owned override', async () => {
  for (const failure of ['discovery', 'runtime']) {
    const f = contextFixture()
    await startContext(f)
    if (failure === 'discovery') {
      f.discovery.unavailable = true
      await callbacks.get('command.run')!(f.host, { args: 'refresh' })
    } else {
      f.host.process.run = async () => ({ exitCode: 127, stdout: '', stderr: 'fixture missing runtime' })
      await callbacks.get('command.run')!(f.host, { args: 'setup repair' })
    }
    expect(f.env.has('CLAUDE_CODE_MAX_CONTEXT_TOKENS')).toBe(false)
  }
})

test('repeated startup preserves ownership state rather than capturing its applied override', async () => {
  const f = contextFixture()
  await startContext(f)
  await startContext(f)
  expect(f.contextWrites).toHaveLength(1)
  expect(f.state.get('nativeContext')).toMatchObject({ original: null, applied: '500000' })
  await switchContext(f, 'sonnet')
  expect(f.env.has('CLAUDE_CODE_MAX_CONTEXT_TOKENS')).toBe(false)
})

test('original owner override and subsequent external changes remain authoritative', async () => {
  const f = contextFixture()
  f.env.set('CLAUDE_CODE_MAX_CONTEXT_TOKENS', '123456')
  await startContext(f)
  await switchContext(f, 'sonnet')
  expect(f.env.get('CLAUDE_CODE_MAX_CONTEXT_TOKENS')).toBe('123456')
  expect(f.contextWrites).toEqual([])
  const g = contextFixture()
  await startContext(g)
  g.env.set('CLAUDE_CODE_MAX_CONTEXT_TOKENS', '654321')
  await switchContext(g, 'sonnet')
  await switchContext(g, 'codex/fresh')
  expect(g.env.get('CLAUDE_CODE_MAX_CONTEXT_TOKENS')).toBe('654321')
  expect(g.contextWrites).toHaveLength(1)
})

test('an external override installed during model lookup is not overwritten', async () => {
  const f = contextFixture()
  f.host.session.model = async () => {
    f.env.set('CLAUDE_CODE_MAX_CONTEXT_TOKENS', '123456')
    return f.selection.model
  }
  await startContext(f)
  expect(f.env.get('CLAUDE_CODE_MAX_CONTEXT_TOKENS')).toBe('123456')
  expect(f.contextWrites).toEqual([])
  expect(f.state.get('nativeContext')).toMatchObject({ relinquished: true })
})

test('ownership persistence failure rolls back a context environment mutation', async () => {
  const f = contextFixture()
  const set = f.host.state.set
  let writes = 0
  f.host.state.set = async (...args: any[]) => {
    if (++writes === 2) throw new Error('fixture ownership persistence failure')
    return set(...args)
  }
  expect(await startContext(f)).toEqual({ started: true })
  expect(f.env.has('CLAUDE_CODE_MAX_CONTEXT_TOKENS')).toBe(false)
  expect(f.state.get('nativeContext')).toMatchObject({ original: null, applied: null })
  await callbacks.get('session.end')!(f.host, {}, async () => ({}))
  expect(f.env.has('CLAUDE_CODE_MAX_CONTEXT_TOKENS')).toBe(false)
})

test('disabled compaction prevents automatic native context management', async () => {
  const f = contextFixture()
  f.env.set('DISABLE_COMPACT', '1')
  await startContext(f)
  expect(f.contextWrites).toEqual([])
  f.env.delete('DISABLE_COMPACT')
  await switchContext(f, 'codex/fresh')
  expect(f.env.get('CLAUDE_CODE_MAX_CONTEXT_TOKENS')).toBe('500000')
  f.env.set('DISABLE_COMPACT', '1')
  await switchContext(f, 'codex/fresh')
  expect(f.env.has('CLAUDE_CODE_MAX_CONTEXT_TOKENS')).toBe(false)
  expect(f.env.get('DISABLE_COMPACT')).toBe('1')
})

test('rejected context environment writes do not prevent startup or command registration', async () => {
  const f = contextFixture()
  const set = f.host.env.set
  f.host.env.set = async (key: string, value: string | undefined) => {
    if (key === 'CLAUDE_CODE_MAX_CONTEXT_TOKENS') throw new Error('fixture environment write denied')
    return set(key, value)
  }
  expect(await startContext(f)).toEqual({ started: true })
  expect(f.commands.map(spec => spec.name)).toContain('rice-models')
  expect(f.env.has('CLAUDE_CODE_MAX_CONTEXT_TOKENS')).toBe(false)
  expect((f.state.get('nativeContext') as { applied?: string } | undefined)?.applied).not.toBe('500000')
})

test('session end restores only the override still owned by the plugin', async () => {
  for (const external of [false, true]) {
    const f = contextFixture()
    await startContext(f)
    if (external) f.env.set('CLAUDE_CODE_MAX_CONTEXT_TOKENS', '654321')
    expect(await callbacks.get('session.end')!(f.host, {}, async () => ({ ended: true }))).toEqual({ ended: true })
    expect(f.env.get('CLAUDE_CODE_MAX_CONTEXT_TOKENS')).toBe(external ? '654321' : undefined)
  }
})

test('setup codex alone dispatches the explicit installer and reports its result without a login or approval', async () => {
  const f = fixture()
  const run = f.host.process.run
  f.host.process.run = async (argv: string[], options: any) => argv[2] === 'setup-codex' ? { exitCode: 0, stdout: JSON.stringify({ ok: true, installed: true, login: ['/fixture/node', '/empty-home/.claude/rice-multi-models/cli/node_modules/@openai/codex/bin/codex.js', 'login'] }), stderr: '' } : run(argv, options)
  const result = await callbacks.get('command.run')!(f.host, { args: 'setup codex' })
  expect(result.text).toContain('plugin-owned state (not globally)')
  expect(result.text).toContain('/fixture/node /empty-home/.claude/rice-multi-models/cli/node_modules/@openai/codex/bin/codex.js login')
  expect(result.text).toContain('No login, provider approval or permission change')
  expect(f.store.size).toBe(0)
  expect(f.syncs).toEqual([])
})
