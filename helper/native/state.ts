import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ModelCatalogue } from '../../hooks/catalogue.ts'
import { runtimeConfig } from '../../hooks/catalogue-runtime.ts'
import { CONFIG_FILE, emptyLoaded, loadText, remoteOf } from '../../hooks/providers.ts'
import { splitTarget } from '../../hooks/protocol.ts'
import type { Transport } from '../../hooks/protocol.ts'
import { nativeAlias, record } from './ownership.ts'
import { discoverProviders } from '../provider-catalog.ts'

export const STATE_ENV = 'RICE_MULTI_MODELS_NATIVE_STATE'
export const ACTIVE_ENV = 'RICE_MULTI_MODELS_NATIVE_ACTIVE'
export const ADAPTER_VERSION = '1'

/** --plugin-dir loads this manifest as rice-multi-models@inline in the pinned host. */
export function approvalStore(configDir: string): string {
  const id = 'rice-multi-models@inline'
  return join(configDir, 'plugins/store', `rice-multi-models_inline-${createHash('sha256').update(id).digest('hex').slice(0, 12)}.json`)
}

export function resumedModel(args: readonly string[], configDir: string): string | undefined {
  const index = args.indexOf('--resume')
  const id = index >= 0 ? args[index + 1] : args.find(arg => arg.startsWith('--resume='))?.slice('--resume='.length)
  if (!id || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) return undefined
  try {
    const store: unknown = JSON.parse(readFileSync(approvalStore(configDir), 'utf8'))
    const owner = record(store) ? store[`native-session:${id}`] : undefined
    return record(owner) && owner.version === 1 && typeof owner.model === 'string' && owner.model.length <= 1024 ? owner.model : undefined
  } catch (error) {
    if (record(error) && error.code === 'ENOENT') return undefined
    throw new Error('native session ownership could not be read')
  }
}

/** Startup compaction precedes session.start. Read the same native store, never a parent's snapshot. */
export function nativeApprovals(state?: NativeState): string[] {
  if (state) return state.approved
  const directory = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  try {
    const grants: unknown = JSON.parse(readFileSync(approvalStore(directory), 'utf8'))
    if (!record(grants)) throw new Error('invalid store')
    return Object.entries(grants).filter(([key, value]) => key.startsWith('trust:') && value === true).map(([key]) => key.slice('trust:'.length))
  } catch (error) {
    if (record(error) && error.code === 'ENOENT') return []
    throw new Error('native provider approvals could not be read')
  }
}

export async function nativeWireConfig(target: string, state: NativeState | undefined, approved: string[], signal: AbortSignal) {
  const source = nativeConfig(state)
  if (state || remoteOf(source, target) || !source.config) return source
  // A discovered-only selection may also be resumed before hooks load. Reuse the
  // real bounded inventory client; a declaration is never labelled fresh here.
  const catalogue = await discoverProviders({ configText: source.text, approved }, { signal, timeoutMs: 8000 })
  return runtimeConfig(source, catalogue)
}

/** Only routing metadata crosses this boundary. Credentials stay in the direct clients. */
export type NativeState = {
  version: 1
  model: string
  session: string
  configPath: string
  approved: string[]
  catalogue: ModelCatalogue
  agents: Record<string, string>
  routedModels?: string[]
  transport?: Transport
}

export function nativeState(env: NodeJS.ProcessEnv = process.env): NativeState | undefined {
  const value = env[STATE_ENV]
  if (!value) return undefined
  try {
    const state: unknown = JSON.parse(value)
    if (!record(state) || state.version !== 1 || typeof state.model !== 'string' || typeof state.session !== 'string'
      || typeof state.configPath !== 'string' || !Array.isArray(state.approved) || !state.approved.every(id => typeof id === 'string')
      || !record(state.catalogue) || !Array.isArray(state.catalogue.models) || !Array.isArray(state.catalogue.providers) || !record(state.agents)
      || !Object.values(state.agents).every(model => typeof model === 'string')
      || state.transport !== undefined && !['auto', 'ws', 'sse'].includes(String(state.transport))
      || state.routedModels !== undefined && (!Array.isArray(state.routedModels) || !state.routedModels.every(model => typeof model === 'string'))) return undefined
    return state as NativeState
  } catch { return undefined }
}

export function nativeConfig(state?: NativeState) {
  const path = state?.configPath ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), CONFIG_FILE)
  let source = emptyLoaded(path)
  try { source = loadText(path, readFileSync(path, 'utf8')) } catch (error) {
    if (!record(error) || error.code !== 'ENOENT') throw new Error('native provider configuration could not be read')
  }
  // An invalid unrelated remote declaration must not disable the built-in Codex client.
  // loadText already drops invalid text; unresolved configured targets still fail closed.
  if (source.errors.length) return source
  return state ? runtimeConfig(source, state.catalogue) : source
}

export function nativeInputBound(config: ReturnType<typeof nativeConfig>, target: string, state?: NativeState): number | null {
  const remote = remoteOf(config, target)
  if (remote) return remote.budget
  const provider = splitTarget(target)?.provider
  if (!provider || !state?.catalogue.providers.some(entry => entry.provider === provider && entry.status === 'fresh')) return null
  const metadata = state.catalogue.models.find(entry => entry.model === target)?.metadata
  if (!metadata) return null
  const limits = [metadata.inputTokenLimit, metadata.contextWindow ?? metadata.maxContextWindow].filter((value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
  return limits.length ? Math.min(...limits) : null
}

export function routedNativeModel(model: string | undefined, state?: NativeState): boolean {
  if (!model) return false
  const split = splitTarget(model)
  if (split && ['codex', 'agy', 'grok'].includes(split.provider)) return true
  if (state?.routedModels?.includes(model)) return true
  if (nativeAlias(model)) return false
  if (split && split.provider !== 'native') return true
  return remoteOf(nativeConfig(state), model) !== undefined
}
