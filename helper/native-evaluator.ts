import { EVALUATOR_MARK, isEvaluatorTemplate, type EvaluatorTemplate } from '../hooks/native-evaluator.ts'
import { runNative, textOf } from './native-run.ts'

export async function captureEvaluator(event: 'Stop' | 'SubagentStop', signal?: AbortSignal): Promise<EvaluatorTemplate> {
  let spawned = false
  const run = await runNative({
    label: 'evaluator-contract', script: ['OWNED_NATIVE_EVALUATOR_MAIN'], signal,
    files: { 'settings.json': JSON.stringify({ hooks: { [event]: [{ hooks: [{ type: 'prompt', prompt: EVALUATOR_MARK + ' $ARGUMENTS', timeout: 15 }] }] } }) },
    answer: request => {
      const messages = request.messages as { content?: unknown }[] | undefined
      const last = textOf(messages?.at(-1)?.content)
      if (last.includes(EVALUATOR_MARK)) return { text: '{"ok":true,"reason":"owned capture evidence"}' }
      if (event === 'SubagentStop' && !spawned && JSON.stringify(messages).includes('OWNED_NATIVE_EVALUATOR_MAIN')) {
        spawned = true
        return { toolUses: [{ id: 'toolu_owned_evaluator_child', name: 'Agent', input: { subagent_type: 'general-purpose', description: 'Owned evaluator capture', prompt: 'OWNED_NATIVE_EVALUATOR_CHILD', run_in_background: false } }] }
      }
      return { text: 'OWNED_NATIVE_EVALUATOR_DONE' }
    },
  })
  const requests = run.requests.filter(request => Array.isArray(request.messages) && textOf(request.messages.at(-1)?.content).includes(EVALUATOR_MARK))
  if (requests.length !== 1) throw new Error('The installed host did not expose one native evaluator contract.')
  const request = requests[0]!
  const systems = request.system as { text?: string }[] | undefined
  const system = systems?.map(block => block.text ?? '').find(text => text.includes('You are evaluating a stop-condition hook'))
  const prompt = textOf((request.messages as { content?: unknown }[]).at(-1)?.content)
  const prefix = prompt.split(EVALUATOR_MARK)[0]
  const output = request.output_config as { format?: { schema?: Record<string, unknown> } } | undefined
  const template = { version: run.version, event, system, prefix, maxTokens: Number(request.max_tokens), outputSchema: output?.format?.schema }
  if (!isEvaluatorTemplate(template)) throw new Error('The installed evaluator contract has an unsupported shape.')
  return template
}
