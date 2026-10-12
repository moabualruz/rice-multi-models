/** This session's choices for routed models: an effort over the Codex default, the transport, and whether steps go to the session helper. */
export type ModelPrefs = {
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
  transport: 'auto' | 'ws' | 'sse'
  helper: 'session' | 'once'
}

declare module 'claude-code' {
  interface PluginState {
    'rice-multi-models': {
      prefs: ModelPrefs
    }
  }
}
