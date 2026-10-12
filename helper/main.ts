// The helper that answers routed steps, on Bun (TypeScript as is, Node built-ins, WebSocket with headers).
// `serve`: the session helper (helper/serve.ts), started once per session. `once`: one StepWire on stdin,
// its events on stdout, one JSON object per line, for when the session helper is not running; killing the
// process cancels the request.
import type { StepWire } from '../hooks/protocol.ts'
import { failedStep } from '../hooks/protocol.ts'
import { runStep } from './run.ts'
import { serve } from './serve.ts'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)

  return Buffer.concat(chunks).toString('utf8')
}

async function once(): Promise<void> {
  const controller = new AbortController()
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => controller.abort())
  let wire: StepWire
  try {
    wire = JSON.parse(await readStdin()) as StepWire
  } catch (error) {
    for (const event of failedStep(`rice-multi-models: the step request did not parse: ${error instanceof Error ? error.message : String(error)}`)) process.stdout.write(`${JSON.stringify(event)}\n`)
    process.exitCode = 2

    return
  }
  for await (const event of runStep(wire, controller.signal)) process.stdout.write(`${JSON.stringify(event)}\n`)
}

if (import.meta.main) {
  const mode = process.argv[2] ?? 'once'
  if (mode === 'once') await once()
  else if (mode === 'serve') serve()
  else {
    process.stderr.write(`rice-multi-models helper: unknown mode ${mode}\n`)
    process.exitCode = 2
  }
}
