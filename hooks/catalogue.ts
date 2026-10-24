/** How model windows reach Claude: one explanation for setup, status and the models report. */
export const NATIVE_WINDOW_EXPLANATION = "Every discovered model is a native /model picker row. Its reported context window fills Claude's per-model modelSettings.<id>.autoCompactWindow (100000 to 1000000), its top effort below xhigh fills modelSettings.<id>.maxEffortLevel, and its effort levels fill CLAUDE_CODE_MODEL_CAPABILITIES. CLAUDE_CODE_MAX_CONTEXT_TOKENS holds the largest reported window, so each model's own window can sit at its real size; Claude's own models are unaffected. All of it is written to ~/.claude/settings.json, which Claude loads when it launches: a model first discovered during a session gets its data from the next launch, and the mod changes nothing in the running session. An id naming a Claude model, such as opencode/claude-sonnet-4-6, is that Claude model to Claude, so Claude's own data applies and the mod writes it no per-model setting. An owner's own value stays authoritative. Window resolution, accounting and automatic compaction stay Claude's own, per agent. Claude has no native field for a non-Claude model's family, output or input limit, modalities or knowledge cutoff."

/** Public host contract, not a claim that picker metadata configures native accounting. */
export const NATIVE_MODEL_LIMITATIONS = {
  version: '2.1.310',
  registration: 'No public model.register/model definition operation for contextWindow, inputTokenLimit, outputTokenLimit, reasoningEfforts or capabilities. Picker rows expose identity and descriptive text, not numeric model accounting.',
  childBudget: 'AgentSpawnInput and TurnStepInput expose no per-invocation context/input/output budget. AgentSpec.autoCompactWindow only lowers an existing custom definition window, from 100000 to 1000000; it is not a built-in/fork/resume fix and cannot represent a smaller budget.',
  recovery: 'TurnStepChunk has no provider error chunk or recovery directive. TurnStepResult cannot rewrite the already streamed native response. A null stop preserves failure, but cannot deliver a native-recognized context-overflow error or request child compaction. session.compact has no agentId selector and is refused during a running turn.',
  visibility: 'agent.spawn description, ToolUse, ToolProgress and task UserMessage display props are public. There is no AgentList/agent-row render component, no mutable resumed-spawn description, and no child identity on Spinner.',
  exploreInherit: 'Claude Code runs built-in Explore on opus when a first-party parent uses fable or mythos. That decision depends on gateway credential state that $.env.get cannot read, so agent.spawn cannot label the resolved child model there and the row may show the parent model instead. Native dispatch is unchanged.',
  agentDefinition: 'No public resolved definition or composed per-child system prompt exists for project or SDK agents, so the mod reads the agent file Claude itself applies and sends its prompt unchanged to whichever model runs the agent.',
} as const

export type ModelMetadata = {
  contextWindow: number | null
  maxContextWindow: number | null
  inputTokenLimit: number | null
  outputTokenLimit: number | null
  autoCompactTokenLimit: number | null
  inputModalities: string[] | null
  reasoningEfforts: string[] | null
  tools: boolean | null
  parallelToolCalls: boolean | null
}

export type DiscoveredModel = {
  model: string
  label: string
  execution: 'native provider'
  source: string
  observedAt: number
  metadata: ModelMetadata
  metadataSources?: Partial<Record<keyof ModelMetadata, string>>
}

export type DiscoveryProvider = {
  provider: string
  status: 'fresh' | 'unavailable' | 'approval-required'
  source: string
  observedAt?: number
  error?: string
}

export type ModelCatalogue = { models: DiscoveredModel[]; providers: DiscoveryProvider[] }

export const unknownMetadata = (): ModelMetadata => ({
  contextWindow: null,
  maxContextWindow: null,
  inputTokenLimit: null,
  outputTokenLimit: null,
  autoCompactTokenLimit: null,
  inputModalities: null,
  reasoningEfforts: null,
  tools: null,
  parallelToolCalls: null,
})
