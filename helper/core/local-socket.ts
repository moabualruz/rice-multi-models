// sockaddr_un limits apply to bytes, not characters. Bind/connect a long private socket path
// relative to its directory while preserving the caller's working directory for all routed work.
import { basename, dirname } from 'node:path'

export function withLocalSocketPath<T>(socketPath: string, operation: (path: string) => T): T {
  if (process.platform === 'win32' || Buffer.byteLength(socketPath) < 100) return operation(socketPath)
  const cwd = process.cwd()
  try {
    process.chdir(dirname(socketPath))
    // Node binds/connects the pipe synchronously when listen/request constructs its native handle.
    return operation(basename(socketPath))
  } finally {
    process.chdir(cwd)
  }
}
