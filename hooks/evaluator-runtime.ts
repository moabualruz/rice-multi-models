import type { EngineInterface, On } from 'claude-code'
import { commandHookResult, evaluatorAnswer, evaluatorPrompt, evaluatorTools, planStopEvaluators, runStopEvaluators } from './evaluators'
import type { EvaluatorCompletion, EvaluatorEvent, EvaluatorOwner, EvaluatorSource, PlannedCommand, PlannedEvaluator } from './evaluators'
import type { StepRequest } from './protocol'
import type { HelperPort } from './backend'
import { TRUST_PREFIX } from './providers'
import { pluginHookConflict } from './evaluator-coverage'

export type EvaluatorRuntimePorts = {
  /** Null is a verified native owner; unresolved routed ownership must throw. */
  owner(context: { agentId?: string; mainModel: string; session: string }): Promise<EvaluatorOwner | null>
  complete(port: HelperPort, request: StepRequest, approved: readonly string[], timeoutMs: number, signal: AbortSignal): Promise<EvaluatorCompletion>
  node(): Promise<string>
  /** Additional loaded definitions, obtained from actual public event metadata. */
  sources?(event: EvaluatorEvent): Promise<{ sources: EvaluatorSource[]; errors?: string[] }>
}

type AgentRun = {
  type: string
  owner: EvaluatorOwner
  node: string
  directory: string
  nonce: string
  deadline: number
  agentId?: string
  captured: boolean
  stopped: boolean
}
type RuntimeState = {
  types: Map<string, AgentRun>; agents: Map<string, AgentRun>; ownedTypes: Set<string>; shell?: 'bash' | 'powershell'
  /** Events each other admitted hooks module registered, by plugin name. */
  moduleEvents: Map<string, readonly string[]>
  /** Classic events invoked skills registered session hooks for. */
  skillEvents: Set<string>
}
const failed = 'The configured evaluator did not finish through its selected provider. No Claude fallback was used.'

function selectedPort($: EngineInterface, node: string, timeoutMs: number): HelperPort {
  async function* bounded(argv: string[], input: string) {
    const result = await $.process.run(argv, { stdin: input, timeoutMs: Math.min(timeoutMs, 600_000) })
    if (result.isStdoutTruncated) throw new Error('The selected-provider evaluator response was truncated.')
    if (result.stdout) yield { stream: 'stdout' as const, text: result.stdout }
    return { code: result.exitCode, signal: null }
  }
  return {
    once: input => bounded([node, `${$.plugin.root}/dist/helper.mjs`, 'once'], input),
    client: (input, socketPath) => bounded([node, `${$.plugin.root}/dist/helper.mjs`, 'client', socketPath], input),
  }
}

async function ownerOf($: EngineInterface, agentId: string | undefined, ports: EvaluatorRuntimePorts) {
  return ports.owner({ ...(agentId ? { agentId } : {}), mainModel: await $.session.model(), session: await $.session.id() })
}

async function grants($: EngineInterface): Promise<string[]> {
  const keys = (await $.store.keys()).filter(key => key.startsWith(TRUST_PREFIX))
  const values = await Promise.all(keys.map(async key => await $.store.get(key) === true ? key.slice(TRUST_PREFIX.length) : undefined))
  return values.filter((value): value is string => value !== undefined)
}

async function helper($: EngineInterface, node: string, mode: string, input: unknown, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  const result = await $.process.run([node, `${$.plugin.root}/scripts/evaluator-wait.mjs`, mode], { stdin: JSON.stringify(input), timeoutMs: Math.min(600_000, timeoutMs) })
  if (result.exitCode !== 0 || result.isStdoutTruncated) throw new Error('The private evaluator operation did not complete.')
  const value: unknown = JSON.parse(result.stdout)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The private evaluator operation returned an invalid result.')
  return value as Record<string, unknown>
}

async function runFor($: EngineInterface, agentId: string | undefined, state: RuntimeState): Promise<AgentRun | undefined> {
  if (!agentId) return undefined
  const known = state.agents.get(agentId)
  if (known) return known
  if (!state.types.size) return undefined
  const agent = (await $.agent.list()).find(each => each.id === agentId)
  const run = agent && state.types.get(agent.type)
  if (!run || agent.spawnedBy !== $.plugin.name || agent.parentId !== (run.owner.who === 'main' ? undefined : run.owner.who)) return undefined
  if (run.agentId && run.agentId !== agentId) throw new Error('The evaluator agent identity changed.')
  run.agentId = agentId
  state.agents.set(agentId, run)
  return run
}

async function publish($: EngineInterface, run: AgentRun, text: string, model: string): Promise<void> {
  if (run.captured) return
  if (!run.agentId || model !== run.owner.target || evaluatorAnswer('agent', { isAnswered: true, text }).error) throw new Error('The evaluator has no valid final verdict for its owner.')
  run.captured = true
  await helper($, run.node, 'publish', { ...run, text, model })
}

async function hold($: EngineInterface, run: AgentRun): Promise<void> {
  const remaining = run.deadline - Date.now()
  if (remaining <= 0) throw new Error('The evaluator deadline expired.')
  await helper($, run.node, 'hold', { ...run, timeoutMs: remaining }, remaining + 1000)
}

async function stopOwned($: EngineInterface, run: AgentRun): Promise<void> {
  if (!run.agentId || run.stopped) return
  const stopped = await $.tool.call({ tool: 'TaskStop', task_id: run.agentId })
  if (stopped.isError || stopped.deny || stopped.result?.task_id !== run.agentId) throw new Error('The owned evaluator task could not be stopped.')
  run.stopped = true
  await helper($, run.node, 'release', run)
}

async function removeRun($: EngineInterface, run: AgentRun, state: RuntimeState): Promise<void> {
  // A failed stop leaves the identity retained for a fresh cleanup event.
  if (run.agentId && !run.stopped) return
  state.types.delete(run.type)
  if (run.agentId) state.agents.delete(run.agentId)
  await helper($, run.node, 'cleanup', run)
}

async function command($: EngineInterface, hook: PlannedCommand, event: EvaluatorEvent, node: string) {
  if (hook.raw.async || hook.raw.asyncRewake) throw new Error('Background commands require the native hook scheduler.')
  const result = await helper($, node, 'command', {
    hook: { ...hook.raw, timeoutMs: hook.timeoutMs }, event, projectDirectory: await $.session.cwd(),
    ...(hook.origin.kind === 'plugin' ? { pluginRoot: hook.origin.id } : {}),
  }, hook.timeoutMs + 1000)
  if (typeof result.exitCode !== 'number' || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') throw new Error('The configured command result is invalid.')
  return commandHookResult({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, failed: result.failed === true }, hook.raw.onFailure)
}

async function agent($: EngineInterface, hook: PlannedEvaluator, event: EvaluatorEvent, owner: EvaluatorOwner, node: string, signal: AbortSignal, state: RuntimeState): Promise<EvaluatorCompletion> {
  signal.throwIfAborted()
  const created = await helper($, node, 'create', {})
  if (typeof created.directory !== 'string' || typeof created.nonce !== 'string') throw new Error('The evaluator has no private rendezvous.')
  const name = `evaluator-${crypto.randomUUID()}`
  const run: AgentRun = { type: `${$.plugin.name}:${name}`, owner, node, directory: created.directory, nonce: created.nonce, deadline: Date.now() + hook.timeoutMs, captured: false, stopped: false }
  state.types.set(run.type, run)
  state.ownedTypes.add(run.type)
  try {
    const tools = evaluatorTools((await $.tool.list()).map(tool => tool.name))
    const registered = await $.agent.register({
      name, description: 'Verify one configured hook condition for its owning conversation', model: owner.target,
      tools, permissionMode: 'dontAsk', maxTurns: 50,
      prompt: 'You verify one configured hook condition. Use the available tools when evidence is needed, retaining every permission check. Return exactly one final JSON object with ok (boolean) and reason (string). The evaluator owner captures that verdict and stops only this verification task. Do not continue after the verdict.',
    })
    run.type = registered.agent
    state.types.set(run.type, run)
    state.ownedTypes.add(run.type)
    const spawned = await $.agent.spawn({ subagentType: registered.agent, prompt: evaluatorPrompt(hook.prompt, event), description: 'Verify the configured hook condition' })
    // Retain a created identity before validating its model, so even an invalid
    // spawn result is cleaned up by the exact owner in finally.
    if (spawned.agentId) { run.agentId = spawned.agentId; state.agents.set(spawned.agentId, run) }
    if (spawned.deny || !spawned.agentId || spawned.model !== owner.target) throw new Error('The evaluator agent did not start with its owning model.')
    signal.throwIfAborted()
    const remaining = run.deadline - Date.now()
    if (remaining <= 0) throw new Error('The evaluator deadline expired.')
    const report = await helper($, node, 'wait', { ...run, model: owner.target, timeoutMs: remaining }, remaining + 1000)
    signal.throwIfAborted()
    if (typeof report.text !== 'string') throw new Error('The evaluator did not return a final verdict.')
    return { isAnswered: true, text: report.text }
  } finally {
    try { await stopOwned($, run) }
    finally { await removeRun($, run, state) }
  }
}

async function sources($: EngineInterface, event: EvaluatorEvent, ports: EvaluatorRuntimePorts, node: string, state: RuntimeState) {
  const effective = await $.settings.read()
  if (effective.disableAllHooks === true) return { hooks: [], hasEvaluators: false, errors: [] }
  // Raw source snapshots can include disabled files. Only the merged effective
  // configuration represents the commands authorized for this invocation.
  const settings: EvaluatorSource[] = [
    { origin: { kind: 'settings' }, settings: effective },
    { origin: { kind: 'settings', managed: true }, settings: await $.settings.read({ source: 'policy' }) },
  ]
  const extra = ports.sources ? await ports.sources(event) : { sources: [] }
  if (!state.shell) {
    const actual = (await helper($, node, 'shell', {})).shell
    if (actual !== 'bash' && actual !== 'powershell') throw new Error('The native command-hook shell is unavailable.')
    state.shell = actual
  }
  const plan = planStopEvaluators([...settings, ...extra.sources], event, state.shell)
  plan.errors.push(...extra.errors ?? [])
  return plan
}

/** Why another hook source of this event may exist beyond the mod's view, or undefined when none can. */
async function hiddenSource($: EngineInterface, event: EvaluatorEvent, state: RuntimeState): Promise<string | undefined> {
  const name = event.hook_event_name
  if (await $.env.get('CLAUDE_CODE_PLUGIN_DIRS')) return 'session plugin directories are not visible to the mod'
  if (state.skillEvents.has(name) || name === 'SubagentStop' && state.skillEvents.has('Stop')) return 'an invoked skill registered hooks for this event'
  for (const [plugin, events] of state.moduleEvents) {
    if (plugin !== $.plugin.name && events.some(pattern => pattern === `classic.${name}` || pattern === 'classic.*' || pattern === '*')) return `${plugin} hooks this event`
  }
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${(await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''}/.claude`
  const effective = await $.settings.read()
  return pluginHookConflict(name, { configDir: configDir.replace(/[\\/]+$/, ''), enabledPlugins: (effective.enabledPlugins ?? {}) as Record<string, unknown>, ownPlugin: $.plugin.name, observedModules: new Set(state.moduleEvents.keys()), exists: path => $.fs.exists(path), read: path => $.fs.read(path) })
}

async function evaluate($: EngineInterface, event: EvaluatorEvent, signal: AbortSignal, ports: EvaluatorRuntimePorts, state: RuntimeState) {
  // The replacement's own verification agents must never recursively evaluate.
  if (typeof event.agent_id === 'string' && await runFor($, event.agent_id, state)) return { result: {}, errors: [] }
  const owner = await ownerOf($, typeof event.agent_id === 'string' ? event.agent_id : undefined, ports)
  if (!owner) return undefined
  if (owner.who !== (event.agent_id ?? 'main')) throw new Error('The configured evaluator has no verified conversation owner.')
  const node = await ports.node()
  const plan = await sources($, event, ports, node, state)
  if (!plan.hasEvaluators) return undefined
  // Replacing evaluators means answering without the native step that runs
  // every other source. When any source could be hidden, or a configured hook
  // needs behavior the adapter cannot reproduce, native hooks run unchanged.
  // Agent-type evaluators need a native verification loop whose completion the
  // host does not expose; a held-and-stopped replacement broke across Claude
  // Code releases, so those events stay native and prompt evaluators are routed.
  const agentEvaluators = plan.hooks.some(hook => hook.type === 'agent')
  const hidden = agentEvaluators ? 'an agent-type evaluator needs the native verification loop'
    : plan.errors.length ? plan.errors.join('; ') : await hiddenSource($, event, state)
  if (hidden) {
    $.ui.log(`${$.plugin.name}: ${event.hook_event_name} evaluators run natively because ${hidden}`, { to: 'debug' })
    return undefined
  }
  const result = await runStopEvaluators(plan, event, owner, {
    command: (hook, input) => command($, hook, input, node),
    prompt: async (hook, request, cancellation) => ports.complete(selectedPort($, node, hook.timeoutMs), request, await grants($), hook.timeoutMs, cancellation),
    agent: (hook, input, actual, cancellation) => agent($, hook, input, actual, node, cancellation, state),
  }, signal)
  signal.throwIfAborted()
  const current = await ownerOf($, typeof event.agent_id === 'string' ? event.agent_id : undefined, ports)
  if (!current || current.target !== owner.target || current.who !== owner.who || current.session !== owner.session) throw new Error('The evaluator conversation changed during verification.')
  return result
}

/** Register before the ordinary routed turn.step handler. Uses only public APIs. */
export function registerEvaluators(on: On, ports: EvaluatorRuntimePorts): void {
  const state: RuntimeState = { types: new Map(), agents: new Map(), ownedTypes: new Set(), moduleEvents: new Map(), skillEvents: new Set() }
  on('plugin.register', { name: /.+/ }, async (_$, e, next) => {
    const result = await next(e)
    if (result.allow) state.moduleEvents.set(e.name, e.uses.events)
    return result
  })
  on('skill.prompt', { skill: /.+/ }, async (_$, e, next) => {
    const result = await next(e)
    const hooks = e.frontmatter.hooks
    if (hooks !== null && typeof hooks === 'object' && !Array.isArray(hooks)) for (const name of Object.keys(hooks)) state.skillEvents.add(name)
    return result
  })
  // Registered definitions outlive a completed run. Keep only definitions this
  // adapter created hidden, including after their task and rendezvous are gone.
  on('agent.offer', { agent: /:evaluator-[0-9a-f-]+$/ }, (_$, e, next) => state.ownedTypes.has(e.agent) ? { isOffered: false } : next(e))
  on('turn.step', { agentId: /.+/ }, async function* ($, e, next) {
    const run = await runFor($, e.agentId, state)
    if (run && e.model !== run.owner.target) {
      // Returning a controlled failure keeps native middleware from skipping a
      // thrown hook into inference with the wrong conversation model.
      yield { kind: 'text', index: 0, text: failed }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }
      return { turnId: e.turnId, index: e.index, answer: failed, toolUses: [], stopReason: 'end_turn', usage: null }
    }
    const result = yield* next(e)
    if (!run || run.stopped || run.captured) return result
    if (result.stopReason === 'end_turn' && result.toolUses.length === 0 && !evaluatorAnswer('agent', { isAnswered: true, text: result.answer }).error) {
      await publish($, run, result.answer, e.model)
      await hold($, run)
    }
    return result
  })
  on('tool.call', { tool: /^SubagentHandback$/ }, async ($, e, next) => {
    const run = await runFor($, e.agentId, state)
    if (!run) return next(e)
    const text = 'message' in e && typeof e.message === 'string' ? e.message : undefined
    if (text !== undefined && !evaluatorAnswer('agent', { isAnswered: true, text }).error) {
      await publish($, run, text, run.owner.target)
      await hold($, run)
    }
    return { deny: 'This owned evaluator reports through its final JSON verdict; its owner ends the verification task.' }
  }).catch(($, e, next) => state.agents.has(e.agentId ?? '') ? { deny: 'The owned evaluator final report was not delivered or replayed.' } : next(e))
  on('classic.Stop', async ($, e, next) => {
    const evaluated = await evaluate($, e, next.signal, ports, state)
    if (!evaluated) return next(e)
    for (const error of evaluated.errors ?? []) $.ui.log(error)
    return evaluated.result
  }).catch(() => ({ preventContinuation: true, stopReason: failed }))
  on('classic.SubagentStop', async ($, e, next) => {
    const evaluated = await evaluate($, e, next.signal, ports, state)
    if (!evaluated) return next(e)
    for (const error of evaluated.errors ?? []) $.ui.log(error)
    return evaluated.result
  }).catch(() => ({ preventContinuation: true, stopReason: failed }))
  on('turn.complete', { isAborted: true }, async ($, e, next) => {
    for (const run of state.types.values()) if (run.owner.who === (e.agentId ?? 'main')) {
      try { await stopOwned($, run); await removeRun($, run, state) } catch { $.ui.log('An owned evaluator could not finish cleanup; its exact identity remains tracked.') }
    }
    return next(e)
  })
  on('session.end', { reason: /.+/ }, async ($, e, next) => {
    for (const run of state.types.values()) {
      try { await stopOwned($, run); await removeRun($, run, state) } catch { $.ui.log('An owned evaluator could not finish cleanup; no other agent was stopped.') }
    }
    return next(e)
  })
}
