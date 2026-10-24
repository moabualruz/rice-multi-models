// Exact-model selection through the Agent tool's `model` argument.
//
// The engine accepts only `fable`, `haiku`, `opus` and `sonnet` there, and checks the argument after the plugin's
// `tool.call` hook ran. The hook sees the raw argument first, so a call naming an exact id this session can run
// is carried: `tool.call` records the id under the call's tool_use_id and hands the engine a valid value
// (CARRIER_VALUE) and adds a visible exact-model note to the description; `agent.spawn` takes the id back, removes the
// mark and the subagent runs on exactly that id. A marked spawn with no record is refused, never run as the carrier's
// tier (an unmarked `haiku` is the engine's own request and passes). Pure: state in and out.
import type { ModelCatalogue } from './catalogue'
import { NATIVE_ALIASES } from './family'
import type { Loaded } from './providers'

export const AGENT_TOOL = 'Agent'
/** A value of the engine's own enum that stands in for the exact id while the engine checks the call. */
export const CARRIER_VALUE = 'haiku'
const PLUGIN = 'rice-multi-models'
/** A visible note distinguishes a lost carried call from a real haiku and makes approval/transcript text truthful. */
export const CARRIER_MARK = ` [${PLUGIN}: exact Agent model `
const CARRIER_END = `; ${CARRIER_VALUE} is validation only]`
export const markDescription = (description: unknown, id: string): string => `${typeof description === 'string' ? description : ''}${CARRIER_MARK}${JSON.stringify(id)}${CARRIER_END}`
export function unmarkDescription(description: string): { text: string; marked: boolean } {
  const start = description.lastIndexOf(CARRIER_MARK)
  return start >= 0 && description.endsWith(CARRIER_END) ? { text: description.slice(0, start), marked: true } : { text: description, marked: false }
}
/** Records kept per session; calls remove their own, so only abandoned ones (a hot reload) ever reach this. */
const MAX_ENTRIES = 128
const DENIAL_LIST_LIMIT = 60
const DESCRIPTION_LIST_LIMIT = 30
/** Above this many ids the schema keeps a plain string instead of an enum, so the list does not ride on every request. */
export const SCHEMA_ENUM_LIMIT = 200
export const DESCRIPTION_MARK = `[${PLUGIN}] The model parameter also takes`

/** What a call recorded: the exact id its spawn runs. */
export type CarrierEntry = { toolUseId: string; kind: 'exact'; at: number; id: string }
export type CarrierState = { readonly entries: readonly CarrierEntry[] }
export const emptyCarrier: CarrierState = { entries: [] }

/** Every exact id a call may name: discovered models of fresh providers, declared models and declared aliases. */
export function exactModelIds(catalogue: ModelCatalogue, loaded: Loaded): string[] {
  const fresh = new Set(catalogue.providers.filter(provider => provider.status === 'fresh').map(provider => provider.provider))
  const ids = new Set<string>()
  for (const entry of catalogue.models) {
    const slash = entry.model.indexOf('/')
    if (entry.execution === 'native provider' && slash > 0 && entry.model.length > slash + 1 && fresh.has(entry.model.slice(0, slash))) ids.add(entry.model)
  }
  for (const provider of Object.values(loaded.config?.providers ?? {})) {
    for (const model of Object.keys(provider.models)) ids.add(`${provider.id}/${model}`)
  }
  for (const alias of Object.keys(loaded.config?.aliases ?? {})) ids.add(alias)
  return [...ids].sort()
}

export type CallVerdict =
  | { kind: 'pass' }
  | { kind: 'carry'; id: string }
  | { kind: 'deny'; reason: string }

const listed = (ids: readonly string[], limit: number): string => ids.length <= limit ? ids.join(', ') : `${ids.slice(0, limit).join(', ')} and ${ids.length - limit} more (/rice-models models lists them)`

/** What a raw Agent `model` argument asks for. */
export function classifyCall(model: unknown, ids: readonly string[]): CallVerdict {
  if (typeof model !== 'string' || model === '') return { kind: 'pass' }
  if ((NATIVE_ALIASES as readonly string[]).includes(model)) return { kind: 'pass' }
  if (ids.includes(model)) return { kind: 'carry', id: model }
  const valid = [...NATIVE_ALIASES, ...ids]
  return { kind: 'deny', reason: `${PLUGIN}: Agent model "${model}" is not a model this session can run, so no subagent was started. Valid values: ${listed(valid, DENIAL_LIST_LIMIT)}.` }
}

const prune = (entries: readonly CarrierEntry[], toolUseId: string): CarrierEntry[] => entries.filter(entry => entry.toolUseId !== toolUseId)

export function recordEntry(state: CarrierState, entry: CarrierEntry): CarrierState {
  const kept = [...prune(state.entries, entry.toolUseId), entry]
  return { entries: kept.slice(Math.max(0, kept.length - MAX_ENTRIES)) }
}

export function forgetEntry(state: CarrierState, toolUseId: string): CarrierState {
  return state.entries.some(entry => entry.toolUseId === toolUseId) ? { entries: prune(state.entries, toolUseId) } : state
}

export const entryOf = (state: CarrierState, toolUseId: string): CarrierEntry | undefined => toolUseId === '' ? undefined : state.entries.find(entry => entry.toolUseId === toolUseId)

export type SpawnPick = { requested: string | undefined; exact?: string } | { deny: string }

/**
 * The `model` a spawn decides from. An exact record wins; a carrier-valued spawn with no record is refused (it
 * would otherwise run as the carrier's tier); a fork inherits its parent, so an exact id on one is refused.
 */
export function pickRequested(entry: CarrierEntry | undefined, model: string | undefined, fork: boolean, marked: boolean): SpawnPick {
  if (entry !== undefined) {
    if (fork) return { deny: `${PLUGIN}: a fork runs on its parent's model, so the Agent model "${entry.id}" cannot be applied; name a subagent_type to run on it. No subagent was started.` }
    return { requested: entry.id, exact: entry.id }
  }
  if (marked) {
    return { deny: `${PLUGIN}: this Agent call's exact model could not be recovered (no record for it), so it was not run as ${CARRIER_VALUE}. Retry with an exact model id. No subagent was started.` }
  }
  return { requested: model }
}

/** The Agent schema a routed model sees: the engine's `model` enum plus the exact ids. */
export function widenAgentSchema(schema: Record<string, unknown>, ids: readonly string[]): Record<string, unknown> {
  const properties = schema['properties']
  if (ids.length === 0 || typeof properties !== 'object' || properties === null || Array.isArray(properties)) return schema
  const model = (properties as Record<string, unknown>)['model']
  if (typeof model !== 'object' || model === null || Array.isArray(model)) return schema
  const current = (model as Record<string, unknown>)['enum']
  if (!Array.isArray(current)) return schema
  const { enum: _enum, ...rest } = model as Record<string, unknown>
  const widened = ids.length > SCHEMA_ENUM_LIMIT ? rest : { ...rest, enum: [...new Set([...current, ...ids])] }
  return { ...schema, properties: { ...properties, model: widened } }
}

/** The short statement appended to the Agent tool's description; empty when nothing is discovered. */
export function descriptionSuffix(ids: readonly string[]): string {
  if (ids.length === 0) return ''
  return `\n\n${DESCRIPTION_MARK} an exact provider/model id from this session, which runs the subagent on exactly that model with no tier mapping: ${listed(ids, DESCRIPTION_LIST_LIMIT)}. Any other id is refused with the valid ones.`
}

export const withDescriptionSuffix = (description: string, ids: readonly string[]): string => description.includes(DESCRIPTION_MARK) ? description : `${description}${descriptionSuffix(ids)}`

/** Presentation only. Never rewrite an agent's address/type or turn an exact model into a tier. */
export function agentLabel(description: string, model: string, effort?: string | number): string {
  const line = (value: string) => value.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim()
  const label = `(${line(model).slice(0, 200)}${effort === undefined ? '' : ` ${line(String(effort)).slice(0, 40)}`})`
  return description.endsWith(label) ? description : `${description} ${label}`.trim()
}
