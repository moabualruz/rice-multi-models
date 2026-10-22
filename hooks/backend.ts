// The helper that calls providers, seen from the mod. The shipped Node helper (`serve`, started
// at session start) keeps one provider connection per conversation; each step reaches it through its client on
// its private Unix socket, the token in the request body. When it is not running a step starts a one-shot
// helper (`once`) instead. Either way the step goes in on standard input and its events come back one JSON
// line at a time; leaving the loop, or the dispatch being abandoned, kills the process and so cancels the
// provider request.
import type { ModelUsage, ProcessSpawnChunk, ProcessSpawnResult } from 'claude-code'

import type { StepEvent, StepWire, StopReason } from './protocol'

type Child = AsyncGenerator<ProcessSpawnChunk, ProcessSpawnResult, void>

/** How the mod starts processes; register.ts builds it over `$.process.spawn`. */
export type HelperPort = {
  once: (input: string) => Child
  client: (input: string, socketPath: string) => Child
}

/** The running session helper: where it listens and the token every call carries. */
export type SessionHelper = { socketPath: string; token: string }

let session: SessionHelper | undefined
let useSession = true

export function setSessionHelper(helper: SessionHelper | undefined): void {
  session = helper
}

export function sessionHelper(): SessionHelper | undefined {
  return session
}

/** Whether steps go to the session helper when it runs (else always one process per step). */
export function preferSession(prefer: boolean): void {
  useSession = prefer
}

/** The session helper's structured announcement, only after its entire line arrives. */
export function readyLine(text: string): SessionHelper | undefined {
  for (const line of text.split('\n').slice(0, -1)) {
    if (!line.startsWith('ready ')) continue
    try {
      const value: unknown = JSON.parse(line.slice(6))
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const ready = value as Record<string, unknown>
      if (typeof ready.socketPath === 'string' && ready.socketPath !== '' && !/[\r\n\0]/.test(ready.socketPath) && typeof ready.token === 'string' && /^[0-9a-f]{64}$/.test(ready.token)) return { socketPath: ready.socketPath, token: ready.token }
    } catch { /* A partial or malformed announcement is not readiness. */ }
  }
  return undefined
}

const lastLine = (text: string) => text.trim().split('\n').at(-1)?.slice(0, 300) ?? ''

/** A child's events, and how it ended. */
async function* eventsOf(child: Child, ended: { code: number | null; stderr: string; events: number }): AsyncGenerator<StepEvent> {
  let buffer = ''
  let next = await child.next()
  while (!next.done) {
    const piece = next.value
    if (piece.stream === 'stderr') ended.stderr = (ended.stderr + piece.text).slice(-4000)
    else {
      buffer += piece.text
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (line === '') continue
        let event: StepEvent
        try {
          event = JSON.parse(line) as StepEvent
        } catch {
          continue
        }
        ended.events += 1
        yield event
      }
    }
    next = await child.next()
  }
  ended.code = next.value.code
}

/** Client exit 3 means unavailable before sending a request. Other failures must never be replayed. */
const UNREACHED = new Set([3])

/**
 * A step's events. Through the session helper when it runs; a call it never answered goes to a one-shot
 * helper instead, and the session helper is forgotten until it announces itself again. A helper that ends
 * without a stop or an error yields one error.
 */
export async function* helperStep(port: HelperPort, wire: StepWire): AsyncGenerator<StepEvent> {
  let finished = false
  const helper = useSession ? session : undefined
  if (helper) {
    const ended = { code: null as number | null, stderr: '', events: 0 }
    for await (const event of eventsOf(port.client(JSON.stringify({ ...wire, token: helper.token }), helper.socketPath), ended)) {
      if (event.type === 'stop' || event.type === 'error') finished = true
      yield event
    }
    if (finished) return
    if (ended.events > 0 || !UNREACHED.has(ended.code ?? -1)) {
      yield { type: 'error', kind: 'request', text: `rice-multi-models: the session helper ended the step without an answer (client exit ${ended.code})` }

      return
    }
    if (session === helper) session = undefined
  }
  const ended = { code: null as number | null, stderr: '', events: 0 }
  for await (const event of eventsOf(port.once(JSON.stringify(wire)), ended)) {
    if (event.type === 'stop' || event.type === 'error') finished = true
    yield event
  }
  if (!finished) yield { type: 'error', kind: 'request', text: `rice-multi-models: the helper ended without an answer${ended.stderr ? ` (${lastLine(ended.stderr)})` : ''}` }
}

/** A whole answer as text, for compaction and one-shot completions. */
export async function collectText(port: HelperPort, wire: StepWire, signal?: AbortSignal): Promise<{ text: string; usage?: ModelUsage; error?: string; status?: number; aborted?: boolean; stopReason?: StopReason }> {
  let text = ''
  let usage: ModelUsage | undefined
  let error: string | undefined
  let status: number | undefined
  let aborted = false
  let stopReason: StopReason | undefined
  try {
    for await (const event of helperStep(port, wire)) {
      if (event.type === 'text') text += event.text
      else if (event.type === 'usage') usage = { input_tokens: event.in, output_tokens: event.out, cache_read_input_tokens: event.cacheRead, cache_creation_input_tokens: event.cacheWrite }
      else if (event.type === 'error') { error = event.text; status = event.status; aborted = event.aborted === true }
      else if (event.type === 'stop') stopReason = event.reason
    }
  } catch (failure) {
    error ??= 'The routed helper stream did not complete.'
    aborted ||= signal?.aborted === true || failure instanceof Error && (failure.name === 'AbortError' || failure.name === 'TimeoutError')
  }
  aborted ||= signal?.aborted === true

  return { text, ...(usage ? { usage } : {}), ...(error !== undefined ? { error } : {}), ...(status === undefined ? {} : { status }), ...(aborted ? { aborted: true } : {}), ...(stopReason ? { stopReason } : {}) }
}
