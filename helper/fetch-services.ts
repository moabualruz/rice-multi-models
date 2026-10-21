import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MAX_FETCH_CONFIG_BYTES, orderedFetchEndpoints, parseFetchConfig } from '../hooks/fetch-config.ts'
import type { FetchEndpoint } from '../hooks/fetch-config.ts'
import { runCommand } from './core/subprocess.ts'

export type FetchedPage = { url: string; content: string; contentType: string; status: number }
export class FetchServiceUnavailable extends Error {}
export type FetchAttempt = { name: string; status: 'unavailable' | 'success'; http?: number }
type Request = (url: URL, init: RequestInit) => Promise<Response>

export function fetchEndpoints(environment: NodeJS.ProcessEnv = process.env): FetchEndpoint[] {
  const file = join(environment.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'rice-multi-models/fetch.json')
  let text: string | undefined
  try {
    if (statSync(file).size > MAX_FETCH_CONFIG_BYTES) throw new FetchServiceUnavailable('Fetch configuration exceeds its size limit.')
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new FetchServiceUnavailable('Cannot read fetch configuration; check /rice-models fetch setup.')
  }
  const parsed = parseFetchConfig(text)
  if (parsed.errors.length) throw new FetchServiceUnavailable('Invalid fetch configuration; check /rice-models fetch setup.')
  return orderedFetchEndpoints(parsed.config)
}

async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new FetchServiceUnavailable('Fetch service returned no response body.')
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > 2 * 1024 * 1024) throw new FetchServiceUnavailable('Fetch service response exceeds its size limit.')
      chunks.push(part.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally { await reader.cancel().catch(() => {}) }
}

function page(value: unknown, requested: string, status: number): FetchedPage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new FetchServiceUnavailable('Fetch service returned an invalid page.')
  const row = value as Record<string, unknown>
  if (Object.keys(row).some(key => !['url', 'content', 'contentType'].includes(key)) || row.url !== requested || typeof row.content !== 'string'
    || new TextEncoder().encode(row.content).byteLength > 10 * 1024 * 1024 || row.contentType !== undefined && typeof row.contentType !== 'string') throw new FetchServiceUnavailable('Fetch service returned an invalid or oversized page.')
  return { url: requested, content: row.content, contentType: typeof row.contentType === 'string' ? row.contentType.slice(0, 128).toLowerCase() : 'text/plain', status }
}

/** Each service receives only its own credential. Redirects and response bodies are bounded. */
export async function fetchFromService(endpoint: FetchEndpoint, url: string, signal: AbortSignal, request: Request = fetch, environment: NodeJS.ProcessEnv = process.env): Promise<FetchedPage> {
  let key: string | undefined
  if (endpoint.auth) {
    if ('env' in endpoint.auth) key = environment[endpoint.auth.env]
    else {
      const helper = await runCommand(endpoint.auth.command, 15_000)
      if (helper.exitCode === 0 && helper.stdout.length <= 16 * 1024) key = helper.stdout.trim()
    }
    if (!key || /[\0\r\n]/.test(key)) throw new FetchServiceUnavailable('Fetch service credential is unavailable.')
  }
  const headers = new Headers({ accept: 'application/json', 'content-type': 'application/json' })
  if (key) headers.set('authorization', `Bearer ${key}`)
  let response: Response
  try {
    response = await request(new URL(endpoint.url), { method: 'POST', headers, body: JSON.stringify({ url, maxBytes: 10 * 1024 * 1024 }), redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) })
  } catch { signal.throwIfAborted(); throw new FetchServiceUnavailable('Fetch service request failed.') }
  if (!response.ok) {
    const status = response.status
    await response.body?.cancel()
    throw Object.assign(new FetchServiceUnavailable(`Fetch service HTTP ${status}.`), { status })
  }
  return page(await readJson(response), url, response.status)
}

/** Services are serial and stable by priority. A valid empty page is success. */
export async function configuredFetch(url: string, signal: AbortSignal, endpoints = fetchEndpoints(), request: Request = fetch,
  observe?: (attempt: FetchAttempt) => void, environment: NodeJS.ProcessEnv = process.env): Promise<FetchedPage> {
  for (const endpoint of endpoints) {
    try {
      const result = await fetchFromService(endpoint, url, signal, request, environment)
      observe?.({ name: endpoint.name, status: 'success', http: result.status })
      return result
    } catch (error) {
      signal.throwIfAborted()
      observe?.({ name: endpoint.name, status: 'unavailable', ...((error as { status?: number }).status ? { http: (error as { status: number }).status } : {}) })
    }
  }
  throw new FetchServiceUnavailable('No configured fetch service is available.')
}
