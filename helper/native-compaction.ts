// Learns Claude Code's own compaction prompt and summary message by running the installed claude once, in a
// throwaway folder, against a loopback stub: no network, no account, none of the person's settings, plugins
// or sessions. Two real `/compact` runs are recorded, one without instructions and one with a known marker,
// and hooks/native-compaction.ts turns them into a template. The caller caches the result per version.
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { deriveTemplate, INSTRUCTIONS_MARK, SUMMARY_MARK, type CompactionTemplate } from '../hooks/native-compaction.ts'

const RUN_LIMIT_MS = 90_000
const KEPT_ENV = ['PATH', 'Path', 'PATHEXT', 'LANG', 'LC_ALL', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'SystemDrive', 'WINDIR', 'ComSpec', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'APPDATA', 'LOCALAPPDATA', 'CLAUDE_CODE_GIT_BASH_PATH']

/** The installed claude, started through a shell on native Windows, where npm installs it as a .cmd shim. */
function claude(args: string[]): { file: string; args: string[] } {
  return process.platform === 'win32' ? { file: 'cmd.exe', args: ['/d', '/s', '/c', 'claude', ...args] } : { file: 'claude', args }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : '')).join('\n')
}

function sse(response: ServerResponse, model: string, reply: string): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const send = (event: string, value: unknown) => response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`)
  send('message_start', { type: 'message_start', message: { id: 'rice-capture', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } })
  send('content_block_stop', { type: 'content_block_stop', index: 0 })
  send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } })
  send('message_stop', { type: 'message_stop' })
  response.end()
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function stop(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
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

/** Runs the capture; rejects when the installed claude does not behave as expected. */
export async function captureCompaction(outer?: AbortSignal): Promise<CompactionTemplate> {
  const root = await mkdtemp(path.join(tmpdir(), 'rice-native-compaction-'))
  const config = path.join(root, '.claude')
  const deadline = AbortSignal.timeout(RUN_LIMIT_MS)
  const signal = outer ? AbortSignal.any([outer, deadline]) : deadline
  const prompts: string[] = []
  const server = createServer(async (request, response) => {
    try {
      const raw = await body(request)
      if (request.url?.startsWith('/v1/messages/count_tokens')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"input_tokens":10}'); return }
      if (request.method !== 'POST' || !request.url?.startsWith('/v1/messages')) { response.writeHead(404); response.end(); return }
      const parsed = JSON.parse(raw) as { model?: string; messages?: { content?: unknown }[] }
      const last = textOf(parsed.messages?.at(-1)?.content)
      // The summary request is the one that asks for the two blocks its answer is read by.
      const summary = last.includes('<analysis>') && last.includes('<summary>')
      if (summary) prompts.push(last)
      sse(response, parsed.model ?? 'capture', summary ? `<analysis>analysis</analysis>\n<summary>\n${SUMMARY_MARK}\n</summary>` : 'ok')
    } catch {
      response.writeHead(500); response.end()
    }
  })
  let child: ChildProcess | undefined
  try {
    await mkdir(config, { recursive: true })
    const global = JSON.stringify({ hasCompletedOnboarding: true, customApiKeyResponses: { approved: ['rice-capture-not-a-key'], rejected: [] } })
    await Promise.all([writeFile(path.join(config, 'settings.json'), '{}\n'), writeFile(path.join(config, '.claude.json'), global), writeFile(path.join(root, '.claude.json'), global)])
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('the loopback stub did not start')
    const env: NodeJS.ProcessEnv = {}
    for (const name of KEPT_ENV) if (process.env[name] !== undefined) env[name] = process.env[name]
    Object.assign(env, { HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: 'rice-capture-not-a-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' })
    const installed = await version(env, root, signal)

    const command = claude(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--setting-sources', 'user'])
    child = spawn(command.file, command.args, { cwd: root, env, signal, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'ignore'] })
    const running = child
    const script = ['capture one', '/compact', 'capture two', `/compact ${INSTRUCTIONS_MARK}`]
    const send = (line: string) => running.stdin!.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: line } })}\n`)
    let pending = '', results = 0
    running.stdout!.on('data', bytes => {
      pending += bytes
      for (let newline = pending.indexOf('\n'); newline !== -1; newline = pending.indexOf('\n')) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        let event: { type?: string }
        try { event = JSON.parse(line) as { type?: string } } catch { continue }
        if (event.type !== 'result') continue
        results++
        if (results < script.length) send(script[results]!)
        else running.stdin!.end()
      }
    })
    send(script[0]!)
    await new Promise<void>((resolve, reject) => {
      running.once('error', reject)
      running.once('close', () => results === script.length ? resolve() : reject(new Error(`the installed claude finished ${results} of ${script.length} capture steps`)))
      signal.addEventListener('abort', () => reject(new Error('the capture was stopped')), { once: true })
    })
    if (prompts.length !== 2) throw new Error(`the installed claude sent ${prompts.length} summary requests, not 2`)

    // The summary message is the transcript row the engine flags as a compaction summary.
    const projects = path.join(config, 'projects')
    const files = (await readdir(projects, { recursive: true })).filter(name => typeof name === 'string' && name.endsWith('.jsonl'))
    let summary = ''
    for (const file of files) {
      for (const line of (await readFile(path.join(projects, file), 'utf8')).split('\n')) {
        if (!line) continue
        let row: { isCompactSummary?: boolean; message?: { content?: unknown } }
        try { row = JSON.parse(line) as typeof row } catch { continue }
        if (row.isCompactSummary && !summary) summary = textOf(row.message?.content)
      }
    }
    if (!summary) throw new Error('the installed claude wrote no compaction summary row')
    const transcriptPath = /read the full transcript at: (.+)/.exec(summary)?.[1]?.trim() ?? ''
    return deriveTemplate({ version: installed, plain: prompts[0]!, custom: prompts[1]!, summaryMessage: summary, transcriptPath })
  } finally {
    if (child) stop(child)
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}
