// Separate native runs can vary in session-scoped descriptions and tool exposure.
// Compare stable Agent schemas, then check routed Agent and ListAgents descriptions against the live session.
// Each run has its own HOME and configuration folder and uses owned loopback stubs, with no external inference or account access.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import ts from 'typescript'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const native = process.env.RICE_CLAUDE_EXECUTABLE || 'claude'
const fixture = mkdtempSync(join(tmpdir(), 'rice-public-tools-'))
const KEPT = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'ProgramFiles', 'ProgramFiles(x86)', 'CLAUDE_CODE_GIT_BASH_PATH']
const AGENT_BODY = 'OWNED_PROOF_AGENT_BODY\nIt answers in one line.'
let child

const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(block => block?.text ?? '').join('\n') : ''
const byName = (tools, name) => tools.find(tool => tool.name === name)
const lastBlock = body => Array.isArray(body.system) ? body.system.at(-1).text : String(body.system)
const names = tools => tools.map(tool => tool.name).sort()
function generatedSchemaInfo() {
  const file = join(root, 'hooks/schemas.gen.ts')
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const declarations = source.statements.flatMap(statement => ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [])
  const stamp = declarations.find(each => ts.isIdentifier(each.name) && each.name.text === 'STAMP')
  const schemas = declarations.find(each => ts.isIdentifier(each.name) && each.name.text === 'SCHEMAS')
  assert.ok(stamp?.initializer && ts.isObjectLiteralExpression(stamp.initializer), 'generated built-in schema stamp exists')
  assert.ok(schemas?.initializer && ts.isObjectLiteralExpression(schemas.initializer), 'generated built-in schema table exists')
  const version = stamp.initializer.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(source) === 'engineVersion')?.initializer
  assert.ok(version && ts.isStringLiteral(version), 'generated built-in schema version is a string')
  return { version: version.text, schemas: JSON.parse(schemas.initializer.getText(source)) }
}
function terminate() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10_000 })
  else try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
}
function isolated(name, extra = {}) {
  const home = join(fixture, name), config = join(home, '.claude')
  mkdirSync(join(config, 'agents'), { recursive: true })
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }))
  writeFileSync(join(config, 'settings.json'), '{}')
  const env = Object.fromEntries(KEPT.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  Object.assign(env, { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: config, CODEX_HOME: join(home, '.codex'), ANTHROPIC_API_KEY: 'owned-no-network', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ...extra })
  return { home, config, env }
}
async function finish(label, limit = 60_000) {
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
  const fallback = generatedSchemaInfo()
  const fallbackSchemas = fallback.schemas

  // 1. An independent native run: the default tools, a custom agent file, and every built-in agent type the engine
  // lists, each started in the foreground and in the background by the stub's answer.
  const first = isolated('native')
  writeFileSync(join(first.config, 'agents', 'owned-proof-agent.md'), `---\nname: owned-proof-agent\ndescription: Owned proof agent\n---\n\n${AGENT_BODY}\n\n`)
  writeFileSync(join(first.config, 'agents', 'owned-proof-restricted-agent.md'), `---\nname: owned-proof-restricted-agent\ndescription: Owned restricted proof agent\ntools: [Read]\n---\n\n${AGENT_BODY}\n\n`)
  const requests = []
  let listed, spawned = false, started
  // The agent types come from the engine's start event, which can reach this process after its first request.
  const start = new Promise(resolve => { started = resolve })
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const bytes of request) raw += bytes
    if (request.url.startsWith('/v1/messages/count_tokens')) { response.writeHead(200, { 'content-type': 'application/json' }); return response.end('{"input_tokens":10}') }
    if (request.method !== 'POST' || !request.url.startsWith('/v1/messages')) { response.writeHead(404); return response.end() }
    const body = JSON.parse(raw)
    const opening = textOf(body.messages[0]?.content)
    const task = /OWNED_PROOF_TASK (\S+) (\S+)/.exec(opening)
    requests.push({ body, type: task?.[1], background: task?.[2] === 'background', main: opening.includes('OWNED_PROOF_MAIN') && !task })
    if (!task && !spawned) await Promise.race([start, new Promise(resolve => setTimeout(resolve, 20_000))])
    const calls = !task && !spawned && listed && (body.tools ?? []).some(tool => tool.name === 'Agent')
      ? (spawned = true, listed.flatMap((type, index) => [false, true].map(background => ({ id: `toolu_owned_${index}_${background}`, name: 'Agent', input: { description: `Proof ${type}`, prompt: `OWNED_PROOF_TASK ${type} ${background ? 'background' : 'foreground'}`, subagent_type: type, run_in_background: background } }))))
      : []
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (event, value) => response.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...value })}\n\n`)
    send('message_start', { message: { id: 'msg_owned', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
    if (calls.length) calls.forEach((call, index) => { send('content_block_start', { index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } }); send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } }); send('content_block_stop', { index }) })
    else { send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }); send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'OWNED_DONE' } }); send('content_block_stop', { index: 0 }) }
    send('message_delta', { delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } })
    send('message_stop', {}); response.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  first.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`
  child = spawn(native, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--setting-sources', 'user', '--permission-mode', 'default', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'], { cwd: first.home, env: first.env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
  console.log(JSON.stringify({ phase: 'independent-native-run', ownedPid: child.pid }))
  let pending = ''
  child.stdout.on('data', bytes => {
    pending += bytes
    for (let at = pending.indexOf('\n'); at !== -1; at = pending.indexOf('\n')) {
      const line = pending.slice(0, at); pending = pending.slice(at + 1)
      let event; try { event = JSON.parse(line) } catch { continue }
      if (event.type === 'system' && event.subtype === 'init' && !listed) { listed = event.agents; started() }
      if (event.type === 'result') child.stdin.end()
    }
  })
  child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'OWNED_PROOF_MAIN' } })}\n`)
  await finish('independent native run')
  server.closeAllConnections(); server.close()
  const nativeMain = requests.find(row => row.main)?.body
  assert.ok(nativeMain?.tools?.length, 'the native run sent its tools')
  assert.ok(listed.length > 0, 'the installed engine lists its built-in agent types')
  assert.ok(listed.every(type => !type.startsWith('rice-multi-models:')), 'native agent definitions include no mod-owned type')
  const agentRequest = (type, background) => requests.find(row => row.type === type && row.background === background)?.body

  // 2. The shipped helper reads the installed engine's definitions in its own isolated run.
  const helper = spawnSync(process.execPath, [join(root, 'dist/helper.mjs'), 'capture-tools'], { input: JSON.stringify({ tools: nativeMain.tools.map(tool => tool.name) }), encoding: 'utf8', timeout: 120_000, env: first.env })
  const result = JSON.parse(helper.stdout)
  assert.equal(result.ok, true, result.error)
  const capture = result.capture
  assert.equal(capture.version, installedVersion, 'tool capture must name the installed Claude Code build')
  assert.equal(typeof capture.prompts.Explore, 'string', 'the helper captures the routed Explore prompt')
  assert.ok(Array.isArray(capture.offered.Explore?.foreground), 'the helper captures the foreground Explore tool offer')
  const independentlySent = new Map(nativeMain.tools.map(tool => [tool.name, tool]))
  for (const tool of capture.tools) {
    const independent = independentlySent.get(tool.name)
    if (independent) assert.deepEqual(tool.input_schema, independent.input_schema, `${tool.name} input schema matches the independent native run`)
  }
  for (const name of ['Agent', 'ListAgents']) {
    const nativeTool = byName(nativeMain.tools, name)
    const capturedTool = byName(capture.tools, name)
    assert.ok(nativeTool && capturedTool, `native and helper captures include ${name}`)
    assert.deepEqual(capturedTool.input_schema, nativeTool.input_schema, `${name} schema remains stable across captures`)
  }
  const compared = []
  for (const type of listed) {
    for (const background of [false, true]) {
      const body = agentRequest(type, background)
      if (!body) continue
      const custom = type === 'owned-proof-agent' || type === 'owned-proof-restricted-agent'
      const own = custom ? AGENT_BODY : capture.prompts[type]
      assert.equal(typeof own, 'string', `the capture holds the ${type} prompt`)
      assert.equal(capture.agentHead + own + capture.agentTail, lastBlock(body), `the ${type} prompt equals the native run, byte for byte`)
      const nativeAgentTools = new Map(body.tools.map(tool => [tool.name, tool]))
      for (const tool of nativeAgentTools.values()) {
        const capturedTool = independentlySent.get(tool.name)
        if (capturedTool) assert.deepEqual(tool.input_schema, capturedTool.input_schema, `the ${type} ${tool.name} input schema matches the native capture`)
      }
      compared.push(`${type}:${background ? 'background' : 'foreground'}`)
    }
  }
  assert.ok(compared.includes('Explore:foreground') && compared.includes('general-purpose:background') && compared.includes('owned-proof-agent:foreground') && compared.includes('owned-proof-restricted-agent:foreground'))

  // 3. A routed session through the mod: its main request and an Explore subagent's carry exactly those texts.
  const second = isolated('routed', { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' })
  const plugin = join(fixture, 'plugin'), evidence = join(fixture, 'wires.json'), spawnEvidence = join(fixture, 'spawn.json')
  mkdirSync(join(second.home, '.claude', 'agents'), { recursive: true })
  writeFileSync(join(second.home, '.claude', 'agents', 'owned-proof-restricted-agent.md'), `---\nname: owned-proof-restricted-agent\ndescription: Owned routed restricted proof agent\nmodel: codex/owned-child\ntools: [Read]\n---\n\n${AGENT_BODY}\n\n`)
  for (const directory of ['.claude-plugin', 'hooks', 'types', 'dist', 'scripts']) cpSync(join(root, directory), join(plugin, directory), { recursive: true })
  const file = join(plugin, 'hooks/register.ts')
  let source = readFileSync(file, 'utf8')
  const decisionLine = '    const decision = spawnDecision({ parentModel, requested: e.model, definitionModel: definition?.model, fork: e.fork }, tiers(), familyPorts)'
  assert.ok(source.includes(decisionLine), 'production spawn decision boundary')
  source = source.replace(decisionLine, `${decisionLine}\n    await $.fs.write(${JSON.stringify(spawnEvidence)},JSON.stringify({ type:e.subagentType, requested:e.model??null, definitionModel:definition?.model??null, selected:decision.model??null, reason:decision.reason }))`)
  const close = source.lastIndexOf('\n}')
  assert.ok(close > 0)
  source = source.slice(0, close) + `
  on('state.get', {plugin:'rice-multi-models',key:'prefs'}, () => ({value:{value:{effort:null,transport:'auto',helper:'once'},version:0}}))
  on('process.run', async ($, e, next) => {
    if (!e.argv.includes('discover')) return next(e)
    const metadata={contextWindow:500000,maxContextWindow:500000,inputTokenLimit:null,outputTokenLimit:32768,autoCompactTokenLimit:null,inputModalities:['text'],reasoningEfforts:null,tools:null,parallelToolCalls:null}
    return {value:{exitCode:0,stdout:JSON.stringify({models:['codex/owned-public','codex/owned-child'].map(model=>({model,label:'Owned',execution:'native provider',source:'owned fixture',observedAt:1800000000000,metadata})),providers:[{provider:'codex',status:'fresh',source:'owned fixture'}]}),stderr:'',isStdoutTruncated:false,isStderrTruncated:false}}
  })
  on('process.spawn', async function* ($, e, next) {
    if (!e.argv.includes('once')) return yield* next(e)
    const req=JSON.parse(e.input || '{}').req
    const rows=await $.fs.exists(${JSON.stringify(evidence)})?JSON.parse(await $.fs.read(${JSON.stringify(evidence)})):[]
    const live=(await $.tool.list()).map(info=>({name:info.name,description:info.description}))
    rows.push({who:req.who,target:req.target,system:req.system,tools:req.tools,live})
    await $.fs.write(${JSON.stringify(evidence)},JSON.stringify(rows))
    const answered=JSON.stringify(req.transcript).includes('tool_result')
    const events=req.who==='main'&&!answered
      ?[{type:'tool_use',id:'toolu_owned_custom',name:'Agent',input:{description:'Owned custom agent',prompt:'Find the owned marker',subagent_type:'owned-proof-restricted-agent',run_in_background:false}},{type:'usage',in:10,out:2,cacheRead:0,cacheWrite:0},{type:'stop',reason:'tool_use'}]
      :[{type:'text',text:req.who==='main'?'OWNED_MAIN_DONE':'OWNED_EXPLORE_REPORT'},{type:'usage',in:10,out:2,cacheRead:0,cacheWrite:0},{type:'stop',reason:'end_turn'}]
    for (const event of events) yield {stream:'stdout',text:JSON.stringify(event)+'\\n'}
    return {value:{code:0,signal:null}}
  })
` + source.slice(close)
  writeFileSync(file, source)
  const checked = spawnSync(native, ['plugin', 'validate', '--strict', plugin], { cwd: second.home, env: second.env, encoding: 'utf8', timeout: 20_000 })
  assert.equal(checked.status, 0, (checked.stdout + checked.stderr).slice(-2000))
  child = spawn(native, ['-p', '--model', 'codex/owned-public', '--plugin-dir', plugin, '--setting-sources', 'user', '--permission-mode', 'default', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], { cwd: second.home, env: second.env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
  console.log(JSON.stringify({ phase: 'routed-session', ownedPid: child.pid }))
  let stdout = '', stderr = ''
  child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes)
  child.stdin.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'Use one owned-proof-restricted-agent, then finish.' } })}\n`)
  assert.equal(await finish('routed session', 90_000), 0, (stdout + stderr).slice(-2000))
  const events = stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
  const init = events.find(event => event.type === 'system' && event.subtype === 'init')
  const nativeResult = events.findLast(event => event.type === 'result')
  const loadedAgents = Array.isArray(init?.agents) ? init.agents : []
  assert.ok(loadedAgents.length > 0, 'the ordinary CLI reported its loaded agent types')
  assert.ok(loadedAgents.every(type => !type.startsWith('rice-multi-models:')), 'the loaded plugin registered no mod-owned agent type')
  assert.equal(nativeResult?.is_error, false, stdout.slice(-1000))
  const wires = JSON.parse(readFileSync(evidence, 'utf8'))
  const main = wires.find(row => row.who === 'main'), custom = wires.find(row => row.who !== 'main')
  assert.ok(main && custom, 'the routed main and its custom agent were both sent')
  const capturedByName = new Map(capture.tools.map(tool => [tool.name, tool]))
  const looseSchema = { type: 'object', additionalProperties: true }
  const assertRoutedSchemas = (tools, stage) => {
    for (const tool of tools) {
      const captured = capturedByName.get(tool.name) ?? independentlySent.get(tool.name)
      const schema = captured?.input_schema ?? fallbackSchemas[tool.name] ?? looseSchema
      assert.deepEqual(tool.schema, schema, `${stage} ${tool.name} input schema matches the capture, native request, or documented fallback`)
      assert.equal(typeof tool.description, 'string', `${stage} ${tool.name} retains its session description`)
    }
  }
  for (const wire of [main, custom]) {
    assertRoutedSchemas(wire.tools, wire.who)
    for (const name of ['Agent', 'ListAgents']) {
      const sent = byName(wire.tools, name)
      if (!sent) continue
      const live = byName(wire.live, name)
      const captured = byName(capture.tools, name)
      assert.ok(live && captured, `${wire.who} live session and capture include ${name}`)
      assert.equal(sent.description, live.description, `${wire.who} ${name} description follows the live session`)
      assert.deepEqual(sent.schema, captured.input_schema, `${wire.who} ${name} schema comes from the capture`)
    }
  }
  for (const name of ['Agent', 'ListAgents']) assert.ok(byName(main.tools, name), `the routed main offers ${name}`)
  const nativeCustom = agentRequest('owned-proof-restricted-agent', false)
  assert.equal(custom.target, 'codex/owned-child', 'the exact routed model in custom frontmatter owns the child step')
  assert.equal(custom.system, lastBlock(nativeCustom), 'the routed custom agent gets its captured native prompt, byte for byte')
  assert.deepEqual(JSON.parse(readFileSync(spawnEvidence, 'utf8')), { type: 'owned-proof-restricted-agent', requested: null, definitionModel: 'codex/owned-child', selected: 'codex/owned-child', reason: 'the agent definition names a routed model' }, 'the plugin routes exact model ids from custom frontmatter')
  assert.ok(!custom.system.includes('styx'))
  console.log(JSON.stringify({ publicTools: true, customAgentProof: true, customAgentType: 'owned-proof-restricted-agent', frontmatterModel: 'codex/owned-child', resolvedTarget: custom.target, loadedModAgentTypes: loadedAgents.filter(type => type.startsWith('rice-multi-models:')), nativeToolCaptureVersion: capture.version, capturedTools: capture.tools.length, comparedAgentPrompts: compared.length, routedSessionDescriptions: ['Agent', 'ListAgents'], routedRequests: wires.length, schemaTableVersion: fallback.version, schemaTableVersionMatchesInstalled: fallback.version === installedVersion }))
} finally {
  terminate()
  rmSync(fixture, { recursive: true, force: true })
}
