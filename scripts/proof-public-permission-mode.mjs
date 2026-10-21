// Ordinary native Claude, production permission handlers, and owned local providers.
// No account, preload, launcher, shell wrapper, or external inference is used.
// Mode changes are detected with native tool.check queries; a session without any
// file-edit tool cannot tell auto from plan that way, so the cases include Write.
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, relative } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
// The host flags an 8.3 short name such as RUNNER~1 as a suspicious Windows path and asks before any
// mode check, so the fixture root is the resolved long path.
const retained = process.env.RICE_PROOF_STATE_DIR || join(realpathSync.native(tmpdir()), 'rice-multi-models-proofs')
mkdirSync(retained, { recursive: true })
const fixture = mkdtempSync(join(retained, 'public-permission-mode-'))
const native = process.env.RICE_CLAUDE_EXECUTABLE || 'claude'
const command = 'printf OWNED_MODE_MARKER > owned-mode-marker; cat owned-mode-marker'
const humanIntent = 'OWNED_MAIN_HUMAN_INTENT: Write and print only the owned-mode-marker file with printf OWNED_MODE_MARKER > owned-mode-marker; cat owned-mode-marker. Delegate only this same action when requested. Do not access other resources.'
const childConstraint = 'OWNED_CHILD_CONSTRAINT: Perform only the exact delegated marker action and retain every owning human constraint.'
const caseLimit = process.platform === 'win32' ? 120_000 : 60_000
const childLimit = process.platform === 'win32' ? 60_000 : 20_000
const cases = [
  { name: 'main-stable-auto', child: false, changeDuringJudgment: false, approved: true },
  { name: 'main-pending-plan', child: false, changeDuringJudgment: true, approved: false },
  { name: 'child-pending-parent-plan', child: true, changeDuringJudgment: true, approved: false },
  { name: 'explicit-child-auto-stable-parent-plan', child: true, explicitAuto: true, changeDuringJudgment: false, approved: true },
]
const hash = value => createHash('sha256').update(value).digest('hex')
const runs = [], contexts = new Map()
let phase = 'prerequisites', active, failure, interrupted = false, version

function compile(source) {
  const result = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: source, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
}

function inheritedEnvironment() {
  const names = ['PATH', 'PATHEXT', 'LANG', 'LC_ALL', 'SystemRoot', 'SystemDrive', 'WINDIR', 'ComSpec', 'ProgramFiles', 'ProgramFiles(x86)', 'CLAUDE_CODE_GIT_BASH_PATH']
  return Object.fromEntries(names.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]))
}

function isolatedEnvironment(directory, base) {
  const temp = join(directory, 'tmp'); mkdirSync(temp)
  return {
    ...inheritedEnvironment(), HOME: directory, USERPROFILE: directory, USER: 'fixture', USERNAME: 'fixture',
    ...(process.platform === 'win32' ? { OS: 'Windows_NT' } : {}),
    TMPDIR: temp, TMP: temp, TEMP: temp, CLAUDE_CONFIG_DIR: join(directory, '.claude'),
    CODEX_HOME: join(directory, '.codex'), ANTHROPIC_API_KEY: 'owned-permission-mode-no-account',
    ANTHROPIC_BASE_URL: base, CLAUDE_CODE_AUTO_MODE_SERVER: '0', DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
  }
}

function sourceInventory(directory) {
  const files = {}
  const visit = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) files[relative(directory, path).split('\\').join('/')] = hash(readFileSync(path))
    }
  }
  visit(directory)
  return files
}

function json(response, value, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json', ...(status >= 400 ? { 'x-should-retry': 'false' } : {}) })
  response.end(JSON.stringify(value))
}

function respond(response, output, text) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const events = [{ type: 'response.created', response: { id: 'resp_owned_mode' } }]
  if (text !== undefined) events.push({ type: 'response.output_text.delta', output_index: 0, delta: text })
  output.forEach((item, output_index) => events.push({ type: 'response.output_item.done', output_index, item }))
  events.push({ type: 'response.completed', response: { id: 'resp_owned_mode', status: 'completed', output, usage: { input_tokens: 10, output_tokens: 10 } } })
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`)
  response.end()
}

function respondText(response, text) {
  respond(response, [{ id: 'msg_owned_mode', type: 'message', content: [{ type: 'output_text', text, annotations: [] }] }], text)
}

function judgmentInput(body) {
  for (const message of body.input ?? []) {
    const text = typeof message.content === 'string' ? [message.content] : (message.content ?? []).map(block => block.text).filter(value => typeof value === 'string')
    for (const value of text) {
      try { const parsed = JSON.parse(value); if (parsed?.pendingAction) return parsed } catch { /* Other text is not the classifier's data envelope. */ }
    }
  }
  throw new Error('The selected classifier received no pending-action data envelope.')
}

async function setPlan(context, boundary) {
  const requestId = `owned-plan-${context.test.name}`
  assert.ok(!context.controls.some(row => row.requestId === requestId), 'one native mode change per case')
  context.child.stdin.write(JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'set_permission_mode', mode: 'plan' } }) + '\n')
  const until = Date.now() + 10_000
  while (!context.controls.some(row => row.requestId === requestId) && Date.now() < until && context.child.exitCode === null) await delay(20)
  const ack = context.controls.find(row => row.requestId === requestId)
  assert.equal(ack?.subtype, 'success', 'real native mode-control acknowledgement succeeds')
  assert.equal(ack.mode, 'plan', 'real native acknowledgement binds plan mode')
  context.barrier = { boundary, acknowledgement: ack, providerReleasedAfterAck: true }
}

const server = createServer(async (request, response) => {
  const match = /^\/cases\/([0-3])\/(.*)$/.exec(request.url.split('?')[0])
  const context = match ? contexts.get(Number(match[1])) : undefined
  if (!context) return json(response, { error: 'Unknown owned fixture endpoint' }, 404)
  try {
    let raw = ''
    for await (const bytes of request) { raw += bytes; assert.ok(raw.length <= 4 * 1024 * 1024, 'bounded owned provider request') }
    const body = raw ? JSON.parse(raw) : undefined
    const classifier = typeof body?.instructions === 'string' && body.instructions.startsWith('Judge one pending tool action')
    const native = match[2].startsWith('native')
    // A native request keeps a short, nonsecret summary so a failure names what reached Claude.
    const system = native ? (typeof body?.system === 'string' ? body.system : Array.isArray(body?.system) ? body.system.map(block => block?.text ?? '').join(' ') : '') : ''
    const row = { method: request.method, path: match[2], classifier, native, credentialFree: !request.headers.authorization && !request.headers['x-api-key'],
      ...(native && body ? { model: body.model, tools: (body.tools ?? []).length, system: system.slice(0, 160), lastUser: JSON.stringify(body.messages?.at(-1)?.content ?? '').slice(0, 200) } : {}) }
    context.requests.push(row)
    if (match[2] !== 'selected/v1/responses') return json(response, { type: 'error', error: { type: 'rate_limit_error', message: 'Owned exhausted native subscription' } }, 429)
    assert.equal(row.credentialFree, true, 'synthetic selected provider receives no credentials')
    if (classifier) {
      const data = judgmentInput(body)
      row.tool = data.pendingAction.tool
      row.noTools = !body.tools?.length
      row.strictSchema = body.text?.format?.type === 'json_schema'
      assert.ok(row.noTools && row.strictSchema, 'selected judgment uses no tools and strict JSON')
      assert.ok(data.userIntent.some(text => text.includes('OWNED_MAIN_HUMAN_INTENT')), 'actual owning human intent reaches the judgment')
      assert.ok(data.userIntent.every(text => !text.includes('OWNED_CHILD_CONSTRAINT')), 'child instructions are not promoted to human authority')
      if (row.tool === 'Bash') {
        assert.equal(data.pendingAction.input.command, command, 'judge receives the actual action')
        row.childConstraints = !context.test.child || data.instructions?.includes(childConstraint) === true
        assert.equal(row.childConstraints, true, 'child constraints remain in separately labeled instructions')
        if (context.test.changeDuringJudgment) await setPlan(context, 'pending-bash-judgment')
      }
      return respondText(response, JSON.stringify({ decision: 'allow', reason: 'The exact owned marker action was requested.' }))
    }
    assert.equal(context.test.child, true, 'only a real child asks for a normal model turn')
    if (context.modelTurns++ > 0) return respondText(response, 'OWNED_CHILD_DONE')
    if (context.test.explicitAuto) await setPlan(context, 'before-child-tool')
    return respond(response, [{ id: 'fc_owned_mode_bash', type: 'function_call', call_id: 'toolu_owned_mode_bash', name: 'Bash', arguments: JSON.stringify({ command, description: 'Write and print only the owned fixture marker' }) }])
  } catch (error) {
    context.providerFailure = String(error?.message || error).slice(0, 1000)
    if (!response.headersSent) json(response, { error: context.providerFailure }, 500)
    else response.destroy()
  }
})

function terminate(context, signal = 'SIGTERM') {
  const child = context?.child
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10_000 })
  else try { process.kill(-child.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error }
}

async function cleanup(context) {
  terminate(context)
  if (!context?.closed) return
  if (await Promise.race([context.closed.then(() => true), delay(5000, false, { ref: false })])) return
  terminate(context, 'SIGKILL')
  assert.equal(await Promise.race([context.closed.then(() => true), delay(5000, false, { ref: false })]), true, 'owned native process exits after cleanup')
}

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { interrupted = true; terminate(active) })

const waitSource = `import{existsSync}from'node:fs';import{setTimeout as delay}from'node:timers/promises';const[file,limit]=process.argv.slice(2);const until=Date.now()+Number(limit);while(!existsSync(file)){if(Date.now()>until)process.exit(3);await delay(25)}`
compile(waitSource)

async function runCase(test, index, base) {
  phase = test.name
  const directory = join(fixture, test.name), plugin = join(directory, 'plugin'), caller = join(directory, 'caller'), config = join(directory, '.claude')
  mkdirSync(directory); mkdirSync(join(config, 'agents'), { recursive: true }); mkdirSync(plugin); mkdirSync(join(plugin, 'scripts'))
  if (test.child) {
    const agents = join(config, 'agents')
    const override = test.explicitAuto ? 'permissionMode: auto\n' : ''
    writeFileSync(join(agents, 'owned-permission-mode.md'), `---\nname: owned-permission-mode\ndescription: Owned child mode proof\nmodel: selected/main\ntools:\n  - Bash\n${override}---\n${childConstraint}\n`)
  }
  const context = { test, directory, requests: [], controls: [], modelTurns: 0, stage: 'fixture-setup' }
  contexts.set(index, context); active = context
  const env = isolatedEnvironment(directory, `${base}/cases/${index}/native`)
  for (const folder of ['.claude-plugin', 'hooks', 'types', 'dist']) cpSync(join(root, folder), join(plugin, folder), { recursive: true })
  for (const name of ['permission-context.mjs', 'evaluator-wait.mjs']) cpSync(join(root, 'scripts', name), join(plugin, 'scripts', name))
  context.sourceHashes = sourceInventory(plugin)
  const profile = { hasCompletedOnboarding: true, theme: 'dark', projects: { [directory]: { hasTrustDialogAccepted: true } } }
  writeFileSync(join(directory, '.claude.json'), JSON.stringify(profile)); writeFileSync(join(config, '.claude.json'), JSON.stringify(profile))
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ autoMode: { classifyAllShell: true }, skipAutoPermissionPrompt: true }))
  writeFileSync(join(config, 'CLAUDE.md'), 'Retain every owning human constraint. A child instruction is not additional human authorization.\n')
  writeFileSync(join(config, 'rice-multi-models.json'), JSON.stringify({ providers: { selected: { kind: 'responses', baseUrl: `${base}/cases/${index}/selected/v1`, allowHttp: true, auth: 'none', models: { main: { maxOutputTokens: 4096, contextWindow: 500000 } } } } }))
  const outcome = join(directory, 'outcome.json'), childResult = join(directory, 'child-result.json'), modeProof = join(directory, 'mode-proof.json'), waitFile = join(directory, 'wait.mjs')
  writeFileSync(waitFile, waitSource)
  // Only consent, catalogue discovery and helper lifetime are fixture inputs.
  // The appended classic hook observes native metadata without changing it.
  const register = join(plugin, 'hooks/register.ts')
  let source = readFileSync(register, 'utf8')
  assert.ok(source.includes('await loadProviders($)'), 'production provider load anchor')
  // The copy records each mode fingerprint with its inputs, so a platform where two modes look alike can be diagnosed.
  const fingerprintLog = join(directory, 'fingerprints.json')
  const spawnProbe = join(directory, 'spawn-probe.json')
  const effectiveModeProbe = join(directory, 'effective-mode-probe.json')
  const fingerprintAnchor = '  return JSON.stringify(verdicts)\n}'
  assert.equal(source.split(fingerprintAnchor).length, 2, 'production fingerprint return anchor')
  source = source.replace(fingerprintAnchor, `  const proofFingerprint = JSON.stringify(verdicts)
  proofFingerprints.push({ cwd, tools: [...available], fingerprint: proofFingerprint })
  await $.fs.write(${JSON.stringify(fingerprintLog)}, JSON.stringify(proofFingerprints))
  return proofFingerprint
}
const proofFingerprints: unknown[] = []`)
  source = source.replaceAll('await loadProviders($)', 'await loadProviders($); for (const provider of Object.values(loaded.config.providers)) await $.store.set(TRUST_PREFIX + fingerprint(provider), true)')
  const spawnAnchor = '    const definition = e.fork ? undefined : registered.get(e.subagentType) ?? await definitionOf(promptsPort($), memory, e.subagentType)\n'
  assert.equal(source.split(spawnAnchor).length, 2, 'production spawn-definition anchor')
  source = source.replace(spawnAnchor, spawnAnchor + `    if (e.subagentType === 'owned-permission-mode') await $.fs.write(${JSON.stringify(spawnProbe)}, JSON.stringify({ registered: registered.has(e.subagentType), permissionMode: definition?.permissionMode, contested: await contested(promptsPort($), memory, e.subagentType) }))\n`)
  const modeAnchor = '    const context = e.tool_use_id ? toolModes.get(e.tool_use_id) : undefined\n'
  assert.equal(source.split(modeAnchor).length, 2, 'production permission-mode anchor')
  source = source.replace(modeAnchor, modeAnchor + `    if (e.tool === 'Bash' && e.tool_use_id) await $.fs.write(${JSON.stringify(effectiveModeProbe)}, JSON.stringify({ mode: context?.mode, agentId: e.agentId, decision: verdict.decision }))\n`)
  const close = source.lastIndexOf('\n}'); assert.ok(close > 0, 'production registration boundary')
  source = source.slice(0, close) + `
  on('state.get', {plugin:'rice-multi-models',key:'prefs'}, () => ({value:{value:{effort:null,transport:'sse',helper:'once'},version:0}}))
  on('process.run', async ($, e, next) => e.argv.includes('discover') ? {value:{exitCode:0,stdout:JSON.stringify({models:[],providers:[]}),stderr:'',isStdoutTruncated:false,isStderrTruncated:false}} : next(e))
  on('classic.PreToolUse', {tool:'Bash'}, async ($, e, next) => {
    const result=await next(e)
    if(e.tool==='Bash'){
      const proof=consumePermissionContext(result.additionalContext??[],{nonce:permissionContextNonce,sessionId:await $.session.id(),toolUseId:e.tool_use_id}).proof
      await $.fs.write(${JSON.stringify(modeProof)},JSON.stringify(proof??null))
    }
    return result
  })
` + source.slice(close)
  writeFileSync(register, source)
  const driver = `export const register=on=>{
    on('tool.call',{tool:'Bash'},async($,e,next)=>{const result=await next(e);await $.fs.write(${JSON.stringify(childResult)},JSON.stringify({agentId:e.agentId,toolUseId:e.tool_use_id,result}));return result;});
    on('turn.step',async function*($,e,next){if(e.agentId!==undefined)return yield*next(e);
      const observation={};let agentId;
      try{
        if(${JSON.stringify(test.child)}){
          const spawned=await $.agent.spawn({subagentType:'owned-permission-mode',prompt:${JSON.stringify(childConstraint + '\n' + command)},description:'Owned child mode proof'});observation.spawned=spawned;
          if(spawned.deny||!spawned.agentId)throw new Error('Owned child spawn prerequisite failed');agentId=spawned.agentId;
          const waited=await $.process.run([${JSON.stringify(process.execPath)},${JSON.stringify(waitFile)},${JSON.stringify(childResult)},${JSON.stringify(String(childLimit))}],{timeoutMs:${childLimit + 5000}});
          if(waited.exitCode!==0)throw new Error('Owned child Bash result deadline expired');
        }else observation.result=await $.tool.call({tool:'Bash',command:${JSON.stringify(command)},description:'Write and print only the owned marker'});
      }catch(error){observation.failure=String(error?.message||error).slice(0,1000);}
      finally{if(agentId){try{observation.stopped=await $.tool.call({tool:'TaskStop',task_id:agentId});}catch(error){observation.stopFailure=String(error?.message||error).slice(0,1000);}}await $.fs.write(${JSON.stringify(outcome)},JSON.stringify(observation));}
      const answer='OWNED_PERMISSION_MODE_DONE';yield{kind:'text',index:0,text:answer};yield{kind:'stop',stopReason:'end_turn',usage:null};return{turnId:e.turnId,index:e.index,answer,toolUses:[],stopReason:'end_turn',usage:null};
    });
  };`
  compile(driver)
  mkdirSync(join(caller, '.claude-plugin'), { recursive: true }); mkdirSync(join(caller, 'hooks'))
  writeFileSync(join(caller, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'a-owned-permission-mode', version: '1.0.0', description: 'Owned native mode acceptance', author: { name: 'Owned fixture' } }))
  writeFileSync(join(caller, 'hooks/hooks.json'), JSON.stringify({ modules: ['./register.js'] })); writeFileSync(join(caller, 'hooks/register.js'), driver)
  context.stage = 'plugin-validation'
  for (const folder of [caller, plugin]) {
    const checked = spawnSync(native, ['plugin', 'validate', '--strict', folder], { cwd: directory, env, encoding: 'utf8', timeout: 15_000, windowsHide: true })
    assert.equal(checked.status, 0, (checked.stdout + checked.stderr).slice(-2000))
  }
  const started = Date.now()
  context.stage = 'native-initialize'
  context.child = spawn(native, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--name', 'Owned permission mode', '--model', 'selected/main', '--plugin-dir', caller, '--plugin-dir', plugin, '--setting-sources', 'user', '--permission-mode', 'auto', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', 'Agent,Bash,Edit,TaskStop,Write', '--allowedTools', 'Agent,TaskStop'], { cwd: directory, env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const child = context.child
  context.closed = new Promise(resolve => { child.once('close', (code, signal) => resolve({ code, signal })); child.once('error', error => { context.spawnFailure = String(error.message); resolve({ code: null, signal: null }) }) })
  console.log(JSON.stringify({ phase, ownedPid: child.pid, startedAt: new Date().toISOString(), fixture: directory, preload: false }))
  let stdout = '', stderr = '', buffer = '', timedOut = false
  child.stdin.on('error', error => { context.stdinFailure = error.code })
  child.stdout.on('data', bytes => {
    if (stdout.length + bytes.length > 8 * 1024 * 1024) { context.captureFailure = 'native stdout exceeded 8MiB'; terminate(context); return }
    stdout += bytes; buffer += bytes
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
      let row; try { row = JSON.parse(line) } catch { continue }
      if (row.type === 'control_response') context.controls.push({ requestId: row.response?.request_id, subtype: row.response?.subtype, ...(row.response?.response?.mode === undefined ? {} : { mode: row.response.response.mode }) })
      if (row.type === 'result') child.stdin.end()
    }
  })
  child.stderr.on('data', bytes => {
    if (stderr.length + bytes.length > 8 * 1024 * 1024) { context.captureFailure = 'native stderr exceeded 8MiB'; terminate(context); return }
    stderr += bytes
  })
  const timer = setTimeout(() => { timedOut = true; terminate(context) }, caseLimit)
  try {
    child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'owned-initialize', request: { subtype: 'initialize' } }) + '\n')
    const until = Date.now() + 15_000
    while (!context.controls.some(row => row.requestId === 'owned-initialize') && Date.now() < until && child.exitCode === null) await delay(20)
    assert.equal(context.controls.find(row => row.requestId === 'owned-initialize')?.subtype, 'success', 'native stream-json initialization')
    context.stage = 'native-action'
    child.stdin.write(JSON.stringify({ type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: humanIntent } }) + '\n')
    const terminal = await context.closed
    context.stage = 'assertions'
    const observed = existsSync(outcome) ? JSON.parse(readFileSync(outcome)) : null
    const result = test.child && existsSync(childResult) ? JSON.parse(readFileSync(childResult)) : { result: observed?.result }
    const proof = existsSync(modeProof) ? JSON.parse(readFileSync(modeProof)) : null
    const effectiveMode = existsSync(effectiveModeProbe) ? JSON.parse(readFileSync(effectiveModeProbe)) : null
    const spawnMode = existsSync(spawnProbe) ? JSON.parse(readFileSync(spawnProbe)) : null
    const run = { name: test.name, ...terminal, timedOut, durationMs: Date.now() - started, requests: context.requests, controls: context.controls, barrier: context.barrier, observation: observed, toolResult: result, modeProof: proof, effectiveMode, spawnMode, markerWritten: existsSync(join(directory, 'owned-mode-marker')), sourceHashes: context.sourceHashes, fixtureRegister: hash(readFileSync(register)), ...(context.providerFailure ? { providerFailure: context.providerFailure } : {}) }
    runs.push(run)
    writeFileSync(join(directory, 'native.stdout.jsonl'), stdout); writeFileSync(join(directory, 'native.stderr.log'), stderr)
    writeFileSync(join(directory, 'receipt.json'), JSON.stringify(run, null, 2))
    assert.equal(interrupted, false, 'proof was not interrupted'); assert.equal(timedOut, false, 'bounded native deadline'); assert.equal(terminal.code, 0, stderr.slice(-2000))
    assert.equal(context.captureFailure, undefined, 'bounded native output'); assert.equal(context.providerFailure, undefined, 'owned provider contract'); assert.ok(observed, 'native driver finishes'); assert.equal(observed.failure, undefined, 'native fixture prerequisites')
    if (test.explicitAuto) {
      assert.equal(spawnMode?.permissionMode, 'auto', 'native agent frontmatter defines the child mode')
      assert.equal(spawnMode?.contested, false, 'the child agent definition is unambiguous')
      assert.equal(effectiveMode?.mode, 'auto', 'agent frontmatter mode reaches the selected permission path')
    } else assert.equal(proof?.mode, 'auto', 'actual action begins in auto mode')
    assert.equal(result.result?.deny === undefined && result.result?.isError !== true, test.approved, 'native action approval matches the case')
    assert.equal(run.markerWritten, test.approved, 'real action marker matches approval')
    const judgments = context.requests.filter(row => row.classifier)
    assert.equal(judgments.filter(row => row.tool === 'Bash').length, 1, 'one selected Bash judgment')
    assert.equal(context.requests.some(row => row.native && row.method === 'POST'), false, `zero native inference POSTs: ${JSON.stringify(context.requests.filter(row => row.native && row.method === 'POST'))}`)
    if (test.changeDuringJudgment || test.explicitAuto) assert.equal(context.barrier?.providerReleasedAfterAck, true, 'real ACK barrier precedes the selected reply')
    if (test.child) {
      assert.ok(observed.spawned?.agentId, 'real child was spawned')
      assert.equal(result.agentId, observed.spawned.agentId, 'native tool result belongs to the exact child')
      assert.equal(proof.agentId, observed.spawned.agentId, 'native metadata belongs to the exact child')
      assert.equal(proof.toolUseId, result.toolUseId, 'native mode proof binds the actual tool call')
      assert.equal(observed.stopped?.result?.task_id, observed.spawned.agentId, 'cleanup names the exact owned child')
      assert.ok(observed.stopped.result.message.includes('Successfully stopped'), 'owned child stop is confirmed')
    } else assert.equal(proof.agentId, undefined, 'main mode proof has no child identity')
    console.log(JSON.stringify({ phase, passed: true, selectedJudgments: judgments.length, nativeInferencePosts: 0, ...(test.child ? { ownedChild: observed.spawned.agentId, stopped: true } : {}) }))
    context.stage = 'complete'
  } finally {
    clearTimeout(timer); await cleanup(context)
    writeFileSync(join(directory, 'native.stdout.jsonl'), stdout); writeFileSync(join(directory, 'native.stderr.log'), stderr)
    if (!runs.some(run => run.name === test.name)) writeFileSync(join(directory, 'receipt.json'), JSON.stringify({ name: test.name, stage: context.stage, code: child.exitCode, signal: child.signalCode, timedOut, durationMs: Date.now() - started, requests: context.requests, controls: context.controls, sourceHashes: context.sourceHashes, spawnFailure: context.spawnFailure, captureFailure: context.captureFailure, stdinFailure: context.stdinFailure }, null, 2))
    if (context.stage === 'complete') active = undefined
  }
}

try {
  assert.ok(Number(process.versions.node.split('.')[0]) >= 22, 'Node.js22 or newer is required')
  for (const path of ['hooks/register.ts', 'hooks/permission-context.ts', 'dist/helper.mjs', 'dist/helper.meta.json']) assert.ok(existsSync(join(root, path)), `Required built input is missing: ${path}`)
  const directory = join(fixture, 'prerequisites'); mkdirSync(directory); mkdirSync(join(directory, '.claude'))
  const env = isolatedEnvironment(directory, 'http://127.0.0.1:1')
  const check = commandName => spawnSync(commandName, ['--version'], { cwd: directory, env, encoding: 'utf8', timeout: 10_000, windowsHide: true })
  // The production loader starts claude from PATH, through cmd.exe for an npm .cmd shim on Windows.
  const actual = check(native)
  let policy = check('claude')
  if (policy.status !== 0 && process.platform === 'win32') policy = spawnSync('cmd.exe', ['/d', '/s', '/c', 'claude', '--version'], { cwd: directory, env, encoding: 'utf8', timeout: 10_000, windowsHide: true })
  assert.equal(actual.status, 0, 'The native Claude executable must be available.')
  version = actual.stdout.trim()
  assert.match(version, /^\d+\.\d+\.\d+ \(Claude Code\)$/)
  assert.equal(policy.status, 0, 'The production permission-policy loader needs claude on PATH.')
  assert.equal(policy.stdout.trim(), version, 'RICE_CLAUDE_EXECUTABLE and PATH claude must be the same native version.')
  let bash = 'bash'
  if (process.platform === 'win32') {
    bash = env.CLAUDE_CODE_GIT_BASH_PATH || [join(env.ProgramFiles || 'C:\\Program Files', 'Git/bin/bash.exe'), join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git/bin/bash.exe')].find(existsSync)
    assert.ok(bash, 'Native Windows Bash acceptance requires installed Git Bash or CLAUDE_CODE_GIT_BASH_PATH.')
  }
  const shell = spawnSync(bash, ['--noprofile', '--norc', '-c', 'printf OWNED_BASH_READY'], { cwd: directory, env, encoding: 'utf8', timeout: 10_000, windowsHide: true })
  assert.equal(shell.status, 0, 'Native Bash prerequisite'); assert.equal(shell.stdout, 'OWNED_BASH_READY')
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  for (const [index, test] of cases.entries()) await runCase(test, index, base)
  console.log(JSON.stringify({ publicPermissionMode: true, cases: runs.length, nativeVersion: version, nativeInferencePosts: 0, fixture, scope: 'Actual native mode controls, production selected-provider permission judgments, main and same-process child tool execution; controlled local provider only.' }))
} catch (error) {
  if (active && !existsSync(join(active.directory, 'receipt.json'))) writeFileSync(join(active.directory, 'receipt.json'), JSON.stringify({ name: active.test.name, stage: active.stage, requests: active.requests, controls: active.controls, sourceHashes: active.sourceHashes }, null, 2))
  failure = { phase, ...(active ? { stage: active.stage, caseReceipt: join(active.directory, 'receipt.json'), ownedPid: active.child?.pid } : {}), name: error?.name || 'Error', message: String(error?.message || error).slice(0, 4000) }
  console.error(JSON.stringify({ publicPermissionMode: false, fixture, failure })); process.exitCode = 1
} finally {
  await cleanup(active)
  server.closeAllConnections()
  if (server.listening) await new Promise(resolve => server.close(resolve))
  writeFileSync(join(fixture, 'receipt.json'), JSON.stringify({ fixture, nativeVersion: version, scope: 'Four ordinary-Claude mode and child permission cases; local synthetic provider, no real accounts or preload.', runs, ...(failure ? { failure } : {}) }, null, 2))
}
