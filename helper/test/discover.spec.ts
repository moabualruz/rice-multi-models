import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fingerprint, parseConfig } from '../../hooks/config.ts'
import { unknownMetadata, type ModelCatalogue } from '../../hooks/catalogue.ts'
import type { Wire } from '../../hooks/protocol.ts'

let home: string
let env: NodeJS.ProcessEnv
const moduleUrl = pathToFileURL(path.join(import.meta.dir, '..', 'discover.ts')).href
const runner = `import { discover } from ${JSON.stringify(moduleUrl)};\nprocess.stdout.write(JSON.stringify(await discover(JSON.parse(process.env.DISCOVERY_FIXTURE_WIRE))));`

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'mm-discover-'))
  env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), XDG_DATA_HOME: path.join(home, 'data'), PATH: home }
})
afterAll(() => { rmSync(home, { recursive: true, force: true }) })

function codexCli(output: string, exitCode = 0): string {
  const source = `const fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(path.join(home, 'codex.calls'))}, JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.stdout.write(${JSON.stringify(output)});\nprocess.exitCode = ${exitCode};\n`
  if (process.platform === 'win32') {
    writeFileSync(path.join(home, 'codex.js'), source)
    const executable = path.join(home, 'codex.cmd')
    writeFileSync(executable, '@"%dp0%\\codex.js" %*\r\n')
    return executable
  }
  const executable = path.join(home, 'codex')
  writeFileSync(executable, `#!${process.execPath}\n${source}`, { mode: 0o755 })
  return executable
}

async function discover(wire: Wire = { configText: '', approved: [] }): Promise<ModelCatalogue> {
  const child = Bun.spawn([process.execPath, '--eval', runner], { env: { ...env, DISCOVERY_FIXTURE_WIRE: JSON.stringify(wire) }, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
  return JSON.parse(stdout) as ModelCatalogue
}

function wireOf(providers: Record<string, unknown>, approved: boolean): Wire {
  const configText = JSON.stringify({ version: 1, providers, aliases: {} })
  const parsed = parseConfig(configText)
  expect(parsed.errors).toEqual([])
  return { configText, approved: approved ? Object.values(parsed.config!.providers).map(fingerprint) : [] }
}

test('discovery reports an unavailable Codex CLI without inventing models', async () => {
  const result = await discover()
  expect(result.models).toEqual([])
  expect(result.providers).toEqual([{ provider: 'codex', status: 'unavailable', source: 'Codex authenticated models endpoint', error: 'cli-unavailable' }])
})

test('configured providers discover fresh endpoint models without CLI fallback', async () => {
  const requests: string[] = []
  const server = Bun.serve({ port: 0, fetch(request) {
    const pathname = new URL(request.url).pathname
    requests.push(pathname)
    return Response.json({ data: [{ id: `live-${pathname.split('/')[1]}` }] })
  } })
  try {
    const providers = Object.fromEntries(['fixture-one', 'fixture-two', 'codex'].map(provider => [provider, {
      kind: 'openai', baseUrl: `http://127.0.0.1:${server.port}/${provider}`, allowHttp: true, auth: 'none',
      models: { 'stale-declared-only': { contextWindow: 99999, maxOutputTokens: 8192, tools: true, vision: true } },
    }]))
    const result = await discover(wireOf(providers, true))
    expect(result.models.map(model => model.model).sort()).toEqual(['codex/live-codex', 'fixture-one/live-fixture-one', 'fixture-two/live-fixture-two'])
    expect(result.providers).toHaveLength(3)
    expect(result.providers.every(provider => provider.status === 'fresh')).toBe(true)
    expect(result.models.every(model => model.execution === 'native provider')).toBe(true)
    for (const model of result.models) expect(model.metadata).toEqual(unknownMetadata())
    expect(requests.sort()).toEqual(['/codex/models', '/fixture-one/models', '/fixture-two/models'])
  } finally { server.stop(true) }
})

test('unapproved configured providers require approval before contacting endpoints', async () => {
  let requests = 0
  const server = Bun.serve({ port: 0, fetch() { requests++; return Response.json({ data: [{ id: 'must-not-appear' }] }) } })
  try {
    const providers = Object.fromEntries(['fixture-one', 'fixture-two', 'codex'].map(provider => [provider, {
      kind: 'openai', baseUrl: `http://127.0.0.1:${server.port}/v1`, allowHttp: true,
      auth: 'none', models: { 'stale-only': { tools: true } },
    }]))
    const result = await discover(wireOf(providers, false))
    expect(result.models).toEqual([])
    expect(result.providers.map(provider => ({ provider: provider.provider, status: provider.status }))).toEqual(['fixture-one', 'fixture-two', 'codex'].map(provider => ({ provider, status: 'approval-required' })))
    expect(requests).toBe(0)
  } finally { server.stop(true) }
})

test('failed Codex discovery stays unavailable without emitting cached identities', async () => {
  codexCli('codex-cli 0.162.1\n')
  const result = await discover()
  expect(result.models).toEqual([])
  expect(result.providers[0]).toMatchObject({ provider: 'codex', status: 'unavailable', error: 'auth-unavailable' })
  const calls = existsSync(path.join(home, 'codex.calls')) ? readFileSync(path.join(home, 'codex.calls'), 'utf8') : ''
  expect(calls).toContain('--version')
  expect(result.providers.map(provider => provider.provider)).toEqual(['codex'])
})
