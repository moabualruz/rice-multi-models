import { splitTarget } from './protocol'

type SearchRemote = {
  provider: { baseUrl: string; auth: unknown }
  model: { kind: string; webSearch?: 'auto' | 'native' | 'off' }
}

export type NativeSearchMethod = 'hosted' | 'ollama'
export type NativeSearchDecision = { method?: NativeSearchMethod; recognized: boolean; reason: string }

const unavailable = (recognized: boolean, reason: string): NativeSearchDecision => ({ recognized, reason })

/** One contract owner for the search router and read-only doctor diagnostics. */
export function nativeSearchDecision(target: string, remote: SearchRemote | undefined): NativeSearchDecision {
  if (!remote) {
    if (splitTarget(target)?.provider !== 'codex') return unavailable(false, 'No provider-native web search contract is implemented for this route.')
    return { method: 'hosted', recognized: true, reason: 'The selected Codex subscription has a recognized hosted web search route.' }
  }
  if (remote.model.webSearch === 'off') return unavailable(false, 'Provider web search is explicitly disabled.')
  let url: URL
  try { url = new URL(remote.provider.baseUrl) } catch { return unavailable(false, 'The selected provider endpoint is not a valid URL.') }
  if (url.origin === 'https://ollama.com' && remote.provider.auth !== 'none') {
    return { method: 'ollama', recognized: true, reason: 'The selected Ollama cloud endpoint has its own configured search route.' }
  }
  const kind = remote.model.kind
  if (!['responses', 'anthropic', 'gemini'].includes(kind)) return unavailable(false, `No native web search contract is implemented for the ${kind} transport.`)
  if (remote.model.webSearch === 'native') return { method: 'hosted', recognized: true, reason: 'Native web search was explicitly enabled for this provider model.' }
  const official = kind === 'responses' && url.origin === 'https://api.openai.com'
    || kind === 'anthropic' && url.origin === 'https://api.anthropic.com'
    || kind === 'gemini' && url.origin === 'https://generativelanguage.googleapis.com'
  return official
    ? { method: 'hosted', recognized: true, reason: `The selected ${kind} endpoint has a recognized native web search contract.` }
    : unavailable(false, 'This compatible endpoint has no explicitly configured native web search capability.')
}
