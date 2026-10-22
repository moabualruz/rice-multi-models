import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

test('compiled continuation lock is exclusive, empty and released on owner termination', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rice-node-continuation-lock-'))
  const file = join(directory, 'rice-multi-models', 'continuation.lock')
  let child
  const acquire = async () => {
    child = spawn(process.execPath, [helper, 'continuation-lock', directory], { stdio: ['ignore', 'pipe', 'pipe'] })
    const current = child
    const exited = new Promise((resolve, reject) => { current.once('error', reject); current.once('close', resolve) })
    let output = ''
    const announced = new Promise((resolve, reject) => {
      current.stdout.on('data', bytes => { output += bytes; if (output.includes('continuation-lock-acquired\n')) resolve() })
      current.once('close', () => reject(new Error('lock exited before acquisition')))
    })
    await announced
    assert.equal((await readFile(file)).length, 0, 'the lock stores no protocol state')
    return { exited }
  }
  try {
    const held = await acquire()
    const contender = spawnSync(process.execPath, [helper, 'continuation-lock', directory], { encoding: 'utf8', timeout: 4000 })
    assert.equal(contender.status, 1, contender.stderr)
    assert.match(contender.stderr, /helper command failed/)
    assert.equal((await readFile(file)).length, 0)
    child.kill('SIGTERM'); await held.exited
    await assert.rejects(stat(file), { code: 'ENOENT' })
    const again = await acquire()
    child.kill('SIGTERM'); await again.exited
    await assert.rejects(stat(file), { code: 'ENOENT' })
  } finally {
    if (child?.exitCode === null) child.kill('SIGTERM')
    await rm(directory, { recursive: true, force: true })
  }
})

test('compiled continuation lock never steals a crash-stale empty lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rice-node-continuation-stale-'))
  try {
    await mkdir(join(directory, 'rice-multi-models'), { mode: 0o700 })
    const file = join(directory, 'rice-multi-models', 'continuation.lock')
    await writeFile(file, '', { mode: 0o600 })
    const before = await stat(file)
    const result = spawnSync(process.execPath, [helper, 'continuation-lock', directory], { encoding: 'utf8', timeout: 4000 })
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /helper command failed/)
    assert.equal((await stat(file)).ino, before.ino)
    assert.equal((await readFile(file)).length, 0)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
