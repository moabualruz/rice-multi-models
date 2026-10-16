// Copied from Trosfy/claude-styx hooks/step.ts at 5072384 (MIT, Copyright (c) 2026 styx contributors;
// see LICENSES/claude-styx.MIT.txt). Modified by Mo Abualruz: coalesce alone, so the helper imports no engine types.
import type { StepEvent } from './protocol'

// Adjacent text deltas merged into one, and adjacent thinking deltas likewise, so what arrives together
// reaches the engine as one chunk.
export function coalesce(events: readonly StepEvent[]): StepEvent[] {
  const out: StepEvent[] = []
  for (const ev of events) {
    const last = out.at(-1)
    if ((ev.type === 'text' || ev.type === 'thinking') && (last?.type === 'text' || last?.type === 'thinking') && last.type === ev.type) {
      out[out.length - 1] = { type: ev.type, text: last.text + ev.text }
    } else out.push(ev)
  }
  return out
}
