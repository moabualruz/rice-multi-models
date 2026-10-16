import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { absoluteNativePath, NATIVE_SELECTION_REPAIR, NativeSelectionError, readSelection, saveSelection, selectionPath, SUPPORTED_NATIVE_VERSIONS } from './native-runtime.ts'
import type { NativeSelection } from './native-runtime.ts'
import { resumedModel } from './state.ts'
import { accountCache, prepareAccounts } from './account-cache.ts'
import { WINDOWS_LAUNCHER_MARKER, windowsLauncher } from './windows-launcher.ts'
import { windowsBootstrapDirectory } from './windows-bootstrap.ts'

const ENTRY_MARKER = '#!/usr/bin/env node\n// rice-multi-models installed launcher\n'

/** Bun does not parse quoted preload paths. A private plain-path bootstrap imports the actual file URL. */
export function bootstrap(bundle: string, cache?: string): string {
  const windows = process.platform === 'win32'
  const uid = windows ? undefined : process.getuid!()
  const source = `await import(${JSON.stringify(pathToFileURL(bundle).href)});\n`
    + (cache ? `process.env.RICE_SESSION_ACCOUNTS_NATIVE_VERSION = '2.1.299';\nawait import(${JSON.stringify(pathToFileURL(cache).href)});\n` : '')
  const digest = createHash('sha256').update(source).update(readFileSync(bundle))
  if (cache) digest.update(readFileSync(cache)).update(readFileSync(join(dirname(cache), 'startup.mjs')))
  const hash = digest.digest('hex')
  const base = /\s/.test(tmpdir()) ? '/tmp' : tmpdir()
  const directory = windows ? windowsBootstrapDirectory(`${hash}.mjs`) : join(base, `rice-multi-models-${uid}`)
  if (!windows) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const info = lstatSync(directory)
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077) !== 0) throw new Error('unsafe native bootstrap directory')
  }
  const path = join(directory, `${hash}.mjs`)
  try { writeFileSync(path, source, { flag: 'wx', mode: 0o600 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = lstatSync(path)
    if (!existing.isFile() || existing.isSymbolicLink() || (!windows && (existing.uid !== uid || (existing.mode & 0o077) !== 0)) || readFileSync(path, 'utf8') !== source) throw new Error('unsafe native bootstrap file')
  }
  // This tiny bootstrap survives the parent so owned background Claude children can reuse it.
  return windows ? path.replace(/\\/g, '/') : path
}

export async function launch(args: string[]): Promise<number> {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('rice-multi-models launcher requires Node 22+')
  const dist = dirname(fileURLToPath(import.meta.url))
  const plugin = dirname(dist)
  const installing = args[0] === '--install'
  const explicit = installing ? args[1] : undefined
  if (installing && (args.length > 2 || explicit !== undefined && !absoluteNativePath(explicit))) {
    throw new NativeSelectionError('Usage: --install [absolute path to a qualified Claude executable]')
  }
  const windows = process.platform === 'win32'
  const directory = join(homedir(), '.local/bin')
  const path = join(directory, windows ? 'rice-claude.cmd' : 'rice-claude')
  const entry = windows ? join(directory, 'rice-claude.mjs') : path
  const managed = [{ path: entry, marker: ENTRY_MARKER }, ...(windows ? [{ path, marker: WINDOWS_LAUNCHER_MARKER }] : [])]
  if (installing) {
    for (const file of managed) {
      try {
        const existing = lstatSync(file.path)
        if (!existing.isFile() || existing.isSymbolicLink() || !readFileSync(file.path, 'utf8').replace(/\r\n/g, '\n').startsWith(file.marker.replace(/\r\n/g, '\n'))) throw new Error('rice-claude already exists and is not this mod\'s managed launcher')
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
  }
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  const override = explicit ?? process.env.RICE_CLAUDE_EXECUTABLE
  const saved = override ? undefined : readSelection(configDir)
  const native = override || saved?.executable || 'claude'
  const cache = accountCache(configDir, process.cwd())
  const preload = bootstrap(join(dist, 'native.mjs'), cache)
  let environment: NodeJS.ProcessEnv = { ...process.env, BUN_OPTIONS: `${process.env.BUN_OPTIONS ?? ''} --preload ${preload}`.trim(),
    // This native flag emits request-class and caller headers. They are consumed
    // in process and never forwarded to a different provider; no gateway exists.
    CLAUDE_CODE_GATEWAY_HINT_HEADERS: '1',
  }
  delete environment.RICE_MULTI_MODELS_NATIVE_ACTIVE
  delete environment.RICE_MULTI_MODELS_NATIVE_STATE
  delete environment.RICE_SESSION_ACCOUNTS_NATIVE_ACTIVE
  if (!installing) {
    const prepared = await prepareAccounts(cache, args, environment, configDir)
    args = prepared.args
    environment = prepared.env
  }
  const modelIndex = args.indexOf('--model')
  let model = modelIndex >= 0 ? args[modelIndex + 1] : args.find(arg => arg.startsWith('--model='))?.slice('--model='.length)
  if (!model) {
    model = resumedModel(args, environment.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'))
    if (model) args = ['--model', model, ...args]
  }
  if (model) environment.RICE_MULTI_MODELS_INITIAL_MODEL = model
  else delete environment.RICE_MULTI_MODELS_INITIAL_MODEL
  const verification = mkdtempSync(join(dirname(preload), 'verify-'))
  const handshake = join(verification, 'ready.json')
  let selection: NativeSelection
  try {
    const probe = spawnSync(native, ['--version'], { env: { ...environment, RICE_MULTI_MODELS_HANDSHAKE: handshake }, encoding: 'utf8', timeout: 15_000 })
    const version = probe.stdout?.match(/^(\d+\.\d+\.\d+)\s/m)?.[1]
    let ready: { version?: string; pid?: number; native?: boolean; executable?: string } | undefined
    try { ready = JSON.parse(readFileSync(handshake, 'utf8')) } catch {}
    if (probe.status !== 0 || ready?.version !== '1' || ready.native !== true || ready.pid !== probe.pid || !ready.executable) {
      throw new NativeSelectionError(`The selected native Claude executable is unavailable or its adapter could not activate. ${NATIVE_SELECTION_REPAIR}`)
    }
    if (!version || !SUPPORTED_NATIVE_VERSIONS.has(version)) throw new NativeSelectionError(`Claude ${version ?? 'unknown'} has not passed the native adapter compatibility proof; supported: ${[...SUPPORTED_NATIVE_VERSIONS].join(', ')}. ${NATIVE_SELECTION_REPAIR}`)
    environment.RICE_MULTI_MODELS_NATIVE_EXECUTABLE = ready.executable
    environment.RICE_MULTI_MODELS_NATIVE_VERSION = version
    selection = { format: 1, executable: ready.executable, claudeVersion: version }
  } finally { rmSync(verification, { recursive: true, force: true }) }
  if (installing) {
    mkdirSync(directory, { recursive: true })
    const outputs = [{ path: entry, bytes: readFileSync(join(dist, 'entry.mjs')) }, ...(windows ? [{ path, bytes: Buffer.from(windowsLauncher(process.execPath)) }] : [])]
    const temporary = outputs.map(() => join(directory, `.rice-claude-${crypto.randomUUID()}`))
    try {
      for (let index = 0; index < outputs.length; index++) {
        writeFileSync(temporary[index], outputs[index].bytes, { flag: 'wx', mode: 0o755 })
        if (!windows) chmodSync(temporary[index], 0o755)
      }
      for (let index = 0; index < outputs.length; index++) renameSync(temporary[index], outputs[index].path)
    } finally { for (const file of temporary) rmSync(file, { force: true }) }
    saveSelection(configDir, selection)
    process.stdout.write(`Installed ${windows ? 'rice-claude.cmd' : 'rice-claude'} in ${directory}. Saved verified Claude ${selection.claudeVersion} at ${selection.executable} in ${selectionPath(configDir)}. Start new sessions with rice-claude; no executable override is needed. The official Claude executable and updater remain intact.\n`)
    return 0
  }
  // Explicit plugin loading makes terminal and SDK invocation independent of ambient plugin settings.
  const child = spawn(selection.executable, ['--plugin-dir', plugin, ...args], { env: environment, stdio: 'inherit' })
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
  const forward = (signal: NodeJS.Signals) => child.kill(signal)
  const handlers = signals.map(signal => () => forward(signal))
  for (let index = 0; index < signals.length; index++) process.on(signals[index], handlers[index])
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', () => reject(new Error('official Claude executable could not be started')))
      child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1)))
    })
  } finally { for (let index = 0; index < signals.length; index++) process.off(signals[index], handlers[index]) }
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  process.exitCode = await launch(process.argv.slice(2)).catch(error => {
    process.stderr.write(`rice-multi-models: ${error instanceof Error ? error.message : 'native launcher failed'}\n`)
    return 1
  })
}
