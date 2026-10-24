// Capture the complete native result, not just an answer observed before exit.
export async function captureNativeChild(child, timeoutMs, terminate) {
  let stdout = '', stderr = '', timedOut = false
  child.stdout.on('data', part => stdout += part)
  child.stderr.on('data', part => stderr += part)
  const timer = setTimeout(() => {
    // Native exit and pipe close are separate events. A delayed observer can see
    // exit before this callback but still have buffered output left to drain.
    if (child.exitCode !== null || child.signalCode !== null) return
    timedOut = true
    terminate()
  }, timeoutMs)
  child.once('exit', () => clearTimeout(timer))
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    return { code, timedOut, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}
