import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fingerprint, parseConfig } from '../../hooks/config.ts'
import { unknownMetadata } from '../../hooks/catalogue.ts'
import type { ModelCatalogue } from '../../hooks/catalogue.ts'
import type { Wire } from '../../hooks/protocol.ts'
import { workerModelIds } from '../discover.ts'

// Real subprocesses keep environment isolation and avoid Bun module mocks leaking into other suites.
let home: string
let env: NodeJS.ProcessEnv
const moduleUrl = pathToFileURL(join(import.meta.dir, '..', 'discover.ts')).href
const runner = `import { discover } from ${JSON.stringify(moduleUrl)};
process.stdout.write(JSON.stringify(await discover(JSON.parse(process.env.DISCOVERY_FIXTURE_WIRE))));`

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'mm-discover-'))
  env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'), XDG_DATA_HOME: join(home, 'data'), PATH: home }
})
afterAll(() => { rmSync(home, { recursive: true, force: true }) })

function cli(provider: 'agy' | 'grok' | 'codex' | 'key-helper', output: string, exitCode = 0): string {
  const source = `const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(join(home, `${provider}.calls`))}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write(${JSON.stringify(output)});
process.exitCode = ${exitCode};\n`
  if (process.platform === 'win32') {
    writeFileSync(join(home, `${provider}.js`), source)
    const executable = join(home, `${provider}.cmd`)
    writeFileSync(executable, `@"%dp0%\\${provider}.js" %*\r\n`)
    return executable
  }
  const executable = join(home, provider)
  writeFileSync(executable, `#!${process.execPath}\n${source}`, { mode: 0o755 })
  return executable
}

function clearCalls() {
  for (const name of ['agy', 'grok', 'codex', 'key-helper']) rmSync(join(home, `${name}.calls`), { force: true })
}
const calls = (name: string): string[][] => existsSync(join(home, `${name}.calls`)) ? readFileSync(join(home, `${name}.calls`), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []

async function discover(wire: Wire = { configText: '', approved: [] }): Promise<ModelCatalogue> {
  const child = Bun.spawn([process.execPath, '--eval', runner], {
    env: { ...env, DISCOVERY_FIXTURE_WIRE: JSON.stringify(wire) },
    stdout: 'pipe', stderr: 'pipe',
  })
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

test('worker IDs strip terminal colors, descriptions and Grok defaults without inventing capabilities', () => {
  expect(workerModelIds('agy', '\u001b[32mgemini-fresh\u001b[0m\tFresh model, 1M context\r\ngemini-fresh\tDuplicate\r\nmodel.v2:latest\tTools and vision\nInvalid Model\nprovider/model\n')).toEqual(['gemini-fresh', 'model.v2:latest'])
  expect(workerModelIds('grok', 'pre-header-model\n\u001b[36mAvailable models:\u001b[0m\r\n  grok-fresh (default)\r\n  grok-other\r\n  grok-fresh\n')).toEqual(['grok-fresh', 'grok-other'])
})

test('empty or malformed worker lists never yield a default model', () => {
  for (const output of ['', '\n \t\r\n', '{"models":[]}', 'Invalid Model\nprovider/model']) expect(workerModelIds('agy', output)).toBeNull()
  for (const output of ['', 'grok-fresh', 'Available models:\n', 'Available models:\nInvalid Model']) expect(workerModelIds('grok', output)).toBeNull()
})

test('authentication refusals invalidate even otherwise parseable worker identities', () => {
  for (const message of ['Not authenticated', 'NOT LOGGED IN', 'Login required']) {
    expect(workerModelIds('agy', `gemini-fresh\tFresh\n${message}`)).toBeNull()
    expect(workerModelIds('grok', `Available models:\ngrok-fresh (default)\n${message}`)).toBeNull()
  }
})

test('startup aggregates real worker lists with unknown metadata and no cached model fallback', async () => {
  clearCalls()
  cli('agy', 'gemini-fresh\tAdvertised context 1000000, tools and vision\n')
  cli('grok', 'Available models:\n  grok-fresh (default)\n')
  const first = await discover()
  expect(first.models.map(model => model.model)).toEqual(['agy/gemini-fresh', 'grok/grok-fresh'])
  for (const model of first.models) {
    expect(model.execution).toBe('CLI worker')
    expect(model.metadata).toEqual(unknownMetadata())
    expect(model.observedAt).toBeGreaterThan(0)
    expect(first.providers.find(provider => provider.provider === model.model.split('/')[0])).toMatchObject({ status: 'fresh', source: model.source, observedAt: model.observedAt })
  }
  expect(first.providers.find(provider => provider.provider === 'codex')).toMatchObject({ status: 'unavailable', error: 'cli-unavailable' })
  cli('agy', 'gemini-replacement\tNew live list\n')
  cli('grok', 'Available models:\ngrok-replacement\n')
  expect((await discover()).models.map(model => model.model)).toEqual(['agy/gemini-replacement', 'grok/grok-replacement'])
  expect(calls('agy')).toEqual([['models'], ['models']])
  expect(calls('grok')).toEqual([['models'], ['models']])
})

test('empty, unauthenticated and failing worker CLIs stay unavailable without defaults', async () => {
  for (const [agy, grok, exitCode, error] of [
    ['', 'Available models:\n', 0, 'model-list-unavailable'],
    ['gemini-fresh\tFresh\nNot logged in', 'Available models:\ngrok-fresh\nLogin required', 0, 'model-list-unavailable'],
    ['gemini-fresh\tFresh\n', 'Available models:\ngrok-fresh\n', 3, 'cli-exit-3'],
  ] as const) {
    cli('agy', agy, exitCode)
    cli('grok', grok, exitCode)
    const result = await discover()
    expect(result.models).toEqual([])
    for (const provider of ['agy', 'grok']) expect(result.providers.find(row => row.provider === provider)).toMatchObject({ status: 'unavailable', error })
  }
})

test('configured namespaces suppress all builtins and aggregate only fresh configured identities', async () => {
  clearCalls()
  cli('agy', 'builtin-agy\n')
  cli('grok', 'Available models:\nbuiltin-grok\n')
  cli('codex', 'codex-cli 0.162.1\n')
  const requests: string[] = []
  const server = Bun.serve({ port: 0, fetch(request) {
    const pathname = new URL(request.url).pathname
    requests.push(pathname)
    return Response.json({ data: [{ id: `live-${pathname.split('/')[1]}` }] })
  } })
  try {
    const providers = Object.fromEntries(['agy', 'grok', 'codex'].map(provider => [provider, {
      kind: 'openai', baseUrl: `http://127.0.0.1:${server.port}/${provider}`, allowHttp: true, auth: 'none',
      models: { 'stale-declared-only': { contextWindow: 99999, maxOutputTokens: 8192, tools: true, vision: true } },
    }]))
    const result = await discover(wireOf(providers, true))
    expect(result.models.map(model => model.model).sort()).toEqual(['agy/live-agy', 'codex/live-codex', 'grok/live-grok'])
    expect(result.providers).toHaveLength(3)
    expect(result.providers.every(provider => provider.status === 'fresh')).toBe(true)
    expect(result.models.every(model => model.execution === 'native provider')).toBe(true)
    for (const model of result.models) expect(model.metadata).toEqual(unknownMetadata())
    expect(requests.sort()).toEqual(['/agy/models', '/codex/models', '/grok/models'])
    for (const provider of ['agy', 'grok', 'codex']) expect(calls(provider)).toEqual([])
  } finally { server.stop(true) }
})

test('unapproved configured namespaces require approval without CLI fallback, key helpers or HTTP', async () => {
  clearCalls()
  const helper = cli('key-helper', 'discovery-fixture-secret')
  let requests = 0
  const server = Bun.serve({ port: 0, fetch() { requests++; return Response.json({ data: [{ id: 'must-not-appear' }] }) } })
  try {
    const providers = Object.fromEntries(['agy', 'grok', 'codex', 'fixture'].map(provider => [provider, {
      kind: 'openai', baseUrl: `http://127.0.0.1:${server.port}/v1`, allowHttp: true,
      auth: { command: [helper], ttlSeconds: 300 }, models: { 'stale-only': { tools: true } },
    }]))
    const result = await discover(wireOf(providers, false))
    expect(result.models).toEqual([])
    expect(result.providers.map(provider => ({ provider: provider.provider, status: provider.status }))).toEqual(['agy', 'grok', 'codex', 'fixture'].map(provider => ({ provider, status: 'approval-required' })))
    expect(requests).toBe(0)
    for (const provider of ['agy', 'grok', 'codex', 'key-helper']) expect(calls(provider)).toEqual([])
    expect(JSON.stringify(result)).not.toContain(helper)
    expect(JSON.stringify(result)).not.toContain('discovery-fixture-secret')
  } finally { server.stop(true) }
})
