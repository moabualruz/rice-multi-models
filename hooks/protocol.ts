// Adapted from Trosfy/claude-styx hooks/protocol.ts at 5072384
// (MIT, Copyright (c) 2026 styx contributors; see LICENSES/claude-styx.MIT.txt).
// Modified by Mo Abualruz: a step names its target by model id (`codex/<slug>`), carries the session for cache
// keys and the transport to use; events add `signature` (reasoning to carry back) and `limits`.
//
// The contract between the mod and the helper that answers its routed steps. Pure: no engine types and
// no I/O, so the shipped Node helper imports it as the mod does.

/** A transcript message as `$.session.messages({ as: "api" })` gives it. */
export type ApiMessage = { role: 'user' | 'assistant'; content: string | readonly ({ type: string } & Record<string, unknown>)[] }

/** A tool the remote model is offered; a deferred one is sent once the transcript has loaded it. */
export type RemoteTool = { name: string; description: string; schema: Record<string, unknown>; deferred?: boolean }

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type Transport = 'auto' | 'ws' | 'sse'
export type WebSearch = { allowedDomains?: string[]; blockedDomains?: string[]; maxUses?: number; location?: Record<string, unknown> }
export type WebFetch = { url: string; maxUses: 1; maxContentTokens: number }
export type SearchSource = { title: string; url: string; content?: string }
/** `complete` certifies reported call accounting, separately from answer completion. */
export type SearchEvidence = { sources: SearchSource[]; searched: boolean; calls?: number; complete?: boolean }

/**
 * One routed step: the model id it is for, the system prompt, the tools offered, the transcript (in
 * Anthropic Messages form, with any reasoning carried back as `thinking` blocks), the effort, who asks
 * (`main` or an agentId) and the session it belongs to.
 */
export type StepRequest = {
  /** Only opt-in dispatches carry durable candidates; native turn/step IDs are authoritative. */
  continuation?: { boundary: { turnId: string; index: number }; maxAgeSeconds: number; records: readonly unknown[] }
  target: string
  system: string
  tools: readonly RemoteTool[]
  transcript: readonly ApiMessage[]
  effort?: Effort | number
  who: string
  session: string
  transport?: Transport
  /** Authentic native request constraints, preserved by the in-process adapter. */
  native?: {
    maxTokens?: number
    stopSequences?: string[]
    toolChoice?: { type: 'auto' | 'any' | 'none' | 'tool'; name?: string; disable_parallel_tool_use?: boolean }
    outputSchema?: Record<string, unknown>
    /** Dedicated hosted search. Only the selected provider's search tool is offered. */
    webSearch?: WebSearch
    /** Dedicated hosted fetch. Only the selected provider's fetch tool is offered. */
    webFetch?: WebFetch
  }
}

export type StopReason = 'end_turn' | 'max_tokens' | 'refusal' | 'tool_use' | 'stop_sequence'

/** Tokens: input not read from cache, output, cache reads and writes, and the reasoning share of output. */
export type Usage = { in: number; out: number; cacheRead: number; cacheWrite: number; reasoning?: number }

/** A provider's own rate-limit report: the share of each window used and when it resets. */
export type Limits = { plan?: string; windows: { label: string; usedPercent: number; resetsAt?: number }[] }

/**
 * One event of a step's answer, in order. `text` and `thinking` stream as deltas; `signature` closes a
 * reasoning block the mod keeps and sends back before the tool calls it led to; a `tool_use` is a whole
 * call. The events end with one `stop` or `error`, then `stats`.
 */
export type StepEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'signature'; thinking: string; signature: string }
  /** Internal helper protocol metadata, never a native chunk, transcript row or UI value. */
  | { type: 'continuation'; record: import('./continuation').ContinuationRecord }
  | { type: 'continuation_status'; status: 'restored' | 'no-compatible-state' | 'opaque-state-not-retained' | 'no-extra-required' }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  /** Server-tool blocks executed by the direct native adapter, within the same owner. */
  | { type: 'native_block'; block: Record<string, unknown> }
  | ({ type: 'search_sources' } & SearchEvidence)
  | ({ type: 'usage' } & Usage)
  | { type: 'limits'; limits: Limits }
  | { type: 'stop'; reason: StopReason }
  | { type: 'error'; kind: 'request' | 'response'; text: string; status?: number; aborted?: boolean }
  | ({ type: 'stats' } & StepStats)

/**
 * How one step went: ms to the first response byte (null when none came) and in all, how it travelled, and,
 * from the claude-styx provider kinds, the request body's bytes, the prompt and output tokens and the finish.
 */
export type StepStats = { ttfbMs: number | null; totalMs: number; transport?: string; reqBytes?: number; in?: number | null; out?: number | null; reasoning?: number; finish?: string }

/** A configured provider's key as the helper holds it (claude-styx's). */
export type ProviderStatus = { provider: string; key: 'cached' | 'not-run' | 'failed' | 'none'; failure?: string }

/**
 * What every call to the helper carries: the session helper's token, the validated provider config's text
 * (empty when there is none), the providers approved so far (their fingerprints) and the User-Agent.
 */
export type Wire = { token?: string; configText: string; approved: readonly string[]; userAgent?: string }

/** A step as the helper receives it. */
export type StepWire = Wire & { req: StepRequest }

/** A step that failed before it could be answered. */
export const failedStep = (text: string, totalMs = 0, transport = 'none'): StepEvent[] => [
  { type: 'error', kind: 'request', text },
  { type: 'stats', ttfbMs: null, totalMs, transport, finish: 'error' },
]

/** The provider and model of a routed id: `codex/gpt-6.1-sol` gives `codex` and `gpt-6.1-sol`. */
export function splitTarget(target: string): { provider: string; model: string } | null {
  const at = target.indexOf('/')
  if (at <= 0) return null

  return { provider: target.slice(0, at), model: target.slice(at + 1).replace(/\[1m\]$/i, '') }
}

/** A tool-call id minted here (a SubagentHandback the mod answers with): Anthropic-shaped, under OpenAI's 40. */
export const mintToolId = () => `toolu_rice_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`
