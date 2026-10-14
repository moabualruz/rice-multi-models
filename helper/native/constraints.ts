import type { ModelConfig } from '../../hooks/config.ts'
import type { StepRequest } from '../../hooks/protocol.ts'
import { record } from './ownership.ts'

const object = (value: unknown): Record<string, unknown> => record(value) ? value : {}

/** Native caps and output contracts override transport defaults, never the configured ceiling. */
export function nativeConstraints(body: string, model: ModelConfig, native: StepRequest['native']): string {
  if (!native) return body
  const sent: unknown = JSON.parse(body)
  if (!record(sent)) throw new Error('invalid native provider body')
  const cap = (value: unknown) => Math.min(native.maxTokens ?? Infinity, typeof value === 'number' ? value : model.maxOutputTokens ?? Infinity)
  const choice = native.toolChoice
  if (model.kind === 'anthropic') {
    if (native.maxTokens !== undefined) sent.max_tokens = cap(sent.max_tokens)
    if (native.maxTokens === 0) delete sent.thinking
    if (native.stopSequences?.length) sent.stop_sequences = native.stopSequences
    if (choice) sent.tool_choice = choice
    if (native.outputSchema) sent.output_config = { ...object(sent.output_config), format: { type: 'json_schema', schema: native.outputSchema } }
  } else if (model.kind === 'openai' || model.kind === 'responses') {
    const responses = model.kind === 'responses'
    const key = responses ? 'max_output_tokens' : model.maxTokensParam ?? 'max_completion_tokens'
    if (native.maxTokens) sent[key] = cap(sent[key])
    // Reasoning Chat models and Responses have no uniform server stop support.
    // nativeContracts enforces the exact strings without unsupported API fields.
    if (choice) {
      sent.tool_choice = choice.type === 'any' ? 'required' : choice.type === 'tool'
        ? responses ? { type: 'function', name: choice.name } : { type: 'function', function: { name: choice.name } }
        : choice.type
      if (choice.disable_parallel_tool_use) sent.parallel_tool_calls = false
    }
    if (native.outputSchema) {
      const format = { type: 'json_schema', name: 'native_result', schema: native.outputSchema, strict: false }
      if (responses) sent.text = { ...object(sent.text), format }
      else sent.response_format = { type: 'json_schema', json_schema: { name: 'native_result', schema: native.outputSchema, strict: false } }
    }
  } else if (model.kind === 'gemini') {
    const generation = { ...object(sent.generationConfig) }
    if (native.maxTokens) generation.maxOutputTokens = cap(generation.maxOutputTokens)
    if (native.stopSequences?.length) generation.stopSequences = native.stopSequences
    if (native.outputSchema) { delete generation.responseSchema; Object.assign(generation, { responseMimeType: 'application/json', responseJsonSchema: native.outputSchema }) }
    sent.generationConfig = generation
    if (choice) sent.toolConfig = { functionCallingConfig: { mode: choice.type === 'auto' ? 'AUTO' : choice.type === 'none' ? 'NONE' : 'ANY', ...(choice.type === 'tool' ? { allowedFunctionNames: [choice.name] } : {}) } }
  } else if (model.kind === 'bedrock') {
    const inference = { ...object(sent.inferenceConfig) }
    if (native.maxTokens) inference.maxTokens = cap(inference.maxTokens)
    if (native.stopSequences?.length) inference.stopSequences = native.stopSequences
    sent.inferenceConfig = inference
    if (choice && choice.type !== 'none') sent.toolConfig = { ...object(sent.toolConfig), toolChoice: choice.type === 'tool' ? { tool: { name: choice.name } } : { [choice.type]: {} } }
    if (choice?.type === 'none') delete sent.toolConfig
    if (native.outputSchema) sent.outputConfig = { textFormat: { type: 'json_schema', structure: { jsonSchema: { schema: JSON.stringify(native.outputSchema) } } } }
  }
  return JSON.stringify(sent)
}
