import { expect, test } from 'bun:test'
import { toolFilter } from '../hooks/agents'
import { claimable, contested, definitionOf, resolveType, systemFor } from '../hooks/prompts'
import type { PromptsPort } from '../hooks/prompts'
import type { NativeCapture } from '../hooks/native-tools'

const project = '/fixture/project'
const config = '/fixture/home/.claude'
const pluginRoot = '/fixture/plugins/owned-plugin'
const files = new Map<string, string>()
const directories = new Map<string, { name: string; kind: 'file' | 'dir' | 'other' }[]>()
const io: PromptsPort = {
  cwd: async () => project,
  configDir: async () => config,
  exists: async path => files.has(path) || directories.has(path),
  read: async path => {
    const value = files.get(path)
    if (value === undefined) throw new Error(`missing fixture ${path}`)
    return value
  },
  listDir: async path => directories.get(path) ?? [],
  compose: async () => [],
  run: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
  now: async () => 1_800_000_000_000,
  debug: () => {},
}
const session = () => ({ agentFiles: new Map(), agentNotes: new Set(), notes: [] }) as any
const native = { agentHead: 'OWNED NATIVE AGENT HEADER\n', agentTail: '\n\nOWNED NATIVE AGENT FOOTER' } as NativeCapture
const file = (root: string, name: string, body: string, frontmatter: string) => {
  const path = `${root}/${name}.md`
  files.set(path, `---\n${frontmatter}\n---\n${body}\n`)
  const existing = directories.get(root) ?? []
  directories.set(root, [...existing, { name: `${name}.md`, kind: 'file' }])
  return path
}

const projectAgents = `${project}/.claude/agents`
const globalAgents = `${config}/agents`
const pluginAgents = `${pluginRoot}/agents`
const projectPath = file(projectAgents, 'project-review', 'Project review prompt.', 'name: project-review\ndescription: Review the project\ntools: [Read, Grep]\ndisallowedTools: [Grep]\npermissionMode: auto')
const globalPath = file(globalAgents, 'global-review', 'Global review prompt.', 'name: global-review\ndescription: Review globally\nmodel: sonnet\ntools: Read, Bash')
const exactPath = file(projectAgents, 'exact-review', 'Exact model prompt.', 'name: exact-review\ndescription: Review with exact model\nmodel: local/qwen')
const aliasPath = file(projectAgents, 'alias-review', 'Alias model prompt.', 'name: alias-review\ndescription: Review with alias\nmodel: haiku')
const noModelPath = file(projectAgents, 'inherited-review', 'Inherited route prompt.', 'name: inherited-review\ndescription: Inherit the parent route\ntools: [Read]')
file(pluginAgents, 'plugin-review', 'Plugin review prompt.', 'tools: [Read, WebSearch]')
files.set(`${config}/plugins/installed_plugins.json`, JSON.stringify({ plugins: { 'owned-plugin@test-marketplace': [{ installPath: pluginRoot, projectPath: project }] } }))

test('native project, global, and plugin agent files keep their own definitions', async () => {
  const s = session()
  expect((await definitionOf(io, s, 'project-review'))?.prompt).toBe('Project review prompt.')
  expect((await definitionOf(io, s, 'project-review'))?.permissionMode).toBe('auto')
  expect((await definitionOf(io, s, 'global-review'))?.prompt).toBe('Global review prompt.')
  expect((await definitionOf(io, s, 'owned-plugin:plugin-review'))?.prompt).toBe('Plugin review prompt.')
  expect(await resolveType(io, s, 'Project-Review')).toEqual({ type: 'project-review' })
  expect(await resolveType(io, s, 'global-review')).toEqual({ type: 'global-review' })
  expect(await resolveType(io, s, 'owned-plugin:plugin-review')).toEqual({ type: 'owned-plugin:plugin-review' })
})

test('a shared project and config agent directory is listed once', async () => {
  const sharedIo = { ...io, configDir: async () => `${project}/.claude` }
  expect(await contested(sharedIo, session(), 'project-review')).toBe(false)
})

test('Windows slash variants of one agent directory are listed once', async () => {
  let listed = 0
  const windowsIo = {
    ...io,
    cwd: async () => String.raw`C:\fixture\project`,
    configDir: async () => String.raw`C:\fixture\project\.claude`,
    listDir: async () => {
      listed++
      return [{ name: 'owned-agent.md', kind: 'file' as const }]
    },
    read: async () => '---\nname: owned-agent\ndescription: Owned agent\n---\nOwned prompt.\n',
  }
  expect(await contested(windowsIo, session(), 'owned-agent')).toBe(false)
  expect(listed).toBe(1)
})

test('custom frontmatter preserves exact and alias models for native resolution', async () => {
  const s = session()
  expect((await definitionOf(io, s, 'exact-review'))?.model).toBe('local/qwen')
  expect((await definitionOf(io, s, 'alias-review'))?.model).toBe('haiku')
  expect(await claimable(io, s, 'exact-review', 'fixture exact model', false)).toEqual({ no: 'names a model of its own' })
  expect(await claimable(io, s, 'alias-review', 'fixture alias model', false)).toEqual({ no: 'names a model of its own' })
  expect(exactPath).toContain('/.claude/agents/exact-review.md')
  expect(aliasPath).toContain('/.claude/agents/alias-review.md')
})

test('an agent without a model inherits the route and retains captured prompt and tools limits', async () => {
  const s = session()
  const def = await definitionOf(io, s, 'inherited-review')
  expect(def?.model).toBeUndefined()
  expect(def?.tools).toEqual(['Read'])
  expect(await claimable(io, s, 'inherited-review', 'fixture inherited model', false)).toEqual({ isolated: false })
  expect(await systemFor(io, s, {
    def,
    route: { type: 'inherited-review' } as any,
    engineModel: 'sonnet',
    target: 'codex/fixture',
    model: 'codex/fixture',
    provider: 'fixture',
    tools: ['Read', 'Bash'],
    native,
  })).toEqual({ text: 'OWNED NATIVE AGENT HEADER\nInherited route prompt.\n\nOWNED NATIVE AGENT FOOTER', source: 'custom' })
  const allows = toolFilter('inherited-review', def)
  expect(['Read', 'Bash'].filter(allows)).toEqual(['Read'])
})

test('plugin definitions follow plugin file naming and list their permitted tools', async () => {
  const s = session()
  const def = await definitionOf(io, s, 'owned-plugin:plugin-review')
  expect(def?.tools).toEqual(['Read', 'WebSearch'])
  const allows = toolFilter('owned-plugin:plugin-review', def)
  expect(['Read', 'WebSearch', 'Bash'].filter(allows)).toEqual(['Read', 'WebSearch'])
  expect(pluginAgents).toBe(`${pluginRoot}/agents`)
  expect(globalPath).toContain('/agents/global-review.md')
  expect(projectPath).toContain('/.claude/agents/project-review.md')
  expect(noModelPath).toContain('/.claude/agents/inherited-review.md')
})
