// Agent CLIs as workers: Antigravity (`agy`) and Grok (`grok`) run their own loop and their own tools. A routed
// step starts one run of the CLI with the newest user turn (or resumes the conversation's run) and answers
// with its final response; the CLI's narration, reasoning and actions stream as thinking meanwhile. A
// read-only run uses the CLI's plan mode; a writing run lets it edit files (accept-edits). Neither skips the
// CLI's own permission checks.
//
// The event grammars and argument shapes follow greenpolo/cc-multi-cli-plugin at 3dcb057 (Apache-2.0; see
// LICENSES/cc-multi-cli-plugin.Apache-2.0.txt): plugins/multi-antigravity/src/cli.ts and
// plugins/multi-grok/src/cli.ts, reimplemented here for a stdio helper.
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'

import type { ApiMessage, StepEvent, StepRequest } from '../hooks/protocol.ts'
import { resolveExecutable } from './core/executable.ts'
import { startProcess } from './core/subprocess.ts'

export type Worker = 'agy' | 'grok'

export type HarnessEvent =
  | { kind: 'session'; id: string }
  | { kind: 'progress'; text: string }
  | { kind: 'answer'; text: string }
  | { kind: 'usage'; in: number; out: number; cacheRead: number; cacheWrite: number; reasoning?: number }
  | { kind: 'done'; ok: boolean; error?: string }

type Json = Record<string, unknown>
const isJson = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** A tool's input in one short line: its first few values, cut. */
export function summarize(input: unknown): string {
  if (!isJson(input)) return ''
  const values = Object.values(input)
    .filter(value => typeof value === 'string' || typeof value === 'number')
    .map(value => String(value).replace(/\s+/g, ' '))

  return values.join(' ').slice(0, 160)
}

/** What one Antigravity stream-json line says. */
export function agyEvents(line: unknown): HarnessEvent[] {
  if (!isJson(line)) return []
  if (line.event === 'init' && typeof line.conversation_id === 'string') return [{ kind: 'session', id: line.conversation_id }]
  if (line.event === 'step_update' && isJson(line.step_update)) {
    const step = line.step_update
    if (step.step_type === 'tool' && step.state === 'ACTIVE') {
      const info = isJson(step.tool_info) ? step.tool_info : {}
      const name = typeof step.tool_name === 'string' ? step.tool_name : 'tool'

      return [{ kind: 'progress', text: `\n▸ ${name} ${summarize(info.parameters)}\n` }]
    }
    if (step.step_type === 'agent_response' && typeof step.text_delta === 'string' && step.text_delta !== '') return [{ kind: 'progress', text: step.text_delta }]

    return []
  }
  if (line.event === 'result' && isJson(line.result)) {
    const result = line.result
    const usage = isJson(result.usage) ? result.usage : {}
    const read = num(usage.cache_read_tokens)
    const events: HarnessEvent[] = []
    if (typeof result.conversation_id === 'string') events.push({ kind: 'session', id: result.conversation_id })
    if (typeof result.response === 'string' && result.response.trim() !== '') events.push({ kind: 'answer', text: result.response.trim() })
    events.push({ kind: 'usage', in: Math.max(0, num(usage.input_tokens) - read), out: num(usage.output_tokens), cacheRead: read, cacheWrite: 0, reasoning: num(usage.thinking_tokens) })
    const ok = result.status === 'SUCCESS'
    events.push(ok ? { kind: 'done', ok } : { kind: 'done', ok, error: `Antigravity ended with ${String(result.status)}` })

    return events
  }

  return []
}

/** What one Grok streaming-json line says. Text before a tool call is narration; text after the last one is the answer. */
export function grokParser(): { feed: (line: unknown) => HarnessEvent[]; end: () => HarnessEvent[] } {
  let text = ''

  return {
    feed(line) {
      if (!isJson(line)) return []
      if (line.type === 'thought' && typeof line.data === 'string') return [{ kind: 'progress', text: line.data }]
      if (line.type === 'text' && typeof line.data === 'string') {
        text += line.data

        return []
      }
      if (line.type === 'tool_call') {
        const said = text
        text = ''
        const name = typeof line.toolName === 'string' ? line.toolName : typeof line.title === 'string' ? line.title : 'tool'

        return [...(said.trim() ? [{ kind: 'progress' as const, text: `${said}\n` }] : []), { kind: 'progress', text: `\n▸ ${name} ${summarize(line.rawInput)}\n` }]
      }
      if (line.type === 'end') {
        const usage = isJson(line.usage) ? line.usage : {}
        const events: HarnessEvent[] = []
        if (typeof line.sessionId === 'string') events.push({ kind: 'session', id: line.sessionId })
        if (text.trim() !== '') events.push({ kind: 'answer', text: text.trim() })
        text = ''
        events.push({ kind: 'usage', in: num(usage.input_tokens), out: num(usage.output_tokens), cacheRead: num(usage.cache_read_input_tokens), cacheWrite: num(usage.cache_creation_input_tokens), reasoning: num(usage.reasoning_tokens) })
        const ok = line.stopReason === 'end_turn' || line.stopReason === 'max_tokens'
        events.push(ok ? { kind: 'done', ok } : { kind: 'done', ok, error: `Grok stopped: ${String(line.stopReason)}` })

        return events
      }

      return []
    },
    end: () => [],
  }
}

const textOf = (message: ApiMessage): string =>
  typeof message.content === 'string'
    ? message.content
    : message.content
        .filter(block => block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text as string)
        .filter(text => !text.trimStart().startsWith('<system-reminder>'))
        .join('\n\n')

/**
 * What the CLI is asked: on a resumed run, the user turns after the last answer; on a new one, every user turn,
 * with the agent's own instructions first when it has any.
 */
export function promptFor(req: StepRequest): string {
  const lastAnswer = req.resume ? req.transcript.findLastIndex(message => message.role === 'assistant') : -1
  const turns = req.transcript.slice(lastAnswer + 1).filter(message => message.role === 'user').map(textOf).filter(text => text.trim() !== '')
  const task = turns.join('\n\n')

  return !req.resume && req.system.trim() !== '' ? `${req.system.trim()}\n\n# Task\n\n${task}` : task
}

const EFFORT_AGY: Record<string, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' }

export function agyArgs(req: StepRequest, model: string, prompt: string): string[] {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--disable-slash-commands', '--model', model, '--add-dir', req.cwd ?? process.cwd()]
  if (typeof req.effort === 'string' && EFFORT_AGY[req.effort]) args.push('--effort', EFFORT_AGY[req.effort] as string)
  if (req.resume) args.push('--conversation', req.resume)
  else args.push('--new-project')
  args.push('--mode', req.workerWrite ? 'accept-edits' : 'plan')

  return args
}

export function grokArgs(req: StepRequest, model: string, prompt: string): string[] {
  const args = ['-p', prompt, '--output-format', 'streaming-json', '--no-auto-update', '--model', model, '--permission-mode', req.workerWrite ? 'acceptEdits' : 'plan', '--cwd', req.cwd ?? process.cwd()]
  if (typeof req.effort === 'string') args.push('--reasoning-effort', req.effort === 'max' || req.effort === 'xhigh' ? 'high' : req.effort)
  args.push(...(req.resume ? ['--resume', req.resume] : ['--session-id', randomUUID()]))

  return args
}

function binary(worker: Worker): string {
  try {
    return resolveExecutable(worker)
  } catch {
    return `${homedir()}/.local/bin/${worker}`
  }
}

/** One worker run as step events: progress as thinking, the final response as text, then usage and the stop. */
export async function* harnessStep(req: StepRequest, worker: Worker, model: string, signal: AbortSignal): AsyncGenerator<StepEvent> {
  const started = Date.now()
  const prompt = promptFor(req)
  if (prompt.trim() === '') {
    yield { type: 'error', kind: 'request', text: `rice-multi-models: nothing to send ${worker}: the conversation has no user text` }
    yield { type: 'stats', ttfbMs: null, totalMs: 0, transport: worker }

    return
  }
  const argv = [binary(worker), ...(worker === 'agy' ? agyArgs(req, model, prompt) : grokArgs(req, model, prompt))]
  signal.throwIfAborted()
  const running = startProcess(argv, req.cwd ?? process.cwd())
  const child = running.child
  const kill = running.stop
  signal.addEventListener('abort', kill, { once: true })
  if (signal.aborted) kill()
  const grok = grokParser()
  let ttfb: number | null = null
  let answer = ''
  let done: HarnessEvent | undefined
  const decoder = new TextDecoder()
  let buffer = ''
  const handle = function* (events: HarnessEvent[]): Generator<StepEvent> {
    for (const event of events) {
      ttfb ??= Date.now() - started
      if (event.kind === 'session') yield { type: 'resume', key: event.id }
      else if (event.kind === 'progress') yield { type: 'thinking', text: event.text }
      else if (event.kind === 'answer') answer = event.text
      else if (event.kind === 'usage') yield { type: 'usage', in: event.in, out: event.out, cacheRead: event.cacheRead, cacheWrite: event.cacheWrite, ...(event.reasoning ? { reasoning: event.reasoning } : {}) }
      else done = event
    }
  }
  try {
    for await (const chunk of child.stdout as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (line === '') continue
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          continue
        }
        yield* handle(worker === 'agy' ? agyEvents(parsed) : grok.feed(parsed))
      }
    }
    yield* handle(worker === 'grok' ? grok.end() : [])
    const code = await running.exited
    const stderr = running.stderr()
    if (signal.aborted) {
      yield { type: 'error', kind: 'request', text: `rice-multi-models: ${worker} was stopped` }
    } else if (done?.kind === 'done' && done.ok) {
      if (answer) yield { type: 'text', text: answer }
      yield { type: 'stop', reason: 'end_turn' }
    } else {
      const why = done?.kind === 'done' && done.error ? done.error : `${worker} exited ${code}${stderr ? `: ${stderr}` : ''}`
      if (answer) yield { type: 'text', text: answer }
      yield { type: 'error', kind: 'response', text: `rice-multi-models: ${why}${/auth|log ?in|sign ?in/i.test(stderr) ? ` (run ${worker} login)` : ''}` }
    }
  } finally {
    signal.removeEventListener('abort', kill)
    if (child.exitCode === null) kill()
    await running.exited.catch(() => {})
  }
  yield { type: 'stats', ttfbMs: ttfb, totalMs: Date.now() - started, transport: worker }
}
