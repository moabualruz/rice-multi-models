// Ordinary native Claude with copied production hooks and the published Node helper.
// Provider responses, page retrieval and the caller are owned fixtures. No account or preload is used.
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const retained = process.env.RICE_PROOF_STATE_DIR || join(tmpdir(), 'rice-multi-models-proofs')
mkdirSync(retained, { recursive: true })
const fixture = mkdtempSync(join(retained, 'public-permissions-'))
const plugin = join(fixture, 'plugin'), config = join(fixture, '.claude')
const caller = join(fixture, 'caller')
const native = process.env.RICE_CLAUDE_EXECUTABLE || 'claude'
const interactive = process.argv.includes('--interactive')
const requests = [], runs = [], sourceHashes = {}
const phaseFile = join(fixture, 'case.json'), eventsFile = join(fixture, 'events.json')
let child, phase = 'setup', failure
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = (response, value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json', ...(status >= 400 ? { 'x-should-retry': 'false' } : {}) }); response.end(JSON.stringify(value)) }
function responseEvents(response, text, search = false) {
  const message = { id: 'msg_owned', type: 'message', content: [{ type: 'output_text', text, annotations: search ? [{ type: 'url_citation', title: 'Owned primary source', url: 'https://docs.example/permission', start_index: 0, end_index: 5 }] : [] }] }
  const output = search ? [{ id: 'ws_owned', type: 'web_search_call', status: 'completed', action: { type: 'search', queries: ['OWNED_REWRITTEN_SEARCH'], sources: [{ type: 'url', url: 'https://docs.example/permission' }] } }, message] : [message]
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const events = [{ type: 'response.created', response: { id: 'resp_owned' } }]
  if (!search) events.push({ type: 'response.output_text.delta', output_index: 0, delta: text })
  output.forEach((item, output_index) => events.push({ type: 'response.output_item.done', output_index, item }))
  events.push({ type: 'response.completed', response: { id: 'resp_owned', status: 'completed', output, usage: { input_tokens: 20, output_tokens: 12 } } })
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`)
  response.end()
}
const server = createServer(async (request, response) => {
  let raw = ''; for await (const bytes of request) raw += bytes
  let body; try { body = JSON.parse(raw) } catch {}
  const path = request.url.split('?')[0]
  if (path === '/selected/v1/responses') {
    const classifier = raw.includes('pendingAction'), search = body?.tools?.some(tool => tool.type === 'web_search') === true
    requests.push({ phase, method: request.method, path, model: body?.model, classifier, search, rewrittenSearch: raw.includes('OWNED_REWRITTEN_SEARCH'), rewrittenFetch: raw.includes('OWNED_REWRITTEN_FETCH'), completeInstructions: raw.includes('OWNED_LONG_INSTRUCTIONS_START') && raw.includes('OWNED_LONG_INSTRUCTIONS_END'), noTools: !body?.tools?.length, strictSchema: body?.text?.format?.type === 'json_schema', credentialFree: !request.headers.authorization && !request.headers['x-api-key'] })
    return responseEvents(response, classifier ? JSON.stringify({ decision: 'allow', reason: 'Only the owned requested marker is printed.' }) : search ? 'Owned search answer.' : 'OWNED_SELECTED_EXTRACTION', search)
  }
  requests.push({ phase, method: request.method, path, native: path.startsWith('/native/'), ...(body ? { model: body.model, maxTokens: body.max_tokens, nativeNaming: JSON.stringify(body.system)?.includes('You are naming a coding session') === true, systemPrefix: JSON.stringify(body.system)?.slice(0, 500), messagePrefix: JSON.stringify(body.messages)?.slice(0, 800) } : {}) })
  json(response, { type: 'error', error: { type: 'rate_limit_error', message: 'Owned exhausted native subscription' } }, 429)
})
let pages
function terminate() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000 })
  else try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
}
const compile = source => {
  const checked = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: source, encoding: 'utf8' })
  assert.equal(checked.status, 0, checked.stderr)
}
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  mkdirSync(plugin); mkdirSync(config); mkdirSync(join(plugin, 'scripts'))
  for (const directory of ['.claude-plugin', 'hooks', 'types', 'dist']) cpSync(join(root, directory), join(plugin, directory), { recursive: true })
  cpSync(join(root, 'scripts/permission-context.mjs'), join(plugin, 'scripts/permission-context.mjs'))
  for (const path of ['hooks/register.ts', 'hooks/permission.ts', 'hooks/permission-context.ts', 'hooks/tool-gate.ts', 'hooks/hooks.json', 'scripts/permission-context.mjs', 'dist/helper.mjs', 'dist/helper.meta.json']) sourceHashes[path] = hash(readFileSync(join(root, path)))
  const nativeProfile = { hasCompletedOnboarding: true, theme: 'dark', projects: { [fixture]: { hasTrustDialogAccepted: true } } }
  writeFileSync(join(fixture, '.claude.json'), JSON.stringify(nativeProfile))
  writeFileSync(join(config, '.claude.json'), JSON.stringify(nativeProfile))
  writeFileSync(join(config, 'CLAUDE.md'), 'OWNED_LONG_INSTRUCTIONS_START\n' + 'Preserve the exact owner approval gate.\n'.repeat(1500) + 'OWNED_LONG_INSTRUCTIONS_END\n')
  writeFileSync(join(config, 'rice-multi-models.json'), JSON.stringify({ providers: { selected: { kind: 'responses', baseUrl: `${base}/selected/v1`, allowHttp: true, auth: 'none', models: { main: { webSearch: 'native', maxOutputTokens: 4096, contextWindow: 500000 } } } } }))
  const key = join(fixture, 'page.key'), cert = join(fixture, 'page.crt'), openssl = join(fixture, 'openssl.cnf')
  writeFileSync(openssl, '[req]\ndistinguished_name=dn\nx509_extensions=extensions\nprompt=no\n[dn]\nCN=127.0.0.1\n[extensions]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n')
  const certificate = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-config', openssl], { encoding: 'utf8', timeout: 10000 })
  assert.equal(certificate.status, 0, 'owned page certificate generation')
  pages = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (request, response) => {
    requests.push({ phase, page: true, path: request.url, credentialFree: !request.headers.authorization && !request.headers['x-api-key'] })
    response.writeHead(200, { 'content-type': 'text/html' }); response.end('<h1>OWNED_REWRITTEN_FETCH</h1><p>Owned page evidence.</p>')
  })
  await new Promise(resolve => pages.listen(0, '127.0.0.1', resolve))
  const page = `https://127.0.0.1:${pages.address().port}/rewritten`
  // Only catalogue discovery, the provider consent store and helper preference are fixture inputs.
  // The production classifier, tool.check, tool.call and classic context handlers are unchanged.
  const registerFile = join(plugin, 'hooks/register.ts')
  let source = readFileSync(registerFile, 'utf8')
  source = source.replaceAll('await loadProviders($)', 'await loadProviders($); for (const provider of Object.values(loaded.config.providers)) await $.store.set(TRUST_PREFIX + fingerprint(provider), true)')
  const close = source.lastIndexOf('\n}')
  assert.ok(close > 0)
  source = source.slice(0, close) + `
  on('state.get', {plugin:'rice-multi-models',key:'prefs'}, () => ({value:{value:{effort:null,transport:'sse',helper:'once'},version:0}}))
  on('process.run', async ($, e, next) => {
    if (!e.argv.includes('discover')) return next(e)
    return {value:{exitCode:0,stdout:JSON.stringify({models:[],providers:[]}),stderr:'',isStdoutTruncated:false,isStderrTruncated:false}}
  })
` + source.slice(close)
  const driver = `const record=async($,row)=>{const path=${JSON.stringify(eventsFile)};const rows=await $.fs.exists(path)?JSON.parse(await $.fs.read(path)):[];rows.push(row);await $.fs.write(path,JSON.stringify(rows));};
  export const register=on=>{
    on('classic.PreToolUse',async($,e,next)=>{const result=await next(e);const test=JSON.parse(await $.fs.read(${JSON.stringify(phaseFile)}));if(!test.rewrite)return result;const updatedInput=test.call.tool==='WebSearch'?{query:'OWNED_REWRITTEN_SEARCH',allowed_domains:['docs.example']}:{url:${JSON.stringify(page)},prompt:'Extract OWNED_REWRITTEN_FETCH'};await record($,{event:'classic-rewrite',tool:test.call.tool,input:updatedInput});return{...result,updatedInput};});
    on('turn.step',async function*($,e){const test=JSON.parse(await $.fs.read(${JSON.stringify(phaseFile)}));let result;try{result=await $.tool.call(test.call);}catch(error){result={deny:'Native call refused: '+String(error?.message||error).slice(0,400),callError:true};}await record($,{event:'tool-result',result});const answer='OWNED_PERMISSIONS '+JSON.stringify(result);yield{kind:'text',index:0,text:answer};yield{kind:'stop',stopReason:'end_turn',usage:null};return{turnId:e.turnId,index:e.index,answer,toolUses:[],stopReason:'end_turn',usage:null};});
  };`
  compile(driver)
  mkdirSync(join(caller, '.claude-plugin'), { recursive: true }); mkdirSync(join(caller, 'hooks'))
  writeFileSync(join(caller, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'a-owned-permission-caller', version: '1.0.0', description: 'Owned permission proof caller', author: { name: 'Owned fixture' } }))
  writeFileSync(join(caller, 'hooks/hooks.json'), JSON.stringify({ modules: ['./register.js'] }))
  writeFileSync(join(caller, 'hooks/register.js'), driver)
  writeFileSync(registerFile, source)
  const env = Object.fromEntries(['PATH', 'PATHEXT', 'TMPDIR', 'LANG', 'SystemRoot', 'SystemDrive', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'ProgramFiles', 'ProgramFiles(x86)', 'CLAUDE_CODE_GIT_BASH_PATH'].filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]))
  Object.assign(env, { HOME: fixture, USERPROFILE: fixture, CLAUDE_CONFIG_DIR: config, CODEX_HOME: join(fixture, '.codex'), NODE_EXTRA_CA_CERTS: cert, ANTHROPIC_API_KEY: 'sk-ant-owned-permissions', ANTHROPIC_BASE_URL: `${base}/native`, CLAUDE_CODE_AUTO_MODE_SERVER: '0', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' })
  for (const folder of [caller, plugin]) {
    const checked = spawnSync(native, ['plugin', 'validate', '--strict', folder], { cwd: fixture, env, encoding: 'utf8', timeout: 10000 })
    assert.equal(checked.status, 0, (checked.stdout + checked.stderr).slice(-2000))
  }
  const bash = { tool: 'Bash', command: "/bin/sh -c 'printf OWNED_CLASSIFIER_MARKER'", description: 'Print the requested owned marker' }
  const headlessTests = [
    { name: 'auto-classifier', mode: 'auto', call: bash, permissions: {}, classifier: 1, approved: true },
    { name: 'native-deny', mode: 'auto', call: bash, permissions: { deny: ['Bash'] }, classifier: 0, approved: false },
    { name: 'forced-ask', mode: 'auto', call: bash, permissions: { ask: ['Bash'] }, classifier: 0, approved: false },
    { name: 'search-allowed-rewritten', mode: 'default', call: { tool: 'WebSearch', query: 'OWNED_ORIGINAL_SEARCH' }, permissions: { allow: ['WebSearch'] }, rewrite: true, approved: true },
    { name: 'fetch-allowed-rewritten', mode: 'default', call: { tool: 'WebFetch', url: 'https://original.example/page', prompt: 'OWNED_ORIGINAL_FETCH' }, permissions: { allow: ['WebFetch(domain:127.0.0.1)'] }, rewrite: true, approved: true },
    { name: 'search-ask-headless', mode: 'default', call: { tool: 'WebSearch', query: 'OWNED_ASK_SEARCH' }, permissions: { ask: ['WebSearch'] }, approved: false },
    { name: 'fetch-ask-headless', mode: 'default', call: { tool: 'WebFetch', url: page, prompt: 'OWNED_ASK_FETCH' }, permissions: { ask: ['WebFetch'] }, approved: false },
  ]
  assert.ok(!interactive || process.stdin.isTTY, '--interactive requires an owned real terminal')
  const tests = interactive ? ['allow-once', 'deny', 'dismiss'].map(choice => ({ name: 'tty-' + choice, mode: 'default', call: { tool: 'WebFetch', url: page, prompt: 'OWNED_TTY_' + choice }, permissions: { ask: ['WebFetch'] }, approved: choice === 'allow-once' })) : headlessTests
  for (const test of tests) {
    phase = test.name
    writeFileSync(phaseFile, JSON.stringify(test)); writeFileSync(eventsFile, '[]')
    writeFileSync(join(config, 'settings.json'), JSON.stringify({ autoMode: { classifyAllShell: true }, skipAutoPermissionPrompt: true, permissions: test.permissions }))
    const start = requests.length, started = Date.now()
    child = spawn(native, [...(interactive ? [] : ['-p', '--output-format', 'json', '--no-session-persistence']), '--model', 'selected/main', '--plugin-dir', caller, '--plugin-dir', plugin, '--setting-sources', 'user', '--permission-mode', test.mode, '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', 'Bash,WebSearch,WebFetch,AskUserQuestion', '--', 'Print only the owned marker or perform this owned local web permission fixture. Do not access any other resource.'], { cwd: fixture, env, detached: process.platform !== 'win32', stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'] })
    console.log(JSON.stringify({ phase, ownedPid: child.pid, startedAt: new Date().toISOString(), fixture, preload: false }))
    let stdout = '', stderr = '', timedOut = false
    child.stdout?.on('data', bytes => stdout += bytes); child.stderr?.on('data', bytes => stderr += bytes)
    const timer = setTimeout(() => { timedOut = true; terminate() }, interactive ? 90000 : 60000)
    const completed = interactive ? setInterval(() => {
      try { if (JSON.parse(readFileSync(eventsFile, 'utf8')).some(row => row.event === 'tool-result')) terminate() } catch { /* An in-progress receipt write is not a completed action. */ }
    }, 100) : undefined
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }); clearTimeout(timer); clearInterval(completed)
    writeFileSync(join(fixture, `${phase}.stdout.json`), stdout); writeFileSync(join(fixture, `${phase}.stderr.log`), stderr)
    let output; try { output = JSON.parse(stdout) } catch {}
    const events = JSON.parse(readFileSync(eventsFile, 'utf8')), selected = requests.slice(start).filter(row => row.path === '/selected/v1/responses')
    const result = events.find(row => row.event === 'tool-result')?.result
    const run = { phase, code, timedOut, durationMs: Date.now() - started, outputResult: output?.result, result, events, requests: requests.slice(start) }
    runs.push(run); writeFileSync(join(fixture, 'receipt.json'), JSON.stringify({ fixture, sourceHashes, runs, requests }, null, 2))
    assert.equal(timedOut, false, phase + ' bounded native deadline')
    if (!interactive) assert.equal(code, 0, phase + ': ' + (stdout + stderr).slice(-2000))
    assert.ok(result, phase + ' reaches fixture driver')
    assert.equal(selected.filter(row => row.classifier).length, test.classifier ?? 0, phase + ' selected classifier count')
    if (test.classifier) assert.ok(selected.filter(row => row.classifier).every(row => row.completeInstructions), 'complete project instructions longer than 32k reach the classifier')
    if (test.approved) {
      assert.equal(result.deny, undefined, phase + ' permitted by native path')
      assert.notEqual(result.isError, true, phase + ' successful typed tool result')
      if (test.call.tool === 'Bash') assert.ok(result.result?.stdout?.includes('OWNED_CLASSIFIER_MARKER'), 'real Bash prints selected-classifier marker')
      if (test.call.tool === 'WebSearch') { assert.equal(result.result?.query, 'OWNED_REWRITTEN_SEARCH'); assert.ok(selected.some(row => row.search && row.rewrittenSearch)) }
      if (test.call.tool === 'WebFetch') { assert.equal(result.result?.url, page); assert.equal(result.result?.result, 'OWNED_SELECTED_EXTRACTION'); if (!interactive) assert.ok(selected.some(row => row.rewrittenFetch)); assert.ok(requests.slice(start).some(row => row.page && row.path === '/rewritten')) }
    } else {
      assert.ok(result.deny || result.isError, phase + ' does not execute')
      assert.equal(selected.length, 0, phase + ' sends no selected-provider request')
      assert.equal(requests.slice(start).some(row => row.page), false, phase + ' retrieves no page')
    }
    assert.equal(requests.slice(start).some(row => row.native && row.method === 'POST' && !row.nativeNaming), false, phase + ' permission and web-tool native SDK receives no POST')
    const namingPosts = requests.slice(start).filter(row => row.native && row.method === 'POST' && row.nativeNaming).length
    console.log(JSON.stringify({ phase, passed: true, selectedRequests: selected.length, permissionNativePostCount: 0, nativeNamingPosts: namingPosts }))
  }
  assert.ok(requests.filter(row => row.path === '/selected/v1/responses' || row.page).every(row => row.credentialFree), 'synthetic provider and page never receive account credentials')
  const nativeNamingPosts = requests.filter(row => row.native && row.method === 'POST' && row.nativeNaming).length
  console.log(JSON.stringify({ publicPermissions: true, productionHelper: true, interactive, cases: runs.length, nativeNamingPosts, noObservedNativeInference: nativeNamingPosts === 0, coverage: 'exercised permission and web calls only', fixture, sourceHashes }))
} catch (error) {
  failure = { phase, name: error?.name || 'Error', message: String(error?.message || error).slice(0, 4000) }
  console.error(JSON.stringify({ publicPermissions: false, fixture, failure }))
  process.exitCode = 1
} finally {
  terminate()
  writeFileSync(join(fixture, 'receipt.json'), JSON.stringify({ fixture, sourceHashes, runs, requests, ...(failure ? { failure } : {}) }, null, 2))
  await Promise.all([new Promise(resolve => server.close(resolve)), pages ? new Promise(resolve => pages.close(resolve)) : Promise.resolve()])
}
