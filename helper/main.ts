// The helper that answers routed steps. `once` reads one StepWire on stdin and writes its events, one JSON
// object per line, on stdout: no socket, no listening port; the mod spawns it per step and killing it
// cancels the request. Runs on Bun (TypeScript as is, Node built-ins, WebSocket with headers).
import type { StepEvent, StepWire } from '../hooks/protocol.ts'
import { failedStep, splitTarget } from '../hooks/protocol.ts'
import { codexStep } from './codex.ts'

/** The events of one step, whichever provider its target names. */
export async function* runStep(wire: StepWire, signal: AbortSignal): AsyncGenerator<StepEvent> {
  const target = splitTarget(wire.req.target)
  if (target?.provider === 'codex') {
    yield* codexStep(wire.req, target.model, signal)

    return
  }
  yield* failedStep(`rice-multi-models: no provider answers ${wire.req.target}`)
}

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
  else {
    process.stderr.write(`rice-multi-models helper: unknown mode ${mode}\n`)
    process.exitCode = 2
  }
}
