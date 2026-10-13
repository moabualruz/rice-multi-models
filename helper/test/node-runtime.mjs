import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const helper = fileURLToPath(new URL('../../dist/helper.mjs', import.meta.url))

test('compiled helper starts under Node without Bun', () => {
  const result = spawnSync(process.execPath, [helper, 'once'], { input: '{', encoding: 'utf8' })
  assert.equal(result.status, 2, result.stderr)
  const events = result.stdout.trim().split('\n').map(line => JSON.parse(line))
  assert.equal(events[0].type, 'error')
  assert.match(events[0].text, /did not parse/)
})
