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

/** Native Messages can evolve tool availability inside positional system messages. */
function nativeTools(initial: unknown) {
  const definitions = new Map<string, Record<string, unknown>>()
  const active = new Map<string, Record<string, unknown> | undefined>()
  function definition(value: unknown): Record<string, unknown> {
    if (!record(value) || !string(value.name) || !value.name) throw new Error('invalid native tool')
    if ((!string(value.type) || value.type === 'custom') && !record(value.input_schema)) throw new Error('invalid native tool schema')
    return value
  }
  if (initial !== undefined) {
    if (!Array.isArray(initial)) throw new Error('invalid native tools')
    for (const value of initial) {
      const tool = definition(value)
      definitions.set(tool.name as string, tool)
      active.set(tool.name as string, tool)
    }
  }
  function system(value: unknown): string {
    if (value === undefined) return ''
    if (string(value)) return value
    if (!Array.isArray(value)) throw new Error('unsupported native system blocks')
    return value.map(block => {
      if (!record(block)) throw new Error('unsupported native system blocks')
      if (block.type === 'text' && string(block.text)) return block.text
      if (!['tool_addition', 'tool_removal'].includes(String(block.type)) || !record(block.tool)) throw new Error('unsupported native system blocks')
      const update = block.tool
      if (block.type === 'tool_removal') {
        if (update.type !== 'tool_reference' || !string(update.name) || !update.name) throw new Error('invalid native tool removal')
        active.delete(update.name)
        return `Tool removed: ${JSON.stringify(update.name)}`
      }
      let name: string, tool: Record<string, unknown> | undefined
      if (update.type === 'tool_definition') {
        tool = definition(update.definition)
        name = tool.name as string
        definitions.set(name, tool)
      } else if (update.type === 'tool_reference' && string(update.name) && update.name) {
        name = update.name
        tool = definitions.get(name)
      } else throw new Error('invalid native tool addition')
      active.set(name, tool)
      return `Tool made available: ${JSON.stringify(name)}`
    }).join('\n\n')
  }
  return { system, current: () => [...active.values()].map(tool => {
    // A historical reference can be removed later without its schema being sent.
    // Only tools still callable at this request boundary need a definition.
    if (!tool) throw new Error('native tool addition has no verified definition')
    return tool
  }) }
}

/** Translate the authentic host request; ownership is independent of its auxiliary model alias. */
export function nativeRequest(body: unknown, owner: NativeOwner): NativeRequest {
  if (owner.unowned || !owner.model) throw new Error('native inference has no verified conversation owner')
  if (!record(body) || !string(body.model) || !Array.isArray(body.messages) || !body.messages.length) throw new Error('invalid native Messages request')
  const available = nativeTools(body.tools)
  const system = available.system(body.system)
  const transcript: ApiMessage[] = body.messages.map(message => {
    if (!record(message) || !['user', 'assistant', 'system', 'developer'].includes(String(message.role)) || !(string(message.content) || Array.isArray(message.content) && message.content.every(block => record(block) && string(block.type)))) throw new Error('invalid native transcript')
    if (message.role === 'system' || message.role === 'developer') {
      // Native compaction keeps positional system reminders in its transcript. Messages
      // providers have two transcript roles, so preserve that position and instruction text.
      return { role: 'user', content: `<system-reminder>\n${available.system(message.content)}\n</system-reminder>` }
    }
    return { role: message.role as ApiMessage['role'], content: message.content as ApiMessage['content'] }
  })
  const tools: RemoteTool[] = [], serverTools: Record<string, unknown>[] = []
  for (const tool of available.current()) {
    if (string(tool.type) && tool.type.startsWith('tool_search_tool_') && tool.name === 'ToolSearch') {
      // Claude Code also exposes ToolSearch as a local tool. Route it as a
      // function call so the host loads deferred tools, without provider inference.
      tools.push({ name: 'ToolSearch', description: 'Find deferred tools by query before calling them.', schema: { type: 'object', properties: { query: { type: 'string' }, max_results: { type: 'number' } }, required: ['query'] } })
      continue
    }
    if (string(tool.type) && tool.type !== 'custom') { serverTools.push(tool); continue }
    if (!record(tool.input_schema)) throw new Error('invalid native tool schema')
    tools.push({ name: tool.name as string, description: string(tool.description) ? tool.description : '', schema: tool.input_schema, ...(tool.defer_loading === true ? { deferred: true } : {}) })
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
      target: owner.model, system, transcript, tools,
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
