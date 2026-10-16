import { expect, test } from 'bun:test'
import { commandHookResult, evaluatorAnswer, evaluatorPrompt, evaluatorRequest, evaluatorTools, planStopEvaluators, runStopEvaluators, type EvaluatorPort, type EvaluatorSource, type PlannedEvaluator } from '../hooks/evaluators'

const event = { hook_event_name: 'Stop' as const, session_id: 'owned-session', last_assistant_message: 'Complete', stop_hook_active: false }
const owner = { target: 'selected/child', who: 'owned-child', session: 'owned-session' }
const prompt: PlannedEvaluator = { type: 'prompt', prompt: 'Verify the condition: $ARGUMENTS', timeoutMs: 30_000, origin: { kind: 'settings' } }
const source = (hooks: unknown[], origin: EvaluatorSource['origin'] = { kind: 'settings' }): EvaluatorSource => ({ origin, settings: { hooks: { Stop: [{ hooks }] } } })
const unused = async (): Promise<never> => { throw new Error('This adapter must not run') }

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
  const port: EvaluatorPort = { command: unused, prompt: unused, agent: unused }
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

test('the configured prompt and complete event bind the explicit child without parent context', () => {
  const request = evaluatorRequest(prompt, event, owner)
  expect(request.target).toBe(owner.target); expect(request.who).toBe(owner.who); expect(request.session).toBe(owner.session)
  expect(request.tools).toEqual([]); expect(request.native?.toolChoice).toEqual({ type: 'none' })
  expect(request.transcript[0]?.content).toBe(evaluatorPrompt(prompt.prompt, event))
  expect(evaluatorPrompt('Verify completion', event)).toBe('Verify completion\n\n' + JSON.stringify(event))
  expect(evaluatorPrompt('$ARGUMENTS / $ARGUMENTS', event)).toBe(JSON.stringify(event) + ' / ' + JSON.stringify(event))
})

test('the verifier retains native tool capabilities and excludes the actual native control pool', () => {
  expect(evaluatorTools(['Read', 'Bash', 'Edit', 'Write', 'Grep', 'Glob', 'mcp__owned__test', 'TaskStop', 'Agent', 'Task', 'Poll', 'ExitPlanMode', 'EnterPlanMode', 'StructuredOutput', 'AskUserQuestion', 'Workflow', 'memory_write', 'ConnectGitHub', 'PublishPlugin', 'EndConversation', 'AppifactRepl']))
    .toEqual(['Read', 'Bash', 'Edit', 'Write', 'Grep', 'Glob', 'mcp__owned__test', 'TaskStop'])
})

test('Stop prompt impossible allows stopping, while agent and ordinary false verdicts continue work', () => {
  const failed = { isAnswered: true, text: '{"ok":false,"reason":"Run the checks","impossible":true}' }
  expect(evaluatorAnswer('prompt', failed).result).toEqual({})
  expect(evaluatorAnswer('agent', failed).result).toEqual({ block: 'Run the checks' })
  expect(evaluatorAnswer('prompt', { isAnswered: true, text: '{"ok":false,"reason":"Run the checks"}' }).result).toEqual({ block: 'Run the checks' })
  expect(evaluatorAnswer('prompt', { isAnswered: true, text: '{"ok":true,"reason":"Verified"}' }).result).toEqual({})
})

test('unusable evaluator output produces native-style nonblocking error without leaking provider bytes', () => {
  for (const completion of [{ isAnswered: false, text: 'private-owned-text' }, { isAnswered: true, text: 'private-owned-text' }, { isAnswered: true, text: '{"ok":false,"reason":""}' }, { isAnswered: true, text: '{"ok":"true","reason":"wrong"}' }]) {
    const result = evaluatorAnswer('prompt', completion)
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

test('matching hooks start in parallel, retain indexed aggregation and route the owner into both evaluators', async () => {
  const started: string[] = [], targets: string[] = []
  let release: (() => void) | undefined
  const waiting = new Promise<void>(resolve => { release = resolve })
  const plan = planStopEvaluators([source([{ type: 'agent', prompt: 'Inspect files' }, { type: 'prompt', prompt: 'Check condition' }, { type: 'command', command: 'owned' }])], event, 'bash')
  const running = runStopEvaluators(plan, event, owner, {
    command: async () => { started.push('command'); await waiting; return { result: { additionalContext: ['Command context'] } } },
    prompt: async (_hook, request) => { started.push('prompt'); targets.push(request.target); return { isAnswered: true, text: '{"ok":false,"reason":"Prompt feedback"}' } },
    agent: async (_hook, _event, actual) => { started.push('agent'); targets.push(actual.target); return { isAnswered: true, text: '{"ok":false,"reason":"Agent feedback"}' } },
  }, new AbortController().signal)
  expect(started).toEqual(['command', 'prompt', 'agent'])
  release?.()
  expect(await running).toEqual({ result: { additionalContext: ['Command context'], block: 'Agent feedback' }, errors: [] })
  expect(targets).toEqual([owner.target, owner.target])
})

test('cancellation remains cancellation instead of becoming an allow or a native retry', async () => {
  const controller = new AbortController()
  const plan = planStopEvaluators([source([{ type: 'prompt', prompt: 'Condition' }])], event, 'bash')
  const running = runStopEvaluators(plan, event, owner, { command: unused, agent: unused, prompt: async () => { controller.abort(); return { isAnswered: true, text: '{"ok":true,"reason":"ignored"}' } } }, controller.signal)
  await expect(running).rejects.toThrow()
})
