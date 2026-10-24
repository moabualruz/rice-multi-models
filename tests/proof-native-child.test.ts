import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { captureNativeChild } from '../scripts/proof-native-child.mjs'

const node = Bun.which('node')!

function child(source: string) {
  return spawn(node, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe'] })
}

test('native terminal success is not a timeout while inherited output pipes finish draining', async () => {
  // A real descendant holds stderr after the actual child exits. This reproduces
  // the exit/deadline/close ordering without manufacturing an exit event or code.
  const processHandle = child(`
    const { spawn } = require('node:child_process')
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600)'], { stdio: ['ignore', 'ignore', 2] })
    holder.unref()
    process.stdout.write(JSON.stringify({ result: 'OWNED_INVENTORY' }))
  `)
  const events: string[] = []
  processHandle.once('exit', () => events.push('exit'))
  processHandle.once('close', () => events.push('close'))
  let terminations = 0
  const result = await captureNativeChild(processHandle, 300, () => { terminations++; processHandle.kill('SIGTERM') })
  expect(events).toEqual(['exit', 'close'])
  expect(result.code).toBe(0)
  expect(JSON.parse(result.stdout).result).toBe('OWNED_INVENTORY')
  expect(result.stderr).toBe('')
  expect(result.timedOut).toBe(false)
  expect(terminations).toBe(0)
})

test('answer output does not complete a still-running native process', async () => {
  const processHandle = child(`process.stdout.write(JSON.stringify({ result: 'OWNED_INVENTORY' })); setInterval(() => {}, 1000)`)
  let terminations = 0
  const result = await captureNativeChild(processHandle, 300, () => { terminations++; processHandle.kill('SIGTERM') })
  expect(JSON.parse(result.stdout).result).toBe('OWNED_INVENTORY')
  expect(result.timedOut).toBe(true)
  expect(result.code).not.toBe(0)
  expect(terminations).toBe(1)
})

test('native failure remains a failure even with complete expected output', async () => {
  const processHandle = child(`process.stdout.write(JSON.stringify({ result: 'OWNED_INVENTORY' })); process.exitCode = 23`)
  const result = await captureNativeChild(processHandle, 1000, () => processHandle.kill('SIGTERM'))
  expect(result.code).toBe(23)
  expect(result.timedOut).toBe(false)
})

test('a native signal is not terminal success', async () => {
  const processHandle = child(`process.kill(process.pid, 'SIGTERM')`)
  const result = await captureNativeChild(processHandle, 1000, () => processHandle.kill('SIGTERM'))
  expect(result.code).not.toBe(0)
  expect(result.timedOut).toBe(false)
})

test('a failed native spawn rejects rather than waiting for its deadline', async () => {
  const processHandle = spawn('owned-nonexistent-native-executable', [], { stdio: ['ignore', 'pipe', 'pipe'] })
  await expect(captureNativeChild(processHandle, 1000, () => processHandle.kill('SIGTERM'))).rejects.toMatchObject({ code: 'ENOENT' })
})
