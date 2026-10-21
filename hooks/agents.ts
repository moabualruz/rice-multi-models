// Copied from Trosfy/claude-styx hooks/agents.ts at 5072384
// (MIT, Copyright (c) 2026 styx contributors; see LICENSES/claude-styx.MIT.txt).
// Modified by Mo Abualruz: imports its JSON helpers from ./util; the built-in types' prompts styx wrote are gone (a
// routed subagent is given the prompt the installed claude sends, see native-tools.ts), and the tool filter
// follows the tools the engine offers each agent type where the capture saw them.
// Custom agent types as Claude Code defines them in agent files (`<name>.md`: a YAML frontmatter, then the
// markdown body that is the agent's whole system prompt), the plugin directory installed_plugins.json
// records, which tools a routed subagent is given, and styx's own definition of the SubagentHandback tool a
// subagent reports through (the engine's name and input shape, styx's text). Pure: the files are read by register.ts.

import { isObject, own } from './util'
import type { JsonSchema } from './util'

// The agent types the engine defines itself (2.1.293); every other type is a custom agent with a
// definition file.
export const BUILTIN_AGENTS: readonly string[] = ['general-purpose', 'Explore', 'Plan', 'statusline-setup', 'claude-code-guide', 'web-fetch', 'claude', 'fork', 'comment-thread-analyst']

// What Explore and Plan may not call on 2.1.292, as the Agent tool's listing of agent types states it
// ("All tools except …"); every other tool the parent has stays. These static rules decide only the tools the
// capture did not see (see toolFilter).
const READ_ONLY_DENIED = ['Agent', 'Artifact', 'ArtifactComments', 'ArtifactData', 'ArtifactCheck', 'ExitPlanMode', 'Edit', 'Write', 'NotebookEdit']

// The tools a built-in agent type is denied; a type not named here keeps its parent's tools.
const AGENT_DENIED: Readonly<Record<string, readonly string[]>> = { Explore: READ_ONLY_DENIED, Plan: READ_ONLY_DENIED }

// The only tools a built-in agent type may call, where its 2.1.292 definition lists them (claude-code-guide's
// list is the union of its two forms); a type not named here keeps its parent's tools.
const AGENT_ALLOWED: Readonly<Record<string, readonly string[]>> = {
  'statusline-setup': ['Read', 'Edit'],
  'claude-code-guide': ['Bash', 'Glob', 'Grep', 'Read', 'WebFetch', 'WebSearch'],
  'web-fetch': ['WebFetch'],
}

// The model a built-in agent type's own definition sets on 2.1.292 (every other built-in type inherits its
// parent's): a subagent of one runs on it, whatever the parent runs on.
export const BUILTIN_MODELS: Readonly<Record<string, string>> = { 'statusline-setup': 'sonnet', 'claude-code-guide': 'haiku' }

// The main conversation's own tools, which no native subagent is given: asking the person, plan mode, the
// session's task list and schedule, and messages to the person.
export const SUBAGENT_DENIED: readonly string[] = [
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
  'TodoWrite',
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'PushNotification',
  'SendUserMessage',
  'SendUserFile',
  'EndConversation',
]

// The SubagentHandback tool as styx offers it to a routed subagent, when the engine's transcript says it delivers
// the report through it (2.1.294: only in auto permission mode). The engine runs or refuses the call itself
// (pool.ts): the name and the input shape are its contract, the texts are styx's own.
export const HANDBACK_TOOL = {
  name: 'SubagentHandback',
  description:
    'Ends your run and hands message to the agent that launched you, as your report. Call it once, after all other work, with the complete report in message: the launcher reads that text and nothing else you wrote, and a run that ends on plain text instead delivers no report. It takes no recipient and is not for progress updates or questions; put those in the report.',
  schema: {
    type: 'object',
    properties: { message: { type: 'string', description: 'The whole report, as the agent that launched you will read it; nothing else reaches it.' } },
    required: ['message'],
    additionalProperties: false,
  } as JsonSchema,
} as const

// What an agent file defines: its frontmatter's fields, and its body as `prompt`.
export type AgentDef = {
  name?: string
  description?: string
  tools?: readonly string[]
  disallowedTools?: readonly string[]
  model?: string
  effort?: string
  isolation?: string
  permissionMode?: string
  omitClaudeMd?: true
  hooks?: Record<string, unknown>
  prompt: string
}
export const AGENT_PERMISSION_MODES = new Set(['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan'])
export type Parsed<T> = T | { error: string }
// installed_plugins.json's `plugins`: each `<name>@<marketplace>` with its installs.
type InstalledPlugins = Readonly<Record<string, readonly unknown[]>>

const UNREAD = (s: string) => ({ error: `"${s}" is a YAML form this mod does not read (only text and lists are)` })
const UNCLOSED = { error: 'a quoted value that does not close on its line, or has an escape JSON does not know' }

// One frontmatter value as text: plain (a ` #` comment cut off), "double-quoted" with JSON's escapes, or
// 'single-quoted' with '' for a quote. Block scalars, maps, nested lists, anchors and tags are errors.
function scalar(raw: string): Parsed<string> {
  const s = raw.trim()
  if (s.startsWith('"')) {
    const m = /^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/.exec(s)
    try {
      const v: unknown = m === null ? undefined : JSON.parse(m[1] as string)
      if (typeof v === 'string') return v
    } catch {}
    return UNCLOSED
  }
  if (s.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(s)
    return m === null ? UNCLOSED : (m[1] as string).replaceAll("''", "'")
  }
  if (/^[|>{[\]&*!%@`]/.test(s)) return UNREAD(s)
  return s.replace(/\s+#.*$/, '')
}

// A `[a, b]` list on one line, its items text. A comma inside a rule's `(…)` part, as in
// `Bash(git:*, npm:*)`, separates no items.
function flowList(raw: string): Parsed<string[]> {
  const m = /^\[(.*)\]\s*(?:#.*)?$/.exec(raw.trim())
  if (m === null) return { error: 'a [list] that does not close on its line' }
  const inner = (m[1] as string).trim()
  const items: string[] = []
  for (const part of inner === '' ? [] : inner.split(/,(?![^(]*\))/)) {
    const v = scalar(part)
    if (typeof v !== 'string') return v
    items.push(v)
  }
  return items
}

// Tool names from a `tools` value: a list, or one comma-separated text. A rule's `(…)` part is dropped,
// so `Bash(git:*)` names Bash and `Agent(worker, researcher)` names Agent.
const toolNames = (v: string | readonly string[]) =>
  (typeof v === 'string' ? v.split(/,(?![^(]*\))/) : v).map(s => s.replace(/\(.*\)$/s, '').trim()).filter(s => s !== '')

// Why a file that does not open on a frontmatter does not read. Claude Code ignores such a file in an agents
// directory without a word, so styx tells this error apart from the others and says nothing of it either.
export const NO_FRONTMATTER = 'no frontmatter (the file must open with a --- line)'

// An agent file's definition. The frontmatter is the YAML agent files use: `key: value` text, and lists as
// `[a, b]` or as `- a` lines under a bare `key:` (a bare key with no items is left out). Keys other than
// the definition's own are read and ignored.
export function parseAgentFile(text: string): Parsed<AgentDef> {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  if (lines[0]?.trimEnd() !== '---') return { error: NO_FRONTMATTER }
  const close = lines.findIndex((l, i) => i > 0 && l.trimEnd() === '---')
  if (close < 0) return { error: 'the frontmatter has no closing --- line' }
  const fields = new Map<string, string | string[]>()
  const bare = new Set<string>()
  let list: string[] | undefined
  for (let i = 1; i < close; i++) {
    const line = lines[i] as string
    const at = `line ${i + 1}`
    if (/^\s*(#.*)?$/.test(line)) continue
    const item = /^\s*-(?:\s+(.*))?$/.exec(line)
    if (item !== null) {
      if (list === undefined) return { error: `${at}: a list item with no key above it` }
      const v = scalar(item[1] ?? '')
      if (typeof v !== 'string') return { error: `${at}: ${v.error}` }
      list.push(v)
      continue
    }
    const kv = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(line)
    if (kv === null) return { error: `${at}: not a "key: value" line, a "- item" of a list, or a comment` }
    const key = kv[1] as string
    const raw = (kv[2] ?? '').trim()
    if (fields.has(key)) return { error: `${at}: ${key} is given twice` }
    list = undefined
    if (raw === '') {
      fields.set(key, (list = []))
      bare.add(key)
      continue
    }
    const v = raw.startsWith('[') ? flowList(raw) : scalar(raw)
    if (!Array.isArray(v) && typeof v !== 'string') return { error: `${at}: ${v.error}` }
    fields.set(key, v)
  }
  for (const key of bare) if ((fields.get(key) as string[]).length === 0) fields.delete(key)
  const def: AgentDef = { prompt: lines.slice(close + 1).join('\n').trim() }
  for (const key of ['name', 'description', 'model', 'effort', 'isolation', 'permissionMode'] as const) {
    const v = fields.get(key)
    if (Array.isArray(v)) return { error: `${key} must be text, not a list` }
    if (v !== undefined) def[key] = v
  }
  for (const key of ['tools', 'disallowedTools'] as const) {
    const v = fields.get(key)
    if (v !== undefined) def[key] = toolNames(v)
  }
  if (def.prompt === '') return { error: 'the body (the system prompt) is empty' }
  return def
}

// installed_plugins.json's plugins (version 2: `plugins` maps `<name>@<marketplace>` to its installs).
export function parseInstalled(text: string): Parsed<{ plugins: InstalledPlugins }> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return { error: `not JSON (${String(err)})` }
  }
  const plugins = isObject(raw) ? raw['plugins'] : undefined
  if (!isObject(plugins)) return { error: 'no plugins object' }
  for (const [key, installs] of Object.entries(plugins)) if (!Array.isArray(installs)) return { error: `plugins.${key} is not a list of installs` }
  return { plugins: plugins as InstalledPlugins }
}

// The directory `plugin` loads from: the absolute `installPath` of its install for the project `cwd` is in
// (`cwd` itself or a directory beneath it; of several, the one with the longest `projectPath`), else of its
// install for every project (one with no `projectPath`). A name installed from two marketplaces is not
// guessed between.
export function pluginRoot(plugins: InstalledPlugins, plugin: string, cwd: string): Parsed<{ root: string }> {
  const keys = Object.keys(plugins).filter(k => k.startsWith(`${plugin}@`))
  if (keys.length === 0) return { error: `plugin ${plugin} is not installed` }
  if (keys.length > 1) return { error: `plugin ${plugin} is installed from more than one marketplace (${keys.join(', ')})` }
  const key = keys[0] as string
  const installs = (plugins[key] ?? []).filter(isObject)
  const comparable = (path: string) => {
    const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
    return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized
  }
  const current = comparable(cwd)
  const covering = installs.flatMap(i => {
    const path = i['projectPath']
    const parent = typeof path === 'string' ? comparable(path) : undefined
    return parent !== undefined && (current === parent || current.startsWith(`${parent}/`)) ? [{ install: i, path: parent }] : []
  })
  const deepest = covering.sort((a, b) => b.path.length - a.path.length)[0]
  const install = deepest?.install ?? installs.find(i => i['projectPath'] === undefined)
  const root = install?.['installPath']
  return typeof root === 'string' && !/[\0\r\n]/.test(root) && (root.startsWith('/') || /^[A-Za-z]:[\\/]/.test(root) || /^\\\\[^\\]+\\[^\\]+/.test(root))
    ? { root: root.replace(/[\\/]+$/, '') }
    : { error: `plugin ${key} has no install for ${cwd}` }
}

// Whether a definition lets its agent call `tool`: listed in `tools` (or `tools` left out, or `*`), and not
// in `disallowedTools`.
export const allowsTool = (def: AgentDef, tool: string) =>
  (def.tools === undefined || def.tools.includes('*') || def.tools.includes(tool)) && !(def.disallowedTools ?? []).includes(tool)

// What the installed claude offers an agent, where its capture saw the tool: `known` are the tools the capture
// saw, `offered` the ones the engine gives that agent (see native-tools.ts offeredTools).
export type EngineOffer = { known: ReadonlySet<string>; offered: ReadonlySet<string> }

// Which of its parent's tools a routed subagent may call. A tool the capture saw is offered when the engine offers
// it to that agent (`engine`), and a custom type's must also be one its definition allows. Any other tool (an MCP
// server's, or one the headless capture cannot see) follows the static rules: never a main-only one
// (SUBAGENT_DENIED); a custom type's, as its definition allows; any other type's (or a custom one whose definition
// did not read), what AGENT_ALLOWED lets its type call, less what AGENT_DENIED denies it.
export function toolFilter(type: string | undefined, def: AgentDef | undefined, engine?: EngineOffer): (tool: string) => boolean {
  const seen = (tool: string) => engine !== undefined && engine.known.has(tool)
  if (def !== undefined) return tool => allowsTool(def, tool) && (seen(tool) ? engine!.offered.has(tool) : !SUBAGENT_DENIED.includes(tool))
  const allowed = own(AGENT_ALLOWED, type ?? '')
  const denied = own(AGENT_DENIED, type ?? '') ?? []
  return tool => seen(tool) ? engine!.offered.has(tool) : !SUBAGENT_DENIED.includes(tool) && !denied.includes(tool) && (allowed === undefined || allowed.includes(tool))
}

// --- the built-in types -------------------------------------------------------------------------------------

// Built-in types styx cannot run itself: comment-thread-analyst builds its prompt from the thread it is given. A
// plain Agent call of one stays native, and a styx agent call naming one is denied. A fork is not among them: it
// runs on its parent's prompt (prompts.ts) and is claimed on its parent's route (inherit.ts).
export const NOT_REPRODUCED: readonly string[] = ['comment-thread-analyst']
// The agent type of a fork, which the engine runs with its parent's context and model.
export const FORK = 'fork'

// Whether an agent type names a fork as Claude Code reads it: NFKC-normalised, lowercased, and with whitespace, `-`
// and `_` removed, it is `fork`. The engine starts such a call as a fork whatever its spelling, so styx must hold
// every spelling to the fork rule, not only the exact one.
export const isFork = (type: unknown): boolean => typeof type === 'string' && type.normalize('NFKC').toLowerCase().replace(/[\s_-]/g, '') === FORK

// --- a routed subagent's identity ------------------------------------------------------------------------------

// The line naming what answers a routed step: its model and provider.
export const identityLine = (model: string, provider: string) => `You are powered by ${model} served by the ${provider} provider.`

// How a fork delivers its result. Claude Code offers a fork no SubagentHandback: the fork's final message is what
// reaches the conversation that started it.
export const FORK_REPORT = `You are a fork: a copy of the conversation above, started to do the task in this message while that conversation goes on. Do only that task, then end with your full report as your final message. That message is what reaches the conversation that started you; no tool delivers it.`
