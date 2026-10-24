// Production lifecycle hooks in ordinary Claude. Only provider I/O is an owned fixture.
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const root = fileURLToPath(new URL('../', import.meta.url))
const fixture = mkdtempSync(join(tmpdir(), 'rice-public-compact-'))
const plugin = join(fixture, 'plugin'), config = join(fixture, '.claude'), evidence = join(fixture, 'wires.json'), lifecycle = join(fixture, 'lifecycle.json'), agentProjection = join(fixture, 'agent-projection.json')
const native = process.env.RICE_CLAUDE_EXECUTABLE || 'claude'
let child
try {
  mkdirSync(plugin); mkdirSync(config)
  for (const directory of ['.claude-plugin', 'hooks', 'types', 'dist', 'scripts', 'README.md']) cpSync(join(root, directory), join(plugin, directory), { recursive: true })
  writeFileSync(join(fixture, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }))
  writeFileSync(join(config, 'settings.json'), '{}')
  const file = join(plugin, 'hooks/register.ts')
  let source = readFileSync(file, 'utf8')
  const close = source.lastIndexOf('\n}')
  assert.ok(close > 0)
  source = source.slice(0, close) + `
  on('state.get', {plugin:'rice-multi-models',key:'prefs'}, () => ({value:{value:{effort:null,transport:'auto',helper:'once'},version:0}}))
  // A supported post-run veto leaves a tracked child without a stored Agent identity.
  on('tool.call', {tool:'Agent',tool_use_id:'toolu_owned_projection'}, async ($, e, next) => {
    await next(e)
    return {deny:'Owned fixture: the Agent result is deliberately unavailable'}
  })
  let releaseOwnedChild
  const ownedChildDone=new Promise(resolve=>{releaseOwnedChild=resolve})
  on('turn.complete', {agentId:/[\\s\\S]+/}, async ($, e, next) => {const result=await next(e);releaseOwnedChild();return result})
  on('process.run', async ($, e, next) => {
    if (!e.argv.includes('discover')) return next(e)
    const metadata={contextWindow:500000,maxContextWindow:500000,inputTokenLimit:null,outputTokenLimit:32768,autoCompactTokenLimit:null,inputModalities:['text'],reasoningEfforts:null,tools:null,parallelToolCalls:null}
    return {value:{exitCode:0,stdout:JSON.stringify({models:[{model:'codex/owned-public',label:'Owned',execution:'native provider',source:'owned fixture',observedAt:Date.now(),metadata}],providers:[{provider:'codex',status:'fresh',source:'owned fixture'}]}),stderr:'',isStdoutTruncated:false,isStderrTruncated:false}}
  })
  on('process.spawn', async function* ($, e, next) {
    if (!e.argv.includes('once')) return yield* next(e)
    const wire=JSON.parse(e.input || '{}')
    const rows=await $.fs.exists(${JSON.stringify(evidence)})?JSON.parse(await $.fs.read(${JSON.stringify(evidence)})):[]
    // The engine's own summary prompt asks for the two blocks its answer is read by.
    const last=JSON.stringify(wire.req.transcript.at(-1))
    const summary=last.includes('<analysis>')&&last.includes('<summary>')
    rows.push({target:wire.req.target,who:wire.req.who,summary,prompt:JSON.stringify(wire.req.transcript),messages:wire.req.transcript.length,last,system:wire.req.system.slice(0,200),maxTokens:wire.req.native?.maxTokens})
    await $.fs.write(${JSON.stringify(evidence)},JSON.stringify(rows))
    const text=summary?'<analysis>owned analysis</analysis>\\n<summary>\\nOWNED_PRODUCT_SUMMARY: Preserve /repo/task.ts; approval remains pending.\\n</summary>':'OWNED_PRODUCT_ANSWER'
    const transcript=JSON.stringify(wire.req.transcript)
    const launch=wire.req.who==='main'&&!summary&&transcript.includes('OWNED_TRACKED_AGENT')&&!transcript.includes('toolu_owned_projection')
    if(wire.req.who==='main'&&!summary&&transcript.includes('toolu_owned_projection'))await ownedChildDone
    const events=launch?[{type:'tool_use',id:'toolu_owned_projection',name:'Agent',input:{description:'Owned tracked Agent',prompt:'Owned synthetic child',subagent_type:'general-purpose',run_in_background:true}},{type:'stop',reason:'tool_use'}]:[{type:'text',text},{type:'usage',in:10000,out:20,cacheRead:0,cacheWrite:0},{type:'stop',reason:'end_turn'}]
    for (const event of events) yield {stream:'stdout',text:JSON.stringify(event)+'\\n'}
    return {value:{code:0,signal:null}}
  })
` + source.slice(close)
  const snapshotTap = 'const snapshot = await $.session.messages(e.agentId === undefined ? {} : { agentId: e.agentId })'
  assert.ok(source.includes(snapshotTap), 'production public snapshot boundary exists')
  source = source.replace(snapshotTap, `${snapshotTap}
    if(e.instructions==='OWNED_AGENT_PROJECTION'){
      const calls=rows=>rows.flatMap(row=>row.toolUses).filter(tool=>tool.tool_use_id==='toolu_owned_projection')
      const eventCall=calls(e.messages)[0],publicCall=calls(snapshot)[0]
      const strip=rows=>rows.map(({handle,toolUses,...row})=>({...row,toolUses:toolUses.map(({agentId,...tool})=>tool)}))
      await $.fs.write(${JSON.stringify(agentProjection)},JSON.stringify({eventCount:e.messages.length,publicCount:snapshot.length,eventCalls:calls(e.messages).length,publicCalls:calls(snapshot).length,eventHasLookup:eventCall?.agentId!==undefined,publicHasLookup:typeof publicCall?.agentId==='string',validWithheldResult:eventCall?.isError===true&&eventCall.text.includes('Owned fixture: the Agent result is deliberately unavailable'),sameWithoutLookup:JSON.stringify(strip(e.messages))===JSON.stringify(strip(snapshot))}))
    }`)
  const receiptTap = 'if (saved) await publishReceipt($, row)'
  assert.ok(source.includes(receiptTap), 'production receipt tap exists')
  source = source.replace(receiptTap, `if (saved) {
    await publishReceipt($, row)
    const records=await $.fs.exists(${JSON.stringify(lifecycle)})?JSON.parse(await $.fs.read(${JSON.stringify(lifecycle)})):[]
    records.push({session:await $.session.id(),entries:(await read($,receiptsAtom)).entries})
    await $.fs.write(${JSON.stringify(lifecycle)},JSON.stringify(records))
  }`)
  const observeTap = 'const observed = await observedReceipt(row, active, session, model ?? (agentId === undefined ? await $.session.model() : agentModels.get(agentId)), now)'
  assert.ok(source.includes(observeTap))
  source = source.replace(observeTap, `const snapshots=await $.fs.exists(${JSON.stringify(lifecycle + '.observations')})?JSON.parse(await $.fs.read(${JSON.stringify(lifecycle + '.observations')})):[]
    snapshots.push({status:row.status,expected:row.expected,active:active.slice(0,3)})
    await $.fs.write(${JSON.stringify(lifecycle + '.observations')},JSON.stringify(snapshots.slice(-6)))
    ${observeTap}`)
  writeFileSync(file, source)
  const env = Object.fromEntries(['PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'ProgramFiles', 'ProgramFiles(x86)', 'CLAUDE_CODE_GIT_BASH_PATH'].filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]))
  Object.assign(env, { HOME: fixture, USERPROFILE: fixture, CLAUDE_CONFIG_DIR: config, CODEX_HOME: join(fixture, '.codex'), ANTHROPIC_API_KEY: 'owned-no-network', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })
  const checked = spawnSync(native, ['plugin', 'validate', '--strict', plugin], { cwd: fixture, env, encoding: 'utf8', timeout: 10000 })
  if (checked.status !== 0) process.stderr.write(checked.stdout + checked.stderr)
  assert.equal(checked.status, 0, (checked.stdout + checked.stderr).slice(-2000))
  async function run(label, session, args, prompt, tools = '') {
    // Native Windows limits a command line to 32767 characters; claude -p reads a long prompt from stdin.
    const script = Array.isArray(prompt) ? prompt : undefined
    const viaStdin = script !== undefined || prompt.length > 8000
    child = spawn(native, ['-p', '--model', 'codex/owned-public', '--plugin-dir', plugin, '--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', tools, ...(tools ? ['--permission-mode', 'bypassPermissions'] : []), '--output-format', script ? 'stream-json' : 'json', ...(script ? ['--input-format', 'stream-json', '--verbose'] : []), ...args, ...(viaStdin ? [] : [prompt])], { cwd: fixture, env, detached: process.platform !== 'win32', stdio: [viaStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    let pending = '', results = 0
    const outputs = []
    const send = text => child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n')
    if (script) {
      child.stdin.on('error', () => {})
      child.stdout.on('data', bytes => {
        pending += bytes
        for (let newline; (newline = pending.indexOf('\n')) !== -1;) {
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1)
          let event; try { event = JSON.parse(line) } catch { continue }
          if (event.type !== 'result') continue
          outputs.push(event); results++
          if (results < script.length) send(script[results]); else child.stdin.end()
        }
      })
      send(script[0])
    } else if (viaStdin) child.stdin.end(prompt)
    console.log(JSON.stringify({ phase: label, ownedPid: child.pid, session, preload: false }))
    let stdout = '', stderr = '', expired = false
    child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes)
    const timer = setTimeout(() => { expired = true; terminate() }, 30000)
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }); clearTimeout(timer)
    assert.equal(expired, false, label + ' deadline')
    assert.equal(code, 0, label + ': ' + (stdout + stderr).slice(-2000))
    if (script) {
      if (tools === 'Agent') assert.ok(results >= script.length && results <= script.length + 1, label + ': native steps plus at most one child notification')
      else assert.equal(results, script.length, label + ': all native steps completed')
    }
    const output = script ? (tools === 'Agent' ? outputs.findLast(event => event.local_command === 'compact' || event.num_turns === 0) : outputs.at(-1)) : JSON.parse(stdout)
    assert.equal(output.is_error, false, label + ': ' + output.result)
    return output
  }
  const manual = randomUUID()
  await run('manual-seed', manual, ['--session-id', manual], 'Preserve /repo/task.ts. Publication requires my approval.')
  await run('manual-compact', manual, ['--resume', manual], '/compact Retain the publication approval gate')
  const manualReceipts = JSON.parse(readFileSync(lifecycle, 'utf8')).flatMap(row => row.entries).filter(row => row.session === manual)
  console.log(JSON.stringify({ manualCompactionReceipts: manualReceipts }))
  assert.ok(manualReceipts.some(row => row.trigger === 'manual' && row.status === 'prepared'), 'mod receipt records preparation without claiming installation')
  assert.ok(manualReceipts.some(row => row.usage?.input_tokens === 10000 && row.usage?.output_tokens === 20), 'actual provider usage is retained in separate mod accounting')
  const afterCompact = JSON.parse(readFileSync(evidence, 'utf8'))
  const summary = afterCompact.find(row => row.summary)
  assert.equal(summary?.target, 'codex/owned-public')
  // The request is the engine's own: the conversation as real messages, then its prompt with the person's instructions in its slot.
  assert.ok(summary.messages >= 2, 'the conversation is sent as messages, not as one JSON document')
  assert.ok(summary.prompt.includes('/repo/task.ts'), 'the conversation reaches the summarizer')
  assert.ok(summary.last.includes('CRITICAL: Respond with TEXT ONLY'), 'the engine\'s own summary prompt is used')
  assert.ok(summary.last.includes('Additional Instructions:') && summary.last.includes('Retain the publication approval gate'), 'the /compact instructions go in the engine\'s slot')
  assert.ok(!summary.prompt.includes('continuationInstructions'), 'no mod-made JSON wrapper')
  assert.equal(summary.maxTokens, 32768, 'the summary may use the output bound the provider reported, not a mod-made cap')
  await run('manual-resume', manual, ['--resume', manual], 'Continue the pending work.')
  const afterResume = JSON.parse(readFileSync(evidence, 'utf8'))
  const resumed = afterResume.at(-1).prompt
  assert.ok(resumed.includes('OWNED_PRODUCT_SUMMARY'), 'native resume consumes production summary')
  assert.ok(!resumed.includes('<analysis>') && !resumed.includes('owned analysis'), 'the analysis block is not kept')
  assert.ok(resumed.includes('This session is being continued from a previous conversation'), 'the summary message is the engine\'s own wording')
  assert.ok(/read the full transcript at: \S+\.jsonl/.test(resumed), 'it cites the session transcript file')
  assert.ok(resumed.includes('Continue the conversation from where it left off'), 'it carries the engine\'s continuation directive')
  assert.ok(!resumed.includes('The conversation was compacted. Continue from this summary'), 'the old mod-made wrapper is gone')
  const inProcess = randomUUID()
  await run('in-process-manual', inProcess, ['--session-id', inProcess], ['Preserve the in-process publication approval.', '/compact Keep the approval gate', 'Continue without publishing.', '/compact Retain the same approval gate again', 'Continue after the second compaction.'])
  const installed = JSON.parse(readFileSync(lifecycle, 'utf8')).flatMap(row => row.entries).filter(row => row.session === inProcess)
  const installationObserved = installed.some(row => row.status === 'installed' && row.observedAt === 'persisted-history')
  if (!installationObserved) console.log(JSON.stringify({ inProcessReceipts: installed, observations: JSON.parse(readFileSync(lifecycle + '.observations', 'utf8')) }))
  assert.ok(installationObserved, 'a later native turn observes the actual installed summary, never the hook return alone')
  assert.equal(new Set(installed.filter(row => row.status === 'prepared').map(row => row.id)).size, 2, 'both successive compactions prepare against the same public history scope')
  assert.ok(!installed.some(row => row.status === 'aborted'), 'archived pre-boundary rows alone do not make the second compaction stale')
  const tracked = randomUUID()
  const trackedResult = await run('tracked-agent-compact', tracked, ['--session-id', tracked], ['OWNED_TRACKED_AGENT', '/compact OWNED_AGENT_PROJECTION'], 'Agent')
  const projection = JSON.parse(readFileSync(agentProjection, 'utf8'))
  assert.equal(projection.eventCount, projection.publicCount, 'same native conversation scope, not a history-bound fixture')
  assert.ok(projection.eventCount < 4096, 'Agent regression stays below the documented public entry bound')
  for (const field of ['publicHasLookup', 'validWithheldResult', 'sameWithoutLookup']) assert.equal(projection[field], true, field)
  assert.equal(projection.eventHasLookup, false, 'the compact event has no runtime-only child lookup')
  assert.equal(projection.eventCalls, 1)
  assert.equal(projection.publicCalls, 1)
  assert.ok(!/Not compacted|stale|discarded/.test(trackedResult.result ?? ''), 'tracked Agent lookup must not falsely reject compaction')
  const trackedPaths = readdirSync(join(config, 'projects'), { recursive: true }).filter(path => typeof path === 'string' && path.endsWith(tracked + '.jsonl'))
  const trackedRows = trackedPaths.flatMap(path => readFileSync(join(config, 'projects', path), 'utf8').trim().split('\n').map(line => JSON.parse(line)))
  assert.equal(trackedRows.filter(row => row.subtype === 'compact_boundary').length, 1, 'tracked Agent compaction actually persisted a native boundary')
  console.log(JSON.stringify({ trackedAgentCompaction: true, projection }))
  env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = '1'
  const automatic = randomUUID()
  await run('auto-seed', automatic, ['--session-id', automatic], 'Preserve the approval gate. ' + 'OWNED_HISTORY '.repeat(2500))
  for (let index = 0; index < 3; index++) await run('auto-continue-' + index, automatic, ['--resume', automatic], 'Continue with the same constraints.')
  const paths = readdirSync(join(config, 'projects'), { recursive: true }).filter(path => typeof path === 'string' && path.endsWith(automatic + '.jsonl'))
  const boundaries = paths.flatMap(path => readFileSync(join(config, 'projects', path), 'utf8').trim().split('\n').map(line => JSON.parse(line))).filter(row => row.type === 'system' && row.subtype === 'compact_boundary')
  assert.ok(boundaries.some(row => row.compactMetadata?.trigger === 'auto'), 'real automatic compaction persists native boundary')
  const wires = JSON.parse(readFileSync(evidence, 'utf8'))
  assert.ok(wires.filter(row => row.summary).length >= 2)
  assert.ok(wires.every(row => row.target === 'codex/owned-public'), 'no native or other provider fallback')
  console.log(JSON.stringify({ publicCompaction: true, manualSavedAndResumed: true, automaticSaved: true, providerOwnedRequests: wires.length, summaryRequests: wires.filter(row => row.summary).length }))
} finally {
  terminate()
  rmSync(fixture, { recursive: true, force: true })
}
function terminate() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000 })
  else try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
}
