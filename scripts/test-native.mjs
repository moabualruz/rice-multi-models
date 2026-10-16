import { cpSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const fixture = mkdtempSync(join(tmpdir(), 'rice-native-'))
try {
  mkdirSync(join(fixture, '.claude-plugin'))
  cpSync(join(root, '.claude-plugin/plugin.json'), join(fixture, '.claude-plugin/plugin.json'))
  for (const directory of ['hooks', 'types', 'dist', 'scripts']) cpSync(join(root, directory), join(fixture, directory), { recursive: true })
  cpSync(join(root, 'scripts/native-activation.fixture.ts'), join(fixture, 'activation.test.ts'))
  const result = spawnSync(process.env.RICE_CLAUDE_EXECUTABLE || 'claude', ['plugin', 'test', fixture], { cwd: root, stdio: 'inherit', timeout: 30_000 })
  if (result.error) process.stderr.write(`Native lifecycle test: ${result.error.message}\n`)
  process.exitCode = result.status ?? 1
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
