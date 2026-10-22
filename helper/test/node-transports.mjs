import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test, { after } from 'node:test'
import { build } from 'esbuild'
import { WebSocketServer } from 'ws'

const root = fileURLToPath(new URL('../../', import.meta.url))
const scratch = await mkdtemp(join(tmpdir(), 'rice-node-runtime-'))
after(() => rm(scratch, { recursive: true, force: true }))
// Compile the production transports with test-only local endpoint injection. The release executable
// does not gain any endpoint override, fake-auth mode, or test dispatch command.
const fixtureModule = join(scratch, 'transports.mjs')
await build({
  absWorkingDir: root, stdin: { contents: [
    "export { codexStep } from './helper/codex.ts'",
    "export { CodexSocket, SocketPool } from './helper/socket.ts'",
    "export { crc32, frameReader } from './helper/styx/codecs/eventstream.ts'",
    "export { runCommand } from './helper/core/subprocess.ts'",
    "export { executableInvocation } from './helper/core/executable.ts'",
    "export { terminateProcessTree } from './helper/core/process-tree.ts'",
    "export { post } from './helper/styx/upstream.ts'",
    "export { withLocalSocketPath } from './helper/core/local-socket.ts'",
  ].join('\n'), resolveDir: root, loader: 'ts' },
  outfile: fixtureModule, bundle: true, platform: 'node', format: 'esm', target: 'node22',
  tsconfig: join(root, 'helper/tsconfig.node.json'),
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  define: { 'process.env.WS_NO_BUFFER_UTIL': '"1"', 'process.env.WS_NO_UTF_8_VALIDATE': '"1"' },
  plugins: [{ name: 'embed-instructions', setup(build) {
    build.onLoad({ filter: /helper[/\\]openai[/\\]instructions\.ts$/ }, async ({ path }) => ({
      contents: (await readFile(path, 'utf8')).replace("readFileSync(new URL('./instructions.md', import.meta.url), 'utf8').trim()", JSON.stringify((await readFile(join(dirname(path), 'instructions.md'), 'utf8')).trim())), loader: 'ts',
    }))
  } }],
})
const runtime = await import(pathToFileURL(fixtureModule).href)
const release = join(root, 'dist/helper.mjs')
const authFile = join(scratch, 'auth.json')
await writeFile(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'node-fixture-token', account_id: 'node-fixture-account' } }))
const req = { target: 'codex/test', system: 'Node fixture.', tools: [{ name: 'echo', description: 'Echo', schema: { type: 'object' } }], transcript: [{ role: 'user', content: 'Hi' }], who: 'main', session: 'node-fixture' }
const created = { type: 'response.created', response: { id: 'resp_node' } }
const success = [created, { type: 'response.completed', response: { id: 'resp_node', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Node works' }] }], usage: { input_tokens: 2, output_tokens: 2 } } }]

async function fake(replies = [{}]) {
  let calls = 0
  let upgrades = 0
  const seen = []
  const reply = () => replies[Math.min(calls++, replies.length - 1)]
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    seen.push({ headers: request.headers, body })
    const answer = reply()
    response.writeHead(answer.status ?? 200, { 'content-type': 'text/event-stream', ...answer.headers })
    response.end(answer.body ? JSON.stringify(answer.body) : (answer.events ?? success).map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
  })
  const ws = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    if (request.url === '/refused') { socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); return }
    upgrades++
    ws.handleUpgrade(request, socket, head, peer => {
      peer.on('message', message => {
        seen.push({ headers: request.headers, body: JSON.parse(message.toString()) })
        const answer = reply()
        for (const event of answer.events ?? success) peer.send(JSON.stringify(event))
        if (answer.close) peer.close(answer.close)
      })
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  return {
    seen, calls: () => calls, upgrades: () => upgrades,
    async run(transport, options = {}) {
      const events = []
      for await (const event of runtime.codexStep({ ...req, transport }, 'test', new AbortController().signal, { authFile, httpUrl: `${url}/responses`, wsUrl: `${url.replace('http:', 'ws:')}/ws`, ...options })) events.push(event)
      return events
    },
    url,
    async close() { for (const peer of ws.clients) peer.terminate(); ws.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) },
  }
}

for (const transport of ['sse', 'ws']) {
  test(`compiled ${transport} sends authenticated headers and the embedded instructions`, async () => {
    const server = await fake()
    try {
      const events = await server.run(transport)
      assert.equal(events.filter(event => event.type === 'text').map(event => event.text).join(''), 'Node works')
      assert.equal(events.find(event => event.type === 'stop').reason, 'end_turn')
      assert.equal(events.at(-1).transport, transport)
      assert.equal(server.seen[0].headers.authorization, 'Bearer node-fixture-token')
      assert.equal(server.seen[0].headers['chatgpt-account-id'], 'node-fixture-account')
      assert.match(server.seen[0].body.instructions, /OpenAI provider instructions/)
      if (transport === 'ws') assert.equal(server.seen[0].body.type, 'response.create')
    } finally { await server.close() }
  })

  test(`compiled ${transport} retries incomplete streams without replaying buffered text`, async () => {
    const server = await fake([{ events: [created, { type: 'response.failed' }], ...(transport === 'ws' ? { close: 1000 } : {}) }, {}])
    try {
      const events = await server.run(transport)
      assert.equal(server.calls(), 2)
      assert.equal(events.filter(event => event.type === 'text').map(event => event.text).join(''), 'Node works')
      assert.equal(events.filter(event => event.type === 'stop').length, 1)
    } finally { await server.close() }
  })

  test(`compiled ${transport} never replays a committed tool call`, async () => {
    const tool = { type: 'function_call', call_id: 'call_node', name: 'echo', arguments: '{}' }
    const server = await fake([{ events: [created, { type: 'response.output_item.added', output_index: 0, item: tool }, { type: 'response.output_item.done', output_index: 0, item: tool }, { type: 'response.failed', response: { error: { code: 'server_error' } } }] }])
    try {
      const events = await server.run(transport)
      assert.equal(server.calls(), 1)
      assert.equal(events.filter(event => event.type === 'tool_use').length, 1)
      assert.ok(events.some(event => event.type === 'error'))
    } finally { await server.close() }
  })
}

test('compiled HTTP stream cancellation closes the provider connection without replay', async () => {
  let calls = 0
  let acknowledge
  const received = new Promise(resolve => { acknowledge = resolve })
  let providerClosed
  const closed = new Promise(resolve => { providerClosed = resolve })
  const server = createServer((request, response) => {
    calls += 1
    request.resume()
    request.once('end', async () => {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      response.on('close', providerClosed)
      for (const event of [
        created,
        { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_node', type: 'message', content: [] } },
        { type: 'response.output_text.delta', output_index: 0, delta: 'cancel me' },
      ]) response.write(`data: ${JSON.stringify(event)}\n\n`)
      await received
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const controller = new AbortController()
  const iterator = runtime.codexStep({ ...req, transport: 'sse' }, 'test', controller.signal, {
    authFile,
    httpUrl: `http://127.0.0.1:${server.address().port}/responses`,
  })[Symbol.asyncIterator]()
  let timer
  try {
    const first = await Promise.race([
      iterator.next(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('first text was not delivered before cancellation handshake')), 2000) }),
    ])
    clearTimeout(timer)
    assert.deepEqual(first, { done: false, value: { type: 'text', text: 'cancel me' } })
    acknowledge()
    await iterator.return()
    await Promise.race([
      closed,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('provider connection stayed open after cancellation')), 2000) }),
    ])
    clearTimeout(timer)
    assert.equal(calls, 1)
  } finally {
    clearTimeout(timer)
    acknowledge()
    controller.abort()
    await iterator.return().catch(() => undefined)
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

test('compiled HTTP retries a connection reset before response headers', async () => {
  let calls = 0
  const server = createServer(async (request, response) => {
    for await (const chunk of request) {}
    if (++calls === 1) { response.destroy(); return }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(success.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const events = []
    for await (const event of runtime.codexStep({ ...req, transport: 'sse' }, 'test', new AbortController().signal, { authFile, httpUrl: `http://127.0.0.1:${server.address().port}` })) events.push(event)
    assert.equal(calls, 2)
    assert.equal(events.find(event => event.type === 'stop').reason, 'end_turn')
    assert.equal(events.some(event => event.type === 'error'), false)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})

test('compiled WebSocket pool reuses the same connection and auto falls back after a refused handshake', async () => {
  const server = await fake()
  const pool = new runtime.SocketPool()
  try {
    await server.run('ws', { pool })
    const second = await server.run('ws', { pool })
    assert.equal(server.upgrades(), 1)
    assert.equal(second.at(-1).transport, 'ws reused')
    const fallback = await server.run('auto', { wsUrl: server.url.replace('http:', 'ws:') + '/refused' })
    assert.equal(fallback.at(-1).transport, 'sse')
    const refused = await server.run('ws', { wsUrl: server.url.replace('http:', 'ws:') + '/refused' })
    assert.match(refused.find(event => event.type === 'error').text, /HTTP 401/)
  } finally { pool.closeAll(); await server.close() }
})

test('compiled WebSocket abort closes a waiting response', async () => {
  const server = await fake([{ events: [created] }])
  const controller = new AbortController()
  const socket = await runtime.CodexSocket.open(server.url.replace('http:', 'ws:') + '/ws', { authorization: 'Bearer node-fixture-token' })
  try {
    const iterator = socket.response({}, controller.signal, () => null, () => {})[Symbol.asyncIterator]()
    await iterator.next()
    controller.abort()
    await assert.rejects(iterator.next(), /aborted/)
    assert.equal(socket.closed, true)
  } finally { socket.close(); await server.close() }
})

for (const cancellation of ['abort', 'abandon']) {
  test(`compiled WebSocket ${cancellation} terminates a peer that never acknowledges close`, async () => {
    const server = createServer()
    let peer
    server.on('upgrade', (request, socket) => {
      peer = socket
      const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
      let sent = false
      socket.on('data', () => {
        if (cancellation === 'abandon' && !sent) {
          sent = true
          const bytes = Buffer.from(JSON.stringify(created))
          socket.write(Buffer.concat([Buffer.from([0x81, bytes.length]), bytes]))
        }
        // Deliberately discard all close frames without replying.
      })
      socket.on('error', () => {})
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    let connection
    try {
      const controller = new AbortController()
      connection = await runtime.CodexSocket.open(`ws://127.0.0.1:${server.address().port}`, {}, controller.signal)
      // Upgraded HTTP sockets are half-open: FIN proves the client terminated without a close reply.
      const peerEnded = once(peer, 'end', { signal: AbortSignal.timeout(1500) })
      const iterator = connection.response({}, controller.signal, () => null, () => {})[Symbol.asyncIterator]()
      const pending = iterator.next()
      if (cancellation === 'abort') {
        controller.abort()
        await assert.rejects(pending, /aborted/)
      } else {
        await pending
        await iterator.return()
      }
      await peerEnded
      assert.equal(connection.closed, true)
    } finally {
      connection?.close(true)
      peer?.destroy()
      await new Promise(resolve => server.close(resolve))
    }
  })
}

test('portable CRC32 matches AWS IEEE framing and rejects corrupt frames', () => {
  assert.equal(runtime.crc32(Buffer.from('123456789')), 0xcbf43926)
  assert.equal(runtime.crc32(new Uint8Array()), 0)
  const payload = Buffer.from('{"hello":"world"}')
  const frame = Buffer.alloc(16 + payload.length)
  frame.writeUInt32BE(frame.length, 0)
  frame.writeUInt32BE(0, 4)
  frame.writeUInt32BE(runtime.crc32(frame.subarray(0, 8)), 8)
  payload.copy(frame, 12)
  frame.writeUInt32BE(runtime.crc32(frame.subarray(0, -4)), frame.length - 4)
  const reader = runtime.frameReader()
  assert.deepEqual([...reader.feed(frame.subarray(0, 7))], [])
  assert.deepEqual([...reader.feed(frame.subarray(7))], [{ headers: {}, payload: payload.toString() }])
  frame[12] ^= 1
  assert.throws(() => [...runtime.frameReader().feed(frame)], /message CRC mismatch/)
})

test('compiled subprocess preserves literal argv and drains large stderr without shell interpretation', async () => {
  const args = ['spaces here', 'quote"here', '&|<>%!', 'line\nbreak', '']
  const result = await runtime.runCommand([process.execPath, '-e', 'process.stderr.write("x".repeat(1024*1024)); process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...args], 5000)
  assert.equal(result.exitCode, 0)
  assert.deepEqual(JSON.parse(result.stdout), args)
  await assert.rejects(runtime.runCommand([process.execPath, '-e', 'setInterval(()=>{},1000)'], 100), /timed out/)
  await assert.rejects(runtime.runCommand([join(scratch, 'missing-executable')], 1000), /ENOENT/)
})

test('compiled credential timeout stops a real descendant process tree', { skip: process.platform === 'win32' }, async () => {
  const heartbeat = join(scratch, 'child-heartbeat')
  const childScript = `require('node:fs').writeFileSync(${JSON.stringify(heartbeat)}, 'started'); setInterval(() => require('node:fs').appendFileSync(${JSON.stringify(heartbeat)}, '.'), 20)`
  const parentScript = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' }); setInterval(() => {}, 1000)`
  await assert.rejects(runtime.runCommand([process.execPath, '-e', parentScript], 500), /timed out/)
  const stopped = await readFile(heartbeat, 'utf8')
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(await readFile(heartbeat, 'utf8'), stopped)
})

test('platform process boundaries use npm shim resolution and tree termination', () => {
  const shim = 'C:\\bin\\worker.cmd'
  const invocation = runtime.executableInvocation(shim, ['literal & argument'], 'win32', {}, { readShim: () => '"%dp0%\\node_modules\\worker\\cli.js" %*', exists: () => true })
  assert.equal(invocation.command, process.execPath)
  assert.deepEqual(invocation.args, ['C:\\bin\\node_modules\\worker\\cli.js', 'literal & argument'])
  assert.throws(() => runtime.executableInvocation(shim, ['unsafe & argument'], 'win32', {}, { readShim: () => '', exists: () => false }), /metacharacters/)
  const killed = []
  runtime.terminateProcessTree(100, { platform: 'linux', signal: 'SIGKILL', kill: (...args) => killed.push(args) })
  assert.deepEqual(killed, [[-100, 'SIGKILL'], [100, 'SIGKILL']])
  const windows = []
  runtime.terminateProcessTree(200, { platform: 'win32', signal: 'SIGKILL', taskkill: (...args) => windows.push(args) })
  assert.deepEqual(windows, [[200, true]])
})

test('compiled provider HTTP transport supports streamed bodies, redirect refusal, and cancellation', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/redirect') { response.writeHead(302, { location: '/okay' }).end(); return }
    response.end('data: test\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  const input = { url, allowHttp: true, headers: {}, body: '{}', totalS: 3, stallS: 2 }
  try {
    const answer = await runtime.post(input, new AbortController().signal)
    assert.equal(answer.status, 200)
    let text = ''
    for await (const bytes of answer.body) text += Buffer.from(bytes).toString()
    assert.equal(text, 'data: test\n\n')
    assert.equal((await runtime.post({ ...input, url: url + '/redirect' }, new AbortController().signal)).cut.kind, 'redirect')
    const controller = new AbortController(); controller.abort()
    assert.equal((await runtime.post(input, controller.signal)).cut.kind, 'reset')
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})

test('release bundle alone runs doctor without node_modules or source assets', async () => {
  const standalone = join(scratch, 'helper-alone.mjs')
  await copyFile(release, standalone)
  const result = spawnSync(process.execPath, [standalone, 'doctor'], { env: { ...process.env, HOME: scratch, CLAUDE_CONFIG_DIR: join(scratch, 'config'), CODEX_HOME: join(scratch, 'codex'), PATH: '' }, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const info = JSON.parse(result.stdout)
  assert.equal(info.configDir, join(scratch, 'config'))
  assert.equal(info.codexHome, join(scratch, 'codex'))
  assert.equal(info.nodeVersion, process.versions.node)
  assert.equal(info.executable, process.execPath)
  assert.deepEqual(info.auth, { codex: false, opencode: false })
})

async function localPost(socketPath, body, path = '/step') {
  return new Promise((resolve, reject) => {
    const outgoing = runtime.withLocalSocketPath(socketPath, socket => request({ socketPath: socket, path, method: 'POST', headers: { 'content-type': 'application/json' } }, async incoming => {
      const chunks = []
      try { for await (const chunk of incoming) chunks.push(chunk); resolve({ status: incoming.statusCode, text: Buffer.concat(chunks).toString() }) } catch (error) { reject(error) }
    }))
    outgoing.on('error', reject)
    outgoing.end(JSON.stringify(body))
  })
}

async function firstChildLine(lines, exited) {
  const [line] = await Promise.race([once(lines, 'line'), exited.then(([code, signal]) => {
    throw new Error(`fixture child exited before readiness: code=${code} signal=${signal}`)
  })])
  return line
}

test('IPC fixture startup fails closed when its child exits before announcing readiness', { timeout: 5000 }, async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(17)'], { stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = once(child, 'exit')
  const lines = createInterface({ input: child.stdout })
  try { await assert.rejects(firstChildLine(lines, exited), /exited before readiness: code=17/) }
  finally { lines.close(); child.kill('SIGTERM'); await exited }
})

test('release client never falls back after accepted empty or dropped requests', async () => {
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\rice-client-test-${process.pid}` : join(scratch, 'accepted.sock')
  const listenPath = process.platform === 'win32' ? socketPath : 'accepted.sock'
  const serverCode = `const http = require('node:http'); const server = http.createServer(async (req,res) => { let text=''; for await (const chunk of req) text+=chunk; if (JSON.parse(text).drop) req.socket.destroy(); else res.end(); }); server.listen(${JSON.stringify(listenPath)}, () => process.stdout.write('ready\\n')); process.on('SIGTERM', () => { server.close(); process.exit(0); });`
  const server = spawn(process.execPath, ['-e', serverCode], { cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = once(server, 'exit')
  const lines = createInterface({ input: server.stdout })
  try {
    await firstChildLine(lines, exited)
    for (const drop of [false, true]) {
      const result = spawnSync(process.execPath, [release, 'client', socketPath], { input: JSON.stringify({ drop }), encoding: 'utf8', timeout: 5000 })
      assert.equal(result.status, 1, result.stderr)
      assert.equal(result.stdout, '')
    }
  } finally { lines.close(); server.kill('SIGTERM'); await exited }
})

test('release session IPC requires its body token and client fallback never replays a delivered event', async () => {
  const longTemp = join(scratch, 'long-private-session-directory-with-spaces-for-unix-socket-regression')
  await mkdir(longTemp)
  const originalCwd = process.cwd()
  const helper = spawn(process.execPath, [release, 'serve'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: scratch, TMPDIR: longTemp, TMP: longTemp, TEMP: longTemp } })
  const exited = once(helper, 'exit')
  const lines = createInterface({ input: helper.stdout })
  try {
    const ready = await firstChildLine(lines, exited)
    assert.ok(ready.startsWith('ready '))
    const { socketPath, token } = JSON.parse(ready.slice(6))
    assert.equal(process.cwd(), originalCwd)
    if (process.platform !== 'win32') assert.ok(socketPath.startsWith(longTemp))
    const wire = { req: { ...req, target: 'missing/test' }, configText: '', approved: [], token }
    assert.equal((await localPost(socketPath, { ...wire, token: 'wrong' })).status, 401)
    assert.equal((await localPost(socketPath, { ...wire, token: 'é'.repeat(token.length) })).status, 401)
    const status = await localPost(socketPath, { token }, '/status')
    assert.equal(status.status, 200)
    assert.equal(JSON.parse(status.text).inFlight, 0)
    const client = spawnSync(process.execPath, [release, 'client', socketPath], { input: JSON.stringify(wire), encoding: 'utf8', timeout: 5000 })
    assert.equal(client.status, 0, client.stderr)
    assert.equal(JSON.parse(client.stdout.trim().split('\n')[0]).type, 'error')
    const denied = spawnSync(process.execPath, [release, 'client', socketPath], { input: JSON.stringify({ ...wire, token: 'wrong' }), encoding: 'utf8', timeout: 5000 })
    assert.equal(denied.status, 1)
    const absent = spawnSync(process.execPath, [release, 'client', join(scratch, 'absent.sock')], { input: JSON.stringify(wire), encoding: 'utf8', timeout: 5000 })
    assert.equal(absent.status, 3)
  } finally {
    lines.close()
    helper.kill('SIGTERM')
    await exited
  }
})
