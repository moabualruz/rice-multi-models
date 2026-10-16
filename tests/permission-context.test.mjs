import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { permissionContext } from '../scripts/permission-context.mjs'

const nonce = 'owned-fixture-nonce-0123456789'
const native = { hook_event_name: 'PreToolUse', session_id: 'owned-session', tool_use_id: 'toolu_owned', permission_mode: 'auto', tool_name: 'Bash', tool_input: { command: 'fixture-sensitive-tool-argument' } }
const prefix = 'RICE_MULTI_MODELS_PERMISSION_CONTEXT:'

test('only bound native mode and identity metadata enter the context marker', () => {
  const result = permissionContext({ ...native, agent_id: 'owned-agent', authorization: 'fixture-private-value', transcript_path: '/fixture/private' }, nonce)
  assert.equal(result.hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.deepEqual(JSON.parse(result.hookSpecificOutput.additionalContext.slice(prefix.length)), { nonce, sessionId: native.session_id, toolUseId: native.tool_use_id, agentId: 'owned-agent', mode: 'auto' })
  assert.equal(JSON.stringify(result).includes('fixture-sensitive-tool-argument'), false)
  assert.equal(JSON.stringify(result).includes('fixture-private-value'), false)
  assert.equal(JSON.stringify(result).includes('permissionDecision'), false)
})

test('main and subagent identities are distinct and all native modes are preserved literally', () => {
  for (const mode of ['default', 'manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']) {
    const result = permissionContext({ ...native, permission_mode: mode }, nonce)
    const marker = JSON.parse(result.hookSpecificOutput.additionalContext.slice(prefix.length))
    assert.equal(marker.mode, mode)
    assert.equal(Object.hasOwn(marker, 'agentId'), false)
  }
})

test('missing or malformed identity, mode and per-process nonce emit no marker or decision', () => {
  for (const bad of [undefined, null, [], {}, { ...native, hook_event_name: 'PostToolUse' }, { ...native, session_id: '' }, { ...native, tool_use_id: 'unsafe\nvalue' }, { ...native, permission_mode: 'unknown' }, { ...native, agent_id: '' }]) assert.deepEqual(permissionContext(bad, nonce), {})
  for (const invalid of [undefined, '', 'short', 'unsafe-nonce-0123456789\nmalformed']) assert.deepEqual(permissionContext(native, invalid), {})
})

test('the actual Node hook reads stdin, emits valid metadata JSON and never echoes arguments', () => {
  const result = spawnSync(process.execPath, [resolve('scripts/permission-context.mjs')], { input: JSON.stringify(native), encoding: 'utf8', env: { RICE_MULTI_MODELS_PERMISSION_CONTEXT_NONCE: nonce }, timeout: 5000 })
  assert.equal(result.status, 0)
  assert.equal(result.stderr, '')
  const output = JSON.parse(result.stdout)
  assert.equal(JSON.parse(output.hookSpecificOutput.additionalContext.slice(prefix.length)).mode, 'auto')
  assert.equal(result.stdout.includes('fixture-sensitive-tool-argument'), false)
})

test('malformed or oversized stdin fails closed without logging content', () => {
  for (const input of ['invalid fixture-sensitive-value', JSON.stringify({ ...native, tool_input: { text: 'x'.repeat(1024 * 1024) } })]) {
    const result = spawnSync(process.execPath, [resolve('scripts/permission-context.mjs')], { input, encoding: 'utf8', env: { RICE_MULTI_MODELS_PERMISSION_CONTEXT_NONCE: nonce }, timeout: 5000 })
    assert.equal(result.status, 0)
    assert.equal(result.stdout, '{}\n')
    assert.equal(result.stderr, '')
  }
})

test('a linked plugin directory still executes the native hook entry point', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'rice-context-link-'))
  try {
    const actual = join(fixture, 'actual'), link = join(fixture, 'linked plugin')
    mkdirSync(actual)
    copyFileSync(resolve('scripts/permission-context.mjs'), join(actual, 'permission-context.mjs'))
    symlinkSync(actual, link, process.platform === 'win32' ? 'junction' : 'dir')
    const result = spawnSync(process.execPath, [join(link, 'permission-context.mjs')], { input: JSON.stringify(native), encoding: 'utf8', env: { RICE_MULTI_MODELS_PERMISSION_CONTEXT_NONCE: nonce }, timeout: 5000 })
    assert.equal(result.status, 0)
    const output = JSON.parse(result.stdout)
    assert.equal(JSON.parse(output.hookSpecificOutput.additionalContext.slice(prefix.length)).mode, 'auto')
    assert.equal(result.stderr, '')
  } finally { rmSync(fixture, { recursive: true, force: true }) }
})
