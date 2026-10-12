// The helper that calls providers, seen from the mod. The session helper (helper/main.ts `serve`, started
// at session start) keeps one provider connection per conversation; each step reaches it through curl on
// its private Unix socket, the token in the request body. When it is not running a step starts a one-shot
// helper (`once`) instead. Either way the step goes in on standard input and its events come back one JSON
// line at a time; leaving the loop, or the dispatch being abandoned, kills the process and so cancels the
// provider request.
import type { HookStream, ModelUsage, ProcessSpawnChunk, ProcessSpawnResult } from 'claude-code'

import type { StepEvent, StepWire } from './protocol'

type Child = HookStream<ProcessSpawnChunk, ProcessSpawnResult>

/** How the mod starts processes; register.ts builds it over `$.process.spawn`. */
export type HelperPort = {
  once: (input: string) => Child
  curl: (input: string, socketPath: string) => Child
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

const READY = /^ready (\S+) ([0-9a-f]{64})$/m

/** The session helper's announcement on its standard output, once complete. */
export function readyLine(text: string): SessionHelper | undefined {
  const match = READY.exec(text)

  return match ? { socketPath: match[1] as string, token: match[2] as string } : undefined
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

/** curl's exits that mean the session helper was not reached or dropped the call before answering. */
const UNREACHED = new Set([7, 52, 56])

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
    for await (const event of eventsOf(port.curl(JSON.stringify({ ...wire, token: helper.token }), helper.socketPath), ended)) {
      if (event.type === 'stop' || event.type === 'error') finished = true
      yield event
    }
    if (finished) return
    if (ended.events > 0 || !UNREACHED.has(ended.code ?? -1)) {
      yield { type: 'error', kind: 'request', text: `rice-multi-models: the session helper ended the step without an answer (curl exit ${ended.code})` }

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
export async function collectText(port: HelperPort, wire: StepWire): Promise<{ text: string; usage?: ModelUsage; error?: string }> {
  let text = ''
  let usage: ModelUsage | undefined
  let error: string | undefined
  for await (const event of helperStep(port, wire)) {
    if (event.type === 'text') text += event.text
    else if (event.type === 'usage') usage = { input_tokens: event.in, output_tokens: event.out, cache_read_input_tokens: event.cacheRead, cache_creation_input_tokens: event.cacheWrite }
    else if (event.type === 'error') error = event.text
  }

  return { text, ...(usage ? { usage } : {}), ...(error !== undefined ? { error } : {}) }
}
