import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AccountSteps, codexStepLimit } from '../account-steps.ts'
import { codexStep } from '../codex.ts'
import type { StepEvent, StepRequest } from '../../hooks/protocol.ts'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))

test('account admission is FIFO, independent by account and cancellation-safe', async () => {
  const limiter = new AccountSteps()
  const signal = new AbortController().signal
  const release = await limiter.acquire('one', 1, signal)
  const cancelled = new AbortController()
  const order: number[] = []
  const queued = limiter.acquire('one', 1, cancelled.signal).catch(() => { order.push(0) })
  const second = limiter.acquire('one', 1, signal).then(release => { order.push(2); return release })
  const third = limiter.acquire('one', 1, signal).then(release => { order.push(3); return release })
  const other = await limiter.acquire('two', 1, signal)
  expect(order).toEqual([])
  cancelled.abort()
  await queued
  release()
  const releaseSecond = await second
  expect(order).toEqual([0, 2])
  releaseSecond()
  releaseSecond()
  const releaseThird = await third
  expect(order).toEqual([0, 2, 3])
  releaseThird()
  other()
  const again = await limiter.acquire('one', 1, signal)
  again()
})

test('limit is off by default, configurable, and rejects invalid configuration', () => {
  expect(codexStepLimit({})).toBe(0)
  expect(codexStepLimit({ RICE_CODEX_MAX_IN_FLIGHT: '6' })).toBe(6)
  expect(codexStepLimit({ RICE_CODEX_MAX_IN_FLIGHT: '0' })).toBe(0)
  expect(codexStepLimit({ RICE_CODEX_MAX_IN_FLIGHT: '15' })).toBe(15)
  for (const value of ['-1', '16', 'six', '1.5', '']) expect(() => codexStepLimit({ RICE_CODEX_MAX_IN_FLIGHT: value })).toThrow()
})

test('eight real HTTP steps on one account queue at a configured limit of six without failing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mm-accounts-'))
  const authFile = join(dir, 'auth.json')
  writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'test-only', account_id: 'queue-test' } }))
  const request: StepRequest = { target: 'codex/test', system: '', tools: [], transcript: [{ role: 'user', content: 'Hi' }], who: 'main', session: 'queue-test', transport: 'sse' }
  let calls = 0
  let active = 0
  let maxActive = 0
  const held: (() => void)[] = []
  let wake: (() => void) | undefined
  const waitCalls = async (count: number) => {
    while (calls < count) await new Promise<void>(resolve => { wake = resolve })
  }
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      await request.json()
      calls++
      maxActive = Math.max(maxActive, ++active)
      const waiting = new Promise<void>(resolve => held.push(resolve))
      wake?.()
      wake = undefined
      await waiting
      active--
      const response = { type: 'response.completed', response: { id: 'r', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }], usage: { input_tokens: 1, output_tokens: 1 } } }
      return new Response(`data: ${JSON.stringify(response)}\n\n`)
    },
  })
  const abort = new AbortController()
  const pending = Array.from({ length: 8 }, async (_, index) => {
    const events: StepEvent[] = []
    for await (const event of codexStep({ ...request, who: `agent-${index}` }, 'test', abort.signal, { authFile, env: { RICE_CODEX_MAX_IN_FLIGHT: '6' }, httpUrl: `http://127.0.0.1:${server.port}` })) events.push(event)
    return events
  })
  try {
    await waitCalls(6)
    await tick()
    expect(calls).toBe(6)
    held.shift()!()
    await waitCalls(7)
    expect(maxActive).toBe(6)
    for (const release of held.splice(0)) release()
    await waitCalls(8)
    for (const release of held.splice(0)) release()
    const results = await Promise.all(pending)
    expect(results.every(events => events.some(event => event.type === 'stop') && !events.some(event => event.type === 'error'))).toBe(true)
    expect(maxActive).toBe(6)
  } finally {
    abort.abort()
    for (const release of held.splice(0)) release()
    await Promise.allSettled(pending)
    server.stop(true)
    rmSync(dir, { recursive: true, force: true })
  }
})
