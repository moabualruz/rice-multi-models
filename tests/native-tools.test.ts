import { expect, test } from 'bun:test'
import { toolFilter } from '../hooks/agents'
import { agentPrompt, BODY_MARK, builtinPrompt, deriveCapture, isCapture, MARKER_AGENT, offeredTools, spawnOf, spawnTask, toolSetKey, toolTable } from '../hooks/native-tools'
import type { ToolsCapture } from '../hooks/native-tools'
import { remoteTools } from '../hooks/tools'

// The engine's requests are stood in for by owned fixtures with the same structure: a header block, an identity
// preamble block, then one block with the agent's own prompt between a head and a tail.
const HEAD = 'OWNED HEAD\n'
const TAIL = '\n\nOWNED NOTES FOR EVERY SUBAGENT'
const tool = (name: string) => ({ name, description: `OWNED ${name} DESCRIPTION, LONGER THAN ANY LIST SUMMARY`, input_schema: { type: 'object', properties: { [`${name}_input`]: { type: 'integer', minimum: 1 } }, required: [`${name}_input`] } })
const request = (tools: string[], prompt: string) => ({ system: [{ type: 'text', text: 'owned-header' }, { type: 'text', text: 'OWNED IDENTITY PREAMBLE' }, { type: 'text', text: HEAD + prompt + TAIL }], tools: tools.map(tool) })
const both = (type: string, prompt: string, foreground: string[], background = foreground) => [
  { type, background: false, body: request(foreground, prompt) },
  { type, background: true, body: request(background, prompt) },
]
const capture: ToolsCapture = {
  version: '9.9.9',
  listed: ['general-purpose', 'Explore', 'statusline-setup', 'never-started'],
  main: { system: [{ type: 'text', text: 'main' }], tools: ['Agent', 'Bash', 'Edit', 'ListAgents', 'Read'].map(tool) },
  spawned: [
    ...both(MARKER_AGENT, BODY_MARK, ['Agent', 'Bash', 'Edit', 'ListAgents', 'Read'], ['Agent', 'Bash', 'Edit', 'Read']),
    ...both('general-purpose', 'OWNED GENERAL PROMPT', ['Agent', 'Bash', 'Edit', 'ListAgents', 'Read'], ['Agent', 'Bash', 'Edit', 'Read']),
    ...both('Explore', 'OWNED EXPLORE PROMPT', ['Bash', 'ListAgents', 'Read'], ['Bash', 'Read']),
    ...both('statusline-setup', 'OWNED STATUS LINE PROMPT', ['Read', 'Edit']),
  ],
}

test('a capture gives each built-in agent type its own prompt, rendered back exactly as the engine sent it', () => {
  const derived = deriveCapture(capture)
  expect(isCapture(derived)).toBe(true)
  expect(derived.version).toBe('9.9.9')
  expect(derived.agentHead).toBe(HEAD)
  expect(derived.agentTail).toBe(TAIL)
  expect(Object.keys(derived.prompts).sort()).toEqual(['Explore', 'general-purpose', 'statusline-setup'])
  for (const spawned of capture.spawned.filter(each => each.type !== MARKER_AGENT)) {
    // Byte for byte the agent's last system block; the engine's identity preamble is not part of it.
    expect(agentPrompt(derived, builtinPrompt(derived, spawned.type)!)).toBe((spawned.body as ReturnType<typeof request>).system.at(-1)!.text)
  }
  expect(builtinPrompt(derived, 'never-started')).toBeUndefined()
  expect(builtinPrompt(derived, 'constructor')).toBeUndefined()
  // An agent file's body goes in the same place.
  expect(agentPrompt(derived, 'A custom agent body')).toBe(`${HEAD}A custom agent body${TAIL}`)
})

test('the tools are kept as the engine sent them, in its order', () => {
  const derived = deriveCapture(capture)
  expect(derived.tools).toEqual(['Agent', 'Bash', 'Edit', 'ListAgents', 'Read'].map(tool))
  expect(toolTable(derived).get('Read')).toEqual(tool('Read'))
})

test('the tools offered follow the agent type and whether it runs in the background', () => {
  const derived = deriveCapture(capture)
  expect([...offeredTools(derived, 'Explore', false)!.offered]).toEqual(['Bash', 'ListAgents', 'Read'])
  expect([...offeredTools(derived, 'Explore', true)!.offered]).toEqual(['Bash', 'Read'])
  expect([...offeredTools(derived, undefined, true)!.offered]).toEqual(['Agent', 'Bash', 'Edit', 'Read'])
  expect(offeredTools(derived, 'never-started', true)).toBeUndefined()
  const session = ['Agent', 'Bash', 'Edit', 'ListAgents', 'Read', 'Workflow', 'AskUserQuestion', 'mcp__server__lookup']
  // A tool the capture saw is offered when the engine offers it; any other follows the static rules.
  expect(session.filter(toolFilter('Explore', undefined, offeredTools(derived, 'Explore', true)))).toEqual(['Bash', 'Read', 'Workflow', 'mcp__server__lookup'])
  expect(session.filter(toolFilter('Explore', undefined, offeredTools(derived, 'Explore', false)))).toEqual(['Bash', 'ListAgents', 'Read', 'Workflow', 'mcp__server__lookup'])
  // A custom definition still decides, within what the engine gives an agent defined by a file.
  expect(session.filter(toolFilter('reviewer', { prompt: 'p', tools: ['Read', 'ListAgents', 'mcp__server__lookup'] }, offeredTools(derived, undefined, true)))).toEqual(['Read', 'mcp__server__lookup'])
  // Without a capture the static rules stay as they were.
  expect(session.filter(toolFilter('Explore', undefined))).toEqual(['Bash', 'ListAgents', 'Read', 'Workflow', 'mcp__server__lookup'])
})

test('routed tools carry the captured definitions; MCP tools and tools the capture did not show keep their fallbacks', () => {
  const derived = deriveCapture(capture)
  const infos = [
    { name: 'Read', description: 'Read a f', mcp: false },
    { name: 'AskUserQuestion', description: 'Ask the', mcp: false },
    { name: 'mcp__server__lookup', description: 'Lookup', mcp: true },
  ]
  const [read, ask, mcp] = remoteTools(infos, new Map(), () => true, {}, toolTable(derived))
  expect(read).toEqual({ name: 'Read', description: tool('Read').description, schema: tool('Read').input_schema, deferred: false })
  expect(ask?.description).toBe('Ask the')
  expect((ask?.schema.properties as Record<string, unknown>).questions).toBeDefined()
  expect(mcp).toEqual({ name: 'mcp__server__lookup', description: 'Lookup', schema: { type: 'object', additionalProperties: true }, deferred: true })
  // What the engine described to this session itself still wins.
  expect(remoteTools(infos.slice(0, 1), new Map([['Read', { description: 'Live text' }]]), () => true, {}, toolTable(derived))[0]?.description).toBe('Live text')
})

test('a capture that is not what the engine is expected to produce is refused, not guessed', () => {
  expect(() => deriveCapture({ ...capture, main: { tools: [] } })).toThrow('no tools')
  expect(() => deriveCapture({ ...capture, spawned: capture.spawned.filter(each => each.type !== MARKER_AGENT) })).toThrow('marker agent did not start')
  const reshaped = capture.spawned.map(each => each.type === 'Explore' && !each.background ? { ...each, body: { ...request([], 'x'), system: [{ type: 'text', text: 'OWNED EXPLORE PROMPT' }] } } : each)
  expect(() => deriveCapture({ ...capture, spawned: reshaped })).toThrow('does not have the shape')
  const differs = capture.spawned.map(each => each.type === 'Explore' && each.background ? { ...each, body: request(['Read'], 'ANOTHER PROMPT') } : each)
  expect(() => deriveCapture({ ...capture, spawned: differs })).toThrow('differs between the foreground and the background')
  expect(() => deriveCapture({ ...capture, main: { tools: [{ name: 'Read' }] } })).toThrow('without a name, a description or an input schema')
  expect(isCapture({ ...deriveCapture(capture), tools: [] })).toBe(false)
  expect(isCapture(null)).toBe(false)
})

test('an agent task names its type and mode, and a tool combination has one key whatever its order', () => {
  expect(spawnOf(`before ${spawnTask('general-purpose', true)} after`)).toEqual({ type: 'general-purpose', background: true })
  expect(spawnOf(spawnTask('Explore', false))).toEqual({ type: 'Explore', background: false })
  expect(spawnOf('an ordinary task')).toBeUndefined()
  expect(toolSetKey(['Read', 'Bash', 'Read'])).toBe(toolSetKey(['Bash', 'Read']))
  expect(toolSetKey(['Bash', 'Read'])).not.toBe(toolSetKey(['Bash', 'Read', 'Glob']))
  expect(toolSetKey([])).toMatch(/^[0-9a-f]{8}$/)
})
