// Whether the mod can see every hook source of one evaluator event. The native
// core runs every non-managed source as one step, so replacing prompt and agent
// evaluators means answering without that step. Do that only when no other
// source could define hooks for the event; otherwise native hooks run unchanged.

type Row = Record<string, unknown>
const object = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value)

export type CoveragePorts = {
  configDir: string
  enabledPlugins: Readonly<Record<string, unknown>>
  ownPlugin: string
  /** Plugins whose function hook modules registered after this mod, so their events are known. */
  observedModules?: ReadonlySet<string>
  exists(path: string): Promise<boolean>
  read(path: string): Promise<string>
}

/** Events a plugin's hooks configuration (hooks.json or a manifest `hooks` object) defines. */
export function hookEvents(config: unknown): string[] {
  const hooks = object(config) && object(config.hooks) ? config.hooks : undefined
  return hooks ? Object.keys(hooks) : []
}

/** Why a classic hook of `event` from another enabled plugin cannot be ruled out, or undefined when it can. */
export async function pluginHookConflict(event: string, ports: CoveragePorts): Promise<string | undefined> {
  const enabled = Object.entries(ports.enabledPlugins).filter(([, on]) => on === true).map(([id]) => id)
  const others = enabled.filter(id => id.split('@')[0] !== ports.ownPlugin)
  if (!others.length) return undefined
  let registry: unknown
  try { registry = JSON.parse(await ports.read(`${ports.configDir}/plugins/installed_plugins.json`)) } catch { return 'the installed plugin registry is unreadable' }
  const plugins = object(registry) && object(registry.plugins) ? registry.plugins : undefined
  if (!plugins) return 'the installed plugin registry has no plugin list'
  for (const id of others) {
    const rows = plugins[id]
    if (!Array.isArray(rows) || !rows.length) return `enabled plugin ${id} has no installed copy the mod can read`
    for (const row of rows) {
      const root = object(row) && typeof row.installPath === 'string' ? row.installPath : undefined
      if (!root) return `enabled plugin ${id} has no install path`
      for (const file of [`${root}/hooks/hooks.json`, `${root}/.claude-plugin/plugin.json`]) {
        if (!await ports.exists(file)) continue
        let parsed: unknown
        try { parsed = JSON.parse(await ports.read(file)) } catch { return `${id} has an unreadable hooks configuration` }
        if (file.endsWith('plugin.json') && object(parsed) && parsed.hooks !== undefined && !object(parsed.hooks)) return `${id} declares hooks in another file`
        if (hookEvents(parsed).includes(event)) return `enabled plugin ${id} defines ${event} hooks`
        // A module that registered before this mod was never observed; its events are unknown.
        if (file.endsWith('hooks.json') && object(parsed) && Array.isArray(parsed.modules) && parsed.modules.length && !ports.observedModules?.has(id.split('@')[0] ?? id)) return `enabled plugin ${id} has function hook modules whose events the mod did not observe`
      }
    }
  }
  return undefined
}
