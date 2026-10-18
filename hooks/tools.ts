// The tools a routed step offers: each tool's name, the description the engine shows the model, and an input
// schema. A built-in tool is sent as the installed claude sends it (its definition as captured, see
// native-tools.ts); without a capture, with the description the session lists and the generated schema table.
// Anything else gets a loose object schema. A tool the engine keeps behind ToolSearch is marked deferred; the
// translator sends it once the transcript has loaded it. Pure.
import type { NativeTool } from './native-tools'
import type { RemoteTool } from './protocol'
import { SCHEMAS } from './schemas.gen'
import { own } from './util'

export type ToolInfoLite = { name: string; description: string; mcp: boolean }
export type Described = { description: string; isDeferred?: boolean }

const LOOSE = { type: 'object', additionalProperties: true } as const

export function remoteTools(
  infos: readonly ToolInfoLite[],
  described: ReadonlyMap<string, Described>,
  allow: (name: string) => boolean,
  mcpSchemas: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {},
  native: ReadonlyMap<string, NativeTool> = new Map(),
): RemoteTool[] {
  return infos
    .filter(info => allow(info.name))
    .map(info => {
      const seen = described.get(info.name)
      const captured = info.mcp ? undefined : native.get(info.name)

      return {
        name: info.name,
        description: seen?.description ?? captured?.description ?? info.description,
        schema: { ...(captured?.input_schema ?? own(SCHEMAS, info.name) ?? own(mcpSchemas, info.name) ?? LOOSE) },
        deferred: seen?.isDeferred ?? info.mcp,
      }
    })
}
