import type { Target } from '../../hooks/config.ts'
import type { WebSearch, StepEvent, StepWire } from '../../hooks/protocol.ts'
import { splitTarget } from '../../hooks/protocol.ts'
import { createKeys } from '../styx/auth.ts'
import { runCommand } from '../core/subprocess.ts'
import { searchRecords, SearchUnavailable } from './endpoints.ts'

type Remote = Pick<Extract<Target, { kind: 'remote' }>, 'provider' | 'model' | 'target'>
const keys = createKeys(runCommand, Date.now)

/** A compatible inference API alone never establishes hosted search support. */
export function providerSearch(target: string, remote: Remote | undefined, restrictions: WebSearch): 'hosted' | 'ollama' | undefined {
  if (!remote) return splitTarget(target)?.provider === 'codex' && !restrictions.blockedDomains?.length ? 'hosted' : undefined
  if (remote.model.webSearch === 'off') return undefined
  const url = new URL(remote.provider.baseUrl)
  if (url.origin === 'https://ollama.com' && remote.provider.auth !== 'none') return 'ollama'
  const kind = remote.model.kind
  if (!['responses', 'anthropic', 'gemini'].includes(kind)) return undefined
  if (kind === 'gemini' && (restrictions.maxUses !== undefined || restrictions.allowedDomains?.length || restrictions.blockedDomains?.length || restrictions.location)) return undefined
  if (remote.model.webSearch === 'native') return 'hosted'
  return kind === 'responses' && url.origin === 'https://api.openai.com'
    || kind === 'anthropic' && url.origin === 'https://api.anthropic.com'
    || kind === 'gemini' && url.origin === 'https://generativelanguage.googleapis.com' ? 'hosted' : undefined
}

/** Ollama local inference never borrows a cloud key. Only this selected cloud account can search. */
export async function ollamaSearch(wire: StepWire, remote: Remote, query: string, signal: AbortSignal): Promise<StepEvent[]> {
  const credential = await keys.get(remote.provider, new Set(wire.approved))
  if ('error' in credential || !credential.key) throw new SearchUnavailable('Selected Ollama cloud account has no search credential.')
  const response = await fetch('https://ollama.com/api/web_search', {
    method: 'POST', headers: { authorization: `Bearer ${credential.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, max_results: 10 }), redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  })
  if (!response.ok) { const status = response.status; await response.body?.cancel(); throw new SearchUnavailable(`Selected Ollama search HTTP ${status}.`) }
  const reader = response.body?.getReader()
  if (!reader) throw new SearchUnavailable('Selected Ollama search has no response.')
  const chunks: Uint8Array[] = []; let size = 0
  try {
    while (true) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > 2 * 1024 * 1024) throw new SearchUnavailable('Selected Ollama search response exceeds its size limit.'); chunks.push(item.value) }
  } finally { await reader.cancel() }
  const sources = searchRecords(JSON.parse(Buffer.concat(chunks).toString('utf8')), 'searxng')
  return [{ type: 'search_sources', searched: true, sources }, { type: 'stop', reason: 'end_turn' }]
}
