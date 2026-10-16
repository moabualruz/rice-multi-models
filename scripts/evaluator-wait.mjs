// Private, bounded rendezvous for a public mod hook. Node 22+, no listener.
import { randomUUID } from 'node:crypto'
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const PRIVATE_DIRECTORY_WINDOWS = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $security = [System.Security.AccessControl.DirectorySecurity]::new()
  $security.SetAccessRuleProtection($true, $false)
  $security.SetOwner($identity.User)
  $security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($identity.User, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit', [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow))
  [void][System.IO.Directory]::CreateDirectory($env:RICE_EVALUATOR_DIRECTORY, $security)
  $attributes = [System.IO.File]::GetAttributes($env:RICE_EVALUATOR_DIRECTORY)
  if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { exit 46 }
  $acl = [System.IO.Directory]::GetAccessControl($env:RICE_EVALUATOR_DIRECTORY, [System.Security.AccessControl.AccessControlSections]'Access,Owner')
  if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $identity.User.Value) { exit 46 }
  foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and $rule.IdentityReference.Value -ne $identity.User.Value) { exit 46 }
  }
  exit 0
} catch { exit 46 }
`

const fail = message => { throw new Error(message) }
const readJson = path => {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 1024 * 1024 || process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) fail('Unsafe evaluator record.')
    return JSON.parse(readFileSync(fd, 'utf8'))
  } finally { closeSync(fd) }
}

function owned(input) {
  const directory = input.directory
  if (typeof directory !== 'string' || !isAbsolute(directory) || !/^rice-evaluator-[0-9a-f-]{36}$/.test(basename(directory)) || dirname(resolve(directory)) !== resolve(tmpdir())) fail('Unknown evaluator directory.')
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) fail('Unsafe evaluator directory.')
  const marker = readJson(join(directory, 'owner.json'))
  if (typeof input.nonce !== 'string' || marker.nonce !== input.nonce) fail('Unknown evaluator owner.')
  return directory
}

function atomic(directory, name, value) {
  const temporary = join(directory, randomUUID() + '.tmp')
  writeFileSync(temporary, JSON.stringify(value), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  renameSync(temporary, join(directory, name))
}

async function wait(directory, name, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600000) fail('Invalid evaluator deadline.')
  const deadline = Date.now() + timeoutMs
  while (!existsSync(join(directory, name))) {
    if (Date.now() >= deadline) fail('The evaluator deadline expired.')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return readJson(join(directory, name))
}

export async function evaluatorWait(mode, input) {
  if (mode === 'shell') return { shell: defaultShell() }
  if (mode === 'create') {
    const directory = join(tmpdir(), 'rice-evaluator-' + randomUUID()), nonce = randomUUID()
    if (process.platform === 'win32') {
      const made = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(PRIVATE_DIRECTORY_WINDOWS, 'utf16le').toString('base64')], { env: { ...process.env, RICE_EVALUATOR_DIRECTORY: directory }, encoding: 'utf8', timeout: 15000, windowsHide: true })
      if (made.status !== 0) fail('A private evaluator directory could not be created.')
    } else mkdirSync(directory, { mode: 0o700 })
    atomic(directory, 'owner.json', { nonce })
    return { directory, nonce }
  }
  const directory = owned(input)
  if (mode === 'publish') {
    if (typeof input.agentId !== 'string' || typeof input.model !== 'string' || typeof input.text !== 'string') fail('Invalid evaluator result.')
    const verdict = JSON.parse(input.text)
    if (typeof verdict?.ok !== 'boolean' || typeof verdict.reason !== 'string' || Object.keys(verdict).some(key => !['ok', 'reason', 'impossible'].includes(key))) fail('Invalid evaluator verdict.')
    atomic(directory, 'result.json', { agentId: input.agentId, model: input.model, text: JSON.stringify(verdict) })
    return {}
  }
  if (mode === 'wait') {
    const result = await wait(directory, 'result.json', input.timeoutMs)
    if (result.agentId !== input.agentId || result.model !== input.model) fail('The evaluator result has a different owner.')
    return result
  }
  if (mode === 'hold') return wait(directory, 'released.json', input.timeoutMs)
  if (mode === 'release') { atomic(directory, 'released.json', {}); return {} }
  if (mode === 'cleanup') { rmSync(directory, { recursive: true }); return {} }
  fail('Unknown evaluator operation.')
}

function gitBash() {
  return [process.env.CLAUDE_CODE_GIT_BASH_PATH, join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'), join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe')].find(path => path && existsSync(path))
}

function defaultShell() { return process.platform === 'win32' && !gitBash() ? 'powershell' : 'bash' }

/** Execute the configured command in its native exec or shell form. */
export async function evaluatorCommand(input) {
  const hook = input.hook, event = input.event
  if (!hook || typeof hook.command !== 'string' || !event || typeof event.cwd !== 'string') fail('Invalid configured command.')
  if (hook.async || hook.asyncRewake) fail('Background hooks require the native scheduler.')
  const env = { ...process.env, CLAUDE_PROJECT_DIR: input.projectDirectory ?? event.cwd }
  if (input.pluginRoot) env.CLAUDE_PLUGIN_ROOT = input.pluginRoot
  if (input.pluginData) env.CLAUDE_PLUGIN_DATA = input.pluginData
  const expand = value => value.replace(/\$\{(CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA)\}/g, (original, name) => env[name] ?? original)
  let argv
  if (Array.isArray(hook.args) && hook.args.every(value => typeof value === 'string')) argv = [expand(hook.command), ...hook.args.map(expand)]
  else if (process.platform !== 'win32') argv = ['/bin/sh', '-c', hook.command]
  else {
    const bash = gitBash()
    if (hook.shell !== 'powershell' && bash) argv = [bash, '-c', hook.command]
    else {
      const executable = ['pwsh.exe', 'powershell.exe'].find(name => spawnSync(name, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { stdio: 'ignore', timeout: 5000, windowsHide: true }).status === 0)
      if (!executable) fail('The configured command shell is unavailable.')
      const command = hook.command.replace(/\$\{(CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA)\}/g, '${env:$1}')
      argv = [executable, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
    }
  }
  const timeoutMs = hook.timeoutMs
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600000) fail('Invalid command-hook deadline.')
  return new Promise(resolve => {
    let stdout = '', stderr = '', truncated = false, expired = false, settled = false
    const child = spawn(argv[0], argv.slice(1), { cwd: event.cwd, env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const terminate = force => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000, windowsHide: true })
      else try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM') } catch {}
    }
    let escalation
    const timer = setTimeout(() => { expired = true; terminate(false); escalation = setTimeout(() => terminate(true), 1000) }, timeoutMs)
    const append = (current, bytes) => { const next = current + bytes; if (next.length > 4 * 1024 * 1024) truncated = true; return next.slice(0, 4 * 1024 * 1024) }
    child.stdout.on('data', bytes => { stdout = append(stdout, bytes) }); child.stderr.on('data', bytes => { stderr = append(stderr, bytes) })
    const onAbort = () => { terminate(true); process.exitCode = 143 }
    const done = code => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(escalation); process.removeListener('SIGTERM', onAbort); resolve({ exitCode: code ?? 1, stdout, stderr, failed: expired || truncated }) }
    child.once('error', () => done(1)); child.once('close', done)
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(event))
    process.once('SIGTERM', onAbort)
  })
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'))
    const result = process.argv[2] === 'command' ? await evaluatorCommand(input) : await evaluatorWait(process.argv[2], input)
    process.stdout.write(JSON.stringify(result) + '\n')
  } catch {
    process.stderr.write('The private evaluator operation did not complete.\n')
    process.exitCode = 1
  }
}
