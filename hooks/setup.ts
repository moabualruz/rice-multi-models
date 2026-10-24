import type { PickerRow } from './picker'
import { NATIVE_MODEL_LIMITATIONS, NATIVE_WINDOW_EXPLANATION } from './catalogue'

export type SetupInfo = {
  node: { executable: string; version: string; supported: boolean }
  platform: string; home: string; configDir: string; codexHome: string; opencodeAuthFile: string
  clis: Partial<Record<'codex' | 'opencode' | 'npm', string>>
  auth: { codex: boolean; opencode: boolean }
}
export type Runtime = { executable?: string; version?: string; error?: string; info?: SetupInfo }
export type PickerResult = { ok: boolean; changed: boolean; count: number; path: string; preserved?: number; error?: string }
export const helperFile = (root: string): string => `${root}/dist/helper.mjs`
export type RunPort = (argv: readonly string[], options?: { timeoutMs?: number; stdin?: string }) => Promise<{ exitCode: number; stdout: string; stderr: string }>
export type RuntimePort = { helper: string; override?: string; run: RunPort; exists: (path: string) => Promise<boolean> }
export type PickerPort = { helper: string; run: RunPort }
export type NoticePort = { get: (key: string) => Promise<unknown>; set: (key: string, value: unknown) => Promise<void>; log: (text: string) => void }
export const absoluteExecutable = (value: string): boolean => !/[\r\n\0]/.test(value) && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value))
const NODE_PROBE = 'console.log(JSON.stringify({executable:process.execPath,version:process.versions.node}))'

/** Starts the candidate Node directly. Shells, Bun and nvm sourcing are not part of startup. */
export async function detectRuntime(io: RuntimePort): Promise<Runtime> {
  const override = io.override
  if (override && !absoluteExecutable(override)) return { error: 'RICE_MULTI_MODELS_NODE must be an absolute Node.js executable path. Set it to Node.js 22+ and /rice-models setup repair.' }
  let outdated: string | undefined
  for (const candidate of override ? [override] : ['node', 'node.exe']) {
    try {
      const found = await io.run([candidate, '-e', NODE_PROBE], { timeoutMs: 5000 })
      if (found.exitCode !== 0) continue
      const value = JSON.parse(found.stdout.trim()) as { executable?: unknown; version?: unknown }
      if (typeof value.executable !== 'string' || !absoluteExecutable(value.executable) || typeof value.version !== 'string') continue
      if (!/^\d+\.\d+\.\d+/.test(value.version) || Number(value.version.split('.')[0]) < 22) { outdated = value.version; continue }
      if (!(await io.exists(io.helper))) return { executable: value.executable, version: value.version, error: 'The shipped dist/helper.mjs is missing. Reinstall or update rice-multi-models, then /rice-models setup repair. No Bun or source compilation is required.' }
      const doctor = await io.run([value.executable, io.helper, 'doctor'], { timeoutMs: 10_000 })
      if (doctor.exitCode !== 0) return { executable: value.executable, version: value.version, error: 'The shipped Node helper could not run. Reinstall or update rice-multi-models, then /rice-models doctor.' }
      const info = JSON.parse(doctor.stdout.trim()) as SetupInfo
      if (!info.node?.supported || !info.home || !info.configDir || !info.auth || !info.clis) return { error: 'The helper doctor returned invalid metadata. Reinstall rice-multi-models and /rice-models setup repair.' }
      return { executable: value.executable, version: value.version, info }
    } catch { /* Missing executables or invalid metadata are handled by the repair command. */ }
  }
  return { error: `${outdated ? `Node.js ${outdated} is too old.` : 'Node.js is not available to this session.'} Install Node.js 22+ from https://nodejs.org, or set RICE_MULTI_MODELS_NODE to its absolute executable path, then /rice-models setup repair.` }
}

export async function syncPicker(io: PickerPort, runtime: Runtime, rows: PickerRow[]): Promise<PickerResult> {
  if (!runtime.executable || !runtime.info || runtime.error) return { ok: false, changed: false, count: 0, path: '', error: runtime.error || 'Node.js 22+ helper is unavailable; /rice-models setup repair.' }
  try {
    const result = await io.run([runtime.executable, io.helper, 'sync-picker'], { stdin: JSON.stringify({ configDir: runtime.info.configDir, rows }), timeoutMs: 10_000 })
    const parsed = JSON.parse(result.stdout.trim()) as PickerResult
    if (typeof parsed.ok === 'boolean') return parsed
  } catch { /* Do not fall back to an unsafe direct settings write. */ }
  return { ok: false, changed: false, count: 0, path: runtime.info.configDir + '/settings.json', error: 'Picker synchronization failed without overwriting settings. Retry /rice-models setup repair or inspect /rice-models doctor.' }
}

export function commandText(argv: readonly string[], platform = 'posix'): string {
  if (platform === 'win32') return `& ${argv.map(word => `'${word.replace(/'/g, "''")}'`).join(' ')}`
  return argv.map(word => /^[A-Za-z0-9_@./:-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`).join(' ')
}
export function loginCommand(runtime: Runtime): string {
  const cli = runtime.info?.clis.codex
  return cli ? commandText(cli.endsWith('.js') ? [runtime.executable || 'node', cli, 'login'] : [cli, 'login'], runtime.info?.platform) : 'codex login'
}
export function setupSummary(runtime: Runtime, picker?: PickerResult, count = 0, defaultModel?: string, catalogueSummary?: string, capabilities?: string): string {
  if (runtime.error) return [`rice-multi-models setup: ${runtime.error}\n/rice-models doctor checks local setup without changing it.`, capabilities].filter(Boolean).join('\n')
  const info = runtime.info!
  const lines = [
    `rice-multi-models setup: Node.js ${runtime.version}; ${count} freshly discovered model candidates (not proof that inference will succeed).`,
    ...(catalogueSummary ? [`Discovery: ${catalogueSummary}.`] : []),
    picker?.ok ? `Picker synchronized in ${picker.path}; custom and edited rows were preserved.` : `Picker needs repair: ${picker?.error || '/rice-models setup repair'}`,
    info.auth.codex ? 'Codex login file is present; entitlement is checked on your first request.' : `Codex login is needed: run ${loginCommand(runtime)} in your terminal.`,
  ]
  if (!info.clis.codex && !info.auth.codex) lines.push('Codex CLI is missing: /rice-models setup codex explicitly installs the pinned official CLI into plugin-owned state (not globally), then shows the login command.')
  lines.push(defaultModel ? `Use /model ${defaultModel} or /rice-models models.` : 'No Codex model was discovered; /rice-models models reports source failures and /rice-models refresh retries discovery.', `Unknown metadata stays unknown. Exact model names and versions remain the route identity. This mod ships no agent files; project agent files work as Claude applies them, whichever model they name. ${NATIVE_MODEL_LIMITATIONS.registration} Native accounting remains host-owned and the mod applies no model-switch denial or request-input guard. ${NATIVE_WINDOW_EXPLANATION}`, `Start the normal claude command. The supported session.compact hook compacts routed history with the selected provider, using Claude Code's own summary prompt and format (read from the installed claude), and retains the original transcript on failure. Subagents compact natively against that window data. ${NATIVE_MODEL_LIMITATIONS.recovery}`, 'Declared providers still require your approval; optional agy/grok CLIs are never installed automatically.', '/rice-models setup repair refreshes discovery and repairs the picker; /rice-models doctor is read-only.')
  if (capabilities) lines.push(capabilities)
  return lines.join('\n')
}

/** Headless startup never consumes the first interactive notice and never opens a dialog. */
export async function startupNotice(io: NoticePort, interactive: boolean, runtime: Runtime, picker: PickerResult | undefined, rows: PickerRow[], defaultModel?: string, catalogueSummary?: string, capabilities?: string): Promise<void> {
  if (!interactive) return
  const key = 'setup-notice-v2'
  const signature = JSON.stringify({ error: runtime.error, node: runtime.version, info: runtime.info, rows, defaultModel, catalogueSummary, capabilities, picker: picker ? { ok: picker.ok, error: picker.error, path: picker.path, preserved: picker.preserved } : undefined })
  if (await io.get(key) === signature) return
  io.log(setupSummary(runtime, picker, rows.length, defaultModel, catalogueSummary, capabilities).replace(/\n/g, ' '))
  await io.set(key, signature)
}
