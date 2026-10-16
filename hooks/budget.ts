// Request-size estimation for the local input-budget guard. The character
// heuristic alone over-counts real tokens by about 2x on long tool-heavy
// transcripts, so the guard anchors on what the provider itself reported for
// the conversation's previous request and estimates only what was added since.
import { estimateTokens } from './providers'

/** The provider-reported input of one conversation's last answered request. */
export type UsageAnchor = { model: string; tokens: number; messages: number }
type Usage = { input_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }

/** Total prompt tokens a provider reported (fresh input plus cache reads and writes), when it reported any. */
export function reportedInput(usage: Usage | null | undefined): number | undefined {
  if (!usage) return undefined
  const parts = [usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens]
    .map(value => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0))
  const total = parts.reduce((sum, value) => sum + value, 0)
  return total > 0 ? total : undefined
}

/**
 * The estimated input of the next request: the anchored previous request plus a
 * heuristic for the transcript messages appended since. Falls back to the whole
 * heuristic when there is no anchor, the model changed, or the transcript shrank
 * (compaction or a rewind).
 */
export function anchoredEstimate(anchor: UsageAnchor | undefined, model: string, transcript: readonly unknown[], whole: () => number): number {
  if (!anchor || anchor.model !== model || transcript.length < anchor.messages) return whole()
  const added = transcript.slice(anchor.messages)
  return anchor.tokens + (added.length ? estimateTokens(added) : 0)
}
