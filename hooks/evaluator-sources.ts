import type { On } from 'claude-code'
import type { EvaluatorEvent, EvaluatorSource } from './evaluators'

type Row = Record<string, unknown>
type RegistrationTrace = { plugin: string; tier: string; outcome: string; received: unknown; returned: unknown }
type AcceptedDefinition = { kind: 'accepted'; hooks?: Row } | { kind: 'unknown' }
const object = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value)

function registeredType(value: unknown): string | undefined {
  return object(value) && object(value.value) && typeof value.value.agent === 'string' && value.value.agent ? value.value.agent : undefined
}

function definition(value: unknown): AcceptedDefinition {
  if (!object(value) || typeof value.name !== 'string' || typeof value.description !== 'string' || typeof value.prompt !== 'string'
    || value.hooks !== undefined && !object(value.hooks)) return { kind: 'unknown' }
  return { kind: 'accepted', ...(value.hooks !== undefined ? { hooks: value.hooks } : {}) }
}

/**
 * Only successful native acceptance attests the definition a registered type uses.
 * `builtins` are the host's own agent types, which carry no frontmatter hooks.
 */
export function createEvaluatorSources(builtins: readonly string[] = []) {
  const definitions = new Map<string, AcceptedDefinition>()
  return {
    registration(result: unknown, trace: readonly RegistrationTrace[]): void {
      const accepted = new Set<string>()
      for (const link of trace) {
        if (link.plugin !== 'engine' || link.tier !== 'core' || !['returned', 'passed'].includes(link.outcome)) continue
        const type = registeredType(link.returned)
        if (!type) continue
        definitions.set(type, definition(link.received))
        accepted.add(type)
      }
      // A takeover can return any existing or invented type. Its input is not
      // evidence of the definition the engine actually holds for that type.
      const answer = registeredType(result)
      if (answer && !accepted.has(answer)) definitions.set(answer, { kind: 'unknown' })
    },

    sources(event: EvaluatorEvent): { sources: EvaluatorSource[]; errors: string[] } {
      const type = event.agent_type
      if (!type) return { sources: [], errors: [] }
      const actual = definitions.get(type)
      // Agent files (user, project, plugin agents folders) never pass through
      // agent.register, so their own frontmatter hooks are not visible here.
      if (!actual) return builtins.includes(type) ? { sources: [], errors: [] } : { sources: [], errors: [`The agent type ${type} comes from a definition file whose own hooks the mod cannot see.`] }
      if (actual.kind === 'unknown') return { sources: [], errors: ['The registered agent type has no successfully accepted native definition; its evaluator hooks cannot be inferred from the registration request.'] }
      if (!actual.hooks) return { sources: [], errors: [] }
      let hooks = actual.hooks
      if (event.hook_event_name === 'SubagentStop' && hooks.Stop !== undefined) {
        // Native frontmatter Stop becomes SubagentStop for that child. Avoid
        // inventing ordering when both forms were explicitly authored.
        if (hooks.SubagentStop !== undefined) return { sources: [], errors: ['The registered agent defines both Stop and SubagentStop; their native registration order has not been qualified.'] }
        hooks = { ...hooks, SubagentStop: hooks.Stop }
      }
      return { sources: [{ origin: { kind: 'agent', id: type }, settings: { hooks } }], errors: [] }
    },
  }
}

/** Distinct matcher permits an integration to keep its own registration observer. */
export function registerEvaluatorSources(on: On, inventory: ReturnType<typeof createEvaluatorSources>): void {
  on('agent.register', { name: /.+/ }, async (_$, e, next) => {
    const result = await next(e)
    inventory.registration(result, next.trace)
    return result
  })
}
