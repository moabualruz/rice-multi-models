/** How model windows reach Claude: one explanation for setup, status and the models report. */
export const NATIVE_WINDOW_EXPLANATION = "Each model's reported context window, input and output limits, effort levels and capabilities appear in the model catalogue and picker. Window resolution, accounting and automatic compaction stay Claude's own, per agent; the mod sets no context override. For a non-Claude model Claude uses CLAUDE_CODE_MAX_CONTEXT_TOKENS when the owner sets it, otherwise its default. The public plugin API has no numeric per-model registration."

/** Public host contract, not a claim that picker metadata configures native accounting. */
export const NATIVE_MODEL_LIMITATIONS = {
  version: '2.1.310',
  registration: 'No public model.register/model definition operation for contextWindow, inputTokenLimit, outputTokenLimit, reasoningEfforts or capabilities. Picker rows expose identity and descriptive text, not numeric model accounting.',
  childBudget: 'AgentSpawnInput and TurnStepInput expose no per-invocation context/input/output budget. AgentSpec.autoCompactWindow only lowers an existing custom definition window, from 100000 to 1000000; it is not a built-in/fork/resume fix and cannot represent a smaller budget.',
  recovery: 'TurnStepChunk has no provider error chunk or recovery directive. TurnStepResult cannot rewrite the already streamed native response. A null stop preserves failure, but cannot deliver a native-recognized context-overflow error or request child compaction. session.compact has no agentId selector and is refused during a running turn.',
  visibility: 'agent.spawn description, ToolUse, ToolProgress and task UserMessage display props are public. There is no AgentList/agent-row render component, no mutable resumed-spawn description, and no child identity on Spinner.',
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
