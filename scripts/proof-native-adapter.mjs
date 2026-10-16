// Real native entry points, direct stand-in providers, and a denied Anthropic endpoint.
// No account is used. Production hooks and the bundled in-process adapter remain in place.
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const root = fileURLToPath(new URL('../', import.meta.url))
const fixture = mkdtempSync(join(tmpdir(), 'rice-native space-'))
const plugin = join(fixture, 'plugin space'), configDir = join(fixture, '.claude')
const observations = [], denied = []
let phase = 'setup', mainCalls = 0
const protocols = ['openai', 'responses', 'anthropic', 'gemini', 'bedrock']
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
  if (protocols.includes(family) && family !== 'openai') {
    observations.push({ phase, kind: 'provider', family, model: body.model ?? 'main', path: request.url.split('?')[0], nativeCredentials: !!(request.headers.authorization && request.headers.authorization !== 'Bearer owned-bedrock-fixture' || request.headers['x-api-key'] || request.headers['x-goog-api-key']) })
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
  const entry = { phase, kind: 'provider', family, model: body.model, ...(auxiliary ? { auxiliary } : {}), ...(fork ? { fork } : {}), classify: userText.includes('labels'),
    evaluator: serialized.includes('OWNED_EVALUATOR'), formatKeys: Object.keys(body.response_format?.json_schema?.schema?.properties ?? {}), commandRan: (body.messages ?? []).some(message => message.role === 'tool' && JSON.stringify(message.content).includes('OWNED_CLASSIFIER_OK')), started: performance.now() }
  observations.push(entry)
  let content = 'Owned provider answer', calls
  if (auxiliary) { await new Promise(resolve => setTimeout(resolve, 100)); content = 'OWNED_AUX_OK' }
  else if (fork) content = 'OWNED_FORK_OK'
  else if (phase === 'children' && body.model === 'main' && mainCalls++ === 0) calls = [
    { id: 'call_child_a', type: 'function', function: { name: 'Agent', arguments: JSON.stringify({ description: 'Owned child A', prompt: 'Return OWNED_CHILD_A without tools.', subagent_type: 'owned-a', name: 'owned-a-peer' }) } },
    { id: 'call_child_b', type: 'function', function: { name: 'Agent', arguments: JSON.stringify({ description: 'Owned child B', prompt: 'Return OWNED_CHILD_B without tools.', subagent_type: 'owned-b', name: 'owned-b-peer' }) } },
  ]
  else if (phase === 'classifier' && body.model === 'main' && mainCalls++ === 0) calls = [{ id: 'call_classifier', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: "/bin/sh -c 'printf OWNED_CLASSIFIER_OK'", description: 'Print the owned classifier marker' }) } }]
  else if (phase === 'classifier' && !body.tools?.length) content = '<severity>1</severity>'
  else if (phase === 'builtins' && body.tools?.some(tool => tool.function?.name === 'web_search')) {
    const hasResult = body.messages?.some(message => message.role === 'tool')
    if (!hasResult) calls = [{ id: 'call_search', type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: 'Claude Code native mod docs' }) } }]
    else content = 'Owned cited source: https://code.claude.com/docs/en/plugins/mods'
  } else if (body.response_format?.json_schema) content = JSON.stringify(schemaValue(body.response_format.json_schema.schema))
  else if (userText.includes('labels')) content = 'owned'
  entry.ended = performance.now()
  response.setHeader('content-type', 'text/event-stream')
  const send = value => response.write(`data: ${JSON.stringify(value)}\n\n`)
  if (phase === 'partial-failure') { send({ choices: [{ index: 0, delta: { content: 'Owned partial output' } }] }); response.end(); return }
  send({ choices: [{ index: 0, delta: calls ? { tool_calls: calls.map((call, index) => ({ index, ...call })) } : { content } }] })
  send({ choices: [{ index: 0, delta: {}, finish_reason: calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: phase.startsWith('auto') ? 10000 : 20, completion_tokens: 10 } })
  response.end('data: [DONE]\n\n')
})
function schemaValue(schema) {
  if (schema.const !== undefined) return schema.const
  if (schema.enum) return schema.enum.find(value => ['allow', 'safe', 'safe_to_run'].includes(value)) ?? schema.enum[0]
  if (schema.anyOf) return schemaValue(schema.anyOf[0])
  if (schema.type === 'object' || schema.properties) return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, value]) => [key, schemaValue(value)]))
  if (schema.type === 'array') return []
  if (schema.type === 'boolean') return true
  if (schema.type === 'integer' || schema.type === 'number') return 0
  if (schema.type === 'null') return null
  return 'Owned classifier rationale'
}
await Promise.all([new Promise(resolve => provider.listen(0, '127.0.0.1', resolve)), new Promise(resolve => search.listen(0, '127.0.0.1', resolve))])
try {
  mkdirSync(plugin); mkdirSync(configDir); mkdirSync(join(configDir, 'plugins')); mkdirSync(join(configDir, 'agents'))
  for (const directory of ['.claude-plugin', 'hooks', 'types', 'dist']) cpSync(join(root, directory), join(plugin, directory), { recursive: true })
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
  source = source.replace('export const register: Register = on => {', 'let proofBuiltinsDone = false\nexport const register: Register = on => {')
  source = source.replaceAll('    await loadProviders($)', `    await loadProviders($)\n    if (!loaded.config) throw new Error('owned fixture configuration must pass the production parser')\n    for (const provider of Object.values(loaded.config.providers)) await $.store.set(TRUST_PREFIX + fingerprint(provider), true)`)
  source = source.replace('    const started = await next(e)', `    await $.state.set({ plugin: 'rice-multi-models', key: 'prefs' }, { effort: null, transport: 'sse', helper: 'once', workers: 'read' })\n    const started = await next(e)`)
  source = source.replace("  on('turn.step', async function* ($, e, next) {", `  on('turn.step', async function* ($, e, next) {
    if (e.agentId && await $.env.get('RICE_OWNED_PHASE') === 'children') {
      const result = await $.model.complete({ model: 'haiku', prompt: 'OWNED_AUX_' + e.agentId })
      if (!result.isAnswered || result.text !== 'OWNED_AUX_OK') throw new Error('owned child auxiliary failed')
      const label = await $.model.classify('Owned classification fixture', ['owned', 'other'])
      if (label !== 'owned') throw new Error('owned child classification failed')
      const fork = await $.model.fork('OWNED_FORK_' + e.agentId)
      if (!fork.isAnswered) throw new Error('owned child fork failed')
    }
    if (e.agentId === undefined && !proofBuiltinsDone && await $.env.get('RICE_OWNED_PHASE') === 'builtins') {
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
  writeFileSync(file, source)
  const env = Object.fromEntries(['PATH', 'TMPDIR', 'LANG', 'SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'RICE_CLAUDE_EXECUTABLE'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  Object.assign(env, { HOME: fixture, USERPROFILE: fixture, CLAUDE_CONFIG_DIR: configDir, CODEX_HOME: join(fixture, '.codex'), ANTHROPIC_API_KEY: 'owned-no-account', ANTHROPIC_BASE_URL: base,
    RICE_MULTI_MODELS_SEARCH_URL: `http://127.0.0.1:${search.address().port}/search`, RICE_MULTI_MODELS_NATIVE_TRACE: join(fixture, 'native.jsonl'), ENABLE_TOOL_SEARCH: 'true', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' })
  async function run(name, extra, prompt, permission = 'dontAsk', model = 'a/main') {
    phase = name; mainCalls = 0
    const child = spawn(process.execPath, [join(plugin, 'dist/launch.mjs'), '-p', ...(model ? ['--model', model] : []), '--setting-sources', 'user', '--strict-mcp-config', '--permission-mode', permission, '--allowedTools', 'Skill,ToolSearch,WebFetch,WebSearch,Agent,SendMessage', '--output-format', 'json', ...extra, '--', prompt], { cwd: fixture, env: { ...env, RICE_OWNED_PHASE: name }, stdio: ['ignore', 'pipe', 'pipe'] })
    process.stdout.write(`${JSON.stringify({ phase: name, ownedPid: child.pid })}\n`)
    let stdout = '', stderr = ''; child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes)
    const timer = setTimeout(() => child.kill('SIGTERM'), 60000)
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }); clearTimeout(timer)
    let result; try { result = JSON.parse(stdout) } catch {}
    if (code !== 0 && !['partial-failure', 'budget'].includes(name)) process.stdout.write(`${JSON.stringify({ phase: name, observations, trace: (() => { try { return readFileSync(join(fixture, 'native.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) } catch { return [] } })(), setupErrors: stderr.match(/(?:Error|rice-multi-models)[^\n]{0,180}/g)?.slice(-3) ?? [], outputTail: stdout.slice(-300) })}\n`)
    assert.equal(code, ['partial-failure', 'budget'].includes(name) ? 1 : 0, `native ${name} exit; output type ${result?.type ?? 'missing'}, stderr present ${!!stderr}`)
    assert.ok(result, `native ${name} emitted its JSON result`)
    assert.equal(result.is_error, ['partial-failure', 'budget'].includes(name), `native ${name} result`)
    return result
  }
  const selected = process.argv[2]
  if (!selected || selected === 'children') {
    await run('children', ['--no-session-persistence'], 'Use both owned child agents, then report completion.')
    const requests = observations.filter(event => event.phase === 'children' && event.auxiliary)
    assert.equal(requests.length, 2, 'two native child completions')
    assert.deepEqual(requests.map(event => event.family).sort(), ['a', 'b'])
    assert.ok(requests.every(event => event.model === 'child'), 'child auxiliary must use its selected model')
    assert.ok(Math.max(...requests.map(event => event.started)) < Math.min(...requests.map(event => event.ended)), 'native child auxiliary requests overlap')
    const forks = observations.filter(event => event.phase === 'children' && event.fork)
    assert.deepEqual(forks.map(event => event.family).sort(), ['a', 'b'], 'child forks keep distinct providers')
  }
  if (!selected || selected === 'builtins') {
    const result = await run('builtins', ['--no-session-persistence'], 'Check native built-in direct routing.')
    const answer = JSON.parse(result.result)
    assert.ok(answer.calls.every(call => !call.isError && !call.deny), 'all available built-in calls complete')
    assert.ok(!JSON.stringify(answer.calls.find(call => call.tool === 'WebSearch')).includes('unrelated.example'), 'native search domain filtering')
    assert.ok(observations.some(event => event.kind === 'retrieval'), 'native WebSearch retrieves')
    assert.ok(observations.filter(event => event.phase === 'builtins' && event.kind === 'provider').every(event => event.family === 'a' && event.model === 'main'), 'built-in inference uses its owner')
  }
  if (!selected || selected === 'compact') {
    const session = randomUUID()
    await run('seed', ['--session-id', session], 'Remember the owned native fixture constraint.')
    await run('compact', ['--resume', session], '/compact')
    const trace = readFileSync(join(fixture, 'native.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.ok(trace.some(event => event.phase === 'dispatch' && event.requestClass === 'compaction' && event.selectedModel === 'a/main'), 'authentic native compaction dispatch')
    assert.ok(observations.some(event => event.phase === 'compact' && event.kind === 'provider'), 'native compactor uses direct provider')
  }
  if (!selected || selected === 'classifier') {
    await run('classifier', ['--no-session-persistence', '--settings', JSON.stringify({ autoMode: { classifyAllShell: true }, skipAutoPermissionPrompt: true })], 'Print the owned classifier marker using Bash.', 'auto')
    const trace = readFileSync(join(fixture, 'native.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.ok(trace.some(event => event.phase === 'dispatch' && event.requestClass === 'auxiliary' && event.selectedModel === 'a/main'), 'native auto classifier uses its owner')
    assert.ok(observations.some(event => event.phase === 'classifier' && event.commandRan), 'native classifier allows the owned readonly command')
  }
  if (!selected || selected === 'skills') {
    await run('skill-temp', ['--no-session-persistence'], '/owned-temp')
    await run('skill-fork', ['--no-session-persistence'], '/owned-fork')
    assert.ok(observations.some(event => event.phase === 'skill-temp' && event.family === 'a' && event.model === 'main'), 'temporary skill alias retains the selected primary provider')
    assert.ok(observations.some(event => event.phase === 'skill-fork' && event.family === 'b' && event.model === 'child'), 'forked skill uses its explicitly selected provider')
  }
  if (!selected || selected === 'budget') {
    const result = await run('budget', ['--no-session-persistence', '--tools', ''], 'Owned oversized context. '.repeat(250), 'dontAsk', 'budget/main')
    assert.match(result.result, /95% safety threshold.*512 token input bound/, 'configured native input bound remains enforced')
    assert.equal(observations.filter(event => event.phase === 'budget' && event.kind === 'provider').length, 0, 'oversized native requests stop before provider dispatch')
  }
  if (!selected || selected === 'failure') {
    await run('partial-failure', ['--no-session-persistence'], 'Return the owned partial output.')
    assert.equal(observations.filter(event => event.phase === 'partial-failure' && event.kind === 'provider').length, 1, 'native host does not replay a provider request after committed partial output')
  }
  if (!selected || selected === 'evaluators') {
    for (const type of ['prompt', 'agent']) {
      await run('evaluator-' + type, ['--no-session-persistence', '--settings', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type, prompt: 'OWNED_EVALUATOR: allow this owned fixture by returning exactly {"ok":true}. $ARGUMENTS', timeout: 30 }] }] } })], 'Return the owned completion.')
      assert.ok(observations.some(event => event.phase === 'evaluator-' + type && event.evaluator), type + ' evaluator reaches a direct provider')
      assert.ok(observations.filter(event => event.phase === 'evaluator-' + type).every(event => event.family === 'a' && event.model === 'main'), type + ' evaluator retains its owner')
    }
  }
  if (!selected || selected === 'protocols') {
    for (const kind of protocols) {
      const session = randomUUID(), model = `${kind}/main`
      await run(`seed-${kind}`, ['--session-id', session], 'Remember the owned provider protocol fixture.', 'dontAsk', model)
      await run(`compact-${kind}`, ['--resume', session], '/compact', 'dontAsk', model)
      const trace = readFileSync(join(fixture, 'native.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
      assert.ok(trace.some(event => event.phase === 'dispatch' && event.requestClass === 'compaction' && event.selectedModel === model), `${kind} native compactor dispatch`)
      assert.ok(observations.some(event => event.phase === `compact-${kind}` && event.family === kind), `${kind} direct native provider request`)
      assert.ok(observations.filter(event => event.family === kind).every(event => !event.nativeCredentials), `${kind} does not receive native Claude credentials`)
    }
  }
  if (!selected || selected === 'auto') {
    env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = '1'
    const session = randomUUID()
    await run('auto-seed', ['--session-id', session, '--tools', ''], 'Remember this owned native fixture context. ' + 'OWNED_AUTO_CONTEXT '.repeat(2500))
    await run('auto-second', ['--resume', session, '--tools', ''], 'Keep the owned native fixture constraints for later.')
    await run('auto-third', ['--resume', session, '--tools', ''], 'Confirm the owned native fixture constraints remain in context.', 'dontAsk', null)
    await run('auto-continue', ['--resume', session, '--tools', ''], 'Continue the owned native fixture.', 'dontAsk', null)
    const trace = readFileSync(join(fixture, 'native.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.ok(trace.some(event => event.phase === 'lifecycle' && event.trigger === 'auto'), 'real native automatic compaction event')
    const files = readdirSync(join(configDir, 'projects'), { recursive: true }).filter(file => typeof file === 'string' && file.endsWith(session + '.jsonl'))
    const boundaries = files.flatMap(file => readFileSync(join(configDir, 'projects', file), 'utf8').trim().split('\n').map(line => JSON.parse(line))).filter(event => event.type === 'system' && event.subtype === 'compact_boundary')
    if (!boundaries.some(event => event.compactMetadata?.trigger === 'auto')) process.stdout.write(JSON.stringify({ autoDiagnostics: { boundaries: boundaries.map(event => ({ keys: Object.keys(event), compactMetadata: event.compactMetadata })), observations: observations.filter(event => event.phase.startsWith('auto')), trace: trace.filter(event => ['dispatch','refused','lifecycle'].includes(event.phase)), stores: readdirSync(join(configDir, 'plugins/store')), } }) + '\n')
    assert.ok(boundaries.some(event => event.compactMetadata?.trigger === 'auto'), 'authentic automatic compaction completes native transcript bookkeeping')
    assert.ok(observations.some(event => event.phase === 'auto-third' && event.family === 'a' && event.model === 'main'), 'startup compaction reaches its approved direct provider')
    delete env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
  }
  assert.equal(denied.length, 0, 'no native Anthropic inference requests escape the adapter')
  process.stdout.write(`${JSON.stringify({ nativeAdapter: 'pass', observations: observations.map(({ started, ended, ...event }) => event), deniedInference: denied.length })}\n`)
} catch (error) {
  process.stdout.write(JSON.stringify({ failedPhase: phase, observations: observations.map(({started,ended,...event})=>event), denied, dispatch: (()=>{try{return readFileSync(join(fixture,'native.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(event=>['dispatch','refused','policy'].includes(event.phase))}catch{return []}})() })+'\n')
  throw error
} finally {
  await Promise.all([new Promise(resolve => provider.close(resolve)), new Promise(resolve => search.close(resolve))])
  rmSync(fixture, { recursive: true, force: true })
}
