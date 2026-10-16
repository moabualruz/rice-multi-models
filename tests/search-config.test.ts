import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { searchConfiguration } from '../helper/search-config'
import { editSearchConfig, orderedSearchEndpoints, parseSearchCommand, parseSearchConfig, searchConfigurationCommand } from '../hooks/search-config'
import type { SearchConfig, SearchEdit } from '../hooks/search-config'

const endpoint = (name = 'local') => ({ name, kind: 'searxng' as const, url: 'https://search.example/search', priority: 10 })
const config = (endpoints: SearchConfig['endpoints']): SearchConfig => ({ version: 1, endpoints })
async function temporary(work: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rice-search-config-'))
  try { await work(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}

test('search parser accepts only credential references and absolute credential helpers across platforms', () => {
  for (const command of [['/usr/local/bin/bao', 'read', 'kv/search'], ['C:\\Program Files\\Bao\\bao.exe', 'read'], ['\\\\server\\tools\\bao.exe', 'read']]) {
    expect(parseSearchConfig(JSON.stringify(config([{ ...endpoint(), auth: { command } }]))).errors).toEqual([])
  }
  expect(parseSearchConfig(JSON.stringify(config([{ ...endpoint(), auth: { env: 'SEARCH_API_KEY' } }]))).errors).toEqual([])
  const privateValue = 'fixture-secret-value'
  const invalid: unknown[] = [
    { ...endpoint(), apiKey: privateValue },
    { ...endpoint(), auth: { key: privateValue } },
    { ...endpoint(), auth: { env: 'SEARCH_API_KEY', token: privateValue } },
    { ...endpoint(), auth: { command: ['bao', 'read'] } },
    { ...endpoint(), url: `https://user:${privateValue}@search.example/search` },
    { ...endpoint(), url: `https://search.example/search?key=${privateValue}` },
    { ...endpoint(), url: 'C:\\services\\search' },
  ]
  for (const row of invalid) {
    const result = parseSearchConfig(JSON.stringify({ version: 1, endpoints: [endpoint('good'), row] }))
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.config.endpoints).toEqual([])
    expect(result.errors.join(' ')).not.toContain(privateValue)
  }
})

test('priorities are stable, edits preserve other services, and malformed documents cannot lose saved rows', () => {
  const initial = config([{ ...endpoint('first'), priority: 20 }, { ...endpoint('second'), priority: 10, auth: { command: ['/opt/bao', 'read', 'kv/search'] } }, { ...endpoint('third'), priority: 10 }])
  expect(orderedSearchEndpoints(initial).map(row => row.name)).toEqual(['second', 'third', 'first'])
  const next = editSearchConfig(initial, { op: 'priority', name: 'first', priority: 1 })
  expect(next.errors).toEqual([])
  expect(next.config.endpoints.slice(1)).toEqual(initial.endpoints.slice(1))
  expect(initial.endpoints[0].priority).toBe(20)
  expect(editSearchConfig(initial, { op: 'add', endpoint: endpoint('first') }).errors.length).toBe(1)
  expect(parseSearchConfig(JSON.stringify(config([endpoint(), endpoint()]))).errors.length).toBe(1)
  expect(parseSearchConfig('x'.repeat(65537)).errors.length).toBe(1)
})

test('headless command grammar rejects unknown options, pasted secrets, invalid priority and trailing arguments', () => {
  expect(parseSearchCommand('add home searxng http://localhost:8080/search')).toEqual({ action: 'edit', edit: { op: 'add', endpoint: { name: 'home', kind: 'searxng', url: 'http://localhost:8080/search', priority: 10 } } })
  for (const args of [
    'add home searxng https://search.example/search api-key=fixture-secret',
    'add home searxng https://search.example/search key-env=not-a-variable',
    'add home searxng https://search.example/search priority=1 priority=2',
    'add home searxng https://search.example/search priority=',
    'priority home -1', 'remove home extra', 'setup extra',
  ]) expect(parseSearchCommand(args)).toHaveProperty('error')
})

test('status does not create state, concurrent edits reread under lock and preserve unrelated machine config', async () => temporary(async directory => {
  const configDir = path.join(directory, 'new config')
  expect(await searchConfiguration({ configDir })).toMatchObject({ ok: true, config: config([]) })
  expect(await readdir(directory)).toEqual([])
  await mkdir(configDir)
  const machine = '{"model":"opus","permissions":{"allow":["Read"]}}\n'
  await writeFile(path.join(configDir, 'settings.json'), machine)
  const results = await Promise.all(['one', 'two', 'three'].map(name => searchConfiguration({ configDir, edit: { op: 'add', endpoint: endpoint(name) } })))
  expect(results.every(result => result.ok)).toBe(true)
  const saved = await searchConfiguration({ configDir })
  expect(saved.config?.endpoints.map(row => row.name).sort()).toEqual(['one', 'three', 'two'])
  const originalOthers = saved.config?.endpoints.filter(row => row.name !== 'two')
  expect(await searchConfiguration({ configDir, edit: { op: 'priority', name: 'two', priority: 1 } })).toMatchObject({ ok: true, changed: true })
  expect((await searchConfiguration({ configDir })).config?.endpoints.filter(row => row.name !== 'two')).toEqual(originalOthers)
  expect(await searchConfiguration({ configDir, edit: { op: 'remove', name: 'one' } })).toMatchObject({ ok: true, changed: true })
  expect(await readFile(path.join(configDir, 'settings.json'), 'utf8')).toBe(machine)
  expect(await readdir(path.join(configDir, 'rice-multi-models'))).toEqual(['search.json'])
}))

test('invalid existing configuration and invalid edit input remain unchanged', async () => temporary(async configDir => {
  const directory = path.join(configDir, 'rice-multi-models'), file = path.join(directory, 'search.json')
  await mkdir(directory)
  const malformed = '{"version":1,"endpoints":[{"name":"do-not-lose","token":"fixture-secret"}]}'
  await writeFile(file, malformed)
  expect(await searchConfiguration({ configDir, edit: { op: 'add', endpoint: endpoint() } })).toMatchObject({ ok: false })
  expect(await readFile(file, 'utf8')).toBe(malformed)
  expect(await searchConfiguration({ configDir, edit: { op: 'remove', name: 'local', token: 'fixture-secret' } })).toMatchObject({ ok: false })
  expect(await readFile(file, 'utf8')).toBe(malformed)
  expect(await searchConfiguration({ configDir: 'relative' })).toMatchObject({ ok: false })
}))

test('symlink search file is refused and its target stays intact', async () => temporary(async configDir => {
  if (process.platform === 'win32') return // Creating a Windows file symlink requires a separate OS privilege.
  const directory = path.join(configDir, 'rice-multi-models'), target = path.join(configDir, 'unrelated.json')
  await mkdir(directory)
  const original = JSON.stringify(config([endpoint('unrelated')]))
  await writeFile(target, original)
  await symlink(target, path.join(directory, 'search.json'))
  expect(await searchConfiguration({ configDir, edit: { op: 'add', endpoint: endpoint() } })).toMatchObject({ ok: false })
  expect(await readFile(target, 'utf8')).toBe(original)
}))

test('setup asks only for endpoint metadata, approves final endpoint, and saves through the same edit interface', async () => {
  const questions: string[] = [], edits: SearchEdit[] = []
  const answers = ['brave', 'work-search', 'https://api.search.brave.com/res/v1/web/search', '3', 'WORK_BRAVE_KEY', 'Save endpoint']
  const result = await searchConfigurationCommand('setup', {
    read: async () => ({ ok: true, config: config([]) }),
    edit: async edit => { edits.push(edit); return { ok: true, config: editSearchConfig(config([]), edit).config } },
    ask: async question => { questions.push(question); return answers.shift() ?? '' },
  })
  expect(edits).toEqual([{ op: 'add', endpoint: { name: 'work-search', kind: 'brave', url: 'https://api.search.brave.com/res/v1/web/search', priority: 3, auth: { env: 'WORK_BRAVE_KEY' } } }])
  expect(questions.some(question => question.includes('NAME only'))).toBe(true)
  expect(questions.at(-1)).toContain('Searches may be sent directly')
  expect(result).toContain('work-search: brave, priority 3')
})

test('dismissed/headless setup and rejected confirmation never edit; CLI edits need no dialog', async () => {
  let edits = 0
  const port = { read: async () => ({ ok: true, config: config([]) }), edit: async (edit: SearchEdit) => { edits++; return { ok: true, config: editSearchConfig(config([]), edit).config } }, ask: async (): Promise<string> => { throw new Error('headless') } }
  expect(await searchConfigurationCommand('setup', port)).toContain('interactive session')
  expect(edits).toBe(0)
  const answers = ['searxng', 'local', 'https://search.example/search', '10', 'No credentials', 'Cancel']
  expect(await searchConfigurationCommand('setup', { ...port, ask: async () => answers.shift() ?? '' })).toContain('cancelled')
  expect(edits).toBe(0)
  expect(await searchConfigurationCommand('add home searxng http://localhost:8080/search', port)).toContain('home: searxng')
  expect(edits).toBe(1)
})
