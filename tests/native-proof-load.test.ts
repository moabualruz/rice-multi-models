import { expect, test } from 'bun:test'
import { waitForNativeProofCapacity } from '../scripts/native-proof-load.mjs'

test('native proof load gate starts without waiting at or below 90', async () => {
  const waits: number[] = []
  const messages: string[] = []
  const accepted = await waitForNativeProofCapacity({
    readLoad: () => 90,
    wait: async ms => { waits.push(ms) },
    now: () => 0,
    log: message => messages.push(message),
    error: message => messages.push(message),
  })

  expect(accepted).toBe(true)
  expect(waits).toEqual([])
  expect(messages).toEqual([])
})

test('native proof load gate waits until the 1-minute load is at most 90', async () => {
  let load = 91
  let clock = 0
  const waits: number[] = []
  const messages: string[] = []
  const accepted = await waitForNativeProofCapacity({
    readLoad: () => load,
    wait: async ms => { waits.push(ms); clock += ms; load = 90 },
    now: () => clock,
    log: message => messages.push(message),
    error: message => messages.push(message),
  })

  expect(accepted).toBe(true)
  expect(waits).toEqual([5000])
  expect(messages).toEqual([
    'Native proof gate: 1-minute load average 91.0 exceeds 90; waiting up to 120 seconds.',
    'Native proof gate: load average is 90.0; starting native proofs.',
  ])
})

test('native proof load gate refuses to start after the bounded wait expires', async () => {
  let clock = 0
  const waits: number[] = []
  const messages: string[] = []
  const errors: string[] = []
  const accepted = await waitForNativeProofCapacity({
    readLoad: () => 91,
    wait: async ms => { waits.push(ms); clock += ms },
    now: () => clock,
    log: message => messages.push(message),
    error: message => errors.push(message),
  })

  expect(accepted).toBe(false)
  expect(waits).toHaveLength(24)
  expect(waits.every(ms => ms === 5000)).toBe(true)
  expect(messages).toEqual(['Native proof gate: 1-minute load average 91.0 exceeds 90; waiting up to 120 seconds.'])
  expect(errors).toEqual(['Native proof gate: load average remains 91.0 after 120 seconds; refusing to start native proofs.'])
})
