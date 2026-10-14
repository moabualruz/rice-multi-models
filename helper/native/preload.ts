import { appendFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { isMainThread } from 'node:worker_threads'
import { installNativeBridge } from './bridge.ts'
import { NativeOwnership, record } from './ownership.ts'
import { nativeFetch } from './transport.ts'
import { ACTIVE_ENV, ADAPTER_VERSION, nativeState, routedNativeModel } from './state.ts'

type BunRuntime = typeof globalThis & { Bun?: { isStandaloneExecutable?: boolean }; Worker: ConstructorParameters<typeof Proxy>[0] }
const runtime = globalThis as unknown as BunRuntime
const key = Symbol.for('rice-multi-models.native-adapter')
const executable = realpathSync(process.execPath)
const expected = process.env.RICE_MULTI_MODELS_NATIVE_EXECUTABLE
const probe = process.env.RICE_MULTI_MODELS_HANDSHAKE !== undefined
const matched = expected === executable

if (isMainThread && runtime.Bun?.isStandaloneExecutable && !matched && !probe) {
  // A Bun credential helper or worker CLI inherits BUN_OPTIONS too. It is not
  // Claude and must never be intercepted using its parent's conversation.
  delete process.env[ACTIVE_ENV]
  if (expected && (basename(expected) === 'claude' && basename(executable) === 'claude'
    || dirname(expected) === dirname(executable) && /^\d+\.\d+\.\d+$/.test(basename(executable)))) throw new Error('rice-multi-models: background Claude executable changed; launch it through the verified rice-claude entry point')
}

if (isMainThread && runtime.Bun?.isStandaloneExecutable && (matched || probe) && !Reflect.has(globalThis, key)) {
  const original = globalThis.fetch
  if (!Object.getOwnPropertyDescriptor(globalThis, 'fetch')?.configurable) throw new Error('rice-multi-models: native fetch cannot be adapted')
  const index = process.argv.indexOf('--model')
  const selected = index >= 0 ? process.argv[index + 1] : process.argv.find(arg => arg.startsWith('--model='))?.slice('--model='.length)
  const ownership = new NativeOwnership(selected ?? (probe ? process.env.RICE_MULTI_MODELS_INITIAL_MODEL : undefined))
  delete process.env.RICE_MULTI_MODELS_NATIVE_STATE
  const trace = process.env.RICE_MULTI_MODELS_NATIVE_TRACE
  installNativeBridge(ownership, runtime as unknown as Parameters<typeof installNativeBridge>[1], trace ? (direction, frame, owner) => {
    if (!record(frame)) return
    const payload = record(frame.payload) ? frame.payload : {}
    if (frame.event === 'session.compact') appendFileSync(trace, JSON.stringify({ phase: 'lifecycle', direction, type: frame.type, keys: Object.keys(frame), event: frame.event, id: frame.id, trigger: payload.trigger, agentId: payload.agentId, environments: frame.environments, payloadKeys: Object.keys(payload) }) + '\n', { mode: 0o600 })
    if (typeof frame.event === 'string' && frame.event.startsWith('model.') || typeof frame.op === 'string' && frame.op.startsWith('model.')) {
      appendFileSync(trace, JSON.stringify({ phase: 'caller', direction, type: frame.type, event: frame.event, op: frame.op, id: frame.id, dispatchId: frame.dispatchId,
        owner, caller: payload.riceMultiModelsCaller,
        argsKind: Array.isArray(frame.args) ? 'array' : typeof frame.args,
        argsKeys: record(frame.args) ? Object.keys(frame.args) : Array.isArray(frame.args) ? frame.args.map(arg => record(arg) ? Object.keys(arg) : typeof arg) : undefined }) + '\n', { mode: 0o600 })
    }
  } : undefined, owner => routedNativeModel(owner.model, nativeState()))
  const delegate = nativeFetch(original, ownership, undefined, trace ? event => appendFileSync(trace, JSON.stringify(event) + '\n', { mode: 0o600 }) : undefined)
  // The host's private FetchSession branch compares current fetch with its captured value.
  // A fresh delegate identity keeps all model requests on this observable boundary.
  Object.defineProperty(globalThis, 'fetch', { configurable: true, enumerable: true, get: () => {
    const current = delegate.bind(globalThis)
    // Bun also exposes fetch.preconnect. Preserve custom static properties on each delegate.
    for (const key of Reflect.ownKeys(original)) {
      if (['name', 'length', 'prototype', 'arguments', 'caller'].includes(String(key))) continue
      const descriptor = Object.getOwnPropertyDescriptor(original, key)
      if (descriptor) Object.defineProperty(current, key, descriptor)
    }
    return current
  } })
  Reflect.set(globalThis, key, ownership)
  process.env[ACTIVE_ENV] = ADAPTER_VERSION
  const handshake = process.env.RICE_MULTI_MODELS_HANDSHAKE
  if (handshake) writeFileSync(handshake, JSON.stringify({ version: ADAPTER_VERSION, pid: process.pid, bun: true, native: true, executable }) + '\n', { mode: 0o600, flag: 'wx' })
}
