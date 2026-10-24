// Copied from Trosfy/claude-styx hooks/step.ts at 5072384
// (MIT, Copyright (c) 2026 styx contributors; see LICENSES/claude-styx.MIT.txt).
// Modified by Mo Abualruz: failure texts name rice-multi-models; mintToolId comes from ./protocol.
// A routed step's events as the engine's turn.step chunks: block indexes, coalesced deltas, tool calls,
// and the end, which is one stop carrying usage. A failed request has a null stop reason,
// no executable tool call, and for children an explicitly labelled runtime failure diagnostic. Pure.
import type { TurnStepChunk, TurnStepToolUse, TurnUsage } from 'claude-code'

import { mintToolId } from './protocol'
import type { StepError, StepEvent, StopReason } from './protocol'
import { redact } from './redact'

/** A runtime diagnostic, not a successful model answer or a fabricated compaction summary. */
function childFailure(model: string, error: StepError): string {
  const bounded = (text: string, max: number) => redact(text.slice(0, max * 4)).replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
  return `rice-multi-models: child request failed [${error.cause ?? `${error.kind}_failed`}] on ${bounded(model, 200)}${error.status === undefined ? '' : ` (HTTP ${error.status})`}. ${bounded(error.text, 700)} No plugin recovery was attempted; existing transcript retained.`
}
// The step's end: its last chunks (the stop among them, last), what it answered, and the failure text when
// it failed.
type StepEnd = { chunks: TurnStepChunk[]; answer: string; toolUses: TurnStepToolUse[]; stopReason: StopReason | null; usage: TurnUsage | null; failure?: string; error?: StepError; diagnostic?: string; delivered?: true }

export { coalesce } from './coalesce'

// One step's chunks, built as its events come. A text or thinking delta continues the open block of its
// kind, else opens one at the next index; a tool call takes the next index and closes the open block. Usage
// is reported as `usageModel`'s.
export function createAssembler(usageModel: string) {
  let next = 0
  let open: { type: 'text' | 'thinking'; index: number } | undefined
  let answer = ''
  const toolUses: TurnStepToolUse[] = []
  let usage: TurnUsage | null = null
  let reason: StopReason | undefined
  let failure: StepError | undefined

  return {
    feed(ev: StepEvent): TurnStepChunk[] {
      if (failure !== undefined && ev.type !== 'usage') return []
      if (ev.type === 'text' || ev.type === 'thinking') {
        if (open?.type !== ev.type) open = { type: ev.type, index: next++ }
        if (ev.type === 'text') answer += ev.text
        return [{ kind: ev.type, index: open.index, text: ev.text }]
      }
      if (ev.type === 'tool_use') {
        const index = next++
        open = undefined
        toolUses.push({ name: ev.name, input: ev.input })
        return [
          { kind: 'tool', index, id: ev.id, name: ev.name },
          { kind: 'input', index, json: JSON.stringify(ev.input) },
        ]
      }
      if (ev.type === 'usage') usage = { input_tokens: ev.in, output_tokens: ev.out, cache_read_input_tokens: ev.cacheRead, cache_creation_input_tokens: ev.cacheWrite, model: usageModel }
      else if (ev.type === 'stop') reason = ev.reason
      else if (ev.type === 'error') failure ??= ev
      return []
    },
    // Native unsuccessful stop: preserve received text and usage, but never authorize tools
    // or report end_turn after a provider failure. The caller withholds tool chunks until success.
    end(o: { handback?: string; failure?: string; deliver?: boolean; child?: boolean } = {}): StepEnd {
      const failed: StepError | undefined =
        o.failure !== undefined
          ? { type: 'error', kind: 'request', text: o.failure, aborted: true }
          : (failure ?? (reason === undefined ? { type: 'error', kind: 'request', text: `rice-multi-models: ${usageModel} ended the step with no stop; retry` } : undefined))
      if (failed === undefined) {
        const stopReason = toolUses.length > 0 ? 'tool_use' : reason === 'tool_use' || reason === undefined ? 'end_turn' : reason
        // `deliver`: a text-only successful end is handed back as one call of `handback` carrying the text.
        if (o.deliver === true && o.handback !== undefined && toolUses.length === 0 && stopReason === 'end_turn' && answer.trim() !== '') {
          const index = next++
          open = undefined
          const input = { message: answer }
          toolUses.push({ name: o.handback, input })
          const chunks: TurnStepChunk[] = [
            { kind: 'tool', index, id: mintToolId(), name: o.handback },
            { kind: 'input', index, json: JSON.stringify(input) },
            { kind: 'stop', stopReason: 'tool_use', usage },
          ]
          return { chunks, answer, toolUses: [...toolUses], stopReason: 'tool_use', usage, delivered: true }
        }
        return { chunks: [{ kind: 'stop', stopReason, usage }], answer, toolUses: [...toolUses], stopReason, usage }
      }
      // The public step API has no error chunk. Keep the unsuccessful null stop, but give a
      // child a clearly labelled runtime diagnostic so its native report cannot be empty success.
      const diagnostic = o.child && !failed.aborted ? childFailure(usageModel, failed) : undefined
      const text = diagnostic === undefined ? '' : `${answer ? '\n\n' : ''}${diagnostic}`
      const chunks: TurnStepChunk[] = diagnostic === undefined ? [] : [{ kind: 'text', index: next, text }]
      chunks.push({ kind: 'stop', stopReason: null, usage })
      return { chunks, answer: answer + text, toolUses: [], stopReason: null, usage, failure: failed.text, error: failed, ...(diagnostic ? { diagnostic } : {}) }
    },
  }
}
