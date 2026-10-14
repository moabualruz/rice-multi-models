import type { ApiMessage, Effort, RemoteTool, StepRequest } from '../../hooks/protocol.ts'
import type { NativeOwner } from './ownership.ts'
import { record } from './ownership.ts'

export type NativeRequest = {
  model: string
  stream: boolean
  req: StepRequest
  serverTools: Record<string, unknown>[]
}

const string = (value: unknown): value is string => typeof value === 'string'

function system(value: unknown): string {
  if (value === undefined) return ''
  if (string(value)) return value
  if (Array.isArray(value) && value.every(block => record(block) && block.type === 'text' && string(block.text))) return value.map(block => block.text).join('\n\n')
  throw new Error('unsupported native system blocks')
}

/** Translate the authentic host request; ownership is independent of its auxiliary model alias. */
export function nativeRequest(body: unknown, owner: NativeOwner): NativeRequest {
  if (owner.unowned || !owner.model) throw new Error('native inference has no verified conversation owner')
  if (!record(body) || !string(body.model) || !Array.isArray(body.messages) || !body.messages.length) throw new Error('invalid native Messages request')
  const transcript: ApiMessage[] = body.messages.map(message => {
    if (!record(message) || !['user', 'assistant', 'system', 'developer'].includes(String(message.role)) || !(string(message.content) || Array.isArray(message.content) && message.content.every(block => record(block) && string(block.type)))) throw new Error('invalid native transcript')
    if (message.role === 'system' || message.role === 'developer') {
      // Native compaction keeps positional system reminders in its transcript. Messages
      // providers have two transcript roles, so preserve that position and instruction text.
      return { role: 'user', content: `<system-reminder>\n${system(message.content)}\n</system-reminder>` }
    }
    return { role: message.role as ApiMessage['role'], content: message.content as ApiMessage['content'] }
  })
  const tools: RemoteTool[] = [], serverTools: Record<string, unknown>[] = []
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) throw new Error('invalid native tools')
    for (const tool of body.tools) {
      if (!record(tool) || !string(tool.name)) throw new Error('invalid native tool')
      if (string(tool.type) && tool.type.startsWith('tool_search_tool_') && tool.name === 'ToolSearch') {
        // Claude Code also exposes ToolSearch as a local tool. Route it as a
        // function call so the host loads deferred tools, without provider inference.
        tools.push({ name: 'ToolSearch', description: 'Find deferred tools by query before calling them.', schema: { type: 'object', properties: { query: { type: 'string' }, max_results: { type: 'number' } }, required: ['query'] } })
        continue
      }
      if (string(tool.type) && tool.type !== 'custom') { serverTools.push(tool); continue }
      if (!record(tool.input_schema)) throw new Error('invalid native tool schema')
      tools.push({ name: tool.name, description: string(tool.description) ? tool.description : '', schema: tool.input_schema, ...(tool.defer_loading === true ? { deferred: true } : {}) })
    }
  }
  if (body.max_tokens !== undefined && (!Number.isSafeInteger(body.max_tokens) || Number(body.max_tokens) < 0)) throw new Error('invalid native output cap')
  const config = record(body.output_config) ? body.output_config : undefined
  const effort = config && ['low', 'medium', 'high', 'xhigh', 'max'].includes(String(config.effort)) ? config.effort as Effort : undefined
  const choice = record(body.tool_choice) ? body.tool_choice : undefined
  if (choice && (!['auto', 'any', 'none', 'tool'].includes(String(choice.type)) || choice.type === 'tool' && (!string(choice.name) || ![...tools, ...serverTools].some(tool => tool.name === choice.name))
    || choice.disable_parallel_tool_use !== undefined && typeof choice.disable_parallel_tool_use !== 'boolean')) throw new Error('invalid native tool choice')
  const stops = body.stop_sequences
  if (stops !== undefined && (!Array.isArray(stops) || !stops.every(stop => string(stop) && stop.length > 0 && stop.length <= 8192))) throw new Error('invalid native stop sequences')
  const format = config?.format ?? body.output_format
  if (format !== undefined && (!record(format) || format.type !== 'json_schema' || !record(format.schema))) throw new Error('unsupported native output format')
  return {
    model: body.model, stream: body.stream === true, serverTools,
    req: {
      target: owner.model, system: system(body.system), transcript, tools,
      who: owner.agentId ?? 'main', session: owner.sessionId ?? 'native', transport: 'sse',
      ...(effort ? { effort } : {}),
      native: {
        ...(typeof body.max_tokens === 'number' ? { maxTokens: body.max_tokens } : {}),
        ...(choice ? { toolChoice: choice as NonNullable<StepRequest['native']>['toolChoice'] } : {}),
        ...(Array.isArray(stops) ? { stopSequences: stops as string[] } : {}),
        ...(record(format) && record(format.schema) ? { outputSchema: format.schema } : {}),
      },
    },
  }
}
