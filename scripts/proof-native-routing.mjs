// Exercises the installed engine, including operation nouns absent from plugin test's $.
// Provider I/O is replaced with deterministic events; no account or network is needed.
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const fixture = mkdtempSync(join(tmpdir(), 'rice-native-routing-'))
try {
  const plugin = join(fixture, 'plugin')
  const configDir = join(fixture, '.claude')
  mkdirSync(plugin)
  mkdirSync(configDir)
  for (const directory of ['.claude-plugin', 'hooks', 'types', 'dist', 'scripts']) cpSync(join(root, directory), join(plugin, directory), { recursive: true })
  writeFileSync(join(fixture, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }))
  // Upgrade an actual pre-0.6 row through the shipped helper before loading the engine.
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ modelPicker: { options: [{ model: 'codex/fresh-native', label: 'Fresh (Codex)', description: 'ChatGPT subscription via rice-multi-models, 500k context', behavesAs: 'claude-sonnet-4-6' }] } }))
  const rows = [{ model: 'codex/fresh-native', label: 'Fresh (Codex)', description: 'reported context 500000' }]
  const migrate = spawnSync(process.execPath, [join(plugin, 'dist/helper.mjs'), 'sync-picker'], { input: JSON.stringify({ configDir, rows }), encoding: 'utf8', timeout: 10_000 })
  assert.equal(migrate.status, 0, 'migration helper exit')
  assert.equal(JSON.parse(migrate.stdout).ok, true)
  assert.deepEqual(JSON.parse(readFileSync(join(configDir, 'settings.json'))).modelPicker.options, rows)

  const file = join(plugin, 'hooks/register.ts')
  let source = readFileSync(file, 'utf8')
  const start = source.indexOf("  on('turn.step',")
  const end = source.indexOf("  on('session.compact',", start)
  assert.ok(start > 0 && end > start, 'production turn hook boundaries')
  // Only the main turn is replaced with the probe. Startup, completion, fork and
  // classification routing retain their production handlers and actual host calls.
  source = source.slice(0, start) + `
  on('turn.step', async function* ($, e) {
    let answer: string
    try {
      // Lifecycle discovery has separate native fixtures. Here the metadata
      // value is fixed to isolate whether legacy picker migration lets the
      // real engine honor its documented context override.
      await $.env.set('CLAUDE_CODE_MAX_CONTEXT_TOKENS', '500000')
      const completion = await $.model.complete({ model: 'codex/fresh-native', prompt: 'One word' })
      const nativeCompletion = await $.model.complete({ model: 'haiku', prompt: 'Explicit native route' })
      const classification = await $.model.classify('A broken feature', ['bug', 'question'], { model: 'codex/fresh-native' })
      const hostVersion = (await $.session.version()).version
      answer = JSON.stringify({ nativeWindow: (await $.session.usage()).context.window,
      completion: completion.isAnswered ? completion.text : completion.reason,
      classification, hostVersion, classifierContract: await $.store.get('native-classifier:' + hostVersion),
      auxiliaryTargets: proofTargets, auxiliaryRequests: proofRequests, nativeCompletions: proofNative })
    } catch (error) {
      answer = JSON.stringify({ fixtureError: error instanceof Error ? error.message : String(error), auxiliaryTargets: proofTargets, nativeCompletions: proofNative,
        runtime: { executable: runtime.executable ?? null, version: runtime.version ?? null, error: runtime.error ?? null, home: runtime.info?.home ? "set" : null }, helper: (await read($, prefsAtom)).helper })
    }
    yield { kind: 'text', index: 0, text: answer }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn', usage: null }
  })

` + source.slice(end)
  source = source.replace('export const register: Register = on => {', `let proofNative = 0
const proofTargets: string[] = []
const proofRequests: unknown[] = []
export const register: Register = on => {`)
  source = source.replace('    const started = await next(e)', `    await $.state.set({ plugin: 'rice-multi-models', key: 'prefs' }, { effort: null, transport: 'auto', helper: 'once' })
    const started = await next(e)`)
  const close = source.lastIndexOf('\n}')
  source = source.slice(0, close) + `
  on('process.run', async ($, e, next) => {
    if (!e.argv.includes('discover')) return next(e)
    const metadata = { contextWindow: 500000, maxContextWindow: 872000, inputTokenLimit: null, outputTokenLimit: null, autoCompactTokenLimit: null, inputModalities: ['text'], reasoningEfforts: null, tools: null, parallelToolCalls: null }
    const catalogue = { models: [{ model: 'codex/fresh-native', label: 'Fresh (Codex)', execution: 'native provider', source: 'fixture', observedAt: Date.now(), metadata }], providers: [{ provider: 'codex', status: 'fresh', source: 'fixture', observedAt: Date.now() }] }
    return { value: { exitCode: 0, stdout: JSON.stringify(catalogue), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* ($, e, next) {
    if (!e.argv.includes('once')) return yield* next(e)
    const { target, system, tools, transcript, who, native } = JSON.parse(e.input || '{}').req
    proofTargets.push(target)
    proofRequests.push({ target, system, tools, transcript, who, native })
    yield { stream: 'stdout', text: JSON.stringify({ type: 'text', text: 'bug' }) + '\\n' + JSON.stringify({ type: 'stop', reason: 'end_turn' }) + '\\n' }
    return { value: { code: 0, signal: null } }
  })
  on('model.complete', { model: 'haiku' }, () => {
    proofNative++
    return { value: { isAnswered: true, text: 'native', usage: NO_USAGE } }
  })
` + source.slice(close)
  writeFileSync(file, source)
  const env = Object.fromEntries(['PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL'].filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]))
  Object.assign(env, { ...(process.platform === 'win32' ? { OS: 'Windows_NT' } : {}), HOME: fixture, USERPROFILE: fixture, CLAUDE_CONFIG_DIR: configDir, CODEX_HOME: join(fixture, '.codex'), ANTHROPIC_API_KEY: 'fixture-no-network', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' })
  const native = process.env.RICE_CLAUDE_EXECUTABLE || 'claude'
  const versionArgs = ['--version']
  const versionOf = (file, args) => {
    const result = spawnSync(file, args, { cwd: fixture, env, encoding: 'utf8', timeout: 10_000 })
    assert.equal(result.status, 0, 'native routing prerequisite: Claude Code version query must succeed')
    const version = /^(\d+\.\d+\.\d+) \(Claude Code\)$/.exec(result.stdout.trim())?.[1]
    assert.ok(version, 'native routing prerequisite: Claude Code must report its version')
    return version
  }
  const targetVersion = versionOf(native, versionArgs)
  // The helper captures through PATH, not the test runner's executable override.
  // Refuse mixed binaries before a valid fail-closed guard looks like a routing defect.
  const captureVersion = process.platform === 'win32'
    ? versionOf('cmd.exe', ['/d', '/s', '/c', 'claude', ...versionArgs])
    : versionOf('claude', versionArgs)
  assert.equal(captureVersion, targetVersion, 'native routing prerequisite: PATH claude must match RICE_CLAUDE_EXECUTABLE; pin both to the target build')
  if (process.env.CLAUDE_VERSION) assert.equal(targetVersion, process.env.CLAUDE_VERSION, 'native routing prerequisite: installed build must match CLAUDE_VERSION')
  const validation = spawnSync(native, ['plugin', 'validate', '--strict', plugin], { cwd: fixture, env, encoding: 'utf8', timeout: 10_000 })
  assert.equal(validation.status, 0, `native fixture validation failed: ${(validation.stdout + validation.stderr).slice(-2500)}`)
  const result = spawnSync(native, ['-p', '--model', 'codex/fresh-native', '--plugin-dir', plugin, '--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', '', '--no-session-persistence', '--output-format', 'json', 'Isolated routing proof'], { cwd: fixture, env, encoding: 'utf8', timeout: 30_000 })
  assert.equal(result.status, 0, `native routing fixture failed: ${(result.stdout + result.stderr).slice(-2000)}`)
  const observed = JSON.parse(JSON.parse(result.stdout).result)
  assert.equal(observed.fixtureError, undefined, JSON.stringify(observed))
  assert.equal(observed.nativeWindow, 500000, JSON.stringify(observed))
  assert.equal(observed.completion, 'bug')
  assert.equal(observed.classification, 'bug')
  assert.equal(observed.hostVersion, targetVersion)
  const contract = observed.classifierContract
  assert.equal(contract?.version, targetVersion, 'classifier wording comes from the executing host build')
  assert.deepEqual(observed.auxiliaryRequests, [
    { target: 'codex/fresh-native', system: '', tools: [], transcript: [{ role: 'user', content: [{ type: 'text', text: 'One word' }] }], who: 'complete', native: { maxTokens: 1024 } },
    { target: 'codex/fresh-native', system: contract.system[0] + ['bug', 'question'].map(label => JSON.stringify(label)).join(', ') + contract.system[1], tools: [], transcript: [{ role: 'user', content: contract.prompt[0] + 'A broken feature' + contract.prompt[1] }], who: 'classify', native: { maxTokens: Math.min(contract.maxTokens, 2048) } },
  ], 'actual helper requests preserve the explicit model, native classifier contract and bounded output')
  assert.deepEqual(observed.auxiliaryTargets, ['codex/fresh-native', 'codex/fresh-native'])
  assert.equal(observed.nativeCompletions, 1, 'explicit native model stays native, never silently replaced by the main provider')
  const { auxiliaryRequests, classifierContract, ...summary } = observed
  process.stdout.write(JSON.stringify({ ...summary, classifierCaptureVersion: contract.version, classifierMaxTokens: auxiliaryRequests[1].native.maxTokens }) + '\n')
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
