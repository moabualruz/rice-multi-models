import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { approvalStore, nativeApprovals, nativeWireConfig, resumedModel } from './state.ts'
import { fingerprint } from '../../hooks/config.ts'
import { remoteOf } from '../../hooks/providers.ts'

test('pre-hook startup reads only true grants from its exact native inline store', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rice-approval-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  try {
    const path = approvalStore(directory)
    expect(path.endsWith('rice-multi-models_inline-8adc0be003e6.json')).toBe(true)
    expect(nativeApprovals()).toEqual([])
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ 'trust:openai|https://owned.example|none': true, 'trust:revoked': false, other: true }))
    expect(nativeApprovals()).toEqual(['openai|https://owned.example|none'])
    const id = '11111111-2222-3333-4444-555555555555'
    writeFileSync(path, JSON.stringify({ 'trust:openai|https://owned.example|none': true, [`native-session:${id}`]: { version: 1, model: 'owned/main' } }))
    expect(resumedModel(['--resume', id], directory)).toBe('owned/main')
    expect(resumedModel(['--resume', 'interactive-name'], directory)).toBeUndefined()
    writeFileSync(join(directory, 'rice-multi-models.json'), JSON.stringify({ providers: { owned: { kind: 'openai', baseUrl: 'https://owned.example/v1', auth: 'none', models: { main: {} } } } }))
    const config = await nativeWireConfig('owned/main', undefined, nativeApprovals(), new AbortController().signal)
    expect(nativeApprovals().includes(fingerprint(remoteOf(config, 'owned/main')!.provider))).toBe(true)
    writeFileSync(join(directory, 'rice-multi-models.json'), JSON.stringify({ providers: { owned: { kind: 'openai', baseUrl: 'https://changed.example/v1', auth: 'none', models: { main: {} } } } }))
    const changed = await nativeWireConfig('owned/main', undefined, nativeApprovals(), new AbortController().signal)
    expect(nativeApprovals().includes(fingerprint(remoteOf(changed, 'owned/main')!.provider))).toBe(false)
    writeFileSync(path, '{')
    expect(() => nativeApprovals()).toThrow('approvals could not be read')
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    rmSync(directory, { recursive: true, force: true })
  }
})
