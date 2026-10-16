// Installation proof uses an isolated home, never the owner's installed launcher.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const fixture = mkdtempSync(join(tmpdir(), 'rice-launcher space-'))
const plugin = join(fixture, 'installed plugin'), config = join(fixture, '.claude')
const native = realpathSync(process.env.RICE_CLAUDE_EXECUTABLE || spawnSync('which', ['claude'], { encoding: 'utf8' }).stdout.trim())
const bin = join(fixture, 'unsupported-path-bin'), marker = join(fixture, 'unexpected-path-fallback')
const env = { ...process.env, HOME: fixture, CLAUDE_CONFIG_DIR: config, PATH: `${bin}:${process.env.PATH}` }
delete env.BUN_OPTIONS
delete env.RICE_MULTI_MODELS_NATIVE_ACTIVE
delete env.RICE_MULTI_MODELS_NATIVE_STATE
delete env.RICE_CLAUDE_EXECUTABLE
try {
  mkdirSync(bin)
  const unsupported = join(bin, 'claude')
  writeFileSync(unsupported, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'PATH fallback used'); console.log('2.1.300 (unsupported fixture)');\n`, { mode: 0o755 })
  assert.equal(spawnSync(process.execPath, ['--check', unsupported]).status, 0)
  const qualified = join(fixture, 'qualified native executable')
  symlinkSync(native, qualified)
  cpSync(join(root, 'dist'), join(plugin, 'dist'), { recursive: true })
  cpSync(join(root, '.claude-plugin'), join(plugin, '.claude-plugin'), { recursive: true })
  mkdirSync(join(config, 'plugins'), { recursive: true })
  const retired = join(fixture, 'disabled retired repair')
  mkdirSync(join(retired, 'dist'), { recursive: true })
  writeFileSync(join(retired, 'dist/launch.mjs'), 'throw new Error("retired disabled repair must never load")\n')
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ enabledPlugins: { 'rice-multi-models@rice-local-repair': false, 'rice-multi-models@rice-mods': true } }))
  writeFileSync(join(config, 'plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
    'rice-multi-models@rice-local-repair': [{ scope: 'user', installPath: retired }],
    'rice-multi-models@rice-mods': [{ scope: 'user', installPath: plugin }],
  } }))
  const launcher = join(fixture, '.local/bin/rice-claude')
  mkdirSync(join(fixture, '.local/bin'), { recursive: true })
  writeFileSync(launcher, 'owned unrelated command\n')
  const selection = join(config, 'rice-multi-models/native-launcher.json')
  const run = (file, args, extraEnv = {}) => spawnSync(process.execPath, [file, ...args], { env: { ...env, ...extraEnv }, cwd: fixture, encoding: 'utf8', timeout: 25000 })
  assert.notEqual(run(join(plugin, 'dist/launch.mjs'), ['--install', qualified]).status, 0, 'unrelated launcher is protected')
  assert.equal(readFileSync(launcher, 'utf8'), 'owned unrelated command\n')
  assert.equal(existsSync(selection), false, 'an unrelated launcher prevents selection writes')
  rmSync(launcher)
  assert.equal(run(join(plugin, 'dist/launch.mjs'), ['--install', qualified]).status, 0)
  const saved = readFileSync(selection, 'utf8')
  assert.deepEqual(JSON.parse(saved), { format: 1, executable: native, claudeVersion: '2.1.299' })
  assert.equal(run(launcher, ['--version']).status, 0, 'plain installed launcher uses the saved native binary instead of unsupported PATH')
  assert.equal(existsSync(marker), false)
  assert.equal(run(join(plugin, 'dist/launch.mjs'), ['--install']).status, 0, 'setup reruns retain a verified selection')
  assert.equal(readFileSync(selection, 'utf8'), saved)
  const installed = readFileSync(launcher, 'utf8')
  writeFileSync(launcher, 'owned unrelated command\n')
  assert.notEqual(run(join(plugin, 'dist/launch.mjs'), ['--install', qualified]).status, 0)
  assert.equal(readFileSync(selection, 'utf8'), saved, 'unrelated launcher refusal preserves an existing selection')
  assert.equal(readFileSync(launcher, 'utf8'), 'owned unrelated command\n')
  writeFileSync(launcher, installed)
  const missing = join(fixture, 'missing native executable')
  assert.notEqual(run(join(plugin, 'dist/launch.mjs'), ['--install', missing]).status, 0)
  assert.equal(readFileSync(selection, 'utf8'), saved, 'failed verification does not replace the saved selection')
  assert.notEqual(run(launcher, ['--version'], { RICE_CLAUDE_EXECUTABLE: missing }).status, 0, 'an explicit override takes precedence over a valid saved selection')
  for (const invalid of [
    JSON.stringify({ format: 1, executable: missing, claudeVersion: '2.1.299' }),
    JSON.stringify({ format: 1, executable: native, claudeVersion: '2.1.300' }),
    '{unreadable-selection-fixture',
  ]) {
    writeFileSync(selection, invalid)
    const refused = run(launcher, ['--version'])
    assert.notEqual(refused.status, 0)
    assert.match(refused.stderr, /\/rice-models setup native/, 'plain launcher preserves an actionable controlled selection error')
    assert.equal(existsSync(marker), false, 'bad saved selection never falls through to PATH')
    assert.equal(run(launcher, ['--version'], { RICE_CLAUDE_EXECUTABLE: qualified }).status, 0, 'explicit qualified override can recover without consuming bad saved state')
    assert.equal(readFileSync(selection, 'utf8'), invalid, 'normal override does not rewrite saved state')
  }
  assert.equal(run(join(plugin, 'dist/launch.mjs'), ['--install', qualified]).status, 0, 'explicit setup repairs invalid saved state after verifying its new selection')
  const updated = join(fixture, 'updated plugin')
  cpSync(plugin, updated, { recursive: true })
  writeFileSync(join(config, 'plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'rice-multi-models@rice-mods': [{ scope: 'user', installPath: updated }] } }))
  rmSync(plugin, { recursive: true })
  assert.equal(run(launcher, ['--version']).status, 0, 'normal plugin update resolves the new cache path without reinstalling the launcher')
  assert.equal(existsSync(marker), false)
  process.stdout.write('Native launcher installation, persisted verified runtime, refusal/repair, path spaces, unrelated-file protection and cache update passed in an isolated home\n')
} finally { rmSync(fixture, { recursive: true, force: true }) }
