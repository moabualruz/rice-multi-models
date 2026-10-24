/** This session's choices for routed models: an effort over the Codex default, the transport, and whether steps go to the session helper. */
export type ModelPrefs = {
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
  transport: 'auto' | 'ws' | 'sse'
  helper: 'session' | 'once'
}

export type AgentModelOwner = { id: string; model: string; explicitNative: boolean; background?: boolean; effort?: string | number }

/** Observed invocation display data only; never a substitute model identity or agent address. */
export type AgentDisplay = { toolUseId: string; agentId?: string; model?: string; effort?: string | number }

/** Mod-owned transaction receipt. Hashes identify context, never retain its content. */
export type CompactionReceipt = {
  id: string; session: string; owner: string; model: string
  trigger: 'manual' | 'auto' | 'plugin' | 'precompute'
  status: 'preparing' | 'prepared' | 'installed' | 'aborted'
  at: number; expiresAt: number; source: string
  expected?: string; expectedCount?: number; expectedWasPresent?: boolean; observedAt?: 'persisted-history'
  reason?: 'superseded' | 'session-changed' | 'expired' | 'model-changed' | 'stale-context' | 'cancelled' | 'failed' | 'configured-policy' | 'interrupted' | 'clear'
  usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
}

declare module 'claude-code' {
  interface PluginState {
    'rice-multi-models': {
      prefs: ModelPrefs
      'agent-model-owners': { entries: readonly AgentModelOwner[] }
      /** Bounded runtime diagnostics for the last failed step of each child; never provider payloads. */
      'child-failures': { entries: readonly { agentId: string; turnId: string; report: string }[] }
      'compaction-receipts': { entries: readonly CompactionReceipt[] }
      'agent-display': { entries: readonly AgentDisplay[] }
      nativeContext: { original: string | null; applied: string | null; relinquished: boolean }
      /** The main transcript's file, as the engine's classic hooks name it (a compaction summary cites it). */
      transcript: { path: string | null }
      /** Exact Agent model ids awaiting their agent.spawn, by tool_use_id (see hooks/agent-model.ts). */
      'agent-model-carrier': { entries: readonly { toolUseId: string; kind: 'exact'; at: number; id: string }[] }
    }
  }
}
