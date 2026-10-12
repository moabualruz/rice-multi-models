// The events of one step, whichever provider its target names.
import type { StepEvent, StepWire } from '../hooks/protocol.ts'
import { failedStep, splitTarget } from '../hooks/protocol.ts'
import { codexStep } from './codex.ts'
import type { SocketPool } from './socket.ts'

export type RunOptions = { pool?: SocketPool }

export async function* runStep(wire: StepWire, signal: AbortSignal, options: RunOptions = {}): AsyncGenerator<StepEvent> {
  const target = splitTarget(wire.req.target)
  if (target?.provider === 'codex') {
    yield* codexStep(wire.req, target.model, signal, { pool: options.pool })

    return
  }
  yield* failedStep(`rice-multi-models: no provider answers ${wire.req.target}`)
}
