import type { StepRequest } from './protocol'
import { withUserText } from './compact'
import type { EvaluatorContext } from './native-evaluator'

export type EvaluatorEvent = {
  hook_event_name: 'Stop' | 'SubagentStop'
  agent_type?: string
  [key: string]: unknown
}

export type EvaluatorOwner = { target: string; who: string; session: string }
export type HookOrigin = {
  kind: 'settings' | 'plugin' | 'skill' | 'agent'
  /** A plugin or skill root keeps its copy separate from settings copies. */
  id?: string
  /** Managed hooks already ran above the public classic event. */
  managed?: boolean
}
export type EvaluatorSource = { origin: HookOrigin; settings: unknown }
export type PlannedEvaluator = {
  type: 'prompt' | 'agent'
  prompt: string
  timeoutMs: number
  origin: HookOrigin
}
export type PlannedCommand = {
  type: 'command'
  command: string
  args?: string[]
  shell?: 'bash' | 'powershell'
  timeoutMs: number
  origin: HookOrigin
  /** The host retains background, failure and environment semantics. */
  raw: Readonly<Record<string, unknown>>
}
export type PlannedHook = PlannedEvaluator | PlannedCommand
export type EvaluatorPlan = { hooks: PlannedHook[]; hasEvaluators: boolean; errors: string[] }
export type StopHookResult = { block?: string; preventContinuation?: true; stopReason?: string; additionalContext?: string[] }
export type HookOutcome = { result: StopHookResult; error?: string }
export type EvaluatorCompletion = { isAnswered: boolean; text?: string }

const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const row = object(value)
  return row ? `{${Object.keys(row).sort().filter(key => row[key] !== undefined).map(key => `${JSON.stringify(key)}:${stable(row[key])}`).join(',')}}` : JSON.stringify(value) ?? 'null'
}

function groups(settings: unknown, name: EvaluatorEvent['hook_event_name']): unknown[] {
  const value = object(object(settings)?.hooks)?.[name]
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('A loaded Stop hook group is invalid.')
  return value
}

function matches(matcher: unknown, event: EvaluatorEvent): boolean {
  // Stop has no matcher axis. Native Claude ignores a matcher on that event.
  if (event.hook_event_name === 'Stop' || matcher === undefined || matcher === '' || matcher === '*' || matcher === '.*') return true
  if (typeof matcher !== 'string') throw new Error('A loaded SubagentStop matcher is invalid.')
  // Native matcher parsing reserves regex behavior for patterns containing
  // syntax beyond the exact-name/list alphabet. Simple names match in full.
  if (/^[a-zA-Z0-9_\- ,|]+$/.test(matcher)) return matcher.split(/[|,]/).some(name => name.trim() === (event.agent_type ?? ''))
  return new RegExp(matcher).test(event.agent_type ?? '')
}

/**
 * Plan only the sources the host actually loaded. This does not discover active
 * skill, plugin or agent hooks from a merged settings snapshot. Callers supply
 * those sources separately, with the root which owns their placeholders.
 */
export function planStopEvaluators(sources: readonly EvaluatorSource[], event: EvaluatorEvent, defaultShell: 'bash' | 'powershell'): EvaluatorPlan {
  const errors: string[] = [], managed = new Set<string>()
  for (const source of sources.filter(source => source.origin.managed)) {
    try { for (const group of groups(source.settings, event.hook_event_name)) managed.add(stable(group)) }
    catch { errors.push('Managed hook metadata could not be read; no replacement plan is safe.') }
  }
  const commands = new Map<string, PlannedCommand>(), prompts = new Map<string, PlannedEvaluator>(), agents = new Map<string, PlannedEvaluator>()
  for (const source of sources.filter(source => !source.origin.managed)) {
    try {
      for (const candidate of groups(source.settings, event.hook_event_name)) {
        // The native managed-exclusion pass compares whole matcher groups.
        if (source.origin.kind === 'settings' && managed.has(stable(candidate))) continue
        const group = object(candidate)
        if (!group || !Array.isArray(group.hooks)) throw new Error('A loaded Stop hook group is invalid.')
        if (!matches(group.matcher, event)) continue
        for (const value of group.hooks) {
          const hook = object(value)
          if (!hook) throw new Error('A loaded Stop hook is invalid.')
          // `if` is evaluated only on tool events; it never runs on Stop.
          if (hook.if) continue
          const namespace = source.origin.kind === 'plugin' || source.origin.kind === 'skill' ? `${source.origin.kind}:${source.origin.id ?? ''}` : ''
          if ((source.origin.kind === 'plugin' || source.origin.kind === 'skill') && !source.origin.id) throw new Error('A hook source has no owning root.')
          const seconds = hook.timeout ?? (hook.type === 'prompt' ? 30 : hook.type === 'agent' ? 60 : 600)
          if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) throw new Error('A loaded hook timeout is invalid.')
          const timeoutMs = seconds * 1000
          if (hook.type === 'command') {
            if (hook.async || hook.asyncRewake) {
              errors.push('A background Stop command requires the native hook scheduler; the replacement cannot preserve it.')
              continue
            }
            if (!nonempty(hook.command) || hook.args !== undefined && (!Array.isArray(hook.args) || !hook.args.every(each => typeof each === 'string'))
              || hook.shell !== undefined && hook.shell !== 'bash' && hook.shell !== 'powershell') throw new Error('A loaded command hook is invalid.')
            const args = hook.args as string[] | undefined, shell = hook.shell as 'bash' | 'powershell' | undefined
            const key = `${namespace}\0command\0${shell ?? defaultShell}\0${hook.command}\0${stable(args ?? null)}\0${hook.if ?? ''}`
            commands.set(key, { type: 'command', command: hook.command, ...(args === undefined ? {} : { args: [...args] }), ...(shell === undefined ? {} : { shell }), timeoutMs, origin: source.origin, raw: { ...hook } })
          } else if (hook.type === 'prompt' || hook.type === 'agent') {
            if (!nonempty(hook.prompt)) throw new Error('A loaded evaluator prompt is invalid.')
            const item: PlannedEvaluator = { type: hook.type, prompt: hook.prompt, timeoutMs, origin: source.origin }
            ;(hook.type === 'prompt' ? prompts : agents).set(`${namespace}\0${hook.prompt}\0${hook.if ?? ''}`, item)
          } else {
            errors.push('The Stop replacement cannot preserve a loaded hook kind.')
          }
        }
      }
    } catch (error) { errors.push(error instanceof Error ? error.message : 'Loaded hook metadata is invalid.') }
  }
  const hooks = [...commands.values(), ...prompts.values(), ...agents.values()]
  return { hooks, hasEvaluators: prompts.size + agents.size > 0, errors }
}

/** The native prompt rule appends the event when no placeholder occurs. */
export function evaluatorPrompt(prompt: string, event: EvaluatorEvent): string {
  const input = JSON.stringify(event)
  return prompt.includes('$ARGUMENTS') ? prompt.replaceAll('$ARGUMENTS', input) : `${prompt}\n\n${input}`
}

export function evaluatorRequest(hook: PlannedEvaluator, event: EvaluatorEvent, owner: EvaluatorOwner, context: EvaluatorContext): StepRequest {
  if (context.template.event !== event.hook_event_name) throw new Error('The evaluator contract belongs to a different native event.')
  return {
    ...owner, system: context.template.system,
    tools: [], transcript: withUserText(context.transcript, context.template.prefix + evaluatorPrompt(hook.prompt, event)),
    native: { maxTokens: Math.min(context.maxTokens, context.template.maxTokens), toolChoice: { type: 'none' }, outputSchema: context.template.outputSchema },
  }
}

/** A failed evaluation reports a hook error, with no inference fallback. */
export function evaluatorAnswer(completion: EvaluatorCompletion): HookOutcome {
  if (!completion.isAnswered || typeof completion.text !== 'string') return { result: {}, error: 'The selected provider did not complete the hook evaluation.' }
  try {
    const value = object(JSON.parse(completion.text))
    if (!value || typeof value.ok !== 'boolean' || typeof value.reason !== 'string' || value.impossible !== undefined && typeof value.impossible !== 'boolean'
      || Object.keys(value).some(key => !['ok', 'reason', 'impossible'].includes(key)) || !value.ok && !value.reason.trim()) throw new Error('Invalid verdict')
    return { result: value.ok || value.impossible === true ? {} : { block: value.reason } }
  } catch { return { result: {}, error: 'The selected provider returned an invalid hook evaluation.' } }
}

/** The Stop fields of native command-hook JSON, without leaking other output. */
export function commandHookResult(output: { exitCode: number; stdout: string; stderr: string; failed?: boolean }, onFailure?: unknown): HookOutcome {
  if (output.exitCode === 2) return { result: { block: output.stderr || 'A configured Stop command blocked completion.' } }
  if (output.failed || output.exitCode !== 0) return onFailure === 'block'
    ? { result: { block: 'A configured Stop command did not complete successfully.' }, error: 'A configured Stop command failed.' }
    : { result: {}, error: 'A configured Stop command failed.' }
  const text = output.stdout.trim()
  if (!text.startsWith('{')) return { result: {} }
  try {
    const row = object(JSON.parse(text))
    if (!row) throw new Error('Invalid command result')
    const result: StopHookResult = {}
    if (row.continue === false) result.preventContinuation = true
    if (typeof row.stopReason === 'string') result.stopReason = row.stopReason
    if (row.decision === 'block') {
      if (!nonempty(row.reason)) throw new Error('Missing block reason')
      result.block = row.reason
    }
    const specific = object(row.hookSpecificOutput)
    if (specific && ['Stop', 'SubagentStop'].includes(String(specific.hookEventName)) && typeof specific.additionalContext === 'string') result.additionalContext = [specific.additionalContext]
    return { result }
  } catch { return { result: {}, error: 'A configured Stop command returned invalid JSON.' } }
}

export type EvaluatorPort = {
  context(hook: PlannedEvaluator, event: EvaluatorEvent, owner: EvaluatorOwner): Promise<EvaluatorContext>
  command(hook: PlannedCommand, event: EvaluatorEvent, signal: AbortSignal): Promise<HookOutcome>
  prompt(hook: PlannedEvaluator, request: StepRequest, signal: AbortSignal): Promise<EvaluatorCompletion>
}

/** Native matching hooks run concurrently; aggregate in native type/source order. */
export async function runStopEvaluators(plan: EvaluatorPlan, event: EvaluatorEvent, owner: EvaluatorOwner, port: EvaluatorPort, signal: AbortSignal): Promise<{ result: StopHookResult; errors: string[] }> {
  signal.throwIfAborted()
  if (plan.errors.length) throw new Error('Loaded hooks cannot be replaced without losing configured behavior.')
  if (plan.hooks.some(hook => hook.type === 'agent')) throw new Error('Agent-type evaluators must run through Claude Code.')
  const outcomes = await Promise.all(plan.hooks.map(async hook => {
    signal.throwIfAborted()
    try {
      const outcome = hook.type === 'command' ? await port.command(hook, event, signal)
        : evaluatorAnswer(await port.prompt(hook, evaluatorRequest(hook, event, owner, await port.context(hook, event, owner)), signal))
      signal.throwIfAborted()
      return outcome
    } catch {
      signal.throwIfAborted()
      return { result: {}, error: 'A configured hook did not complete.' }
    }
  }))
  signal.throwIfAborted()
  const result: StopHookResult = {}, errors: string[] = []
  for (const outcome of outcomes) {
    const { additionalContext, ...fields } = outcome.result
    Object.assign(result, fields)
    if (additionalContext?.length) result.additionalContext = [...result.additionalContext ?? [], ...additionalContext]
    if (outcome.error) errors.push(outcome.error)
  }
  return { result, errors }
}
