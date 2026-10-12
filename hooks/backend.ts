// The helper that calls providers, seen from the mod: one process per routed request (helper/main.ts
// `once`), the step sent on its standard input and its events read back one JSON line at a time. Leaving the
// loop, or the dispatch being abandoned, kills the process and so cancels the provider request. No socket.
import type { HookStream, ModelUsage, ProcessSpawnChunk, ProcessSpawnResult } from 'claude-code'

import type { StepEvent, StepWire } from './protocol'

/** How the mod starts a helper; register.ts builds it over `$.process.spawn`. */
export type HelperPort = { spawn: (input: string) => HookStream<ProcessSpawnChunk, ProcessSpawnResult> }

const lastLine = (text: string) => text.trim().split('\n').at(-1)?.slice(0, 300) ?? ''

/** A step's events as the helper writes them; a helper that ends without a stop or an error yields one error. */
export async function* helperStep(port: HelperPort, wire: StepWire): AsyncGenerator<StepEvent> {
  let buffer = ''
  let stderr = ''
  let ended = false
  for await (const piece of port.spawn(JSON.stringify(wire))) {
    if (piece.stream === 'stderr') {
      stderr = (stderr + piece.text).slice(-4000)
      continue
    }
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
      if (event.type === 'stop' || event.type === 'error') ended = true
      yield event
    }
  }
  if (!ended) yield { type: 'error', kind: 'request', text: `rice-multi-models: the helper ended without an answer${stderr ? ` (${lastLine(stderr)})` : ''}` }
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
