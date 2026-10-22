/** This session's choices for routed models: an effort over the Codex default, the transport, and whether steps go to the session helper. */
export type ModelPrefs = {
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
  transport: 'auto' | 'ws' | 'sse'
  helper: 'session' | 'once'
}

export type AgentModelOwner = { id: string; model: string; explicitNative: boolean; background?: boolean }

declare module 'claude-code' {
  interface PluginState {
    'rice-multi-models': {
      prefs: ModelPrefs
      'agent-model-owners': { entries: readonly AgentModelOwner[] }
      nativeContext: { original: string | null; applied: string | null; relinquished: boolean }
      /** The main transcript's file, as the engine's classic hooks name it (a compaction summary cites it). */
      transcript: { path: string | null }
      /** Exact Agent model ids awaiting their agent.spawn, by tool_use_id (see hooks/agent-model.ts). */
      'agent-model-carrier': { entries: readonly { toolUseId: string; kind: 'exact'; at: number; id: string }[] }
    }
  }
}
