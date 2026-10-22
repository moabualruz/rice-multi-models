// Request-size estimation for the local input-budget guard. The character
// heuristic alone over-counts real tokens by about 2x on long tool-heavy
// transcripts, so the guard anchors on what the provider itself reported for
// the conversation's previous request and estimates only what was added since.
import { estimateTokens } from './providers'

/** The provider-reported input of one conversation's last answered request. */
export type UsageAnchor = { model: string; tokens: number; messages: number }
type Usage = { input_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }

/** Host-reported capacity facts. Invalid, absent, and non-integer values are ignored. */
export type RequestCapacity = {
  contextWindow?: unknown
  maxContextWindow?: unknown
  inputTokenLimit?: unknown
  outputTokenLimit?: unknown
}

export type RequestBudgetOptions = {
  /** Output reserved for the exact request model. Defaults conservatively when metadata is missing. */
  outputReserve?: number
  /** Room for system text, request instructions, and serialization overhead. */
  overhead?: number
  /** Safe input budget when no usable capacity fact is available. */
  conservativeInput?: number
}

const DEFAULT_OUTPUT_RESERVE = 2_048
const DEFAULT_REQUEST_OVERHEAD = 2_048
const DEFAULT_CONSERVATIVE_INPUT = 8_192
const positiveSafeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0

/**
 * Conservative input-token allowance for a request on one exact model. Active context, max context,
 * and input limits all constrain capacity; maxContextWindow never expands a smaller active window.
 */
export function requestInputBudget(capacity: RequestCapacity | null | undefined, options: RequestBudgetOptions = {}): number {
  const outputReserve = positiveSafeInteger(options.outputReserve)
    ? options.outputReserve
    : positiveSafeInteger(capacity?.outputTokenLimit) ? capacity.outputTokenLimit : DEFAULT_OUTPUT_RESERVE
  const overhead = Number.isSafeInteger(options.overhead) && options.overhead! >= 0 ? options.overhead! : DEFAULT_REQUEST_OVERHEAD
  const fallback = positiveSafeInteger(options.conservativeInput) ? options.conservativeInput : DEFAULT_CONSERVATIVE_INPUT
  const active = positiveSafeInteger(capacity?.contextWindow) ? capacity.contextWindow : undefined
  const maximum = positiveSafeInteger(capacity?.maxContextWindow) ? capacity.maxContextWindow : undefined
  const inputLimit = positiveSafeInteger(capacity?.inputTokenLimit) ? capacity.inputTokenLimit : undefined
  if (active === undefined) {
    const maximumInput = maximum === undefined ? Infinity : maximum - outputReserve - overhead
    const reportedInput = inputLimit === undefined ? Infinity : inputLimit - overhead
    return Math.max(0, Math.min(fallback, maximumInput, reportedInput))
  }
  const contextLimit = Math.min(active, maximum ?? Infinity) - outputReserve
  return Math.max(0, Math.min(contextLimit, inputLimit ?? Infinity) - overhead)
}

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
