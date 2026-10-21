import { splitTarget } from './protocol'
import type { WebSearch } from './protocol'

type SearchRemote = {
  provider: { baseUrl: string; auth: unknown }
  model: { kind: string; webSearch?: 'auto' | 'native' | 'off' }
}

export const DEFAULT_WEB_SEARCH_MAX_USES = 8
export type NativeSearchMethod = 'hosted' | 'ollama'
export type NativeSearchDecision = { method?: NativeSearchMethod; recognized: boolean; reason: string; constraints: string[] }

const unavailable = (recognized: boolean, reason: string, constraints: string[] = []): NativeSearchDecision => ({ recognized, reason, constraints })

/** One contract owner for the search router and read-only doctor diagnostics. */
export function nativeSearchDecision(target: string, remote: SearchRemote | undefined, restrictions: WebSearch): NativeSearchDecision {
  if (!remote) {
    if (splitTarget(target)?.provider !== 'codex') return unavailable(false, 'No provider-native web search contract is implemented for this route.')
    const constraints = [
      ...(restrictions.maxUses === undefined ? [] : ['Codex cannot enforce a maximum number of search uses before making its provider call.']),
      ...(restrictions.blockedDomains?.length ? ['Codex cannot enforce blocked-domain filtering before its provider call.'] : []),
    ]
    return constraints.length
      ? unavailable(true, 'The Codex subscription search contract is recognized, but requested restrictions require a later tier.', constraints)
      : { method: 'hosted', recognized: true, reason: 'The selected Codex subscription has a recognized hosted web search route.', constraints: [] }
  }
  if (remote.model.webSearch === 'off') return unavailable(false, 'Provider web search is explicitly disabled.')
  let url: URL
  try { url = new URL(remote.provider.baseUrl) } catch { return unavailable(false, 'The selected provider endpoint is not a valid URL.') }
  if (url.origin === 'https://ollama.com' && remote.provider.auth !== 'none') {
    return { method: 'ollama', recognized: true, reason: 'The selected Ollama cloud endpoint has its own configured search route.', constraints: [] }
  }
  const kind = remote.model.kind
  if (!['responses', 'anthropic', 'gemini'].includes(kind)) return unavailable(false, `No native web search contract is implemented for the ${kind} transport.`)
  const constraints = kind === 'gemini'
    ? [
      ...(restrictions.maxUses === undefined ? [] : ['Gemini grounding cannot enforce a maximum number of search uses.']),
      ...(restrictions.allowedDomains?.length ? ['Gemini grounding cannot enforce an allowed-domain filter.'] : []),
      ...(restrictions.blockedDomains?.length ? ['Gemini grounding cannot enforce a blocked-domain filter.'] : []),
      ...(restrictions.location ? ['Gemini grounding cannot enforce a search location.'] : []),
    ]
    : []
  if (constraints.length) return unavailable(true, 'The native search contract is recognized, but requested restrictions require a later tier.', constraints)
  if (remote.model.webSearch === 'native') return { method: 'hosted', recognized: true, reason: 'Native web search was explicitly enabled for this provider model.', constraints: [] }
  const official = kind === 'responses' && url.origin === 'https://api.openai.com'
    || kind === 'anthropic' && url.origin === 'https://api.anthropic.com'
    || kind === 'gemini' && url.origin === 'https://generativelanguage.googleapis.com'
  return official
    ? { method: 'hosted', recognized: true, reason: `The selected ${kind} endpoint has a recognized native web search contract.`, constraints: [] }
    : unavailable(false, 'This compatible endpoint has no explicitly configured native web search capability.')
}
