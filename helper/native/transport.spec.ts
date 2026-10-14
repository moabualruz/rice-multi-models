import { expect, test } from 'bun:test'
import { NativeOwnership } from './ownership.ts'
import { nativeFetch } from './transport.ts'
import type { StepEvent, StepWire } from '../../hooks/protocol.ts'

test('direct native requests never forward Claude credentials, recurse, or borrow an ambiguous owner', async () => {
  const ownership = new NativeOwnership('codex/owned')
  const targets: string[] = []
  let passthrough = 0
  const original = (async () => { passthrough++; return new Response('unrelated') }) as typeof fetch
  const direct = async function* (wire: StepWire): AsyncGenerator<StepEvent> {
    targets.push(wire.req.target)
    expect(Object.keys(wire).sort()).toEqual(['approved', 'configText', 'req', 'userAgent'])
    yield { type: 'text', text: 'Owned direct answer' }; yield { type: 'stop', reason: 'end_turn' }
  }
  const adapted = nativeFetch(original, ownership, direct)
  const call = () => adapted('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { authorization: 'unforwarded', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'haiku', messages: [{ role: 'user', content: 'Owned' }] }) })
  const first = await ownership.run({ model: 'codex/child', agentId: 'a' }, call)
  expect(first.status).toBe(200)
  expect(targets).toEqual(['codex/child'])
  const refused = await ownership.run({ unowned: true }, call)
  expect(refused.status).toBe(400)
  expect(targets).toHaveLength(1)
  await adapted('https://example.com/content')
  expect(passthrough).toBe(1)
})
