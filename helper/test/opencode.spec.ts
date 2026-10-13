// OpenCode Zen and Go as providers: the gateway's model list read, each model's kind and limits from a
// models.dev-shaped catalog, models left out and why, a config that validates, and the key read by Node from
// OpenCode's auth file (the tier's own entry, else the other's). Run: bun test helper
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { resolveExecutable } from '../core/executable.ts'

import { inputBudget, parseConfig } from '../../hooks/config'
import { kindCounts, liveIds, modelOf, opencodeProvider } from '../../hooks/opencode'

const entry = (npm: string | undefined, extra: Record<string, unknown> = {}) => ({
  tool_call: true,
  reasoning: true,
  limit: { context: 400_000, output: 128_000 },
  modalities: { input: ['text', 'image'], output: ['text'] },
  ...(npm ? { provider: { npm } } : {}),
  ...extra,
})
const CATALOG = {
  // The provider-level SDK is reported by models.dev; model entries may explicitly override it.
  'opencode-go': {
    npm: '@ai-sdk/openai-compatible',
    models: {
      'glm-5.3': entry(undefined, { modalities: { input: ['text'], output: ['text'] } }),
      'minimax-m3': entry('@ai-sdk/anthropic', { limit: { context: 1_000_000, output: 131_072 } }),
      'gpt-6-luna': entry('@ai-sdk/openai', { limit: { context: 1_050_000, input: 922_000, output: 128_000 } }),
      'kimi-k2.6': entry(undefined, { status: 'deprecated' }),
      'old-model': entry(undefined, { tool_call: false }),
      'catalog-only': entry('@ai-sdk/openai'),
    },
  },
  opencode: { npm: '@ai-sdk/openai-compatible', models: { 'gemini-3.8-flash': entry('@ai-sdk/google', { limit: { context: 1_048_576, output: 65_536 } }), 'mistral-large-4': entry('@ai-sdk/mistral', { reasoning: false }) } },
}

test('the exact gateway/catalog intersection gets reported protocol, limits and modalities, with no invented effort', () => {
  expect(liveIds('{"object":"list","data":[{"id":"glm-5.3"},{"id":"x"},{"nope":1}]}')).toEqual(['glm-5.3', 'x'])
  expect(liveIds('not json')).toEqual([])
  const live = ['minimax-m3', 'glm-5.3', 'gpt-6-luna', 'kimi-k2.6', 'old-model', 'omen-alpha', 'glm-5.3']
  const { provider, skipped } = opencodeProvider('go', CATALOG, live, '/usr/bin/node', '/h/.local/share/opencode/auth.json', '/plugin/dist/helper.mjs')
  expect(skipped).toEqual(['kimi-k2.6 (retired)', 'old-model (no tool calls)', 'omen-alpha (not in the models.dev catalog)'])
  expect(provider).toMatchObject({ kind: 'openai', baseUrl: 'https://opencode.ai/inference/go/v1', sessionHeader: 'x-opencode-session', headers: { 'x-opencode-client': 'rice-multi-models' } })
  const models = provider['models'] as Record<string, Record<string, unknown>>
  expect(Object.keys(models)).toEqual(['glm-5.3', 'gpt-6-luna', 'minimax-m3'])
  expect(models['glm-5.3']).toEqual({ contextWindow: 400_000, maxOutputTokens: 128_000, vision: false })
  // An openai-compatible SDK names the protocol, not its output-token parameter dialect. An explicit
  // maxTokensParam configuration is required before sending this known output cap; the importer cannot guess it.
  expect(models['glm-5.3']).not.toHaveProperty('maxTokensParam')
  expect(models['minimax-m3']).toEqual({ kind: 'anthropic', contextWindow: 1_000_000, maxOutputTokens: 131_072, vision: true })
  expect(models['gpt-6-luna']).toEqual({
    kind: 'responses',
    contextWindow: 1_050_000,
    maxInputTokens: 922_000,
    maxOutputTokens: 128_000,
    vision: true,
  })
  expect(kindCounts(provider)).toBe('1 openai, 1 responses, 1 anthropic')
  expect(parseConfig(JSON.stringify({ providers: { 'opencode-go': provider } })).errors).toEqual([])
})

test('Zen: an explicit Gemini SDK selects Gemini without inventing thinking options; unsupported SDKs are skipped', () => {
  const { provider, skipped } = opencodeProvider('zen', CATALOG, ['gemini-3.8-flash', 'mistral-large-4'], '/usr/bin/node', '/a.json', '/plugin/dist/helper.mjs')
  const models = provider['models'] as Record<string, Record<string, unknown>>
  expect(provider['baseUrl']).toBe('https://opencode.ai/inference/v1')
  expect(models['gemini-3.8-flash']).toEqual({ kind: 'gemini', contextWindow: 1_048_576, maxOutputTokens: 65_536, vision: true })
  expect(models['mistral-large-4']).toBeUndefined()
  expect(skipped).toEqual(['mistral-large-4 (no supported protocol SDK package in the catalog)'])
  expect(modelOf(undefined)).toEqual({ skip: 'not in the models.dev catalog' })
  expect(parseConfig(JSON.stringify({ providers: { opencode: provider } })).errors).toEqual([])
})

test('limits are optional catalog facts, with no output defaults, window fractions, or dropped equal input limits', () => {
  expect(modelOf(entry('@ai-sdk/openai', { limit: { context: 100, input: 100, output: 80 }, modalities: undefined }))).toEqual({
    model: { kind: 'responses', contextWindow: 100, maxInputTokens: 100, maxOutputTokens: 80 },
  })
  for (const limit of [undefined, null, {}, { context: null, input: null, output: null }, { context: 0, input: -1, output: 1.5 }, { context: '400000', input: Infinity, output: NaN }]) {
    const made = modelOf(entry('@ai-sdk/openai', { limit, modalities: undefined }))
    expect(made).toEqual({ model: { kind: 'responses' } })
    if ('skip' in made) throw new Error(made.skip)
    const parsed = parseConfig(JSON.stringify({ providers: { test: { kind: 'responses', baseUrl: 'https://example.com/v1', auth: 'none', models: { unknown: made.model } } } }))
    expect(parsed.errors).toEqual([])
    expect(inputBudget(parsed.config!.providers['test']!.models['unknown']!)).toBeNull()
  }
  expect(modelOf(entry('@ai-sdk/anthropic', { limit: { context: 200_000 }, modalities: undefined }))).toEqual({ model: { kind: 'anthropic', contextWindow: 200_000 } })
  expect(modelOf(entry('@ai-sdk/google', { limit: { output: 65_536 }, modalities: undefined }))).toEqual({ model: { kind: 'gemini', maxOutputTokens: 65_536 } })
  expect(modelOf(entry('@ai-sdk/openai', { limit: { input: 128_000 }, modalities: undefined }))).toEqual({ model: { kind: 'responses', maxInputTokens: 128_000 } })
  expect(modelOf(entry('@ai-sdk/openai', { limit: { context: 100, input: 101 }, modalities: undefined }))).toEqual({ model: { kind: 'responses', contextWindow: 100 } })
})

test('only an explicitly reported, supported SDK selects the protocol; model overrides never fall back to a provider SDK', () => {
  const missingProtocol = { skip: 'no supported protocol SDK package in the catalog' }
  expect(modelOf(entry(undefined))).toEqual(missingProtocol)
  expect(modelOf(entry(undefined, { provider: { npm: null } }), '@ai-sdk/openai-compatible')).toEqual(missingProtocol)
  for (const npm of ['@ai-sdk/mistral', '@ai-sdk/unrecognized', 'constructor', 'toString', '__proto__']) {
    expect(modelOf(entry(npm), '@ai-sdk/openai-compatible')).toEqual(missingProtocol)
  }
  expect(modelOf(entry('@ai-sdk/openai-compatible', { limit: null, modalities: undefined }))).toEqual({ model: {} })
  const { provider, skipped } = opencodeProvider('go', { 'opencode-go': { models: { missing: entry(undefined) } } }, ['missing'], '/usr/bin/node', '/a.json', '/plugin/dist/helper.mjs')
  expect(provider['models']).toEqual({})
  expect(skipped).toEqual(['missing (no supported protocol SDK package in the catalog)'])
})

test('unknown input modalities and a reasoning boolean do not create capabilities or request policy', () => {
  for (const npm of ['@ai-sdk/openai', '@ai-sdk/google', '@ai-sdk/openai-compatible']) {
    for (const modalities of [undefined, null, {}, { input: [] }, { input: [null] }]) {
      const made = modelOf(entry(npm, { limit: null, modalities }))
      expect('model' in made).toBe(true)
      if ('skip' in made) throw new Error(made.skip)
      expect(made.model).not.toHaveProperty('vision')
      expect(made.model).not.toHaveProperty('effort')
      expect(made.model).not.toHaveProperty('params')
    }
  }
})

test('the key command prints the tier entry key, else the other tier entry key, else nothing', async () => {
  const node = resolveExecutable('node')
  const helper = join(import.meta.dir, '..', '..', 'dist', 'helper.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'rice-opencode-'))
  const file = join(dir, 'auth.json')
  const run = async (tier: 'zen' | 'go') => {
    const command = (opencodeProvider(tier, CATALOG, [], node, file, helper).provider['auth'] as { command: string[] }).command
    expect(command).toEqual([node, helper, 'opencode-key', tier, file])
    const child = spawnSync(command[0]!, command.slice(1), { encoding: 'utf8' })
    return child.stdout.trim()
  }
  try {
    writeFileSync(file, JSON.stringify({ 'opencode-go': { type: 'api', key: 'fake-go' } }))
    expect([await run('zen'), await run('go')]).toEqual(['fake-go', 'fake-go'])
    writeFileSync(file, JSON.stringify({ 'opencode-go': { type: 'api', key: 'fake-go' }, opencode: { type: 'api', key: 'fake-zen' } }))
    expect([await run('zen'), await run('go')]).toEqual(['fake-zen', 'fake-go'])
    writeFileSync(file, JSON.stringify({ openrouter: { type: 'api', key: 'other' } }))
    expect([await run('zen'), await run('go')]).toEqual(['', ''])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
