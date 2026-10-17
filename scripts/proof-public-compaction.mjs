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
const plugin = join(fixture, 'plugin'), config = join(fixture, '.claude'), evidence = join(fixture, 'wires.json')
const native = process.env.RICE_CLAUDE_EXECUTABLE || 'claude'
let child
try {
  mkdirSync(plugin); mkdirSync(config)
  for (const directory of ['.claude-plugin', 'hooks', 'types', 'dist', 'scripts']) cpSync(join(root, directory), join(plugin, directory), { recursive: true })
  writeFileSync(join(fixture, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }))
  writeFileSync(join(config, 'settings.json'), '{}')
  const file = join(plugin, 'hooks/register.ts')
  let source = readFileSync(file, 'utf8')
  const close = source.lastIndexOf('\n}')
  assert.ok(close > 0)
  source = source.slice(0, close) + `
  on('state.get', {plugin:'rice-multi-models',key:'prefs'}, () => ({value:{value:{effort:null,transport:'auto',helper:'once',workers:'read'},version:0}}))
  on('process.run', async ($, e, next) => {
    if (!e.argv.includes('discover')) return next(e)
    const metadata={contextWindow:500000,maxContextWindow:500000,inputTokenLimit:null,outputTokenLimit:8192,autoCompactTokenLimit:null,inputModalities:['text'],reasoningEfforts:null,tools:null,parallelToolCalls:null}
    return {value:{exitCode:0,stdout:JSON.stringify({models:[{model:'codex/owned-public',label:'Owned',execution:'native provider',source:'owned fixture',observedAt:1800000000000,metadata}],providers:[{provider:'codex',status:'fresh',source:'owned fixture'}]}),stderr:'',isStdoutTruncated:false,isStderrTruncated:false}}
  })
  on('process.spawn', async function* ($, e, next) {
    if (!e.argv.includes('once')) return yield* next(e)
    const wire=JSON.parse(e.input || '{}')
    const rows=await $.fs.exists(${JSON.stringify(evidence)})?JSON.parse(await $.fs.read(${JSON.stringify(evidence)})):[]
    const summary=wire.req.system.startsWith('Create a precise continuation summary')
    rows.push({target:wire.req.target,who:wire.req.who,summary,prompt:JSON.stringify(wire.req.transcript),maxTokens:wire.req.native?.maxTokens})
    await $.fs.write(${JSON.stringify(evidence)},JSON.stringify(rows))
    const text=summary?'OWNED_PRODUCT_SUMMARY: Preserve /repo/task.ts; approval remains pending.':'OWNED_PRODUCT_ANSWER'
    for (const event of [{type:'text',text},{type:'usage',in:10000,out:20,cacheRead:0,cacheWrite:0},{type:'stop',reason:'end_turn'}]) yield {stream:'stdout',text:JSON.stringify(event)+'\\n'}
    return {value:{code:0,signal:null}}
  })
` + source.slice(close)
  writeFileSync(file, source)
  const env = Object.fromEntries(['PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'ProgramFiles', 'ProgramFiles(x86)', 'CLAUDE_CODE_GIT_BASH_PATH'].filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]))
  Object.assign(env, { HOME: fixture, USERPROFILE: fixture, CLAUDE_CONFIG_DIR: config, CODEX_HOME: join(fixture, '.codex'), ANTHROPIC_API_KEY: 'owned-no-network', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })
  const checked = spawnSync(native, ['plugin', 'validate', '--strict', plugin], { cwd: fixture, env, encoding: 'utf8', timeout: 10000 })
  assert.equal(checked.status, 0, (checked.stdout + checked.stderr).slice(-2000))
  async function run(label, session, args, prompt) {
    // Native Windows limits a command line to 32767 characters; claude -p reads a long prompt from stdin.
    const viaStdin = prompt.length > 8000
    child = spawn(native, ['-p', '--model', 'codex/owned-public', '--plugin-dir', plugin, '--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', '', '--output-format', 'json', ...args, ...(viaStdin ? [] : [prompt])], { cwd: fixture, env, detached: process.platform !== 'win32', stdio: [viaStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    if (viaStdin) child.stdin.end(prompt)
    console.log(JSON.stringify({ phase: label, ownedPid: child.pid, session, preload: false }))
    let stdout = '', stderr = '', expired = false
    child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes)
    const timer = setTimeout(() => { expired = true; terminate() }, 30000)
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }); clearTimeout(timer)
    assert.equal(expired, false, label + ' deadline')
    assert.equal(code, 0, label + ': ' + (stdout + stderr).slice(-2000))
    const output = JSON.parse(stdout)
    assert.equal(output.is_error, false, label + ': ' + output.result)
    return output
  }
  const manual = randomUUID()
  await run('manual-seed', manual, ['--session-id', manual], 'Preserve /repo/task.ts. Publication requires my approval.')
  await run('manual-compact', manual, ['--resume', manual], '/compact Retain the publication approval gate')
  const afterCompact = JSON.parse(readFileSync(evidence, 'utf8'))
  const summary = afterCompact.find(row => row.summary)
  assert.equal(summary?.target, 'codex/owned-public')
  assert.ok(summary.prompt.includes('publication approval gate'))
  assert.ok(summary.prompt.includes('/repo/task.ts'))
  await run('manual-resume', manual, ['--resume', manual], 'Continue the pending work.')
  const afterResume = JSON.parse(readFileSync(evidence, 'utf8'))
  assert.ok(afterResume.at(-1).prompt.includes('OWNED_PRODUCT_SUMMARY'), 'native resume consumes production summary')
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
