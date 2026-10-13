import { expect, test } from 'bun:test'

import { catalogueRows, type PickerRow } from '../hooks/picker'
import { unknownMetadata, type ModelCatalogue } from '../hooks/catalogue'
import { agentTypeInput, candidates, DISCOVERY_GUIDANCE, DISCOVERY_SCHEMAS, DISCOVERY_SECTION_ID, discoveryInput, limitsReport, modelExecution, modelIsCandidate, modelsReport, nativeAgentSpec, reserveAgentType, withDiscoverySection, workerAgentSpec } from '../hooks/discovery'
import type { Limits } from '../hooks/protocol'

const baseRows: PickerRow[] = [
  { model: 'codex/gpt-6.1-sol', label: 'Sol (Codex)' },
  { model: 'local/qwen-3', label: 'Qwen (local)', description: 'openai endpoint http://127.0.0.1:11434 via rice-multi-models' },
  { model: 'agy/gemini-3.8-flash-high', label: 'Gemini (Antigravity)', description: 'Antigravity CLI as a worker with its own tools' },
  { model: 'grok/grok-build', label: 'Grok Build', description: 'Grok CLI as a worker with its own tools' },
]

test('discovery section replaces its own id once and leaves all other section order intact', () => {
  const initial = [
    { id: 'first', text: 'first section', scope: 'shared' as const },
    { id: DISCOVERY_SECTION_ID, text: 'stale discovery', scope: 'session' as const },
    { id: 'last', text: 'last section', scope: 'session' as const },
    { id: DISCOVERY_SECTION_ID, text: 'duplicate stale section', scope: 'session' as const },
  ]
  const once = withDiscoverySection(initial)
  const twice = withDiscoverySection(once)
  expect(once.map(section => section.id)).toEqual(['first', 'last', DISCOVERY_SECTION_ID])
  expect(twice).toEqual(once)
  expect(once.at(-1)).toMatchObject({ id: DISCOVERY_SECTION_ID, scope: 'session', text: DISCOVERY_GUIDANCE })
})

test('prompt guidance follows session restrictions without imposing a provider preference', () => {
  expect(DISCOVERY_GUIDANCE).toContain('Follow the user\'s provider and model restrictions for this session')
  expect(DISCOVERY_GUIDANCE).toContain('Obey provider quota refusals')
  expect(DISCOVERY_GUIDANCE).toContain('Never fall back to another provider implicitly')
  expect(DISCOVERY_GUIDANCE).toContain('not unlimited capacity')
  expect(DISCOVERY_GUIDANCE).not.toMatch(/Codex-only|Luna|AirFVR/)
})

test('native window explanations distinguish primary integration from per-model registration without changing report keys', () => {
  const report = JSON.parse(modelsReport([], [], { status: 'unavailable', windows: [] }))
  expect(Object.keys(report)).toEqual(['models', 'discovery', 'providerApprovals', 'codexLimits', 'compaction', 'nativeContextRegistration'])
  expect(report.compaction).toMatchObject({ routed: 'unavailable', customSummarization: false, providerFallback: false, nativeClaude: 'unchanged' })
  expect(DISCOVERY_GUIDANCE).toContain('native routed compaction is unavailable')
  expect(report.compaction.modelSwitchGuard).toContain('not proof of request fit')
  for (const explanation of [DISCOVERY_GUIDANCE, report.nativeContextRegistration]) {
    expect(explanation).toContain('main routed native-provider model')
    expect(explanation).toContain('supported process-local CLAUDE_CODE_MAX_CONTEXT_TOKENS')
    expect(explanation).toContain('fresh exact active contextWindow ?? maxContextWindow')
    expect(explanation).toContain('native context meter and automatic compaction threshold')
    expect(explanation).toContain('existing explicit owner override remains authoritative')
    expect(explanation).toContain('discovery failure and session.end restore the value owned by the mod')
    expect(explanation).toContain('ownership state survives hot reload')
    expect(explanation).toContain('numeric per-model')
    expect(explanation).toContain('process-global override does not establish independent custom-subagent windows')
    expect(explanation).toContain('mixed custom models and restoration on plugin unload remain limitations')
    expect(explanation).not.toContain('200k fallback')
  }
})

test('owned discovery schemas stay strict for host and remote tool translation', () => {
  expect(DISCOVERY_SCHEMAS['mcp__rice-multi-models__models']).toEqual({
    type: 'object',
    properties: { action: { type: 'string', enum: ['models', 'status'] } },
    required: ['action'],
    additionalProperties: false,
  })
  expect(DISCOVERY_SCHEMAS['mcp__rice-multi-models__agent_type']).toEqual({
    type: 'object',
    properties: { model: { type: 'string' }, mode: { type: 'string', enum: ['read', 'write'], default: 'read' } },
    required: ['model'],
    additionalProperties: false,
  })
})

test('picker candidates come only from the fresh catalogue with unknown metadata kept unknown', () => {
  const catalogue: ModelCatalogue = {
    models: [{ model: 'codex/fresh-model', label: 'Fresh', execution: 'native provider', source: 'fixture authenticated models endpoint', observedAt: 1_800_000_000_000, metadata: unknownMetadata() }],
    providers: [{ provider: 'codex', status: 'fresh', source: 'fixture authenticated models endpoint', observedAt: 1_800_000_000_000 }],
  }
  const rows = candidates(catalogueRows(catalogue), model => ({
    source: 'fixture authenticated models endpoint',
    execution: 'native provider',
    identity: `subscription:${model}`,
    codexSubscriptionQuota: true,
  }))
  expect(rows.map(row => row.model)).toEqual(['codex/fresh-model'])
  expect(rows[0]).toMatchObject({ source: 'fixture authenticated models endpoint', execution: 'native provider', codexSubscriptionQuota: true })
  expect(rows[0]?.description).toContain('context unknown, input unknown, output unknown')
})

test('empty and unavailable catalogues never manufacture a default candidate', () => {
  for (const providers of [[], [{ provider: 'codex', status: 'unavailable' as const, source: 'fixture authenticated models endpoint', error: 'fixture-unavailable' }]]) {
    const rows = candidates(catalogueRows({ models: [], providers }))
    expect(rows).toEqual([])
    expect(modelIsCandidate('codex/gpt-6.1-sol', rows)).toBe(false)
    expect(modelExecution('codex/gpt-6.1-sol', rows)).toBeUndefined()
  }
})

test('model candidates distinguish native providers from the supplied CLI workers', () => {
  const rows = candidates(baseRows)
  expect(rows.map(row => row.model)).toEqual(['codex/gpt-6.1-sol', 'local/qwen-3', 'agy/gemini-3.8-flash-high', 'grok/grok-build'])
  expect(modelExecution('local/qwen-3', rows)).toBe('native provider')
  expect(modelExecution('agy/gemini-3.8-flash-high', rows)).toBe('CLI worker')
  expect(modelExecution('grok/grok-build', rows)).toBe('CLI worker')
  const configured = candidates([...baseRows, { model: 'agy/review-model', label: 'Configured Antigravity namespace' }], model => model === 'agy/review-model'
    ? { source: 'configured provider', execution: 'native provider', identity: 'configured:agy/review-model', codexSubscriptionQuota: false }
    : undefined)
  expect(modelExecution('agy/review-model', configured)).toBe('native provider')
  expect(modelExecution('local/not-supplied', rows)).toBeUndefined()
  expect(modelIsCandidate('local/not-supplied', rows)).toBe(false)
})

test('model and status tool inputs are strict and the agent mode defaults to read', () => {
  expect(discoveryInput({ action: 'models' })).toEqual({ action: 'models' })
  expect(discoveryInput({ action: 'status', extra: true })).toBeUndefined()
  expect(discoveryInput({ action: 'refresh' })).toBeUndefined()
  expect(agentTypeInput({ model: 'local/qwen-3' })).toEqual({ model: 'local/qwen-3', mode: 'read' })
  expect(agentTypeInput({ model: 'local/qwen-3', mode: 'write' })).toEqual({ model: 'local/qwen-3', mode: 'write' })
  expect(agentTypeInput({ model: 'local/qwen-3', mode: 'auto' })).toBeUndefined()
  expect(agentTypeInput({ model: 'local/qwen-3', mode: 'read', permissionMode: 'bypassPermissions' })).toBeUndefined()
  expect(agentTypeInput({ model: ' local/qwen-3' })).toBeUndefined()
})

test('dynamic native Agent type names are stable per model and mode but differ across pairs', () => {
  const registry = new Map<string, string>()
  const first = reserveAgentType(registry, 'local/qwen-3\\u0000read\\u0000route-a', 1)
  const reused = reserveAgentType(registry, 'local/qwen-3\\u0000read\\u0000route-a', first.index)
  const write = reserveAgentType(registry, 'local/qwen-3\\u0000write\\u0000route-a', reused.index)
  const otherModel = reserveAgentType(registry, 'codex/gpt-6.1-sol\\u0000read\\u0000route-a', write.index)
  const changedRoute = reserveAgentType(registry, 'local/qwen-3\\u0000read\\u0000route-b', otherModel.index)
  expect(first).toMatchObject({ name: 'model-1', reused: false })
  expect(reused).toMatchObject({ name: 'model-1', reused: true })
  expect(write).toMatchObject({ name: 'model-2', reused: false })
  expect(otherModel).toMatchObject({ name: 'model-3', reused: false })
  expect(changedRoute).toMatchObject({ name: 'model-4', reused: false })
  expect([...registry.values()].every(name => /^[A-Za-z0-9_-]{1,64}$/.test(name))).toBe(true)
})

test('native registrations use native Agent specs without permission overrides while CLI workers stay distinct', () => {
  const nativeRead = nativeAgentSpec('model-1', 'local/qwen-3', 'read')
  const nativeWrite = nativeAgentSpec('model-2', 'codex/gpt-6.1-sol', 'write')
  const cliRead = workerAgentSpec('model-3', 'agy/gemini-3.8-flash-high', 'read', 'Antigravity (Gemini)')
  expect(nativeRead.model).toBe('local/qwen-3')
  expect(nativeRead.prompt).toContain('Search with the Glob and Grep tools')
  expect(nativeRead.tools).toEqual(['Read', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch'])
  expect(nativeWrite.prompt).toContain('general-purpose agent')
  expect(nativeWrite.tools).toBeUndefined()
  expect('permissionMode' in nativeRead).toBe(false)
  expect('permissionMode' in nativeWrite).toBe(false)
  expect(cliRead.model).toBe('agy/gemini-3.8-flash-high')
  expect(cliRead.description).toContain('CLI worker with its own tools')
  expect(cliRead.tools).toEqual([])
  expect(cliRead.description).toContain('reads and plans only (plan mode)')
})

test('missing limits remain unavailable while reported limits include observed time and reset metadata', () => {
  expect(limitsReport(undefined, undefined)).toEqual({ status: 'unavailable', windows: [] })
  const limits: Limits = { plan: 'standard', windows: [{ label: 'weekly', usedPercent: 41, resetsAt: 1_800_000_000_000 }] }
  expect(limitsReport(limits, 1_700_000_000_000)).toEqual({
    status: 'reported',
    observedAt: '2023-11-14T22:13:20.000Z',
    plan: 'standard',
    windows: [{ label: 'weekly', usedPercent: 41, resetsAt: 1_800_000_000_000 }],
  })
})

test('model report is candidate-only and does not expose provider endpoint descriptions', () => {
  const secretLikeUrl = 'https://user:private-token@example.invalid/v1'
  const rows = candidates([
    { model: 'local/qwen-3', label: 'Qwen', description: `openai endpoint ${secretLikeUrl} via rice-multi-models` },
    { model: 'agy/model-a', label: 'Worker', description: 'Antigravity CLI as a worker with its own tools' },
  ])
  const report = modelsReport(rows, [{ provider: 'local', approved: false }], { status: 'unavailable', windows: [] })
  expect(report).toContain('candidate, not live-entitlement proof')
  expect(report).toContain('CLI worker')
  expect(report).not.toContain(secretLikeUrl)
  expect(report).not.toContain('private-token')
  expect(report).not.toContain('auth.json')
  expect(report).not.toContain('baseUrl')
  expect(report).toContain('"approved": false')
  expect(report).toContain('"status": "unavailable"')
  expect(report).toContain('"usageLimits": {\n        "status": "unavailable"')
})
