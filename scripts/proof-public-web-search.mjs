// The real public tool.call boundary, ordinary native Claude, and production search mapping.
// All providers and sources are owned stand-ins. No preload, account or installation is used.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const fixture = mkdtempSync(join(tmpdir(), 'rice-public-search-'))
const config = join(fixture, '.claude'), observer = join(fixture, 'public-tool'), driver = join(fixture, 'driver'), nativeHttp = join(fixture, 'native-http')
const queries = ['OWNED_PROVIDER_QUERY', 'OWNED_CONFIGURED_QUERY', 'OWNED_NATIVE_QUERY']
const observations = [], outcomes = []
let child, timedOut = false
const providerSource = { title: 'Owned provider primary source', url: 'https://docs.example/provider' }
const serviceSource = { title: 'Owned configured primary source', url: 'https://docs.example/configured', content: 'Owned retrieved evidence.' }
const nativeSource = { title: 'Owned native primary source', url: 'https://docs.example/native' }
const nativeModel = { id: 'claude-owned-catalogue-choice', lifecycle: 'active', line: 'haiku', max_tokens: 2048, capabilities: { server_tools: { web_search: { supported: true } } } }
const json = (response, body, status = 200) => { response.writeHead(status, { 'content-type': 'application/json', ...(status >= 400 ? { 'x-should-retry': 'false' } : {}) }); response.end(JSON.stringify(body)) }
const server = createServer(async (request, response) => {
  let raw = ''; for await (const bytes of request) raw += bytes
  let body; try { body = JSON.parse(raw) } catch {}
  const url = new URL(request.url, 'http://fixture')
  if (url.pathname === '/search') {
    const query = url.searchParams.get('q')
    observations.push({ stage: 'configured', query, format: url.searchParams.get('format'), http: query === queries[1] ? 200 : 503 })
    return query === queries[1] ? json(response, { results: [serviceSource] }) : json(response, { error: 'Owned unavailable service' }, 503)
  }
  const query = queries.find(value => raw.includes(value)) ?? null
  if (url.pathname === '/selected/v1/responses') {
    observations.push({ stage: 'provider', query, model: body.model, searchTool: body.tools?.some(tool => tool.type === 'web_search'), searchContextSize: body.tools?.find(tool => tool.type === 'web_search')?.search_context_size, credentialFree: !request.headers.authorization && !request.headers['x-api-key'], http: query === queries[0] ? 200 : 429 })
    if (query !== queries[0]) return json(response, { error: { message: 'Owned provider quota exhausted' } }, 429)
    const call = { id: 'ws_owned', type: 'web_search_call', status: 'completed', action: { type: 'search', queries: [query], sources: [{ type: 'url', url: providerSource.url }] } }
    const message = { id: 'msg_owned', type: 'message', content: [{ type: 'output_text', text: 'Owned provider search answer.', annotations: [{ type: 'url_citation', ...providerSource, start_index: 0, end_index: 10 }] }] }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of [{ type: 'response.created', response: { id: 'resp_owned' } }, { type: 'response.output_item.done', output_index: 0, item: call }, { type: 'response.output_item.done', output_index: 1, item: message }, { type: 'response.completed', response: { id: 'resp_owned', status: 'completed', output: [call, message], usage: { input_tokens: 20, output_tokens: 10 } } }]) response.write(`data: ${JSON.stringify(event)}\n\n`)
    response.end(); return
  }
  if (url.pathname === '/native/v1/messages') {
    const nativeModel = /^claude-[a-z0-9-]+$/.test(body.model)
    observations.push({ stage: 'native', query, model: body.model, nativeModel, launchAccountPreserved: request.headers['x-api-key'] === 'owned-launch-key', searchTool: body.tools?.some(tool => tool.name === 'web_search'), http: nativeModel ? 200 : 400 })
    if (!nativeModel) return json(response, { type: 'error', error: { type: 'invalid_request_error', message: 'Owned native provider refuses an external model id' } }, 400)
    const content = [{ type: 'server_tool_use', id: 'srvtoolu_owned', name: 'web_search', input: { query: queries[2] } }, { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_owned', content: [{ type: 'web_search_result', ...nativeSource }] }, { type: 'text', text: 'Owned native search answer.' }]
    const message = { id: 'msg_owned_native', type: 'message', role: 'assistant', model: body.model, content, stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 20 } }
    if (!body.stream) return json(response, message)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (type, value) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`)
    send('message_start', { message: { ...message, content: [], stop_reason: null } })
    for (const [index, block] of content.entries()) {
      send('content_block_start', { index, content_block: block.type === 'text' ? { ...block, text: '' } : block.type === 'server_tool_use' ? { ...block, input: {} } : block })
      if (block.type === 'text') send('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } })
      if (block.type === 'server_tool_use') send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
      send('content_block_stop', { index })
    }
    send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } }); send('message_stop', {}); response.end(); return
  }
  observations.push({ stage: 'unexpected', path: url.pathname }); json(response, { error: 'Owned fixture path unavailable' }, 404)
})

function terminate() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000 })
  else try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
}
const writePlugin = (path, name, source) => {
  mkdirSync(join(path, '.claude-plugin'), { recursive: true }); mkdirSync(join(path, 'hooks'), { recursive: true })
  writeFileSync(join(path, '.claude-plugin/plugin.json'), JSON.stringify({ name, version: '1.0.0', description: 'Owned public WebSearch fixture', author: { name: 'Owned fixture' } }))
  writeFileSync(join(path, 'hooks/hooks.json'), JSON.stringify({ modules: ['./register.js'] })); writeFileSync(join(path, 'hooks/register.js'), source)
}

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
try {
  mkdirSync(config); mkdirSync(join(config, 'rice-multi-models'))
  const base = `http://127.0.0.1:${server.address().port}`
  const bundle = join(fixture, 'tool-search.mjs'), cli = join(fixture, 'tool-search-cli.mjs'), nativeBundle = join(observer, 'hooks/native-fallback.mjs')
  // This fixture owns its build output and never reads or rewrites shared generated dist.
  await build({ absWorkingDir: root, tsconfig: join(root, 'helper/tsconfig.node.json'), stdin: { contents: "export {runToolSearch} from './helper/search/tool-search.ts'; export {parseConfig,fingerprint} from './hooks/config.ts'", resolveDir: root, sourcefile: 'owned-public-search-entry.ts' }, outfile: bundle,
    bundle: true, platform: 'node', format: 'esm', target: 'node22', banner: { js: "import {createRequire as __createRequire} from 'node:module'; const require=__createRequire(import.meta.url);" }, define: { 'process.env.WS_NO_BUFFER_UTIL': '"1"', 'process.env.WS_NO_UTF_8_VALIDATE': '"1"' } })
  await build({ absWorkingDir: root, tsconfig: join(root, 'helper/tsconfig.node.json'), entryPoints: ['hooks/native-search.ts'], outfile: nativeBundle, bundle: true, platform: 'neutral', format: 'esm', target: 'es2023' })
  copyFileSync(join(root, 'helper/openai/instructions.md'), join(fixture, 'instructions.md'))
  const { parseConfig, fingerprint } = await import(pathToFileURL(bundle).href)
  const configText = JSON.stringify({ providers: { selected: { kind: 'responses', baseUrl: `${base}/selected/v1`, allowHttp: true, auth: 'none', models: { main: { webSearch: 'native', maxOutputTokens: 2048 } } } } })
  const parsed = parseConfig(configText); assert.ok(parsed.config, 'owned provider fixture passes production validation')
  const wire = { configText, approved: [fingerprint(parsed.config.providers.selected)], req: { target: 'selected/main', who: 'main', session: 'owned-public-session', system: '', tools: [], transcript: [] } }
  writeFileSync(cli, "import {readFileSync} from 'node:fs'; import {runToolSearch} from './tool-search.mjs'; const abort=new AbortController(); process.once('SIGTERM',()=>abort.abort()); const answer=await runToolSearch(JSON.parse(readFileSync(0,'utf8')),abort.signal); process.stdout.write(JSON.stringify(answer));\n")
  writeFileSync(join(config, 'rice-multi-models/search.json'), JSON.stringify({ version: 1, endpoints: [{ name: 'owned', kind: 'searxng', url: `${base}/search`, priority: 0 }] }))
  writeFileSync(join(config, 'settings.json'), '{}'); writeFileSync(join(fixture, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }))
  const hookFailure = join(fixture, 'hook-failure.json'), httpReceipt = join(fixture, 'public-native-http.json'), authorizationReceipt = join(fixture, 'authorization.json'), stageReceipt = join(fixture, 'search-stages.json')
  const hook = `import {runNativeSearch} from './native-fallback.mjs';export const register=on=>{const stages=[];on('tool.call',{tool:'WebSearch'},async($,e,next)=>{
    const run=await $.process.run([${JSON.stringify(process.execPath)},${JSON.stringify(cli)}],{stdin:JSON.stringify({wire:${JSON.stringify(wire)},query:e.query,allowed_domains:e.allowed_domains,blocked_domains:e.blocked_domains,mode:e.mode??'extended'}),timeoutMs:65000});
    if(run.exitCode!==0){await $.fs.write(${JSON.stringify(hookFailure)},JSON.stringify({phase:'helper-exit',exit:run.exitCode,error:run.stderr.match(/(?:Error|ERR_[A-Z_]+)[^\\n]{0,240}/g)?.slice(-3)}));throw new Error('Owned public search helper failed');}
    const result=JSON.parse(run.stdout);if(result.kind==='answered'){stages.push({query:e.query,stage:result.stage,modeDelivered:e.mode!==undefined});await $.fs.write(${JSON.stringify(stageReceipt)},JSON.stringify(stages));return{result:result.result};}
    stages.push({query:e.query,stage:result.stage,modeDelivered:e.mode!==undefined});await $.fs.write(${JSON.stringify(stageReceipt)},JSON.stringify(stages));let handle;return{result:await runNativeSearch(result.request,{authorize:async()=>{const a=await $.session.authorize();handle=a?.handle;await $.fs.write(${JSON.stringify(authorizationReceipt)},JSON.stringify({kind:a?.kind,handlePresent:!!handle}));return a;},fetch:async(url,init)=>{if(!handle||init.auth!==handle)throw new Error('Owned fallback handle mismatch');return $.http.fetch(url,init);}},next.signal)};
  }).catch(async($,e,next)=>{if(!next.called){if(!await $.fs.exists(${JSON.stringify(hookFailure)}))await $.fs.write(${JSON.stringify(hookFailure)},JSON.stringify({phase:'hook-pre-dispatch',kind:next.error.kind,message:next.error.message.slice(0,240)}));return{deny:'Owned search fixture preparation failed'};}throw new Error('Owned search fixture continuation failed');});};`
  const caller = `export const register=on=>{on('turn.step',async function*($,e){const outcomes=[];
    for(const [index,query] of ${JSON.stringify(queries)}.entries()){const result=await $.tool.call({tool:'WebSearch',query,...(index===1?{}:{allowed_domains:['docs.example']}),mode:'extended'});outcomes.push({query,isError:result.isError===true,denied:!!result.deny,sourceUrls:result.result?.results?.flatMap(group=>typeof group==='string'?[]:group.content.map(source=>source.url))??[]});}
    const answer='OWNED_PUBLIC_SEARCH '+JSON.stringify(outcomes);yield{kind:'text',index:0,text:answer};yield{kind:'stop',stopReason:'end_turn',usage:null};return{turnId:e.turnId,index:e.index,answer,toolUses:[],stopReason:'end_turn',usage:null};
  });};`
  const httpMock = `export const register=on=>{const rows=[];on('http.fetch',async($,e,next)=>{
    const url=new URL(e.url);if(url.origin!=='https://api.anthropic.com')return next(e);
    const body=e.init?.body?JSON.parse(e.init.body):undefined;
    rows.push({stage:url.pathname==='/v1/models'?'native-catalogue':'native-public-search',host:url.host,authHandlePresent:!!e.init?.auth,model:body?.model,query:body?.messages?.[0]?.content,allowedDomains:body?.tools?.[0]?.allowed_domains,maxUses:body?.tools?.[0]?.max_uses});
    await $.fs.write(${JSON.stringify(httpReceipt)},JSON.stringify(rows));
    if(url.pathname==='/v1/models')return{value:{status:200,ok:true,headers:{'content-type':'application/json'},text:JSON.stringify({data:[${JSON.stringify(nativeModel)}],has_more:false})}};
    if(url.pathname==='/v1/messages')return{value:{status:200,ok:true,headers:{'content-type':'application/json'},text:JSON.stringify({type:'message',role:'assistant',model:body.model,content:[{type:'server_tool_use',id:'srvtoolu_owned_public',name:'web_search',input:{query:${JSON.stringify(queries[2])}}},{type:'web_search_tool_result',tool_use_id:'srvtoolu_owned_public',content:[{type:'web_search_result',...${JSON.stringify(nativeSource)}}]}],stop_reason:'end_turn'})}};
    throw new Error('Owned unexpected first-party public path');
  }).catch(async($,e,next)=>{await $.fs.write(${JSON.stringify(hookFailure)},JSON.stringify({phase:'http-fixture-handler',kind:next.error.kind,message:next.error.message.slice(0,240)}));return{value:{status:503,ok:false,headers:{},text:'{}'}};});};`
  writePlugin(observer, 'owned-public-search', hook); writePlugin(driver, 'owned-public-caller', caller)
  writePlugin(nativeHttp, 'owned-public-native-http', httpMock)
  const env = Object.fromEntries(['PATH', 'PATHEXT', 'TMPDIR', 'LANG', 'SystemRoot', 'SystemDrive', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'ProgramFiles', 'ProgramFiles(x86)', 'CLAUDE_CODE_GIT_BASH_PATH'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  // Keep first-party origin ownership for authorize(), but block any native SDK
  // connection outside the explicitly mocked public HTTP operations.
  Object.assign(env, { HOME: fixture, USERPROFILE: fixture, CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: 'sk-ant-owned-public-search', ANTHROPIC_UNIX_SOCKET: join(fixture, 'unused-native.sock'), DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' })
  const native = process.env.RICE_CLAUDE_EXECUTABLE ?? 'claude'
  for (const path of [nativeHttp, observer, driver]) {
    const checked = spawnSync(native, ['plugin', 'validate', '--strict', path], { cwd: fixture, env, encoding: 'utf8', timeout: 10000 })
    assert.equal(checked.status, 0, 'owned public tool plugin validates')
  }
  child = spawn(native, ['-p', '--model', 'selected/main', '--plugin-dir', nativeHttp, '--plugin-dir', observer, '--plugin-dir', driver, '--debug-file', join(fixture, 'native-debug.log'), '--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', 'WebSearch', '--allowedTools', 'WebSearch', '--no-session-persistence', '--output-format', 'json', 'Run the owned public WebSearch proof.'], { cwd: fixture, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  process.stdout.write(`${JSON.stringify({ phase: 'public-search-started', ownedPid: child.pid, preload: false, externalMainModel: 'selected/main' })}\n`)
  let stdout = '', stderr = ''
  child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes)
  const timer = setTimeout(() => { timedOut = true; terminate() }, 60000)
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }); clearTimeout(timer)
  let output; try { output = JSON.parse(stdout) } catch {}
  if (typeof output?.result === 'string' && output.result.startsWith('OWNED_PUBLIC_SEARCH ')) outcomes.push(...JSON.parse(output.result.slice('OWNED_PUBLIC_SEARCH '.length)))
  let failure, nativeOperations, authorization, stages
  try { failure = JSON.parse(readFileSync(hookFailure, 'utf8')) } catch {}
  try { nativeOperations = JSON.parse(readFileSync(httpReceipt, 'utf8')) } catch {}
  try { authorization = JSON.parse(readFileSync(authorizationReceipt, 'utf8')) } catch {}
  try { stages = JSON.parse(readFileSync(stageReceipt, 'utf8')) } catch {}
  const receipt = { scope: 'ordinary native CLI, public tool.call, production routing and native fallback; actual session.authorize with synthetic API key; first-party HTTP operation responses are owned public hooks, host credential injection and live entitlement are not exercised', code, timedOut, observations, outcomes, stages, nativeOperations, authorization, stderrPresent: stderr.length > 0, ...(failure ? { failure } : {}) }
  process.stdout.write(`${JSON.stringify(receipt)}\n`)
  assert.equal(code, 0, 'ordinary native public search process exits successfully'); assert.equal(timedOut, false); assert.equal(outcomes.length, 3)
  assert.deepEqual(outcomes.map(outcome => outcome.sourceUrls), [[providerSource.url], [serviceSource.url], [nativeSource.url]], 'provider, configured service and public native fallback each return their own sources')
  assert.deepEqual(stages.map(row => row.stage), ['provider-native', 'configured-service', 'claude-native'], 'each registered public call records the stage that answered')
  assert.deepEqual(stages.map(row => row.query), queries)
  // Whether this headless build hands the model's own mode to tool.call is recorded; the helper is given extended either way.
  process.stdout.write(`${JSON.stringify({ modeDeliveredByClaude: stages.map(row => row.modeDelivered) })}\n`)
  assert.ok(outcomes.every(outcome => !outcome.isError && !outcome.denied), 'native tool accepts every public result')
  assert.equal(observations.filter(row => row.stage === 'provider').length, 3)
  // The second query has no domain list and reaches the service. The third carries one, the searxng service has no field for it, so it is skipped and Claude's native search answers.
  assert.equal(observations.filter(row => row.stage === 'configured').length, 1)
  assert.equal(observations.filter(row => row.stage === 'native').length, 0, 'external main model never reaches the original native SDK search')
  assert.deepEqual(authorization, { kind: 'api-key', handlePresent: true })
  assert.equal(nativeOperations.length, 2); assert.ok(nativeOperations.every(row => row.authHandlePresent))
  assert.equal(nativeOperations[1].model, nativeModel.id); assert.equal(nativeOperations[1].query, queries[2]); assert.deepEqual(nativeOperations[1].allowedDomains, ['docs.example']); assert.equal(nativeOperations[1].maxUses, undefined, 'Rice adds no search count bound')
  assert.ok(observations.filter(row => row.stage === 'provider').every(row => row.searchContextSize === 'high'), 'the native mode reaches the provider request as its depth field')
} finally {
  terminate(); await new Promise(resolve => server.close(resolve)); rmSync(fixture, { recursive: true, force: true })
}
