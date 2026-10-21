import { expect, test } from 'bun:test'
import { CARRIER_VALUE, classifyCall, markDescription, unmarkDescription, descriptionSuffix, emptyCarrier, entryOf, exactModelIds, forgetEntry, pickRequested, recordEntry, SCHEMA_ENUM_LIMIT, widenAgentSchema, withDescriptionSuffix } from '../hooks/agent-model'
import { unknownMetadata } from '../hooks/catalogue'
import type { ModelCatalogue } from '../hooks/catalogue'
import { remoteTools } from '../hooks/tools'
import type { NativeTool } from '../hooks/native-tools'
import { parseConfig } from '../hooks/config'
import type { Loaded } from '../hooks/providers'

const model = (id: string) => ({ model: id, label: id, execution: 'native provider' as const, source: 'fixture', observedAt: 1, metadata: unknownMetadata() })
const catalogue: ModelCatalogue = {
  models: [model('codex/gpt-6.1-sol'), model('codex/gpt-6-luna'), model('stale/old')],
  providers: [{ provider: 'codex', status: 'fresh', source: 'fixture' }, { provider: 'stale', status: 'unavailable', source: 'fixture' }],
}
const configText = JSON.stringify({
  providers: { local: { kind: 'openai', baseUrl: 'https://fixture.invalid/v1', auth: 'none', models: { qwen: { contextWindow: 8000, maxOutputTokens: 1000 } } } },
  aliases: { fast: { target: 'local/qwen' } },
})
const parsed = parseConfig(configText)
const loaded: Loaded = { path: 'fixture', text: configText, config: parsed.config, errors: parsed.errors }
const ids = exactModelIds(catalogue, loaded)

test('the accepted ids are discovered models of fresh providers, declared models and declared aliases', () => {
  expect(parsed.errors).toEqual([])
  expect(ids).toEqual(['codex/gpt-6-luna', 'codex/gpt-6.1-sol', 'fast', 'local/qwen'])
  expect(exactModelIds({ models: [], providers: [] }, { path: 'x', text: '', errors: [] })).toEqual([])
})

test('a call is classified before the engine checks it', () => {
  expect(classifyCall(undefined, ids)).toEqual({ kind: 'pass' })
  expect(classifyCall('sonnet', ids)).toEqual({ kind: 'pass' })
  expect(classifyCall(7, ids)).toEqual({ kind: 'pass' })
  expect(classifyCall(CARRIER_VALUE, ids)).toEqual({ kind: 'pass' })
  expect(classifyCall('codex/gpt-6.1-sol', ids)).toEqual({ kind: 'carry', id: 'codex/gpt-6.1-sol' })
  expect(classifyCall('fast', ids)).toEqual({ kind: 'carry', id: 'fast' })
})

test('an unknown id is denied with the valid values and nothing is carried', () => {
  for (const bad of ['codex/gpt-9', 'stale/old', 'Codex/gpt-6.1-sol', 'codex/gpt-6.1-sol ']) {
    const verdict = classifyCall(bad, ids)
    expect(verdict.kind).toBe('deny')
    if (verdict.kind === 'deny') {
      expect(verdict.reason).toContain(`"${bad}"`)
      for (const valid of ['haiku', 'sonnet', 'opus', 'fable', ...ids]) expect(verdict.reason).toContain(valid)
      expect(verdict.reason).toContain('no subagent was started')
    }
  }
  const many = Array.from({ length: 100 }, (_, index) => `p/m${String(index).padStart(3, '0')}`)
  const long = classifyCall('p/none', many)
  expect(long.kind === 'deny' && long.reason).toContain('and 44 more')
})

test('the carrier records, consumes and forgets by tool_use_id, and parallel calls keep their own ids', () => {
  let state = emptyCarrier
  state = recordEntry(state, { toolUseId: 'toolu_a', kind: 'exact', id: 'codex/gpt-6.1-sol', at: 1 })
  state = recordEntry(state, { toolUseId: 'toolu_b', kind: 'exact', id: 'codex/gpt-6-luna', at: 2 })
  expect(entryOf(state, 'toolu_a')?.id).toBe('codex/gpt-6.1-sol')
  expect(entryOf(state, 'toolu_b')?.id).toBe('codex/gpt-6-luna')
  expect(entryOf(state, 'toolu_missing')).toBeUndefined()
  expect(entryOf(state, '')).toBeUndefined()
  state = forgetEntry(state, 'toolu_a')
  expect(entryOf(state, 'toolu_a')).toBeUndefined()
  expect(entryOf(state, 'toolu_b')?.id).toBe('codex/gpt-6-luna')
  expect(forgetEntry(state, 'toolu_a')).toBe(state)
  state = recordEntry(state, { toolUseId: '__proto__', kind: 'exact', id: 'x/y', at: 4 })
  expect(entryOf(state, '__proto__')?.id).toBe('x/y')
  expect(entryOf(state, 'constructor')).toBeUndefined()
})

test('abandoned records are bounded', () => {
  let state = emptyCarrier
  for (let index = 0; index < 400; index++) state = recordEntry(state, { toolUseId: `toolu_${index}`, kind: 'exact', id: 'a/b', at: index })
  expect(state.entries.length).toBe(128)
  expect(entryOf(state, 'toolu_399')).toBeDefined()
  expect(entryOf(state, 'toolu_0')).toBeUndefined()
})

test('a spawn restores the exact id, refuses a marked spawn with no record and refuses a fork', () => {
  const entry = { toolUseId: 't', kind: 'exact' as const, id: 'codex/gpt-6-luna', at: 1 }
  expect(pickRequested(entry, CARRIER_VALUE, false, true)).toEqual({ requested: 'codex/gpt-6-luna', exact: 'codex/gpt-6-luna' })
  const missing = pickRequested(undefined, CARRIER_VALUE, false, true)
  expect('deny' in missing && missing.deny).toContain('could not be recovered')
  expect('deny' in missing && missing.deny).toContain('not run as haiku')
  // An unmarked haiku is the engine's own request.
  expect(pickRequested(undefined, CARRIER_VALUE, false, false)).toEqual({ requested: CARRIER_VALUE })
  expect(pickRequested(undefined, 'sonnet', false, false)).toEqual({ requested: 'sonnet' })
  expect(pickRequested(undefined, undefined, false, false)).toEqual({ requested: undefined })
  const fork = pickRequested(entry, CARRIER_VALUE, true, true)
  expect('deny' in fork && fork.deny).toContain('fork')
})

test('the description mark is invisible, removable and absent from other text', () => {
  const marked = markDescription('Fix the bug')
  expect(unmarkDescription(marked)).toEqual({ text: 'Fix the bug', marked: true })
  expect(unmarkDescription('Fix the bug')).toEqual({ text: 'Fix the bug', marked: false })
  expect(unmarkDescription(markDescription(undefined))).toEqual({ text: '', marked: true })
})

const agentSchema = { type: 'object', properties: { description: { type: 'string' }, model: { type: 'string', enum: ['sonnet', 'opus', 'haiku', 'fable'], description: 'engine text' } }, required: ['description'] }

test('the routed schema lists the engine values plus the exact ids and keeps the engine text', () => {
  const widened = widenAgentSchema(agentSchema, ids) as any
  expect(widened.properties.model.enum).toEqual(['sonnet', 'opus', 'haiku', 'fable', ...ids])
  expect(widened.properties.model.description).toBe('engine text')
  expect(widened.required).toEqual(['description'])
  expect((agentSchema.properties.model.enum as string[]).length).toBe(4)
  expect(widenAgentSchema(agentSchema, [])).toBe(agentSchema)
  const wide = widenAgentSchema(agentSchema, Array.from({ length: SCHEMA_ENUM_LIMIT + 1 }, (_, index) => `p/m${index}`)) as any
  expect(wide.properties.model.enum).toBeUndefined()
  expect(wide.properties.model.type).toBe('string')
  const noEnum = { type: 'object', properties: { model: { type: 'string' } } }
  expect(widenAgentSchema(noEnum, ids)).toBe(noEnum)
})

test('the description gets one short suffix derived from the ids, once', () => {
  expect(descriptionSuffix([])).toBe('')
  expect(withDescriptionSuffix('Engine text.', [])).toBe('Engine text.')
  const text = withDescriptionSuffix('Engine text.', ids)
  expect(text.startsWith('Engine text.\n\n[rice-multi-models]')).toBe(true)
  for (const id of ids) expect(text).toContain(id)
  expect(withDescriptionSuffix(text, ids)).toBe(text)
  expect(/[–—]/.test(text)).toBe(false)
  const many = descriptionSuffix(Array.from({ length: 80 }, (_, index) => `p/m${index}`))
  expect(many).toContain('and 50 more')
})

test('remoteTools widens only the built-in Agent tool', () => {
  const infos = [{ name: 'Agent', description: 'live', mcp: false }, { name: 'mcp__x__Agent', description: 'mcp', mcp: true }, { name: 'Bash', description: 'b', mcp: false }]
  const native = new Map<string, NativeTool>([['Agent', { name: 'Agent', description: 'captured', input_schema: agentSchema }]])
  const tools = remoteTools(infos, new Map([['Agent', { description: 'engine Agent text' }]]), () => true, {}, native, ids)
  const agent = tools.find(tool => tool.name === 'Agent')!
  expect((agent.schema as any).properties.model.enum).toEqual(['sonnet', 'opus', 'haiku', 'fable', ...ids])
  expect(agent.description.startsWith('engine Agent text\n\n[rice-multi-models]')).toBe(true)
  expect(tools.find(tool => tool.name === 'mcp__x__Agent')!.description).toBe('mcp')
  expect(tools.find(tool => tool.name === 'Bash')!.description).toBe('b')
  const plain = remoteTools(infos, new Map(), () => true, {}, native)
  expect(plain.find(tool => tool.name === 'Agent')!.description).toBe('live')
  expect((plain.find(tool => tool.name === 'Agent')!.schema as any).properties.model.enum).toEqual(['sonnet', 'opus', 'haiku', 'fable'])
})
