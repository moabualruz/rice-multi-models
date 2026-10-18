// Runs the installed claude once, in a throwaway folder, against a loopback stub: no network, no account, none of
// the person's settings, plugins or sessions. The caller scripts the user lines and the stub's answers and reads
// what the engine sent (every request body, every stream-json event, the transcript rows it wrote). The captures
// that learn the engine's own text (compaction, tool definitions, agent prompts) are built on it.
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const RUN_LIMIT_MS = 90_000
const KEPT_ENV = ['PATH', 'Path', 'PATHEXT', 'LANG', 'LC_ALL', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'SystemDrive', 'WINDIR', 'ComSpec', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'APPDATA', 'LOCALAPPDATA', 'CLAUDE_CODE_GIT_BASH_PATH']
/** A placeholder the stub accepts; never a credential. */
const NOT_A_KEY = 'rice-capture-not-a-key'

/** What the stub answers one model request with: text, or tool calls the engine then runs. */
export type StubAnswer = { text: string } | { toolUses: readonly { id: string; name: string; input: Record<string, unknown> }[] }
export type RunEvent = Record<string, unknown> & { type?: unknown }

/** What a run has seen so far. */
export type NativeRun = {
  /** Every model request body the engine sent, parsed, in order. */
  readonly requests: readonly Record<string, unknown>[]
  /** Every stream-json event the engine printed, in order. */
  readonly events: readonly RunEvent[]
  /** The first event, already printed or still to come, that `match` accepts. */
  event(match: (event: RunEvent) => boolean): Promise<RunEvent>
}

export type NativeRunOptions = {
  /** Names the throwaway folder. */
  label: string
  /** The user lines: the first at the start, each next one after the engine's `result` for the one before; input ends after the last. */
  script: readonly string[]
  /** The answer to each model request; text `ok` when left out. */
  answer?: (body: Record<string, unknown>, run: NativeRun) => StubAnswer | Promise<StubAnswer>
  /** Files written into the isolated configuration folder first, by their path inside it. */
  files?: Readonly<Record<string, string>>
  /** More arguments for claude. */
  args?: readonly string[]
  /** Ends the run as soon as it holds, checked after each request; otherwise the run ends when claude exits. */
  done?: (run: NativeRun) => boolean
  signal?: AbortSignal
  limitMs?: number
}

export type NativeRunResult = {
  /** The installed claude's version, as it reports it. */
  version: string
  requests: readonly Record<string, unknown>[]
  events: readonly RunEvent[]
  /** Every transcript row the engine wrote, in file order. */
  transcript: readonly Record<string, unknown>[]
}

/** The installed claude, started through a shell on native Windows, where npm installs it as a .cmd shim. */
function claude(args: readonly string[]): { file: string; args: string[] } {
  return process.platform === 'win32' ? { file: 'cmd.exe', args: ['/d', '/s', '/c', 'claude', ...args] } : { file: 'claude', args: [...args] }
}

/** The text of a message's content: a string, or its text blocks joined. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : '')).join('\n')
}

function sse(response: ServerResponse, model: string, answer: StubAnswer): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const send = (event: string, value: unknown) => response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`)
  const calls = 'toolUses' in answer ? answer.toolUses : []
  send('message_start', { type: 'message_start', message: { id: 'rice-capture', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
  if ('text' in answer) {
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer.text } })
    send('content_block_stop', { type: 'content_block_stop', index: 0 })
  }
  calls.forEach((call, index) => {
    send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } })
    send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } })
    send('content_block_stop', { type: 'content_block_stop', index })
  })
  send('message_delta', { type: 'message_delta', delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } })
  send('message_stop', { type: 'message_stop' })
  response.end()
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

/** Ends claude and everything it started: its process group, or its process tree on Windows. */
function stop(child: ChildProcess): void {
  if (child.pid === undefined) return
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).once('error', () => {})
  else try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
}

async function version(env: NodeJS.ProcessEnv, cwd: string, signal: AbortSignal): Promise<string> {
  const command = claude(['--version'])
  const child = spawn(command.file, command.args, { cwd, env, signal, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  let out = ''
  child.stdout.on('data', bytes => { out += bytes })
  await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(`claude --version exited ${code}`))) })
  const found = /^(\S+) \(Claude Code\)/.exec(out.trim())?.[1]
  if (!found) throw new Error('the installed claude did not report a version')
  return found
}

async function transcriptRows(projects: string): Promise<Record<string, unknown>[]> {
  let files: string[]
  try { files = (await readdir(projects, { recursive: true })).filter(name => typeof name === 'string' && name.endsWith('.jsonl')).sort() } catch { return [] }
  const rows: Record<string, unknown>[] = []
  for (const file of files) {
    for (const line of (await readFile(path.join(projects, file), 'utf8')).split('\n')) {
      if (!line) continue
      try { rows.push(JSON.parse(line) as Record<string, unknown>) } catch { /* a partial last line */ }
    }
  }
  return rows
}

/** Runs the installed claude headless over the script; rejects when it does not finish the script or the run is stopped. */
export async function runNative(options: NativeRunOptions): Promise<NativeRunResult> {
  const root = await mkdtemp(path.join(tmpdir(), `rice-native-${options.label}-`))
  const config = path.join(root, '.claude')
  const deadline = AbortSignal.timeout(options.limitMs ?? RUN_LIMIT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
  const requests: Record<string, unknown>[] = []
  const events: RunEvent[] = []
  const waiting: { match: (event: RunEvent) => boolean; resolve: (event: RunEvent) => void }[] = []
  let finish: (() => void) | undefined
  const run: NativeRun = {
    requests,
    events,
    event: match => {
      const seen = events.find(match)
      return seen ? Promise.resolve(seen) : new Promise(resolve => { waiting.push({ match, resolve }) })
    },
  }
  const server = createServer(async (request, response) => {
    try {
      const raw = await body(request)
      if (request.url?.startsWith('/v1/messages/count_tokens')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"input_tokens":10}'); return }
      if (request.method !== 'POST' || !request.url?.startsWith('/v1/messages')) { response.writeHead(404); response.end(); return }
      const parsed = JSON.parse(raw) as Record<string, unknown>
      requests.push(parsed)
      sse(response, typeof parsed.model === 'string' ? parsed.model : 'capture', options.answer ? await options.answer(parsed, run) : { text: 'ok' })
      if (options.done?.(run)) finish?.()
    } catch {
      if (!response.headersSent) response.writeHead(500)
      response.end()
    }
  })
  let child: ChildProcess | undefined
  let closed = false
  try {
    await mkdir(config, { recursive: true })
    const global = JSON.stringify({ hasCompletedOnboarding: true, customApiKeyResponses: { approved: [NOT_A_KEY], rejected: [] } })
    await Promise.all([writeFile(path.join(config, 'settings.json'), '{}\n'), writeFile(path.join(config, '.claude.json'), global), writeFile(path.join(root, '.claude.json'), global)])
    for (const [name, text] of Object.entries(options.files ?? {})) {
      const file = path.join(config, name)
      if (!file.startsWith(config + path.sep)) throw new Error(`${name} is outside the isolated configuration`)
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, text)
    }
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('the loopback stub did not start')
    const env: NodeJS.ProcessEnv = {}
    for (const name of KEPT_ENV) if (process.env[name] !== undefined) env[name] = process.env[name]
    Object.assign(env, { HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: NOT_A_KEY, ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' })
    const installed = await version(env, root, signal)

    const command = claude(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--setting-sources', 'user', ...(options.args ?? [])])
    child = spawn(command.file, command.args, { cwd: root, env, signal, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'ignore'] })
    const running = child
    const { script } = options
    const send = (line: string) => running.stdin!.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: line } })}\n`)
    let pending = '', results = 0
    running.stdin!.on('error', () => {})
    running.stdout!.on('data', bytes => {
      pending += bytes
      for (let newline = pending.indexOf('\n'); newline !== -1; newline = pending.indexOf('\n')) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        let event: RunEvent
        try { event = JSON.parse(line) as RunEvent } catch { continue }
        events.push(event)
        for (const wait of waiting.filter(each => each.match(event))) { waiting.splice(waiting.indexOf(wait), 1); wait.resolve(event) }
        if (event.type !== 'result') continue
        results++
        if (results < script.length) send(script[results]!)
        else running.stdin!.end()
      }
    })
    send(script[0]!)
    await new Promise<void>((resolve, reject) => {
      finish = resolve
      running.once('error', reject)
      running.once('close', () => { closed = true; results >= script.length || options.done?.(run) ? resolve() : reject(new Error(`the installed claude finished ${results} of ${script.length} capture steps`)) })
      signal.addEventListener('abort', () => reject(new Error('the capture was stopped')), { once: true })
    })
    return { version: installed, requests, events, transcript: await transcriptRows(path.join(config, 'projects')) }
  } finally {
    if (child && !closed) {
      stop(child)
      // Let it exit before its folder is removed; a process that holds a file open keeps it on Windows.
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, 5_000); child!.once('close', () => { clearTimeout(timer); resolve() }) })
    }
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}
