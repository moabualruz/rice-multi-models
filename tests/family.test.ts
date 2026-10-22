import { describe, expect, test } from 'bun:test'
import { CLAUDE_FAMILY, familyOf, parseTiers, spawnDecision, stepModel, tierModel, tierOf } from '../hooks/family'
import type { FamilyPorts } from '../hooks/family'

const ports: FamilyPorts = {
  isRouted: model => model.includes('/'),
  providerOf: model => model.includes('/') ? model.slice(0, model.indexOf('/')) : undefined,
  defaultModel: family => ({ codex: 'codex/gpt-main', a: 'a/main', b: 'b/child' } as Record<string, string>)[family],
}
const spawn = (input: Partial<Parameters<typeof spawnDecision>[0]>, tiers = {}) => {
  const decision = spawnDecision({ parentModel: 'a/main', fork: false, ...input }, tiers, ports)
  return { ...decision, native: decision.model === undefined }
}

describe('family identity', () => {
  test('routed models belong to their provider and everything else to Claude', () => {
    expect(familyOf('codex/gpt-main', ports)).toBe('codex')
    expect(familyOf('sonnet', ports)).toBe(CLAUDE_FAMILY)
    expect(familyOf(undefined, ports)).toBe(CLAUDE_FAMILY)
  })
  test('tiers come from aliases and full Claude ids, never from routed ids', () => {
    expect(tierOf('haiku')).toBe('haiku')
    expect(tierOf('claude-haiku-4-5')).toBe('haiku')
    expect(tierOf('claude-opus-5-5[1m]')).toBe('opus')
    expect(tierOf('claude-haiku-5-5')).toBe('haiku')
    expect(tierOf('claude-sonnet-5-5')).toBe('sonnet')
    expect(tierOf('claude-fable-5-1')).toBe('fable')
    expect(tierOf('claude-haiku-9-9')).toBeUndefined()
    expect(tierOf('claude-sonnet-9-9')).toBeUndefined()
    expect(tierOf('claude-opus-9-9')).toBeUndefined()
    expect(tierOf('claude-haiku-4-5[1m]')).toBeUndefined()
    expect(tierOf('claude-haiku-9-9[1m]')).toBeUndefined()
    expect(tierOf('a/opus-like')).toBeUndefined()
    expect(tierOf('my-haiku-runtime')).toBeUndefined()
    expect(tierOf('claude-haiku-runtime')).toBeUndefined()
    expect(tierOf('inherit')).toBeUndefined()
  })
})

describe('tier resolution inside one family', () => {
  const tiers = { a: { haiku: 'a/small', default: 'a/large' }, codex: { haiku: 'b/wrong-family' } }
  test('a configured tier wins, then the configured default, then the anchor', () => {
    expect(tierModel('a', 'haiku', 'a/main', tiers, ports)).toBe('a/small')
    expect(tierModel('a', 'opus', 'a/main', tiers, ports)).toBe('a/large')
    expect(tierModel('a', 'opus', 'a/main', {}, ports)).toBe('a/main')
  })
  test('a misconfigured tier from another family is ignored', () => {
    expect(tierModel('codex', 'haiku', 'codex/gpt-main', tiers, ports)).toBe('codex/gpt-main')
  })
  test('without an anchor the family default is used', () => {
    expect(tierModel('b', 'sonnet', undefined, {}, ports)).toBe('b/child')
  })
  test('a family default from another provider is ignored', () => {
    const wrongDefault: FamilyPorts = { ...ports, defaultModel: () => 'a/other' }
    expect(tierModel('b', 'sonnet', undefined, {}, wrongDefault)).toBeUndefined()
  })
})

describe('spawn decisions', () => {
  test('a routed parent keeps default subagents in its family', () => {
    expect(spawn({})).toMatchObject({ model: 'a/main', family: 'a', explicit: false })
    expect(spawn({ requested: 'haiku' })).toMatchObject({ model: 'a/main', family: 'a', explicit: false })
    expect(spawn({ definitionModel: 'sonnet' })).toMatchObject({ model: 'a/main', family: 'a' })
    expect(spawn({ requested: 'haiku' }, { a: { haiku: 'a/small' } })).toMatchObject({ model: 'a/small' })
  })
  test('routed ids in frontmatter and explicit choices are honored exactly', () => {
    expect(spawn({ definitionModel: 'b/child' })).toMatchObject({ model: 'b/child', native: false, family: 'b', explicit: true })
    expect(spawn({ requested: 'b/child' })).toMatchObject({ model: 'b/child', family: 'b', explicit: true })
  })
  test('explicit native ids remain native and explicit aliases outrank a routed definition', () => {
    expect(spawn({ requested: 'claude-sonnet-5-5' })).toMatchObject({ native: true, family: CLAUDE_FAMILY, explicit: true })
    expect(spawn({ requested: 'haiku', definitionModel: 'b/child' }, { a: { haiku: 'a/small' } })).toMatchObject({ model: 'a/small', family: 'a' })
  })
  test('a Claude parent and forks keep native resolution', () => {
    expect(spawn({ parentModel: 'sonnet', requested: 'haiku' })).toMatchObject({ native: true, family: CLAUDE_FAMILY })
    expect(spawn({ fork: true, requested: 'haiku' })).toMatchObject({ native: true, family: 'a' })
  })
})

describe('step models', () => {
  test('a native alias inside a routed owner resolves in the owner family', () => {
    expect(stepModel('haiku', 'a/main', false, {}, ports)).toBe('a/main')
    expect(stepModel('claude-haiku-4-5', 'a/main', false, { a: { haiku: 'a/small' } }, ports)).toBe('a/small')
  })
  test('explicit Claude placement, routed requests and Claude owners stay unchanged', () => {
    expect(stepModel('haiku', 'a/main', true, {}, ports)).toBe('haiku')
    expect(stepModel('b/child', 'a/main', false, {}, ports)).toBe('b/child')
    expect(stepModel('haiku', 'sonnet', false, {}, ports)).toBe('haiku')
    expect(stepModel('haiku', undefined, false, {}, ports)).toBe('haiku')
  })
})

describe('tiers configuration', () => {
  test('accepts family maps of routed ids', () => {
    expect(parseTiers({ codex: { haiku: 'codex/gpt-mini', default: 'codex/gpt-main' } })).toEqual({ tiers: { codex: { haiku: 'codex/gpt-mini', default: 'codex/gpt-main' } }, errors: [] })
    expect(parseTiers(undefined)).toEqual({ tiers: {}, errors: [] })
  })
  test('rejects unknown tiers, non-routed ids and malformed blocks', () => {
    expect(parseTiers({ codex: { tiny: 'codex/x' } }).errors[0]).toContain('tiers.codex.tiny')
    expect(parseTiers({ codex: { haiku: 'haiku' } }).errors[0]).toContain('routed model id')
    expect(parseTiers([]).errors[0]).toContain('tiers must be an object')
    expect(parseTiers({ codex: 'x' }).errors[0]).toContain('tiers.codex must be an object')
  })
})
