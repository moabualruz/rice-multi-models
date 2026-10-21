// Ordinary Claude, the production WebFetch hook and isolated public tool calls.
// Synthetic pages and providers are owned fixtures; no real account or session is read.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const fixture = mkdtempSync(join(tmpdir(), 'rice-public-fetch-'))
const config = join(fixture, '.claude'), plugin = join(fixture, 'production-plugin'), driver = join(fixture, 'driver'), nativeHttp = join(fixture, 'native-http')
const inputs = [
  { url: 'https://93.184.216.34/configured-page', prompt: 'Extract the published change.' },
  { url: 'https://93.184.216.34/native-page', prompt: 'Extract the native page.' },
  { url: 'https://93.184.216.34/direct-page', prompt: 'Extract the direct page.' },
]
const observations = [], marker = 'OWNED_SELECTED_PAGE_EXTRACTION', nativeMarker = 'OWNED_NATIVE_WEBFETCH_RESULT', directMarker = 'OWNED_DIRECT_PAGE_EXTRACTION'
let child, timedOut = false
const selectedPage = '<html><body><h1>Owned release</h1><p>The published change is ACTUAL_PAGE_EVIDENCE.</p></body></html>'
const directPage = '<html><body><h1>Owned direct source</h1><p>The direct page says DIRECT_PAGE_EVIDENCE.</p></body></html>'
const nativePage = 'Owned native source document.'
const nativeModel = { id: 'claude-haiku-5-5', lifecycle: 'active', max_tokens: 2048 }
const json = (response, body, status = 200) => { response.writeHead(status, { 'content-type': 'application/json', ...(status >= 400 ? { 'x-should-retry': 'false' } : {}) }); response.end(JSON.stringify(body)) }
const server = createServer(async (request, response) => {
  let raw = ''; for await (const bytes of request) raw += bytes
  let body; try { body = JSON.parse(raw) } catch {}
  const url = new URL(request.url, 'http://fixture')
  if (url.pathname === '/direct-page') {
    observations.push({ stage: 'direct-page', status: 200 })
    response.writeHead(200, { 'content-type': 'text/html' }); response.end(directPage); return
  }
  if (url.pathname === '/fetch') {
    const requested = body?.url
    const ok = requested === inputs[0].url
    observations.push({ stage: 'configured-service', path: url.pathname, requested, status: ok ? 200 : 503 })
    if (!ok) return json(response, { error: 'Owned configured service unavailable' }, 503)
    return json(response, { url: requested, content: selectedPage, contentType: 'text/html' })
  }
  if (url.pathname === '/selected/v1/models') return json(response, { data: [{ id: 'owned' }] })
  if (url.pathname === '/selected/v1/responses') {
    const direct = raw.includes('DIRECT_PAGE_EVIDENCE')
    observations.push({ stage: 'selected-provider', model: body?.model, pageEvidence: raw.includes('ACTUAL_PAGE_EVIDENCE') || direct, direct, noTools: !body?.tools?.length, credentialPresent: !!request.headers.authorization || !!request.headers['x-api-key'] })
    const answer = direct ? directMarker : marker
    const message = { id: 'msg_owned_fetch', type: 'message', content: [{ type: 'output_text', text: answer, annotations: [] }] }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of [{ type: 'response.created', response: { id: 'resp_owned_fetch' } }, { type: 'response.output_text.delta', output_index: 0, delta: answer }, { type: 'response.output_item.done', output_index: 0, item: message }, { type: 'response.completed', response: { id: 'resp_owned_fetch', status: 'completed', output: [message], usage: { input_tokens: 20, output_tokens: 8 } } }]) response.write(`data: ${JSON.stringify(event)}\n\n`)
    response.end(); return
  }
  observations.push({ stage: 'unexpected-provider-request', path: url.pathname })
  json(response, { error: 'Owned fixture path unavailable' }, 404)
})

function terminate() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000 })
  else try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
}
const writePlugin = (folder, name, source) => {
  mkdirSync(join(folder, '.claude-plugin'), { recursive: true }); mkdirSync(join(folder, 'hooks'), { recursive: true })
  writeFileSync(join(folder, '.claude-plugin/plugin.json'), JSON.stringify({ name, version: '1.0.0', description: 'Owned public WebFetch proof', author: { name: 'Owned fixture' } }))
  writeFileSync(join(folder, 'hooks/hooks.json'), JSON.stringify({ modules: ['./register.js'] })); writeFileSync(join(folder, 'hooks/register.js'), source)
}

try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  mkdirSync(config); mkdirSync(join(config, 'rice-multi-models'))
  const base = `http://127.0.0.1:${server.address().port}`
  cpSync(join(root, 'hooks'), join(plugin, 'hooks'), { recursive: true })
  cpSync(join(root, 'helper'), join(plugin, 'helper'), { recursive: true })
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true }); mkdirSync(join(plugin, 'dist'), { recursive: true })
  writeFileSync(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'rice-multi-models-owned-proof', version: '1.0.0', description: 'Owned production WebFetch hook fixture', author: { name: 'Owned fixture' }, license: 'MIT' }))
  writeFileSync(join(plugin, 'README.md'), 'This isolated fixture exercises the production WebFetch hook through ordinary Claude. It uses synthetic provider responses, synthetic page content and a temporary configuration directory. No account, installed plugin, real session or external page is read. It checks both configured-service extraction and the Claude Code native WebFetch fallback. The fixture is created and removed by the proof script.\n')
  const helper = await build({ absWorkingDir: root, entryPoints: { helper: 'helper/main.ts' }, outdir: join(plugin, 'dist'), outExtension: { '.js': '.mjs' }, tsconfig: join(root, 'helper/tsconfig.node.json'), bundle: true, platform: 'node', target: 'node22', format: 'esm', charset: 'utf8', legalComments: 'inline', write: false, banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" }, define: { 'process.env.WS_NO_BUFFER_UTIL': '"1"', 'process.env.WS_NO_UTF_8_VALIDATE': '"1"' }, plugins: [{ name: 'embedded-openai-instructions', setup(build) { build.onLoad({ filter: /helper[/\\]openai[/\\]instructions\.ts$/ }, async ({ path }) => { const source = readFileSync(path, 'utf8'); const instructions = readFileSync(join(dirname(path), 'instructions.md'), 'utf8').trim(); return { contents: source.replace("readFileSync(new URL('./instructions.md', import.meta.url), 'utf8').trim()", JSON.stringify(instructions)), loader: 'ts' } }) } }, { name: 'owned-loopback-direct-fetch', setup(build) { build.onLoad({ filter: /helper[/\\]web-fetch\.ts$/ }, async ({ path }) => { const source = readFileSync(path, 'utf8'); const defaultTransport = 'request: pinnedRequest, resolve: resolveAddresses'; assert.equal(source.split(defaultTransport).length - 1, 2); const loopbackRequest = `request: async (_url, init) => fetch(${JSON.stringify(`${base}/direct-page`)}, { signal: init.signal }), resolve: resolveAddresses`; return { contents: source.replaceAll(defaultTransport, loopbackRequest), loader: 'ts' } }) } }] })
  for (const file of helper.outputFiles) writeFileSync(join(plugin, 'dist', file.path.split(/[\\/]/).at(-1)), file.contents)
  copyFixtureInstructions(plugin, root)
  const selectedConfig = { providers: { selected: { kind: 'responses', baseUrl: `${base}/selected/v1`, allowHttp: true, auth: 'none', models: { owned: { maxOutputTokens: 2048 } } } } }
  writeFileSync(join(config, 'rice-multi-models.json'), JSON.stringify(selectedConfig))
  writeFileSync(join(config, 'rice-multi-models/fetch.json'), JSON.stringify({ version: 1, endpoints: [{ name: 'owned-fetch', url: `${base}/fetch`, priority: 1 }] }))
  writeFileSync(join(config, 'settings.json'), '{}'); writeFileSync(join(fixture, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }))
  const receipts = { hook: join(fixture, 'hook-receipt.json'), native: join(fixture, 'native-http.json') }
  const driverSource = `export const register=on=>{on('turn.step',async function*($,e){const outcomes=[];for(const input of ${JSON.stringify(inputs)}){const answer=await $.tool.call({tool:'WebFetch',...input});outcomes.push({isError:answer.isError===true,denied:!!answer.deny,reason:answer.deny,result:answer.result?.result,url:answer.result?.url,code:answer.result?.code,bytes:answer.result?.bytes});}const text='OWNED_PUBLIC_FETCH '+JSON.stringify(outcomes);yield{kind:'text',index:0,text};yield{kind:'stop',stopReason:'end_turn',usage:null};return{turnId:e.turnId,index:e.index,answer:text,toolUses:[],stopReason:'end_turn',usage:null};});};`
  const nativeHttpSource = `export const register=on=>{on('http.fetch',async($,e,next)=>{const url=new URL(e.url);if(url.origin!=='https://api.anthropic.com')return next(e);const body=e.init?.body?JSON.parse(e.init.body):undefined;if(url.pathname==='/v1/models'){await $.fs.write(${JSON.stringify(receipts.native)},JSON.stringify({stage:'native-models',authHandlePresent:!!e.init?.auth}));return{value:{status:200,ok:true,headers:{'content-type':'application/json'},text:JSON.stringify({data:[${JSON.stringify(nativeModel)}],has_more:false})}};}if(url.pathname==='/v1/messages'){const requested=JSON.parse(body.messages[0].content).url;await $.fs.write(${JSON.stringify(receipts.native)},JSON.stringify({stage:'native-messages',authHandlePresent:!!e.init?.auth,model:body.model,requested,webFetchTool:body.tools?.[0]?.name}));const failed=requested===${JSON.stringify(inputs[2].url)};const content=[{type:'server_tool_use',id:'srvtoolu_owned_fetch',name:'web_fetch',input:{url:requested}},...(failed?[{type:'web_fetch_tool_result_error',tool_use_id:'srvtoolu_owned_fetch',error_code:'url_not_accessible'}]:[{type:'web_fetch_tool_result',tool_use_id:'srvtoolu_owned_fetch',content:{type:'web_fetch_result',url:requested,retrieved_at:'2026-10-21T00:00:00Z',content:{type:'document',title:'Owned native page',citations:{enabled:false},source:{type:'text',media_type:'text/plain',data:${JSON.stringify(nativePage)}}}}},{type:'text',text:${JSON.stringify(nativeMarker)}}])];return{value:{status:200,ok:true,headers:{'content-type':'application/json'},text:JSON.stringify({id:'msg_owned_fetch',type:'message',role:'assistant',model:body.model,content,stop_reason:'end_turn',usage:{input_tokens:20,output_tokens:8}})}};}throw new Error('Owned unexpected first-party WebFetch path');}).catch(async($,e,next)=>{await $.fs.write(${JSON.stringify(receipts.hook)},JSON.stringify({phase:'native-http-fixture',kind:next.error.kind}));return{value:{status:503,ok:false,headers:{},text:'{}'}};});};`
  writePlugin(driver, 'owned-public-fetch-caller', driverSource); writePlugin(nativeHttp, 'owned-public-fetch-native-http', nativeHttpSource)
  const env = Object.fromEntries(['PATH', 'PATHEXT', 'TMPDIR', 'LANG', 'SystemRoot', 'SystemDrive', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'ProgramFiles', 'ProgramFiles(x86)', 'CLAUDE_CODE_GIT_BASH_PATH'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  Object.assign(env, { HOME: fixture, USERPROFILE: fixture, CLAUDE_CONFIG_DIR: config, RICE_MULTI_MODELS_NODE: process.execPath, ANTHROPIC_API_KEY: 'owned-fixture-only', ANTHROPIC_UNIX_SOCKET: join(fixture, 'unused-native.sock'), DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })
  const native = process.env.RICE_CLAUDE_EXECUTABLE ?? 'claude'
  for (const path of [nativeHttp, driver]) {
    const validated = spawnSync(native, ['plugin', 'validate', '--strict', path], { env, cwd: fixture, encoding: 'utf8', timeout: 15000 })
    assert.equal(validated.status, 0, 'owned public fixture plugins validate')
  }
  const doctor = spawnSync(native, ['-p', '--model', 'selected/owned', '--plugin-dir', plugin, '--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence', '--output-format', 'json', '/rice-models doctor'], { env, cwd: fixture, encoding: 'utf8', timeout: 30000 })
  assert.equal(doctor.status, 0, 'owned helper doctor command completes')
  const approval = spawnSync(native, ['-p', '--model', 'selected/owned', '--plugin-dir', plugin, '--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence', '--output-format', 'json', '/rice-models approve selected'], { env, cwd: fixture, encoding: 'utf8', timeout: 30000 })
  assert.equal(approval.status, 0, 'owned selected provider approval command completes')
  assert.match(JSON.parse(approval.stdout).result, /Approved selected/)
  child = spawn(native, ['-p', '--model', 'selected/owned', '--plugin-dir', driver, '--plugin-dir', plugin, '--plugin-dir', nativeHttp, '--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', 'WebFetch', '--allowedTools', 'WebFetch', '--no-session-persistence', '--output-format', 'json', 'Run the owned production WebFetch proof.'], { cwd: fixture, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes)
  const timer = setTimeout(() => { timedOut = true; terminate() }, 60000)
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }); clearTimeout(timer)
  let output; try { output = JSON.parse(stdout) } catch {}
  const outcomes = typeof output?.result === 'string' && output.result.startsWith('OWNED_PUBLIC_FETCH ') ? JSON.parse(output.result.slice('OWNED_PUBLIC_FETCH '.length)) : []
  let nativeReceipt, failure
  try { nativeReceipt = JSON.parse(readFileSync(receipts.native, 'utf8')) } catch {}
  try { failure = JSON.parse(readFileSync(receipts.hook, 'utf8')) } catch {}
  const receipt = { scope: 'ordinary native CLI, production hook registration, public tool.call and permission gate; isolated HOME/config, synthetic providers and pages; no production account or external page access', code, timedOut, outcomes, observations, nativeReceipt, stderrPresent: !!stderr, ...(failure ? { failure } : {}) }
  process.stdout.write(`${JSON.stringify(receipt)}\n`)
  assert.equal(code, 0); assert.equal(timedOut, false); assert.equal(outcomes.length, 3)
  assert.deepEqual(outcomes[0], { isError: false, denied: false, result: marker, url: inputs[0].url, code: 200, bytes: Buffer.byteLength(selectedPage) })
  assert.deepEqual(outcomes[1], { isError: false, denied: false, result: nativeMarker, url: inputs[1].url, code: 200, bytes: Buffer.byteLength(nativePage) })
  assert.deepEqual(outcomes[2], { isError: false, denied: false, result: directMarker, url: inputs[2].url, code: 200, bytes: Buffer.byteLength(directPage) })
  assert.deepEqual(observations.filter(row => row.stage === 'configured-service').map(row => row.status), [200, 503, 503])
  assert.equal(observations.filter(row => row.stage === 'direct-page').length, 1)
  assert.deepEqual(observations.filter(row => row.stage === 'selected-provider').map(row => ({ pageEvidence: row.pageEvidence, direct: row.direct, noTools: row.noTools })), [{ pageEvidence: true, direct: false, noTools: true }, { pageEvidence: true, direct: true, noTools: true }])
  assert.deepEqual(nativeReceipt, { stage: 'native-messages', authHandlePresent: true, model: nativeModel.id, requested: inputs[2].url, webFetchTool: 'web_fetch' })
} finally {
  terminate(); await new Promise(resolve => server.close(resolve)); rmSync(fixture, { recursive: true, force: true })
}

function copyFixtureInstructions(pluginRoot, sourceRoot) {
  mkdirSync(join(pluginRoot, 'scripts'), { recursive: true })
  cpSync(join(sourceRoot, 'scripts/permission-context.mjs'), join(pluginRoot, 'scripts/permission-context.mjs'))
  cpSync(join(sourceRoot, 'helper/openai/instructions.md'), join(pluginRoot, 'dist/instructions.md'))
}
