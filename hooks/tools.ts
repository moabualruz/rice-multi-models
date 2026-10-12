// The tools a routed step offers: each tool's name, the description the engine shows the model, and an input
// schema (the generated table for built-ins, a loose object otherwise). A tool the engine keeps behind
// ToolSearch is marked deferred; the translator sends it once the transcript has loaded it. Pure.
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
): RemoteTool[] {
  return infos
    .filter(info => allow(info.name))
    .map(info => {
      const seen = described.get(info.name)

      return {
        name: info.name,
        description: seen?.description ?? info.description,
        schema: { ...(own(SCHEMAS, info.name) ?? own(mcpSchemas, info.name) ?? LOOSE) },
        deferred: seen?.isDeferred ?? info.mcp,
      }
    })
}
