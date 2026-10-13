// Shell-free Node subprocesses with platform-safe argv and process-tree cleanup.
import { spawn } from 'node:child_process'
import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { executableInvocation, resolveExecutable } from './executable.ts'
import { terminateProcessTree } from './process-tree.ts'

export function startProcess(argv: readonly string[], cwd?: string): {
  child: ChildProcessByStdio<null, Readable, Readable>
  exited: Promise<number>
  stderr: () => string
  stop: () => void
} {
  const executable = argv[0]
  if (!executable) throw new Error('empty executable argv')
  const filename = /[/\\]/.test(executable) ? executable : resolveExecutable(executable)
  const invocation = executableInvocation(filename, argv.slice(1))
  const child = spawn(invocation.command, invocation.args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
    ...invocation.options,
  })
  // Drain stderr from the start: a noisy worker must not block its stdout pipe.
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4096) })
  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => resolve(code ?? 1))
  })
  // Errors can precede the caller reaching its await (e.g. while streaming stdout).
  void exited.catch(() => {})
  const stop = () => {
    if (child.pid) terminateProcessTree(child.pid, { signal: 'SIGKILL' })
  }
  return { child, exited, stderr: () => stderr.trim().split('\n').at(-1)?.slice(0, 300) ?? '', stop }
}

export async function runCommand(argv: readonly string[], timeoutMs: number): Promise<{ stdout: string; exitCode: number }> {
  const running = startProcess(argv)
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; running.stop() }, timeoutMs)
  try {
    const chunks: Buffer[] = []
    for await (const chunk of running.child.stdout) chunks.push(Buffer.from(chunk))
    const exitCode = await running.exited
    if (timedOut) throw new Error(`timed out after ${timeoutMs} ms`)
    return { stdout: Buffer.concat(chunks).toString('utf8'), exitCode }
  } finally {
    clearTimeout(timer)
    if (running.child.exitCode === null) running.stop()
  }
}
