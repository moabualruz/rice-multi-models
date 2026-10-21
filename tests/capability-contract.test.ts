import { expect, test } from 'bun:test'

import { parseConfig } from '../hooks/config'
import { capabilityContracts, formatCapabilityContracts, selectTools, toolCoverageWarning } from '../hooks/capability-contract'
import { fetchTierConfigState } from '../hooks/fetch-config'
import { webSearchStatus } from '../hooks/web-search-status'
import type { Config } from '../hooks/config'
import type { RemoteTool } from '../hooks/protocol'

const config = parseConfig(JSON.stringify({
  providers: {
    anthropic: { kind: 'anthropic', baseUrl: 'https://anthropic.example', maxTools: 4, auth: 'none', models: { opus: { contextWindow: 200_000, maxInputTokens: 180_000, maxOutputTokens: 20_000, tools: ['Read', 'Write'], effort: { low: { output_config: { effort: 'low' } }, high: { output_config: { effort: 'high' } } }, cache: '1h', webSearch: 'native', parallelToolCalls: false } } },
    chat: { kind: 'openai', baseUrl: 'https://chat.example', auth: 'none', models: { unknown: { tools: true, maxOutputTokens: 4096, maxTokensParam: 'max_tokens' } } },
    responses: { kind: 'responses', baseUrl: 'https://responses.example', auth: 'none', models: { gpt: { maxOutputTokens: 4000 } } },
    gemini: { kind: 'gemini', baseUrl: 'https://gemini.example', auth: 'none', models: { flash: { contextWindow: 1_000_000, maxOutputTokens: 8000 } } },
    bedrock: { kind: 'bedrock', baseUrl: 'https://bedrock.example', auth: { command: ['/usr/bin/false'] }, models: { sonnet: { contextWindow: 200_000, maxOutputTokens: 8000, cache: '5m' } } },
  },
}))

test('capability contracts describe every configured provider model and label absent bounds unknown', () => {
  expect(config.errors).toEqual([])
  const reports = capabilityContracts(config.config as Config)
  expect(reports.map(report => report.target)).toEqual(['anthropic/opus', 'bedrock/sonnet', 'chat/unknown', 'gemini/flash', 'responses/gpt'])
  const anthropic = reports[0]!
  expect(anthropic.target).toBe('anthropic/opus')
  expect(anthropic.protocol).toBe('anthropic')
  expect(anthropic.tools).toMatchObject({ enabled: true, allowlist: ['Read', 'Write'], cap: 4, configuredCount: 2 })
  expect(anthropic.tools.schemaFidelity).toContain('not enabled')
  expect(anthropic.vision).toBe(true)
  expect(anthropic.documents).toContain('PDF')
  expect(anthropic.contextWindow).toEqual({ status: 'known', tokens: 200_000 })
  expect(anthropic.inputTokens).toEqual({ status: 'known', tokens: 180_000 })
  expect(anthropic.outputTokens).toEqual({ status: 'known', tokens: 20_000 })
  expect(anthropic.parallelCalls).toBe(false)
  expect(anthropic.reasoning).toMatchObject({ status: 'configured', effort: ['low', 'high'] })
  expect(anthropic.caching).toMatchObject({ enabled: true, lifetime: '1h' })
  expect(anthropic.web).toMatchObject({ search: 'native', fetch: 'not configured per model' })
  const unknown = reports.find(report => report.target === 'chat/unknown')!
  expect(unknown.contextWindow).toEqual({ status: 'unknown', tokens: null })
  expect(unknown.inputTokens).toEqual({ status: 'unknown', tokens: null })
  expect(unknown.outputTokens).toEqual({ status: 'known', tokens: 4096 })
  expect(unknown.web).toMatchObject({ search: 'unknown', fetch: 'not configured per model' })
})

test('runtime capability output reports narrowed tools and keeps full-capability coverage silent', () => {
  const parsed = parseConfig(JSON.stringify({ providers: {
    allowed: { kind: 'openai', baseUrl: 'https://allowed.example', auth: 'none', maxTools: 8, models: { narrow: { tools: ['Read', 'Write'] } } },
    capped: { kind: 'openai', baseUrl: 'https://capped.example', auth: 'none', maxTools: 2, models: { small: { tools: true } } },
    local: { kind: 'openai', baseUrl: 'http://local.example:8080', allowHttp: true, auth: 'none', maxTools: 8, models: { qwen: { tools: false } } },
    full: { kind: 'openai', baseUrl: 'https://full.example', auth: 'none', maxTools: 8, models: { complete: { tools: true } } },
  } }))
  expect(parsed.errors).toEqual([])
  const runtimeTools: RemoteTool[] = ['Read', 'Write', 'Bash', 'Grep', 'Glob'].map(name => ({ name, description: name, schema: {} }))
  const configured = parsed.config as Config
  const cases = [
    ['allowed/narrow', configured.providers['allowed']!, configured.providers['allowed']!.models['narrow']!],
    ['capped/small', configured.providers['capped']!, configured.providers['capped']!.models['small']!],
    ['local/qwen', configured.providers['local']!, configured.providers['local']!.models['qwen']!],
    ['full/complete', configured.providers['full']!, configured.providers['full']!.models['complete']!],
  ] as const
  const reports = capabilityContracts(configured)
  const output = [formatCapabilityContracts(reports), ...cases.flatMap(([target, provider, model]) => {
    const offered = selectTools(runtimeTools, provider, model)
    return [toolCoverageWarning(target, runtimeTools.length, offered.length)].filter((line): line is string => line !== undefined)
  })].join('\n')
  expect(output).toContain('allowed/narrow (openai): tools=on, allowlist=Read,Write, configured-cap=8, allowlisted-count=2')
  expect(output).toContain('capped/small is offered 2 of 5 session tools')
  expect(output).toContain('local/qwen is offered 0 of 5 session tools')
  expect(output).toContain('allowed/narrow is offered 2 of 5 session tools')
  expect(output).not.toContain('full/complete is offered')
  expect(selectTools(runtimeTools, configured.providers['full']!, configured.providers['full']!.models['complete']!)).toHaveLength(5)
})

test('web capability output uses the configured search and fetch tier status functions', () => {
  const fetch = fetchTierConfigState({ endpoints: [{ name: 'fetch-primary', priority: 1 }] }, true)
  const status = webSearchStatus('anthropic/opus', undefined, { version: 1, endpoints: [] }, undefined, true, fetch)
  const web = {
    'anthropic/opus': {
      search: JSON.stringify({ policy: 'native', providerNative: status.providerNative, configuredServices: status.configuredServices, fallback: status.claudeFallback }),
      fetch: JSON.stringify({ tiers: status.fetchTierState.tiers }),
    },
  }
  const output = formatCapabilityContracts(capabilityContracts(config.config as Config, web))
  expect(output).toContain('web-search={"policy":"native"')
  expect(output).toContain('provider-native')
  expect(output).toContain('configured-service')
  expect(output).toContain('native-fallback')
  expect(output).toContain('direct-selected-extraction')
})

test('tool selection applies model allowlists and the provider cap in one stable pass', () => {
  const p = (config.config as Config).providers['anthropic']!
  const m = p.models['opus']!
  const tools: RemoteTool[] = ['Read', 'Write', 'Bash', 'Grep'].map(name => ({ name, description: '', schema: {} }))
  expect(selectTools(tools, p, m).map(tool => tool.name)).toEqual(['Read', 'Write'])
  expect(selectTools(tools, { ...p, maxTools: 1 }, m).map(tool => tool.name)).toEqual(['Read'])
  expect(toolCoverageWarning('anthropic/opus', 4, 2)).toContain('offered 2 of 4 session tools')
  expect(toolCoverageWarning('anthropic/opus', 2, 2)).toBeUndefined()
})
