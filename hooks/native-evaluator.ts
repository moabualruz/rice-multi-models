import type { ApiMessage } from './protocol'

export const EVALUATOR_MARK = 'RICE_OWNED_EVALUATOR_CONDITION_42'
export type EvaluatorTemplate = { version: string; event: 'Stop' | 'SubagentStop'; system: string; prefix: string; maxTokens: number; outputSchema: Record<string, unknown> }
export type EvaluatorContext = { template: EvaluatorTemplate; transcript: readonly ApiMessage[]; maxTokens: number }

export function isEvaluatorTemplate(value: unknown): value is EvaluatorTemplate {
  if (!value || typeof value !== 'object') return false
  const v = value as EvaluatorTemplate
  return typeof v.version === 'string' && ['Stop', 'SubagentStop'].includes(v.event) && typeof v.system === 'string' && v.system.length > 0 && typeof v.prefix === 'string' && v.prefix.length > 0 && Number.isSafeInteger(v.maxTokens) && v.maxTokens > 0 && !!v.outputSchema && typeof v.outputSchema === 'object' && !Array.isArray(v.outputSchema)
}
