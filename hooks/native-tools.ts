// Claude Code's own tool definitions and built-in agent prompts, learned from the installed claude and used here.
//
// A routed session builds no Anthropic request, so the engine never renders its tools or a subagent's prompt for
// it. The helper runs the installed claude once per version and tool combination in an isolated folder against a
// loopback stub (see helper/native-tools.ts): the main request carries the tools as the engine sends them, and the
// stub answers it by starting every agent type the engine lists, in the foreground and in the background, plus an
// agent file whose whole prompt is a known marker. This module turns those requests into what a routed step
// sends. Nothing here is a copy of the engine's text.
import { isObject, own } from './util'

/** The capture's user line, an agent's task and the marker agent's prompt; never shown to a model in use. */
export const MAIN_MARK = 'RICECAPTUREMAINTURN'
export const SPAWN_MARK = 'RICECAPTURESPAWN'
export const BODY_MARK = 'RICECAPTUREAGENTBODY'
/** The agent file the capture adds: a custom agent whose whole prompt is BODY_MARK, so the text the engine puts around a prompt shows. */
export const MARKER_AGENT = 'rice-capture-marker'

/** One built-in tool as the engine sends it to the model. */
export type NativeTool = { name: string; description: string; input_schema: Record<string, unknown> }
/** The tools an agent is offered when it runs in the foreground and in the background. */
export type ToolSets = { foreground: readonly string[]; background: readonly string[] }

/** What one Claude Code version sends, for one combination of the session's built-in tools. */
export type NativeCapture = {
  version: string
  /** The built-in tools, in the engine's order. */
  tools: readonly NativeTool[]
  /** The text the engine writes before and after every subagent's own prompt. */
  agentHead: string
  agentTail: string
  /** Each built-in agent type's own prompt, by type. */
  prompts: Readonly<Record<string, string>>
  /** The tools the engine offers each built-in agent type. */
  offered: Readonly<Record<string, ToolSets>>
  /** The tools it offers an agent whose definition does not list them. */
  custom: ToolSets
}

/** What the capture observed: the agent types the engine listed, its main request, and each started agent's first request. */
export type ToolsCapture = {
  version: string
  listed: readonly string[]
  main: unknown
  spawned: readonly { type: string; background: boolean; body: unknown }[]
}

/** The agent file the capture writes into its isolated configuration. */
export const markerAgentFile = (): string => `---\nname: ${MARKER_AGENT}\ndescription: Capture marker\n---\n${BODY_MARK}\n`

/** The task the capture gives an agent: names its type and whether it runs in the background. */
export const spawnTask = (type: string, background: boolean): string => `${SPAWN_MARK} ${background ? 'background' : 'foreground'} ${type}`

/** The type and mode an agent's opening text names, when it is one the capture started. */
export function spawnOf(text: string): { type: string; background: boolean } | undefined {
  const found = new RegExp(`${SPAWN_MARK} (foreground|background) (\\S+)`).exec(text)
  return found ? { type: found[2]!, background: found[1] === 'background' } : undefined
}

/** A short, stable name for a set of tool names, whatever their order. */
export function toolSetKey(names: readonly string[]): string {
  let hash = 0x811c9dc5
  for (const char of [...new Set(names)].sort().join(',')) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string')
const isSets = (value: unknown): value is ToolSets => isObject(value) && isStrings(value.foreground) && isStrings(value.background)
const isTool = (value: unknown): value is NativeTool => isObject(value) && typeof value.name === 'string' && typeof value.description === 'string' && isObject(value.input_schema)

export function isCapture(value: unknown): value is NativeCapture {
  if (!isObject(value)) return false
  return typeof value.version === 'string' && Array.isArray(value.tools) && value.tools.length > 0 && value.tools.every(isTool)
    && typeof value.agentHead === 'string' && typeof value.agentTail === 'string'
    && isObject(value.prompts) && Object.values(value.prompts).every(text => typeof text === 'string')
    && isObject(value.offered) && Object.values(value.offered).every(isSets) && isSets(value.custom)
}

/** The texts of a request's system blocks, in order. */
function systemOf(body: unknown): string[] {
  const system = isObject(body) ? body.system : undefined
  if (typeof system === 'string') return [system]
  if (!Array.isArray(system) || !system.every(block => isObject(block) && typeof block.text === 'string')) throw new Error('a request has no system prompt the capture can read')
  return system.map(block => (block as { text: string }).text)
}

/** A request's tools, as the engine sent them. */
function toolsOf(body: unknown): NativeTool[] {
  const tools = isObject(body) ? body.tools : undefined
  if (!Array.isArray(tools)) return []
  if (!tools.every(isTool)) throw new Error('a request carries a tool without a name, a description or an input schema')
  return tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema }))
}

/**
 * The definitions and prompts a capture implies; throws when it does not have the shape the engine is expected to
 * produce. Every subagent's system prompt is the engine's preamble (its blocks before the agent's own) and then one
 * block: the agent's own prompt between a head and a tail, which the marker agent shows. The preamble names the
 * engine's model and product, as the main prompt's identity sections do, and is left out as they are.
 */
export function deriveCapture(capture: ToolsCapture): NativeCapture {
  const tools = toolsOf(capture.main)
  if (tools.length === 0) throw new Error('the installed claude sent no tools')
  const find = (type: string, background: boolean) => capture.spawned.find(each => each.type === type && each.background === background)
  const marker = find(MARKER_AGENT, false)
  const markerBackground = find(MARKER_AGENT, true)
  if (!marker || !markerBackground) throw new Error('the marker agent did not start in both the foreground and the background')
  const blocks = systemOf(marker.body)
  const at = blocks.length - 1
  const mark = blocks[at]!.indexOf(BODY_MARK)
  if (mark < 0) throw new Error('the marker agent\'s prompt is not the last block of its system prompt')
  const head = blocks[at]!.slice(0, mark)
  const tail = blocks[at]!.slice(mark + BODY_MARK.length)
  const ownPrompt = (type: string, body: unknown) => {
    const system = systemOf(body)
    const text = system.at(-1)!
    if (system.length !== blocks.length || !text.startsWith(head) || !text.endsWith(tail) || text.length < head.length + tail.length) throw new Error(`the ${type} agent's system prompt does not have the shape of the marker agent's`)
    return text.slice(head.length, text.length - tail.length)
  }
  if (ownPrompt(MARKER_AGENT, markerBackground.body) !== BODY_MARK) throw new Error('the marker agent\'s prompt differs in the background')
  const names = (body: unknown) => toolsOf(body).map(tool => tool.name)
  // Keyed by names the engine lists, so without a prototype a name could reach.
  const prompts: Record<string, string> = Object.create(null)
  const offered: Record<string, ToolSets> = Object.create(null)
  for (const type of capture.listed) {
    if (type === MARKER_AGENT || Object.hasOwn(prompts, type)) continue
    const foreground = find(type, false)
    const background = find(type, true)
    // A listed type the engine did not start has no prompt here; a routed step of it is refused.
    if (!foreground || !background) continue
    const prompt = ownPrompt(type, foreground.body)
    if (ownPrompt(type, background.body) !== prompt) throw new Error(`the ${type} agent's prompt differs between the foreground and the background`)
    prompts[type] = prompt
    offered[type] = { foreground: names(foreground.body), background: names(background.body) }
  }
  return { version: capture.version, tools, agentHead: head, agentTail: tail, prompts, offered, custom: { foreground: names(marker.body), background: names(markerBackground.body) } }
}

/** A subagent's system prompt as the engine words it, around the agent's own prompt `body`. */
export const agentPrompt = (capture: NativeCapture, body: string): string => capture.agentHead + body + capture.agentTail

/** A built-in agent type's own prompt, if the capture holds it. */
export const builtinPrompt = (capture: NativeCapture, type: string): string | undefined => own(capture.prompts, type)

/** The captured tools by name. */
export const toolTable = (capture: NativeCapture): ReadonlyMap<string, NativeTool> => new Map(capture.tools.map(tool => [tool.name, tool]))

/**
 * What the capture says about the tools an agent is offered: `known` are the tools it saw, `offered` the ones the
 * engine gives the agent type (or, with no type, an agent defined by a file). A type the capture did not start
 * answers undefined.
 */
export function offeredTools(capture: NativeCapture, type: string | undefined, background: boolean): { known: ReadonlySet<string>; offered: ReadonlySet<string> } | undefined {
  const sets = type === undefined ? capture.custom : own(capture.offered, type)
  if (!sets) return undefined
  const known = new Set(capture.tools.map(tool => tool.name))
  for (const each of [capture.custom, ...Object.values(capture.offered)]) for (const name of [...each.foreground, ...each.background]) known.add(name)
  return { known, offered: new Set(background ? sets.background : sets.foreground) }
}
