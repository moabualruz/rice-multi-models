import { expect, test } from 'bun:test'
import { NativeOwnership } from './ownership'

const dispatch = (id: number, agentId: string, model: string, environmentId = 7) => ({ type: 'dispatch', id, event: 'turn.step', payload: { agentId, model }, environments: [{ environmentId }] })

test('overlapping child operations retain their exact owner after asynchronous interleaving', async () => {
  const ownership = new NativeOwnership('codex/parent')
  const worker = {}, first = {}, second = {}
  ownership.pair(first, second)
  ownership.outgoing(worker, { type: 'load', environmentId: 7, port: second })
  ownership.outgoing(worker, dispatch(1, 'child-a', 'provider-a/model'))
  ownership.outgoing(worker, dispatch(2, 'child-b', 'provider-b/model'))
  const a = ownership.portOwner(first, { type: 'op', opId: 11, dispatchId: 1 })
  const b = ownership.portOwner(first, { type: 'op', opId: 12, dispatchId: 2 })
  const results = await Promise.all([a, b].map(owner => ownership.run(owner, async () => { await Promise.resolve(); return ownership.context.getStore() })))
  expect(results.map(owner => owner?.model)).toEqual(['provider-a/model', 'provider-b/model'])
  expect(results.map(owner => owner?.agentId)).toEqual(['child-a', 'child-b'])
})

test('nested auxiliary dispatch inherits ownership without treating Haiku as the owner', () => {
  const ownership = new NativeOwnership('codex/parent'), worker = {}
  ownership.outgoing(worker, dispatch(1, 'child', 'other/model'))
  const owner = ownership.workerOwner(worker, { type: 'next', id: 1 })
  const result = ownership.run(owner, () => ownership.outgoing(worker, { type: 'dispatch', id: 2, event: 'model.complete', payload: { model: 'haiku', prompt: 'Fixture' }, environments: [7] })) as any
  expect(result.payload.riceMultiModelsCaller).toMatchObject({ agentId: 'child', model: 'other/model' })
  expect(result.payload.model).toBe('haiku')
})

test('Worker replacement and mismatched environment membership cannot borrow an old owner', () => {
  const ownership = new NativeOwnership('codex/parent'), old = {}, fresh = {}, first = {}, second = {}
  ownership.outgoing(old, dispatch(1, 'old-child', 'other/old'))
  expect(ownership.workerOwner(fresh, { type: 'next', id: 1 }).unowned).toBe(true)
  ownership.pair(first, second)
  ownership.outgoing(old, { type: 'load', environmentId: 8, port: second })
  expect(ownership.portOwner(first, { type: 'op', opId: 1, dispatchId: 1 }).unowned).toBe(true)
})

test('an already captured operation survives dispatch closeout while new stale operations refuse', () => {
  const ownership = new NativeOwnership('codex/parent'), worker = {}, first = {}, second = {}
  ownership.pair(first, second);ownership.outgoing(worker, { type: 'load', environmentId: 7, port: second })
  ownership.outgoing(worker, dispatch(1, 'child', 'other/model'))
  ownership.portOwner(first, { type: 'op', opId: 3, dispatchId: 1 })
  ownership.finishWorker(worker, { type: 'result', id: 1 })
  expect(ownership.portOwner(first, { type: 'op_pull', opId: 3 }).model).toBe('other/model')
  expect(ownership.portOwner(first, { type: 'op', opId: 4, dispatchId: 1 }).unowned).toBe(true)
})

test('native stream terminal shapes retain operations across chunks and release at done and unload', () => {
  const ownership = new NativeOwnership('codex/parent'), worker = {}, first = {}, second = {}
  ownership.pair(first, second); ownership.outgoing(worker, { type: 'load', environmentId: 7, port: second })
  ownership.outgoing(worker, dispatch(1, 'child', 'other/model'))
  expect(ownership.portOwner(first, { type: 'op_pull', opId: 5, open: { dispatchId: 1 } }).model).toBe('other/model')
  ownership.finishPort(first, { type: 'op_result', opId: 5, value: { done: false, value: 'chunk' } })
  ownership.finishWorker(worker, { type: 'stream_step', id: 1, step: { done: true } })
  expect(ownership.portOwner(first, { type: 'op_pull', opId: 5 }).model).toBe('other/model')
  ownership.finishPort(first, { type: 'op_result', opId: 5, value: { done: true } })
  expect(ownership.portOwner(first, { type: 'op_pull', opId: 5 }).unowned).toBe(true)
  ownership.outgoing(worker, { type: 'unload', environmentId: 7 })
  expect(ownership.portOwner(first, { type: 'op', opId: 7, dispatchId: 1 }).unowned).toBe(true)
})

test('authoritative primary loop and compaction events cannot borrow a child or an unrelated timer scope', () => {
  const ownership = new NativeOwnership('codex/parent'), worker = {}
  ownership.outgoing(worker, dispatch(1, 'child', 'other/child'))
  const child = ownership.workerOwner(worker, { type: 'next', id: 1 })
  ownership.run(child, () => ownership.outgoing(worker, { type: 'dispatch_stream', id: 2, event: 'turn.step', payload: { model: 'codex/new-parent' }, environments: [7] }))
  expect(ownership.workerOwner(worker, { type: 'next', id: 2 })).toMatchObject({ model: 'codex/new-parent' })
  expect(ownership.workerOwner(worker, { type: 'next', id: 2 }).agentId).toBeUndefined()
  expect(ownership.selection('child').model).toBe('other/child')
  ownership.run({ unowned: true }, () => ownership.outgoing(worker, { type: 'dispatch', id: 3, event: 'session.compact', payload: { trigger: 'auto' }, environments: [7] }))
  expect(ownership.workerOwner(worker, { type: 'next', id: 3 }).model).toBe('codex/new-parent')
})

test('a temporary primary skill alias preserves the selected provider, while an explicit selection changes it', () => {
  const ownership = new NativeOwnership('codex/parent'), worker = {}
  ownership.publish({ model: 'codex/parent', session: 'owned' })
  ownership.outgoing(worker, { type: 'dispatch_stream', id: 1, event: 'turn.step', payload: { model: 'haiku' }, environments: [7] })
  expect(ownership.workerOwner(worker, { type: 'next', id: 1 }).model).toBe('codex/parent')
  ownership.outgoing(worker, { type: 'dispatch_stream', id: 3, event: 'turn.step', payload: { model: 'other/forked-skill' }, environments: [7] })
  expect(ownership.workerOwner(worker, { type: 'next', id: 3 }).model).toBe('other/forked-skill')
  expect(ownership.selection().model).toBe('codex/parent')
  ownership.publish({ model: 'haiku', session: 'owned' })
  ownership.outgoing(worker, { type: 'dispatch_stream', id: 2, event: 'turn.step', payload: { model: 'haiku' }, environments: [7] })
  expect(ownership.workerOwner(worker, { type: 'next', id: 2 }).model).toBe('haiku')
})
