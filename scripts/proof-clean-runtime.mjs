import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { cpSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('../', import.meta.url))
const directory = mkdtempSync(join(tmpdir(), 'rice-clean-'))
const install = join(directory, 'installed plugin with spaces')
const home = join(directory, 'empty home')
mkdirSync(install)
mkdirSync(home)
cpSync(join(source, 'dist'), join(install, 'dist'), { recursive: true })
const artifact = join(install, 'dist/helper.mjs')
const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex'), PATH: dirname(process.execPath) }
const children = new Set()
let calls = 0
const server = createServer(async (request, response) => {
  const parts = []
  for await (const part of request) parts.push(part)
  const body = JSON.parse(Buffer.concat(parts).toString('utf8'))
  assert.equal(request.url, '/v1/chat/completions')
  assert.equal(body.model, 'fixture-model')
  calls++
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end([
    { choices: [{ index: 0, delta: { content: 'clean Node response' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 } },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n')
})

function child(args) {
  const processHandle = spawn(process.execPath, [artifact, ...args], { cwd: install, env, stdio: ['pipe', 'pipe', 'pipe'] })
  children.add(processHandle)
  processHandle.once('close', () => children.delete(processHandle))
  return processHandle
}

async function run(args, input = '') {
  const processHandle = child(args)
  let output = ''
  let errors = ''
  processHandle.stdout.on('data', data => { output += data })
  processHandle.stderr.on('data', data => { errors += data })
  const ended = once(processHandle, 'close')
  const timer = setTimeout(() => processHandle.kill('SIGTERM'), 15_000)
  try {
    processHandle.stdin.end(input)
    const [code] = await ended
    assert.equal(code, 0, `helper ${args[0]} failed: ${errors.slice(0, 300)}`)
    return output
  } finally {
    clearTimeout(timer)
  }
}

function assertAnswer(output) {
  const events = output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.equal(events.filter(event => event.type === 'text').map(event => event.text).join(''), 'clean Node response')
  assert(events.some(event => event.type === 'stop' && event.reason === 'end_turn'))
  assert(!events.some(event => event.type === 'error'))
}

let session
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const configText = JSON.stringify({ providers: { fixture: { kind: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, allowHttp: true, auth: 'none', models: { 'fixture-model': { contextWindow: 128000, maxOutputTokens: 4096, maxTokensParam: 'max_tokens' } } } } })
  const wire = { configText, approved: [`openai|http://127.0.0.1:${port}|none`], req: { target: 'fixture/fixture-model', system: 'Return the fixture response.', tools: [], transcript: [{ role: 'user', content: 'hi' }], who: 'main', session: 'clean-install' } }
  const diagnostics = JSON.parse(await run(['doctor']))
  assert(diagnostics && typeof diagnostics === 'object')
  assertAnswer(await run(['once'], JSON.stringify(wire)))
  session = child(['serve'])
  let buffer = ''
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Session helper did not announce readiness')), 10_000)
    session.once('error', reject)
    session.once('close', () => { clearTimeout(timer); reject(new Error('Session helper exited before readiness')) })
    session.stdout.on('data', data => {
      buffer += data
      const line = buffer.split('\n').find(value => value.startsWith('ready '))
      if (!line) return
      clearTimeout(timer)
      resolve(JSON.parse(line.slice(6)))
    })
  })
  assert.equal(typeof ready.socketPath, 'string')
  assert.match(ready.token, /^[a-f0-9]{64}$/)
  assertAnswer(await run(['client', ready.socketPath], JSON.stringify({ ...wire, token: ready.token })))
  assert.equal(calls, 2)
  const closed = once(session, 'close')
  session.kill('SIGTERM')
  await closed
  process.stdout.write(`Clean shipped payload passed: ${process.platform} ${process.version}; no Bun, curl, jq or node_modules; once and session IPC.\n`)
} finally {
  for (const processHandle of children) processHandle.kill('SIGTERM')
  await Promise.all([...children].map(processHandle => once(processHandle, 'close')))
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  rmSync(directory, { recursive: true, force: true })
}
