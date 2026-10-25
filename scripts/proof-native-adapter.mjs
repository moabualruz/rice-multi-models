// Ordinary `claude --plugin-dir` with the production hooks, direct stand-in
// providers and a denied Anthropic endpoint. The mod works only through public
// plugin hooks. No account is used: HOME and CLAUDE_CONFIG_DIR are an owned
// temporary fixture, and every request that reaches the Anthropic stub fails
// the run.
// Usage: node scripts/proof-native-adapter.mjs [phase] [--public-hooks]
// (`--public-hooks` is accepted for existing callers; it is the only mode.)
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const PHASES = ['children', 'family', 'builtins', 'compact', 'skills', 'budget', 'failure', 'evaluators', 'protocols', 'auto', 'step-throw']
const OPT_IN = []
const flags = process.argv.slice(2).filter(arg => arg.startsWith('--'))
const unknownFlags = flags.filter(flag => flag !== '--public-hooks')
if (unknownFlags.length) throw new Error(`unknown option ${unknownFlags.join(' ')}`)
const selected = process.argv.slice(2).find(arg => !arg.startsWith('--'))
if (selected !== undefined && ![...PHASES, ...OPT_IN].includes(selected)) throw new Error(`unknown phase ${selected}; phases: ${[...PHASES, ...OPT_IN].join(', ')}`)
const wants = name => selected === undefined ? PHASES.includes(name) : selected === name

const root = fileURLToPath(new URL('../', import.meta.url))
const fixture = mkdtempSync(join(tmpdir(), 'rice-native space-'))
const plugin = join(fixture, 'plugin space'), configDir = join(fixture, '.claude')
const observations = [], denied = []
let phase = 'setup', mainCalls = 0
let cancelClosed = false, releaseCancelClose
const protocols = ['openai', 'responses', 'anthropic', 'gemini', 'bedrock']
const CHILDREN_PROMPT = 'Use both owned child agents, then report completion.'
const FAMILY_PROMPT = 'Use two owned subagents, then report completion.'
const search = createServer((request, response) => {
  const query = new URL(request.url, 'http://fixture').searchParams.get('q')
  observations.push({ phase, kind: 'retrieval', query })
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({ results: [{ title: 'Owned primary source', url: 'https://code.claude.com/docs/en/plugins/mods', content: 'Owned search fixture source.' }, { title: 'Excluded', url: 'https://unrelated.example/page', content: 'Excluded by domain policy.' }] }))
})
const provider = createServer(async (request, response) => {
  let text = ''; for await (const bytes of request) text += bytes
  const body = text ? JSON.parse(text) : {}
  const family = request.url.split('/')[1]
  if (!['a', 'b', 'budget', ...protocols].includes(family)) {
    if (request.method === 'POST') denied.push({ phase, path: request.url, model: body.model })
    response.writeHead(429, { 'content-type': 'application/json', 'x-should-retry': 'false' })
    response.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Owned fixture: Claude subscription exhausted' } })); return
  }
  if (request.method === 'GET' && request.url.split('?')[0].endsWith('/models')) {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(family === 'gemini' ? { models: ['main', 'child'].map(id => ({ name: 'models/' + id, inputTokenLimit: 495904, outputTokenLimit: 4096 })) } : { data: ['main', 'child'].map(id => ({ id, ...(family === 'anthropic' ? { max_input_tokens: 495904, max_tokens: 4096 } : {}) })) }))
    return
  }
  // The provider, not the mod, owns its input limit: the budget family rejects every request as too long.
  if (family === 'budget' && request.method === 'POST') {
    observations.push({ phase, kind: 'provider', family, model: body.model })
    response.writeHead(400, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'Owned fixture: input exceeds the model context window', type: 'invalid_request_error', code: 'context_length_exceeded' } })); return
  }
  // The engine's own summary prompt, which the routed compaction sends, asks for the two blocks its answer is read by.
  const compaction = text.includes('<analysis>') && text.includes('<summary>')
  if (protocols.includes(family) && family !== 'openai') {
    observations.push({ phase, kind: 'provider', family, model: body.model ?? 'main', path: request.url.split('?')[0], compaction, nativeCredentials: !!(request.headers.authorization && request.headers.authorization !== 'Bearer owned-bedrock-fixture' || request.headers['x-api-key'] || request.headers['x-goog-api-key']) })
    if (family === 'bedrock') { response.setHeader('content-type', 'application/vnd.amazon.eventstream'); response.end(readFileSync(join(root, 'helper/styx/codecs/fixtures/bedrock/text.eventstream'))); return }
    response.setHeader('content-type', 'text/event-stream')
    if (family === 'responses') { response.end(readFileSync(join(root, 'helper/styx/codecs/fixtures/responses/recorded-text.sse'))); return }
    if (family === 'anthropic') { response.end(readFileSync(join(root, 'helper/styx/codecs/fixtures/anthropic/thinking.sse'))); return }
    response.end(`data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Owned Gemini summary' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, totalTokenCount: 30 } })}\n\n`); return
  }
  const serialized = JSON.stringify(body.messages ?? [])
  const userText = (body.messages ?? []).filter(message => message.role === 'user').map(message => typeof message.content === 'string' ? message.content : (message.content ?? []).map(block => block.text ?? '').join('\n')).join('\n')
  const auxiliary = serialized.match(/OWNED_AUX_([a-z0-9]+)/)?.[1]
  const fork = serialized.match(/OWNED_FORK_([a-z0-9]+)/)?.[1]
  // A child loop's own request carries its task prompt and never the main
  // conversation's prompt (the main request echoes the task in its tool calls).
  const familyChild = !serialized.includes(FAMILY_PROMPT) ? userText.match(/OWNED_FAMILY_([A-Z]+)/)?.[1] : undefined
  const child = !serialized.includes(CHILDREN_PROMPT) ? userText.match(/OWNED_CHILD_([AB])/)?.[1] : undefined
  const entry = { phase, kind: 'provider', family, model: body.model, unreadableTask: serialized.includes('is not readable by plugins'), ...(auxiliary ? { auxiliary } : {}), ...(fork ? { fork } : {}), ...(child && phase === 'children' ? { child } : {}), ...(familyChild && phase === 'family' ? { familyChild } : {}), classify: userText.includes('Owned classification fixture'), compaction,
    evaluator: serialized.includes('OWNED_EVALUATOR'), started: performance.now() }
  observations.push(entry)
  let content = 'Owned provider answer', calls
  if (auxiliary) { await new Promise(resolve => setTimeout(resolve, 100)); content = 'OWNED_AUX_OK' }
  else if (fork) content = 'OWNED_FORK_OK'
  else if (phase.startsWith('children') && body.model === 'main' && mainCalls++ === 0) calls = [
    { id: 'call_child_a', type: 'function', function: { name: 'Agent', arguments: JSON.stringify({ description: 'Owned child A', prompt: 'Return OWNED_CHILD_A without tools.', subagent_type: 'owned-a', name: 'owned-a-peer' }) } },
    { id: 'call_child_b', type: 'function', function: { name: 'Agent', arguments: JSON.stringify({ description: 'Owned child B', prompt: 'Return OWNED_CHILD_B without tools.', subagent_type: 'owned-b', name: 'owned-b-peer' }) } },
  ]
  else if (phase === 'family' && body.model === 'main' && !familyChild && mainCalls++ === 0) calls = [
    { id: 'call_family_explore', type: 'function', function: { name: 'Agent', arguments: JSON.stringify({ description: 'Owned family explore', prompt: 'Return OWNED_FAMILY_EXPLORE without tools.', subagent_type: 'Explore', model: 'haiku', run_in_background: false }) } },
    { id: 'call_family_general', type: 'function', function: { name: 'Agent', arguments: JSON.stringify({ description: 'Owned family general', prompt: 'Return OWNED_FAMILY_GENERAL without tools.', subagent_type: 'general-purpose', run_in_background: false }) } },
  ]
  else if (phase === 'builtins' && body.tools?.some(tool => tool.function?.name === 'web_search')) {
    const hasResult = body.messages?.some(message => message.role === 'tool')
    if (!hasResult) calls = [{ id: 'call_search', type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: 'Claude Code native mod docs' }) } }]
    else content = 'Owned cited source: https://code.claude.com/docs/en/plugins/mods'
  }
  else if (userText.includes('Owned classification fixture')) content = 'owned'
  entry.ended = performance.now()
  if (phase === 'request-failure') { response.writeHead(429, { 'content-type': 'application/json', 'x-should-retry': 'false' }); response.end('{"error":{"message":"Owned quota rejection"}}'); return }
  response.setHeader('content-type', 'text/event-stream')
  const send = value => response.write(`data: ${JSON.stringify(value)}\n\n`)
  if (phase === 'cancellation') { response.once('close', () => { cancelClosed = true; releaseCancelClose?.() }); send({ choices: [{ index: 0, delta: { content: 'OWNED_PARTIAL_BEFORE_CANCEL' } }] }); return }
  if (phase === 'partial-failure') { send({ choices: [{ index: 0, delta: { content: 'Owned partial output' } }] }); response.end(); return }
  send({ choices: [{ index: 0, delta: calls ? { tool_calls: calls.map((call, index) => ({ index, ...call })) } : { content } }] })
  send({ choices: [{ index: 0, delta: {}, finish_reason: calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: phase.startsWith('auto') ? 10000 : 20, completion_tokens: 10 } })
  response.end('data: [DONE]\n\n')
})
// The production hooks change while this proof stays fixed: a missing anchor
// must fail loudly instead of silently dropping a fixture prelude.
function inject(source, anchor, replacement, all = false) {
  if (!source.includes(anchor)) throw new Error(`hooks/register.ts no longer contains the fixture anchor ${JSON.stringify(anchor.trim().slice(0, 80))}`)
  return all ? source.replaceAll(anchor, replacement) : source.replace(anchor, replacement)
}
function sessionRows(session) {
  const files = readdirSync(join(configDir, 'projects'), { recursive: true }).filter(file => typeof file === 'string' && file.endsWith(session + '.jsonl'))
  return files.flatMap(file => readFileSync(join(configDir, 'projects', file), 'utf8').trim().split('\n').map(line => JSON.parse(line)))
}
const compactBoundaries = session => sessionRows(session).filter(event => event.type === 'system' && event.subtype === 'compact_boundary')
const strip = ({ started, ended, ...event }) => event
await Promise.all([new Promise(resolve => provider.listen(0, '127.0.0.1', resolve)), new Promise(resolve => search.listen(0, '127.0.0.1', resolve))])
try {
  mkdirSync(plugin); mkdirSync(configDir); mkdirSync(join(configDir, 'plugins')); mkdirSync(join(configDir, 'agents'))
  for (const directory of ['.claude-plugin', 'hooks', 'types', 'dist', 'scripts']) cpSync(join(root, directory), join(plugin, directory), { recursive: true })
  writeFileSync(join(configDir, 'plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'rice-multi-models@rice-mods': [{ scope: 'user', installPath: plugin }] } }))
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'rice-multi-models@rice-mods': true } }))
  writeFileSync(join(fixture, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }))
  const base = `http://127.0.0.1:${provider.address().port}`
  writeFileSync(join(configDir, 'rice-multi-models.json'), JSON.stringify({ providers: Object.fromEntries(['a', 'b', 'budget', ...protocols].map(id => [id, { kind: protocols.includes(id) ? id : 'openai', baseUrl: `${base}/${id}${['a', 'b', 'budget', 'openai'].includes(id) ? '/v1' : ''}`, allowHttp: true, auth: id === 'bedrock' ? { command: [process.execPath, '-e', 'process.stdout.write("owned-bedrock-fixture")'] } : 'none', models: { main: { contextWindow: 500000, maxOutputTokens: id === 'budget' ? 128 : 4096, ...(id === 'budget' ? { maxInputTokens: 512 } : {}), ...(['a', 'b', 'budget', 'openai'].includes(id) ? { maxTokensParam: 'max_completion_tokens' } : {}) }, child: { contextWindow: 500000, maxOutputTokens: id === 'budget' ? 128 : 4096, ...(id === 'budget' ? { maxInputTokens: 512 } : {}), ...(['a', 'b', 'budget', 'openai'].includes(id) ? { maxTokensParam: 'max_completion_tokens' } : {}) } } }])) }))
  for (const id of ['a', 'b']) writeFileSync(join(configDir, 'agents', `owned-${id}.md`), `---\nname: owned-${id}\ndescription: Owned direct provider ${id} child.\nmodel: ${id}/child\n---\nReturn the owned child marker.\n`)
  for (const [name, header] of [['owned-temp', 'model: haiku'], ['owned-fork', 'context: fork\nmodel: b/child']]) {
    mkdirSync(join(configDir, 'skills', name), { recursive: true })
    writeFileSync(join(configDir, 'skills', name, 'SKILL.md'), '---\nname: ' + name + '\ndescription: Owned native routing fixture.\n' + header + '\n---\nReturn the owned skill result.\n')
  }
  const file = join(plugin, 'hooks/register.ts')
  let source = readFileSync(file, 'utf8')
  source = inject(source, 'export const register: Register = on => {', 'let proofBuiltinsDone = false\nexport const register: Register = on => {')
  source = inject(source, '    await loadProviders($)', `    await loadProviders($)\n    if (!loaded.config) throw new Error('owned fixture configuration must pass the production parser')\n    for (const provider of Object.values(loaded.config.providers)) await $.store.set(TRUST_PREFIX + fingerprint(provider), true)`, true)
  source = inject(source, '    const started = await next(e)', `    await $.state.set({ plugin: 'rice-multi-models', key: 'prefs' }, { effort: null, transport: 'sse', helper: 'once' })\n    const started = await next(e)`)
  // The children prelude records each auxiliary outcome and never throws: the
  // host skips a turn.step hook that throws and sends the step, unrouted, to
  // native Claude. $.model.fork takes { prompt }.
  source = inject(source, "  on('turn.step', async function* ($, e, next) {", `  on('turn.step', async function* ($, e, next) {
    const ownedPhase = await $.env.get('RICE_OWNED_PHASE')
    if (e.agentId && e.index === 0 && ownedPhase === 'children') {
      const settle = async work => { try { return await work() } catch (error) { return { threw: String(error?.message ?? error).slice(0, 300) } } }
      const report = { agentId: e.agentId, model: e.model }
      report.complete = await settle(async () => { const answer = await $.model.complete({ model: e.model, prompt: 'OWNED_AUX_' + e.agentId }); return { isAnswered: answer.isAnswered, text: answer.text ?? null } })
      report.classify = await settle(async () => ({ label: await $.model.classify('Owned classification fixture', ['owned', 'other'], { model: e.model }) ?? null }))
      report.fork = await settle(async () => { const answer = await $.model.fork({ prompt: 'OWNED_FORK_' + e.agentId }); return { isAnswered: answer.isAnswered, text: answer.text ?? null } })
      await settle(() => $.fs.write('owned-prelude/' + e.agentId + '.json', JSON.stringify(report)))
    }
    if (e.agentId === undefined && ownedPhase?.startsWith('step-throw')) {
      if (ownedPhase === 'step-throw-mid') yield { kind: 'text', index: 0, text: 'OWNED_PARTIAL_BEFORE_FAILURE ' }
      throw new Error('OWNED_STEP_FAILURE')
    }
    if (e.agentId === undefined && !proofBuiltinsDone && ownedPhase === 'builtins') {
      proofBuiltinsDone = true
      const calls = []
      for (const input of [{ tool: 'Skill', skill: 'plugin-authoring' }, { tool: 'ToolSearch', query: 'Find the web search tool', max_results: 1 }, { tool: 'WebFetch', url: 'https://example.com', prompt: 'Give the page title only.' }, { tool: 'WebSearch', query: 'Claude Code native mod docs', allowed_domains: ['code.claude.com'] }]) {
        try {
          const answer = await $.tool.call(input)
          calls.push({ tool: input.tool, isError: answer.isError, deny: answer.deny, result: answer.result })
        } catch { calls.push({ tool: input.tool, isError: true }) }
      }
      const answer = JSON.stringify({ calls })
      yield { kind: 'text', index: 0, text: answer }; yield { kind: 'stop', stopReason: 'end_turn', usage: null }
      return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn', usage: null }
    }
  `)
  const cancelReceipt = join(fixture, 'cancel-turn.json')
  const moduleEnd = source.lastIndexOf('\n}')
  source = source.slice(0, moduleEnd) + `\n  on('turn.complete',async($,e,next)=>{const result=await next(e);if(await $.env.get('RICE_OWNED_PHASE')==='cancellation')await $.fs.write(${JSON.stringify(cancelReceipt)},JSON.stringify({reason:e.reason,isAborted:e.isAborted}));return result;});\n` + source.slice(moduleEnd)
  writeFileSync(file, source)
  // ProgramFiles and CLAUDE_CODE_GIT_BASH_PATH let native Windows find Git Bash, whose absence removes the Bash tool.
  const env = Object.fromEntries(['PATH', 'PATHEXT', 'TMPDIR', 'LANG', 'LC_ALL', 'SystemRoot', 'SystemDrive', 'WINDIR', 'ComSpec', 'ProgramFiles', 'ProgramFiles(x86)', 'CLAUDE_CODE_GIT_BASH_PATH', 'TEMP', 'TMP', 'RICE_CLAUDE_EXECUTABLE'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  Object.assign(env, { ...(process.platform === 'win32' ? { OS: 'Windows_NT' } : {}), HOME: fixture, USERPROFILE: fixture, CLAUDE_CONFIG_DIR: configDir, CODEX_HOME: join(fixture, '.codex'), ANTHROPIC_API_KEY: 'owned-no-account', ANTHROPIC_BASE_URL: base,
    RICE_MULTI_MODELS_SEARCH_URL: `http://127.0.0.1:${search.address().port}/search`, ENABLE_TOOL_SEARCH: 'true', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' })
  // A failed plugin response uses the public null stop reason, not fabricated answer text.
  // The host still owns CLI error bookkeeping; the failure proof records that boundary.
  async function run(name, extra, prompt, { permission = 'dontAsk', model = 'a/main', expectSuccess = true } = {}) {
    phase = name; mainCalls = 0
    const started = Date.now()
    // Native Windows limits a command line to 32767 characters; claude -p reads a long prompt from stdin.
    const viaStdin = prompt.length > 8000
    const child = spawn(process.env.RICE_CLAUDE_EXECUTABLE || 'claude', ['--plugin-dir', plugin, '-p', ...(model ? ['--model', model] : []), '--setting-sources', 'user', '--strict-mcp-config', '--permission-mode', permission, '--allowedTools', 'Skill,ToolSearch,WebFetch,WebSearch,Agent,SendMessage', '--output-format', 'json', ...extra, ...(viaStdin ? [] : ['--', prompt])], { cwd: fixture, env: { ...env, RICE_OWNED_PHASE: name }, stdio: [viaStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    if (viaStdin) child.stdin.end(prompt)
    process.stdout.write(`${JSON.stringify({ phase: name, ownedPid: child.pid })}\n`)
    let stdout = '', stderr = ''; child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes)
    const timer = setTimeout(() => child.kill('SIGTERM'), 60000)
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }); clearTimeout(timer)
    let result; try { result = JSON.parse(stdout) } catch {}
    if (!expectSuccess) return { code, result }
    if (code !== 0 || result?.is_error !== false) process.stdout.write(`${JSON.stringify({ phase: name, code, elapsedMs: Date.now() - started, observations: observations.filter(event => event.phase === name).map(strip), denied: denied.filter(event => event.phase === name), setupErrors: stderr.match(/(?:Error|rice-multi-models)[^\n]{0,180}/g)?.slice(-3) ?? [], outputTail: stdout.slice(-300) })}\n`)
    assert.equal(code, 0, `${name} exit; output type ${result?.type ?? 'missing'}, stderr present ${!!stderr}`)
    assert.ok(result, `${name} emitted its JSON result`)
    assert.equal(result.is_error, false, `${name} result`)
    return result
  }
  // A subagent's task prompt is in its $.session.messages view only when the
  // session is saved, so the subagent phases keep normal session persistence.
  if (wants('children')) {
    await run('children', [], CHILDREN_PROMPT)
    const preludeDir = join(fixture, 'owned-prelude')
    const reports = existsSync(preludeDir) ? readdirSync(preludeDir).map(name => JSON.parse(readFileSync(join(preludeDir, name), 'utf8'))) : []
    assert.deepEqual(reports.map(report => report.model).sort(), ['a/child', 'b/child'], 'both child loops step on their explicit provider/model')
    for (const report of reports) {
      assert.deepEqual(report.complete, { isAnswered: true, text: 'OWNED_AUX_OK' }, `child ${report.model} $.model.complete`)
      assert.deepEqual(report.classify, { label: 'owned' }, `child ${report.model} $.model.classify`)
      assert.deepEqual(report.fork, { isAnswered: true, text: 'OWNED_FORK_OK' }, `child ${report.model} $.model.fork`)
    }
    const turns = observations.filter(event => event.phase === 'children' && event.child)
    assert.deepEqual(turns.map(event => `${event.child}:${event.family}/${event.model}`).sort(), ['A:a/child', 'B:b/child'], 'each child receives its task on its explicit provider/model')
    // Explicit auxiliary models belong to the caller's request, not a guessed main owner.
    // A public fork alone is documented to use the main thread's last sent prefix.
    const agentIds = reports.map(report => report.agentId).sort()
    const requests = observations.filter(event => event.phase === 'children' && event.auxiliary)
    assert.deepEqual(requests.map(event => event.auxiliary).sort(), agentIds, 'one completion per child loop')
    assert.deepEqual(requests.map(event => event.family+'/'+event.model).sort(), ['a/child','b/child'], 'auxiliary completions honor each explicit child model')
    assert.ok(Math.max(...requests.map(event => event.started)) < Math.min(...requests.map(event => event.ended)), 'concurrent auxiliary completions overlap')
    const labels = observations.filter(event => event.phase === 'children' && event.classify)
    assert.equal(labels.length, 2, 'one classification per child loop')
    assert.deepEqual(labels.map(event => event.family+'/'+event.model).sort(), ['a/child','b/child'], 'classifications honor each explicit child model')
    const forks = observations.filter(event => event.phase === 'children' && event.fork)
    assert.deepEqual(forks.map(event => event.fork).sort(), agentIds, 'one fork per child loop')
    assert.ok(forks.every(event => event.family === 'a' && event.model === 'main'), 'forks of the main thread use the main conversation family')
    assert.equal(denied.filter(event => event.phase === 'children').length, 0, 'no child step reached native Claude')
    // Without session persistence the host's view of a child transcript lacks
    // its task. The child is refused visibly; nothing reaches any provider.
    await run('children-unsaved', ['--no-session-persistence'], CHILDREN_PROMPT)
    assert.equal(observations.filter(event => event.phase === 'children-unsaved' && event.model === 'child').length, 0, 'a child without a readable task sends nothing')
    assert.ok(observations.some(event => event.phase === 'children-unsaved' && event.model === 'main'), 'the native parent loop remains operational without inventing child answers')
    assert.equal(denied.filter(event => event.phase === 'children-unsaved').length, 0, 'a child without a readable task never reaches native Claude')
  }
  if (wants('family')) {
    await run('family', [], FAMILY_PROMPT)
    const requests = observations.filter(event => event.phase === 'family' && event.kind === 'provider')
    assert.deepEqual(requests.filter(event => event.familyChild).map(event => event.familyChild).sort(), ['EXPLORE', 'GENERAL'], 'the Explore child with a native haiku alias and the default child each received their task')
    assert.ok(requests.length >= 4, 'the main turn, both children and the final main turn reached a provider')
    assert.ok(requests.every(event => event.family === 'a' && event.model === 'main'), 'native alias and default subagents stay in the parent family')
    assert.equal(denied.filter(event => event.phase === 'family').length, 0, 'no subagent request reached native Claude')
  }
  if (wants('builtins')) {
    const result = await run('builtins', ['--no-session-persistence'], 'Check native built-in direct routing.')
    const answer = JSON.parse(result.result)
    const fetchCall = answer.calls.find(call => call.tool === 'WebFetch')
    assert.ok(fetchCall?.isError || fetchCall?.deny, 'unavailable final native WebFetch is terminal, never hidden direct retrieval')
    assert.ok(answer.calls.filter(call => call.tool !== 'WebFetch').every(call => !call.isError && !call.deny), 'other available built-in calls complete')
    assert.equal(observations.filter(event => event.phase === 'builtins' && event.kind === 'provider').length, 0, 'no selected extraction runs after the unavailable final native fetch')
    assert.ok(!JSON.stringify(answer.calls.find(call => call.tool === 'WebSearch')).includes('unrelated.example'), 'native search domain filtering')
    assert.ok(observations.some(event => event.kind === 'retrieval'), 'native WebSearch retrieves')
    assert.ok(observations.filter(event => event.phase === 'builtins' && event.kind === 'provider').every(event => event.family === 'a' && event.model === 'main'), 'built-in inference uses its owner')
  }
  if (wants('compact')) {
    const session = randomUUID()
    await run('seed', ['--session-id', session], 'Remember the owned native fixture constraint.')
    await run('compact', ['--resume', session], '/compact')
    assert.ok(observations.some(event => event.phase === 'compact' && event.family === 'a' && event.model === 'main' && event.compaction), 'manual compaction sends the routed compaction request to the conversation provider')
    assert.ok(compactBoundaries(session).some(event => event.compactMetadata?.trigger === 'manual'), 'manual compaction completes native transcript bookkeeping')
  }
  if (wants('skills')) {
    await run('skill-temp', ['--no-session-persistence'], '/owned-temp')
    // A forked skill's transcript is readable only from its saved sidechain, so
    // the supported case keeps normal session persistence.
    await run('skill-fork', [], '/owned-fork')
    assert.ok(observations.some(event => event.phase === 'skill-temp' && event.family === 'a' && event.model === 'main'), 'temporary skill alias retains the selected primary provider')
    assert.ok(observations.some(event => event.phase === 'skill-fork' && event.family === 'b' && event.model === 'child'), 'forked skill uses its explicitly selected provider')
    const unsaved = await run('skill-fork-unsaved', ['--no-session-persistence'], '/owned-fork')
    assert.equal(unsaved.stop_reason, null, 'an unreadable fork produces an unsuccessful stop instead of fabricated assistant text')
    assert.equal(observations.filter(event => event.phase === 'skill-fork-unsaved' && event.kind === 'provider').length, 0, 'an unreadable fork sends nothing')
    assert.equal(denied.filter(event => event.phase === 'skill-fork-unsaved').length, 0, 'an unreadable fork never falls back to Claude')
  }
  if (wants('budget')) {
    const { code, result } = await run('budget', ['--no-session-persistence', '--tools', ''], 'Owned oversized context. '.repeat(250), { model: 'budget/main', expectSuccess: false })
    assert.equal(code, 1, 'a provider context overflow is an unsuccessful native CLI result')
    assert.equal(result?.is_error, true, 'the provider refusal is not a successful assistant answer')
    assert.ok(result.result === undefined || result.result === '', 'the diagnostic is not fabricated assistant content')
    assert.equal(observations.filter(event => event.phase === 'budget' && event.kind === 'provider').length, 1, 'the request reaches the provider once: no plugin pre-abort and no replay')
  }
  if (wants('failure')) {
    const rejected = await run('request-failure', ['--no-session-persistence'], 'Return the owned quota rejection.', { expectSuccess: false })
    assert.equal(rejected.code, 1, 'a rejected provider request is not a successful CLI answer')
    assert.equal(rejected.result?.is_error, true)
    assert.equal(observations.filter(event => event.phase === 'request-failure' && event.kind === 'provider').length, 1, 'a rejected request is not replayed')
    const result = await run('partial-failure', ['--no-session-persistence'], 'Return the owned partial output.')
    assert.equal(observations.filter(event => event.phase === 'partial-failure' && event.kind === 'provider').length, 1, 'a committed partial response is not replayed')
    assert.equal(result.result, 'Owned partial output', 'only real partial output is retained, never fabricated success or failure text')
    assert.equal(result.stop_reason, null, 'the provider failure retains the supported unsuccessful stop shape')
    console.log(JSON.stringify({ nativeFailureBoundary: { stopReason: result.stop_reason, cliIsError: result.is_error, providerReplayed: false, fabricatedAnswer: false } }))
    phase = 'cancellation'; cancelClosed = false
    const providerClosed = new Promise(resolve => { releaseCancelClose = resolve })
    const cancelled = spawn(process.env.RICE_CLAUDE_EXECUTABLE || 'claude', ['--plugin-dir', plugin, '-p', '--model', 'a/main', '--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-mode', 'dontAsk', '--tools', '', '--no-session-persistence', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--verbose'], { cwd: fixture, env: { ...env, RICE_OWNED_PHASE: phase }, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
    console.log(JSON.stringify({ phase, ownedPid: cancelled.pid }))
    let output = '', errorOutput = '', pending = ''
    const events = [], waiters = []
    const waitFor = match => events.some(match) ? Promise.resolve(events.find(match)) : new Promise(resolve => waiters.push({ match, resolve }))
    cancelled.stdout.on('data', bytes => {
      output += bytes; pending += bytes
      for (let at = pending.indexOf('\n'); at !== -1; at = pending.indexOf('\n')) {
        const line = pending.slice(0, at); pending = pending.slice(at + 1)
        let event; try { event = JSON.parse(line) } catch { continue }
        events.push(event)
        for (const waiter of [...waiters]) if (waiter.match(event)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(event) }
      }
    })
    cancelled.stderr.on('data', bytes => { errorOutput = (errorOutput + bytes).slice(-4000) })
    const closed = new Promise((resolve, reject) => { cancelled.once('error', reject); cancelled.once('close', code => resolve(code)) })
    let deadlineTimer
    const deadline = new Promise((_, reject) => { deadlineTimer = setTimeout(() => reject(new Error('Owned cancellation deadline')), 60_000) })
    const until = work => Promise.race([work, deadline, closed.then(code => { throw new Error(`Owned cancellation ended early (${code}): ${errorOutput.slice(-600)}`) })])
    const send = value => cancelled.stdin.write(JSON.stringify(value) + '\n')
    try {
      send({ type: 'control_request', request_id: 'owned-cancel-init', request: { subtype: 'initialize' } })
      await until(waitFor(event => event.type === 'control_response' && event.response?.request_id === 'owned-cancel-init' && event.response?.subtype === 'success'))
      send({ type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: 'Owned cancellation fixture.' } })
      await until(waitFor(event => JSON.stringify(event).includes('OWNED_PARTIAL_BEFORE_CANCEL')))
      send({ type: 'control_request', request_id: 'owned-cancel-interrupt', request: { subtype: 'interrupt' } })
      await until(waitFor(event => event.type === 'control_response' && event.response?.request_id === 'owned-cancel-interrupt' && event.response?.subtype === 'success'))
      cancelled.stdin.end()
      await Promise.race([closed, deadline])
      await Promise.race([providerClosed, deadline])
      assert.equal(cancelClosed, true, 'native interruption closes the owned provider request')
      assert.ok(existsSync(cancelReceipt), 'the native aborted turn completes its lifecycle')
      assert.deepEqual(JSON.parse(readFileSync(cancelReceipt, 'utf8')), { reason: 'aborted', isAborted: true })
      assert.equal(observations.filter(event => event.phase === 'cancellation' && event.kind === 'provider').length, 1, 'visible output and interruption never replay inference')
      assert.equal(denied.filter(event => event.phase === 'cancellation').length, 0)
      console.log(JSON.stringify({ nativeCancellation: true, providerClosed: cancelClosed, nativeAbortedLifecycle: true }))
    } finally {
      clearTimeout(deadlineTimer)
      if (cancelled.exitCode === null && cancelled.signalCode === null) {
        if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(cancelled.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10_000 })
        else try { process.kill(-cancelled.pid, 'SIGTERM') } catch {}
        await closed.catch(() => {})
      }
    }
  }
  if (wants('evaluators')) {
    // Prompt-type Stop evaluators are routed. Agent-type evaluators run natively
    // by design; scripts/proof-public-evaluators.mjs covers them.
    await run('evaluator-prompt', ['--no-session-persistence', '--settings', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'OWNED_EVALUATOR: allow this owned fixture by returning exactly {"ok":true}. $ARGUMENTS', timeout: 30 }] }] } })], 'Return the owned completion.')
    assert.ok(observations.some(event => event.phase === 'evaluator-prompt' && event.evaluator), 'prompt evaluator reaches a direct provider')
    assert.ok(observations.filter(event => event.phase === 'evaluator-prompt').every(event => event.family === 'a' && event.model === 'main'), 'prompt evaluator retains its owner')
  }
  if (wants('protocols')) {
    for (const kind of protocols) {
      const session = randomUUID(), model = `${kind}/main`
      await run(`seed-${kind}`, ['--session-id', session], 'Remember the owned provider protocol fixture.', { model })
      await run(`compact-${kind}`, ['--resume', session], '/compact', { model })
      assert.ok(observations.some(event => event.phase === `compact-${kind}` && event.family === kind && event.compaction), `${kind} receives the routed compaction request`)
      assert.ok(observations.filter(event => event.family === kind).every(event => !event.nativeCredentials), `${kind} does not receive native Claude credentials`)
    }
  }
  if (wants('auto')) {
    // A resumed conversation keeps its provider only when it is selected again:
    // ordinary claude starts a resume on the configured model.
    env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = '1'
    const session = randomUUID()
    await run('auto-seed', ['--session-id', session, '--tools', ''], 'Remember this owned native fixture context. ' + 'OWNED_AUTO_CONTEXT '.repeat(2500))
    await run('auto-second', ['--resume', session, '--tools', ''], 'Keep the owned native fixture constraints for later.')
    await run('auto-third', ['--resume', session, '--tools', ''], 'Confirm the owned native fixture constraints remain in context.')
    await run('auto-continue', ['--resume', session, '--tools', ''], 'Continue the owned native fixture.')
    const boundaries = compactBoundaries(session)
    if (!boundaries.some(event => event.compactMetadata?.trigger === 'auto')) process.stdout.write(JSON.stringify({ autoDiagnostics: { boundaries: boundaries.map(event => ({ keys: Object.keys(event), compactMetadata: event.compactMetadata })), observations: observations.filter(event => event.phase.startsWith('auto')).map(strip) } }) + '\n')
    assert.ok(boundaries.some(event => event.compactMetadata?.trigger === 'auto'), 'automatic compaction completes native transcript bookkeeping')
    assert.ok(observations.some(event => event.phase === 'auto-third' && event.family === 'a' && event.model === 'main' && event.compaction), 'startup compaction of a resumed conversation reaches its direct provider')
    assert.ok(observations.filter(event => event.phase.startsWith('auto') && event.kind === 'provider').every(event => event.family === 'a' && event.model === 'main'), 'every automatic compaction and turn stays in the conversation family')
    delete env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
  }
  if (wants('step-throw')) {
    // A turn.step hook that throws is skipped by the host, which then sends the
    // step unrouted to native Claude. The production hook must refuse instead.
    for (const name of ['step-throw', 'step-throw-mid']) {
      const { code, result } = await run(name, ['--no-session-persistence', '--tools', ''], 'Return the owned completion.', { expectSuccess: false })
      process.stdout.write(`${JSON.stringify({ phase: name, code, isError: result?.is_error, result: result?.result?.slice(0, 300), denied: denied.filter(event => event.phase === name) })}\n`)
      assert.equal(denied.filter(event => event.phase === name).length, 0, `${name}: a failing routed step never falls back to native Claude`)
      assert.equal(observations.filter(event => event.phase === name && event.kind === 'provider').length, 0, `${name}: a failing routed step is not replayed`)
    }
  }
  assert.equal(denied.length, 0, 'no inference request reaches native Claude')
  process.stdout.write(`${JSON.stringify({ integration: 'ordinary-claude-public-hooks', phase: selected ?? 'all', result: 'pass', observations: observations.map(strip), deniedInference: denied.length })}\n`)
} catch (error) {
  process.stdout.write(JSON.stringify({ failedPhase: phase, observations: observations.map(strip), denied }) + '\n')
  throw error
} finally {
  await Promise.all([new Promise(resolve => provider.close(resolve)), new Promise(resolve => search.close(resolve))])
  rmSync(fixture, { recursive: true, force: true })
}
