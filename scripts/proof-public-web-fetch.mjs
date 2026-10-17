// Ordinary Claude and the real public WebFetch consumer, with default direct
// retrieval and selected-provider clients. All sources/accounts are owned fixtures.
// This controlled preapproved call does not qualify production permission handling.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createServer as httpServer } from 'node:http'
import { createServer as httpsServer } from 'node:https'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url))), fixture = mkdtempSync(join(tmpdir(), 'rice-public-fetch-'))
const config = join(fixture, '.claude'), plugin = join(fixture, 'plugin'), driver = join(fixture, 'driver')
const observations = [], resultMarker = 'OWNED_SELECTED_PAGE_EXTRACTION', failureMarker = 'OWNED_FETCH_QUOTA'
const pageHtml = '<html><head><script>must_not_execute()</script></head><body><h1>Owned release</h1><p>The published change is ACTUAL_PAGE_EVIDENCE.</p></body></html>'
let child, pages, provider, timedOut = false
const native = process.env.RICE_CLAUDE_EXECUTABLE || 'claude'
const writePlugin = (folder, name, source) => {
  mkdirSync(join(folder, '.claude-plugin'), { recursive: true }); mkdirSync(join(folder, 'hooks'), { recursive: true })
  writeFileSync(join(folder, '.claude-plugin/plugin.json'), JSON.stringify({ name, version: '1.0.0', description: 'Owned public WebFetch proof', author: { name: 'Owned fixture' } }))
  writeFileSync(join(folder, 'hooks/hooks.json'), JSON.stringify({ modules: ['./register.js'] })); writeFileSync(join(folder, 'hooks/register.js'), source)
}
function terminate() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000 })
  else try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
}
try {
  const checkedOpenSsl = spawnSync('openssl', ['version'], { encoding: 'utf8', timeout: 5000 })
  assert.equal(checkedOpenSsl.status, 0, 'owned HTTPS fixture requires an existing openssl CLI')
  const key = join(fixture, 'fixture.key'), certificate = join(fixture, 'fixture.crt'), sslConfig = join(fixture, 'fixture.cnf')
  writeFileSync(sslConfig, '[req]\ndistinguished_name=dn\nx509_extensions=extensions\nprompt=no\n[dn]\nCN=127.0.0.1\n[extensions]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n')
  // Synthetic TLS identity, created and removed only inside this owned fixture.
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', certificate, '-days', '1', '-config', sslConfig], { stdio: 'ignore', timeout: 10000 })
  assert.equal(generated.status, 0, 'owned HTTPS certificate generation')
  pages = httpsServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (request, response) => {
    observations.push({ stage: 'retrieval', path: request.url, accountHeadersPresent: !!request.headers.authorization || !!request.headers['x-api-key'] })
    response.writeHead(200, { 'content-type': 'text/html' }); response.end(pageHtml)
  })
  provider = httpServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part
    if (request.url?.startsWith('/native/')) {
      observations.push({ stage: 'forbidden-native-fallback', path: request.url })
      response.writeHead(429, { 'content-type': 'application/json', 'x-should-retry': 'false' }); response.end('{"error":{"message":"Owned native quota exhausted"}}'); return
    }
    const body = JSON.parse(raw), quota = raw.includes(failureMarker)
    observations.push({ stage: 'selected-provider', path: request.url, model: body.model, http: quota ? 429 : 200, pageEvidence: raw.includes('ACTUAL_PAGE_EVIDENCE'), privateContextAbsent: !raw.includes('UNRELATED_PRIVATE_CONTEXT'), noTools: !body.tools?.length })
    if (quota) { response.writeHead(429, { 'content-type': 'application/json' }); response.end('{"error":{"message":"Owned selected quota exhausted"}}'); return }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const message = { id: 'msg_owned_fetch', type: 'message', content: [{ type: 'output_text', text: resultMarker, annotations: [] }] }
    for (const event of [{ type: 'response.created', response: { id: 'resp_owned_fetch' } }, { type: 'response.output_text.delta', output_index: 0, delta: resultMarker }, { type: 'response.output_item.done', output_index: 0, item: message }, { type: 'response.completed', response: { id: 'resp_owned_fetch', status: 'completed', output: [message], usage: { input_tokens: 20, output_tokens: 8 } } }]) response.write(`data: ${JSON.stringify(event)}\n\n`)
    response.end()
  })
  await Promise.all([new Promise(resolve => pages.listen(0, '127.0.0.1', resolve)), new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))])
  const pageUrl = `https://127.0.0.1:${pages.address().port}/page`, base = `http://127.0.0.1:${provider.address().port}`
  const bundle = join(fixture, 'web-fetch.mjs'), cli = join(fixture, 'web-fetch-cli.mjs')
  await build({ absWorkingDir: root, tsconfig: join(root, 'helper/tsconfig.node.json'), stdin: { contents: "export {runWebFetch} from './helper/web-fetch.ts';export {parseConfig,fingerprint} from './hooks/config.ts'", resolveDir: root, sourcefile: 'owned-web-fetch-entry.ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22', banner: { js: "import {createRequire as __createRequire} from 'node:module';const require=__createRequire(import.meta.url);" }, define: { 'process.env.WS_NO_BUFFER_UTIL': '"1"', 'process.env.WS_NO_UTF_8_VALIDATE': '"1"' } })
  copyFileSync(join(root, 'helper/openai/instructions.md'), join(fixture, 'instructions.md'))
  const { parseConfig, fingerprint } = await import(pathToFileURL(bundle).href)
  const configText = JSON.stringify({ providers: { selected: { kind: 'responses', baseUrl: `${base}/selected/v1`, allowHttp: true, auth: 'none', models: { owned: {} } } } })
  const parsed = parseConfig(configText); assert.ok(parsed.config, 'provider fixture passes production config validation')
  const wire = { configText, approved: [fingerprint(parsed.config.providers.selected)], req: { target: 'selected/owned', who: 'main', session: 'owned-fetch-session', system: 'UNRELATED_PRIVATE_CONTEXT', tools: [], transcript: [] } }
  writeFileSync(cli, "import{readFileSync}from'node:fs';import{runWebFetch}from'./web-fetch.mjs';const abort=new AbortController();process.once('SIGTERM',()=>abort.abort());try{process.stdout.write(JSON.stringify(await runWebFetch(JSON.parse(readFileSync(0,'utf8')),abort.signal)));}catch(error){process.stdout.write(JSON.stringify({error:{phase:error.phase,message:error.name==='WebFetchUnavailable'?error.message:'Owned fetch failure'}}));process.exitCode=1;}\n")
  const helperFailure = join(fixture, 'failure.json')
  const observer = `export const register=on=>{on('tool.call',{tool:'WebFetch'},async($,e,next)=>{
    const run=await $.process.run([${JSON.stringify(process.execPath)},${JSON.stringify(cli)}],{stdin:JSON.stringify({wire:${JSON.stringify(wire)},url:e.url,prompt:e.prompt,offset:e.offset}),timeoutMs:125000});
    const answer=JSON.parse(run.stdout);if(run.exitCode!==0){await $.fs.write(${JSON.stringify(helperFailure)},JSON.stringify({phase:answer.error?.phase,selectedProviderFailed:true}));return{deny:'Owned selected provider extraction failed; no Claude fallback'};}return{result:answer};
  }).catch(()=>({deny:'Owned public fetch preparation failed; no native fallback'}));};`
  const caller = `export const register=on=>{on('turn.step',async function*($,e){const outcomes=[];for(const prompt of ['Extract the published change.',${JSON.stringify(failureMarker)}]){const answer=await $.tool.call({tool:'WebFetch',url:${JSON.stringify(pageUrl)},prompt});outcomes.push({isError:answer.isError===true,denied:!!answer.deny,result:answer.result?.result,url:answer.result?.url,code:answer.result?.code,bytes:answer.result?.bytes});}const answer='OWNED_PUBLIC_FETCH '+JSON.stringify(outcomes);yield{kind:'text',index:0,text:answer};yield{kind:'stop',stopReason:'end_turn',usage:null};return{turnId:e.turnId,index:e.index,answer,toolUses:[],stopReason:'end_turn',usage:null};});};`
  writePlugin(plugin, 'owned-public-fetch', observer); writePlugin(driver, 'owned-fetch-caller', caller)
  mkdirSync(config); writeFileSync(join(config, 'settings.json'), '{}'); writeFileSync(join(fixture, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }))
  const env = Object.fromEntries(['PATH', 'PATHEXT', 'TMPDIR', 'LANG', 'SystemRoot', 'SystemDrive', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'ProgramFiles', 'ProgramFiles(x86)', 'CLAUDE_CODE_GIT_BASH_PATH'].filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]))
  Object.assign(env, { HOME: fixture, USERPROFILE: fixture, CLAUDE_CONFIG_DIR: config, NODE_EXTRA_CA_CERTS: certificate, ANTHROPIC_API_KEY: 'owned-no-real-auth', ANTHROPIC_BASE_URL: `${base}/native`, DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })
  for (const folder of [plugin, driver]) {
    const checked = spawnSync(native, ['plugin', 'validate', '--strict', folder], { cwd: fixture, env, encoding: 'utf8', timeout: 10000 })
    assert.equal(checked.status, 0, 'owned public WebFetch plugin validates')
  }
  child = spawn(native, ['-p', '--model', 'selected/owned', '--plugin-dir', plugin, '--plugin-dir', driver, '--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', 'WebFetch', '--allowedTools', 'WebFetch', '--no-session-persistence', '--output-format', 'json', 'Run the owned public WebFetch proof.'], { cwd: fixture, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  process.stdout.write(`${JSON.stringify({ phase: 'public-web-fetch-started', ownedPid: child.pid, preload: false })}\n`)
  let stdout = '', stderr = ''
  child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes)
  const timer = setTimeout(() => { timedOut = true; terminate() }, 30000)
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }); clearTimeout(timer)
  let output; try { output = JSON.parse(stdout) } catch {}
  const outcomes = typeof output?.result === 'string' && output.result.startsWith('OWNED_PUBLIC_FETCH ') ? JSON.parse(output.result.slice('OWNED_PUBLIC_FETCH '.length)) : []
  let failure; try { failure = JSON.parse(readFileSync(helperFailure, 'utf8')) } catch {}
  process.stdout.write(`${JSON.stringify({ scope: 'ordinary native CLI, controlled preapproved public tool boundary, production default HTTPS retrieval and selected-provider extraction; synthetic accounts/providers only; production permission workflow is outside this fixture', code, timedOut, observations, outcomes, failure, stderrPresent: !!stderr })}\n`)
  assert.equal(code, 0); assert.equal(timedOut, false); assert.equal(outcomes.length, 2)
  assert.deepEqual(outcomes[0], { isError: false, denied: false, result: resultMarker, url: pageUrl, code: 200, bytes: Buffer.byteLength(pageHtml) })
  assert.equal(outcomes[1].denied, true, 'selected quota failure refuses instead of falling back')
  assert.deepEqual(failure, { phase: 'extraction', selectedProviderFailed: true })
  assert.equal(observations.filter(row => row.stage === 'retrieval').length, 2)
  assert.equal(observations.filter(row => row.stage === 'forbidden-native-fallback').length, 0)
  assert.deepEqual(observations.filter(row => row.stage === 'selected-provider').map(row => row.http), [200, 429])
  assert.ok(observations.filter(row => row.stage === 'selected-provider').every(row => row.model === 'owned' && row.pageEvidence && row.privateContextAbsent && row.noTools))
  assert.ok(observations.filter(row => row.stage === 'retrieval').every(row => !row.accountHeadersPresent))
} finally {
  terminate()
  await Promise.all([pages, provider].filter(Boolean).map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) })))
  rmSync(fixture, { recursive: true, force: true })
}
