import assert from 'node:assert/strict'
import { test } from 'node:test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Script } from 'node:vm'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { evaluatorCommand, evaluatorWait } from '../../scripts/evaluator-wait.mjs'

test('the shipped helper CLI runs when its argv uses a directory link', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rice-evaluator-cli-'))
  try {
    const real = join(directory, 'real'), alias = join(directory, 'alias'); mkdirSync(real)
    copyFileSync(fileURLToPath(new URL('../../scripts/evaluator-wait.mjs', import.meta.url)), join(real, 'helper.mjs'))
    symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const ran = spawnSync(process.execPath, [join(alias, 'helper.mjs'), 'shell'], { input: '{}', encoding: 'utf8', timeout: 5000 })
    assert.equal(ran.status, 0); assert.ok(['bash', 'powershell'].includes(JSON.parse(ran.stdout).shell))
  } finally { rmSync(directory, { recursive: true }) }
})

test('private evaluator results are atomic, owned, bounded, and removed only by their owner', async () => {
  const run = await evaluatorWait('create', {})
  try {
    await assert.rejects(evaluatorWait('cleanup', { ...run, nonce: 'another-owner' }), /owner/)
    assert.equal(existsSync(run.directory), true)
    const waiting = evaluatorWait('wait', { ...run, agentId: 'owned-agent', model: 'selected/owned', timeoutMs: 1000 })
    await evaluatorWait('publish', { ...run, agentId: 'owned-agent', model: 'selected/owned', text: '{"ok":true,"reason":"Verified"}' })
    assert.deepEqual(await waiting, { agentId: 'owned-agent', model: 'selected/owned', text: '{"ok":true,"reason":"Verified"}' })
    await assert.rejects(evaluatorWait('wait', { ...run, agentId: 'different-agent', model: 'selected/owned', timeoutMs: 1000 }), /different owner/)
    await evaluatorWait('release', run)
    assert.deepEqual(await evaluatorWait('hold', { ...run, timeoutMs: 1000 }), {})
  } finally { await evaluatorWait('cleanup', run) }
  assert.equal(existsSync(run.directory), false)
})

test('a missing evaluator result expires without a false verdict', async () => {
  const run = await evaluatorWait('create', {})
  try { await assert.rejects(evaluatorWait('wait', { ...run, agentId: 'owned-agent', model: 'selected/owned', timeoutMs: 30 }), /deadline expired/) }
  finally { await evaluatorWait('cleanup', run) }
})

test('exec-form command hooks preserve argv, complete event stdin, output and path placeholders', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rice-evaluator-command-'))
  const program = 'let raw="";process.stdin.on("data",part=>raw+=part);process.stdin.on("end",()=>process.stdout.write(JSON.stringify({args:process.argv.slice(1),input:JSON.parse(raw),project:process.env.CLAUDE_PROJECT_DIR})));'
  new Script(program)
  const event = { hook_event_name: 'Stop', cwd: directory, last_assistant_message: 'Owned result' }
  try {
    const result = await evaluatorCommand({ hook: { command: process.execPath, args: ['-e', program, "space & Unicode 雨 ' quote", '${CLAUDE_PROJECT_DIR}'], timeoutMs: 5000 }, event, projectDirectory: directory })
    assert.equal(result.exitCode, 0); assert.equal(result.failed, false)
    assert.deepEqual(JSON.parse(result.stdout), { args: ["space & Unicode 雨 ' quote", directory], input: event, project: directory })
  } finally { rmSync(directory, { recursive: true }) }
})

test('command deadline retains partial output and kills a child which ignores graceful termination', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rice-evaluator-deadline-'))
  const program = 'process.on("SIGTERM",()=>{});process.stdout.write("OWNED_PARTIAL");setInterval(()=>{},100);'
  new Script(program)
  const start = Date.now()
  try {
    const result = await evaluatorCommand({ hook: { command: process.execPath, args: ['-e', program], timeoutMs: 1000 }, event: { hook_event_name: 'Stop', cwd: directory } })
    assert.equal(result.failed, true); assert.match(result.stdout, /OWNED_PARTIAL/)
    assert.ok(Date.now() - start < 7000, 'one bounded termination escalation')
  } finally { rmSync(directory, { recursive: true }) }
})
