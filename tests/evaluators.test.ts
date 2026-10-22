import { expect, test } from 'bun:test'
import { isEvaluatorTemplate } from '../hooks/native-evaluator'
import { commandHookResult, evaluatorAnswer, evaluatorPrompt, evaluatorRequest, planStopEvaluators, runStopEvaluators, type EvaluatorPort, type EvaluatorSource, type PlannedEvaluator } from '../hooks/evaluators'

const event = { hook_event_name: 'Stop' as const, session_id: 'owned-session', last_assistant_message: 'Complete', stop_hook_active: false }
const owner = { target: 'selected/child', who: 'owned-child', session: 'owned-session' }
const prompt: PlannedEvaluator = { type: 'prompt', prompt: 'Verify the condition: $ARGUMENTS', timeoutMs: 30_000, origin: { kind: 'settings' } }
const source = (hooks: unknown[], origin: EvaluatorSource['origin'] = { kind: 'settings' }): EvaluatorSource => ({ origin, settings: { hooks: { Stop: [{ hooks }] } } })
const unused = async (): Promise<never> => { throw new Error('This adapter must not run') }
const context = async () => ({ template: { version: 'owned', event: 'Stop' as const, system: 'OWNED_NATIVE_EVALUATOR_SYSTEM', prefix: 'OWNED_NATIVE_CONDITION_PREFIX ', maxTokens: 10000, outputSchema: { type: 'object' } }, transcript: [{ role: 'user' as const, content: 'OWNED_CHILD_CONTEXT' }, { role: 'assistant' as const, content: 'OWNED_CHILD_REPLY' }], maxTokens: 2048 })

test('planning retains native type order, last duplicate settings value, and separate plugin copies', () => {
  const plan = planStopEvaluators([
    source([{ type: 'prompt', prompt: 'Same condition', timeout: 4 }, { type: 'command', command: 'node', args: ['owned.mjs'] }]),
    source([{ type: 'prompt', prompt: 'Same condition', timeout: 9 }, { type: 'agent', prompt: 'Inspect files' }]),
    source([{ type: 'prompt', prompt: 'Same condition' }], { kind: 'plugin', id: '/owned/plugin' }),
  ], event, 'bash')
  expect(plan.errors).toEqual([])
  expect(plan.hooks.map(hook => hook.type)).toEqual(['command', 'prompt', 'prompt', 'agent'])
  expect(plan.hooks[1]?.timeoutMs).toBe(9000)
  expect(plan.hasEvaluators).toBe(true)
})

test('agent-type evaluators remain native and cannot enter the prompt adapter', async () => {
  const plan = planStopEvaluators([source([{ type: 'agent', prompt: 'Inspect files' }])], event, 'bash')
  expect(plan.hooks.map(hook => hook.type)).toEqual(['agent'])
  await expect(runStopEvaluators(plan, event, owner, { context, command: unused, prompt: unused }, new AbortController().signal)).rejects.toThrow('must run through Claude Code')
})

test('managed matching groups already ran, Stop ignores matcher, and nontool if hooks never run', () => {
  const managed = source([{ type: 'prompt', prompt: 'Managed condition' }], { kind: 'settings', managed: true })
  const same = source([{ type: 'prompt', prompt: 'Managed condition' }])
  const plan = planStopEvaluators([managed, same, { origin: { kind: 'settings' }, settings: { hooks: { Stop: [{ matcher: '[invalid', hooks: [{ type: 'prompt', prompt: 'Active' }, { type: 'prompt', prompt: 'Skipped', if: 'Bash(git *)' }] }] } } }], event, 'bash')
  expect(plan.hooks.map(hook => hook.type === 'command' ? hook.command : hook.prompt)).toEqual(['Active'])
  expect(plan.errors).toEqual([])
  const subagent = { hook_event_name: 'SubagentStop' as const, agent_type: 'Explore' }
  const settings = { hooks: { SubagentStop: [{ matcher: 'Explore|Plan', hooks: [{ type: 'prompt', prompt: 'Matched' }] }, { matcher: 'general-purpose', hooks: [{ type: 'prompt', prompt: 'Other' }] }] } }
  expect(planStopEvaluators([{ origin: { kind: 'settings' }, settings }], subagent, 'bash').hooks).toHaveLength(1)
})

test('an unpreserved hook or invalid matcher prevents any partial replacement', async () => {
  const plan = planStopEvaluators([source([{ type: 'prompt', prompt: 'Condition' }, { type: 'http', url: 'https://owned.invalid' }])], event, 'bash')
  expect(plan.errors).toHaveLength(1)
  const port: EvaluatorPort = { context, command: unused, prompt: unused }
  await expect(runStopEvaluators(plan, event, owner, port, new AbortController().signal)).rejects.toThrow('losing configured behavior')
  const invalid = planStopEvaluators([{ origin: { kind: 'settings' }, settings: { hooks: { SubagentStop: [{ matcher: '[invalid', hooks: [] }] } } }], { hook_event_name: 'SubagentStop' }, 'bash')
  expect(invalid.errors).toHaveLength(1)
})

test('SubagentStop matchers preserve native exact lists and explicit regex behavior', () => {
  const planned = (matcher: string, agent_type: string) => planStopEvaluators([{ origin: { kind: 'settings' }, settings: { hooks: { SubagentStop: [{ matcher, hooks: [{ type: 'prompt', prompt: 'Owned condition' }] }] } } }], { hook_event_name: 'SubagentStop', agent_type }, 'bash').hooks.length
  expect(planned('Explore', 'Explore')).toBe(1)
  expect(planned('Explore', 'OtherExploreX')).toBe(0)
  expect(planned('Explore, Plan | owned-reviewer', 'Plan')).toBe(1)
  expect(planned('Explore, Plan | owned-reviewer', 'owned-reviewer')).toBe(1)
  expect(planned('Explore, Plan | owned-reviewer', 'OtherPlan')).toBe(0)
  expect(planned('^owned:reviewer$', 'owned:reviewer')).toBe(1)
  expect(planned('Explore.*', 'OtherExploreX')).toBe(1)
  expect(planned('*', 'Any agent')).toBe(1)
})

test('the captured native contract includes the owner transcript and complete condition event', async () => {
  const request = evaluatorRequest(prompt, event, owner, await context())
  expect(request.target).toBe(owner.target); expect(request.who).toBe(owner.who); expect(request.session).toBe(owner.session)
  expect(request.tools).toEqual([]); expect(request.native?.toolChoice).toEqual({ type: 'none' })
  expect(request.system).toBe('OWNED_NATIVE_EVALUATOR_SYSTEM')
  expect(request.transcript[0]?.content).toBe('OWNED_CHILD_CONTEXT')
  expect(request.transcript[1]?.content).toBe('OWNED_CHILD_REPLY')
  expect(JSON.stringify(request.transcript.at(-1))).toContain('OWNED_NATIVE_CONDITION_PREFIX ')
  expect(JSON.stringify(request.transcript.at(-1))).toContain('Verify the condition:')
  expect(request.native?.maxTokens).toBe(2048)
  expect(evaluatorPrompt('Verify completion', event)).toBe('Verify completion\n\n' + JSON.stringify(event))
  expect(evaluatorPrompt('$ARGUMENTS / $ARGUMENTS', event)).toBe(JSON.stringify(event) + ' / ' + JSON.stringify(event))
})

test('native evaluator templates reject malformed or wrong-event contracts', async () => {
  const held = await context()
  expect(isEvaluatorTemplate(held.template)).toBe(true)
  expect(isEvaluatorTemplate({ ...held.template, outputSchema: undefined })).toBe(false)
  expect(isEvaluatorTemplate({ ...held.template, maxTokens: Infinity })).toBe(false)
  expect(() => evaluatorRequest(prompt, { hook_event_name: 'SubagentStop' }, owner, held)).toThrow('different native event')
})

test('prompt evaluator results preserve native impossible and block behavior', () => {
  expect(evaluatorAnswer({ isAnswered: true, text: '{"ok":false,"reason":"Run the checks","impossible":true}' }).result).toEqual({})
  expect(evaluatorAnswer({ isAnswered: true, text: '{"ok":false,"reason":"Run the checks"}' }).result).toEqual({ block: 'Run the checks' })
  expect(evaluatorAnswer({ isAnswered: true, text: '{"ok":true,"reason":"Verified"}' }).result).toEqual({})
})

test('unusable evaluator output produces native-style nonblocking error without leaking provider bytes', () => {
  for (const completion of [{ isAnswered: false, text: 'private-owned-text' }, { isAnswered: true, text: 'private-owned-text' }, { isAnswered: true, text: '{"ok":false,"reason":""}' }, { isAnswered: true, text: '{"ok":"true","reason":"wrong"}' }]) {
    const result = evaluatorAnswer(completion)
    expect(result.result).toEqual({}); expect(result.error).toBeString(); expect(JSON.stringify(result)).not.toContain('private-owned-text')
  }
})

test('command results preserve native Stop control, failure policy, and context', () => {
  expect(commandHookResult({ exitCode: 2, stdout: 'ignored', stderr: 'Tests failed' }).result).toEqual({ block: 'Tests failed' })
  expect(commandHookResult({ exitCode: 1, stdout: '', stderr: 'private-owned-error' }).result).toEqual({})
  expect(commandHookResult({ exitCode: 1, stdout: '', stderr: 'private-owned-error' }, 'block').result.block).toBeString()
  expect(commandHookResult({ exitCode: 0, stdout: JSON.stringify({ continue: false, stopReason: 'Owner ended this run', decision: 'block', reason: 'Checks pending', hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'Retain approval' } }), stderr: '' }).result)
    .toEqual({ preventContinuation: true, stopReason: 'Owner ended this run', block: 'Checks pending', additionalContext: ['Retain approval'] })
  expect(commandHookResult({ exitCode: 0, stdout: 'Ordinary output', stderr: '' }).result).toEqual({})
})

test('matching command and prompt hooks start in parallel and aggregate in native order', async () => {
  const started: string[] = [], targets: string[] = []
  let release: (() => void) | undefined
  const waiting = new Promise<void>(resolve => { release = resolve })
  const plan = planStopEvaluators([source([{ type: 'prompt', prompt: 'Check condition' }, { type: 'command', command: 'owned' }])], event, 'bash')
  const running = runStopEvaluators(plan, event, owner, {
    context,
    command: async () => { started.push('command'); await waiting; return { result: { additionalContext: ['Command context'] } } },
    prompt: async (_hook, request) => { started.push('prompt'); targets.push(request.target); return { isAnswered: true, text: '{"ok":false,"reason":"Prompt feedback"}' } },
  }, new AbortController().signal)
  await Promise.resolve()
  expect(started).toEqual(['command', 'prompt'])
  release?.()
  expect(await running).toEqual({ result: { additionalContext: ['Command context'], block: 'Prompt feedback' }, errors: [] })
  expect(targets).toEqual([owner.target])
})

test('cancellation remains cancellation instead of becoming an allow or a native retry', async () => {
  const controller = new AbortController()
  const plan = planStopEvaluators([source([{ type: 'prompt', prompt: 'Condition' }])], event, 'bash')
  const running = runStopEvaluators(plan, event, owner, { context, command: unused, prompt: async () => { controller.abort(); return { isAnswered: true, text: '{"ok":true,"reason":"ignored"}' } } }, controller.signal)
  await expect(running).rejects.toThrow()
})
