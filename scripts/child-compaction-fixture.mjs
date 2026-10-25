// One routed child in ordinary native Claude, in an isolated HOME and CLAUDE_CONFIG_DIR with a fake provider.
// Shared by the subagent auto-compaction regression (proof-public-compaction.mjs) and the diagnosis that records
// whether a native compaction attempt fired, was skipped or failed (proof-child-compaction-diagnosis.mjs).
// The fixture only observes: its hooks log what Claude and the mod's production hooks do, and decide nothing.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const CHILD = 'codex/owned-child', PARENT = 'codex/owned-public'
const SUMMARY_MARK = 'OWNED_COMPACT_SUMMARY'
const DEFAULT_INPUTS = [20000, 50000, 70000, 72000, 74000, 75000]

/**
 * Runs one parent that spawns one routed child whose reported usage grows by `inputs`, one value per child step.
 *  - seeded: the per-model windows (parent 500000, child 100000) and the global ceiling (500000) are in the native
 *    settings before launch. Unseeded, the global ceiling is only set live by the parent's first step (late data).
 *  - background: the child runs in the background.  - cache: the usage is almost entirely cache reads.
 *  - summary: what the fake provider answers a summary request with: 'ok', 'error' or 'empty'.
 */
export async function runChildCase({ label, native, seeded = true, background = false, cache = false, inputs = DEFAULT_INPUTS, summary = 'ok', deadlineMs = 90_000 }) {
  const fixture = mkdtempSync(join(tmpdir(), `rice-child-${label}-`))
  const home = join(fixture, 'home'), config = join(home, '.claude'), plugin = join(fixture, 'plugin'), wires = join(fixture, 'wires'), events = join(fixture, 'events')
  for (const directory of [config, wires, events]) mkdirSync(directory, { recursive: true })
  for (const path of ['.claude-plugin', 'hooks', 'types', 'dist', 'scripts', 'README.md']) cpSync(join(root, path), join(plugin, path), { recursive: true })
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }))
  writeFileSync(join(home, 'owned.txt'), 'OWNED_TOOL_RESULT approval is pending')
  const settings = seeded
    ? { modelSettings: { [CHILD]: { autoCompactWindow: 100000 }, [PARENT]: { autoCompactWindow: 500000 } }, env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '500000' } }
    : {}
  writeFileSync(join(config, 'settings.json'), JSON.stringify(settings))
  const file = join(plugin, 'hooks/register.ts')
  const source = readFileSync(file, 'utf8')
  const close = source.lastIndexOf('\n}')
  const open = source.indexOf('export const register: Register = on => {\n')
  assert.ok(close > 0 && open > 0, 'production register boundaries')
  const head = open + 'export const register: Register = on => {\n'.length
  const record = (kind, expression) => `await $.fs.write(${JSON.stringify(events)}+'/'+crypto.randomUUID()+'.json',JSON.stringify({kind:${JSON.stringify(kind)},at:Date.now(),...(${expression})}));`
  // The observer is registered first so that it wraps the production hook, which answers without calling next.
  const observer = `
  // Observation only: a hook that records the compaction entry and what the production hook below it answered.
  on('session.compact', {trigger:/[\\s\\S]+/}, async ($, e, next) => {
    ${record('compact-entry', '{trigger:e.trigger,agentId:e.agentId,messages:e.messages.length}')}
    let result
    try { result = await next(e) } catch (error) {
      ${record('compact-result', '{agentId:e.agentId,rejected:String(error&&error.message||error)}')}
      throw error
    }
    ${record('compact-result', '{agentId:e.agentId,skip:result.skip,messages:result.messages&&result.messages.length,usage:result.usage}')}
    return result
  })
`
  writeFileSync(file, source.slice(0, head) + observer + source.slice(head, close) + `
  on('state.get', {plugin:'rice-multi-models',key:'prefs'}, () => ({value:{value:{effort:null,transport:'auto',helper:'once'},version:0}}))
  on('process.run', async ($, e, next) => {
    if (!e.argv.includes('discover')) return next(e)
    const metadata={contextWindow:100000,maxContextWindow:100000,inputTokenLimit:null,outputTokenLimit:32768,autoCompactTokenLimit:null,inputModalities:['text'],reasoningEfforts:null,tools:null,parallelToolCalls:null}
    return {value:{exitCode:0,stdout:JSON.stringify({models:[${JSON.stringify(PARENT)},${JSON.stringify(CHILD)}].map(model=>({model,label:'Owned',execution:'native provider',source:'owned fixture',observedAt:Date.now(),metadata:model===${JSON.stringify(PARENT)}?{...metadata,contextWindow:500000,maxContextWindow:500000}:metadata})),providers:[{provider:'codex',status:'fresh',source:'owned fixture'}]}),stderr:'',isStdoutTruncated:false,isStderrTruncated:false}}
  })
  let parentStep=0,childStep=0,summaryCount=0,compacted=0,releaseChild
  const childDone=new Promise(resolve=>{releaseChild=resolve})
  on('turn.complete',{agentId:/[\\s\\S]+/},async($,e,next)=>{const result=await next(e);releaseChild();return result})
  on('process.spawn', async function* ($, e, next) {
    if (!e.argv.includes('once')) return yield* next(e)
    const req=JSON.parse(e.input||'{}').req
    const last=JSON.stringify(req.transcript.at(-1))
    const isSummary=last.includes('<analysis>')&&last.includes('<summary>')
    const child=req.who!=='main'
    const n=isSummary?++summaryCount:child?++childStep:++parentStep
    if(!isSummary&&!child&&n>1&&${JSON.stringify(background)})await childDone
    if(!isSummary&&!child&&n===1&&${JSON.stringify(!seeded)})await $.env.set('CLAUDE_CODE_MAX_CONTEXT_TOKENS','500000')
    const growth=${JSON.stringify(inputs)}
    if(isSummary&&${JSON.stringify(summary)}==='ok')compacted++
    const input=child?(compacted>0?12000:growth[Math.min(n-1,growth.length-1)]):1000
    await $.fs.write(${JSON.stringify(wires)}+'/'+crypto.randomUUID()+'.json',JSON.stringify({who:req.who,target:req.target,n,summary:isSummary,input,messages:req.transcript.length,hasSummary:JSON.stringify(req.transcript).includes(${JSON.stringify(SUMMARY_MARK)})}))
    const tool=!isSummary&&!child&&n===1?{type:'tool_use',id:'toolu_owned_child',name:'Agent',input:{description:'Owned compaction child',prompt:'Read the owned file repeatedly while preserving approval pending.',subagent_type:'general-purpose',model:${JSON.stringify(CHILD)},run_in_background:${JSON.stringify(background)}}}:!isSummary&&child&&n<growth.length?{type:'tool_use',id:'toolu_owned_read_'+n,name:'Read',input:{file_path:${JSON.stringify(join(home, 'owned.txt'))}}}:undefined
    const text=isSummary?'<analysis>owned</analysis>\\n<summary>\\n${SUMMARY_MARK} approval pending\\n</summary>':child?'OWNED_CHILD_DONE':'OWNED_PARENT_DONE'
    const failed=isSummary&&${JSON.stringify(summary)}==='error'
    const body=isSummary&&${JSON.stringify(summary)}==='empty'?[]:[{type:'text',text}]
    const events=failed?[{type:'error',kind:'response',text:'owned summary failure'}]:[...(tool?[tool]:body),{type:'usage',in:isSummary?10000:${JSON.stringify(cache)}?1000:input,out:20,cacheRead:!isSummary&&${JSON.stringify(cache)}?input-1000:0,cacheWrite:0},{type:'stop',reason:tool?'tool_use':'end_turn'}]
    for(const event of events)yield {stream:'stdout',text:JSON.stringify(event)+'\\n'}
    return {value:{code:failed?1:0,signal:null}}
  })
` + source.slice(close))
  const env = Object.fromEntries(['PATH', 'TMPDIR', 'LANG', 'LC_ALL'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  Object.assign(env, { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: config, CODEX_HOME: join(home, '.codex'), ANTHROPIC_API_KEY: 'owned-no-network', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })
  const validation = spawnSync(native, ['plugin', 'validate', '--strict', plugin], { cwd: home, env, encoding: 'utf8', timeout: 20_000 })
  assert.equal(validation.status, 0, (validation.stdout + validation.stderr).slice(-2000))
  // Anything that reaches the Anthropic API is recorded (and refused): a routed child must send nothing there.
  const anthropicPosts = []
  const anthropic = createServer((request, response) => {
    let raw = ''; request.on('data', bytes => raw += bytes)
    request.on('end', () => {
      try { anthropicPosts.push({ url: request.url, model: JSON.parse(raw).model }) } catch { anthropicPosts.push({ url: request.url }) }
      response.writeHead(404, { 'content-type': 'application/json', 'x-should-retry': 'false' })
      response.end('{"type":"error","error":{"type":"not_found_error","message":"owned fixture"}}')
    })
  })
  await new Promise(resolve => anthropic.listen(0, '127.0.0.1', resolve))
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${anthropic.address().port}`
  const child = spawn(native, ['-p', '--model', PARENT, '--plugin-dir', plugin, '--setting-sources', 'user', '--permission-mode', 'bypassPermissions', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', 'Agent,Read', '--debug-file', join(fixture, 'debug.log'), '--output-format', 'json', 'Start the owned compaction child, wait for it, then finish.'], { cwd: home, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  console.log(JSON.stringify({ phase: 'child-compaction', label, ownedPid: child.pid, fixture, preload: false }))
  let stdout = '', stderr = '', timedOut = false
  child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes)
  const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGTERM') } catch { /* already gone */ } }, deadlineMs)
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  clearTimeout(timer); anthropic.close()
  writeFileSync(join(fixture, 'stdout.json'), stdout); writeFileSync(join(fixture, 'stderr.txt'), stderr)
  const readJson = directory => readdirSync(directory).map(name => JSON.parse(readFileSync(join(directory, name), 'utf8')))
  const transcripts = readdirSync(join(config, 'projects'), { recursive: true }).filter(path => typeof path === 'string' && path.endsWith('.jsonl'))
  const childFiles = transcripts.filter(path => path.includes('subagents/'))
  const rows = path => readFileSync(join(config, 'projects', path), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const childRows = childFiles.flatMap(rows)
  const debug = readFileSync(join(fixture, 'debug.log'), 'utf8').split('\n')
  const wireRows = readJson(wires).sort((a, b) => a.who.localeCompare(b.who) || a.n - b.n)
  const compactEvents = readJson(events).sort((a, b) => a.at - b.at)
  const boundaries = childRows.filter(row => row.subtype === 'compact_boundary')
  return {
    fixture, code, timedOut, label, anthropicPosts,
    childTranscripts: childFiles.length,
    childUsage: childRows.filter(row => row.type === 'assistant').map(row => ({ model: row.message.model, input: row.message.usage?.input_tokens, cacheRead: row.message.usage?.cache_read_input_tokens })),
    boundaries: boundaries.map(row => ({ trigger: row.compactMetadata?.trigger })),
    autoBoundaries: boundaries.filter(row => row.compactMetadata?.trigger === 'auto').length,
    parentBoundaries: transcripts.filter(path => !path.includes('subagents/')).flatMap(rows).filter(row => row.subtype === 'compact_boundary').length,
    summaryRequests: wireRows.filter(row => row.summary).map(row => ({ who: row.who === 'main' ? 'main' : 'child', target: row.target, messages: row.messages })),
    childRequests: wireRows.filter(row => row.who !== 'main' && !row.summary).map(row => ({ n: row.n, input: row.input, hasSummary: row.hasSummary })),
    window: {
      source: [...new Set(debug.map(line => /thresholdSource=(\w+)/.exec(line)?.[1]).filter(Boolean))],
      effective: [...new Set(debug.map(line => Number(/effectiveWindow=(\d+)/.exec(line)?.[1])).filter(Boolean))],
    },
    nativeAttempts: debug.filter(line => /autocompact: routing through/.test(line)).length,
    breaker: debug.filter(line => /circuit breaker|rapid_refill/.test(line)).map(line => line.replace(/^\S+ /, '').slice(0, 200)),
    sessionCompact: compactEvents.map(({ at, ...row }) => row),
    nativeSkips: debug.filter(line => /session\.compact \(auto\)|Reactive compact skipped|compact.*skipped/.test(line)).map(line => line.replace(/^\S+ /, '').slice(0, 240)),
  }
}

/** The regression every positive case must show: an automatic native compaction of the child, on the child's own model. */
export function assertChildCompacted(result, expectedInputs = DEFAULT_INPUTS.length) {
  const label = result.label
  assert.equal(result.timedOut, false, `${label}: native fixture deadline`)
  assert.equal(result.code, 0, `${label}: claude exits cleanly`)
  assert.equal(result.childTranscripts, 1, `${label}: exactly one child transcript`)
  assert.deepEqual(result.anthropicPosts, [], `${label}: nothing reaches the Anthropic API`)
  assert.ok(result.childRequests.length >= expectedInputs, `${label}: the child ran its growing-usage steps`)
  assert.ok(result.autoBoundaries >= 1, `${label}: an automatic compact_boundary is in the CHILD transcript`)
  assert.equal(result.parentBoundaries, 0, `${label}: the 500000-token parent is not compacted`)
  assert.ok(result.summaryRequests.length >= 1 && result.summaryRequests.every(request => request.who === 'child' && request.target === CHILD), `${label}: the summary request targets the child's exact model`)
  assert.ok(result.window.effective.includes(80000), `${label}: the child's seeded 100000 window is Claude's effective window`)
  const later = result.childRequests.filter(request => request.hasSummary)
  assert.ok(later.length >= 1, `${label}: a later child request carries the summary`)
  assert.ok(later.every(request => request.input < 67000), `${label}: the later child request reports reduced usage, under the 67000 threshold`)
  assert.ok(result.sessionCompact.some(row => row.kind === 'compact-result' && row.messages === 1 && row.agentId !== undefined), `${label}: the production hook answered the child's compaction with the summary message`)
}

/** The negative control: data that arrives after launch leaves the child at the window Claude resolved at launch. */
export function assertChildNotCompacted(result) {
  const label = result.label
  assert.equal(result.timedOut, false, `${label}: native fixture deadline`)
  assert.equal(result.code, 0, `${label}: claude exits cleanly`)
  assert.deepEqual(result.anthropicPosts, [], `${label}: nothing reaches the Anthropic API`)
  assert.equal(result.autoBoundaries, 0, `${label}: no automatic compaction without launch-time data`)
  assert.equal(result.summaryRequests.length, 0, `${label}: no summary request`)
  assert.ok(!result.window.effective.includes(80000), `${label}: the child never sees the 100000 window`)
}
