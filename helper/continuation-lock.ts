// A lock, not a state backend. No provider data or credentials enter this empty file.
import { open, lstat, unlink, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export async function continuationLock(configDir: string, lifetime?: AbortSignal): Promise<void> {
  if (!isAbsolute(configDir) || /[\0\r\n]/.test(configDir) || configDir.split(/[\\/]/).includes('..')) throw new Error('Invalid continuation lock directory')
  // The config root must already exist. Only the fixed plugin child may be created;
  // never follow a planted plugin/config symlink or create an arbitrary parent tree.
  let directory: string
  try {
    // Strip trailing separators before lstat; otherwise the OS follows a final symlink.
    const rootPath = resolve(configDir)
    const root = await lstat(rootPath)
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('directory')
    directory = join(await realpath(rootPath), 'rice-multi-models')
    try { await mkdir(directory, { mode: 0o700 }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const owned = await lstat(directory)
    if (!owned.isDirectory() || owned.isSymbolicLink() || process.platform !== 'win32' && (owned.mode & 0o022 || process.getuid && owned.uid !== process.getuid())) throw new Error('directory')
  } catch { throw new Error('Continuation lock directory unavailable or unsafe; no durable read/write was performed') }
  const file = join(directory, 'continuation.lock')
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
