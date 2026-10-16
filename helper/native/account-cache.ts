import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { NativeSelectionError } from './native-runtime.ts'

type Installation = { scope?: string; projectPath?: string; installPath?: string }

/** Compose only the installed Rice account mod, never an old repair marketplace. */
export function accountCache(configDir: string, cwd: string): string | undefined {
  let ledger: { plugins?: Record<string, Installation[]> }
  try { ledger = JSON.parse(readFileSync(join(configDir, 'plugins/installed_plugins.json'), 'utf8')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new NativeSelectionError('The installed plugin registry could not be read; repair the Rice plugin installation.')
  }
  const installs = (ledger.plugins?.['rice-session-accounts@rice-mods'] ?? [])
    .filter(row => typeof row.installPath === 'string' && isAbsolute(row.installPath)
      && ['user', 'project', 'local'].includes(row.scope ?? '')
      && (!row.projectPath || cwd === resolve(row.projectPath) || cwd.startsWith(resolve(row.projectPath) + sep)))
    .sort((a, b) => (b.projectPath?.length ?? 0) - (a.projectPath?.length ?? 0))
  const root = installs[0]?.installPath
  if (!root) return undefined
  const cache = join(root, 'native/cache.mjs')
  if (existsSync(cache)) {
    if (!existsSync(join(root, 'native/startup.mjs'))) throw new NativeSelectionError('Rice Accounts startup support is missing; update rice-session-accounts before starting rice-claude.')
    return cache
  }
  let version: unknown
  try { version = JSON.parse(readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8')).version }
  catch { throw new NativeSelectionError('Rice Accounts is incomplete; update rice-session-accounts before starting rice-claude.') }
  // Version 0.2 predates this optional composition contract.
  if (typeof version === 'string' && /^0\.[012]\./.test(version)) return undefined
  throw new NativeSelectionError('Rice Accounts native cache support is missing; update rice-session-accounts before starting rice-claude.')
}

/** Select a saved browser account before native resume and startup compaction. */
export async function prepareAccounts(cache: string | undefined, args: string[], environment: NodeJS.ProcessEnv, configDir: string): Promise<{ args: string[]; env: NodeJS.ProcessEnv }> {
  const delimiter = args.indexOf('--')
  const selectsAccount = args.slice(0, delimiter < 0 ? undefined : delimiter).some(arg => arg === '--account' || arg.startsWith('--account='))
  if (!cache) {
    if (selectsAccount) throw new NativeSelectionError('The --account option requires Rice Accounts 0.3 or newer. Update rice-session-accounts, complete /rice-account setup <name>, then start rice-claude again.')
    return { args, env: environment }
  }
  try {
    const { prepareAccountLaunch } = await import(pathToFileURL(join(dirname(cache), 'startup.mjs')).href) as {
      prepareAccountLaunch(args: string[], environment: NodeJS.ProcessEnv, configDir: string): { args: string[]; env: NodeJS.ProcessEnv }
    }
    return prepareAccountLaunch(args, environment, configDir)
  } catch {
    throw new NativeSelectionError('Rice Accounts could not prepare the saved browser account. Update rice-session-accounts, complete /rice-account setup <name>, and pass --account <name> once before the Claude arguments.')
  }
}
