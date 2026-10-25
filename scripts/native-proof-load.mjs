import { loadavg } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'

const LOAD_LIMIT = 90
const MAX_WAIT_MS = 120_000
const POLL_MS = 5_000

export async function waitForNativeProofCapacity({
  readLoad = () => loadavg()[0],
  wait = sleep,
  now = () => Date.now(),
  log = message => console.log(message),
  error = message => console.error(message),
} = {}) {
  let load = readLoad()
  if (load <= LOAD_LIMIT) return true

  const deadline = now() + MAX_WAIT_MS
  log(`Native proof gate: 1-minute load average ${load.toFixed(1)} exceeds ${LOAD_LIMIT}; waiting up to ${MAX_WAIT_MS / 1000} seconds.`)
  while (load > LOAD_LIMIT && now() < deadline) {
    await wait(Math.min(POLL_MS, deadline - now()))
    load = readLoad()
  }
  if (load > LOAD_LIMIT) {
    error(`Native proof gate: load average remains ${load.toFixed(1)} after ${MAX_WAIT_MS / 1000} seconds; refusing to start native proofs.`)
    return false
  }
  log(`Native proof gate: load average is ${load.toFixed(1)}; starting native proofs.`)
  return true
}
