// Production public evaluator adapter. Native CLI and tools are real; provider/auth are fixtures.
// Prompt evaluators route to the selected provider; an event with an agent-type
// evaluator stays entirely native, so every other configured hook still runs.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { Script } from 'node:vm'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url)), fixture = realpathSync(mkdtempSync(join(tmpdir(), 'rice-public-evaluators-')))
const plugin = join(fixture, 'plugin'), controller = join(fixture, 'controller'), config = join(fixture, '.claude')
const commands = join(fixture, 'commands.jsonl'), results = join(fixture, 'results.jsonl'), agentTypes = join(fixture, 'agent-types.json')
const excludedMarker = join(fixture, 'excluded-command-ran'), sourceCheck = join(fixture, 'effective-sources.json')
const native = process.env.RICE_CLAUDE_EXECUTABLE || 'claude'
const observations = [], receipts = []
let mode = 'allow', scenario = 'prompt-allow', child
const server = createServer(async (request, response) => {
  let raw = ''; for await (const part of request) raw += part
  const body = raw ? JSON.parse(raw) : {}
  if (request.url !== '/selected/v1/chat/completions') {
    observations.push({ mode, scenario, stage: 'forbidden-native', method: request.method, path: request.url })
    response.writeHead(429, { 'content-type': 'application/json', 'x-should-retry': 'false' })
    response.end('{"error":{"type":"rate_limit_error","message":"Owned Claude subscription exhausted"}}'); return
  }
  const continued = JSON.stringify(body.messages).includes('\\"stop_hook_active\\":true') || JSON.stringify(body.messages).includes('"stop_hook_active":true')
  observations.push({ mode, scenario, stage: 'prompt', model: body.model })
  const content = JSON.stringify({ ok: mode === 'allow' || continued, reason: 'OWNED_STOP_BLOCK' })
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content } }] }) + '\n\n')
  response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10 } }) + '\n\ndata: [DONE]\n\n')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const commandCode = 'const fs=require("node:fs");const input=JSON.parse(fs.readFileSync(0,"utf8"));fs.appendFileSync(process.argv[1],JSON.stringify({event:input.hook_event_name,active:input.stop_hook_active})+"\\n");'
new Script(commandCode)
const excludedCode = 'require("node:fs").writeFileSync(process.argv[1],"OWNED_EXCLUDED_HOOK");'
new Script(excludedCode)

function terminate() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000, windowsHide: true })
  else try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
}

try {
  mkdirSync(plugin); mkdirSync(config)
  // The build reads an immutable owned source copy, never shared generated dist.
  for (const directory of ['.claude-plugin', 'hooks', 'types', 'scripts', 'helper']) cpSync(join(root, directory), join(plugin, directory), { recursive: true })
  const maintainedInputHashes = Object.fromEntries(['hooks/register.ts', 'hooks/evaluator-runtime.ts', 'hooks/evaluators.ts', 'scripts/evaluator-wait.mjs', 'scripts/proof-public-evaluators.mjs'].map(name => [name, createHash('sha256').update(readFileSync(join(plugin, name))).digest('hex')]))
  mkdirSync(join(plugin, 'dist'))
  await build({ absWorkingDir: plugin, nodePaths: [join(root, 'node_modules')], tsconfig: join(plugin, 'helper/tsconfig.node.json'), entryPoints: ['helper/main.ts'], outfile: join(plugin, 'dist/helper.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22', banner: { js: "import{createRequire as __createRequire}from'node:module';const require=__createRequire(import.meta.url);" }, define: { 'process.env.WS_NO_BUFFER_UTIL': '"1"', 'process.env.WS_NO_UTF_8_VALIDATE': '"1"' } })
  cpSync(join(plugin, 'helper/openai/instructions.md'), join(plugin, 'dist/instructions.md'))
  await build({ absWorkingDir: plugin, tsconfig: join(plugin, 'helper/tsconfig.node.json'), stdin: { contents: "export{parseConfig,fingerprint}from'./hooks/config.ts'", resolveDir: plugin, sourcefile: 'owned-config.ts' }, outfile: join(fixture, 'config.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22' })
  const { parseConfig, fingerprint } = await import(pathToFileURL(join(fixture, 'config.mjs')).href)
  const configText = JSON.stringify({ providers: { selected: { kind: 'openai', baseUrl: `http://127.0.0.1:${server.address().port}/selected/v1`, allowHttp: true, auth: 'none', models: { owned: { maxOutputTokens: 4096, maxTokensParam: 'max_completion_tokens' } } } } })
  const parsed = parseConfig(configText); assert.ok(parsed.config)
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: process.execPath, args: ['-e', excludedCode, excludedMarker], statusMessage: 'OWNED_EXCLUDED_HOOK' }] }] } }))
  writeFileSync(join(config, 'rice-multi-models.json'), configText)
  writeFileSync(join(fixture, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }))
  const file = join(plugin, 'hooks/register.ts')
  let source = readFileSync(file, 'utf8')
  source = source.replace('await loadProviders($)', `await loadProviders($); await $.store.set(${JSON.stringify('trust:' + fingerprint(parsed.config.providers.selected))}, true)`)
  const close = source.lastIndexOf('\n}'); assert.ok(close > 0)
  source = source.slice(0, close) + `
    on('state.get',{plugin:'rice-multi-models',key:'prefs'},()=>({value:{value:{effort:null,transport:'auto',helper:'once'},version:0}}))
    on('process.run',async($,e,next)=>{if(!e.argv.includes('discover'))return next(e);return{value:{exitCode:0,stdout:JSON.stringify({models:[],providers:[]}),stderr:'',isStdoutTruncated:false,isStderrTruncated:false}}})
  ` + source.slice(close)
  writeFileSync(file, source)
  mkdirSync(join(controller, '.claude-plugin'), { recursive: true }); mkdirSync(join(controller, 'hooks'))
  writeFileSync(join(controller, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'owned-evaluator-controller', version: '1.0.0', description: 'Owned evaluator acceptance controller', author: { name: 'Owned fixture' } }))
  writeFileSync(join(controller, 'hooks/hooks.json'), JSON.stringify({ modules: ['./register.js'] }))
  const controllerSource = `export const register=on=>{let turns=0,registrations=0;const seen=[];
    on('agent.register',async($,e,next)=>{const result=await next(e);registrations++;if(typeof e.name==='string'&&e.name.startsWith('rice-multi-models:'))seen.push(e.name);return result;});
    on('turn.step',async function*($,e,next){if(e.agentId!==undefined)return yield*next(e);const excluded=JSON.stringify(await $.settings.read()).includes('OWNED_EXCLUDED_HOOK');await $.fs.write(${JSON.stringify(sourceCheck)},JSON.stringify({excluded}));const answer=excluded?'OWNED_SOURCE_SETUP_FAILURE':'OWNED_MAIN_'+(++turns);yield{kind:'text',index:0,text:answer};yield{kind:'stop',stopReason:'end_turn',usage:null};return{turnId:e.turnId,index:e.index,answer,toolUses:[],stopReason:'end_turn',usage:null};});
    on('classic.Stop',async($,e,next)=>{const result=await next(e);await $.fs.write(${JSON.stringify(results)},JSON.stringify({active:e.stop_hook_active,result}));await $.fs.write(${JSON.stringify(agentTypes)},JSON.stringify({seen,registrations}));return result;});};`
  assert.equal(spawnSync(process.execPath, ['--input-type=module', '--check'], { input: controllerSource, encoding: 'utf8' }).status, 0)
  writeFileSync(join(controller, 'hooks/register.js'), controllerSource)
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'SystemDrive', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'ProgramFiles', 'ProgramFiles(x86)', 'CLAUDE_CODE_GIT_BASH_PATH'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  Object.assign(env, { HOME: fixture, USERPROFILE: fixture, CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: 'owned-no-account', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })
  for (const folder of [controller, plugin]) {
    const checked = spawnSync(native, ['plugin', 'validate', '--strict', folder], { cwd: fixture, env, encoding: 'utf8', timeout: 15000 })
    assert.equal(checked.status, 0, (checked.stdout + checked.stderr).slice(-4000))
  }
  const command = { type: 'command', command: process.execPath, args: ['-e', commandCode, commands] }
  const prompt = { type: 'prompt', prompt: 'OWNED_EVALUATOR: Verify the completion. $ARGUMENTS', timeout: 15 }
  const agentHook = { type: 'agent', prompt: 'OWNED_AGENT_EVALUATOR: Verify the completion. $ARGUMENTS', timeout: 15 }
  const scenarios = [
    { name: 'prompt-allow', mode: 'allow', hooks: { Stop: [{ hooks: [command, prompt] }] }, answer: 'OWNED_MAIN_1', commands: 1 },
    { name: 'prompt-block', mode: 'block', hooks: { Stop: [{ hooks: [command, prompt] }] }, answer: 'OWNED_MAIN_2', commands: 2 },
    { name: 'agent-native', mode: 'allow', hooks: { Stop: [{ hooks: [command, prompt, agentHook] }] }, commands: 1 },
  ]
  const sourceHashes = Object.fromEntries(['hooks/register.ts', 'hooks/evaluator-runtime.ts', 'hooks/evaluators.ts', 'scripts/evaluator-wait.mjs'].map(name => [name, createHash('sha256').update(readFileSync(join(plugin, name))).digest('hex')]))
  let expectedCommands = 0
  for (const current of scenarios) {
    mode = current.mode; scenario = current.name
    for (const stale of [results, agentTypes]) rmSync(stale, { force: true })
    child = spawn(native, ['-p', '--model', 'selected/owned', '--plugin-dir', controller, '--plugin-dir', plugin, '--setting-sources', '', '--settings', JSON.stringify({ hooks: current.hooks }), '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', 'Read,Agent,TaskStop', '--allowedTools', 'Read,Agent,TaskStop', '--no-session-persistence', '--output-format', 'json', '--', 'Return the owned completion.'], { cwd: fixture, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    console.log(JSON.stringify({ phase: `evaluators-${current.name}`, ownedPid: child.pid, preload: false }))
    let stdout = '', stderr = '', timedOut = false
    child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes)
    const timer = setTimeout(() => { timedOut = true; terminate() }, 30000)
    const code = await new Promise(resolve => child.once('close', resolve)); clearTimeout(timer)
    let output, stop, registeredTypes; try { output = JSON.parse(stdout) } catch {} try { stop = JSON.parse(readFileSync(results, 'utf8')) } catch {} try { registeredTypes = JSON.parse(readFileSync(agentTypes, 'utf8')) } catch { registeredTypes = null }
    const observed = observations.filter(row => row.scenario === current.name)
    const receipt = { scenario: current.name, mode, code, timedOut, answer: output?.result, stop, registeredTypes, observedRequests: observed, stderrPresent: !!stderr }
    receipts.push(receipt); console.log(JSON.stringify(receipt))
    assert.deepEqual(JSON.parse(readFileSync(sourceCheck, 'utf8')), { excluded: false }, 'disabled user hooks are absent from effective configuration')
    assert.equal(existsSync(excludedMarker), false, 'an excluded user command never executes')
    assert.equal(code, 0); assert.equal(timedOut, false)
    assert.deepEqual(registeredTypes.seen, [], 'the plugin registers no rice-multi-models agent types')
    expectedCommands += current.commands
    assert.equal(readFileSync(commands, 'utf8').trim().split('\n').length, expectedCommands, 'the configured command runs once per Stop occurrence')
    if (current.name === 'agent-native') {
      assert.equal(observed.filter(row => row.stage === 'prompt' || row.stage === 'agent').length, 0, 'an agent-type evaluator keeps the whole event native')
      assert.ok(observed.some(row => row.stage === 'forbidden-native'), 'native evaluators ran natively (visible residual)')
    } else {
      assert.equal(output?.result, current.answer)
      assert.deepEqual(stop?.result, {})
      assert.ok(observed.some(row => row.stage === 'prompt' && row.model === 'owned'), 'prompt evaluators use the selected provider')
      assert.equal(observed.filter(row => row.stage === 'forbidden-native').length, 0, 'no native inference for routed prompt evaluators')
    }
  }
  console.log(JSON.stringify({ publicEvaluators: true, scope: 'ordinary native CLI; production planner/runtime/helper; prompt evaluators routed; agent-type evaluators stay native; selected provider fixtures', maintainedInputHashes, fixtureInputHashes: sourceHashes, receipts }))
} finally {
  terminate(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  rmSync(fixture, { recursive: true, force: true })
}
