// The events of one step, whichever provider its target names: `codex/...` goes to the Codex provider
// (ChatGPT subscription); any provider declared in the config (OpenAI-style, Anthropic-style or Bedrock
// endpoints, adapted from claude-styx) goes to the styx step runner, which keeps keys, tool ids and signed
// thinking for the helper's life.
import type { ApiMessage, RemoteTool, StepEvent, StepRequest, StepWire } from '../hooks/protocol.ts'
import { failedStep, splitTarget } from '../hooks/protocol.ts'
import { codexStep } from './codex.ts'
import { harnessStep } from './harness.ts'
import type { SocketPool } from './socket.ts'
import type { Runner } from './styx/auth'
import { createStepper } from './styx/step'
import { post } from './styx/upstream'

export type RunOptions = { pool?: SocketPool }

// A credential helper run with no shell, its stdin closed and its stderr dropped, killed after `timeoutMs`.
// From Trosfy/claude-styx styxd/main.ts at 5072384 (MIT; see LICENSES/claude-styx.MIT.txt).
const runHelper: Runner = async (argv, timeoutMs) => {
  const child = Bun.spawn([...argv], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', timeout: timeoutMs })
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (child.signalCode === 'SIGTERM') throw new Error(`timed out after ${timeoutMs} ms`)

  return { exitCode, stdout }
}

let stepper: ReturnType<typeof createStepper> | undefined
const styx = () => (stepper ??= createStepper({ post, run: runHelper, now: () => Date.now(), log: line => process.stderr.write(`${line}\n`) }))

/** The names the transcript has loaded: tools it called, and tools a ToolSearch result referenced. */
export function loadedNames(transcript: readonly ApiMessage[]): Set<string> {
  const names = new Set<string>()
  const visit = (block: unknown): void => {
    if (!block || typeof block !== 'object') return
    const record = block as Record<string, unknown>
    if (record.type === 'tool_use' && typeof record.name === 'string') names.add(record.name)
    if (record.type === 'tool_reference' && typeof record.tool_name === 'string') names.add(record.tool_name)
    if (Array.isArray(record.content)) record.content.forEach(visit)
  }
  for (const message of transcript) if (Array.isArray(message.content)) message.content.forEach(visit)

  return names
}

/** The tools a configured provider is sent: every tool in front, and a deferred one once loaded. */
export function offeredTools(req: StepRequest): RemoteTool[] {
  const loaded = loadedNames(req.transcript)

  return req.tools.filter(tool => !tool.deferred || loaded.has(tool.name)).map(({ deferred: _deferred, ...tool }) => tool)
}

export async function* runStep(wire: StepWire, signal: AbortSignal, options: RunOptions = {}): AsyncGenerator<StepEvent> {
  const target = splitTarget(wire.req.target)
  if (target?.provider === 'codex') {
    yield* codexStep(wire.req, target.model, signal, { pool: options.pool })

    return
  }
  if (target?.provider === 'agy' || target?.provider === 'grok') {
    yield* harnessStep(wire.req, target.provider, target.model, signal)

    return
  }
  if (wire.configText.trim() !== '') {
    yield* styx().step({ ...wire, req: { ...wire.req, tools: offeredTools(wire.req) } }, signal)

    return
  }
  yield* failedStep(`rice-multi-models: no provider answers ${wire.req.target}; declare it in rice-multi-models.json`)
}
