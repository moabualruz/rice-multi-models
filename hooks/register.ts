// rice-multi-models: non-Anthropic models as session and subagent models. A model id `codex/<slug>` set with
// /model, --model or an agent's `model:` is answered here: the request is built from the engine's own
// transcript, system prompt and tools, a helper process (helper/main.ts, one per request, stdio only) calls
// the provider, and its stream comes back as the engine's own chunks. Claude models pass through untouched.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelCompleteResult, ModelUsage, Register, TurnStepChunk, TurnStepInput, TurnStepResult } from 'claude-code'

import { GENERAL_PURPOSE_PROMPT, EXPLORE_PROMPT, HANDBACK_TOOL, identityLine, toolFilter } from './agents'
import type { AgentDef } from './agents'
import { collectText, helperStep, preferSession, readyLine, sessionHelper, setSessionHelper } from './backend'
import type { HelperPort } from './backend'
import { carryFor, remember, withCarry } from './carry'
import type { Reasoning } from './carry'
import { COMPACT_SYSTEM, compactRequest, summaryMessage, withUserText } from './compact'
import { createMemory } from './memory'
import { agyModelIds, codexRows, mergeRows, providerRows, workerRows } from './picker'
import type { PickerRow } from './picker'
import { approvalQuestion, CONFIG_FILE, emptyLoaded, estimateTokens, loadText, providerLines, remoteOf, TRUST_PREFIX } from './providers'
import type { Loaded, Remote } from './providers'
import { definitionOf, rewriteMain, systemFor, withIdentity } from './prompts'
import type { PromptsPort } from './prompts'
import { splitTarget } from './protocol'
import type { ApiMessage, Effort, Limits, RemoteTool, StepRequest, StepWire, Transport } from './protocol'
import { STAMP } from './schemas.gen'
import { createAssembler } from './step'
import { remoteTools } from './tools'
import type { Described } from './tools'
import { handbackState, withTask } from './transcript'

const PLUGIN = 'rice-multi-models'
const CURL = '/usr/bin/curl'
const PROVIDERS: Readonly<Record<string, string>> = { codex: 'OpenAI Codex (ChatGPT subscription)', agy: 'Antigravity (agy CLI)', grok: 'Grok (grok CLI)' }
/** Agent CLIs that run their own loop and tools: their label, default model, and what a user asks for to use them. */
const WORKERS: Readonly<Record<string, { label: string; model: string; ask: string }>> = {
  agy: { label: 'Antigravity (Gemini)', model: 'gemini-3.8-flash-high', ask: 'Antigravity or Gemini' },
  grok: { label: 'Grok Build', model: 'grok-build', ask: 'Grok' },
}
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const prefsAtom = atom({ plugin: 'rice-multi-models', key: 'prefs' } as const, { effort: null, transport: 'auto', helper: 'session', workers: 'read' })

const memory = createMemory()
const described = new Map<string, Described>()
/** The model each subagent loop last ran on, for its compaction. */
const agentModels = new Map<string, string>()
/** The agent types this mod registers, by their full name, with what they run on. */
const registered = new Map<string, AgentDef>()
let bun: string | undefined
let codexDefaults: { model?: string; effort?: Effort } = {}
let limits: Limits | undefined
let lastStep: { model: string; who: string; ms: number; transport: string } | undefined
/** Each conversation's worker run to resume (`main` or a subagent's id). */
const resumes = new Map<string, string>()
/** Whether each registered worker agent type may edit files. */
const workerWrites = new Map<string, boolean>()
let loaded: Loaded = emptyLoaded(CONFIG_FILE)

/** Whether a model name is answered here: a Codex id, or a declared provider's model or alias. */
export function isRouted(model: string | undefined): model is string {
  if (!model) return false
  const target = splitTarget(model)

  return (target !== null && Object.hasOwn(PROVIDERS, target.provider)) || remoteOf(loaded, model) !== undefined
}

/** The provider and model a routed name stands for, an alias resolved. */
function targetOf(model: string): { provider: string; model: string; label: string; remote?: Remote } | null {
  const remote = remoteOf(loaded, model)
  if (remote) return { provider: remote.provider.id, model: remote.modelId, label: remote.provider.id, remote }
  const target = splitTarget(model)

  return target ? { ...target, label: PROVIDERS[target.provider] ?? target.provider } : null
}

async function loadProviders($: EngineInterface): Promise<void> {
  const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${(await $.env.get('HOME')) ?? ''}/.claude`
  const path = `${dir}/${CONFIG_FILE}`
  loaded = (await $.fs.exists(path)) ? loadText(path, await $.fs.read(path)) : emptyLoaded(path)
}

async function approvedSet($: EngineInterface): Promise<Set<string>> {
  return new Set((await $.store.keys()).filter(key => key.startsWith(TRUST_PREFIX)).map(key => key.slice(TRUST_PREFIX.length)))
}

/** Undefined once the provider is approved (asked here the first time), else why the step is not sent. */
async function approval($: EngineInterface, remote: Remote): Promise<string | undefined> {
  if ((await approvedSet($)).has(remote.fingerprint)) return undefined
  try {
    const answer = await $.ui.ask(approvalQuestion(remote.provider), { options: ['Allow', 'Keep it off'], header: 'rice-models' })
    if (answer === 'Allow') {
      await $.store.set(`${TRUST_PREFIX}${remote.fingerprint}`, true)

      return undefined
    }

    return `${remote.provider.id} was not approved; nothing was sent`
  } catch {
    return `${remote.provider.id} is not approved yet; run /rice-models approve ${remote.provider.id}. Nothing was sent`
  }
}

/** What the helper gets with a step: the config's text and the approved fingerprints. */
async function wireFor($: EngineInterface, req: StepRequest): Promise<StepWire> {
  return { configText: loaded.text, approved: [...(await approvedSet($))], req }
}

function limitsText(): string | undefined {
  if (!limits || limits.windows.length === 0) return undefined

  return `codex ${limits.windows.map(window => `${window.label} ${Math.round(window.usedPercent)}%`).join(' ')}`
}

function promptsPort($: EngineInterface): PromptsPort {
  return {
    compose: async (model, tools) => (await $.prompt.compose({ model, tools })).sections,
    cwd: () => $.session.cwd(),
    configDir: async () => (await $.env.get('CLAUDE_CONFIG_DIR')) || `${(await $.env.get('HOME')) ?? ''}/.claude`,
    exists: path => $.fs.exists(path),
    read: path => $.fs.read(path),
    listDir: async dir => ((await $.fs.exists(dir)) ? (await $.fs.list(dir)).map(entry => ({ name: entry.name, kind: entry.kind })) : []),
    run: async (argv, options) => {
      try {
        return await $.process.run(argv, { timeoutMs: options?.timeoutMs ?? 10_000 })
      } catch {
        return { exitCode: 127, stdout: '', stderr: '' }
      }
    },
    now: () => $.clock.now(),
    debug: text => $.ui.log(`${PLUGIN}: ${text}`, { to: 'debug' }),
  }
}

function helperPort($: EngineInterface): HelperPort {
  return {
    once: input => $.process.spawn({ argv: [bun ?? 'bun', `${$.plugin.root}/helper/main.ts`, 'once'], input }),
    curl: (input, socketPath) => $.process.spawn({ argv: [CURL, '-q', '-sS', '-N', '--unix-socket', socketPath, '--data-binary', '@-', 'http://rice/step'], input }),
  }
}

/**
 * Keeps the session helper running for the session's life: started here, announced on its standard output,
 * started again when it exits, and given up (one process per step from then on) after three exits within a
 * minute. The loop ends with the module, which ends the helper.
 */
async function superviseHelper($: EngineInterface): Promise<void> {
  let exits: number[] = []
  while (bun) {
    let buffer = ''
    try {
      for await (const piece of $.process.spawn({ argv: [bun, `${$.plugin.root}/helper/main.ts`, 'serve'] })) {
        if (piece.stream !== 'stdout' || sessionHelper()) continue
        buffer += piece.text
        const ready = readyLine(buffer)
        if (ready) setSessionHelper(ready)
      }
    } catch (error) {
      $.ui.log(`${PLUGIN}: the session helper did not start: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
    }
    setSessionHelper(undefined)
    const now = await $.clock.now()
    exits = [...exits.filter(at => now - at < 60_000), now]
    if (exits.length >= 3) {
      $.ui.log(`${PLUGIN}: the session helper keeps exiting; each step starts its own helper now`, { to: 'debug' })

      return
    }
    await $.clock.sleep(1_000)
  }
}

async function findBun($: EngineInterface): Promise<string | undefined> {
  const found = await $.process.run(['/bin/sh', '-c', 'command -v bun || { [ -x "$HOME/.bun/bin/bun" ] && echo "$HOME/.bun/bin/bun"; }'], { timeoutMs: 10_000 })

  return found.exitCode === 0 && found.stdout.trim() !== '' ? found.stdout.trim().split('\n')[0] : undefined
}

/** The Codex CLI's own defaults: its model and reasoning effort, from config.toml. */
async function readCodexDefaults($: EngineInterface): Promise<{ model?: string; effort?: Effort }> {
  const home = (await $.env.get('CODEX_HOME')) || `${(await $.env.get('HOME')) ?? ''}/.codex`
  try {
    const text = await $.fs.read(`${home}/config.toml`)
    const top = text.split(/^\[/m)[0] ?? ''
    const model = /^model\s*=\s*"([^"]+)"/m.exec(top)?.[1]
    const effort = /^model_reasoning_effort\s*=\s*"([^"]+)"/m.exec(top)?.[1]

    return { model, effort: EFFORTS.includes(effort as Effort) ? (effort as Effort) : effort === 'ultra' ? 'max' : undefined }
  } catch {
    return {}
  }
}

async function registerAgents($: EngineInterface): Promise<void> {
  const model = `codex/${codexDefaults.model ?? 'gpt-6.1-sol'}`
  const agents: { name: string; description: string; def: AgentDef }[] = [
    {
      name: 'codex',
      description: `A general-purpose subagent running on ${model} (OpenAI Codex via the ChatGPT subscription), with Claude Code's tools. Give it a complete, self-contained task.`,
      def: { prompt: GENERAL_PURPOSE_PROMPT },
    },
    {
      name: 'codex-explore',
      description: `A read-only search agent running on ${model}: finds code and files and reports where they are. Say how thorough to be.`,
      def: { prompt: EXPLORE_PROMPT, tools: ['Read', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch'] },
    },
  ]
  for (const agent of agents) {
    await $.agent.register({ name: agent.name, description: agent.description, prompt: agent.def.prompt, model, ...(agent.def.tools ? { tools: agent.def.tools } : {}) })
    registered.set(`${PLUGIN}:${agent.name}`, agent.def)
  }
  for (const [worker, info] of Object.entries(WORKERS)) {
    if (!(await hasCli($, worker))) continue
    const workerModel = `${worker}/${info.model}`
    for (const write of [false, true]) {
      const name = write ? `${worker}-write` : worker
      const can = write ? 'reads, runs its own tools and may edit files (accept-edits)' : 'reads and plans only (plan mode)'
      const prompt = `You are ${info.label} working for a Claude Code session. Do the task you are given with your own tools, then answer with a complete report of what you found or changed; that report is all the caller reads.`
      await $.agent.register({ name, description: `Runs ${info.label} on ${workerModel} as a worker with its own tools; it ${can}. Use it when the user asks for ${info.ask}.`, prompt, model: workerModel, tools: [] })
      registered.set(`${PLUGIN}:${name}`, { prompt, tools: [] })
      workerWrites.set(`${PLUGIN}:${name}`, write)
    }
  }
}

async function hasCli($: EngineInterface, name: string): Promise<boolean> {
  const found = await $.process.run(['/bin/sh', '-c', 'command -v "$0" >/dev/null || [ -x "$HOME/.local/bin/$0" ]', name], { timeoutMs: 10_000 }).catch(() => undefined)

  return found?.exitCode === 0
}

/**
 * A worker step's request: no Claude system prompt or tools (the CLI brings its own), the agent's own
 * instructions when it has a definition, the transcript for its user turns, the session's directory, the
 * conversation's run to resume, and whether the run may edit files.
 */
async function buildWorkerRequest($: EngineInterface, e: TurnStepInput, transcript: readonly ApiMessage[]): Promise<StepRequest> {
  const who = e.agentId ?? 'main'
  let system = ''
  let write = (await read($, prefsAtom)).workers === 'write'
  if (e.agentId !== undefined) {
    const type = (await $.agent.list()).find(each => each.id === e.agentId)?.type
    const def = (type && registered.get(type)) || (await definitionOf(promptsPort($), memory, type))
    system = def?.prompt ?? ''
    write = type ? (workerWrites.get(type) ?? false) : false
  }
  const prefs = await read($, prefsAtom)
  const effort = e.effort ?? prefs.effort ?? undefined
  const resume = resumes.get(who)

  return {
    target: e.model,
    system,
    tools: [],
    transcript,
    ...(effort ? { effort } : {}),
    who,
    session: await $.session.id(),
    cwd: await $.session.cwd(),
    ...(resume ? { resume } : {}),
    workerWrite: write,
  }
}

/** The request for one routed step: the system prompt, the tools, the transcript with reasoning put back. */
async function buildRequest($: EngineInterface, e: TurnStepInput, transcript: readonly ApiMessage[]): Promise<{ req: StepRequest; handback?: string }> {
  const who = e.agentId ?? 'main'
  const target = targetOf(e.model)
  if (!target) throw new Error(`${e.model} names no provider`)
  const provider = target.label
  const infos = await $.tool.list()
  const names = infos.map(info => info.name)
  const io = promptsPort($)
  let system: string
  let allow: (tool: string) => boolean = () => true
  let messages = transcript
  let handback: string | undefined
  if (e.agentId === undefined) {
    system = rewriteMain((await $.prompt.compose({ model: e.model, tools: names })).sections, identityLine(target.model, provider))
  } else {
    const agent = (await $.agent.list()).find(each => each.id === e.agentId)
    const type = agent?.type
    const def = (type && registered.get(type)) || (await definitionOf(io, memory, type))
    allow = toolFilter(type, def)
    const offered = names.filter(allow)
    if (handbackState(transcript, HANDBACK_TOOL.name) === 'offered') handback = HANDBACK_TOOL.name
    const prompt = await systemFor(io, memory, {
      def,
      route: { type, label: e.model },
      engineModel: e.model,
      target: e.model,
      model: target.model,
      provider,
      tools: handback ? [...offered, handback] : offered,
    })
    system = prompt.text
    messages = withTask(messages, agent?.description)
  }
  const only = target.remote?.model.tools
  if (Array.isArray(only)) {
    const allowed = allow
    allow = tool => allowed(tool) && only.includes(tool)
  }
  messages = withCarry(withIdentity(messages, target.model, provider), carryFor(who))
  const tools: RemoteTool[] = remoteTools(infos, described, allow)
  if (handback) tools.push({ name: HANDBACK_TOOL.name, description: HANDBACK_TOOL.description, schema: { ...HANDBACK_TOOL.schema } })
  const prefs = await read($, prefsAtom)
  const isCodex = target.provider === 'codex' && !target.remote
  const effort: Effort | number | undefined = e.effort ?? prefs.effort ?? (isCodex ? (codexDefaults.effort ?? 'medium') : undefined)

  return {
    req: { target: e.model, system, tools, transcript: messages, ...(effort === undefined ? {} : { effort }), who, session: await $.session.id(), transport: prefs.transport },
    ...(handback ? { handback } : {}),
  }
}

/** One routed step, streamed. Every failure is answered as text (or a subagent's handback), never thrown, so
 *  the engine never sends the routed model id to Anthropic. */
async function* routedStep($: EngineInterface, e: TurnStepInput): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  const who = e.agentId ?? 'main'
  if (e.agentId !== undefined) agentModels.set(e.agentId, e.model)
  $.ui.log(`${PLUGIN}: step ${who} ${e.model} index=${e.index} effort=${e.effort ?? 'unset'}`, { to: 'debug' })
  const assembler = createAssembler(e.model)
  let handback: string | undefined
  let deliver = false
  try {
    const transcript = await $.session.messages(e.agentId === undefined ? { as: 'api' } : { as: 'api', agentId: e.agentId })
    if (!Array.isArray(transcript)) throw new Error(`the transcript of ${who} is unreadable (${transcript.deny})`)
    const isWorker = Object.hasOwn(WORKERS, targetOf(e.model)?.provider ?? '') && !targetOf(e.model)?.remote
    const built = isWorker ? { req: await buildWorkerRequest($, e, transcript as ApiMessage[]), ...(e.agentId !== undefined && handbackState(transcript as ApiMessage[], HANDBACK_TOOL.name) === 'offered' ? { handback: HANDBACK_TOOL.name } : {}) } : await buildRequest($, e, transcript as ApiMessage[])
    handback = built.handback
    deliver = isWorker
    const remote = targetOf(e.model)?.remote
    if (remote) {
      const refused = await approval($, remote)
      if (refused) throw new Error(refused)
      const size = estimateTokens(built.req)
      if (size > 0.95 * remote.budget) throw new Error(`the conversation is about ${Math.round(size / 1000)}k tokens, past ${remote.target}'s ${Math.round(remote.budget / 1000)}k input budget; run /compact`)
    }
    const reasoning: Reasoning[] = []
    let firstTool: string | undefined
    for await (const event of helperStep(helperPort($), await wireFor($, built.req))) {
      if (event.type === 'signature') reasoning.push({ thinking: event.thinking, signature: event.signature })
      else if (event.type === 'resume') resumes.set(who, event.key)
      else if (event.type === 'limits') {
        limits = event.limits
        $.ui.status(limitsText())
      } else if (event.type === 'stats') {
        const via = event.transport ?? 'http'
        lastStep = { model: e.model, who, ms: event.totalMs, transport: via }
        $.ui.log(`${PLUGIN}: step ${who} answered in ${event.totalMs} ms over ${via}`, { to: 'debug' })
      }
      else {
        if (event.type === 'tool_use') firstTool ??= event.id
        yield* assembler.feed(event)
      }
    }
    remember(carryFor(who), firstTool, reasoning)
  } catch (error) {
    assembler.feed({ type: 'error', kind: 'request', text: `rice-multi-models: ${error instanceof Error ? error.message : String(error)}` })
  }
  const end = assembler.end(handback ? { handback, deliver } : {})
  if (end.failure !== undefined && e.agentId !== undefined) $.ui.toast(end.failure.split('\n')[0] ?? end.failure)
  yield* end.chunks

  return { turnId: e.turnId, index: e.index, answer: end.answer, toolUses: end.toolUses, stopReason: end.stopReason, usage: end.usage }
}

const NO_USAGE: ModelUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

/** A one-shot completion on a routed model, for `model.complete` and `model.fork`. */
async function complete($: EngineInterface, req: StepRequest): Promise<ModelCompleteResult> {
  const remote = targetOf(req.target)?.remote
  if (remote && (await approval($, remote))) return { isAnswered: false, reason: 'api-error', status: null, error: 'unknown', usage: NO_USAGE }
  const answer = await collectText(helperPort($), await wireFor($, req))
  if (answer.error !== undefined) return { isAnswered: false, reason: 'api-error', status: null, error: 'unknown', usage: answer.usage ?? NO_USAGE }
  if (answer.text.trim() === '') return { isAnswered: false, reason: 'empty-reply', usage: answer.usage ?? NO_USAGE }

  return { isAnswered: true, text: answer.text, usage: answer.usage ?? NO_USAGE }
}

async function statusText($: EngineInterface): Promise<string> {
  const prefs = await read($, prefsAtom)
  const version = await $.session.version()
  const lines = [
    `helper: ${!bun ? 'bun not found (install Bun, then /reload-plugins)' : prefs.helper === 'once' ? 'one process per step (/rice-models helper session for the session helper)' : sessionHelper() ? 'session helper running (one connection per conversation, private socket)' : 'session helper not running; one process per step'}`,
    `transport: ${prefs.transport} (auto = WebSocket, falling back to server-sent events)`,
    `effort: ${prefs.effort ?? `${codexDefaults.effort ?? 'medium'} (Codex default)`}${prefs.effort ? ' (set here)' : ''}, unless the session sets one`,
    `Codex default model: codex/${codexDefaults.model ?? 'gpt-6.1-sol'}`,
    `tool schemas: generated for ${STAMP.engineVersion}${version.version !== STAMP.engineVersion ? ` (this is ${version.version}: regenerate with scripts/gen-schemas.ts)` : ''}`,
    limitsText() ? `ChatGPT limits: ${limitsText()}` : 'ChatGPT limits: shown after the first WebSocket request',
    lastStep ? `last step: ${lastStep.model} for ${lastStep.who}, ${lastStep.ms} ms over ${lastStep.transport}` : 'no routed step yet',
    ...memory.notes.slice(-5),
  ]

  return lines.join('\n')
}

async function codexCache($: EngineInterface): Promise<{ models?: { slug?: string; display_name?: string; context_window?: number; visibility?: string }[] }> {
  const home = (await $.env.get('CODEX_HOME')) || `${(await $.env.get('HOME')) ?? ''}/.codex`
  try {
    return JSON.parse(await $.fs.read(`${home}/models_cache.json`)) as { models?: { slug?: string; display_name?: string; context_window?: number; visibility?: string }[] }
  } catch {
    return {}
  }
}

/** Every routed model as a picker row: Codex's, the declared providers', and the installed workers'. */
async function routedRows($: EngineInterface): Promise<PickerRow[]> {
  const rows = [...codexRows(await codexCache($)), ...providerRows(loaded.config)]
  if (await hasCli($, 'agy')) {
    const listed = await $.process.run(['/bin/sh', '-c', 'exec "$(command -v agy || echo "$HOME/.local/bin/agy")" models'], { timeoutMs: 30_000 }).catch(() => undefined)
    const ids = listed?.exitCode === 0 ? agyModelIds(listed.stdout) : []
    rows.push(...workerRows('agy', 'Antigravity', ids.length > 0 ? ids : [WORKERS.agy?.model ?? 'gemini-3.8-flash-high']))
  }
  if (await hasCli($, 'grok')) rows.push(...workerRows('grok', 'Grok', [WORKERS.grok?.model ?? 'grok-build']))

  return rows
}

async function modelsText($: EngineInterface): Promise<string> {
  const rows = await routedRows($)
  if (rows.length === 0) return 'No routed models: sign in to Codex (codex login), declare providers in rice-multi-models.json, or install agy or grok.'

  return `${rows.map(row => `${row.model}  ${row.label}`).join('\n')}\n\nUse one with /model <id>, --model <id>, or model: <id> in an agent file. /rice-models picker write lists them in /model.`
}

/** The user settings with the picker's routed rows replaced by the current ones. */
async function writePicker($: EngineInterface): Promise<string> {
  const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${(await $.env.get('HOME')) ?? ''}/.claude`
  const path = `${dir}/settings.json`
  const settings = (await $.fs.exists(path)) ? (JSON.parse(await $.fs.read(path)) as Record<string, unknown>) : {}
  const picker = (settings.modelPicker && typeof settings.modelPicker === 'object' ? settings.modelPicker : {}) as Record<string, unknown>
  const rows = await routedRows($)
  const ours = (model: string): boolean => ['codex/', 'agy/', 'grok/'].some(prefix => model.startsWith(prefix)) || remoteOf(loaded, model) !== undefined
  const options = mergeRows(picker.options, rows, ours)
  await $.fs.write(path, `${JSON.stringify({ ...settings, modelPicker: { ...picker, options } }, null, 2)}\n`)

  return `Wrote ${rows.length} routed rows into ${path} (modelPicker); rows you wrote yourself were kept. /model lists them in new sessions.`
}

async function runCommand($: EngineInterface, args: string): Promise<string> {
  const [first, value] = args.trim().split(/\s+/)
  if (!first || first === 'status') return statusText($)
  if (first === 'models') return modelsText($)
  if (first === 'picker') return value === 'write' ? writePicker($) : `${JSON.stringify({ modelPicker: { options: await routedRows($) } }, null, 2)}\n\n/rice-models picker write puts these rows in your user settings.`
  if (first === 'providers') return providerLines(loaded, await approvedSet($)).join('\n')
  if (first === 'reload') {
    await loadProviders($)

    return loaded.errors.length > 0 ? `${loaded.path} does not validate; no declared provider routes:\n${loaded.errors.join('\n')}` : providerLines(loaded, await approvedSet($)).join('\n')
  }
  if (first === 'approve') {
    const provider = value ? loaded.config?.providers[value] : undefined
    if (!provider) return `Usage: /rice-models approve <provider>; declared: ${Object.keys(loaded.config?.providers ?? {}).join(', ') || 'none'}`
    const remote = remoteOf(loaded, `${provider.id}/${Object.keys(provider.models)[0] ?? ''}`)
    if (!remote) return `${provider.id} declares no model`
    await $.store.set(`${TRUST_PREFIX}${remote.fingerprint}`, true)

    return `Approved ${provider.id}: conversations for its models go to ${provider.origin}. A changed address or key command asks again.`
  }
  if (first === 'effort') {
    if (value === 'default') {
      await update($, prefsAtom, prefs => ({ ...prefs, effort: null }))

      return 'Effort back to the Codex default.'
    }
    if (!EFFORTS.includes(value as Effort)) return `Usage: /rice-models effort ${EFFORTS.join('|')}|default`
    await update($, prefsAtom, prefs => ({ ...prefs, effort: value as Effort }))

    return `Routed models think at ${value} effort in this session, unless a request sets its own.`
  }
  if (first === 'workers') {
    if (value !== 'read' && value !== 'write') return 'Usage: /rice-models workers read|write (for agy/... or grok/... as the session model)'
    const workers: 'read' | 'write' = value
    await update($, prefsAtom, prefs => ({ ...prefs, workers }))

    return workers === 'write' ? 'A worker model in this session may edit files (accept-edits).' : 'A worker model in this session only reads and plans.'
  }
  if (first === 'helper') {
    if (value !== 'session' && value !== 'once') return 'Usage: /rice-models helper session|once'
    const helper: 'session' | 'once' = value
    await update($, prefsAtom, prefs => ({ ...prefs, helper }))
    preferSession(value === 'session')

    return value === 'session' ? 'Steps go to the session helper (one connection per conversation).' : 'Each step starts its own helper (no local socket).'
  }
  if (first === 'transport') {
    if (value !== 'auto' && value !== 'ws' && value !== 'sse') return 'Usage: /rice-models transport auto|ws|sse'
    await update($, prefsAtom, prefs => ({ ...prefs, transport: value as Transport }))

    return `Routed requests use ${value === 'auto' ? 'a WebSocket, falling back to server-sent events' : value === 'ws' ? 'a WebSocket only' : 'server-sent events only'}.`
  }

  return 'Usage: /rice-models [status | models | picker [write] | providers | approve <provider> | reload | effort <level> | transport auto|ws|sse | helper session|once | workers read|write]'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    bun = await findBun($)
    codexDefaults = await readCodexDefaults($)
    await loadProviders($)
    await $.command.register({
      name: 'rice-models',
      description: 'Non-Anthropic models in this session: status, models, providers, approvals, effort, transport',
      argumentHint: '[status | models | picker [write] | providers | approve <provider> | reload | effort <level> | transport auto|ws|sse | helper session|once | workers read|write]',
    })
    await registerAgents($)
    preferSession((await read($, prefsAtom)).helper !== 'once')
    void superviseHelper($)

    return started
  })

  on('tool.describe', async ($, e, next) => {
    const answer = await next(e)
    described.set(e.tool, { description: answer.description, isDeferred: answer.isDeferred ?? e.isDeferred })

    return answer
  })

  on('turn.step', async function* ($, e, next) {
    if (!isRouted(e.model)) return yield* next(e)

    return yield* routedStep($, e)
  })

  on('session.compact', async ($, e, next) => {
    const model = e.agentId === undefined ? await $.session.model() : agentModels.get(e.agentId)
    if (!isRouted(model)) return next(e)
    if (e.trigger === 'precompute') return { skip: 'rice-multi-models compacts a routed conversation when it is due, not ahead' }
    const transcript = await $.session.messages(e.agentId === undefined ? { as: 'api' } : { as: 'api', agentId: e.agentId })
    if (!Array.isArray(transcript)) return { skip: `rice-multi-models: the transcript is unreadable (${transcript.deny})` }
    const remote = targetOf(model)?.remote
    const refused = remote ? await approval($, remote) : undefined
    if (refused) return { skip: `rice-multi-models: ${refused}` }
    const effort = (await read($, prefsAtom)).effort ?? (remote ? undefined : 'medium')
    const req: StepRequest = { target: model, system: COMPACT_SYSTEM, tools: [], transcript: compactRequest(transcript as ApiMessage[], e.instructions), ...(effort ? { effort } : {}), who: `${e.agentId ?? 'main'}:compact`, session: await $.session.id() }
    const answer = await collectText(helperPort($), await wireFor($, req))
    if (answer.error !== undefined || answer.text.trim() === '') return { skip: `rice-multi-models: ${model} could not summarize (${answer.error ?? 'empty reply'})` }

    return { messages: [{ role: 'user', text: summaryMessage(answer.text), toolUses: [] }] }
  }).catch(($, e, next) => next(e))

  on('model.complete', async ($, e, next) => {
    if (!isRouted(e.model)) return next(e)
    const req: StepRequest = {
      target: e.model,
      system: e.system ?? '',
      tools: [],
      transcript: [{ role: 'user', content: [{ type: 'text', text: e.prompt }] }],
      effort: e.effort ?? 'low',
      who: 'complete',
      session: await $.session.id(),
    }

    return { value: await complete($, req) }
  }).catch(($, e, next) => next(e))

  on('model.fork', async ($, e, next) => {
    const model = await $.session.model()
    if (!isRouted(model)) return next(e)
    const transcript = await $.session.messages({ as: 'api' })
    if (!Array.isArray(transcript)) return next(e)
    const req: StepRequest = {
      target: model,
      system: rewriteMain((await $.prompt.compose({ model })).sections, identityLine(targetOf(model)?.model ?? model, targetOf(model)?.label ?? 'codex')),
      tools: [],
      transcript: withUserText(transcript as ApiMessage[], e.prompt),
      effort: 'low',
      who: 'fork',
      session: await $.session.id(),
    }

    return { value: await complete($, req) }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'rice-models' }, async ($, e) => ({ text: await runCommand($, e.args) }))
}
