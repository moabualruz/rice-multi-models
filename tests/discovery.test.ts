import { expect, test } from 'bun:test'

import { catalogueRows, type PickerRow } from '../hooks/picker'
import { unknownMetadata, type ModelCatalogue } from '../hooks/catalogue'
import { candidates, discoveryGuidance, DISCOVERY_SECTION_ID, limitsReport, modelExecution, modelIsCandidate, modelsReport, withDiscoverySection } from '../hooks/discovery'
import type { Limits } from '../hooks/protocol'

const baseRows: PickerRow[] = [
  { model: 'codex/gpt-6.1-sol', label: 'Sol (Codex)' },
  { model: 'local/qwen-3', label: 'Qwen (local)', description: 'openai endpoint http://127.0.0.1:11434 via rice-multi-models' },
  { model: 'agy/gemini-3.8-flash-high', label: 'Gemini (Antigravity)', description: 'Antigravity CLI as a worker with its own tools' },
  { model: 'grok/grok-build', label: 'Grok Build', description: 'Grok CLI as a worker with its own tools' },
]

const families = [
  { family: 'codex', label: 'OpenAI Codex (ChatGPT subscription)', type: 'rice-multi-models:codex', model: 'codex/gpt-6.1-sol', tiers: { haiku: 'codex/gpt-6.1-mini' } },
  { family: 'claude', label: 'Claude (Anthropic)', type: 'rice-multi-models:claude' },
]

test('discovery section replaces its own id once and leaves all other section order intact', () => {
  const initial = [
    { id: 'first', text: 'first section', scope: 'shared' as const },
    { id: DISCOVERY_SECTION_ID, text: 'stale discovery', scope: 'session' as const },
    { id: 'last', text: 'last section', scope: 'session' as const },
    { id: DISCOVERY_SECTION_ID, text: 'duplicate stale section', scope: 'session' as const },
  ]
  const text = discoveryGuidance(families)
  const once = withDiscoverySection(initial, text)
  const twice = withDiscoverySection(once, text)
  expect(once.map(section => section.id)).toEqual(['first', 'last', DISCOVERY_SECTION_ID])
  expect(twice).toEqual(once)
  expect(once.at(-1)).toMatchObject({ id: DISCOVERY_SECTION_ID, scope: 'session', text })
})

test('family guidance keeps each conversation in its family and names explicit native choices only', () => {
  const text = discoveryGuidance(families, [{ type: 'rice-multi-models:agy', label: 'Antigravity (Gemini)' }])
  expect(text).toContain('Each conversation stays on its own provider family')
  expect(text).toContain('pick a tier inside the current family; they never switch provider')
  expect(text).toContain('only when the user or session instructions ask for it')
  expect(text).toContain('OpenAI Codex (ChatGPT subscription): codex/gpt-6.1-sol (tiers: haiku -> codex/gpt-6.1-mini); agent type rice-multi-models:codex')
  expect(text).toContain('Claude (Anthropic): native Claude models; agent type rice-multi-models:claude')
  expect(text).toContain('CLI worker agent type rice-multi-models:agy')
  expect(text).toContain('never switch providers to get around them')
  expect(text).not.toMatch(/mcp__|Luna|AirFVR/)
})

test('native window explanations distinguish primary integration from per-model registration without changing report keys', () => {
  const report = JSON.parse(modelsReport([], [], { status: 'unavailable', windows: [] }))
  expect(Object.keys(report)).toEqual(['models', 'discovery', 'providerApprovals', 'codexLimits', 'compaction', 'nativeContextRegistration'])
  expect(report.compaction).toMatchObject({ routed: 'session.compact', customSummarization: true, providerFallback: false, nativeClaude: 'unchanged' })
  expect(report.compaction.modelSwitchGuard).toContain('not proof of request fit')
  for (const explanation of [report.nativeContextRegistration]) {
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
