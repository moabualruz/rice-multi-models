import { expect, mock, test } from 'claude-code/testing'

for (const isInteractive of [true, false]) {
  test(`startup keeps repair available without Node (${isInteractive ? 'interactive' : 'headless'})`, async ($, on) => {
    const commands: string[] = []
    const notices: string[] = []
    mock.env(on, { HOME: '/empty-home' })
    on('env.set', () => ({ value: undefined }))
    mock.store(on)
    mock.clock(on, { now: 1_800_000_000_000 })
    on('session.start', (_host, input) => ({ cwd: input.cwd }))
    on('session.cwd', () => ({ value: '/fixture' }))
    on('session.version', () => ({ value: { version: '2.1.296' } }))
    on('fs.exists', () => ({ value: false }))
    on('fs.read', () => { throw new Error('ENOENT fixture') })
    on('fs.list', () => ({ value: [] }))
    on('fs.write', () => { throw new Error('Missing-runtime startup must not write files') })
    on('process.run', () => ({ value: { exitCode: 127, stdout: '', stderr: 'executable unavailable', isStdoutTruncated: false, isStderrTruncated: false } }))
    on('process.spawn', async function* () { throw new Error('Missing-runtime startup must not launch a helper') })
    on('command.register', (_host, input) => { commands.push(input.name); return { value: { command: input.name } } })
    on('tool.register', (_host, input) => ({ value: { tool: input.name } }))
    on('agent.register', (_host, input) => ({ value: { agent: input.name } }))
    on('ui.log', (_host, input) => { if (input.to === 'transcript') notices.push(input.text); return { value: undefined } })
    on('ui.status', () => ({ value: undefined }))
    on('ui.toast', () => ({ value: undefined }))
    await $.session.start({ cwd: '/fixture', surface: isInteractive ? 'terminal' : null, isInteractive })
    expect(commands).toContain('rice-models')
    if (isInteractive) {
      expect(notices.join('\n')).toMatch(/Node/i)
      expect(notices.join('\n')).toContain('/rice-models setup')
      expect(notices.every(text => !text.includes('\n'))).toBe(true)
    } else {
      expect(notices).toEqual([])
    }
  })
}

test('native startup refreshes catalogue and exposes factual metadata without a host capability alias', async ($, on) => {
  let discoveries = 0
  const synced: any[] = []
  const notices: string[] = []
  const metadata = { contextWindow: 500000, maxContextWindow: 872000, inputTokenLimit: null, outputTokenLimit: null, autoCompactTokenLimit: null, inputModalities: ['text', 'image'], reasoningEfforts: ['low', 'high'], tools: null, parallelToolCalls: null }
  const catalogue = { models: [{ model: 'codex/fresh-native', label: 'Fresh native', execution: 'native provider', source: 'fixture models endpoint', observedAt: 1800000000000, metadata }], providers: [{ provider: 'codex', status: 'fresh', source: 'fixture models endpoint', observedAt: 1800000000000 }] }
  const info = { node: { supported: true, executable: '/fixture/node', version: '22.23.3' }, platform: 'linux', home: '/fixture', configDir: '/fixture/.claude', codexHome: '/fixture/.codex', opencodeAuthFile: '/fixture/opencode/auth.json', clis: { codex: '/fixture/codex' }, auth: { codex: true, opencode: false } }
  const environment = new Map<string, string>([['HOME', '/fixture']])
  const contextWrites: (string | undefined)[] = []
  let selectedModel = 'codex/fresh-native'
  let nativeCompactions = 0
  on('session.compact', () => { nativeCompactions++; return { messages: [{ role: 'user', text: 'native fixture summary', toolUses: [] }] } })
  on('classic.PreModelSwitch', () => ({ permissionDecision: 'allow' }))
  on('env.get', (_host, input) => ({ value: environment.get(input.name) }))
  on('env.set', (_host, input) => {
    if (input.name === 'CLAUDE_CODE_MAX_CONTEXT_TOKENS') contextWrites.push(input.value)
    if (input.value === undefined) environment.delete(input.name)
    else environment.set(input.name, input.value)
    return { value: undefined }
  })
  on('session.model', () => ({ value: selectedModel }))
  on('classic.PostModelSwitch', () => ({}))
  mock.store(on)
  mock.clock(on, { now: 1800000000000 })
  on('state.get', { plugin: 'rice-multi-models', key: 'prefs' }, () => ({ value: { value: { effort: null, transport: 'auto', helper: 'once' }, version: 1 } }))
  on('session.start', (_host, input) => ({ cwd: input.cwd }))
  // Native Windows resolves fs event paths with backslashes, including this
  // copied plugin's helper path. Only the synthetic file-matching oracle varies.
  on('fs.exists', (_host, input) => ({ value: input.path.replaceAll('\\', '/').endsWith('/dist/helper.mjs') }))
  on('fs.read', () => { throw new Error('ENOENT fixture') })
  on('process.run', (_host, input) => {
    let value: unknown
    if (input.argv.includes('-e')) value = { executable: '/fixture/node', version: '22.23.3' }
    else if (input.argv.includes('doctor')) value = info
    else if (input.argv.includes('discover')) { discoveries++; value = catalogue }
    else if (input.argv.includes('sync-picker')) { synced.push(JSON.parse(input.init?.stdin || '{}')); value = { ok: true, changed: true, count: 1, path: '/fixture/.claude/settings.json' } }
    else throw new Error('Unexpected fixture process')
    return { value: { exitCode: 0, stdout: JSON.stringify(value), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', (_host, input) => ({ value: { command: input.name } }))
  on('tool.register', (_host, input) => ({ value: { tool: input.name } }))
  on('agent.register', (_host, input) => ({ value: { agent: input.name } }))
  on('ui.log', (_host, input) => { if (input.to === 'transcript') notices.push(input.text); return { value: undefined } })
  await $.session.start({ cwd: '/fixture', surface: 'terminal', isInteractive: true })
  expect(discoveries).toBe(1)
  expect(synced[0].rows[0].description).toContain('reported context 500000')
  expect(synced[0].rows[0].behavesAs).toBeUndefined()
  expect(notices.join('\n')).toContain('codex: fresh')
  const report = await $.command.run({ command: 'rice-models', args: 'models' })
  expect(String(report.text)).toContain('872000')
  expect(discoveries).toBe(1)
  expect(environment.get('CLAUDE_CODE_MAX_CONTEXT_TOKENS')).toBeUndefined()
  await $.session.start({ cwd: '/fixture', surface: 'terminal', isInteractive: true })
  expect(contextWrites).toEqual([])
  const switchRequest = { from_model: 'sonnet', to_model: 'codex/fresh-native', requested_model: 'codex/fresh-native', source: 'sdk', context_tokens: 500001, prompt_cache_warm: false, cache_ttl: '1h', estimated_cache_write_usd: 0, pricing: 'default' } as const
  // Model switches are the host's decision; the mod adds no budget denial.
  const passed = await $.classic.PreModelSwitch(switchRequest)
  expect(passed.permissionDecision).toBe('allow')
  expect(contextWrites).toEqual([])
  selectedModel = 'sonnet'
  await $.classic.PostModelSwitch({ from_model: 'codex/fresh-native', to_model: 'sonnet', requested_model: 'sonnet', source: 'sdk', context_tokens: 0, prompt_cache_warm: false, cache_ttl: '1h', estimated_cache_write_usd: 0, pricing: 'default' })
  expect(environment.get('CLAUDE_CODE_MAX_CONTEXT_TOKENS')).toBeUndefined()
  expect(contextWrites).toEqual([])
  const native = await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'native fixture history', toolUses: [] }] })
  expect(native.messages).toEqual([{ role: 'user', text: 'native fixture summary', toolUses: [] }])
  expect(nativeCompactions).toBe(1)
})
