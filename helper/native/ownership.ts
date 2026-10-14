import { AsyncLocalStorage } from 'node:async_hooks'

export type NativeOwner = Readonly<{
  model?: string
  agentId?: string
  sessionId?: string
  unowned?: true
  purpose?: 'fork'
}>

type Frame = { owner: NativeOwner; environments: ReadonlySet<number> }
type WorkerState = { frames: Map<number, Frame>; calls: Map<number, Frame>; ports: Map<number, Set<object>> }
type PortState = { worker: object; environment: number; operations: Map<number, { owner: NativeOwner; stream: boolean }> }

export const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
export const nativeAlias = (model: string): boolean => /^(?:claude-|native\/|(?:haiku|sonnet|opus|fable|default|inherit)(?:\[1m\])?$)/i.test(model)
const number = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length < 4096
const UNOWNED: NativeOwner = Object.freeze({ unowned: true })
const MAX_FRAMES = 4096

/** Correlations are scoped to real Worker/port objects, never a global last-child value. */
export class NativeOwnership {
  readonly context = new AsyncLocalStorage<NativeOwner>()
  private readonly workers = new WeakMap<object, WorkerState>()
  private readonly ports = new WeakMap<object, PortState>()
  private readonly pairs = new WeakMap<object, object>()
  private readonly models = new Map<string, string>()
  private primary: string | undefined
  private session: string | undefined

  constructor(initialModel?: string) { this.primary = initialModel }

  private published = false

  publish(state: { model: string; session: string; agents?: Record<string, string> }): void {
    if (this.session !== undefined && this.session !== state.session) this.models.clear()
    this.primary = state.model
    this.published = true
    this.session = state.session
    for (const [id, model] of Object.entries(state.agents ?? {})) this.models.set(id, model)
  }

  selection(agentId?: string): NativeOwner {
    const model = agentId ? this.models.get(agentId) : this.primary
    return Object.freeze({ ...(model ? { model } : { unowned: true as const }), ...(agentId ? { agentId } : {}), ...(this.session ? { sessionId: this.session } : {}) })
  }

  private worker(worker: object): WorkerState {
    let state = this.workers.get(worker)
    if (!state) { state = { frames: new Map(), calls: new Map(), ports: new Map() }; this.workers.set(worker, state) }
    return state
  }

  pair(first: object, second: object): void { this.pairs.set(first, second); this.pairs.set(second, first) }

  private owner(event: string, payload: Record<string, unknown>): NativeOwner {
    const inherited = this.context.getStore()
    const loop = ['turn.step', 'turn.start', 'turn.complete', 'session.compact'].includes(event)
    const id = text(payload.agentId) ? payload.agentId : text(payload.agent_id) ? payload.agent_id : loop ? undefined : inherited?.agentId
    // Only an actual loop step establishes its model. Completion's model is a requested alias.
    if (event === 'turn.step' && text(payload.model)) {
      if (id) this.models.set(id, payload.model)
      // $.session.model is the selected primary model. A skill can temporarily
      // override the step's model alias without choosing another provider.
      else if (!this.published) this.primary = payload.model
    }
    // Forked skills can have a distinct routed loop model without an agent ID.
    // Capture that frame's explicit route, preserving the parent selection.
    const selected = event === 'turn.step' && !id && text(payload.model) && !nativeAlias(payload.model) ? payload.model : this.primary
    const model = id ? this.models.get(id) ?? (inherited?.agentId === id ? inherited.model : undefined) : loop ? selected : inherited?.model ?? (inherited?.unowned ? undefined : this.primary)
    return Object.freeze({ ...(model ? { model } : {}), ...(id ? { agentId: id } : {}), ...(this.session ? { sessionId: this.session } : {}), ...(!model ? { unowned: true as const } : {}) })
  }

  outgoing(worker: object, value: unknown): unknown {
    if (!record(value)) return value
    const state = this.worker(worker)
    if (value.type === 'load' && number(value.environmentId) && record(value.port)) {
      const host = this.pairs.get(value.port)
      if (host) {
        this.ports.set(host, { worker, environment: value.environmentId, operations: new Map() })
        const ports = state.ports.get(value.environmentId) ?? new Set<object>()
        ports.add(host); state.ports.set(value.environmentId, ports)
      }
    }
    if (value.type === 'unload' && number(value.environmentId)) {
      for (const port of state.ports.get(value.environmentId) ?? []) this.ports.delete(port)
      state.ports.delete(value.environmentId)
    }
    if (value.type === 'stream_close' && number(value.id)) state.frames.delete(value.id)
    if ((value.type === 'dispatch' || value.type === 'dispatch_stream') && number(value.id) && text(value.event) && record(value.payload)) {
      // Native fork's main-request cache check runs before its documented event.
      // A routed fork operation opens the completion dispatch solely to raise that
      // event; its own handler reads the correct conversation's transcript.
      if (value.event === 'model.complete' && this.context.getStore()?.purpose === 'fork') value = { ...value, event: 'model.fork', payload: { prompt: value.payload.prompt } }
      if (!record(value) || !text(value.event) || !record(value.payload) || !number(value.id)) return value
      const environments = new Set<number>()
      if (Array.isArray(value.environments)) for (const entry of value.environments) {
        if (number(entry)) environments.add(entry)
        else if (record(entry) && number(entry.environmentId)) environments.add(entry.environmentId)
      }
      const owner = this.owner(value.event, value.payload)
      if (state.frames.size >= MAX_FRAMES && !state.frames.has(value.id)) throw new Error('rice-multi-models: native dispatch correlation capacity exceeded')
      state.frames.set(value.id, { owner, environments })
      // Ownership comes from the host dispatch, independently of the requested auxiliary alias.
      return ['model.complete', 'model.classify', 'model.fork'].includes(value.event)
        ? { ...value, payload: { ...value.payload, riceMultiModelsCaller: { version: 1, ...owner } } } : value
    }
    if (value.type === 'call' && number(value.callId) && number(value.environmentId)) {
      state.calls.set(value.callId, { owner: this.context.getStore() ?? UNOWNED, environments: new Set([value.environmentId]) })
    }
    return value
  }

  workerOwner(worker: object, value: unknown): NativeOwner {
    if (!record(value)) return UNOWNED
    const state = this.worker(worker)
    return number(value.id) ? state.frames.get(value.id)?.owner ?? UNOWNED
      : number(value.callId) ? state.calls.get(value.callId)?.owner ?? UNOWNED : UNOWNED
  }

  portOwner(port: object, value: unknown): NativeOwner {
    const binding = this.ports.get(port)
    if (!binding || !record(value) || !number(value.opId)) return UNOWNED
    const existing = binding.operations.get(value.opId)
    if (existing) return existing.owner
    const operation = value.type === 'op_pull' && record(value.open) ? value.open : value
    const state = this.worker(binding.worker)
    const frame = number(operation.dispatchId) ? state.frames.get(operation.dispatchId)
      : number(operation.serving) ? state.calls.get(operation.serving) : undefined
    const selected = frame && frame.environments.has(binding.environment) ? frame.owner : UNOWNED
    const owner = operation.op === 'model.fork' && !selected.unowned ? Object.freeze({ ...selected, purpose: 'fork' as const }) : selected
    if (binding.operations.size >= MAX_FRAMES) return UNOWNED
    binding.operations.set(value.opId, { owner, stream: value.type === 'op_pull' })
    return owner
  }

  finishWorker(worker: object, value: unknown): void {
    if (!record(value)) return
    const state = this.worker(worker)
    if ((value.type === 'result' || value.type === 'error' || value.type === 'stream_step' && record(value.step) && value.step.done === true) && number(value.id)) state.frames.delete(value.id)
    if ((value.type === 'call_result' || value.type === 'call_error') && number(value.callId)) state.calls.delete(value.callId)
  }

  finishPort(port: object, value: unknown): void {
    if (!record(value) || !number(value.opId)) return
    const binding = this.ports.get(port)
    const operation = binding?.operations.get(value.opId)
    if (value.type === 'op_close' || value.type === 'op_abort' || value.type === 'op_error' || value.type === 'op_result' && (!operation?.stream || record(value.value) && value.value.done === true)) binding?.operations.delete(value.opId)
  }

  drop(worker: object): void {
    const state = this.workers.get(worker)
    for (const ports of state?.ports.values() ?? []) for (const port of ports) this.ports.delete(port)
    this.workers.delete(worker)
  }

  run<T>(owner: NativeOwner, action: () => T): T { return this.context.run(owner, action) }
}
