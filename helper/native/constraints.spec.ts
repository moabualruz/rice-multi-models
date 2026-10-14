import { expect, test } from 'bun:test'
import { parseConfig } from '../../hooks/config.ts'
import { nativeConstraints } from './constraints.ts'

test('native caps, named choice and structured output follow each direct protocol without raising ceilings', () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
  for (const kind of ['openai', 'responses', 'anthropic', 'gemini', 'bedrock'] as const) {
    const config = parseConfig(JSON.stringify({ providers: { owned: { kind, baseUrl: 'https://owned.example', auth: kind === 'bedrock' ? { command: ['/owned-key'] } : 'none', models: { main: { maxOutputTokens: 12 } } } } })).config!
    const model = config.providers.owned.models.main
    const sent = JSON.parse(nativeConstraints(JSON.stringify({ max_tokens: 12, max_completion_tokens: 12, max_output_tokens: 12, generationConfig: { maxOutputTokens: 12, responseSchema: {} }, inferenceConfig: { maxTokens: 12 } }), model,
      { maxTokens: 32, stopSequences: ['STOP'], toolChoice: { type: 'tool', name: 'Check', disable_parallel_tool_use: true }, outputSchema: schema }))
    if (kind === 'openai') {
      expect(sent.max_completion_tokens).toBe(12)
      expect(sent.tool_choice).toEqual({ type: 'function', function: { name: 'Check' } })
      expect(sent.response_format.json_schema.schema).toEqual(schema)
      expect(sent.stop).toBeUndefined()
      expect(sent.parallel_tool_calls).toBe(false)
    } else if (kind === 'responses') {
      expect(sent.max_output_tokens).toBe(12)
      expect(sent.tool_choice).toEqual({ type: 'function', name: 'Check' })
      expect(sent.text.format.schema).toEqual(schema)
    } else if (kind === 'anthropic') {
      expect(sent.max_tokens).toBe(12)
      expect(sent.tool_choice).toMatchObject({ type: 'tool', name: 'Check' })
      expect(sent.output_config.format.schema).toEqual(schema)
    } else if (kind === 'gemini') {
      expect(sent.generationConfig.maxOutputTokens).toBe(12)
      expect(sent.generationConfig.responseSchema).toBeUndefined()
      expect(sent.generationConfig.responseJsonSchema).toEqual(schema)
      expect(sent.toolConfig.functionCallingConfig.allowedFunctionNames).toEqual(['Check'])
    } else {
      expect(sent.inferenceConfig.maxTokens).toBe(12)
      expect(sent.toolConfig.toolChoice).toEqual({ tool: { name: 'Check' } })
      expect(JSON.parse(sent.outputConfig.textFormat.structure.jsonSchema.schema)).toEqual(schema)
    }
  }
})
