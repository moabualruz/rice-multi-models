import { AsyncLocalStorage } from 'node:async_hooks'
import type { StepEvent, StepWire } from '../../hooks/protocol.ts'
import { runStep } from '../run.ts'
import { NativeOwnership, nativeAlias, record } from './ownership.ts'
import { nativeRequest } from './requests.ts'
import { nativeFailure, providerResponse } from './responses.ts'
import { nativeApprovals, nativeInputBound, nativeState, nativeWireConfig, routedNativeModel } from './state.ts'
import { searchStep } from './search.ts'
import { nativeContracts } from './contracts.ts'
import { estimateTokens, remoteOf } from '../../hooks/providers.ts'
import { splitTarget } from '../../hooks/protocol.ts'

type Direct = (wire: StepWire, signal: AbortSignal) => AsyncIterable<StepEvent>
export type NativeObservation = { phase: 'dispatch'; selectedModel: string; requestedModel: string; agentId?: string; requestClass?: string; stream: boolean }
  | { phase: 'policy'; nativeState: boolean; inputBound: number | null; estimatedTokens: number; reportedInput: number | null; configuredInput: number | null; freshProvider: boolean }
  | { phase: 'refused'; reason: string; ownerKnown: boolean; scoped: boolean; nativeState: boolean; fields: string[]; messages: unknown[] }

export function nativeEndpoint(url: URL): 'messages' | 'count' | undefined {
  if (/\/messages\/count_tokens\/?$/.test(url.pathname)) return 'count'
  if (/\/messages\/?$/.test(url.pathname)) return 'messages'
  return undefined
}

/** No listener or intermediate server: this delegate answers the host's fetch inside its process. */
export function nativeFetch(original: typeof fetch, ownership: NativeOwnership, direct: Direct = runStep, observe?: (event: NativeObservation) => void): typeof fetch {
  const providerCall = new AsyncLocalStorage<boolean>()
  return async (input, init) => {
    if (providerCall.getStore()) return original(input, init)
    const request = new Request(input, init)
    const endpoint = request.method === 'POST' ? nativeEndpoint(new URL(request.url)) : undefined
    if (!endpoint) return original(input, init)
    const state = nativeState()
    if (state) ownership.publish(state)
    const scope = ownership.context.getStore()
    const id = request.headers.get('x-claude-code-agent-id')
    const identified = id ? ownership.selection(id) : undefined
    let owner = identified && !identified.unowned ? identified : scope ?? ownership.selection(id ?? undefined)
    let body: unknown
    // Native forked skills can dispatch from their parent's async continuation.
    // A subagent loop's exact routed model is authoritative; auxiliary Claude
    // aliases still inherit the captured conversation owner.
    if (request.headers.get('x-claude-code-request-class') === 'subagent') {
      try {
        body = await request.clone().json()
        if (record(body) && typeof body.model === 'string' && !nativeAlias(body.model)) owner = Object.freeze({ ...owner, model: body.model, unowned: undefined })
      } catch { return nativeFailure() }
    }
    // A known native owner retains its native provider; unrelated HTTP remains unchanged.
    try { if (!owner.unowned && !routedNativeModel(owner.model, state)) return original(request) } catch { return nativeFailure() }
    try {
      body ??= await request.json()
      if (endpoint === 'count') {
        // The host already uses local token estimates when this optional API is unavailable.
        return Response.json({ type: 'error', error: { type: 'not_found_error', message: 'Direct provider token counting uses local estimation' } }, { status: 404, headers: { 'x-should-retry': 'false' } })
      }
      const native = nativeRequest(body, owner)
      observe?.({ phase: 'dispatch', selectedModel: native.req.target, requestedModel: native.model, ...(owner.agentId ? { agentId: owner.agentId } : {}),
        ...(request.headers.get('x-claude-code-request-class') ? { requestClass: request.headers.get('x-claude-code-request-class')! } : {}), stream: native.stream })
      const approved = nativeApprovals(state)
      const config = await nativeWireConfig(native.req.target, state, approved, request.signal)
      const bound = nativeInputBound(config, native.req.target, state)
      const size = estimateTokens(native.req)
      observe?.({ phase: 'policy', nativeState: state !== undefined, inputBound: bound, estimatedTokens: size,
        reportedInput: state?.catalogue.models.find(entry => entry.model === native.req.target)?.metadata.inputTokenLimit ?? null,
        configuredInput: remoteOf(config, native.req.target)?.model.maxInputTokens ?? null,
        freshProvider: state?.catalogue.providers.some(entry => entry.provider === splitTarget(native.req.target)?.provider && entry.status === 'fresh') ?? false,
      })
      if (bound !== null && size > 0.95 * bound) return nativeFailure(`rice-multi-models: estimated request exceeds the local 95% safety threshold of the ${bound} token input bound; compact or reduce context (token estimates are approximate)`)
      if (state?.transport) native.req.transport = state.transport
      const capability = remoteOf(config, native.req.target)?.model.tools
      if (native.req.native?.maxTokens === 0 && remoteOf(config, native.req.target)?.model.kind !== 'anthropic') throw new Error('native cache-only requests require a provider with cache population support')
      const toolCapable = capability !== false && (!Array.isArray(capability) || capability.includes('web_search')) && !['agy', 'grok'].includes(splitTarget(native.req.target)?.provider ?? '')
      const controller = new AbortController()
      const signal = AbortSignal.any([request.signal, controller.signal])
      const wire: StepWire = { req: native.req, configText: config.text, approved, userAgent: 'rice-multi-models/native' }
      // Run every iterator continuation under the bypass scope, including asynchronous provider fetches.
      const events = {
        async *[Symbol.asyncIterator]() {
          const iterator = providerCall.run(true, () => nativeContracts(native.serverTools.length ? searchStep(wire, native, signal, direct, undefined, toolCapable) : direct(wire, signal), native.req.native)[Symbol.asyncIterator]())
          try {
            while (true) {
              const item = await providerCall.run(true, () => iterator.next())
              if (item.done) return
              yield item.value
            }
          } finally { await providerCall.run(true, () => iterator.return?.(undefined)) }
        },
      }
      // Codex subscriptions do not accept a server output cap. A reported overrun
      // fails the native contract instead of silently declaring a capped answer.
      const maximum = Math.min(native.req.native?.maxTokens ?? Infinity, remoteOf(config, native.req.target)?.model.maxOutputTokens ?? Infinity)
      return await providerResponse(remoteOf(config, native.req.target)?.target ?? native.req.target, events, signal, () => controller.abort(), native.stream, Number.isFinite(maximum) ? maximum : undefined)
    } catch (error) {
      if (request.signal.aborted) throw request.signal.reason
      const message = error instanceof Error ? error.message : ''
      const reason = /^(native inference has no verified conversation owner|invalid native [a-z ]+|unsupported native [a-z ]+|native provider configuration [a-z ]+|native server tool requires a direct implementation)$/.test(message) ? message : 'adapter-request-failed'
      observe?.({ phase: 'refused', reason, ownerKnown: !owner.unowned && !!owner.model, scoped: scope !== undefined, nativeState: state !== undefined,
        fields: record(body) ? Object.keys(body).filter(key => /^[a-z_]+$/.test(key)) : [],
        messages: record(body) && Array.isArray(body.messages) ? body.messages.slice(0, 20).map(message => record(message) ? {
          role: ['user', 'assistant', 'system', 'developer'].includes(String(message.role)) ? message.role : 'unknown',
          contentKind: Array.isArray(message.content) ? 'array' : typeof message.content,
          blocks: Array.isArray(message.content) ? message.content.slice(0, 12).map(block => record(block) ? typeof block.type === 'string' && /^[a-z_0-9]+$/.test(block.type) ? block.type : Object.keys(block).filter(key => /^[a-z_]+$/.test(key)) : typeof block) : [],
        } : { kind: typeof message }) : [] })
      return nativeFailure()
    }
  }
}
