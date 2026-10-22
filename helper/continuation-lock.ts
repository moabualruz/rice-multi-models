// A lock, not a state backend. No provider data or credentials enter this empty file.
import { open, lstat, unlink, mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export async function continuationLock(configDir: string, lifetime?: AbortSignal): Promise<void> {
  if (!isAbsolute(configDir) || /[\0\r\n]/.test(configDir)) throw new Error('Invalid continuation lock directory')
  const file = join(configDir, 'rice-multi-models', 'continuation.lock')
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  // Never steal an expired-looking lock. A suspended holder is still a holder.
  let handle: Awaited<ReturnType<typeof open>> | undefined
  const deadline = Date.now() + 1000
  while (!handle) {
    lifetime?.throwIfAborted()
    try { handle = await open(file, 'wx', 0o600) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline) throw new Error('Continuation store lock unavailable; no durable read/write was performed')
      await delay(25, undefined, { signal: lifetime })
    }
  }
  const held = await handle.stat()
  let release: () => void = () => {}
  const ended = new Promise<void>(resolve => { release = resolve })
  const stop = () => release()
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(signal, stop)
  lifetime?.addEventListener('abort', stop, { once: true })
  const keepAlive = setInterval(() => {}, 1000)
  try {
    lifetime?.throwIfAborted()
    process.stdout.write('continuation-lock-acquired\n')
    await ended
  } finally {
    clearInterval(keepAlive)
    lifetime?.removeEventListener('abort', stop)
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.off(signal, stop)
    await handle.close()
    const current = await lstat(file)
    if (current.dev !== held.dev || current.ino !== held.ino) throw new Error('Continuation lock ownership changed')
    await unlink(file)
  }
}
