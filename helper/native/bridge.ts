import { createRequire, syncBuiltinESMExports } from 'node:module'
import { NativeOwnership, record } from './ownership.ts'
import type { NativeOwner } from './ownership.ts'

type Listener = ((event: { data: unknown }) => unknown) | { handleEvent(event: { data: unknown }): unknown }
type NativeWorker = {
  postMessage(value: unknown, ...rest: unknown[]): unknown
  addEventListener(type: string, listener: Listener, ...rest: unknown[]): unknown
  removeEventListener(type: string, listener: Listener, ...rest: unknown[]): unknown
  terminate?(): unknown
}
type Channel = { port1: object; port2: object }
type Runtime = {
  Worker: new (...args: unknown[]) => NativeWorker
  MessageChannel: new (...args: unknown[]) => Channel
  MessagePort: { prototype: object }
}
export type BridgeTrace = (direction: 'send' | 'worker' | 'port', frame: unknown, owner?: NativeOwner) => void

/** Observes native RPC correlations and preserves the host's own message callbacks and async scopes. */
export function installNativeBridge(ownership: NativeOwnership, runtime: Runtime, trace?: BridgeTrace, redirectFork?: (owner: NativeOwner) => boolean): void {
  const OriginalWorker = runtime.Worker
  runtime.Worker = new Proxy(OriginalWorker, {
    construct(target, args, newTarget) {
      const worker = Reflect.construct(target, args, newTarget) as NativeWorker
      if (worker.terminate) {
        const terminate = worker.terminate
        worker.terminate = function () { ownership.drop(worker); return terminate.call(this) }
      }
      const send = worker.postMessage
      worker.postMessage = function (value, ...rest) {
        const outgoing = ownership.outgoing(worker, value)
        trace?.('send', outgoing, ownership.context.getStore())
        return send.call(this, outgoing, ...rest)
      }
      const add = worker.addEventListener, remove = worker.removeEventListener
      const listeners = new WeakMap<object, Listener>()
      worker.addEventListener = function (type, listener, ...rest) {
        if (type !== 'message') return add.call(this, type, listener, ...rest)
        let wrapped = listeners.get(listener)
        if (!wrapped) {
          wrapped = event => {
            const owner = ownership.workerOwner(worker, event.data)
            trace?.('worker', event.data, owner)
            try { return ownership.run(owner, () => typeof listener === 'function' ? listener.call(worker, event) : listener.handleEvent(event)) }
            finally { ownership.finishWorker(worker, event.data) }
          }
          listeners.set(listener, wrapped)
        }
        return add.call(this, type, wrapped, ...rest)
      }
      worker.removeEventListener = function (type, listener, ...rest) { return remove.call(this, type, type === 'message' ? listeners.get(listener) ?? listener : listener, ...rest) }
      return worker
    },
  })

  const OriginalChannel = runtime.MessageChannel
  const ChannelWrapper = new Proxy(OriginalChannel, {
    construct(target, args, newTarget) {
      const channel = Reflect.construct(target, args, newTarget) as Channel
      ownership.pair(channel.port1, channel.port2)
      return channel
    },
  })
  runtime.MessageChannel = ChannelWrapper
  // The native host imports this builtin by name; update that binding as well as the global.
  const common = createRequire(import.meta.url)('node:worker_threads') as { MessageChannel: unknown }
  if (common.MessageChannel === OriginalChannel) { common.MessageChannel = ChannelWrapper; syncBuiltinESMExports() }

  const prototype = runtime.MessagePort.prototype
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'onmessage')
  if (!descriptor?.set || !descriptor.get || !descriptor.configurable) throw new Error('rice-multi-models: unsupported native MessagePort callback contract')
  const assigned = new WeakMap<object, unknown>()
  Object.defineProperty(prototype, 'onmessage', {
    ...descriptor,
    get() { return assigned.has(this) ? assigned.get(this) : descriptor.get!.call(this) },
    set(listener: unknown) {
      assigned.set(this, listener)
      if (typeof listener !== 'function') { descriptor.set!.call(this, listener); return }
      const port = this
      descriptor.set!.call(this, (event: { data: unknown }) => {
        const owner = ownership.portOwner(port, event.data)
        trace?.('port', event.data, owner)
        const frame = event.data
        const forkPrompt = record(frame) ? typeof frame.args === 'string' ? frame.args : record(frame.args) && typeof frame.args.prompt === 'string' ? frame.args.prompt : undefined : undefined
        if (owner.purpose === 'fork' && redirectFork?.(owner) && record(frame) && forkPrompt !== undefined) {
          const adapted = { ...frame, op: 'model.complete', args: { model: owner.model, prompt: forkPrompt } }
          // Preserve the native MessageEvent identity/properties apart from its owned RPC data.
          const forwarded = new Proxy(event, { get(target, name) { return name === 'data' ? adapted : Reflect.get(target, name, target) } })
          return ownership.run(owner, () => listener.call(port, forwarded))
        }
        try { return ownership.run(owner, () => listener.call(port, event)) }
        finally { if (record(frame) && (frame.type === 'op_close' || frame.type === 'op_abort')) ownership.finishPort(port, frame) }
      })
    },
  })

  const send = Reflect.get(prototype, 'postMessage') as (...args: unknown[]) => unknown
  Object.defineProperty(prototype, 'postMessage', {
    configurable: true, writable: true,
    value(this: object, value: unknown, ...rest: unknown[]) {
      // A completed host operation can release its retained scope after sending its result.
      const result = send.call(this, value, ...rest)
      if (record(value)) ownership.finishPort(this, value)
      return result
    },
  })
}
