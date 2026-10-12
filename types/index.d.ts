/** This session's choices for routed models: an effort over the Codex default, and the transport. */
export type ModelPrefs = {
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
  transport: 'auto' | 'ws' | 'sse'
}

declare module 'claude-code' {
  interface PluginState {
    'rice-multi-models': {
      prefs: ModelPrefs
    }
  }
}
