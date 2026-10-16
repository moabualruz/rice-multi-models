// Actual official Claude 2.1.299 WebSearch consumer, isolated account/config,
// direct stand-in provider/retrieval services, and a denied Anthropic endpoint.
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const fixture = mkdtempSync(join(tmpdir(), 'rice-native-search space-'))
const plugin = join(fixture, 'plugin space'), configDir = join(fixture, '.claude')
const query = 'RICE_NATIVE_SEARCH_OWNED_QUERY'
const sourceUrl = 'https://code.claude.com/docs/en/plugins/mods'
const sourceTitle = 'Owned primary search source'
const sourceText = 'RICE_NATIVE_SEARCH_SOURCE_CONTENT'
const synthesis = `RICE_NATIVE_SEARCH_SYNTHESIS [${sourceTitle}](${sourceUrl}). ${sourceText}`
const searches = [], providers = [], denied = []
let child, timer, forceTimer, stdout = '', stderr = ''

function json(response, value) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)) }
const search = createServer((request, response) => {
  const url = new URL(request.url, 'http://fixture')
  searches.push({ path: url.pathname, queryKnown: url.searchParams.get('q') === query, json: url.searchParams.get('format') === 'json' })
  json(response, { results: [
    { title: sourceTitle, url: sourceUrl, content: sourceText },
    { title: 'Excluded source', url: 'https://unrelated.example/excluded', content: 'Excluded by the native allowed_domains policy.' },
  ] })
})
const provider = createServer(async (request, response) => {
  let text = ''
  for await (const bytes of request) {
    text += bytes
    if (text.length > 2 * 1024 * 1024) { response.writeHead(413); response.end(); return }
  }
  const body = text ? JSON.parse(text) : {}
  if (request.method === 'GET' && request.url === '/owned/v1/models') return json(response, { data: [{ id: 'main', context_window: 500000, max_output_tokens: 4096 }] })
  if (request.method === 'POST' && request.url === '/owned/v1/chat/completions') {
    const queryInference = Boolean(body.response_format?.json_schema?.schema?.properties?.query)
    providers.push({ model: body.model, queryInference, sourceFiltered: !text.includes('unrelated.example'), sourceEvidence: text.includes(sourceText), nativeCredentials: Boolean(request.headers.authorization || request.headers['x-api-key'] || request.headers['x-goog-api-key']) })
    const content = queryInference ? JSON.stringify({ query }) : synthesis
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10 } })}\n\n`)
    response.end('data: [DONE]\n\n')
    return
  }
  if (request.method === 'POST' && /\/messages(?:\/count_tokens)?(?:\?|$)/.test(request.url)) denied.push({ path: request.url.split('?')[0] })
  response.writeHead(429, { 'content-type': 'application/json', 'x-should-retry': 'false' })
  response.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Owned fixture: Claude subscription exhausted' } }))
})

function trace() {
  try { return readFileSync(join(fixture, 'native.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch { return [] }
}
function terminate(signal) {
  if (!child || !Number.isSafeInteger(child.pid) || child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch (error) { if (error.code !== 'ESRCH') throw error }
}
function replace(source, anchor, replacement) {
  assert.equal(source.split(anchor).length, 2, `the owned native fixture seam is unique: ${anchor.slice(0, 55)}`)
  return source.replace(anchor, replacement)
}

await Promise.all([new Promise(resolve => provider.listen(0, '127.0.0.1', resolve)), new Promise(resolve => search.listen(0, '127.0.0.1', resolve))])
try {
  mkdirSync(plugin)
  mkdirSync(join(configDir, 'plugins'), { recursive: true })
  mkdirSync(join(configDir, 'rice-multi-models'))
  for (const directory of ['.claude-plugin', 'hooks', 'types', 'dist']) cpSync(join(root, directory), join(plugin, directory), { recursive: true })
  writeFileSync(join(configDir, 'plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'rice-multi-models@rice-mods': [{ scope: 'user', installPath: plugin }] } }))
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'rice-multi-models@rice-mods': true } }))
  writeFileSync(join(fixture, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }))
  const base = `http://127.0.0.1:${provider.address().port}`
  writeFileSync(join(configDir, 'rice-multi-models.json'), JSON.stringify({ providers: { owned: { kind: 'openai', baseUrl: `${base}/owned/v1`, allowHttp: true, auth: 'none', models: { main: { contextWindow: 500000, maxOutputTokens: 4096, maxTokensParam: 'max_completion_tokens' } } } } }))
  writeFileSync(join(configDir, 'rice-multi-models/search.json'), JSON.stringify({ version: 1, endpoints: [{ name: 'owned-search', kind: 'searxng', url: `http://127.0.0.1:${search.address().port}/search`, priority: 10 }] }))
  const file = join(plugin, 'hooks/register.ts')
  let source = readFileSync(file, 'utf8')
  source = replace(source, 'export const register: Register = on => {', 'let ownedSearchDone = false\nexport const register: Register = on => {')
  source = replace(source, '    const started = await next(e)', `    await $.state.set({ plugin: 'rice-multi-models', key: 'prefs' }, { effort: null, transport: 'sse', helper: 'once', workers: 'read' })\n    const started = await next(e)`)
  // Approval is limited to the isolated owned endpoint, using the production fingerprint.
  source = source.replaceAll('    await loadProviders($)', `    await loadProviders($)\n    if (!loaded.config) throw new Error('owned search fixture configuration must validate')\n    for (const provider of Object.values(loaded.config.providers)) await $.store.set(TRUST_PREFIX + fingerprint(provider), true)`)
  source = replace(source, "  on('turn.step', async function* ($, e, next) {", `  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined && !ownedSearchDone) {
      ownedSearchDone = true
      const called = await $.tool.call({ tool: 'WebSearch', query: ${JSON.stringify(query)}, allowed_domains: ['code.claude.com'] })
      const answer = JSON.stringify({ isError: called.isError, deny: called.deny, result: called.result })
      yield { kind: 'text', index: 0, text: answer }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }
      return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn', usage: null }
    }
  `)
  writeFileSync(file, source)
  const environment = Object.fromEntries(['PATH', 'TMPDIR', 'LANG', 'SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'RICE_CLAUDE_EXECUTABLE'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  Object.assign(environment, { HOME: fixture, USERPROFILE: fixture, CLAUDE_CONFIG_DIR: configDir, CODEX_HOME: join(fixture, '.codex'), ANTHROPIC_API_KEY: 'owned-no-account', ANTHROPIC_BASE_URL: `${base}/anthropic`,
    RICE_MULTI_MODELS_NATIVE_TRACE: join(fixture, 'native.jsonl'), DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' })
  child = spawn(process.execPath, [join(plugin, 'dist/launch.mjs'), '-p', '--model', 'owned/main', '--setting-sources', 'user', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--allowedTools', 'WebSearch', '--no-session-persistence', '--output-format', 'json', '--', 'Run the owned native WebSearch fixture.'], { cwd: fixture, env: environment, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  process.stdout.write(`${JSON.stringify({ phase: 'native-search-start', ownedPid: child.pid, fixture })}\n`)
  child.stdout.on('data', bytes => stdout += bytes)
  child.stderr.on('data', bytes => stderr += bytes)
  timer = setTimeout(() => { terminate('SIGTERM'); forceTimer = setTimeout(() => terminate('SIGKILL'), 5000) }, 60000)
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  clearTimeout(timer); clearTimeout(forceTimer)
  const result = JSON.parse(stdout)
  assert.equal(code, 0, 'actual native WebSearch process exits successfully')
  assert.equal(result.is_error, false, 'actual native run reports success')
  const called = JSON.parse(result.result)
  assert.ok(!called.isError && !called.deny, 'native WebSearch consumer returns a successful tool result')
  const rendered = JSON.stringify(called.result)
  assert.ok(rendered.includes(sourceUrl) && rendered.includes(sourceTitle), 'native consumer keeps the retrieved source URL and title')
  assert.ok(rendered.includes(sourceText), 'native consumer keeps plaintext source evidence')
  assert.ok(!rendered.includes('unrelated.example'), 'native allowed_domains is honored')
  const frames = trace()
  assert.ok(frames.some(event => event.phase === 'search' && event.stage === 'query' && event.queryKnown === true), 'actual WebSearch SDK request retains its tool-call query ownership')
  assert.equal(searches.length, 1, 'one configured retrieval service receives the request')
  assert.ok(searches[0].queryKnown && searches[0].json, 'configured service receives the original query and JSON format')
  assert.ok(providers.every(event => event.model === 'main' && !event.nativeCredentials && !event.queryInference), 'only the selected direct provider synthesizes evidence, without native credentials or query inference')
  assert.ok(providers.length <= 1 && providers.every(event => event.sourceFiltered && event.sourceEvidence), 'filtered plaintext evidence reaches at most one synthesis request')
  assert.equal(denied.length, 0, 'exhausted Claude endpoint receives no inference request')
  process.stdout.write(`${JSON.stringify({ phase: 'native-search-complete', queryOwned: true, retrievalRequests: searches.length, synthesisRequests: providers.length, nativeConsumerSources: true, domainPolicy: true, anthropicInference: denied.length })}\n`)
} catch (error) {
  process.stdout.write(`${JSON.stringify({ phase: 'native-search-failed', message: error instanceof Error ? error.message : 'proof failed', searches, providers, denied, trace: trace(), stderrPresent: Boolean(stderr), outputPresent: Boolean(stdout) })}\n`)
  throw error
} finally {
  clearTimeout(timer); clearTimeout(forceTimer)
  terminate('SIGTERM')
  await Promise.all([new Promise(resolve => provider.close(resolve)), new Promise(resolve => search.close(resolve))])
  rmSync(fixture, { recursive: true, force: true })
}
