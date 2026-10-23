import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const helper = fileURLToPath(new URL('../../dist/helper.mjs', import.meta.url))
const cooperativeOwner = `
import { pathToFileURL } from 'node:url'
const [directory, helper] = process.argv.slice(1)
const { main } = await import(pathToFileURL(helper).href)
process.argv = [process.execPath, helper, 'continuation-lock', directory]
const lifetime = new AbortController()
process.stdin.once('data', () => lifetime.abort())
await main(lifetime.signal)
`

async function acquire(directory, cooperative = false) {
  const args = cooperative ? ['--input-type=module', '-e', cooperativeOwner, directory, helper] : [helper, 'continuation-lock', directory]
  const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  let output = ''
  const announced = new Promise((resolve, reject) => {
    child.stdout.on('data', bytes => { output += bytes; if (output.includes('continuation-lock-acquired\n')) resolve() })
    child.once('close', () => reject(new Error('lock exited before acquisition')))
  })
  await announced
  assert.equal((await readFile(join(directory, 'rice-multi-models', 'continuation.lock'))).length, 0, 'the lock stores no protocol state')
  return { child, exited }
}

function refusedContender(directory) {
  const contender = spawnSync(process.execPath, [helper, 'continuation-lock', directory], { encoding: 'utf8', timeout: 4000 })
  assert.equal(contender.status, 1, contender.stderr)
  assert.match(contender.stderr, /helper command failed/)
}

test('compiled helper starts under Node without Bun', () => {
  const result = spawnSync(process.execPath, [helper, 'once'], { input: '{', encoding: 'utf8' })
  assert.equal(result.status, 2, result.stderr)
  const events = result.stdout.trim().split('\n').map(line => JSON.parse(line))
  assert.equal(events[0].type, 'error')
  assert.match(events[0].text, /did not parse/)
})

test('compiled continuation lock is exclusive, empty and released on cooperative owner termination', { timeout: 15000 }, async () => {
  const compiled = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: cooperativeOwner, encoding: 'utf8' })
  assert.equal(compiled.status, 0, compiled.stderr)
  const directory = await mkdtemp(join(tmpdir(), 'rice-node-continuation-lock-'))
  const file = join(directory, 'rice-multi-models', 'continuation.lock')
  let held
  try {
    held = await acquire(directory, true)
    refusedContender(directory)
    assert.equal((await readFile(file)).length, 0)
    held.child.stdin.end('release\n')
    assert.equal(await held.exited, 0, 'cooperative lifetime cleanup succeeds')
    await assert.rejects(stat(file), { code: 'ENOENT' })
    held = await acquire(directory, true)
    held.child.stdin.end('release\n')
    assert.equal(await held.exited, 0, 'the next owner also releases cleanly')
    await assert.rejects(stat(file), { code: 'ENOENT' })
  } finally {
    if (held?.child.exitCode === null && held.child.signalCode === null) { held.child.kill('SIGTERM'); await held.exited }
    await rm(directory, { recursive: true, force: true })
  }
})

test('compiled continuation lock respects platform signal termination without stealing stale ownership', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rice-node-continuation-signal-'))
  const file = join(directory, 'rice-multi-models', 'continuation.lock')
  let held
  try {
    held = await acquire(directory)
    const before = await stat(file)
    assert.equal(held.child.kill('SIGTERM'), true)
    await held.exited
    if (process.platform === 'win32') {
      // Node child.kill is abrupt on Windows: no JavaScript finally/signal handler
      // runs. A crash-stale lock must remain intact and block a new owner.
      assert.equal((await stat(file)).ino, before.ino)
      assert.equal((await readFile(file)).length, 0)
      refusedContender(directory)
      assert.equal((await stat(file)).ino, before.ino)
    } else {
      await assert.rejects(stat(file), { code: 'ENOENT' })
      held = await acquire(directory)
      assert.equal(held.child.kill('SIGTERM'), true)
      await held.exited
      await assert.rejects(stat(file), { code: 'ENOENT' })
    }
  } finally {
    if (held?.child.exitCode === null && held.child.signalCode === null) { held.child.kill('SIGTERM'); await held.exited }
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
