import { access, mkdir, readFile, realpath } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export type SetupInfo = {
  node: { executable: string; version: string; supported: boolean }
  executable: string
  nodeVersion: string
  platform: string
  home: string
  configDir: string
  codexHome: string
  opencodeAuthFile: string
  clis: Partial<Record<'codex' | 'agy' | 'grok' | 'opencode' | 'npm', string>>
  auth: { codex: boolean; opencode: boolean }
}

async function exists(file: string, executable = false): Promise<boolean> {
  try { await access(file, executable && process.platform !== 'win32' ? constants.X_OK : constants.F_OK); return true } catch { return false }
}

/** Safe local facts only. Never reads credentials, runs login, installs, or writes files. */
export async function setupInfo(env: NodeJS.ProcessEnv = process.env): Promise<SetupInfo> {
  const home = path.resolve(env.HOME || env.USERPROFILE || homedir())
  const configDir = path.resolve(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'))
  const codexHome = path.resolve(env.CODEX_HOME || path.join(home, '.codex'))
  const opencodeAuthFile = path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'opencode', 'auth.json')
  const dirs = [...(env.PATH || '').split(path.delimiter), path.join(home, '.local', 'bin'), path.join(home, '.codex', 'bin')].filter(Boolean)
  const clis: SetupInfo['clis'] = {}
  for (const name of ['codex', 'agy', 'grok', 'opencode', 'npm'] as const) {
    const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']
    for (const dir of dirs) {
      for (const suffix of suffixes) {
        const file = path.resolve(dir, name + suffix)
        if (await exists(file, true)) { clis[name] = file; break }
      }
      if (clis[name]) break
    }
  }
  const scopedCodex = path.join(configDir, 'rice-multi-models', 'cli', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  if (!clis.codex && await exists(scopedCodex)) clis.codex = scopedCodex
  return {
    executable: path.resolve(process.execPath), nodeVersion: process.versions.node,
    node: { executable: path.resolve(process.execPath), version: process.versions.node, supported: Number(process.versions.node.split('.')[0]) >= 22 },
    platform: process.platform, home, configDir, codexHome, opencodeAuthFile, clis,
    auth: { codex: await exists(path.join(codexHome, 'auth.json')), opencode: await exists(opencodeAuthFile) },
  }
}

const CODEX_VERSION = '0.162.1'
const CODEX_INTEGRITY = 'sha512-NWZdi/kxyjv/8EUGFupziGU38YyleugZRM4JXgY5XFH7FUmaFA33NZS2Bmq0HPazf7S3jJQQWsZ/jAK9jsrV3Q=='
function run(argv: string[], env: NodeJS.ProcessEnv, timeout: number): Promise<{ code: number; stdout: string }> {
  return new Promise(resolve => {
    execFile(argv[0]!, argv.slice(1), { env, timeout, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => resolve({ code: error ? 1 : 0, stdout: String(stdout) }))
  })
}

/** Only the explicit setup codex action calls this scoped, pinned official CLI installer. */
export async function setupCodex(env: NodeJS.ProcessEnv = process.env): Promise<{ ok: boolean; installed: boolean; executable?: string; login?: string[]; error?: string }> {
  const info = await setupInfo(env)
  const login = (executable: string) => executable.endsWith('.js') ? [process.execPath, executable, 'login'] : [executable, 'login']
  if (info.clis.codex) return { ok: true, installed: false, executable: info.clis.codex, login: login(info.clis.codex) }
  if (!['darwin', 'linux', 'win32'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) return { ok: false, installed: false, error: 'The pinned official Codex CLI supports macOS, Linux and Windows x64/arm64 only. Install a vendor-supported CLI for your platform.' }
  if (!info.clis.npm) return { ok: false, installed: false, error: 'npm is missing. Install the official Node.js 22+ distribution with npm, then /rice-models setup codex.' }
  try {
    const npmPath = await realpath(info.clis.npm)
    const npmScript = npmPath.endsWith('.js') ? npmPath : path.join(path.dirname(npmPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (!await exists(npmScript)) return { ok: false, installed: false, error: 'Could not locate npm-cli.js in this Node distribution. Install official Node.js with npm, then retry /rice-models setup codex.' }
    const npm = [process.execPath, npmScript]
    const childEnv = { ...env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${env.PATH || ''}` }
    const metadata = await run([...npm, 'view', `@openai/codex@${CODEX_VERSION}`, '--json', '--registry=https://registry.npmjs.org'], childEnv, 30_000)
    if (metadata.code !== 0) return { ok: false, installed: false, error: 'Could not verify official Codex package metadata from registry.npmjs.org. No install was attempted.' }
    const parsedMetadata: unknown = JSON.parse(metadata.stdout)
    const singleManifest: unknown = Array.isArray(parsedMetadata) ? parsedMetadata.length === 1 ? parsedMetadata[0] : undefined : parsedMetadata
    if (!singleManifest || typeof singleManifest !== 'object' || Array.isArray(singleManifest)) return { ok: false, installed: false, error: 'Official Codex package metadata did not match the verified pinned distribution. No install was attempted.' }
    const packageInfo = singleManifest as { name?: string; version?: string; repository?: { url?: string }; dist?: { integrity?: string }; bin?: { codex?: string }; optionalDependencies?: Record<string, string> }
    if (packageInfo.name !== '@openai/codex' || packageInfo.version !== CODEX_VERSION || packageInfo.repository?.url !== 'git+https://github.com/openai/codex.git' || packageInfo.dist?.integrity !== CODEX_INTEGRITY || packageInfo.bin?.codex !== 'bin/codex.js' || !packageInfo.optionalDependencies?.[`@openai/codex-${process.platform}-${process.arch}`]) return { ok: false, installed: false, error: 'Official Codex package metadata did not match the verified pinned distribution. No install was attempted.' }
    const prefix = path.join(info.configDir, 'rice-multi-models', 'cli')
    await mkdir(prefix, { recursive: true })
    const installed = await run([...npm, 'install', '--prefix', prefix, '--no-audit', '--no-fund', '--ignore-scripts', '--save-exact', '--registry=https://registry.npmjs.org', `@openai/codex@${CODEX_VERSION}`], childEnv, 120_000)
    if (installed.code !== 0) return { ok: false, installed: false, error: 'Scoped Codex CLI install failed. Check npm connectivity and permissions, then retry /rice-models setup codex. No global install or login was performed.' }
    const executable = path.join(prefix, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    const manifest = JSON.parse(await readFile(path.join(prefix, 'node_modules', '@openai', 'codex', 'package.json'), 'utf8')) as { name?: string; version?: string }
    const verified = manifest.name === '@openai/codex' && manifest.version === CODEX_VERSION && (await run([process.execPath, executable, '--version'], childEnv, 10_000)).code === 0
    return verified ? { ok: true, installed: true, executable, login: login(executable) } : { ok: false, installed: false, error: 'Codex package installed but its executable verification failed; no login was performed.' }
  } catch { return { ok: false, installed: false, error: 'Scoped Codex setup could not complete safely; retry /rice-models setup codex after checking Node/npm and filesystem access.' } }
}
