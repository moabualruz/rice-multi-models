import { expect, test } from 'bun:test'
import { helperStep, preferSession, readyLine, setSessionHelper } from '../hooks/backend'
import type { StepWire } from '../hooks/protocol'

const token = 'a'.repeat(64)
const wire = { configText: '', approved: [], req: { target: 'codex/test', system: '', transcript: [], tools: [], who: 'main', session: 'fixture' }, userAgent: 'fixture' } as StepWire

test('structured ready supports spaced Unix paths and Windows pipes only after complete newline', () => {
  for (const socketPath of ['/tmp/rice fixture/helper.sock', '\\\\.\\pipe\\rice-fixture']) {
    const line = 'ready ' + JSON.stringify({ socketPath, token })
    expect(readyLine(line)).toBeUndefined()
    expect(readyLine(line + '\n')).toEqual({ socketPath, token })
  }
  expect(readyLine('ready /tmp/old.sock ' + token + '\n')).toBeUndefined()
  expect(readyLine('ready {"socketPath":"/tmp/rice","token":"bad"}\n')).toBeUndefined()
})

test('Node client falls back once only when unavailable before sending a request', async () => {
  let fallback = 0
  const port: any = {
    client: async function* (input: string, socketPath: string) {
      expect(JSON.parse(input).token).toBe(token)
      expect(socketPath).toBe('/tmp/rice fixture.sock')
      return { code: 3 }
    },
    once: async function* (input: string) {
      fallback++
      expect(JSON.parse(input).token).toBeUndefined()
      yield { stream: 'stdout', text: '{"type":"text","text":"fallback"}\n{"type":"stop","reason":"end_turn"}\n' }
      return { code: 0 }
    },
  }
  preferSession(true)
  setSessionHelper({ socketPath: '/tmp/rice fixture.sock', token })
  const events = []
  for await (const event of helperStep(port, wire)) events.push(event)
  expect(events.map(event => event.type)).toEqual(['text', 'stop'])
  expect(fallback).toBe(1)
  setSessionHelper(undefined)
})

test('post-dispatch client failures and partial output never replay provider requests', async () => {
  for (const partial of [false, true]) {
    let fallback = 0
    const port: any = {
      client: async function* () {
        if (partial) yield { stream: 'stdout', text: '{"type":"text","text":"partial"}\n' }
        return { code: partial ? 3 : 1 }
      },
      once: async function* () { fallback++; return { code: 0 } },
    }
    setSessionHelper({ socketPath: '/tmp/rice.sock', token })
    const events = []
    for await (const event of helperStep(port, wire)) events.push(event)
    expect(fallback).toBe(0)
    expect(events.at(-1)?.type).toBe('error')
  }
  setSessionHelper(undefined)
})
