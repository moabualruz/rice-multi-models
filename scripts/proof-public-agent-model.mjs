// Exact model ids through the Agent tool's `model`, in an isolated routed session of the installed claude.
// The routed main model emits four parallel Agent calls: two exact discovered ids, the Claude alias `sonnet`, and an
// id nothing discovered. The proof reads what each child step was sent to (its target), what the main model was
// offered (the widened Agent schema and description) and the unknown id's visible refusal. Own HOME and configuration,
// owned stubs, no external inference or account access.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const native = process.env.RICE_CLAUDE_EXECUTABLE || 'claude'
const fixture = mkdtempSync(join(tmpdir(), 'rice-public-agent-model-'))
const KEPT = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'ProgramFiles', 'ProgramFiles(x86)', 'CLAUDE_CODE_GIT_BASH_PATH']
const DISCOVERED = ['codex/owned-public', 'codex/owned-child', 'codex/owned-other']
let child

function terminate() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10_000 })
  else try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
}
async function finish(label, limit) {
  let expired = false
  const timer = setTimeout(() => { expired = true; terminate() }, limit)
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  clearTimeout(timer)
  assert.equal(expired, false, `${label} deadline`)
  return code
}

try {
  const versionResult = spawnSync(native, ['--version'], { encoding: 'utf8', timeout: 10_000 })
  assert.equal(versionResult.status, 0, `installed Claude Code version query failed: ${(versionResult.stdout + versionResult.stderr).slice(-1000)}`)
  const installedVersion = /^(\d+\.\d+\.\d+) \(Claude Code\)$/.exec(versionResult.stdout.trim())?.[1]
  assert.ok(installedVersion, `unrecognized installed Claude Code version: ${versionResult.stdout.trim()}`)
  if (process.env.CLAUDE_VERSION) assert.equal(installedVersion, process.env.CLAUDE_VERSION, 'installed Claude Code must match the CI target version')

  const home = join(fixture, 'home'), config = join(home, '.claude')
  mkdirSync(join(config, 'agents'), { recursive: true })
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }))
  writeFileSync(join(config, 'settings.json'), '{}')
  const env = Object.fromEntries(KEPT.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  Object.assign(env, { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: config, CODEX_HOME: join(home, '.codex'), ANTHROPIC_API_KEY: 'owned-no-network', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })

  // A configured subagent default must not override an explicit built-in Agent model.
  // The host's forced-model precedence over hook rewrites is specific to workflow agents.
  env.CLAUDE_CODE_SUBAGENT_MODEL = 'codex/owned-other'
  const plugin = join(fixture, 'plugin'), evidence = join(fixture, 'wires')
  mkdirSync(evidence)
  for (const directory of ['.claude-plugin', 'hooks', 'types', 'dist', 'scripts']) cpSync(join(root, directory), join(plugin, directory), { recursive: true })
  const file = join(plugin, 'hooks/register.ts')
  let source = readFileSync(file, 'utf8')
  const close = source.lastIndexOf('\n}')
  assert.ok(close > 0)
  // Test-only hooks appended to the copied mod: a fixed discovery and a stub for the helper's one-shot step. They
  // write one evidence file per step and answer the main model's first step with the four parallel Agent calls.
  source = source.slice(0, close) + `
  on('state.get', {plugin:'rice-multi-models',key:'prefs'}, () => ({value:{value:{effort:null,transport:'auto',helper:'once'},version:0}}))
  on('process.run', async ($, e, next) => {
    if (!e.argv.includes('discover')) return next(e)
    const metadata={contextWindow:500000,maxContextWindow:500000,inputTokenLimit:null,outputTokenLimit:32768,autoCompactTokenLimit:null,inputModalities:['text'],reasoningEfforts:null,tools:null,parallelToolCalls:null}
    return {value:{exitCode:0,stdout:JSON.stringify({models:${JSON.stringify(DISCOVERED)}.map(model=>({model,label:'Owned',execution:'native provider',source:'owned fixture',observedAt:1800000000000,metadata})),providers:[{provider:'codex',status:'fresh',source:'owned fixture'}]}),stderr:'',isStdoutTruncated:false,isStderrTruncated:false}}
  })
  on('process.spawn', async function* ($, e, next) {
    if (!e.argv.includes('once')) return yield* next(e)
    const req=JSON.parse(e.input || '{}').req
    const transcript=JSON.stringify(req.transcript)
    const name=req.who+'-'+Math.random().toString(36).slice(2)
    await $.fs.write(${JSON.stringify(evidence)}+'/'+name+'.json',JSON.stringify({who:req.who,target:req.target,transcript,tools:req.tools}))
    const answered=transcript.includes('tool_result')
    const call=(id,model,tag)=>({type:'tool_use',id,name:'Agent',input:{description:'Owned '+tag,prompt:'OWNED_CHILD_'+tag,subagent_type:'general-purpose',...(model?{model}:{}),run_in_background:false}})
    const events=req.who==='main'&&!answered
      ?[call('toolu_owned_a','codex/owned-child','A'),call('toolu_owned_b','codex/owned-other','B'),call('toolu_owned_c','sonnet','C'),call('toolu_owned_d','codex/not-discovered','D'),{type:'usage',in:10,out:2,cacheRead:0,cacheWrite:0},{type:'stop',reason:'tool_use'}]
      :[{type:'text',text:req.who==='main'?'OWNED_MAIN_DONE':'OWNED_CHILD_REPORT'},{type:'usage',in:10,out:2,cacheRead:0,cacheWrite:0},{type:'stop',reason:'end_turn'}]
    for (const event of events) yield {stream:'stdout',text:JSON.stringify(event)+'\\n'}
    return {value:{code:0,signal:null}}
  })
` + source.slice(close)
  writeFileSync(file, source)
  const checked = spawnSync(native, ['plugin', 'validate', '--strict', plugin], { cwd: home, env, encoding: 'utf8', timeout: 20_000 })
  assert.equal(checked.status, 0, (checked.stdout + checked.stderr).slice(-2000))
  child = spawn(native, ['-p', '--model', 'codex/owned-public', '--plugin-dir', plugin, '--setting-sources', 'user', '--permission-mode', 'bypassPermissions', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], { cwd: home, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
  console.log(JSON.stringify({ phase: 'routed-session', ownedPid: child.pid, claude: installedVersion }))
  let stdout = '', stderr = ''
  child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes)
  child.stdin.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'Run the owned agents, then finish.' } })}\n`)
  assert.equal(await finish('routed session', 100_000), 0, (stdout + stderr).slice(-2000))
  const events = stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
  assert.equal(events.findLast(event => event.type === 'result')?.is_error, false, stdout.slice(-1500))

  const rows = readdirSync(evidence).map(name => JSON.parse(readFileSync(join(evidence, name), 'utf8')))
  const mains = rows.filter(row => row.who === 'main')
  const children = rows.filter(row => row.who !== 'main')
  const targetOf = tag => children.filter(row => row.transcript.includes(`OWNED_CHILD_${tag}`)).map(row => row.target)

  // 1. The main model is offered the capability: the Agent schema lists the discovered ids, the description names them.
  const offered = mains[0].tools.find(tool => tool.name === 'Agent')
  assert.ok(offered, 'the routed main offers Agent')
  const enumeration = offered.schema.properties.model.enum
  for (const id of DISCOVERED) assert.ok(enumeration.includes(id), `the Agent schema lists ${id}`)
  for (const alias of ['haiku', 'sonnet', 'opus', 'fable']) assert.ok(enumeration.includes(alias), `the Agent schema keeps the engine value ${alias}`)
  assert.match(offered.description, /\[rice-multi-models\] The model parameter also takes/)
  for (const id of DISCOVERED) assert.ok(offered.description.includes(id), `the Agent description names ${id}`)

  // 2. Two parallel calls with different exact ids each ran on their own id; the alias keeps its tier meaning.
  assert.deepEqual(targetOf('A'), ['codex/owned-child'], 'call A ran on exactly codex/owned-child')
  assert.deepEqual(targetOf('B'), ['codex/owned-other'], 'call B ran on exactly codex/owned-other')
  assert.deepEqual(targetOf('C'), ['codex/owned-public'], 'the sonnet alias still resolves inside the session family, as before')
  assert.deepEqual(targetOf('D'), [], 'the unknown id started no subagent')

  // 3. The unknown id is refused visibly, with the valid ids, in the tool result the main model reads next.
  const answered = mains.find(row => row.transcript.includes('tool_result'))
  assert.ok(answered, 'the main model read the tool results')
  const refusal = /Agent model \\"codex\/not-discovered\\" is not a model this session can run[^"]*/.exec(answered.transcript)?.[0] ?? ''
  assert.ok(refusal, 'the unknown id was refused in a visible tool result')
  for (const id of ['haiku', 'sonnet', 'opus', 'fable', ...DISCOVERED]) assert.ok(refusal.includes(id), `the refusal lists ${id}`)
  assert.equal(children.length, 3, 'exactly the three valid calls started a subagent')
  const parentText = answered.transcript
  assert.equal([...parentText].some(character => [0x2062, 0x2063].includes(character.codePointAt(0))), false, 'no invisible carrier marks reach the provider transcript')
  const toolCalls = events.filter(event => event.type === 'assistant').flatMap(event => event.message?.content ?? []).filter(block => block.type === 'tool_use' && block.name === 'Agent')
  const exactCalls = toolCalls.filter(call => ['toolu_owned_a', 'toolu_owned_b'].includes(call.id))
  assert.equal(exactCalls.length, 2, 'both exact calls are observable in the emitted transcript')
  for (const call of exactCalls) {
    const exact = call.id === 'toolu_owned_a' ? 'codex/owned-child' : 'codex/owned-other'
    assert.ok(call.input.model === exact || call.input.description.includes(`exact Agent model ${JSON.stringify(exact)}`), 'the emitted transcript identifies the exact model, never an unexplained carrier')
  }
  console.log(JSON.stringify({ publicAgentModel: true, claude: installedVersion, targets: { A: targetOf('A'), B: targetOf('B'), C: targetOf('C'), D: targetOf('D') }, refusal }))
} finally {
  terminate()
  rmSync(fixture, { recursive: true, force: true })
}
