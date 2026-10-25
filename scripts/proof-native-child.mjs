// Capture the complete native result, not just an answer observed before exit.
// The deadline covers execution only: it stops at exit. After exit the pipes get drainMs to deliver
// what is left; a descendant that still holds one open is then released and the capture resolves
// with what was read. terminate receives the output read so far when the deadline fires.
export async function captureNativeChild(child, timeoutMs, terminate, drainMs = 2000) {
  let stdout = '', stderr = '', timedOut = false, drainTimer
  child.stdout.on('data', part => stdout += part)
  child.stderr.on('data', part => stderr += part)
  const timer = setTimeout(() => {
    // Native exit and pipe close are separate events. A delayed observer can see
    // exit before this callback but still have buffered output left to drain.
    if (child.exitCode !== null || child.signalCode !== null) return
    timedOut = true
    terminate({ stdout, stderr })
  }, timeoutMs)
  try {
    return await new Promise((resolve, reject) => {
      const settle = code => { clearTimeout(drainTimer); resolve({ code, timedOut, stdout, stderr }) }
      child.once('error', reject)
      child.once('close', settle)
      child.once('exit', code => {
        clearTimeout(timer)
        drainTimer = setTimeout(() => {
          child.stdout.destroy()
          child.stderr.destroy()
          settle(code)
        }, drainMs)
      })
    })
  } finally {
    clearTimeout(timer)
    clearTimeout(drainTimer)
  }
}
