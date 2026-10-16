import { expect, test } from 'bun:test'
import { BUILTIN_AGENTS } from '../hooks/agents'
import { createEvaluatorSources } from '../hooks/evaluator-sources'
import { planStopEvaluators } from '../hooks/evaluators'

const type = 'owned-plugin:reviewer'
const result = { value: { agent: type } }
const event = { hook_event_name: 'SubagentStop' as const, agent_id: 'owned-child', agent_type: type }
const core = (prompt = 'Final registered prompt', hooks: unknown = { Stop: [{ hooks: [{ type: 'prompt', prompt: 'Final evaluator condition' }] }] }) => ({ plugin: 'engine', tier: 'core', outcome: 'returned', received: { name: 'reviewer', description: 'Verify owned work', prompt, ...(hooks === undefined ? {} : { hooks }) }, returned: result })

test('the final successful core input supplies hooks after another mod rewrites registration', () => {
  const inventory = createEvaluatorSources()
  inventory.registration(result, [{ plugin: 'rewriter', tier: 'user', outcome: 'returned', received: { hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'Original condition' }] }] } }, returned: result }, core()])
  const found = inventory.sources(event)
  expect(found.errors).toEqual([])
  expect(found.sources[0]?.origin).toEqual({ kind: 'agent', id: type })
  const plan = planStopEvaluators(found.sources, event, 'bash')
  expect(plan.errors).toEqual([])
  expect(plan.hooks).toHaveLength(1)
  expect(plan.hooks[0]).toMatchObject({ type: 'prompt', prompt: 'Final evaluator condition' })
  expect(JSON.stringify(found)).not.toContain('Original condition')
})

test('a takeover result without native acceptance carries an explicit unknown instead of guessed hooks', () => {
  const inventory = createEvaluatorSources(BUILTIN_AGENTS)
  inventory.registration(result, [{ plugin: 'other-mod', tier: 'user', outcome: 'returned', received: core().received, returned: result }])
  expect(inventory.sources(event).sources).toEqual([])
  expect(inventory.sources(event).errors).toHaveLength(1)
  // A file-defined custom type may carry its own hooks the mod cannot see; a built-in has none.
  expect(inventory.sources({ ...event, agent_type: 'another-type' }).errors).toHaveLength(1)
  expect(inventory.sources({ ...event, agent_type: 'Explore' })).toEqual({ sources: [], errors: [] })
})

test('failed core input and an outer type rewrite cannot attest the returned agent definition', () => {
  const inventory = createEvaluatorSources()
  inventory.registration(result, [{ ...core(), outcome: 'rejected' }])
  expect(inventory.sources(event).errors).toHaveLength(1)
  inventory.registration({ value: { agent: 'invented:type' } }, [core()])
  expect(inventory.sources(event).errors).toEqual([])
  expect(inventory.sources({ ...event, agent_type: 'invented:type' }).errors).toHaveLength(1)
})

test('an accepted replacement updates only its exact type and absence of hooks means no invented evaluators', () => {
  const inventory = createEvaluatorSources()
  inventory.registration(result, [core()])
  inventory.registration(result, [{ ...core(), received: { name: 'reviewer', description: 'Verify work', prompt: 'Updated prompt' } }])
  expect(inventory.sources(event)).toEqual({ sources: [], errors: [] })
  expect(inventory.sources({ hook_event_name: 'Stop' })).toEqual({ sources: [], errors: [] })
})

test('an agent running as main retains Stop while mixed unqualified stop forms refuse explicitly', () => {
  const inventory = createEvaluatorSources()
  inventory.registration(result, [core()])
  const main = { hook_event_name: 'Stop' as const, agent_type: type }
  expect(planStopEvaluators(inventory.sources(main).sources, main, 'bash').hooks).toHaveLength(1)
  inventory.registration(result, [core('Final prompt', { Stop: [], SubagentStop: [] })])
  expect(inventory.sources(event).errors).toHaveLength(1)
})
