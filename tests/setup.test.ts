import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink, chmod } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pickerLockPort, syncPicker } from '../helper/picker-settings'
import { setupInfo, setupCodex } from '../helper/setup-info'
import { opencodeEntries, opencodeKey } from '../helper/opencode-auth'
import { absoluteExecutable, commandText, detectRuntime, setupSummary, startupNotice } from '../hooks/setup'
import { parseConfig } from '../hooks/config'
import { unknownMetadata, type ModelCatalogue } from '../hooks/catalogue'
import { nativeModelEnv, nativeModelSettings } from '../hooks/picker'

test('displayed login commands preserve shell metacharacters and use PowerShell invocation on Windows', () => {
  expect(commandText(['C:\\Program Files\\nodejs\\node.exe', "C:\\User's files\\codex.js", 'login'], 'win32')).toBe("& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\User''s files\\codex.js' 'login'")
  if (process.platform === 'win32') return
  const argument = "/space folder/$HOME`not-a-command`/quote's\\name"
  const command = commandText([process.execPath, '-p', 'JSON.stringify(process.argv.slice(1))', argument])
  expect(Bun.spawnSync(['/bin/bash', '-n', '-c', command]).exitCode).toBe(0)
  const result = Bun.spawnSync(['/bin/bash', '-c', command])
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout.toString())).toEqual([argument])
})

const rows = [{ model: 'codex/gpt-6.1-sol', label: 'Codex default' }, { model: 'local/qwen', label: 'Qwen' }]
async function temporary(work: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'rice-setup-test-'))
  try { await work(dir) } finally { await rm(dir, { force: true, recursive: true }) }
}

test('picker sync owns exact generated rows, preserves custom prefixed rows and unrelated settings, and is idempotent', async () => temporary(async configDir => {
  const custom = [{ model: 'codex/custom', label: 'My personal route' }, { model: 'local/qwen', label: 'My Qwen label', extra: true }]
  const settings = { permissions: { allow: ['Read'] }, providers: { private: 'unchanged' }, modelPicker: { customOption: 42, options: custom } }
  await writeFile(path.join(configDir, 'settings.json'), JSON.stringify(settings))
  expect(await syncPicker({ configDir, rows })).toMatchObject({ ok: true, changed: true, count: 1, preserved: 2 })
  const text = await readFile(path.join(configDir, 'settings.json'), 'utf8')
  expect(JSON.parse(text)).toEqual({ ...settings, modelPicker: { ...settings.modelPicker, options: [...custom, rows[0]] } })
  expect(await syncPicker({ configDir, rows })).toMatchObject({ ok: true, changed: false, count: 1 })
  expect(await readFile(path.join(configDir, 'settings.json'), 'utf8')).toBe(text)
  expect(await syncPicker({ configDir, rows: [] })).toMatchObject({ ok: true, count: 0 })
  expect(JSON.parse(await readFile(path.join(configDir, 'settings.json'), 'utf8')).modelPicker.options).toEqual(custom)
}))

test('native model settings fill only their own keys, keep the person\'s values and leave with the model', async () => temporary(async configDir => {
  const file = path.join(configDir, 'settings.json')
  await writeFile(file, JSON.stringify({ modelSettings: { 'local/qwen': { effortLevel: 'low' }, 'claude-opus-5-5': { maxEffortLevel: 'medium' } } }))
  const modelSettings = { 'codex/gpt-6.1-sol': { autoCompactWindow: 500000 }, 'local/qwen': { autoCompactWindow: 128000, maxEffortLevel: 'high' } }
  expect(await syncPicker({ configDir, rows, modelSettings })).toMatchObject({ ok: true, changed: true })
  expect(JSON.parse(await readFile(file, 'utf8')).modelSettings).toEqual({
    'local/qwen': { effortLevel: 'low', autoCompactWindow: 128000, maxEffortLevel: 'high' },
    'claude-opus-5-5': { maxEffortLevel: 'medium' },
    'codex/gpt-6.1-sol': { autoCompactWindow: 500000 },
  })
  // The person's own change to a filled key is kept from then on.
  const edited = JSON.parse(await readFile(file, 'utf8'))
  edited.modelSettings['local/qwen'].autoCompactWindow = 200000
  await writeFile(file, JSON.stringify(edited))
  await syncPicker({ configDir, rows, modelSettings: { ...modelSettings, 'local/qwen': { autoCompactWindow: 131072, maxEffortLevel: 'medium' } } })
  expect(JSON.parse(await readFile(file, 'utf8')).modelSettings['local/qwen']).toEqual({ effortLevel: 'low', autoCompactWindow: 200000, maxEffortLevel: 'medium' })
  // A model no longer discovered loses only what the mod wrote.
  await syncPicker({ configDir, rows: [], modelSettings: {} })
  expect(JSON.parse(await readFile(file, 'utf8')).modelSettings).toEqual({ 'local/qwen': { effortLevel: 'low', autoCompactWindow: 200000 }, 'claude-opus-5-5': { maxEffortLevel: 'medium' } })
}))

test('the env block and per-model settings are written for Claude\'s next launch and keep the person\'s own values', async () => temporary(async configDir => {
  const file = path.join(configDir, 'settings.json')
  await writeFile(file, JSON.stringify({ env: { FOO: '1', CLAUDE_CODE_MODEL_CAPABILITIES: 'mine=effort' }, modelSettings: { 'Codex/Fresh': { autoCompactWindow: 128000 }, 'local/route-20261024': { autoCompactWindow: 200000 }, 'local/wide[1m]': { autoCompactWindow: 180000 }, 'Local/Tuned-20261024': { effortLevel: 'xhigh' }, 'Local/Bare': {} } }))
  const env = { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '500000', CLAUDE_CODE_MODEL_CAPABILITIES: 'codex/fresh=effort' }
  const modelSettings = { 'codex/fresh': { autoCompactWindow: 500000 }, 'local/route': { autoCompactWindow: 400000 }, 'local/wide': { autoCompactWindow: 600000 }, 'local/tuned': { maxEffortLevel: 'high' }, 'local/bare': { autoCompactWindow: 700000 }, 'local/other': { autoCompactWindow: 300000 } }
  expect(await syncPicker({ configDir, rows, modelSettings, env })).toMatchObject({ ok: true, changed: true })
  let written = JSON.parse(await readFile(file, 'utf8'))
  // The person's own value and their entry under another spelling of the same model stay theirs.
  expect(written.env).toEqual({ FOO: '1', CLAUDE_CODE_MODEL_CAPABILITIES: 'mine=effort', CLAUDE_CODE_MAX_CONTEXT_TOKENS: '500000' })
  // The person's entry holds a key the mod does not fill, or none, and still no key is added beside it for that model.
  expect(written.modelSettings).toEqual({ 'Codex/Fresh': { autoCompactWindow: 128000 }, 'local/route-20261024': { autoCompactWindow: 200000 }, 'local/wide[1m]': { autoCompactWindow: 180000 }, 'Local/Tuned-20261024': { effortLevel: 'xhigh' }, 'Local/Bare': {}, 'local/other': { autoCompactWindow: 300000 } })
  // A later sync updates only what the mod wrote, and removes it when the data is gone.
  await syncPicker({ configDir, rows, modelSettings: { 'local/other': { autoCompactWindow: 250000 } }, env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '250000' } })
  written = JSON.parse(await readFile(file, 'utf8'))
  expect(written.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('250000')
  expect(written.modelSettings['local/other']).toEqual({ autoCompactWindow: 250000 })
  await syncPicker({ configDir, rows: [] })
  written = JSON.parse(await readFile(file, 'utf8'))
  expect(written.env).toEqual({ FOO: '1', CLAUDE_CODE_MODEL_CAPABILITIES: 'mine=effort' })
  expect(written.modelSettings).toEqual({ 'Codex/Fresh': { autoCompactWindow: 128000 }, 'local/route-20261024': { autoCompactWindow: 200000 }, 'local/wide[1m]': { autoCompactWindow: 180000 }, 'Local/Tuned-20261024': { effortLevel: 'xhigh' }, 'Local/Bare': {} })
}))

test('provider data never raises a cap the settings file sets itself', async () => temporary(async configDir => {
  const file = path.join(configDir, 'settings.json')
  await writeFile(file, JSON.stringify({ maxEffortLevel: 'medium', autoCompactWindow: 200000 }))
  // Claude lets a per-model value replace the file's own top-level one, so only a lower value is written.
  const modelSettings = { 'local/big': { autoCompactWindow: 500000, maxEffortLevel: 'high' }, 'local/small': { autoCompactWindow: 128000, maxEffortLevel: 'low' } }
  expect(await syncPicker({ configDir, rows, modelSettings })).toMatchObject({ ok: true })
  const written = JSON.parse(await readFile(file, 'utf8'))
  expect([written.maxEffortLevel, written.autoCompactWindow]).toEqual(['medium', 200000])
  expect(written.modelSettings).toEqual({ 'local/small': { autoCompactWindow: 128000, maxEffortLevel: 'low' } })
}))

test('catalogue data maps to Claude\'s native per-model fields and leaves unknown data to Claude', () => {
  const metadata = (contextWindow: number | null, reasoningEfforts: string[] | null) => ({ ...unknownMetadata(), contextWindow, reasoningEfforts })
  const catalogue = {
    models: [
      { model: 'codex/gpt-6.1-sol', label: 'Sol', execution: 'native provider', source: 'fixture', observedAt: 1, metadata: metadata(500000, ['low', 'medium', 'high', 'xhigh']) },
      { model: 'local/qwen', label: 'Qwen', execution: 'native provider', source: 'fixture', observedAt: 1, metadata: metadata(64000, ['low', 'high']) },
      { model: 'local/plain', label: 'Plain', execution: 'native provider', source: 'fixture', observedAt: 1, metadata: metadata(null, []) },
      { model: 'local/unknown', label: 'Unknown', execution: 'native provider', source: 'fixture', observedAt: 1, metadata: metadata(null, null) },
      // Claude reads this id as its own claude-sonnet-4-6: its settings would change that model's, and Claude's own window data applies to it.
      { model: 'opencode/claude-sonnet-4-6', label: 'Routed Sonnet', execution: 'native provider', source: 'fixture', observedAt: 1, metadata: metadata(900000, ['low', 'high']) },
    ],
    providers: [],
  } as ModelCatalogue
  expect(nativeModelSettings(catalogue)).toEqual({ 'codex/gpt-6.1-sol': { autoCompactWindow: 500000 }, 'local/qwen': { maxEffortLevel: 'high' } })
  expect(nativeModelEnv(catalogue)).toEqual({
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: '500000',
    CLAUDE_CODE_MODEL_CAPABILITIES: 'codex/gpt-6.1-sol=effort,xhigh_effort,-max_effort;local/qwen=effort,-xhigh_effort,-max_effort;local/plain=-effort;opencode/claude-sonnet-4-6=effort,-xhigh_effort,-max_effort',
  })
  expect(nativeModelEnv({ models: [], providers: [] })).toEqual({})
  // An alias is a model id of its own to Claude: it carries its target's fields, and nothing when its target has none.
  // An alias that only contains "claude-" names no Claude model, so it is an id of its own too.
  const aliases = { preferred: 'local/qwen', quiet: 'local/unknown', steady: 'opencode/claude-sonnet-4-6', 'my-claude-route': 'codex/gpt-6.1-sol' }
  expect(nativeModelSettings(catalogue, aliases)).toEqual({ 'codex/gpt-6.1-sol': { autoCompactWindow: 500000 }, 'local/qwen': { maxEffortLevel: 'high' }, preferred: { maxEffortLevel: 'high' }, steady: { autoCompactWindow: 900000, maxEffortLevel: 'high' }, 'my-claude-route': { autoCompactWindow: 500000 } })
  expect(nativeModelEnv(catalogue, aliases)).toEqual({
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: '900000',
    CLAUDE_CODE_MODEL_CAPABILITIES: 'codex/gpt-6.1-sol=effort,xhigh_effort,-max_effort;local/qwen=effort,-xhigh_effort,-max_effort;local/plain=-effort;opencode/claude-sonnet-4-6=effort,-xhigh_effort,-max_effort;preferred=effort,-xhigh_effort,-max_effort;steady=effort,-xhigh_effort,-max_effort;my-claude-route=effort,xhigh_effort,-max_effort',
  })
})

test('picker sync never adds an empty picker block to settings that had none', async () => temporary(async configDir => {
  const settings = { permissions: { allow: ['Read'] }, autoMode: { classifyAllShell: true } }
  await writeFile(path.join(configDir, 'settings.json'), JSON.stringify(settings))
  expect(await syncPicker({ configDir, rows: [] })).toMatchObject({ ok: true, changed: false, count: 0 })
  expect(JSON.parse(await readFile(path.join(configDir, 'settings.json'), 'utf8'))).toEqual(settings)
}))

test('edited generated rows lose ownership permanently and survive repair and provider removal', async () => temporary(async configDir => {
  await syncPicker({ configDir, rows })
  const file = path.join(configDir, 'settings.json')
  const settings = JSON.parse(await readFile(file, 'utf8'))
  settings.modelPicker.options[0].label = 'My edited model'
  settings.modelPicker.options[0].description = 'Keep this'
  await writeFile(file, JSON.stringify(settings))
  await syncPicker({ configDir, rows: [{ ...rows[0]!, label: 'New plugin label' }] })
  const edited = JSON.parse(await readFile(file, 'utf8')).modelPicker.options
  expect(edited).toEqual([{ ...rows[0], label: 'My edited model', description: 'Keep this' }])
  await syncPicker({ configDir, rows: [] })
  expect(JSON.parse(await readFile(file, 'utf8')).modelPicker.options).toEqual(edited)
  expect(JSON.parse(await readFile(path.join(configDir, '.rice-multi-models-picker.json'), 'utf8')).edited).toEqual(['codex/gpt-6.1-sol'])
}))

test('upgrades migrate exact pre-0.6 generated Sonnet aliases to the discovered catalogue', async () => temporary(async configDir => {
  const legacy = [
    { model: 'codex/gpt-6.1-sol', label: 'GPT-6.1-Sol (Codex)', description: 'ChatGPT subscription via rice-multi-models, 500k context', behavesAs: 'claude-sonnet-4-6' },
    { model: 'local/qwen', label: 'qwen (local)', description: 'openai endpoint http://localhost:8080 via rice-multi-models, 128k context', behavesAs: 'claude-sonnet-4-6' },
  ]
  const custom = [
    { ...legacy[0], model: 'codex/personal', label: 'My personal model' },
    { ...legacy[1], model: 'local/edited', label: 'edited (local)', extra: true },
    { model: 'custom/one', label: 'My custom route', description: 'Custom provider signature', behavesAs: 'claude-sonnet-4-6' },
  ]
  const file = path.join(configDir, 'settings.json')
  const settings = { permissions: { allow: ['Read'] }, modelPicker: { customOption: 42, options: [...legacy, ...custom] } }
  await writeFile(file, JSON.stringify(settings))
  expect(await syncPicker({ configDir, rows })).toMatchObject({ ok: true, changed: true, count: 2, preserved: 3 })
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ ...settings, modelPicker: { ...settings.modelPicker, options: [...custom, ...rows] } })
  expect(await syncPicker({ configDir, rows })).toMatchObject({ ok: true, changed: false })
  await syncPicker({ configDir, rows: [] })
  expect(JSON.parse(await readFile(file, 'utf8')).modelPicker.options).toEqual(custom)
}))

test('explicitly edited ownership prevents legacy migration', async () => temporary(async configDir => {
  const legacy = { model: 'codex/gpt-6.1-sol', label: 'GPT-6.1-Sol (Codex)', description: 'ChatGPT subscription via rice-multi-models, 500k context', behavesAs: 'claude-sonnet-4-6' }
  await writeFile(path.join(configDir, 'settings.json'), JSON.stringify({ modelPicker: { options: [legacy] } }))
  await writeFile(path.join(configDir, '.rice-multi-models-picker.json'), JSON.stringify({ version: 1, rows: [], edited: [legacy.model] }))
  expect(await syncPicker({ configDir, rows })).toMatchObject({ ok: true, preserved: 1 })
  expect(JSON.parse(await readFile(path.join(configDir, 'settings.json'), 'utf8')).modelPicker.options[0]).toEqual(legacy)
}))

test('concurrent picker sessions serialize rereads and never duplicate or truncate rows', async () => temporary(async configDir => {
  await writeFile(path.join(configDir, 'settings.json'), JSON.stringify({ modelPicker: { options: [{ model: 'codex/personal', label: 'Personal' }] }, unrelated: 17 }))
  const results = await Promise.all(Array.from({ length: 20 }, () => syncPicker({ configDir, rows })))
  expect(results.every(result => result.ok)).toBe(true)
  const settings = JSON.parse(await readFile(path.join(configDir, 'settings.json'), 'utf8'))
  expect(settings.unrelated).toBe(17)
  expect(settings.modelPicker.options.map((row: any) => row.model)).toEqual(['codex/personal', ...rows.map(row => row.model)])
  expect((await readdir(configDir)).some(name => name.endsWith('.tmp') || name.endsWith('.lock'))).toBe(false)
}))

test('a failed discovery leaves the rows it wrote, while a provider without rows does not hold the sync back', async () => temporary(async configDir => {
  const file = path.join(configDir, 'settings.json')
  await syncPicker({ configDir, rows, modelSettings: { 'codex/gpt-6.1-sol': { autoCompactWindow: 400000 } } })
  const written = await readFile(file, 'utf8')
  for (const unavailable of [['codex'], ['runtime'], ['configured']]) {
    const result = await syncPicker({ configDir, rows: [], unavailable })
    expect(result).toMatchObject({ ok: false, changed: false })
    expect(result.error).toContain('/rice-models refresh')
    expect(await readFile(file, 'utf8')).toBe(written)
  }
  expect(await syncPicker({ configDir, rows, unavailable: ['bedrock'] })).toMatchObject({ ok: true })
  expect(await syncPicker({ configDir, rows: rows.slice(1), unavailable: ['bedrock'] })).toMatchObject({ ok: true, changed: true })
  expect(JSON.parse(await readFile(file, 'utf8')).modelPicker.options.map((row: any) => row.model)).toEqual(['local/qwen'])
}))

test('a failed discovery keeps the model data it wrote for a provider whose row the person edited', async () => temporary(async configDir => {
  const file = path.join(configDir, 'settings.json')
  const modelSettings = { 'codex/gpt-6.1-sol': { autoCompactWindow: 400000 } }
  await syncPicker({ configDir, rows, modelSettings })
  const settings = JSON.parse(await readFile(file, 'utf8'))
  settings.modelPicker.options[0].label = 'My Sol'
  await writeFile(file, JSON.stringify(settings))
  await syncPicker({ configDir, rows, modelSettings })
  const written = await readFile(file, 'utf8')
  expect(JSON.parse(written).modelSettings['codex/gpt-6.1-sol']).toEqual({ autoCompactWindow: 400000 })
  expect(await syncPicker({ configDir, rows: rows.slice(1), unavailable: ['codex'] })).toMatchObject({ ok: false, changed: false })
  expect(await readFile(file, 'utf8')).toBe(written)
}))

test('a failed discovery keeps the model data it wrote for an alias of that provider', async () => temporary(async configDir => {
  const file = path.join(configDir, 'settings.json')
  const aliases = { steady: 'opencode/claude-sonnet-4-6' }
  const modelSettings = { steady: { autoCompactWindow: 300000 } }
  await syncPicker({ configDir, rows: [{ model: 'steady', label: 'Steady' }], modelSettings, aliases })
  const settings = JSON.parse(await readFile(file, 'utf8'))
  settings.modelPicker.options[0].label = 'My Steady'
  await writeFile(file, JSON.stringify(settings))
  await syncPicker({ configDir, rows: [{ model: 'steady', label: 'Steady' }], modelSettings, aliases })
  const written = await readFile(file, 'utf8')
  expect(JSON.parse(written).modelSettings.steady).toEqual({ autoCompactWindow: 300000 })
  expect(await syncPicker({ configDir, rows: [], unavailable: ['opencode'], aliases })).toMatchObject({ ok: false, changed: false })
  expect(await readFile(file, 'utf8')).toBe(written)
}))

test('a failed discovery keeps the env it wrote even when it owns no row or model setting', async () => temporary(async configDir => {
  const file = path.join(configDir, 'settings.json')
  await syncPicker({ configDir, rows: [], env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '500000' } })
  const written = await readFile(file, 'utf8')
  expect(JSON.parse(written).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('500000')
  expect(await syncPicker({ configDir, rows: [], env: {}, unavailable: ['codex', 'opencode', 'runtime'] })).toMatchObject({ ok: false, changed: false })
  expect(await readFile(file, 'utf8')).toBe(written)
}))

test('a lock whose holder was killed never blocks a later sync', async () => temporary(async configDir => {
  const port = pickerLockPort(configDir)
  const holder = Bun.spawn([process.execPath, '-e', `require('node:net').createServer().listen({ host: '127.0.0.1', port: ${port}, exclusive: true }, () => console.log('held'))`], { stdout: 'pipe' })
  const reader = holder.stdout.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('held')
  holder.kill('SIGKILL')
  await holder.exited
  const started = Date.now()
  expect(await syncPicker({ configDir, rows })).toMatchObject({ ok: true, count: rows.length })
  expect(Date.now() - started).toBeLessThan(2_000)
  expect((await readdir(configDir)).some(name => name.includes('.lock') || name.endsWith('.tmp'))).toBe(false)
}))

test('a sync waits while another writer holds the lock and runs once it lets go', async () => temporary(async configDir => {
  const holder = createServer()
  await new Promise<void>(resolve => holder.listen({ host: '127.0.0.1', port: pickerLockPort(configDir), exclusive: true }, resolve))
  const started = Date.now()
  const pending = syncPicker({ configDir, rows })
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(await readdir(configDir)).not.toContain('settings.json')
  await new Promise(resolve => holder.close(resolve))
  expect(await pending).toMatchObject({ ok: true, count: rows.length })
  expect(Date.now() - started).toBeGreaterThanOrEqual(300)
}))

test('malformed settings or ownership records are never overwritten', async () => temporary(async configDir => {
  const file = path.join(configDir, 'settings.json')
  for (const text of ['{ broken', '[]', '{"modelPicker":null}', '{"modelPicker":{"options":{}}}']) {
    await writeFile(file, text)
    expect(await syncPicker({ configDir, rows })).toMatchObject({ ok: false, changed: false })
    expect(await readFile(file, 'utf8')).toBe(text)
  }
  const valid = '{"keep":true}'
  await writeFile(file, valid)
  await writeFile(path.join(configDir, '.rice-multi-models-picker.json'), '{ broken ownership')
  expect(await syncPicker({ configDir, rows })).toMatchObject({ ok: false, changed: false })
  expect(await readFile(file, 'utf8')).toBe(valid)
}))

test('setup metadata honors HOME USERPROFILE and config overrides without reading secrets or creating files', async () => temporary(async home => {
  const codexHome = path.join(home, 'custom-codex')
  const data = path.join(home, 'custom-data')
  await mkdir(codexHome)
  await mkdir(path.join(data, 'opencode'), { recursive: true })
  await writeFile(path.join(codexHome, 'auth.json'), 'not JSON secret-token')
  await writeFile(path.join(data, 'opencode', 'auth.json'), JSON.stringify({ opencode: { key: 'private-console-secret' } }))
  const before = (await readdir(home)).sort()
  const info = await setupInfo({ USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, 'claude-override'), CODEX_HOME: codexHome, XDG_DATA_HOME: data, PATH: '' })
  expect(info).toMatchObject({ home, codexHome, configDir: path.join(home, 'claude-override'), auth: { codex: true, opencode: true }, nodeVersion: process.versions.node, executable: process.execPath })
  expect(JSON.stringify(info)).not.toContain('secret')
  expect((await readdir(home)).sort()).toEqual(before)
  expect((await setupInfo({ HOME: home, USERPROFILE: '/ignored', PATH: '' })).home).toBe(home)
}))

test('OpenCode metadata only lists keys and explicit key mode obeys preferred tier without leaking errors', async () => temporary(async dir => {
  const file = path.join(dir, 'auth.json')
  await writeFile(file, JSON.stringify({ opencode: { key: 'zen-secret' }, 'opencode-go': { key: 'go-secret' }, unrelated: { key: 'other-secret' } }))
  expect(await opencodeEntries(file)).toEqual(['opencode', 'opencode-go', 'unrelated'])
  expect(await opencodeKey('zen', file)).toBe('zen-secret')
  expect(await opencodeKey('go', file)).toBe('go-secret')
  await writeFile(file, JSON.stringify({ opencode: { key: 'zen-secret' } }))
  expect(await opencodeKey('go', file)).toBe('zen-secret')
  await writeFile(file, 'bad secret contents')
  await expect(opencodeEntries(file)).rejects.toThrow('malformed or unreadable')
  await expect(opencodeKey('go', file)).rejects.toThrow('missing, malformed or unreadable')
  expect(await opencodeEntries(path.join(dir, 'absent.json'))).toEqual([])
}))

test('runtime probe rejects relative and outdated Node overrides and accepts drive/UNC executable paths', async () => {
  expect(absoluteExecutable('C:\\Program Files\\nodejs\\node.exe')).toBe(true)
  expect(absoluteExecutable('\\\\server\\share\\node.exe')).toBe(true)
  expect(absoluteExecutable('C:node.exe')).toBe(false)
  let runs = 0
  const relative: any = { helper: '/fixture/helper.mjs', override: 'node', run: async () => { runs++ }, exists: async () => true }
  expect((await detectRuntime(relative)).error).toContain('absolute')
  expect(runs).toBe(0)
  const outdated: any = { helper: '/fixture/helper.mjs', exists: async () => true, run: async () => ({ exitCode: 0, stdout: '{"executable":"/node","version":"20.19.0"}', stderr: '' }) }
  expect((await detectRuntime(outdated)).error).toContain('too old')
  for (const command of [['C:\\Program Files\\nodejs\\node.exe', 'helper.mjs'], ['\\\\server\\share\\helper.exe']]) {
    const result = parseConfig(JSON.stringify({ providers: { local: { kind: 'openai', baseUrl: 'https://fixture.invalid/v1', auth: { command }, models: { qwen: { contextWindow: 128000, maxOutputTokens: 4096 } } } } }))
    expect(result.errors).toEqual([])
  }
})

test('startup notice has no invented default and includes fresh source status and native window explanations', async () => {
  const runtime = { executable: '/node', version: '22.23.3', info: { node: { executable: '/node', version: '22.23.3', supported: true }, platform: 'linux', home: '/home', configDir: '/home/.claude', codexHome: '/home/.codex', opencodeAuthFile: '/home/opencode/auth.json', clis: {}, auth: { codex: false, opencode: false } } }
  const picker = { ok: true, changed: false, count: 0, path: '/home/.claude/settings.json' }
  const summary = setupSummary(runtime, picker)
  expect(summary).toContain('No Codex model was discovered')
  expect(summary).not.toContain('/model codex/')
  expect(summary).not.toContain('/model undefined')
  expect(summary).toContain('native /model picker row')
  expect(summary).toContain('modelSettings.<id>.autoCompactWindow')
  expect(summary).toContain('modelSettings.<id>.maxEffortLevel')
  expect(summary).toContain('CLAUDE_CODE_MODEL_CAPABILITIES')
  expect(summary).toContain('CLAUDE_CODE_MAX_CONTEXT_TOKENS holds the largest reported window')
  expect(summary).toContain('An owner\'s own value stays authoritative')
  expect(summary).toContain('compaction stay Claude\'s own, per agent')
  expect(summary).toContain('applies no model-switch denial or request-input guard')
  expect(summary).not.toContain('200k fallback')
  expect(summary).toContain('Start the normal claude command')
  expect(summary).toContain('supported session.compact hook')
  expect(summary).not.toContain('rice-claude')
  const state = new Map<string, unknown>()
  const logs: string[] = []
  const port = { get: async (key: string) => state.get(key), set: async (key: string, value: unknown) => { state.set(key, value) }, log: (text: string) => { logs.push(text) } }
  await startupNotice(port, false, runtime, picker, [], undefined, 'codex: unavailable (auth-unavailable)')
  expect(state.size).toBe(0)
  await startupNotice(port, true, runtime, picker, [], undefined, 'codex: unavailable (auth-unavailable)')
  await startupNotice(port, true, runtime, picker, [], undefined, 'codex: unavailable (auth-unavailable)')
  expect(logs).toHaveLength(1)
  expect(logs[0]).toContain('auth-unavailable')
  await startupNotice(port, true, runtime, picker, rows, rows[0]!.model, 'codex: fresh')
  expect(logs).toHaveLength(2)
  expect(logs[1]).toContain(`/model ${rows[0]!.model}`)
})

const verifiedCodexMetadata = {
  name: '@openai/codex', version: '0.162.1',
  repository: { url: 'git+https://github.com/openai/codex.git' },
  dist: { integrity: 'sha512-NWZdi/kxyjv/8EUGFupziGU38YyleugZRM4JXgY5XFH7FUmaFA33NZS2Bmq0HPazf7S3jJQQWsZ/jAK9jsrV3Q==' },
  bin: { codex: 'bin/codex.js' },
  optionalDependencies: { [`@openai/codex-${process.platform}-${process.arch}`]: `npm:@openai/codex@0.162.1-${process.platform}-${process.arch}` },
}

async function fakeNpm(home: string, metadata: unknown): Promise<{ env: NodeJS.ProcessEnv; installMarker: string }> {
  const bin = path.join(home, 'bin')
  await mkdir(bin, { recursive: true })
  const script = process.platform === 'win32' ? path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js') : path.join(bin, 'npm-cli.js')
  await mkdir(path.dirname(script), { recursive: true })
  const installMarker = path.join(home, 'fake-install-called')
  await writeFile(script, `#!/usr/bin/env node\nconst fs = require('node:fs');\nif (process.argv[2] === 'view') { console.log(${JSON.stringify(JSON.stringify(metadata))}); } else if (process.argv[2] === 'install') { fs.writeFileSync(${JSON.stringify(installMarker)}, 'fake install only'); process.exit(1); } else { process.exit(2); }\n`)
  await chmod(script, 0o755)
  if (process.platform === 'win32') await writeFile(path.join(bin, 'npm.cmd'), 'fake npm launcher, never executed')
  else await symlink(script, path.join(bin, 'npm'))
  return { env: { HOME: home, USERPROFILE: home, PATH: bin }, installMarker }
}

test('verified object and singleton npm metadata reach the scoped install phase without invoking real npm', async () => {
  for (const metadata of [verifiedCodexMetadata, [verifiedCodexMetadata]]) {
    await temporary(async home => {
      const { env, installMarker } = await fakeNpm(home, metadata)
      const result = await setupCodex(env)
      expect(result).toMatchObject({ ok: false, installed: false })
      expect(result.error).toContain('Scoped Codex CLI install failed')
      expect(result.error).not.toContain('metadata did not match')
      expect(await readFile(installMarker, 'utf8')).toBe('fake install only')
    })
  }
})

test('ambiguous and nonobject npm metadata cannot reach the install phase', async () => {
  for (const metadata of [[], [verifiedCodexMetadata, verifiedCodexMetadata], [null], [[]], [[verifiedCodexMetadata]], null, 42, 'not a manifest', true]) {
    await temporary(async home => {
      const { env, installMarker } = await fakeNpm(home, metadata)
      const result = await setupCodex(env)
      expect(result).toMatchObject({ ok: false, installed: false })
      expect(result.error).toContain('metadata did not match')
      await expect(readFile(installMarker, 'utf8')).rejects.toThrow()
      expect((await readdir(home)).sort()).toEqual(['bin'])
    })
  }
})

test('Codex setup never installs without npm and rejects unverified metadata before creating scoped state', async () => temporary(async home => {
  expect(await setupCodex({ HOME: home, PATH: '' })).toMatchObject({ ok: false, installed: false })
  if (process.platform === 'win32') return
  const bin = path.join(home, 'bin')
  await mkdir(bin)
  const script = path.join(bin, 'npm-cli.js')
  await writeFile(script, '#!/usr/bin/env node\nconsole.log(JSON.stringify({name:"untrusted",version:"0.162.1"}))\n')
  await chmod(script, 0o755)
  await symlink(script, path.join(bin, 'npm'))
  const before = (await readdir(home)).sort()
  const result = await setupCodex({ HOME: home, PATH: bin })
  expect(result).toMatchObject({ ok: false, installed: false })
  expect(result.error).toContain('metadata did not match')
  expect((await readdir(home)).sort()).toEqual(before)
}))
