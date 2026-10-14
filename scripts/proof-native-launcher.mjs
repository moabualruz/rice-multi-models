// Installation proof uses an isolated home, never the owner's installed launcher.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const fixture = mkdtempSync(join(tmpdir(), 'rice-launcher space-'))
const plugin = join(fixture, 'installed plugin'), config = join(fixture, '.claude')
const env = { ...process.env, HOME: fixture, CLAUDE_CONFIG_DIR: config }
delete env.BUN_OPTIONS
delete env.RICE_MULTI_MODELS_NATIVE_ACTIVE
delete env.RICE_MULTI_MODELS_NATIVE_STATE
try {
  cpSync(join(root, 'dist'), join(plugin, 'dist'), { recursive: true })
  cpSync(join(root, '.claude-plugin'), join(plugin, '.claude-plugin'), { recursive: true })
  mkdirSync(join(config, 'plugins'), { recursive: true })
  writeFileSync(join(config, 'plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'rice-multi-models@rice-mods': [{ scope: 'user', installPath: plugin }] } }))
  const launcher = join(fixture, '.local/bin/rice-claude')
  mkdirSync(join(fixture, '.local/bin'), { recursive: true })
  writeFileSync(launcher, 'owned unrelated command\n')
  const run = (file, args) => spawnSync(process.execPath, [file, ...args], { env, cwd: fixture, encoding: 'utf8', timeout: 20000 })
  assert.notEqual(run(join(plugin, 'dist/launch.mjs'), ['--install']).status, 0, 'unrelated launcher is protected')
  assert.equal(readFileSync(launcher, 'utf8'), 'owned unrelated command\n')
  rmSync(launcher)
  assert.equal(run(join(plugin, 'dist/launch.mjs'), ['--install']).status, 0)
  assert.equal(run(launcher, ['--version']).status, 0, 'installed launcher verifies and starts the real native binary')
  const updated = join(fixture, 'updated plugin')
  cpSync(plugin, updated, { recursive: true })
  writeFileSync(join(config, 'plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'rice-multi-models@rice-mods': [{ scope: 'user', installPath: updated }] } }))
  rmSync(plugin, { recursive: true })
  assert.equal(run(launcher, ['--version']).status, 0, 'normal plugin update resolves the new cache path without reinstalling the launcher')
  process.stdout.write('Native launcher installation, path spaces, unrelated-file protection and cache update passed in an isolated home\n')
} finally { rmSync(fixture, { recursive: true, force: true }) }
