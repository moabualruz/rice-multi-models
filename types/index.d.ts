/** This session's choices for routed models: an effort over the Codex default, the transport, and whether steps go to the session helper. */
export type ModelPrefs = {
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
  transport: 'auto' | 'ws' | 'sse'
  helper: 'session' | 'once'
  workers: 'read' | 'write'
}

declare module 'claude-code' {
  interface PluginState {
    'rice-multi-models': {
      prefs: ModelPrefs
      nativeContext: { original: string | null; applied: string | null; relinquished: boolean }
      /** The main transcript's file, as the engine's classic hooks name it (a compaction summary cites it). */
      transcript: { path: string | null }
    }
  }
}
