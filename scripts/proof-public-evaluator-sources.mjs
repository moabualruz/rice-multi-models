import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { Script } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { captureNativeChild } from './proof-native-child.mjs'

const native = process.env.RICE_CLAUDE_EXECUTABLE || 'claude'
const root = fileURLToPath(new URL('../', import.meta.url))
const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'rice-evaluator-inventory-')))
const config = join(fixture, '.claude'), observer = join(fixture, 'observer'), rewrite = join(fixture, 'rewrite'), driver = join(fixture, 'driver'), classic = join(fixture, 'classic-only'), mixed = join(fixture, 'mixed')
const resultFile = join(fixture, 'observations.json'), enabledMarker = join(fixture, 'classic-enabled')
const requests = []
const server = createServer((request, response) => { requests.push({ path: request.url.split('?')[0] }); response.writeHead(429, { 'content-type': 'application/json', 'x-should-retry': 'false' }); response.end('{"error":{"type":"rate_limit_error","message":"Owned exhausted sentinel"}}') })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const command = 'require("node:fs").writeFileSync(process.argv[1],"OWNED_ENABLED")'
new Script(command)
const skillFrontmatter = { name: 'owned-inventory', description: 'Owned hook inventory fixture', hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'OWNED_SKILL_HOOK', once: true }] }] } }
const sources = {
 observer: `import{createEvaluatorSources,registerEvaluatorSources}from'./evaluator-sources';const seen={plugins:[],skills:[],agents:[],deniedNetwork:[]};export const register=on=>{const inventory=createEvaluatorSources();registerEvaluatorSources(on,inventory);
  on('http.fetch',async($,e,next)=>{const url=new URL(e.url);if(url.origin===${JSON.stringify(`http://127.0.0.1:${server.address().port}`)})return next(e);seen.deniedNetwork.push('nonloopback');return{value:{status:503,ok:false,headers:{},text:'Owned nonloopback request denied'}};}).catch(($,e,next)=>{seen.deniedNetwork.push('failed-closed');return{value:{status:503,ok:false,headers:{},text:'Owned network failed closed'}};});
  on('plugin.register',async($,e,next)=>{const result=await next(e);seen.plugins.push({name:e.name,root:e.root,provenance:e.provenance,events:e.uses.events,result});return result;});
  on('skill.prompt',async($,e,next)=>{const result=await next(e);const core=next.trace.find(row=>row.plugin==='engine'&&row.tier==='core'&&['returned','passed'].includes(row.outcome));seen.skills.push({skill:e.skill,path:e.path,source:e.source,frontmatter:e.frontmatter,coreInput:core?.received,origin:next.origin});return result;});
  on('agent.register',async($,e,next)=>{const result=await next(e);seen.agents.push({original:e,result,trace:next.trace.map(row=>({plugin:row.plugin,tier:row.tier,outcome:row.outcome,received:row.received,returned:row.returned}))});return result;});
  on('classic.Stop',async($,e)=>{seen.stop={keys:Object.keys(e),settings:await $.settings.read()};seen.inventory={accepted:inventory.sources({hook_event_name:'SubagentStop',agent_id:'owned-metadata-query',agent_type:'owned-driver:owned-source'}),unknown:inventory.sources({hook_event_name:'SubagentStop',agent_id:'owned-metadata-query',agent_type:'owned-rewrite:unknown'})};await $.fs.write(${JSON.stringify(resultFile)},JSON.stringify(seen));return{};});
 };`,
 rewrite: `export const register=on=>{on('agent.register',($,e,next)=>e.name==='owned-unknown'?{value:{agent:'owned-rewrite:unknown'}}:next({...e,prompt:'OWNED_FINAL_PROMPT',hooks:{SubagentStop:[{hooks:[{type:'prompt',prompt:'OWNED_FINAL_AGENT_HOOK'}]}]}}));};`,
 driver: `export const register=on=>{on('turn.step',async function*($,e){await $.tool.call({tool:'Skill',skill:'owned-inventory'});await $.agent.register({name:'owned-source',description:'Owned source metadata',prompt:'OWNED_ORIGINAL_PROMPT',hooks:{SubagentStop:[{hooks:[{type:'prompt',prompt:'OWNED_ORIGINAL_AGENT_HOOK'}]}]}});await $.agent.register({name:'owned-unknown',description:'Owned takeover metadata',prompt:'OWNED_UNATTESTED_PROMPT',hooks:{SubagentStop:[{hooks:[{type:'prompt',prompt:'OWNED_UNATTESTED_HOOK'}]}]}});const answer='OWNED_INVENTORY';yield{kind:'text',index:0,text:answer};yield{kind:'stop',stopReason:'end_turn',usage:null};return{turnId:e.turnId,index:e.index,answer,toolUses:[],stopReason:'end_turn',usage:null};});};`,
 mixed: `export const register=on=>{on('turn.start',($,e,next)=>next(e));};`,
}
const env = Object.fromEntries(['PATH', 'LANG', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'SystemDrive', 'ProgramFiles', 'ProgramFiles(x86)', 'CLAUDE_CODE_GIT_BASH_PATH'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
Object.assign(env, { HOME: fixture, USERPROFILE: fixture, CLAUDE_CONFIG_DIR: config, CODEX_HOME: join(fixture, '.codex'), ANTHROPIC_API_KEY: 'owned-no-account', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' })
let child
function terminate() {
 if (!child || child.exitCode !== null || child.signalCode !== null) return
 if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000, windowsHide: true })
 else try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
}
try {
 mkdirSync(config)
 writeFileSync(join(fixture, '.claude.json'), '{"hasCompletedOnboarding":true}')
 writeFileSync(join(config, 'settings.json'), '{}')
 const skill = join(config, 'skills/owned-inventory'); mkdirSync(skill, { recursive: true }); writeFileSync(join(skill, 'SKILL.md'), '---\n' + JSON.stringify(skillFrontmatter) + '\n---\nOWNED_SKILL_BODY\n')
 for (const folder of [observer, rewrite, driver, classic, mixed]) {
  const name = basename(folder)
  mkdirSync(join(folder, '.claude-plugin'), { recursive: true }); mkdirSync(join(folder, 'hooks'))
  if (name === 'observer') copyFileSync(join(root, 'hooks/evaluator-sources.ts'), join(folder, 'hooks/evaluator-sources.ts'))
  writeFileSync(join(folder, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'owned-' + name, version: '1.0.0', description: 'Owned evaluator source inventory', author: { name: 'Owned fixture' } }))
  const hooks = { ...(sources[name] ? { modules: ['./register.js'] } : {}), ...(name === 'classic-only' ? { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: process.execPath, args: ['-e', command, enabledMarker] }] }], Stop: [{ hooks: [{ type: 'prompt', prompt: 'OWNED_CLASSIC_PROMPT' }, { type: 'agent', prompt: 'OWNED_CLASSIC_AGENT' }] }] } } : {}), ...(name === 'mixed' ? { hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'OWNED_MIXED_PROMPT' }] }] } } : {}) }
  writeFileSync(join(folder, 'hooks/hooks.json'), JSON.stringify(hooks))
  if (sources[name]) { const compiled = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: sources[name], encoding: 'utf8' }); assert.equal(compiled.status, 0, compiled.stderr); writeFileSync(join(folder, 'hooks/register.js'), sources[name]) }
  const validated = spawnSync(native, ['plugin', 'validate', '--strict', folder], { env, cwd: fixture, encoding: 'utf8', timeout: 15000 }); assert.equal(validated.status, 0, (validated.stdout + validated.stderr).slice(-2000))
 }
 child = spawn(native, ['-p', '--plugin-dir', observer, '--plugin-dir', rewrite, '--plugin-dir', driver, '--plugin-dir', classic, '--plugin-dir', mixed, '--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', 'Skill', '--allowedTools', 'Skill', '--no-session-persistence', '--output-format', 'json', '--', 'Inspect owned source inventory.'], { env, cwd: fixture, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
 console.log(JSON.stringify({ phase: 'inventory-start', ownedPid: child.pid, preload: false }))
 const { code, timedOut, stdout, stderr } = await captureNativeChild(child, 15000, terminate)
 const output = JSON.parse(stdout), observed = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8')) : undefined
 const receipt = { scope: 'Actual native registration and loaded skill metadata; production collector; source queries are data-only, no spawned evaluator or claim of complete hook inventory', code, timedOut, answer: output.result, requests, classicEnabled: existsSync(enabledMarker), observed, stderr }
 console.log(JSON.stringify(receipt))
 assert.equal(code, 0); assert.equal(timedOut, false); assert.equal(output.result, 'OWNED_INVENTORY'); assert.equal(requests.length, 0)
 assert.equal(receipt.classicEnabled, true)
 assert.deepEqual(observed.deniedNetwork, [], 'the owned inventory attempted no nonloopback HTTP operation')
 assert.equal(observed.skills[0]?.frontmatter.hooks.Stop[0].hooks[0].prompt, 'OWNED_SKILL_HOOK')
 const registration = observed.agents.find(row => row.original.name === 'owned-source')
 assert.equal(registration.original.prompt, 'OWNED_ORIGINAL_PROMPT')
 assert.ok(registration.trace.some(row => row.plugin === 'engine' && row.tier === 'core' && row.received.prompt === 'OWNED_FINAL_PROMPT'))
 assert.deepEqual(observed.inventory.accepted.errors, [])
 assert.equal(observed.inventory.accepted.sources[0]?.settings.hooks.SubagentStop[0].hooks[0].prompt, 'OWNED_FINAL_AGENT_HOOK')
 assert.deepEqual(observed.inventory.unknown.sources, [])
 assert.equal(observed.inventory.unknown.errors.length, 1)
 assert.equal(JSON.stringify(observed.inventory).includes('OWNED_UNATTESTED_HOOK'), false)
 assert.equal(observed.plugins.some(plugin => plugin.name === 'owned-classic-only'), false, 'an enabled classic-only plugin is not a module-admission event')
 assert.ok(observed.plugins.some(plugin => plugin.name === 'owned-mixed'))
 assert.deepEqual(observed.stop.settings.hooks ?? {}, {}, 'merged settings do not include loaded plugin/skill hooks')
} finally {
 terminate()
 server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(fixture, { recursive: true, force: true })
}
