// OpenCode Zen and Go as providers: the gateway's model list read, each model's kind and limits from a
// models.dev-shaped catalog, models left out and why, a config that validates, and the key read by jq from
// OpenCode's auth file (the tier's own entry, else the other's). Run: bun test helper
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseConfig } from '../../hooks/config'
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
  'opencode-go': {
    models: {
      'glm-5.3': entry(undefined, { modalities: { input: ['text'], output: ['text'] } }),
      'minimax-m3': entry('@ai-sdk/anthropic', { limit: { context: 1_000_000, output: 131_072 } }),
      'gpt-6-luna': entry('@ai-sdk/openai', { limit: { context: 1_050_000, input: 922_000, output: 128_000 } }),
      'kimi-k2.6': entry(undefined, { status: 'deprecated' }),
      'old-model': entry(undefined, { tool_call: false }),
    },
  },
  opencode: { models: { 'gemini-3.8-flash': entry('@ai-sdk/google', { limit: { context: 1_048_576, output: 65_536 } }), 'mistral-large-4': entry('@ai-sdk/mistral', { reasoning: false }) } },
}

test('the gateway list is read; each model gets its kind, limits, vision and effort; the rest are named with a reason', () => {
  expect(liveIds('{"object":"list","data":[{"id":"glm-5.3"},{"id":"x"},{"nope":1}]}')).toEqual(['glm-5.3', 'x'])
  expect(liveIds('not json')).toEqual([])
  const live = ['minimax-m3', 'glm-5.3', 'gpt-6-luna', 'kimi-k2.6', 'old-model', 'omen-alpha', 'glm-5.3']
  const { provider, skipped } = opencodeProvider('go', CATALOG, live, '/usr/bin/jq', '/h/.local/share/opencode/auth.json')
  expect(skipped).toEqual(['kimi-k2.6 (retired)', 'old-model (no tool calls)', 'omen-alpha (not in the models.dev catalog)'])
  expect(provider).toMatchObject({ kind: 'openai', baseUrl: 'https://opencode.ai/inference/go/v1', sessionHeader: 'x-opencode-session', headers: { 'x-opencode-client': 'rice-multi-models' } })
  const models = provider['models'] as Record<string, Record<string, unknown>>
  expect(Object.keys(models)).toEqual(['glm-5.3', 'gpt-6-luna', 'minimax-m3'])
  expect(models['glm-5.3']).toEqual({ contextWindow: 400_000, maxOutputTokens: 32_000, vision: false })
  expect(models['minimax-m3']).toEqual({ kind: 'anthropic', contextWindow: 1_000_000, maxOutputTokens: 32_000 })
  expect(models['gpt-6-luna']).toEqual({
    kind: 'responses',
    contextWindow: 1_050_000,
    maxInputTokens: 922_000,
    maxOutputTokens: 32_000,
    params: { reasoning: { summary: 'auto' } },
    effort: { low: { reasoning: { effort: 'low' } }, medium: { reasoning: { effort: 'medium' } }, high: { reasoning: { effort: 'high' } } },
  })
  expect(kindCounts(provider)).toBe('1 openai, 1 responses, 1 anthropic')
  expect(parseConfig(JSON.stringify({ providers: { 'opencode-go': provider } })).errors).toEqual([])
})

test('Zen: Gemini thinks at low or high and shows its thoughts; a Mistral model speaks Chat Completions', () => {
  const { provider } = opencodeProvider('zen', CATALOG, ['gemini-3.8-flash', 'mistral-large-4'], '/usr/bin/jq', '/a.json')
  const models = provider['models'] as Record<string, Record<string, unknown>>
  expect(provider['baseUrl']).toBe('https://opencode.ai/inference/v1')
  expect(models['gemini-3.8-flash']).toMatchObject({
    kind: 'gemini',
    params: { generationConfig: { thinkingConfig: { includeThoughts: true } } },
    effort: { low: { generationConfig: { thinkingConfig: { thinkingLevel: 'low' } } }, high: { generationConfig: { thinkingConfig: { thinkingLevel: 'high' } } } },
  })
  expect(models['mistral-large-4']).toEqual({ contextWindow: 400_000, maxOutputTokens: 32_000 })
  expect(modelOf(undefined)).toEqual({ skip: 'not in the models.dev catalog' })
  expect(parseConfig(JSON.stringify({ providers: { opencode: provider } })).errors).toEqual([])
})

test('the key command prints the tier entry key, else the other tier entry key, else nothing', async () => {
  const jq = Bun.which('jq')
  if (!jq) return
  const dir = mkdtempSync(join(tmpdir(), 'rice-opencode-'))
  const file = join(dir, 'auth.json')
  const run = async (tier: 'zen' | 'go') => {
    const command = (opencodeProvider(tier, CATALOG, [], jq, file).provider['auth'] as { command: string[] }).command
    const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'ignore' })
    return (await new Response(child.stdout).text()).trim()
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
