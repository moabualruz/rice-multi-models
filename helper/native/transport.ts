import { AsyncLocalStorage } from 'node:async_hooks'
import type { StepEvent, StepWire } from '../../hooks/protocol.ts'
import { runStep } from '../run.ts'
import { NativeOwnership, nativeAlias, record } from './ownership.ts'
import { nativeRequest } from './requests.ts'
import { nativeFailure, providerResponse } from './responses.ts'
import { nativeApprovals, nativeConfig, nativeInputBound, nativeState, nativeWireConfig, routedNativeModel } from './state.ts'
import { directSearch, nativeSearchResponse, searchRestrictions } from './search-policy.ts'
import type { SearchObservation } from './search-policy.ts'
import { NativeSearchModelError, resolveNativeSearchModel } from './search-model.ts'
import { nativeContracts } from './contracts.ts'
import { estimateTokens, remoteOf } from '../../hooks/providers.ts'
import { splitTarget } from '../../hooks/protocol.ts'

type Direct = (wire: StepWire, signal: AbortSignal) => AsyncIterable<StepEvent>
export type NativeObservation = { phase: 'dispatch'; selectedModel: string; requestedModel: string; agentId?: string; requestClass?: string; stream: boolean }
  | SearchObservation
  | { phase: 'policy'; nativeState: boolean; inputBound: number | null; estimatedTokens: number; reportedInput: number | null; configuredInput: number | null; freshProvider: boolean }
  | { phase: 'refused'; reason: string; ownerKnown: boolean; scoped: boolean; nativeState: boolean; fields: string[]; messages: unknown[] }

export function nativeEndpoint(url: URL): 'messages' | 'count' | undefined {
  if (/\/messages\/count_tokens\/?$/.test(url.pathname)) return 'count'
  if (/\/messages\/?$/.test(url.pathname)) return 'messages'
  return undefined
}

/** No listener or intermediate server: this delegate answers the host's fetch inside its process. */
export function nativeFetch(original: typeof fetch, ownership: NativeOwnership, direct: Direct = runStep, observe?: (event: NativeObservation) => void, searchModel = resolveNativeSearchModel): typeof fetch {
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
    // Dedicated search alone has an explicitly requested fallback policy.
    // Ordinary native inference retains the selected conversation provider.
    let routed = false, dedicatedSearch = false
    try {
      routed = routedNativeModel(owner.model, state)
      if (endpoint === 'messages') {
        body ??= await request.clone().json()
        // The qualified host can label its dedicated WebSearch request auxiliary.
        // Its sole server tool establishes the operation independently of that hint.
        dedicatedSearch = record(body) && Array.isArray(body.tools) && body.tools.length === 1 && record(body.tools[0]) && body.tools[0].name === 'web_search' && String(body.tools[0].type).startsWith('web_search_')
      }
      if (!owner.unowned && !routed && !dedicatedSearch) return original(request)
    } catch { return nativeFailure() }
    try {
      body ??= await request.clone().json()
      if (endpoint === 'count') {
        // The host already uses local token estimates when this optional API is unavailable.
        return Response.json({ type: 'error', error: { type: 'not_found_error', message: 'Direct provider token counting uses local estimation' } }, { status: 404, headers: { 'x-should-retry': 'false' } })
      }
      const native = nativeRequest(body, owner)
      observe?.({ phase: 'dispatch', selectedModel: native.req.target, requestedModel: native.model, ...(owner.agentId ? { agentId: owner.agentId } : {}),
        ...(request.headers.get('x-claude-code-request-class') ? { requestClass: request.headers.get('x-claude-code-request-class')! } : {}), stream: native.stream })
      const approved = nativeApprovals(state)
      const config = routed ? await nativeWireConfig(native.req.target, state, approved, request.signal) : nativeConfig(state)
      const bound = nativeInputBound(config, native.req.target, state)
      const size = estimateTokens(native.req)
      observe?.({ phase: 'policy', nativeState: state !== undefined, inputBound: bound, estimatedTokens: size,
        reportedInput: state?.catalogue.models.find(entry => entry.model === native.req.target)?.metadata.inputTokenLimit ?? null,
        configuredInput: remoteOf(config, native.req.target)?.model.maxInputTokens ?? null,
        freshProvider: state?.catalogue.providers.some(entry => entry.provider === splitTarget(native.req.target)?.provider && entry.status === 'fresh') ?? false,
      })
      if (bound !== null && size > 0.95 * bound) return nativeFailure(`rice-multi-models: estimated request exceeds the local 95% safety threshold of the ${bound} token input bound; compact or reduce context (token estimates are approximate)`)
      if (state?.transport) native.req.transport = state.transport
      if (native.req.native?.maxTokens === 0 && remoteOf(config, native.req.target)?.model.kind !== 'anthropic') throw new Error('native cache-only requests require a provider with cache population support')
      const controller = new AbortController()
      const signal = AbortSignal.any([request.signal, controller.signal])
      const wire: StepWire = { req: native.req, configText: config.text, approved, userAgent: 'rice-multi-models/native' }
      if (dedicatedSearch) {
        // Invalid input is a request failure, not a reason to try another service.
        searchRestrictions(native.serverTools[0])
        const query = ownership.search(scope) ?? ownership.search(owner)
        const searchSignal = AbortSignal.any([signal, AbortSignal.timeout(90_000)])
        let nativeAttempt: Response | undefined
        const failedClaude = (error: unknown) => {
          request.signal.throwIfAborted()
          observe?.({ phase: 'search', stage: 'claude', status: 'unavailable', reason: error instanceof NativeSearchModelError ? error.reason : 'request-failed' })
        }
        const claude = async () => {
          const model = routed ? await searchModel() : native.model
          const headers = new Headers(request.headers)
          headers.delete('content-length')
          const response = await providerCall.run(true, () => original(new Request(request, { headers, body: JSON.stringify({ ...(body as Record<string, unknown>), model }), signal: AbortSignal.any([searchSignal, AbortSignal.timeout(30_000)]) })))
          const checked = await nativeSearchResponse(response, searchSignal)
          nativeAttempt = checked.response
          observe?.({ phase: 'search', stage: 'claude', status: checked.ok ? 'success' : 'unavailable' })
          return checked.ok
        }
        // Native Claude is already the selected provider, so it occupies step1.
        if (!routed) {
          try { if (await claude()) return nativeAttempt! } catch (error) { failedClaude(error) }
        }
        try {
          const found = await providerCall.run(true, () => directSearch(wire, native, query, remoteOf(config, native.req.target), searchSignal, direct, observe))
          await nativeAttempt?.body?.cancel()
          const events = { async *[Symbol.asyncIterator]() { yield* found } }
          return await providerResponse(native.model, nativeContracts(events, native.req.native), signal, () => controller.abort(), native.stream)
        } catch { request.signal.throwIfAborted() }
        if (routed) {
          try { if (await claude()) return nativeAttempt! } catch (error) { failedClaude(error) }
        }
        return nativeAttempt ?? nativeFailure('rice-multi-models: provider search, configured services and native Claude search are unavailable; run /rice-models search setup')
      }
      // Run every iterator continuation under the bypass scope, including asynchronous provider fetches.
      const events = {
        async *[Symbol.asyncIterator]() {
          if (native.serverTools.length) throw new Error('native server tool requires a direct implementation')
          const iterator = providerCall.run(true, () => nativeContracts(direct(wire, signal), native.req.native)[Symbol.asyncIterator]())
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
      const reason = /^(native inference has no verified conversation owner|native tool addition has no verified definition|invalid native [a-z ]+|unsupported native [a-z ]+|native provider configuration [a-z ]+|native server tool requires a direct implementation)$/.test(message) ? message : 'adapter-request-failed'
      observe?.({ phase: 'refused', reason, ownerKnown: !owner.unowned && !!owner.model, scoped: scope !== undefined, nativeState: state !== undefined,
        fields: record(body) ? Object.keys(body).filter(key => /^[a-z_]+$/.test(key)) : [],
        messages: record(body) && Array.isArray(body.messages) ? body.messages.slice(0, 20).map(message => record(message) ? {
          role: ['user', 'assistant', 'system', 'developer'].includes(String(message.role)) ? message.role : 'unknown',
          contentKind: Array.isArray(message.content) ? 'array' : typeof message.content,
          blocks: Array.isArray(message.content) ? message.content.slice(0, 12).map(block => record(block) ? typeof block.type === 'string' && /^[a-z_0-9]+$/.test(block.type) ? block.type : Object.keys(block).filter(key => /^[a-z_]+$/.test(key)) : typeof block) : [],
          toolChanges: Array.isArray(message.content) ? message.content.filter(block => record(block) && ['tool_addition', 'tool_removal'].includes(String(block.type))).slice(0, 12).map(block => {
            const tool = record(block.tool) ? block.tool : undefined
            return { kind: tool?.type === 'tool_reference' || tool?.type === 'tool_definition' ? tool.type : 'unknown',
              schemaInRequest: record(body) && Array.isArray(body.tools) && body.tools.some(value => record(value) && value.name === tool?.name),
              inlineSchema: record(tool?.definition) && record(tool.definition.input_schema) }
          }) : [],
        } : { kind: typeof message }) : [] })
      return nativeFailure()
    }
  }
}
