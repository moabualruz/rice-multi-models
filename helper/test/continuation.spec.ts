import { expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { codexStep } from '../codex'
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseConfig, fingerprint } from '../../hooks/config'
import type { Kind } from '../../hooks/config'
import type { ApiMessage, StepEvent, StepRequest } from '../../hooks/protocol'
import { continuationCapability, continuationStatus, CONTINUATION_OFF } from '../../hooks/continuation'
import type { ContinuationAdapter } from '../../hooks/continuation'
import { contextDigest, continuationScope, createContinuation, opaqueBlocks, restoreContinuations } from '../continuation'
import { createStepper } from '../styx/step'
import type { Placed } from '../styx/history'
import { CODECS } from '../styx/codecs'
import { normalize } from '../styx/history'

const now = 100000
const req: StepRequest = { target: 'custom/exact-model', session: 'synthetic-session-a', who: 'native-agent-loop-a', system: 'PRIVATE_SYSTEM_NOT_TO_PERSIST', tools: [{ name: 'Read', description: 'read', schema: { type: 'object' } }], transcript: [{ role: 'user', content: 'PRIVATE_PROMPT_NOT_TO_PERSIST' }], continuation: { boundary: { turnId: 'native-turn-a', index: 0 }, maxAgeSeconds: 60, records: [] } }
const call = { id: 'toolu_rice_actual_native_boundary', name: 'Read', input: { file_path: 'synthetic.txt' }, providerId: 'provider_call_a' }
const identity = { providerId: 'custom', providerKind: 'responses' as const, endpointOrigin: 'https://synthetic.example', endpointRef: 'deployment-a', accountRef: 'profile-a', modelKind: 'responses' as const, modelId: 'exact-model', session: req.session, owner: req.who }
const endpoint = 'https://synthetic.example/v1'
const scope = continuationScope(identity, endpoint)
const encrypted = randomBytes(64).toString('base64')
const blocksFor = (adapter: ContinuationAdapter): Placed[] => [{ at: 0, block: adapter === 'anthropic' || adapter === 'bedrock'
  ? { type: 'redacted_thinking', data: encrypted }
  : { type: 'thinking', thinking: '', signature: adapter === 'gemini' ? 'gemini:' + encrypted : adapter === 'codex-responses'
    ? 'multi-openai:' + Buffer.from(JSON.stringify({ type: 'reasoning', id: 'rs_synthetic', encrypted_content: encrypted, summary: [] })).toString('base64url')
    : 'responses:' + JSON.stringify({ id: 'rs_synthetic', encrypted }) } }]
const resumed = (records: readonly unknown[], extra: readonly ApiMessage[] = []): StepRequest => ({ ...req, transcript: [...req.transcript, { role: 'assistant', content: [{ type: 'tool_use', id: call.id, name: call.name, input: call.input }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'PRIVATE_TOOL_RESULT_NOT_TO_PERSIST' }] }, ...extra], continuation: { ...req.continuation!, boundary: { turnId: 'native-turn-a', index: 1 }, records } })

test('canonical config owns opt-in; there is no implicit retention duration or provider name allowlist', () => {
  expect(parseConfig('{}').config?.continuation).toBeUndefined()
  expect(parseConfig('{"continuation":{"mode":"off"}}').config?.continuation).toEqual(CONTINUATION_OFF)
  expect(parseConfig('{"continuation":{"mode":"durable","maxAgeSeconds":86400}}').config?.continuation).toEqual({ mode: 'durable', maxAgeSeconds: 86400 })
  for (const value of [{ mode: 'durable' }, { mode: 'durable', maxAgeSeconds: 86401 }, { mode: 'durable', maxAgeSeconds: 0 }, { mode: 'off', maxAgeSeconds: 10 }, { mode: 'durable', maxAgeSeconds: 60, enabled: true }, true]) expect(parseConfig(JSON.stringify({ continuation: value })).config).toBeUndefined()
  expect(continuationCapability('openai').detail).toBe('no extra protocol state required')
  const diagnostic = JSON.stringify(continuationStatus({ mode: 'durable', maxAgeSeconds: 60 }, ['responses', 'gemini', 'openai'], 'restored'))
  expect(diagnostic).not.toContain(encrypted)
  expect(diagnostic).toContain('not host-enforced isolation')
})

for (const adapter of ['responses', 'codex-responses', 'gemini', 'anthropic', 'bedrock'] as const) test(`${adapter}: opaque codec contract survives a new module/request, not a wrong native boundary`, () => {
  const blocks = blocksFor(adapter)
  const record = createContinuation(req, adapter, scope, { actualSentPrefix: 'PRIVATE_DISPATCH_NOT_TO_PERSIST' }, [call], blocks, now)!
  expect(record).toBeDefined()
  expect(record.dispatchedDigest).toMatch(/^[a-f0-9]{64}$/)
  expect(record.blocks).toEqual(blocks)
  const serialized = JSON.stringify(record)
  for (const text of ['PRIVATE_PROMPT', 'PRIVATE_SYSTEM', 'PRIVATE_DISPATCH', 'PRIVATE_TOOL_RESULT', 'synthetic.txt', 'profile-a', 'synthetic.example']) expect(serialized).not.toContain(text)
  const fresh = JSON.parse(serialized)
  expect(restoreContinuations(resumed([fresh]), adapter, scope, now + 1)).toEqual([record])
  expect(restoreContinuations(resumed([fresh], [{ role: 'user', content: 'A later user message after committed results' }]), adapter, scope, now + 1)).toHaveLength(1)
  expect(restoreContinuations(resumed([fresh]), adapter, scope, now + 60000)).toEqual([])
  expect(restoreContinuations(resumed([fresh]), adapter, contextDigest('other endpoint/account/model'), now + 1)).toEqual([])
  expect(restoreContinuations({ ...resumed([fresh]), session: 'other-session' }, adapter, scope, now + 1)).toEqual([])
  expect(restoreContinuations({ ...resumed([fresh]), who: 'other-agent' }, adapter, scope, now + 1)).toEqual([])
  expect(restoreContinuations({ ...resumed([fresh]), system: 'changed' }, adapter, scope, now + 1)).toEqual([])
  expect(restoreContinuations({ ...resumed([fresh]), transcript: [{ role: 'user', content: 'compacted' }] }, adapter, scope, now + 1)).toEqual([])
  expect(restoreContinuations({ ...req, continuation: { ...req.continuation!, records: [fresh] } }, adapter, scope, now + 1)).toEqual([])
  const failed = resumed([fresh]); failed.transcript = [...failed.transcript.slice(0, -1), { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, is_error: true, content: 'failed' }] }]
  expect(restoreContinuations(failed, adapter, scope, now + 1)).toEqual([])
  const edited = resumed([fresh]); edited.transcript = [edited.transcript[0]!, { role: 'assistant', content: [{ type: 'tool_use', id: call.id, name: 'Bash', input: { command: 'changed' } }] }, edited.transcript[2]!]
  expect(restoreContinuations(edited, adapter, scope, now + 1)).toEqual([])
  const editedText = resumed([fresh]); editedText.transcript = [editedText.transcript[0]!, { role: 'assistant', content: [{ type: 'text', text: 'an edited assistant prefix' }, { type: 'tool_use', id: call.id, name: call.name, input: call.input }] }, editedText.transcript[2]!]
  expect(restoreContinuations(editedText, adapter, scope, now + 1)).toEqual([])
  for (const other of ['responses', 'codex-responses', 'gemini', 'anthropic', 'bedrock'] as const) if (other !== adapter) expect(restoreContinuations(resumed([fresh]), other, scope, now + 1)).toEqual([])
  expect(restoreContinuations(resumed([{ ...fresh, version: 2 }]), adapter, scope, now + 1)).toEqual([])
  expect(restoreContinuations(resumed([{ ...fresh, integrity: contextDigest('corrupt') }]), adapter, scope, now + 1)).toEqual([])
})

test('fresh module restoration is independent of process-lifetime maps', async () => {
  // Bun canonicalizes query suffixes and does not load this data URL. Compile a distinct owned module instead.
  const dir = await mkdtemp(join(tmpdir(), 'rice-continuation-module-'))
  try {
    const compiled = await build({ entryPoints: [fileURLToPath(new URL('../continuation.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false, tsconfigRaw: { compilerOptions: {} } })
    const file = join(dir, 'continuation.mjs')
    await writeFile(file, compiled.outputFiles[0]!.text)
    const fresh = await import(pathToFileURL(file).href)
    expect(fresh.restoreContinuations).not.toBe(restoreContinuations)
    const record = createContinuation(req, 'gemini', scope, {}, [call], blocksFor('gemini'), now)!
    expect(fresh.restoreContinuations(resumed([JSON.parse(JSON.stringify(record))]), 'gemini', scope, now + 1)).toEqual([record])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('endpoint path/account/model changes cannot reuse opaque state; credential query/userinfo do not enter scope', () => {
  for (const update of [{ providerId: 'other' }, { modelId: 'other' }, { accountRef: 'other' }, { endpointRef: 'other' }, { session: 'other' }, { owner: 'other' }]) expect(continuationScope({ ...identity, ...update }, endpoint)).not.toBe(scope)
  expect(continuationScope(identity, endpoint + '/other')).not.toBe(scope)
  expect(continuationScope(identity, 'https://unused:unused@synthetic.example/v1?key=unused#unused')).toBe(scope)
})

test('plaintext signed thoughts are blocked, not truncated, fabricated or persisted; empty opaque blocks are preserved', () => {
  for (const adapter of ['anthropic', 'bedrock'] as const) expect(opaqueBlocks(adapter, [{ at: 0, block: { type: 'thinking', thinking: 'private signed provider text', signature: encrypted } }])).toBeUndefined()
  expect(createContinuation(req, 'openai', scope, {}, [call], [], now)).toBeUndefined()
  expect(opaqueBlocks('gemini', [{ at: 0, block: { type: 'thinking', thinking: '', signature: 'gemini:skip_thought_signature_validator' } }])).toBeUndefined()
  expect(createContinuation(req, 'responses', scope, {}, [call], [{ at: 0, block: { type: 'thinking', thinking: '', signature: 'responses:' + JSON.stringify({ encrypted: 'x'.repeat(140000) }) } }], now)).toBeUndefined()
})

for (const kind of ['openai', 'responses', 'anthropic', 'gemini', 'bedrock'] as const) test(`${kind}: actual production codec receives verified extras or ordinary native replay`, () => {
  const config = parseConfig(JSON.stringify({ providers: { arbitrary: { kind: kind === 'bedrock' ? 'bedrock' : 'openai', baseUrl: endpoint, auth: kind === 'bedrock' ? { command: ['/synthetic/auth'] } : 'none', models: { routed: { ...(kind === 'bedrock' ? {} : { kind }), maxOutputTokens: 1024, ...(kind === 'openai' ? { maxTokensParam: 'max_tokens' } : {}) } } } } })).config!
  const provider = config.providers['arbitrary']!, model = provider.models['routed']!
  const blocks = kind === 'openai' ? [] : blocksFor(kind)
  const record = createContinuation(req, kind, scope, {}, [call], blocks, now)
  const current = resumed(record ? [record] : [])
  const restored = restoreContinuations(current, kind, scope, now + 1)
  const wire = CODECS[kind].encode({ system: current.system, tools: [], messages: normalize(current.transcript, true, id => restored.flatMap(record => record.calls).find(call => call.id === id)?.providerId, id => restored.find(record => record.calls.some(call => call.id === id))?.blocks) }, provider, model)
  if (kind === 'responses') { expect(wire.body).toContain(encrypted); expect(JSON.parse(wire.body).store).toBe(false); expect(wire.body).not.toContain('previous_response_id') }
  else if (kind === 'gemini' || kind === 'anthropic' || kind === 'bedrock') expect(wire.body).toContain(encrypted)
  else { expect(wire.body).toContain('PRIVATE_PROMPT'); expect(wire.body).not.toContain(encrypted) }
})

test('durable Gemini history misses never emit a made-up validator signature', () => {
  const provider = parseConfig(JSON.stringify({ providers: { arbitrary: { kind: 'gemini', baseUrl: endpoint, auth: 'none', models: { 'gemini-3-synthetic': {} } } } })).config!.providers['arbitrary']!
  const neutral = { system: req.system, tools: [], messages: normalize(resumed([]).transcript, true, () => undefined), durableContinuation: true as const }
  const wire = CODECS.gemini.encode(neutral, provider, provider.models['gemini-3-synthetic']!)
  expect(wire.body).not.toContain('skip_thought_signature_validator')
  expect(wire.body).not.toContain('thoughtSignature')
})

test('Codex production translator restores encrypted state only for its exact account and endpoint', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rice-continuation-codex-'))
  const authFile = join(dir, 'auth.json')
  const bodies: Record<string, unknown>[] = []
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk
    bodies.push(JSON.parse(body))
    response.setHeader('content-type', 'text/event-stream')
    const send = (event: unknown) => response.write('data: ' + JSON.stringify(event) + '\n\n')
    send({ type: 'response.created', response: { id: 'response_synthetic' } })
    if (bodies.length === 1) {
      const output = [{ type: 'message', id: 'msg_visible', content: [{ type: 'output_text', text: 'Visible fixture prefix' }] }, { type: 'reasoning', id: 'rs_synthetic', encrypted_content: encrypted, summary: [] }, { type: 'function_call', id: 'fc_synthetic', call_id: call.id, name: call.name, arguments: JSON.stringify(call.input) }]
      output.forEach((item, output_index) => {
        send({ type: 'response.output_item.added', output_index, item: item.type === 'message' ? { ...item, content: [] } : item })
        if (item.type === 'message') send({ type: 'response.output_text.delta', output_index, delta: 'Visible fixture prefix' })
        send({ type: 'response.output_item.done', output_index, item })
      })
      send({ type: 'response.completed', response: { id: 'response_synthetic', status: 'completed', output, usage: { input_tokens: 10, output_tokens: 5 } } })
    } else send({ type: 'response.completed', response: { id: 'response_synthetic_end', status: 'completed', output: [], usage: { input_tokens: 10, output_tokens: 1 } } })
    response.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('loopback fixture unavailable')
  const url = `http://127.0.0.1:${address.port}/responses`
  const jwt = Buffer.from('{"alg":"none"}').toString('base64url') + '.' + Buffer.from('{"exp":4102444800}').toString('base64url') + '.synthetic-only'
  const account = (id: string) => writeFile(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: jwt, account_id: id, refresh_token: 'synthetic-never-refreshed' } }), { mode: 0o600 })
  const invoke = async (request: StepRequest) => {
    const events: StepEvent[] = []
    for await (const event of codexStep({ ...request, target: 'codex/exact-model', transport: 'sse' }, 'exact-model', new AbortController().signal, { authFile, httpUrl: url })) events.push(event)
    return events
  }
  try {
    await account('synthetic-account-a')
    const first = await invoke({ ...req, continuation: { ...req.continuation!, maxAgeSeconds: 86400 } })
    expect(first.filter(event => event.type === 'error')).toEqual([])
    const durable = first.find(event => event.type === 'continuation')
    expect(durable?.type).toBe('continuation')
    if (durable?.type !== 'continuation') throw new Error('Codex emitted no durable record')
    expect(durable.record.blocks[0]?.at).toBe(1)
    const resumedReq = resumed([JSON.parse(JSON.stringify(durable.record))]); resumedReq.continuation!.maxAgeSeconds = 86400
    resumedReq.transcript = [resumedReq.transcript[0]!, { role: 'assistant', content: [{ type: 'text', text: 'Visible fixture prefix' }, { type: 'tool_use', id: call.id, name: call.name, input: call.input }] }, resumedReq.transcript[2]!]
    await invoke(resumedReq)
    expect(JSON.stringify(bodies[1])).toContain(encrypted)
    expect(JSON.stringify(bodies[1]).indexOf('Visible fixture prefix')).toBeLessThan(JSON.stringify(bodies[1]).indexOf(encrypted))
    await account('synthetic-account-b')
    await invoke(resumedReq)
    expect(JSON.stringify(bodies[2])).not.toContain(encrypted)
    for (const body of bodies) { expect(body['store']).toBe(false); expect(body).not.toHaveProperty('previous_response_id') }
    expect(JSON.stringify(durable.record)).not.toContain(jwt)
    expect(JSON.stringify(durable.record)).not.toContain('synthetic-account-a')
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }) }
})

test('production Responses decoder/stepper emits a minimal durable record only on complete successful tool output', async () => {
  const configText = JSON.stringify({ providers: { arbitrary: { kind: 'responses', baseUrl: endpoint, auth: 'none', models: { 'exact-model': { maxOutputTokens: 1024 } } } } })
  const provider = parseConfig(configText).config!.providers['arbitrary']!
  const signatureItem = { type: 'reasoning', id: 'rs_synthetic', encrypted_content: encrypted, summary: [] }
  const output = [signatureItem, { type: 'function_call', id: 'fc_synthetic', call_id: 'real_provider_boundary', name: 'Read', arguments: JSON.stringify(call.input) }]
  const fixtures = [
    output.map((item, output_index) => ({ type: 'response.output_item.done', output_index, item })).concat([{ type: 'response.completed', response: { id: 'resp_synthetic', output, status: 'completed' } }] as never),
    [{ type: 'response.output_item.done', output_index: 0, item: signatureItem }, { type: 'response.failed', response: { error: { message: 'synthetic failed stream' } } }],
  ]
  for (const [index, fixture] of fixtures.entries()) {
    const stepper = createStepper({ now: () => now, log() {}, run: async () => ({ exitCode: 1, stdout: '' }), post: async () => ({ status: 200, cancel() {}, body: (async function* () { yield new TextEncoder().encode(fixture.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('')); return undefined })() }) })
    const events: StepEvent[] = []
    for await (const event of stepper.step({ req: { ...req, target: 'arbitrary/exact-model' }, configText, approved: [fingerprint(provider)] }, new AbortController().signal)) events.push(event)
    const durable = events.filter(event => event.type === 'continuation')
    expect(durable).toHaveLength(index === 0 ? 1 : 0)
    if (index === 0 && durable[0]?.type === 'continuation') expect(durable[0].record.calls[0]?.providerId).toBe('real_provider_boundary')
  }
})
