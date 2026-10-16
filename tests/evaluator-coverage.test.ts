import { expect, test } from 'bun:test'
import { hookEvents, pluginHookConflict } from '../hooks/evaluator-coverage'

const files = new Map<string, string>()
const ports = (enabledPlugins: Record<string, unknown>) => ({
  configDir: '/home/fixture/.claude', enabledPlugins, ownPlugin: 'rice-multi-models',
  exists: async (path: string) => files.has(path), read: async (path: string) => { const text = files.get(path); if (text === undefined) throw new Error('ENOENT'); return text },
})
const registry = (plugins: Record<string, unknown>) => files.set('/home/fixture/.claude/plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins }))

test('hook events come from a hooks object only', () => {
  expect(hookEvents({ hooks: { Stop: [], SessionStart: [] } })).toEqual(['Stop', 'SessionStart'])
  expect(hookEvents({ modules: ['./register.ts'] })).toEqual([])
  expect(hookEvents(null)).toEqual([])
})

test('only this mod enabled leaves no hidden plugin source', async () => {
  files.clear()
  expect(await pluginHookConflict('Stop', ports({ 'rice-multi-models@rice-mods': true, 'disabled@x': false }))).toBeUndefined()
})

test('another enabled plugin defining the event or an unreadable source blocks the takeover', async () => {
  files.clear()
  registry({ 'memory@market': [{ installPath: '/plugins/memory' }], 'quiet@market': [{ installPath: '/plugins/quiet' }] })
  files.set('/plugins/memory/hooks/hooks.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] } }))
  files.set('/plugins/quiet/hooks/hooks.json', JSON.stringify({ hooks: { SessionStart: [] } }))
  expect(await pluginHookConflict('Stop', ports({ 'quiet@market': true }))).toBeUndefined()
  expect(await pluginHookConflict('Stop', ports({ 'memory@market': true }))).toContain('memory@market defines Stop hooks')
  expect(await pluginHookConflict('SubagentStop', ports({ 'memory@market': true }))).toBeUndefined()
  expect(await pluginHookConflict('Stop', ports({ 'missing@market': true }))).toContain('no installed copy')
  files.set('/plugins/quiet/.claude-plugin/plugin.json', JSON.stringify({ name: 'quiet', hooks: './other-hooks.json' }))
  expect(await pluginHookConflict('Stop', ports({ 'quiet@market': true }))).toContain('declares hooks in another file')
  files.delete('/home/fixture/.claude/plugins/installed_plugins.json')
  expect(await pluginHookConflict('Stop', ports({ 'quiet@market': true }))).toContain('registry is unreadable')
})

test('a plugin with function hook modules is hidden unless its registration was observed', async () => {
  files.clear()
  registry({ 'modular@market': [{ installPath: '/plugins/modular' }] })
  files.set('/plugins/modular/hooks/hooks.json', JSON.stringify({ modules: ['./register.ts'] }))
  expect(await pluginHookConflict('Stop', ports({ 'modular@market': true }))).toContain('did not observe')
  expect(await pluginHookConflict('Stop', { ...ports({ 'modular@market': true }), observedModules: new Set(['modular']) })).toBeUndefined()
})
