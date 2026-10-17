// Ordinary Claude, production title/turn hooks and an owned direct provider.
// The native endpoint is exhausted; no launcher, preload or real account is used.
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = process.env.RICE_TITLE_PROOF_SOURCE_ROOT || fileURLToPath(new URL('../', import.meta.url))
const retained = process.env.RICE_PROOF_STATE_DIR || join(tmpdir(), 'rice-multi-models-proofs')
mkdirSync(retained, { recursive: true })
const fixture = mkdtempSync(join(retained, 'public-titles-')), plugin = join(fixture, 'plugin')
const native = process.env.RICE_CLAUDE_EXECUTABLE || 'claude'
const interactive = process.argv.includes('--interactive')
const prompt = 'Verify the owned session naming fixture and return only RICE_TITLE_MAIN_OK.'
const generatedTitle = 'Owned selected provider title', manualTitle = 'Owner supplied manual title'
const fallbackTitle = prompt.replace(/\s+/g, ' ').trim().slice(0, 80)
const requests = [], runs = [], sourceHashes = {}
let child, phase = 'setup', failure
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = (response, value, status) => {
  response.writeHead(status, { 'content-type': 'application/json', 'x-should-retry': 'false', 'retry-after': '0' })
  response.end(JSON.stringify(value))
}
function answer(response, text) {
  const message = { id: 'msg_owned_title', type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }
  const events = [
    { type: 'response.created', response: { id: 'resp_owned_title' } },
    { type: 'response.output_text.delta', output_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item: message },
    { type: 'response.completed', response: { id: 'resp_owned_title', status: 'completed', output: [message], usage: { input_tokens: 20, output_tokens: 12 } } },
  ]
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`)
  response.end()
}
const server = createServer(async (request, response) => {
  let raw = ''; for await (const bytes of request) raw += bytes
  let body; try { body = JSON.parse(raw) } catch {}
  const title = typeof body?.instructions === 'string' && body.instructions.startsWith('Name this coding session')
  const selected = request.url === '/selected/v1/responses'
  requests.push({ phase, method: request.method, path: request.url, selected, title, model: body?.model,
    ...(selected ? { credentialFree: !request.headers.authorization && !request.headers['x-api-key'], noTools: !body?.tools?.length, titlePromptOnly: title && JSON.stringify(body.input).includes(prompt), maxOutputTokens: body?.max_output_tokens } : {}) })
  if (!selected) return json(response, { type: 'error', error: { type: 'rate_limit_error', message: 'Owned exhausted native subscription' } }, 429)
  if (title && phase === 'provider-failure') return json(response, { error: { type: 'rate_limit_error', message: 'Owned unavailable selected title provider' } }, 429)
  answer(response, title ? generatedTitle : 'RICE_TITLE_MAIN_OK')
})
function terminate() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10_000 })
  else try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
}
function transcriptFiles(directory, name, depth = 0) {
  if (depth > 5 || !existsSync(directory)) return []
  const paths = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) paths.push(...transcriptFiles(path, name, depth + 1))
    else if (entry.isFile() && entry.name === name) paths.push(path)
  }
  return paths
}
function savedSession(config, id) {
  const paths = transcriptFiles(join(config, 'projects'), `${id}.jsonl`)
  const rows = paths.flatMap(path => readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return undefined } }).filter(Boolean))
  const title = rows.filter(row => row.type === 'custom-title' && row.sessionId === id).at(-1)?.customTitle
  const mainCompleted = rows.some(row => row.type === 'assistant' && JSON.stringify(row.message?.content).includes('RICE_TITLE_MAIN_OK'))
  return { paths, title, mainCompleted }
}
try {
  assert.ok(!interactive || process.stdin.isTTY, '--interactive requires an owned terminal')
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  mkdirSync(plugin)
  for (const directory of ['.claude-plugin', 'hooks', 'types', 'dist']) cpSync(join(root, directory), join(plugin, directory), { recursive: true })
  mkdirSync(join(plugin, 'scripts'))
  for (const file of ['permission-context.mjs', 'evaluator-wait.mjs']) cpSync(join(root, 'scripts', file), join(plugin, 'scripts', file))
  for (const path of ['hooks/register.ts', 'hooks/titles.ts', 'hooks/backend.ts', 'hooks/hooks.json', 'dist/helper.mjs', 'dist/helper.meta.json']) sourceHashes[path] = hash(readFileSync(join(root, path)))
  // Fixture-only provider consent and empty discovery avoid external catalogue
  // calls. Production title generation and the main routed turn stay unchanged.
  const registerPath = join(plugin, 'hooks/register.ts')
  let source = readFileSync(registerPath, 'utf8')
  const load = 'await loadProviders($)'
  assert.ok(source.includes(load), 'production provider load anchor')
  source = source.replaceAll(load, `${load}; for (const provider of Object.values(loaded.config.providers)) await $.store.set(TRUST_PREFIX + fingerprint(provider), true)`)
  const end = source.lastIndexOf('\n}')
  assert.ok(end > 0, 'production register boundary')
  source = source.slice(0, end) + `
  on('state.get', {plugin:'rice-multi-models',key:'prefs'}, () => ({value:{value:{effort:null,transport:'sse',helper:'once',workers:'read'},version:0}}))
  on('process.run', async ($, e, next) => {
    if (!e.argv.includes('discover')) return next(e)
    return {value:{exitCode:0,stdout:JSON.stringify({models:[],providers:[]}),stderr:'',isStdoutTruncated:false,isStderrTruncated:false}}
  })
` + source.slice(end)
  writeFileSync(registerPath, source)
  const cases = interactive ? [{ name: 'interactive-generated', expected: generatedTitle, titleRequests: 1 }] : [
    { name: 'generated', expected: generatedTitle, titleRequests: 1 },
    { name: 'manual-title', expected: manualTitle, titleRequests: 0, manual: true },
    { name: 'provider-failure', expected: fallbackTitle, titleRequests: 1 },
    { name: 'nonessential-disabled', expected: fallbackTitle, titleRequests: 0, disabled: true },
  ]
  for (const test of cases) {
    phase = test.name
    const home = join(fixture, test.name), config = join(home, '.claude'), id = randomUUID()
    mkdirSync(config, { recursive: true })
    const profile = { hasCompletedOnboarding: true, theme: 'dark', projects: { [fixture]: { hasTrustDialogAccepted: true } } }
    writeFileSync(join(home, '.claude.json'), JSON.stringify(profile)); writeFileSync(join(config, '.claude.json'), JSON.stringify(profile))
    writeFileSync(join(config, 'settings.json'), '{}')
    writeFileSync(join(config, 'rice-multi-models.json'), JSON.stringify({ providers: { selected: { kind: 'responses', baseUrl: `${base}/selected/v1`, allowHttp: true, auth: 'none', models: { main: { maxOutputTokens: 4096, contextWindow: 500000 } } } } }))
    const env = Object.fromEntries(['PATH', 'PATHEXT', 'TMPDIR', 'LANG', 'SystemRoot', 'SystemDrive', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'ProgramFiles', 'ProgramFiles(x86)', 'CLAUDE_CODE_GIT_BASH_PATH'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
    Object.assign(env, { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: config, CODEX_HOME: join(home, '.codex'), ANTHROPIC_API_KEY: 'sk-ant-owned-title', ANTHROPIC_BASE_URL: `${base}/native`, DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', ...(test.disabled ? { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } : {}) })
    const validation = spawnSync(native, ['plugin', 'validate', '--strict', plugin], { cwd: fixture, env, encoding: 'utf8', timeout: 10_000 })
    assert.equal(validation.status, 0, (validation.stdout + validation.stderr).slice(-2000))
    const args = [...(interactive ? [] : ['-p', '--output-format', 'json']), '--session-id', id, ...(test.manual ? ['--name', manualTitle] : []), '--model', 'selected/main', '--plugin-dir', plugin, '--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', 'Read', ...(interactive ? [] : ['--', prompt])]
    const start = requests.length, started = Date.now()
    child = spawn(native, args, { cwd: fixture, env, detached: process.platform !== 'win32', stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'] })
    console.log(JSON.stringify({ phase, ownedPid: child.pid, startedAt: new Date().toISOString(), fixture, sessionId: id, preload: false, ...(interactive ? { submit: prompt } : {}) }))
    let stdout = '', stderr = '', timedOut = false, controlledStop = false
    child.stdout?.on('data', bytes => stdout += bytes); child.stderr?.on('data', bytes => stderr += bytes)
    const deadline = setTimeout(() => { timedOut = true; terminate() }, interactive ? 90_000 : 45_000)
    const monitor = interactive ? setInterval(() => {
      if (savedSession(config, id).mainCompleted) { controlledStop = true; terminate() }
    }, 250) : undefined
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    clearTimeout(deadline); clearInterval(monitor)
    writeFileSync(join(home, 'stdout.log'), stdout); writeFileSync(join(home, 'stderr.log'), stderr)
    const saved = savedSession(config, id), observed = requests.slice(start)
    const run = { phase, id, code, signal: child.signalCode, timedOut, controlledStop, durationMs: Date.now() - started, saved, requests: observed }
    runs.push(run)
    writeFileSync(join(fixture, 'receipt.json'), JSON.stringify({ fixture, sourceHashes, runs, requests }, null, 2))
    assert.equal(timedOut, false, phase + ' bounded deadline')
    if (!interactive) assert.equal(code, 0, phase + ': ' + (stdout + stderr).slice(-2000))
    else assert.equal(controlledStop, true, 'owned interactive session stops after saved main answer')
    assert.equal(saved.mainCompleted, true, phase + ' main routed turn is saved')
    assert.equal(saved.title, test.expected, phase + ' actual persisted custom title')
    const titleRequests = observed.filter(row => row.selected && row.title)
    if (test.name === 'provider-failure') assert.ok(titleRequests.length >= 1, 'selected title provider was attempted')
    else assert.equal(titleRequests.length, test.titleRequests, phase + ' selected title requests')
    assert.ok(titleRequests.every(row => row.credentialFree && row.noTools && row.titlePromptOnly && row.maxOutputTokens === 128), 'title uses the exact selected account, submitted prompt and tool-free bounded request')
    assert.equal(observed.filter(row => !row.selected && row.method === 'POST').length, 0, phase + ' no native inference fallback')
    console.log(JSON.stringify({ phase, passed: true, title: saved.title, selectedTitleRequests: titleRequests.length, nativePosts: 0 }))
  }
  console.log(JSON.stringify({ publicTitles: true, interactive, cases: runs.length, fixture, sourceHashes }))
} catch (error) {
  failure = { phase, name: error?.name || 'Error', message: String(error?.message || error).slice(0, 4000) }
  console.error(JSON.stringify({ publicTitles: false, fixture, failure }))
  process.exitCode = 1
} finally {
  terminate()
  writeFileSync(join(fixture, 'receipt.json'), JSON.stringify({ fixture, sourceHashes, runs, requests, ...(failure ? { failure } : {}) }, null, 2))
  await new Promise(resolve => server.close(resolve))
}
