// Learns Claude Code's own tool definitions and built-in agent prompts by running the installed claude once, in a
// throwaway folder, against a loopback stub (helper/native-run.ts): no network, no account, none of the person's
// settings, plugins or sessions. The run is given the session's own built-in tools, since the engine words some
// tools and prompts by which others are present. Its main request carries the tools as the engine sends them; the
// stub answers it by starting every agent type the engine lists, and a marker agent, in the foreground and in the
// background, and records each agent's first request. hooks/native-tools.ts turns them into what a routed step
// sends. The caller caches the result per version and tool combination.
import { deriveCapture, MAIN_MARK, MARKER_AGENT, markerAgentFile, spawnOf, spawnTask, type NativeCapture, type ToolsCapture } from '../hooks/native-tools.ts'
import { runNative, textOf } from './native-run.ts'

/** A built-in tool's name: what reaches the claude command line, through a shell on native Windows. */
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

/** Runs the capture for the session's built-in tools; rejects when the installed claude does not behave as expected. */
export async function captureTools(names: readonly string[], outer?: AbortSignal): Promise<NativeCapture> {
  // The Agent tool starts the agents whose prompts are read. Capture against
  // Claude Code's default native surface, then select this session's names: an
  // explicit --tools list changes its own dynamic tool descriptions.
  const tools = new Set([...names.filter(name => TOOL_NAME.test(name)), 'Agent'])
  let main: Record<string, unknown> | undefined
  let listed: string[] = []
  let expected: number | undefined
  const spawned: ToolsCapture['spawned'][number][] = []
  const run = await runNative({
    label: 'tools',
    script: [MAIN_MARK],
    // Default mode, which some versions do not start a headless run in: an auto-mode classifier would judge each Agent call.
    args: ['--permission-mode', 'default'],
    files: { [`agents/${MARKER_AGENT}.md`]: markerAgentFile() },
    answer: async (body, current) => {
      const opening = textOf((body.messages as { content?: unknown }[] | undefined)?.[0]?.content)
      const agent = spawnOf(opening)
      if (agent) {
        if (!spawned.some(each => each.type === agent.type && each.background === agent.background)) spawned.push({ ...agent, body })
        return { text: 'ok' }
      }
      if (main !== undefined || !opening.includes(MAIN_MARK)) return { text: 'ok' }
      main = body
      // The agent types the engine offers this session, as its start event lists them.
      const start = await current.event(event => event.type === 'system' && event.subtype === 'init')
      listed = Array.isArray(start.agents) ? start.agents.filter((type): type is string => typeof type === 'string') : []
      if (!Array.isArray(body.tools) || !body.tools.some(tool => (tool as { name?: unknown }).name === 'Agent')) { expected = 0; return { text: 'ok' } }
      const types = [...new Set([...listed, MARKER_AGENT])]
      const calls = types.flatMap((type, index) => [false, true].map(background => ({
        id: `toolu_rice_capture_${index}_${background ? 'b' : 'f'}`,
        name: 'Agent',
        input: { description: `Capture ${type}`, prompt: spawnTask(type, background), subagent_type: type, run_in_background: background },
      })))
      expected = calls.length
      return { toolUses: calls }
    },
    // Each agent's first request is all that is read; the rest of the run is not waited for.
    done: () => expected !== undefined && spawned.length >= expected,
    signal: outer,
  })
  if (main === undefined) throw new Error('the installed claude sent no request')
  const capture = deriveCapture({ version: run.version, listed, main, spawned })
  const missing = [...tools].filter(name => !capture.tools.some(tool => tool.name === name))
  if (missing.length > 0) throw new Error(`Claude Code did not expose requested native tools: ${missing.join(', ')}`)
  const select = (sets: { readonly foreground: readonly string[]; readonly background: readonly string[] }) => ({
    foreground: sets.foreground.filter(name => tools.has(name)),
    background: sets.background.filter(name => tools.has(name)),
  })
  return {
    ...capture,
    tools: capture.tools.filter(tool => tools.has(tool.name)),
    offered: Object.fromEntries(Object.entries(capture.offered).map(([type, sets]) => [type, select(sets)])),
    custom: select(capture.custom),
  }
}
