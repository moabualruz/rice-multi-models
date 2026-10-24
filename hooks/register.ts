// rice-multi-models: non-Anthropic models as session and subagent models. A model id `codex/<slug>` set with
// /model, --model or an agent's `model:` is answered here: the request is built from the engine's own
// transcript, system prompt and tools, the shipped Node helper (dist/helper.mjs) calls
// the provider, and its stream comes back as the engine's own chunks. Claude models pass through untouched.
import { atom, read, update } from 'claude-code'
import type { AgentDisplay, AgentModelOwner, CompactionReceipt } from '../types'
import type { EngineInterface, ModelCompleteResult, ModelUsage, Origin, Register, ToolCallResult, TurnStepChunk, TurnStepInput, TurnStepResult } from 'claude-code'

import { AGENT_TOOL, CARRIER_VALUE, agentLabel, classifyCall, emptyCarrier, entryOf, exactModelIds, forgetEntry, markDescription, pickRequested, recordEntry, unmarkDescription, withDescriptionSuffix } from './agent-model'
import { BUILTIN_AGENTS, HANDBACK_TOOL, identityLine, isFork, toolFilter } from './agents'
import type { AgentDef } from './agents'
import { requestInputBudget } from './budget'
import { CLAUDE_FAMILY, familyOf, isNativeAlias, spawnDecision, stepModel } from './family'
import type { FamilyPorts, SpawnDecision, TierMap } from './family'
import { permissionContext, permissionIntent } from './permission-intent'
import { collectText, helperStep, preferSession, readyLine, sessionHelper, setSessionHelper } from './backend'
import type { HelperPort } from './backend'
import { carryFor, remember, withCarry } from './carry'
import type { Reasoning } from './carry'
import { CONTINUATION_OFF, continuationSessionPrefix, continuationStatus } from './continuation'
import type { ContinuationRecord } from './continuation'
import { clearContinuations, continuationRecords, saveContinuation, withContinuationStore } from './continuation-store'
import { persistedCompactSource, retainedTail, withUserText } from './compact'
import type { CompactMessage } from './compact'
import { compactOwner, compactionPolicyBlock, historyContains, historyDigest, observedReceipt, putReceipt, RECEIPT_TTL_MS, receiptText } from './compaction-receipt'
import { compactionPrompt, fitTranscript, isTemplate, summaryBody, summaryMessage } from './native-compaction'
import type { CompactionTemplate } from './native-compaction'
import { classifierRequest, isClassifyTemplate } from './native-classify'
import type { ClassifyTemplate } from './native-classify'
import { builtinPrompt, isCapture, offeredTools, toolSetKey, toolTable } from './native-tools'
import type { NativeCapture } from './native-tools'
import { createMemory } from './memory'
import { CATALOG_URL, kindCounts, liveIds, opencodeProvider, TIERS } from './opencode'
import type { Tier } from './opencode'
import { catalogueRows } from './picker'
import { NATIVE_MODEL_LIMITATIONS, unknownMetadata } from './catalogue'
import type { ModelCatalogue } from './catalogue'
import { runtimeConfig } from './catalogue-runtime'
import type { PickerRow } from './picker'
import { candidates, discoveryGuidance, limitsReport, modelsReport, withDiscoverySection } from './discovery'
import type { FamilyLine } from './discovery'
import type { CandidateRoute } from './discovery'
import { approvalQuestion, CONFIG_FILE, emptyLoaded, loadText, providerLines, remoteOf, TRUST_PREFIX } from './providers'
import type { Loaded, Remote } from './providers'
import { contested, definitionOf, rewriteMain, systemFor, withIdentity } from './prompts'
import type { PromptsPort } from './prompts'
import { splitTarget } from './protocol'
import type { ApiMessage, Effort, Limits, RemoteTool, StepRequest, StepWire, Transport } from './protocol'
import { fingerprint } from './config'
import { capabilityContracts, formatCapabilityContracts, selectTools, toolCoverageWarning } from './capability-contract'
import { STAMP } from './schemas.gen'
import { createAssembler } from './step'
import { redact } from './redact'
import { setCapped } from './util'
import { remoteTools } from './tools'
import type { Described } from './tools'
import { handbackState, withTask } from './transcript'
import { commandText, detectRuntime as probeRuntime, helperFile, setupSummary, startupNotice as publishNotice, syncPicker as synchronizePicker } from './setup'
import type { PickerResult, Runtime } from './setup'
import { searchConfigurationCommand } from './search-config'
import type { SearchConfigurationResult, SearchEdit } from './search-config'
import { fetchProviderProtocol, fetchTierConfigState } from './fetch-config'
import type { FetchConfigMetadata } from './fetch-config'
import { webSearchStatus } from './web-search-status'
import { DEFAULT_WEB_SEARCH_MAX_USES } from './web-search-tier'
import { runNativeSearch } from './native-search'
import { NativeFetchUnavailable, runNativeFetch } from './native-fetch'
import { runFinalNativeFetch } from './web-fetch-fallback'
import type { ToolSearchOutcome } from '../helper/search/tool-search'
import type { WebFetchOutcome } from '../helper/web-fetch'
import { createToolGate } from './tool-gate'
import type { PublicWebSearchInput } from './web-search'
import type { PublicWebFetchInput } from './web-fetch'
import { CLASSIFIER_ONLY_TOOLS, eligiblePermission, permissionAnswer, permissionRequest, resolvePermissionPolicy } from './permission'
import { consumePermissionContext } from './permission-context'
import { fallbackTitle, titleAnswer, titleRequest } from './titles'
import { registerEvaluators } from './evaluator-runtime'
import type { EvaluatorCapacityPort } from './evaluator-runtime'
import { createEvaluatorSources, registerEvaluatorSources } from './evaluator-sources'

const PLUGIN = 'rice-multi-models'
/** Who the requests to declared providers say they come from (OpenCode Go asks each client to name itself). */
const USER_AGENT = 'rice-multi-models/0.17.0 (claude-code)'
const PROVIDERS: Readonly<Record<string, string>> = { codex: 'OpenAI Codex (ChatGPT subscription)' }
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const prefsAtom = atom({ plugin: 'rice-multi-models', key: 'prefs' } as const, { effort: null, transport: 'auto', helper: 'session' })
/** Exact Agent model ids carried from a call's tool.call to its agent.spawn (see agent-model.ts), by tool_use_id; host state, so a hot reload keeps it. */
const carrierAtom = atom({ plugin: 'rice-multi-models', key: 'agent-model-carrier' } as const, emptyCarrier)
const ownersAtom = atom({ plugin: 'rice-multi-models', key: 'agent-model-owners' } as const, { entries: [] as readonly AgentModelOwner[] })
const childFailuresAtom = atom({ plugin: 'rice-multi-models', key: 'child-failures' } as const, { entries: [] as readonly { agentId: string; turnId: string; report: string }[] })
const agentDisplayAtom = atom({ plugin: 'rice-multi-models', key: 'agent-display' } as const, { entries: [] as readonly AgentDisplay[] })
const receiptsAtom = atom({ plugin: 'rice-multi-models', key: 'compaction-receipts' } as const, { entries: [] as readonly CompactionReceipt[] })
/** The main transcript's file, as the engine's classic hooks name it; a compaction cites it in its summary message. */
const transcriptAtom = atom({ plugin: 'rice-multi-models', key: 'transcript' } as const, { path: null })

const memory = createMemory()
const described = new Map<string, Described>()
/** The model each subagent loop last ran on, for its compaction. */
const agentModels = new Map<string, string>()
const webToolGate = createToolGate()
const toolModes = new Map<string, { mode?: string; agentId?: string }>()
let permissionDefaults: Promise<unknown> | undefined
let permissionContextNonce = ''
let loadedPermissionContext: string | undefined
/** Whether the loaded context includes instruction files (CLAUDE.md and its kin). */
let loadedInstructionFiles = false
let permissionRevision = 0
/** Agent definitions observed from Claude Code or user plugins, by their full type name. */
const registered = new Map<string, AgentDef>()
let runtime: Runtime = {}
let helperSupervision: Promise<void> | undefined
let helperReadiness: Promise<void> | undefined
let codexDefaults: { model?: string; effort?: Effort } = {}
let limits: Limits | undefined
let lastStep: { model: string; who: string; ms: number; transport: string } | undefined
/** The main model last recorded for this session, so a resume on another model can say so once. */
let recordedMainModel: string | undefined
const LAST_MODELS = 'last-main-models'
/** How each spawned agent's model was decided, by its agent id. */
const spawnDecisions = new Map<string, SpawnDecision>()
let limitsObservedAt: number | undefined
let declared: Loaded = emptyLoaded(CONFIG_FILE)
let loaded: Loaded = declared
let catalogue: ModelCatalogue = { models: [], providers: [] }
let catalogueCheckedAt: number | undefined
let capacityExpiresAt: number | undefined
let catalogueRefresh: Promise<void> | undefined
const CAPACITY_MAX_AGE_MS = 5 * 60_000
let nativeContextSync = Promise.resolve()
let compactionTemplate: Promise<CompactionTemplate> | undefined
/** The installed claude's tool definitions and agent prompts, per combination of the session's built-in tools (toolSetKey). */
const toolCaptures = new Map<string, Promise<NativeCapture>>()
const readyCaptures = new Map<string, NativeCapture>()
/** The last failed capture, which is not retried for a minute (or until /rice-models refresh). */
let toolCaptureFailure: { at: number; error: string } | undefined
const TOOL_CAPTURE_RETRY_MS = 60_000
/** The capture failures already written to the debug log. */
const reportedToolFallbacks = new Set<string>()
/** Whether this session is interactive, as its start said: an interactive session's subagents get the background tool set. */
let interactiveSession: boolean | undefined
/** Whether each spawned agent runs in the background, by its agent id. */
const spawnBackground = new Map<string, boolean>()
/** Workflow agents, which `$.agent.list()` never names: live from their spawn until their `turn.complete`. */
const liveWorkflowAgents = new Map<string, true>()
let seenTranscriptPath: string | undefined

/** Immutable last dispatched routed main request prefix, never reconstructed from current context. */
let mainSnapshot: StepRequest | undefined
let lastContinuationStatus = 'not used'
let continuationExpiredRecords = 0

function activeContext(model: string) {
  const route = splitTarget(model)
  const target = remoteOf(loaded, model)?.target ?? (route ? `${route.provider}/${route.model}` : model)
  const provider = target.slice(0, target.indexOf('/'))
  if (!isRouted(model) || !catalogue.providers.some(entry => entry.provider === provider && entry.status === 'fresh')) return undefined
  return catalogue.models.find(entry => entry.model === target && entry.execution === 'native provider')?.metadata
}

/** The smallest reported window among the routed models running now: the main model and every live subagent. */
async function windowInUse($: EngineInterface): Promise<number | undefined> {
  const models = [await $.session.model()]
  for (const agent of await $.agent.list().catch(() => [])) {
    const model = ['pending', 'running', 'waiting', 'idle'].includes(agent.status) ? agentModels.get(agent.id) : undefined
    if (model) models.push(model)
  }
  for (const id of liveWorkflowAgents.keys()) {
    const model = agentModels.get(id)
    if (model) models.push(model)
  }
  const windows = models.map(model => activeContext(model)?.contextWindow)
    .filter((window): window is number => typeof window === 'number' && Number.isSafeInteger(window) && window > 0)
  return windows.length ? Math.min(...windows) : undefined
}

/**
 * Claude's own accounting and automatic compaction need each model's window, and the public API has no per-model or
 * per-agent registration. The supported process-local CLAUDE_CODE_MAX_CONTEXT_TOKENS is that data: it carries the
 * smallest window among the routed models in use so no loop outgrows its model before Claude compacts it. An owner's
 * explicit override stays authoritative; the mod restores only the value it owns.
 */
async function syncNativeContext($: EngineInterface, restore = false): Promise<void> {
  const sync = nativeContextSync.then(async () => {
    const current = await $.env.get('CLAUDE_CODE_MAX_CONTEXT_TOKENS') ?? null
    const ref = { plugin: 'rice-multi-models', key: 'nativeContext' } as const
    let held = (await $.state.get(ref)).value
    if (!held) {
      held = { original: current, applied: null, relinquished: false }
      await $.state.set(ref, held)
    }
    if (held.relinquished || held.original !== null) return
    if (current !== (held.applied ?? held.original)) {
      await $.state.set(ref, { ...held, applied: null, relinquished: true })
      return
    }
    const window = !restore && runtime.executable && !runtime.error && await $.env.get('DISABLE_COMPACT') === undefined ? await windowInUse($) : undefined
    const desired = window === undefined ? held.original : String(window)
    if ((await $.env.get('CLAUDE_CODE_MAX_CONTEXT_TOKENS') ?? null) !== current) {
      await $.state.set(ref, { ...held, applied: null, relinquished: true })
      return
    }
    if (desired !== current) await $.env.set('CLAUDE_CODE_MAX_CONTEXT_TOKENS', desired ?? undefined)
    try {
      await $.state.set(ref, { ...held, applied: desired })
    } catch (error) {
      if (desired !== current && (await $.env.get('CLAUDE_CODE_MAX_CONTEXT_TOKENS') ?? null) === desired) {
        await $.env.set('CLAUDE_CODE_MAX_CONTEXT_TOKENS', current ?? undefined)
      }
      throw error
    }
  })
  nativeContextSync = sync.catch(() => { $.ui.log(`${PLUGIN}: native context window synchronization unavailable`, { to: 'debug' }) })
  await nativeContextSync
}

function outputLimit(model: string): number {
  const configured = remoteOf(loaded, model)?.model.maxOutputTokens
  const reported = activeContext(model)?.outputTokenLimit
  const bounds = [configured, reported].filter((value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
  return bounds.length ? Math.min(...bounds) : 2048
}

function summaryInputCapacity(model: string, outputReserve = outputLimit(model)): number {
  const configured = remoteOf(loaded, model)?.model
  const metadata = activeContext(model)
  return requestInputBudget({
    contextWindow: configured?.contextWindow ?? metadata?.contextWindow,
    maxContextWindow: metadata?.maxContextWindow,
    inputTokenLimit: configured?.maxInputTokens ?? metadata?.inputTokenLimit,
    outputTokenLimit: outputLimit(model),
  }, { outputReserve })
}

function defaultModel(provider: string): string | undefined {
  const models = catalogue.models.filter(model => model.model.startsWith(`${provider}/`))
  const preferred = provider === 'codex' && codexDefaults.model ? `codex/${codexDefaults.model}` : undefined
  return models.find(model => model.model === preferred)?.model ?? models[0]?.model
}

function tiers(): TierMap {
  return loaded.config?.tiers ?? {}
}

/** The model a family runs on when no conversation of it anchors the choice. */
function familyDefault(family: string): string | undefined {
  const configured = tiers()[family]?.default
  if (configured && isRouted(configured)) return configured
  return defaultModel(family)
}

const familyPorts: FamilyPorts = {
  isRouted: model => isRouted(model),
  providerOf: model => targetOf(model)?.provider,
  defaultModel: family => familyDefault(family),
}

/** Native provider families with a fresh catalogue. */
function routedFamilies(): string[] {
  const fresh = new Set(catalogue.providers.filter(provider => provider.status === 'fresh').map(provider => provider.provider))
  const families = new Set<string>()
  for (const entry of catalogue.models) {
    if (entry.execution !== 'native provider') continue
    const family = entry.model.slice(0, entry.model.indexOf('/'))
    if (family && fresh.has(family)) families.add(family)
  }
  return [...families].sort()
}

function familyLines(): FamilyLine[] {
  const lines: FamilyLine[] = routedFamilies().map(family => ({
    family, label: PROVIDERS[family] ?? family, model: familyDefault(family),
    tiers: Object.fromEntries(Object.entries(tiers()[family] ?? {}).filter(([tier]) => tier !== 'default')),
  }))
  return lines.length ? [...lines, { family: CLAUDE_FAMILY, label: 'Claude (Anthropic)' }] : []
}

async function discoverCapacity(port: EvaluatorCapacityPort): Promise<void> {
  const source = 'session capacity discovery'
  const configured = declared
  if (!runtime.executable || runtime.error) {
    catalogue = { models: [], providers: [{ provider: 'runtime', status: 'unavailable', source, error: 'helper-unavailable' }] }
  } else {
    try {
      const result = await port.run([runtime.executable, port.helper, 'discover'], { stdin: JSON.stringify({ configText: configured.text, approved: port.approved }), timeoutMs: 15_000 })
      if (result.exitCode !== 0 || declared !== configured) throw new Error('helper-failed-or-configuration-changed')
      const snapshot = JSON.parse(result.stdout) as ModelCatalogue
      if (!Array.isArray(snapshot.models) || !Array.isArray(snapshot.providers)) throw new Error('protocol-invalid')
      const now = port.now
      // Discovery is optional, but old or invalid observations cannot inflate capacity.
      catalogue = { ...snapshot, models: snapshot.models.map(entry => Number.isSafeInteger(entry.observedAt) && entry.observedAt <= now + 60_000 && now - entry.observedAt <= CAPACITY_MAX_AGE_MS ? entry : { ...entry, metadata: unknownMetadata() }) }
    } catch {
      catalogue = { models: [], providers: [{ provider: 'runtime', status: 'unavailable', source, error: 'discovery-helper-failed' }] }
    }
  }
  catalogueCheckedAt = port.now
  const expiries = catalogue.models.filter(entry => Number.isSafeInteger(entry.observedAt) && entry.observedAt + CAPACITY_MAX_AGE_MS > port.now).map(entry => entry.observedAt + CAPACITY_MAX_AGE_MS)
  capacityExpiresAt = Math.min(port.now + CAPACITY_MAX_AGE_MS, ...expiries)
  loaded = runtimeConfig(declared, catalogue)
}

async function refreshCatalogue($: EngineInterface): Promise<void> {
  await discoverCapacity({ now: await $.clock.now(), helper: helperFile($.plugin.root), approved: [...await approvedSet($)], run: (argv, options) => $.process.run(argv, options) })
  await syncNativeContext($)
}

async function refreshCapacity(port: EvaluatorCapacityPort): Promise<void> {
  if (catalogueCheckedAt !== undefined && capacityExpiresAt !== undefined && port.now >= catalogueCheckedAt && port.now < capacityExpiresAt) return
  catalogueRefresh ??= discoverCapacity(port).finally(() => { catalogueRefresh = undefined })
  await catalogueRefresh
}

async function ensureFreshCapacity($: EngineInterface): Promise<void> {
  await refreshCapacity({ now: await $.clock.now(), helper: helperFile($.plugin.root), approved: [...await approvedSet($)], run: (argv, options) => $.process.run(argv, options) })
  await syncNativeContext($)
}

/** Engine calls stay in this module; imported setup logic receives plain values and callable ports. */
async function detectRuntime($: EngineInterface): Promise<Runtime> {
  return probeRuntime({
    helper: helperFile($.plugin.root),
    override: await $.env.get('RICE_MULTI_MODELS_NODE'),
    run: (argv, options) => $.process.run(argv, options),
    exists: path => $.fs.exists(path),
  })
}

async function syncPicker($: EngineInterface, current: Runtime, rows: PickerRow[]): Promise<PickerResult> {
  return synchronizePicker({ helper: helperFile($.plugin.root), run: (argv, options) => $.process.run(argv, options) }, current, rows)
}

async function startupNotice($: EngineInterface, interactive: boolean, current: Runtime, picker: PickerResult | undefined, rows: PickerRow[], defaultModel: string | undefined, catalogueSummary?: string, capabilities?: string): Promise<void> {
  return publishNotice({
    get: key => $.store.get(key),
    set: (key, value) => $.store.set(key, value),
    log: text => $.ui.log(text, { to: 'transcript' }),
  }, interactive, current, picker, rows, defaultModel, catalogueSummary ?? catalogue.providers.map(provider => `${provider.provider}: ${provider.status}${provider.error ? ` (${provider.error})` : ''}`).join('; '), capabilities)
}

/** Whether a model name is answered here: a Codex id, or a declared provider's model or alias. */
export function isRouted(model: string | undefined): model is string {
  if (!model) return false
  const target = splitTarget(model)

  return (target !== null && Object.hasOwn(PROVIDERS, target.provider)) || remoteOf(loaded, model) !== undefined
}

/** Why a model this mod's configuration names cannot run, so it is never sent to Claude instead. */
function claimedRefusal(model: string): string | undefined {
  const id: string | undefined = model
  if (isRouted(id)) return undefined
  const claimed = loaded.claimed ?? declared.claimed ?? []
  const slash = model.indexOf('/')
  if (!claimed.includes(model) && !(slash > 0 && claimed.includes(model.slice(0, slash)))) return undefined
  return `${PLUGIN}: ${model} is declared in ${CONFIG_FILE}, which does not validate (${(declared.errors[0] ?? loaded.errors[0] ?? 'unknown error')}); fix it and run /rice-models reload. Nothing was sent.`
}

/** The provider and model a routed name stands for, an alias resolved. */
function targetOf(model: string): { provider: string; model: string; label: string; remote?: Remote } | null {
  const remote = remoteOf(loaded, model)
  if (remote) return { provider: remote.provider.id, model: remote.modelId, label: remote.provider.id, remote }
  const target = splitTarget(model)

  return target ? { ...target, label: PROVIDERS[target.provider] ?? target.provider } : null
}

async function loadProviders($: EngineInterface): Promise<void> {
  const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${(await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''}/.claude`
  const path = `${dir}/${CONFIG_FILE}`
  declared = (await $.fs.exists(path)) ? loadText(path, await $.fs.read(path)) : emptyLoaded(path)
  loaded = runtimeConfig(declared, catalogue)
}

async function approvedSet($: EngineInterface): Promise<Set<string>> {
  const keys = (await $.store.keys()).filter(key => key.startsWith(TRUST_PREFIX))
  const grants = await Promise.all(keys.map(async key => await $.store.get(key) === true ? key.slice(TRUST_PREFIX.length) : undefined))
  return new Set(grants.filter((grant): grant is string => grant !== undefined))
}

/** Undefined once the provider is approved (asked here the first time), else why the step is not sent. */
async function approval($: EngineInterface, remote: Remote): Promise<string | undefined> {
  if ((await approvedSet($)).has(remote.fingerprint)) return undefined
  try {
    const answer = await $.ui.ask(approvalQuestion(remote.provider), { options: ['Allow', 'Keep it off'], header: 'rice-models' })
    if (answer === 'Allow') {
      await $.store.set(`${TRUST_PREFIX}${remote.fingerprint}`, true)

      return undefined
    }

    return `${remote.provider.id} was not approved; nothing was sent`
  } catch {
    return `${remote.provider.id} is not approved yet; run /rice-models approve ${remote.provider.id}. Nothing was sent`
  }
}

/** What the helper gets with a step: the config's text and the approved fingerprints. */
async function wireFor($: EngineInterface, req: StepRequest): Promise<StepWire> {
  const maxTokens = req.native?.maxTokens ?? outputLimit(req.target)
  if (maxTokens > outputLimit(req.target)) throw new Error('The requested output cap exceeds the active model output limit.')
  // Readiness also marks an exhausted supervisor; do not restart it per dispatch.
  if (helperReadiness === undefined) await ensureHelper($)
  return { configText: loaded.text, approved: [...(await approvedSet($))], req: { ...req, native: { ...req.native, maxTokens } }, userAgent: USER_AGENT }
}

function limitsText(): string | undefined {
  if (!limits || limits.windows.length === 0) return undefined

  return `codex ${limits.windows.map(window => `${window.label} ${Math.round(window.usedPercent)}%`).join(' ')}`
}

function promptsPort($: EngineInterface): PromptsPort {
  return {
    compose: async (model, tools) => (await $.prompt.compose({ model, tools })).sections,
    cwd: () => $.session.cwd(),
    configDir: async () => (await $.env.get('CLAUDE_CONFIG_DIR')) || `${(await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''}/.claude`,
    exists: path => $.fs.exists(path),
    read: path => $.fs.read(path),
    listDir: async dir => ((await $.fs.exists(dir)) ? (await $.fs.list(dir)).map(entry => ({ name: entry.name, kind: entry.kind })) : []),
    run: async (argv, options) => {
      try {
        return await $.process.run(argv, { timeoutMs: options?.timeoutMs ?? 10_000 })
      } catch {
        return { exitCode: 127, stdout: '', stderr: '' }
      }
    },
    now: () => $.clock.now(),
    debug: text => $.ui.log(`${PLUGIN}: ${text}`, { to: 'debug' }),
  }
}

function helperPort($: EngineInterface, timeoutMs?: number): HelperPort {
  async function* bounded(argv: string[], input: string) {
    const result = await $.process.run(argv, { stdin: input, timeoutMs: Math.min(timeoutMs!, 600_000) })
    if (result.isStdoutTruncated) throw new Error('routed auxiliary response exceeded the bounded capture size')
    if (result.stdout) yield { stream: 'stdout' as const, text: result.stdout }
    return { code: result.exitCode, signal: null }
  }
  return {
    once: input => {
      if (!runtime.executable || runtime.error) throw new Error(runtime.error || 'Node.js 22+ helper unavailable; /rice-models setup repair')
      return timeoutMs === undefined ? $.process.spawn({ argv: [runtime.executable, helperFile($.plugin.root), 'once'], input }) : bounded([runtime.executable, helperFile($.plugin.root), 'once'], input)
    },
    client: (input, socketPath) => {
      if (!runtime.executable || runtime.error) throw new Error(runtime.error || 'Node.js 22+ helper unavailable; /rice-models setup repair')
      return timeoutMs === undefined ? $.process.spawn({ argv: [runtime.executable, helperFile($.plugin.root), 'client', socketPath], input }) : bounded([runtime.executable, helperFile($.plugin.root), 'client', socketPath], input)
    },
  }
}

/**
 * Keeps the session helper running for the session's life: started here, announced on its standard output,
 * started again when it exits, and given up (one process per step from then on) after three exits within a
 * minute. The loop ends with the module, which ends the helper.
 */
async function superviseHelper($: EngineInterface, announce: () => void): Promise<void> {
  let exits: number[] = []
  while (runtime.executable && !runtime.error) {
    let buffer = ''
    try {
      for await (const piece of $.process.spawn({ argv: [runtime.executable, helperFile($.plugin.root), 'serve'] })) {
        if (piece.stream !== 'stdout' || sessionHelper()) continue
        buffer = (buffer + piece.text).slice(-16_000)
        const ready = readyLine(buffer)
        if (ready) { setSessionHelper(ready); announce() }
      }
    } catch {
      $.ui.log(`${PLUGIN}: the session helper did not start; using the shipped one-shot helper`, { to: 'debug' })
    }
    setSessionHelper(undefined)
    announce()
    const now = await $.clock.now()
    exits = [...exits.filter(at => now - at < 60_000), now]
    if (exits.length >= 3) {
      $.ui.log(`${PLUGIN}: the session helper keeps exiting; each step starts its own helper now`, { to: 'debug' })
      return
    }
    await $.clock.sleep(1_000)
  }
}

/** One supervisor per loaded module; startup waits a bounded time, never for the helper's lifetime. */
async function ensureHelper($: EngineInterface): Promise<void> {
  if (!runtime.executable || runtime.error || (await read($, prefsAtom)).helper === 'once') return
  if (!helperSupervision) {
    let announce: () => void = () => {}
    helperReadiness = new Promise(resolve => { announce = resolve })
    helperSupervision = superviseHelper($, announce).catch(() => { announce() }).finally(() => { helperSupervision = undefined })
  }
  await Promise.race([helperReadiness, $.clock.sleep(1500)])
}

/** The Codex CLI's own defaults: its model and reasoning effort, from config.toml. */
async function readCodexDefaults($: EngineInterface): Promise<{ model?: string; effort?: Effort }> {
  const home = (await $.env.get('CODEX_HOME')) || `${(await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''}/.codex`
  try {
    const text = await $.fs.read(`${home}/config.toml`)
    const top = text.split(/^\[/m)[0] ?? ''
    const model = /^model\s*=\s*"([^"]+)"/m.exec(top)?.[1]
    const effort = /^model_reasoning_effort\s*=\s*"([^"]+)"/m.exec(top)?.[1]

    return { model, effort: EFFORTS.includes(effort as Effort) ? (effort as Effort) : effort === 'ultra' ? 'max' : undefined }
  } catch {
    return {}
  }
}

/**
 * Whose prompt a subagent's step follows: its own agent type's and definition, or for a fork the conversation it
 * forks, the nearest ancestor that is not a fork (no type when that is main).
 */
async function promptOwner($: EngineInterface, agentId: string) {
  const agents = await $.agent.list()
  const agent = agents.find(each => each.id === agentId)
  const fork = agent !== undefined && isFork(agent.type)
  let source = agent
  for (let depth = 0; source !== undefined && isFork(source.type) && depth <= agents.length; depth++) {
    const parent: string | undefined = source.parentId
    source = parent === undefined ? undefined : agents.find(each => each.id === parent)
  }
  const type = fork ? source?.type : agent?.type
  // A project's agent file is Claude's to apply: its prompt goes to whichever model runs the agent.
  const def = (type && registered.get(type)) || (await definitionOf(promptsPort($), memory, type))
  return { agent, fork, type, def, route: fork && type === undefined ? undefined : { type, label: '' } }
}

/** The request for one routed step: the system prompt, the tools, the transcript with reasoning put back. */
async function buildRequest($: EngineInterface, e: TurnStepInput, transcript: readonly ApiMessage[]): Promise<{ req: StepRequest; handback?: string }> {
  const who = e.agentId ?? 'main'
  const target = targetOf(e.model)
  if (!target) throw new Error(`${e.model} names no provider`)
  const provider = target.label
  const infos = await $.tool.list()
  const builtins = builtinNames(infos)
  const io = promptsPort($)
  // The installed claude's own tool definitions and agent prompts. A main step without them still runs, with the
  // generated schema table; a subagent's prompt cannot be had without them, so its step is refused (systemFor).
  const native = e.agentId !== undefined || builtins.length ? await stepTools($, builtins) : undefined
  // The hook API can list platform tools that the native model request does not receive. When a native capture is
  // available, it is authoritative for the native surface sent to the provider; retain MCP tools separately.
  const nativeCapture = native === undefined || native instanceof Error ? undefined : native
  const modelInfos = nativeCapture === undefined ? infos : [
    ...nativeCapture.tools.map(tool => infos.find(info => !info.mcp && info.name === tool.name) ?? { name: tool.name, description: tool.description, mcp: false }),
    ...infos.filter(info => info.mcp && !nativeCapture.tools.some(tool => tool.name === info.name)),
  ]
  const names = modelInfos.map(info => info.name)
  let system: string
  let allow: (tool: string) => boolean = () => true
  let messages = transcript
  let handback: string | undefined
  if (e.agentId === undefined) {
    system = rewriteMain((await $.prompt.compose({ model: e.model, tools: names })).sections, identityLine(target.model, provider))
  } else {
    const owner = await promptOwner($, e.agentId)
    // A fork keeps its parent's tool rules. Any other agent is offered what the engine offers its type: in an
    // interactive session, and for an agent in the background, the background set.
    const background = interactiveSession !== false || spawnBackground.get(e.agentId) !== false
    const engineType = owner.def !== undefined ? undefined : BUILTIN_AGENTS.includes(owner.type ?? '') ? owner.type! : 'general-purpose'
    const engine = native === undefined || native instanceof Error || owner.fork ? undefined : offeredTools(native, engineType, background)
    allow = owner.fork ? toolFilter(owner.agent?.type, undefined) : toolFilter(owner.type, owner.def, engine)
    const offered = names.filter(allow)
    if (handbackState(transcript, HANDBACK_TOOL.name) === 'offered') handback = HANDBACK_TOOL.name
    const prompt = await systemFor(io, memory, {
      def: owner.def,
      route: owner.route && { ...owner.route, label: e.model },
      fork: owner.fork,
      engineModel: e.model,
      target: e.model,
      model: target.model,
      provider,
      tools: handback ? [...offered, handback] : offered,
      native,
    })
    system = prompt.text
    messages = withTask(messages, owner.agent?.description)
  }
  const only = target.remote?.model.tools
  if (Array.isArray(only)) {
    const allowed = allow
    allow = tool => allowed(tool) && only.includes(tool)
  }
  messages = withIdentity(messages, target.model, provider)
  if (loaded.config?.continuation?.mode !== 'durable') messages = withCarry(messages, carryFor(who))
  const candidates: RemoteTool[] = remoteTools(modelInfos, described, allow, {}, native === undefined || native instanceof Error ? undefined : toolTable(native), exactModelIds(catalogue, loaded))
  if (handback) candidates.push({ name: HANDBACK_TOOL.name, description: HANDBACK_TOOL.description, schema: { ...HANDBACK_TOOL.schema } })
  const tools = target.remote ? selectTools(candidates, target.remote.provider, target.remote.model) : candidates
  if (target.remote) {
    const warning = toolCoverageWarning(target.remote.target, names.length, tools.length)
    if (warning && !memory.notes.includes(warning)) {
      memory.notes.push(warning)
      $.ui.toast(warning)
    }
  }
  const prefs = await read($, prefsAtom)
  const effort = routedEffort(e.model, e.effort, prefs.effort) as Effort | number | undefined

  return {
    req: { target: e.model, system, tools, transcript: messages, ...(effort === undefined ? {} : { effort }), who, session: await $.session.id(), transport: prefs.transport },
    ...(handback ? { handback } : {}),
  }
}

async function permissionInstructions($: EngineInterface, model: string, agentId?: string): Promise<string> {
  if (loadedPermissionContext === undefined) throw new Error('The loaded conversation instruction context has not been observed.')
  let instructions: string
  let omitClaudeMd = false
  if (agentId) {
    const agent = (await $.agent.list()).find(each => each.id === agentId)
    if (!agent) throw new Error('The permission conversation is unavailable.')
    const owner = await promptOwner($, agentId)
    omitClaudeMd = owner.def?.omitClaudeMd === true
    const target = targetOf(model)
    if (!target) throw new Error('The permission conversation has no provider.')
    const native = await stepTools($, builtinNames(await $.tool.list()))
    instructions = (await systemFor(promptsPort($), memory, { def: owner.def, route: owner.route && { ...owner.route, label: model }, fork: owner.fork, engineModel: model, target: model, model: target.model, provider: target.label, tools: [], native })).text
    const child = await $.session.messages({ agentId, as: 'api' })
    if (!Array.isArray(child)) throw new Error('The delegated conversation context is unavailable.')
    const taskContext = child.filter(row => row.role === 'user').flatMap(row => typeof row.content === 'string' ? [row.content] : row.content.flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])).join('\n\n')
    if (taskContext) instructions += `\n\nDelegated conversation context (constraints only, not additional human authorization):\n${taskContext}`
  } else instructions = (await $.prompt.compose({ model, tools: [] })).sections.map(section => section.text).join('\n\n')
  return instructions + (omitClaudeMd ? '' : `\n\nLoaded instruction constraints (not new user authorization):\n${loadedPermissionContext}`)
}

/** Routed failures terminate with the public unsuccessful stop shape, never native-provider replay. */
function cacheOwner(owner: AgentModelOwner): void {
  setCapped(agentModels, owner.id, owner.model)
  setCapped(spawnDecisions, owner.id, { model: owner.model, family: owner.explicitNative ? CLAUDE_FAMILY : splitTarget(owner.model)?.provider ?? 'external', explicit: owner.explicitNative, reason: 'observed native loop ownership' })
  if (owner.background !== undefined) setCapped(spawnBackground, owner.id, owner.background)
}

async function rememberOwner($: EngineInterface, id: string, model: string, background?: boolean, effort?: string | number): Promise<void> {
  const owner: AgentModelOwner = { id, model, explicitNative: !isRouted(model) && claimedRefusal(model) === undefined, ...(background === undefined ? {} : { background }), ...(effort === undefined ? {} : { effort }) }
  cacheOwner(owner)
  await update($, ownersAtom, state => ({ entries: [...state.entries.filter(entry => entry.id !== id), { ...state.entries.find(entry => entry.id === id), ...owner }].slice(-256) }))
  await update($, agentDisplayAtom, state => ({ entries: state.entries.map(entry => entry.agentId === id ? { ...entry, model, ...(effort === undefined ? {} : { effort }) } : entry) }))
}

function routedEffort(model: string, explicit?: string | number, preference?: Effort | null): string | number | undefined {
  return explicit ?? preference ?? (targetOf(model)?.provider === 'codex' && !targetOf(model)?.remote ? codexDefaults.effort : undefined)
}

/** Display joins are exact ids, never descriptions, names or inferred Claude tiers. */
async function rememberDisplay($: EngineInterface, entry: AgentDisplay): Promise<void> {
  if (!entry.toolUseId) return
  await update($, agentDisplayAtom, state => ({ entries: [...state.entries.filter(row => row.toolUseId !== entry.toolUseId), { ...state.entries.find(row => row.toolUseId === entry.toolUseId), ...entry }].slice(-256) }))
}

/** The public tool result can mark failure; the public step stream cannot carry a native API error. */
async function childHandback<R extends ToolCallResult>($: EngineInterface, result: R): Promise<R | { deny: string }> {
  if (result.deny !== undefined || result.isError) return result
  const record = result.result as { status?: unknown; agentId?: unknown } | undefined
  if (record?.status !== 'completed' || typeof record.agentId !== 'string') return result
  const failed = (await read($, childFailuresAtom)).entries.find(entry => entry.agentId === record.agentId)
  return failed ? { deny: failed.report } : result
}

async function restoreOwner($: EngineInterface, id: string): Promise<void> {
  if (agentModels.has(id) && spawnDecisions.has(id)) return
  const owner = (await read($, ownersAtom)).entries.find(entry => entry.id === id)
  if (owner) cacheOwner(owner)
}

/** The model a step runs on: native aliases stay in the observed owning conversation's family. */
async function stepOwnerModel($: EngineInterface, e: TurnStepInput): Promise<string> {
  if (e.agentId === undefined) return stepModel(e.model, await $.session.model(), false, tiers(), familyPorts)
  if (isRouted(e.model)) return e.model
  await restoreOwner($, e.agentId)
  // A loop with a native alias (an Explore default, a forked skill's
  // model: haiku) stays in its owner's family unless it was explicitly
  // placed on Claude. The owner is the spawn decision, else the parent loop.
  const decision = spawnDecisions.get(e.agentId)
  const explicitClaude = decision?.explicit === true && decision.family === CLAUDE_FAMILY
  const owner = decision?.model ?? agentModels.get(e.agentId)
  if (owner !== undefined && decision?.family !== CLAUDE_FAMILY && !isRouted(owner)) throw new Error('the observed external child model is unavailable; its request was not moved to a native provider')
  if (owner === undefined && (isNativeAlias(e.model) || e.model === 'inherit') && isRouted(await $.session.model())) throw new Error('the child has no observed model or verified parent model')
  // A list row identifies a loop, not its model choice. Never infer ownership from main.
  // An exact native model on an unowned request remains native, rather than being remapped.
  return stepModel(e.model, owner, explicitClaude, tiers(), familyPorts)
}

type AgentCallInput = { tool_use_id: string; model?: unknown; description?: unknown }

/**
 * An Agent call's `model`, seen before the engine checks it: an exact id this session can run is recorded under the
 * call's tool_use_id and the engine gets its own carrier value; agent.spawn takes the id back (see agent-model.ts).
 * An id nothing here can run is refused with the valid ones. The record goes when the call ends, however it ends.
 */
async function agentCall<E extends AgentCallInput, R>($: EngineInterface, e: E, next: (input: E) => Promise<R>): Promise<R | { deny: string }> {
  const verdict = classifyCall(e.model, exactModelIds(catalogue, loaded))
  if (verdict.kind === 'deny') return { deny: verdict.reason }
  if (verdict.kind === 'pass') return next(e)
  if (!e.tool_use_id) return { deny: `${PLUGIN}: this Agent call carries no tool_use_id, so its model cannot be carried to the spawn; no subagent was started` }
  const entry = { toolUseId: e.tool_use_id, kind: 'exact' as const, at: Date.now(), id: verdict.id }
  await update($, carrierAtom, state => recordEntry(state, entry))
  try {
    return await next({ ...e, model: CARRIER_VALUE, description: markDescription(e.description, verdict.id) })
  } finally {
    await update($, carrierAtom, state => forgetEntry(state, e.tool_use_id))
  }
}

/** The record an Agent call left for its spawn; taking it removes it. */
async function takeCarried($: EngineInterface, toolUseId: string) {
  const entry = entryOf(await read($, carrierAtom), toolUseId)
  if (entry) await update($, carrierAtom, state => forgetEntry(state, toolUseId))
  return entry
}

/**
 * Remember the main model per session (bounded). The first step after a resume
 * that runs on a different model than the routed one this conversation last used
 * says how to return; the host restores only its default model on resume.
 */
async function noteMainModel($: EngineInterface, model: string): Promise<void> {
  try {
    const session = await $.session.id()
    const stored = await $.store.get(LAST_MODELS)
    const models: Record<string, string> = stored && typeof stored === 'object' && !Array.isArray(stored) ? { ...(stored as Record<string, string>) } : {}
    const previous = models[session]
    if (recordedMainModel === undefined && previous !== undefined && previous !== model && isRouted(previous)) {
      $.ui.toast(`${PLUGIN}: this conversation last ran on ${previous}; it now runs on ${model}. Use /model ${previous} to continue on ${previous}.`)
    }
    recordedMainModel = model
    delete models[session]
    models[session] = model
    const keys = Object.keys(models)
    for (const old of keys.slice(0, Math.max(0, keys.length - 200))) delete models[old]
    await $.store.set(LAST_MODELS, models)
  } catch {
    $.ui.log(`${PLUGIN}: the session model note could not be saved`, { to: 'debug' })
  }
}

/** Whether a subagent's transcript holds its task: any user content beyond host reminders. */
function carriesTask(transcript: readonly ApiMessage[]): boolean {
  const reminder = (text: string) => { const trimmed = text.trim(); return trimmed === '' || trimmed.startsWith('<system-reminder>') && trimmed.endsWith('</system-reminder>') }
  return transcript.some(message => message.role !== 'user' || (typeof message.content === 'string'
    ? !reminder(message.content)
    : message.content.some(block => block.type !== 'text' || typeof block.text !== 'string' || !reminder(block.text))))
}

/** Keep only bounded runtime diagnostics, by exact child identity, across a native handback or reload. */
async function rememberChildFailure($: EngineInterface, e: TurnStepInput, report?: string): Promise<void> {
  if (e.agentId === undefined) return
  await update($, childFailuresAtom, state => ({ entries: [...state.entries.filter(entry => entry.agentId !== e.agentId), ...(report ? [{ agentId: e.agentId!, turnId: e.turnId, report }] : [])].slice(-256) }))
}

/** A step answered with a visible refusal, without any provider request. */
async function* refusedStep($: EngineInterface, e: TurnStepInput, text: string): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  $.ui.log(text, { to: 'transcript' })
  const assembler = createAssembler(e.model)
  assembler.feed({ type: 'error', kind: 'request', text })
  const end = assembler.end({ child: e.agentId !== undefined })
  await rememberChildFailure($, e, end.diagnostic)
  yield* end.chunks
  return { turnId: e.turnId, index: e.index, answer: end.answer, toolUses: end.toolUses, stopReason: end.stopReason, usage: end.usage }
}

async function* routedStep($: EngineInterface, e: TurnStepInput, signal?: AbortSignal): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  const who = e.agentId ?? 'main'
  $.ui.log(`${PLUGIN}: step ${who} ${e.model} index=${e.index} effort=${e.effort ?? 'unset'}`, { to: 'debug' })
  const assembler = createAssembler(e.model)
  let handback: string | undefined
  const pending: TurnStepChunk[] = []
  let holdingTools = false
  let visibleAnswer = ''
  try {
    signal?.throwIfAborted()
    await ensureFreshCapacity($)
    const transcript = await $.session.messages(e.agentId === undefined ? { as: 'api' } : { as: 'api', agentId: e.agentId })
    if (!Array.isArray(transcript)) throw new Error(`the transcript of ${who} is unreadable (${transcript.deny})`)
    if (e.agentId !== undefined && !carriesTask(transcript as ApiMessage[])) throw new Error(`the task of ${who} is not readable by plugins (subagent transcripts need session persistence); nothing was sent`)
    const built = await buildRequest($, e, transcript as ApiMessage[])
    handback = built.handback
    const remote = targetOf(e.model)?.remote
    if (remote) {
      const refused = await approval($, remote)
      if (refused) throw new Error(refused)
    }
    const continuation = loaded.config?.continuation
    if (continuation?.mode === 'durable') {
      if (!runtime.executable) throw new Error('Durable continuation requires the native Node helper')
      const records = remote?.model.kind === 'openai' ? [] : await withContinuationStore($, runtime.executable, store => continuationRecords(store, built.req.session, who, Date.now(), () => { continuationExpiredRecords++ }))
      built.req.continuation = { boundary: { turnId: e.turnId, index: e.index }, maxAgeSeconds: continuation.maxAgeSeconds, records }
    }
    const wire = await wireFor($, built.req)
    signal?.throwIfAborted()
    if (e.agentId === undefined) mainSnapshot = JSON.parse(JSON.stringify(wire.req)) as StepRequest
    const reasoning: Reasoning[] = []
    let durable: ContinuationRecord | undefined
    let firstTool: string | undefined
    for await (const event of helperStep(helperPort($), wire)) {
      signal?.throwIfAborted()
      if (event.type === 'continuation') durable = event.record
      else if (event.type === 'continuation_status') {
        lastContinuationStatus = event.status
        if (event.status === 'opaque-state-not-retained') throw new Error('Durable continuation blocked: signed plaintext, oversized state or an unrepresentable opaque position cannot be retained; tool calls withheld')
      }
      else if (event.type === 'signature') reasoning.push({ thinking: event.thinking, signature: event.signature })
      else if (event.type === 'limits') {
        limits = event.limits
        limitsObservedAt = await $.clock.now()
        $.ui.status(limitsText())
      } else if (event.type === 'stats') {
        const via = event.transport ?? 'http'
        lastStep = { model: e.model, who, ms: event.totalMs, transport: via }
        $.ui.log(`${PLUGIN}: step ${who} answered in ${event.totalMs} ms over ${via}`, { to: 'debug' })
      }
      else {
        if (event.type === 'tool_use') { firstTool ??= event.id; holdingTools = true }
        const chunks = assembler.feed(event)
        // Text before the first tool remains live. Tool chunks stay pending until success; on failure,
        // the caller keeps real text but withholds every tool chunk.
        if (holdingTools) pending.push(...chunks)
        else {
          yield* chunks
        }
        for (const chunk of chunks) if (chunk.kind === 'text') visibleAnswer += chunk.text
      }
    }
    if (durable && runtime.executable && assembler.end().failure === undefined) {
      // Staged until the next native transcript proves every real call committed successfully.
      const status = await withContinuationStore($, runtime.executable, store => saveContinuation(store, built.req.session, who, durable!, Date.now()))
      lastContinuationStatus = status === 'saved' ? 'staged: awaiting successful native tool results' : status
      if (status !== 'saved') throw new Error(`Durable continuation blocked: ${status}; tool calls withheld`)
    }
    if (!built.req.continuation) remember(carryFor(who), firstTool, reasoning)
  } catch (error) {
    if (loaded.config?.continuation?.mode === 'durable') lastContinuationStatus = ['budget-full', 'expired', 'cleared', 'opaque-state-not-retained'].includes(lastContinuationStatus) ? `blocked: ${lastContinuationStatus}` : 'blocked: durable dispatch or store operation failed'
    assembler.feed({ type: 'error', kind: 'request', text: `rice-multi-models: ${error instanceof Error ? error.message : String(error)}` })
  }
  const end = assembler.end({ child: e.agentId !== undefined, ...(handback ? { handback } : {}), ...(signal?.aborted ? { failure: `${PLUGIN}: request aborted` } : {}) })
  await rememberChildFailure($, e, end.diagnostic)
  if (end.failure !== undefined) {
    $.ui.log(end.diagnostic ?? redact(end.failure).slice(0, 1200), { to: 'transcript' })
    for (const chunk of pending) if (chunk.kind === 'text') yield chunk
  } else {
    yield* pending
  }
  yield* end.chunks

  return { turnId: e.turnId, index: e.index, answer: end.failure === undefined || end.diagnostic !== undefined ? end.answer : visibleAnswer, toolUses: end.toolUses, stopReason: end.stopReason, usage: end.usage }
}

/** Host-attested caller plugin, not an inferred loop identity for hidden requests. */
const auxiliaryOwner = (purpose: string, origin?: Origin) => origin ? JSON.stringify(['auxiliary', purpose, origin.tier, origin.plugin]) : purpose

const NO_USAGE: ModelUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

/** Public system notices, never assistant text or native accounting. */
async function publishReceipt($: EngineInterface, row: CompactionReceipt): Promise<void> {
  try {
    $.ui.status(`Compaction (${row.owner}): ${row.status === 'installed' ? 'installed-observed' : row.status}`)
    await $.session.append({ message: { type: 'system', content: [{ type: 'text', text: receiptText(row) }] }, ...(row.owner === 'main' ? {} : { agentId: row.owner.slice(6) }) })
  } catch { $.ui.log(`${PLUGIN}: compaction receipt notice unavailable; /rice-models doctor retains transaction status`, { to: 'debug' }) }
}

async function saveReceipt($: EngineInterface, row: CompactionReceipt, prior?: CompactionReceipt): Promise<boolean> {
  let saved = false
  await update($, receiptsAtom, state => {
    saved = prior === undefined || state.entries.some(item => item.id === prior.id && item.status === prior.status && item.at === prior.at)
    return saved ? { entries: putReceipt(state.entries, row) } : state
  })
  if (saved) await publishReceipt($, row)
  return saved
}

async function reconcileCompaction($: EngineInterface, agentId?: string, model?: string): Promise<void> {
  const owner = compactOwner(agentId)
  const pending = (await read($, receiptsAtom)).entries.filter(row => row.owner === owner && ['preparing', 'prepared'].includes(row.status))
  if (!pending.length) return
  const active = await $.session.messages(agentId === undefined ? {} : { agentId })
  if (!Array.isArray(active)) return
  const session = await $.session.id(), now = await $.clock.now()
  for (const row of pending) {
    const observed = await observedReceipt(row, active, session, model ?? (agentId === undefined ? await $.session.model() : agentModels.get(agentId)), now)
    if (observed !== row) await saveReceipt($, observed, row)
  }
}

/** A one-shot completion on a routed model, for `model.complete` and `model.fork`. */
async function complete($: EngineInterface, req: StepRequest, timeoutMs?: number, requireFinished = false, signal?: AbortSignal): Promise<ModelCompleteResult> {
  if (signal?.aborted) return { isAnswered: false, reason: 'aborted', usage: NO_USAGE }
  await ensureFreshCapacity($)
  if (signal?.aborted) return { isAnswered: false, reason: 'aborted', usage: NO_USAGE }
  if (req.native?.maxTokens !== undefined && req.native.maxTokens > outputLimit(req.target)) return { isAnswered: false, reason: 'api-error', status: null, error: 'invalid_request', usage: NO_USAGE }
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647)) return { isAnswered: false, reason: 'api-error', status: null, error: 'invalid_request', usage: NO_USAGE }
  const remote = targetOf(req.target)?.remote
  if (remote && (await approval($, remote))) return { isAnswered: false, reason: 'api-error', status: null, error: 'invalid_request', usage: NO_USAGE }
  let answer: Awaited<ReturnType<typeof collectText>>
  const started = await $.clock.now()
  try { answer = await collectText(helperPort($, timeoutMs), await wireFor($, req), signal) } catch (error) {
    if (signal?.aborted || error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError') || timeoutMs !== undefined && await $.clock.now() - started >= timeoutMs) return { isAnswered: false, reason: 'aborted', usage: NO_USAGE }
    return { isAnswered: false, reason: 'api-error', status: null, error: 'unknown', usage: NO_USAGE }
  }
  const usage = answer.usage ?? NO_USAGE
  if (signal?.aborted || answer.aborted || answer.error !== undefined && timeoutMs !== undefined && await $.clock.now() - started >= timeoutMs) return { isAnswered: false, reason: 'aborted', usage }
  if (answer.error !== undefined) {
    if (answer.cause) $.ui.log(`${PLUGIN}: ${req.target} auxiliary request failed [${answer.cause}]; no plugin recovery attempted`, { to: 'transcript' })
    const status = answer.status ?? null
    const error = status === 429 ? 'rate_limit' : status === 529 ? 'overloaded' : status === 401 || status === 403 ? 'authentication_failed' : status === 402 ? 'billing_error' : status === 404 ? 'model_not_found' : status !== null && status >= 500 ? 'server_error' : status !== null && status >= 400 ? 'invalid_request' : 'unknown'
    return { isAnswered: false, reason: 'api-error', status, error, usage }
  }
  if (requireFinished && answer.stopReason !== 'end_turn' && answer.stopReason !== 'stop_sequence') return { isAnswered: false, reason: 'api-error', status: null, error: answer.stopReason === 'max_tokens' ? 'max_output_tokens' : 'unknown', usage }
  if (answer.text.trim() === '') return { isAnswered: false, reason: 'empty-reply', usage }
  return { isAnswered: true, text: answer.text, usage }
}

/**
 * Runs the installed claude CLI with fixed arguments. npm installs it on native
 * Windows as a .cmd shim, which only a shell can start; the arguments here are
 * constants, so the cmd.exe fallback carries no user input.
 */
async function installedClaude($: EngineInterface, args: readonly string[], options: { timeoutMs: number; env: Record<string, string> }) {
  let direct: Awaited<ReturnType<EngineInterface['process']['run']>> | undefined
  try { direct = await $.process.run(['claude', ...args], options) } catch { direct = undefined }
  if (direct?.exitCode === 0 || await $.env.get('OS') !== 'Windows_NT') {
    if (direct) return direct
    throw new Error('The installed claude executable is unavailable.')
  }
  return $.process.run(['cmd.exe', '/d', '/s', '/c', 'claude', ...args], options)
}

/**
 * Claude Code's own compaction prompt and summary message, read from the installed claude by the helper once
 * per running version and kept in the plugin's store. Rejects, naming why, when they cannot be read: a routed
 * conversation is then not compacted rather than compacted with text this mod made up.
 */
function nativeCompaction($: EngineInterface): Promise<CompactionTemplate> {
  compactionTemplate ??= (async () => {
    const version = (await $.session.version()).version
    const key = `native-compaction:${version}`
    const cached = await $.store.get(key)
    if (isTemplate(cached) && cached.version === version) return cached
    if (!runtime.executable || runtime.error) throw new Error(runtime.error || 'the Node.js helper is unavailable; /rice-models setup repair')
    const ran = await $.process.run([runtime.executable, helperFile($.plugin.root), 'capture-compaction'], { timeoutMs: 100_000 })
    let result: { ok?: boolean; template?: unknown; error?: unknown } = {}
    try { result = JSON.parse(ran.stdout) as typeof result } catch { /* reported below */ }
    if (ran.exitCode !== 0 || result.ok !== true || !isTemplate(result.template)) throw new Error(typeof result.error === 'string' ? result.error : 'the helper could not capture it')
    if (result.template.version !== version) throw new Error('The installed compaction contract does not match this host version.')
    await $.store.set(key, result.template)
    return result.template
  })()
  compactionTemplate.catch(() => { compactionTemplate = undefined })
  return compactionTemplate
}

async function nativeClassifier($: EngineInterface): Promise<ClassifyTemplate> {
  const version = (await $.session.version()).version
  const key = `native-classifier:${version}`
  const cached = await $.store.get(key)
  if (isClassifyTemplate(cached) && cached.version === version) return cached
  if (!runtime.executable || runtime.error) throw new Error('The native classifier capture needs the Node helper.')
  const ran = await $.process.run([runtime.executable, helperFile($.plugin.root), 'capture-classifier'], { timeoutMs: 100_000 })
  const result = JSON.parse(ran.stdout) as { ok?: boolean; template?: unknown }
  if (ran.exitCode !== 0 || !result.ok || !isClassifyTemplate(result.template) || result.template.version !== version) throw new Error('The native classifier contract could not be captured for this host version.')
  await $.store.set(key, result.template)
  return result.template
}

/** The session's built-in tools by name: the combination the engine's tool texts and agent prompts are read for. */
const builtinNames = (infos: readonly { name: string; mcp: boolean }[]): string[] => infos.filter(info => !info.mcp).map(info => info.name)

/**
 * Claude Code's own tool definitions and built-in agent prompts for this combination of built-in tools, read from
 * the installed claude by the helper once per running version and combination and kept in the plugin's store.
 * Rejects, naming why, when they cannot be read: a main step then sends the generated schema table and the
 * descriptions the session lists, and a subagent step is refused rather than sent with a prompt this mod made up.
 */
function nativeTools($: EngineInterface, names: readonly string[]): Promise<NativeCapture> {
  const set = toolSetKey(names)
  let pending = toolCaptures.get(set)
  if (pending) return pending
  pending = (async () => {
    const version = (await $.session.version()).version
    const key = `native-tools:${version}:${set}`
    const cached = await $.store.get(key)
    if (isCapture(cached)) return cached
    if (toolCaptureFailure && await $.clock.now() - toolCaptureFailure.at < TOOL_CAPTURE_RETRY_MS) throw new Error(toolCaptureFailure.error)
    if (!runtime.executable || runtime.error) throw new Error(runtime.error || 'the Node.js helper is unavailable; /rice-models setup repair')
    const ran = await $.process.run([runtime.executable, helperFile($.plugin.root), 'capture-tools'], { stdin: JSON.stringify({ tools: [...names] }), timeoutMs: 100_000 })
    let result: { ok?: boolean; capture?: unknown; error?: unknown } = {}
    try { result = JSON.parse(ran.stdout) as typeof result } catch { /* reported below */ }
    if (ran.exitCode !== 0 || result.ok !== true || !isCapture(result.capture)) {
      const error = typeof result.error === 'string' ? result.error : 'the helper could not capture them'
      toolCaptureFailure = { at: await $.clock.now(), error }
      throw new Error(error)
    }
    toolCaptureFailure = undefined
    try { await $.store.set(key, result.capture) } catch { $.ui.log(`${PLUGIN}: the installed claude's tool definitions could not be saved; they are read again next session`, { to: 'debug' }) }
    if (result.capture.version !== version) $.ui.log(`${PLUGIN}: tool definitions and agent prompts come from the installed claude ${result.capture.version}; this session runs ${version}`, { to: 'debug' })
    return result.capture
  })()
  setCapped(toolCaptures, set, pending, 16)
  pending.then(capture => { setCapped(readyCaptures, set, capture, 16) }, () => { if (toolCaptures.get(set) === pending) toolCaptures.delete(set) })
  return pending
}

/** The capture for these tools when it is already read (in this process or in the store), without running one. */
async function readyTools($: EngineInterface, names: readonly string[]): Promise<NativeCapture | undefined> {
  const set = toolSetKey(names)
  const ready = readyCaptures.get(set)
  if (ready) return ready
  const cached = await $.store.get(`native-tools:${(await $.session.version()).version}:${set}`)
  return isCapture(cached) ? cached : undefined
}

/** The capture for a step's tools, or why there is none; a failure is written to the debug log once. */
async function stepTools($: EngineInterface, names: readonly string[]): Promise<NativeCapture | Error> {
  try {
    return await nativeTools($, names)
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    if (!reportedToolFallbacks.has(failure.message)) {
      reportedToolFallbacks.add(failure.message)
      $.ui.log(`${PLUGIN}: Claude Code's own tool definitions could not be read from the installed claude (${failure.message}); built-in tools use the generated schema table (${STAMP.engineVersion}) and the descriptions the session lists, and routed subagent steps are refused`, { to: 'debug' })
    }
    return failure
  }
}

/** Where the tool definitions and agent prompts of routed steps come from now, for status and doctor. */
async function toolDefinitionsState($: EngineInterface): Promise<{ source: string; version: string | null; agentTypes: string[]; error: string | null }> {
  const capture = await $.tool.list().then(infos => readyTools($, builtinNames(infos))).catch(() => undefined)
  if (capture) return { source: 'installed claude', version: capture.version, agentTypes: Object.keys(capture.prompts).sort(), error: null }
  return { source: `generated schema table (${STAMP.engineVersion})`, version: null, agentTypes: [], error: toolCaptureFailure?.error ?? 'not read yet' }
}

/** The main transcript's file path, from the latest classic hook that named it; kept across a plugin reload. */
async function transcriptPath($: EngineInterface): Promise<string | undefined> {
  return seenTranscriptPath ?? (await read($, transcriptAtom)).path ?? undefined
}

/** Remembers the transcript path a main-conversation classic hook names. */
async function noteTranscript($: EngineInterface, e: { transcript_path: string; agent_id?: string }): Promise<void> {
  if (e.agent_id !== undefined || !e.transcript_path || e.transcript_path === seenTranscriptPath) return
  seenTranscriptPath = e.transcript_path
  await update($, transcriptAtom, () => ({ path: e.transcript_path }))
}

/**
 * The native auto-mode defaults are built into each Claude Code version, not read
 * from settings. They are cached per version, so a background update of the
 * installed CLI does not break a session still running the previous version.
 */
function nativePermissionDefaults($: EngineInterface): Promise<unknown> {
  permissionDefaults ??= (async () => {
    const version = (await $.session.version()).version
    const cached = await $.store.get(`auto-mode-defaults:${version}`)
    if (cached !== undefined) return cached
    // A nested claude process migrates the settings of whatever configuration it
    // starts in. Give it a mod-owned folder so the user's settings never change.
    const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${(await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''}/.claude`
    const isolated = `${configDir.replace(/[\\/]+$/, '')}/rice-multi-models/native-defaults`
    await $.fs.write(`${isolated}/settings.json`, '{}\n')
    const env = { CLAUDE_CONFIG_DIR: isolated }
    const checked = await installedClaude($, ['--version'], { timeoutMs: 5_000, env })
    const installed = /^(\S+) \(Claude Code\)/.exec(checked.stdout.trim())?.[1]
    if (checked.exitCode !== 0 || !installed) throw new Error('The installed claude executable is unavailable for the auto-mode defaults.')
    const defaults = await installedClaude($, ['auto-mode', 'defaults'], { timeoutMs: 10_000, env })
    if (defaults.exitCode !== 0 || defaults.isStdoutTruncated) throw new Error('The native auto-mode defaults could not be loaded.')
    const parsed = JSON.parse(defaults.stdout) as unknown
    await $.store.set(`auto-mode-defaults:${installed}`, parsed)
    if (installed !== version) $.ui.log(`${PLUGIN}: auto-mode defaults come from the installed claude ${installed}; this session runs ${version}`, { to: 'debug' })
    return parsed
  })()
  permissionDefaults.catch(() => { permissionDefaults = undefined })
  return permissionDefaults
}

async function effectivePermissionPolicy($: EngineInterface) {
  const [defaults, user, flag, policy] = await Promise.all([nativePermissionDefaults($),
    $.settings.read({ source: 'user' }), $.settings.read({ source: 'flag' }), $.settings.read({ source: 'policy' })])
  return resolvePermissionPolicy(defaults, { user: user.autoMode, flag: flag.autoMode, policy: policy.autoMode })
}

/**
 * Harmless native permission questions whose answers differ by mode (plan names itself on edits).
 * Edit paths are relative: the engine resolves them against the working directory, so the answer
 * does not depend on how the platform spells that directory (an 8.3 short name on Windows made an
 * absolute probe look the same in every mode).
 */
const MODE_PROBES: readonly { tool: string; input: (cwd: string) => Record<string, unknown> }[] = [
  { tool: 'Bash', input: () => ({ command: 'printf rice-multi-models-mode-probe', description: 'Permission mode probe' }) },
  { tool: 'Write', input: () => ({ file_path: '.rice-multi-models-mode-probe', content: '' }) },
  { tool: 'Edit', input: () => ({ file_path: '.rice-multi-models-mode-probe', old_string: 'probe', new_string: 'probe-changed' }) },
  { tool: 'Agent', input: () => ({ description: 'Permission mode probe', prompt: 'Permission mode probe' }) },
]

/**
 * The main permission mode's native fingerprint: core's own verdicts for the
 * available probe tools, asked as `$.tool.check` queries (no execution, no
 * classic hooks, no mod tool). Taken before and after a pending judgment, a
 * change means the mode or policy changed. Without any file-edit tool an
 * auto-to-plan switch answers identically and is not detectable this way.
 */
async function mainModeFingerprint($: EngineInterface): Promise<string> {
  const cwd = (await $.session.cwd()).replace(/[\\/]+$/, '')
  const available = new Set((await $.tool.list()).map(info => info.name))
  const verdicts = await Promise.all(MODE_PROBES.filter(probe => available.has(probe.tool)).map(async probe => {
    try {
      const verdict = await $.tool.check({ tool: probe.tool, input: probe.input(cwd) })
      return [probe.tool, verdict.decision, verdict.reason ?? '', verdict.rule ?? '', verdict.setting ?? '']
    } catch { return [probe.tool, 'unavailable'] }
  }))
  return JSON.stringify(verdicts)
}

async function nativeContextStatus($: EngineInterface) {
  const model = await $.session.model()
  const metadata = activeContext(model)
  const usage = await $.session.usage({ breakdown: 'summary' })
  const held = (await $.state.get({ plugin: 'rice-multi-models', key: 'nativeContext' })).value
  const current = await $.env.get('CLAUDE_CODE_MAX_CONTEXT_TOKENS') ?? null
  return {
    model,
    activeContextWindow: metadata?.contextWindow ?? null,
    maxContextWindow: metadata?.maxContextWindow ?? null,
    inputTokenLimit: metadata?.inputTokenLimit ?? null,
    outputTokenLimit: metadata?.outputTokenLimit ?? null,
    autoCompactTokenLimit: metadata?.autoCompactTokenLimit ?? null,
    reasoningEfforts: metadata?.reasoningEfforts ?? null,
    capabilities: { inputModalities: metadata?.inputModalities ?? null, tools: metadata?.tools ?? null, parallelToolCalls: metadata?.parallelToolCalls ?? null },
    nativeWindow: usage.context.window,
    override: held?.applied !== null && held?.applied !== undefined && held.applied === current ? 'plugin-owned' : current !== null ? 'owner/external' : 'unmanaged',
    scope: 'native accounting and automatic compaction are host-owned; the mod supplies the smallest reported window of the routed main model and live routed subagents as CLAUDE_CODE_MAX_CONTEXT_TOKENS and applies no input-budget aborts',
    limitations: NATIVE_MODEL_LIMITATIONS,
  }
}

async function configuredCapabilities($: EngineInterface, checked: Runtime = runtime) {
  if (!loaded.config) return []
  const reports = capabilityContracts(loaded.config)
  const search = await readSearchConfiguration($, checked)
  const fetch = await readFetchConfiguration($, checked)
  const legacyUrl = await $.env.get('RICE_MULTI_MODELS_SEARCH_URL')
  const searchConfig = search.config ?? { version: 1 as const, endpoints: [] }
  const fetchConfig = fetch.config ?? { endpoints: [] }
  const web: Record<string, { search: string; fetch: string }> = {}
  for (const report of reports) {
    const remote = remoteOf(loaded, report.target)
    const providerNative = remote !== undefined && fetchProviderProtocol(remote.model.kind, remote.provider.baseUrl, remote.modelId) !== undefined
    const status = webSearchStatus(report.target, remote, searchConfig, legacyUrl, search.ok,
      fetchTierConfigState(fetchConfig, providerNative), { available: fetch.ok, error: fetch.error ?? null })
    web[report.target] = {
      search: JSON.stringify({ policy: remote?.model.webSearch ?? 'auto', providerNative: status.providerNative, configuredServices: status.configuredServices, configuredServicesAvailable: status.configuredServicesAvailable, claudeFallback: status.claudeFallback }),
      fetch: JSON.stringify({ configuration: status.fetchConfiguration, tiers: status.fetchTierState.tiers }),
    }
  }
  return capabilityContracts(loaded.config, web)
}

async function capabilitySummary($: EngineInterface): Promise<string> {
  return formatCapabilityContracts(await configuredCapabilities($))
}

async function statusText($: EngineInterface): Promise<string> {
  const prefs = await read($, prefsAtom)
  const version = await $.session.version()
  const context = await nativeContextStatus($)
  const tools = await toolDefinitionsState($)
  const table = `the schema table generated for ${STAMP.engineVersion}${version.version !== STAMP.engineVersion ? ` (this is ${version.version})` : ''} and the descriptions the session lists`
  const lines = [
    `helper: ${runtime.error || !runtime.executable ? runtime.error || 'Node.js 22+ unavailable; /rice-models setup repair' : prefs.helper === 'once' ? 'one process per step (/rice-models helper session for the session helper)' : sessionHelper() ? 'session helper running (one connection per conversation, private socket)' : 'session helper not running; one process per step'}`,
    `transport: ${prefs.transport} (auto = WebSocket, falling back to server-sent events)`,
    `effort: ${prefs.effort ?? (codexDefaults.effort ? `${codexDefaults.effort} (configured Codex policy)` : 'unset; provider chooses')}${prefs.effort ? ' (set here)' : ''}, unless the session sets one`,
    `Codex session candidate: ${defaultModel('codex') ?? 'none discovered'}`,
    `Discovery: ${catalogue.providers.map(provider => `${provider.provider}: ${provider.status}${provider.error ? ` (${provider.error})` : ''}`).join('; ')}`,
    await capabilitySummary($),
    `Primary context (${context.model}): active context ${context.activeContextWindow ?? 'unknown'}, maximum context ${context.maxContextWindow ?? 'unknown'}, reported input ${context.inputTokenLimit ?? 'unknown'}, reported output ${context.outputTokenLimit ?? 'unknown'}, native window ${context.nativeWindow}; override ${context.override}.`,
    `Native context scope: ${context.scope}. ${NATIVE_MODEL_LIMITATIONS.registration}`,
    `Native child recovery limitation: ${NATIVE_MODEL_LIMITATIONS.childBudget} ${NATIVE_MODEL_LIMITATIONS.recovery}`,
    'Compaction: native-like session.compact replacement on the same exact active model only, using captured native wording and bounded input/output capacity. Mod-owned preparing/prepared/aborted receipts confirm installed-observed only from actual active context. Core summarizer lifecycle/UI/accounting is not equivalent. Configured PreCompact policy is never bypassed or manually dispatched: replacement is refused when present or unreadable. Failed, cancelled or incomplete summaries retain original history; clipped source coverage is disclosed.',
    `Compaction receipts: ${JSON.stringify((await read($, receiptsAtom)).entries.map(({ id, owner, trigger, status, reason }) => ({ id, owner, trigger, status, reason })))}`,
    tools.source === 'installed claude'
      ? `Tool definitions and agent prompts: Claude Code's own, read from the installed claude ${tools.version} (built-in agent types ${tools.agentTypes.join(', ') || 'none'}); a tool it did not show (MCP, or interactive only) uses ${table}.`
      : `Tool definitions and agent prompts: ${tools.error === 'not read yet' ? 'not read from the installed claude yet' : `the installed claude's could not be read (${tools.error})`}; built-in tools use ${table}, and a routed subagent step is refused until they are read.`,
    limitsText() ? `ChatGPT limits: ${limitsText()}` : 'ChatGPT limits: shown after the first WebSocket request',
    `Web search: ${JSON.stringify(await currentWebSearchStatus($))}`,
    lastStep ? `last step: ${lastStep.model} for ${lastStep.who}, ${lastStep.ms} ms over ${lastStep.transport}` : 'no routed step yet',
    ...memory.notes.slice(-5),
  ]

  return lines.join('\n')
}

function routedRows(): PickerRow[] {
  return catalogueRows(catalogue)
}

async function modelsText($: EngineInterface): Promise<string> {
  return `${await discoveryText($, 'models')}\n\nUse a discovered candidate with /model <id>, --model <id>, or model: <id> in an agent file. /rice-models refresh fetches a new catalogue; discovery tools read this snapshot.`
}

function candidateRoute(model: string): CandidateRoute | undefined {
  const remote = remoteOf(loaded, model)
  if (remote) {
    return {
      source: 'configured provider',
      execution: 'native provider',
      identity: JSON.stringify({
        kind: 'configured-provider',
        requestedModel: model,
        resolvedTarget: remote.target,
        approvalFingerprint: remote.fingerprint,
        provider: remote.provider,
        model: remote.model,
      }),
      codexSubscriptionQuota: false,
    }
  }
  const target = splitTarget(model)
  if (!target) return undefined
  if (target.provider === 'codex') {
    return {
      source: 'Codex authenticated models endpoint',
      execution: 'native provider',
      identity: JSON.stringify({ kind: 'codex-subscription', model: target.model }),
      codexSubscriptionQuota: true,
    }
  }
  return undefined
}

function candidateModels() {
  return candidates(routedRows(), candidateRoute).map(candidate => {
    const entry = catalogue.models.find(model => model.model === candidate.model)!
    return { ...candidate, source: entry.source, metadata: entry.metadata, metadataSources: entry.metadataSources, observedAt: entry.observedAt }
  })
}

async function discoveryText($: EngineInterface, action: 'models' | 'status'): Promise<string> {
  const models = candidateModels()
  const approvals = await approvedSet($)
  const providers = Object.values(loaded.config?.providers ?? {}).map(provider => ({ provider: provider.id, approved: approvals.has(fingerprint(provider)) }))
  const report = modelsReport(models, providers, limitsReport(limits, limitsObservedAt), catalogue)
  if (action === 'models') return report
  return `${report}\n\nSession status:\n${JSON.stringify(await discoveryStatus($), null, 2)}`
}

async function discoveryStatus($: EngineInterface): Promise<Record<string, unknown>> {
  const prefs = await read($, prefsAtom)
  const version = await $.session.version()
  return {
    helper: !runtime.executable || runtime.error ? 'unavailable' : prefs.helper === 'once' ? 'one process per step' : sessionHelper() ? 'session helper running' : 'one process per step',
    transport: prefs.transport,
    effort: prefs.effort ?? codexDefaults.effort ?? null,
    defaultCodexModel: defaultModel('codex'),
    nativeContext: await nativeContextStatus($),
    toolSchemaVersion: STAMP.engineVersion,
    toolDefinitions: await toolDefinitionsState($),
    webSearch: await currentWebSearchStatus($),
    continuation: continuationStatus(loaded.config?.continuation ?? CONTINUATION_OFF, ['codex-responses', ...Object.values(loaded.config?.providers ?? {}).flatMap(provider => Object.values(provider.models).map(model => model.kind))], lastContinuationStatus, continuationExpiredRecords),
    modelCapabilities: await configuredCapabilities($),
    currentEngineVersion: version.version,
    limits: limitsReport(limits, limitsObservedAt),
    lastStep: lastStep ? { model: lastStep.model, who: lastStep.who, durationMs: lastStep.ms, transport: lastStep.transport } : null,
    diagnostics: { count: memory.notes.length, class: memory.notes.length === 0 ? 'none' : 'agent/configuration diagnostics' },
  }
}

/** The Node helper serializes writes and tracks exact owned rows, never provider prefixes. */
async function writePicker($: EngineInterface): Promise<string> {
  const result = await syncPicker($, runtime, routedRows())
  return result.ok ? `Synchronized ${result.count} owned rows into ${result.path}; custom and edited rows were kept. /model lists them in new sessions.` : `Picker not changed: ${result.error}`
}

async function setupCommand($: EngineInterface, action: string | undefined): Promise<string> {
  if (action === 'native') return 'Start the normal claude command. This mod uses supported plugin hooks; separate launchers are no longer installed. Use /rice-models setup repair to check the local runtime.'
  if (action && !['repair', 'codex'].includes(action)) return 'Usage: /rice-models setup [repair|codex]. No global install is performed.'
  runtime = await detectRuntime($)
  if (runtime.error) {
    await syncNativeContext($, true)
    return setupSummary(runtime, undefined, 0, undefined, undefined, await capabilitySummary($))
  }
  if (action === 'codex') {
    try {
      const result = await $.process.run([runtime.executable!, helperFile($.plugin.root), 'setup-codex'], { timeoutMs: 180_000 })
      const installed = JSON.parse(result.stdout.trim()) as { ok: boolean; installed: boolean; login?: string[]; error?: string }
      if (!installed.ok) return `Codex setup failed: ${installed.error || 'inspect /rice-models doctor'}`
      runtime = await detectRuntime($)
      return `${installed.installed ? 'Installed the pinned official Codex CLI into plugin-owned state (not globally).' : 'Using the existing Codex CLI; no install was needed.'}\nRun ${commandText(installed.login || ['codex', 'login'], runtime.info?.platform)} in your terminal to sign in. No login, provider approval or permission change was performed.`
    } catch { return 'Codex setup did not complete; inspect /rice-models doctor and retry /rice-models setup codex. No login or provider approval was performed.' }
  }
  codexDefaults = await readCodexDefaults($)
  await loadProviders($)
  await refreshCatalogue($)
  await ensureHelper($)
  const rows = routedRows()
  return setupSummary(runtime, await syncPicker($, runtime, rows), rows.length, defaultModel('codex'), undefined, await capabilitySummary($))
}

async function readSearchConfiguration($: EngineInterface, checked: Runtime, edit?: SearchEdit): Promise<SearchConfigurationResult> {
  if (checked.error || !checked.executable) return { ok: false, error: 'Search configuration is unavailable until the local helper is ready.' }
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${checked.info?.home || (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''}/.claude`
  try {
    const result = await $.process.run([checked.executable, helperFile($.plugin.root), 'search-config'], { stdin: JSON.stringify({ configDir, ...(edit ? { edit } : {}) }), timeoutMs: 10_000 })
    const parsed: SearchConfigurationResult = JSON.parse(result.stdout)
    return typeof parsed.ok === 'boolean' ? parsed : { ok: false, error: 'Search configuration helper returned an invalid result.' }
  } catch { return { ok: false, error: 'Search configuration helper did not complete.' } }
}

type FetchConfigurationResult = { ok: boolean; config?: FetchConfigMetadata; error?: string }

async function readFetchConfiguration($: EngineInterface, checked: Runtime): Promise<FetchConfigurationResult> {
  if (checked.error || !checked.executable) return { ok: false, config: { endpoints: [] }, error: 'Fetch configuration could not be read.' }
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${checked.info?.home || (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''}/.claude`
  try {
    const result = await $.process.run([checked.executable, helperFile($.plugin.root), 'fetch-config-status'], { stdin: JSON.stringify({ configDir }), timeoutMs: 10_000 })
    const value: unknown = JSON.parse(result.stdout)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, config: { endpoints: [] }, error: 'Fetch configuration could not be read.' }
    const parsed = value as FetchConfigurationResult
    const endpoints = parsed.config?.endpoints
    if (typeof parsed.ok !== 'boolean' || !Array.isArray(endpoints) || !endpoints.every(endpoint =>
      endpoint && typeof endpoint.name === 'string' && Number.isSafeInteger(endpoint.priority))) return { ok: false, config: { endpoints: [] }, error: 'Fetch configuration could not be read.' }
    return {
      ok: parsed.ok,
      config: { endpoints: endpoints.map(({ name, priority }) => ({ name, priority })) },
      ...(parsed.ok ? {} : { error: 'Fetch configuration could not be read.' }),
    }
  } catch { return { ok: false, config: { endpoints: [] }, error: 'Fetch configuration could not be read.' } }
}

async function currentWebSearchStatus($: EngineInterface, checked: Runtime = runtime) {
  const model = await $.session.model()
  const remote = remoteOf(loaded, model)
  const search = await readSearchConfiguration($, checked)
  const fetch = await readFetchConfiguration($, checked)
  const config = search.config ?? { version: 1 as const, endpoints: [] }
  const providerNative = remote !== undefined && fetchProviderProtocol(remote.model.kind, remote.provider.baseUrl, remote.modelId) !== undefined
  const fetchTiers = fetchTierConfigState(fetch.config ?? { endpoints: [] }, providerNative)
  return webSearchStatus(model, remote, config, await $.env.get('RICE_MULTI_MODELS_SEARCH_URL'), search.ok, fetchTiers,
    { available: fetch.ok, error: fetch.error ?? null })
}

/** Pure diagnostics: no startup, settings write, install, network request, login or approval. */
async function doctorCommand($: EngineInterface): Promise<string> {
  const checked = await detectRuntime($)
  return JSON.stringify({ runtime: checked.info || { node: { executable: checked.executable, version: checked.version } }, error: checked.error || null,
    integration: { kind: 'public plugin hooks', start: 'claude', compaction: 'session.compact', compactionReceipts: (await read($, receiptsAtom)).entries, compactionAccounting: 'mod-owned provider usage, not native ledger', toolDefinitions: await toolDefinitionsState($), webSearch: await currentWebSearchStatus($, checked) },
    continuation: continuationStatus(loaded.config?.continuation ?? CONTINUATION_OFF, ['codex-responses', ...Object.values(loaded.config?.providers ?? {}).flatMap(provider => Object.values(provider.models).map(model => model.kind))], lastContinuationStatus, continuationExpiredRecords),
    modelCapabilities: await configuredCapabilities($),
    actions: checked.error ? ['/rice-models setup repair'] : ['/rice-models setup repair', ...(!checked.info?.auth.codex ? ['codex login', ...(!checked.info?.clis.codex ? ['/rice-models setup codex'] : [])] : [])] }, null, 2)
}

/**
 * OpenCode Zen and Go as providers, from each gateway's model list and the models.dev catalog: a summary, or
 * with `write` the providers saved into rice-multi-models.json (other providers kept) and reloaded.
 */
async function opencodeCommand($: EngineInterface, words: readonly string[]): Promise<string> {
  const tiers: Tier[] = words.includes('zen') ? ['zen'] : words.includes('go') ? ['go'] : ['zen', 'go']
  const write = words.includes('write')
  if (!runtime.executable || runtime.error || !runtime.info) return setupSummary(runtime)
  const home = runtime.info.home
  const authFile = runtime.info.opencodeAuthFile
  // The helper emits entry names only here, never credential values.
  const listed = await $.process.run([runtime.executable, helperFile($.plugin.root), 'opencode-entries', authFile], { timeoutMs: 10_000 }).catch(() => undefined)
  if (!listed || listed.exitCode !== 0) return 'OpenCode auth metadata is malformed or unreadable. Check /rice-models doctor or run opencode auth login; no provider configuration was written.'
  const entries = new Set(JSON.parse(listed.stdout) as string[])
  const catalog = await $.http.fetch(CATALOG_URL)
  if (!catalog.ok) return `rice-models opencode: ${CATALOG_URL} answered HTTP ${catalog.status}; retry later.`
  const parsed: unknown = JSON.parse(catalog.text)
  const built: { tier: Tier; provider: Record<string, unknown>; skipped: string[] }[] = []
  for (const tier of tiers) {
    const live = await $.http.fetch(`${TIERS[tier].base}/models`)
    if (!live.ok) return `rice-models opencode: ${TIERS[tier].base}/models answered HTTP ${live.status}; retry later.`
    built.push({ tier, ...opencodeProvider(tier, parsed, liveIds(live.text), runtime.executable, authFile, helperFile($.plugin.root)) })
  }
  const lines = built.map(({ tier, provider, skipped }) => {
    const t = TIERS[tier]
    const key = entries.has(t.keys[0]) ? `key: the ${t.keys[0]} entry` : entries.has(t.keys[1]) ? `key: the ${t.keys[1]} entry (one console key serves Zen and Go)` : `key: none yet; run opencode auth login and pick ${t.label}`
    const models = Object.keys(provider.models as object)

    return `${t.id} (${t.label}, ${t.base}): ${models.length} models (${kindCounts(provider)}); ${key}${skipped.length > 0 ? `\n  left out: ${skipped.join(', ')}` : ''}`
  })
  if (!write) return `${lines.join('\n')}\n\n/rice-models opencode ${tiers.length === 1 ? `${tiers[0]} ` : ''}write saves ${tiers.length === 1 ? 'it' : 'them'} into rice-multi-models.json.`
  const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${home}/.claude`
  const path = `${dir}/${CONFIG_FILE}`
  const current = (await $.fs.exists(path)) ? (JSON.parse(await $.fs.read(path)) as Record<string, unknown>) : {}
  const providers = { ...((current.providers as Record<string, unknown> | undefined) ?? {}) }
  for (const { tier, provider } of built) providers[TIERS[tier].id] = provider
  const next = `${JSON.stringify({ ...current, providers }, null, 2)}\n`
  const checked = loadText(path, next)
  if (checked.errors.length > 0) return `rice-models opencode: the result does not validate, so nothing was written:\n${checked.errors.join('\n')}`
  await $.fs.write(path, next)
  await loadProviders($)

  return `${lines.join('\n')}\n\nWrote ${built.map(b => TIERS[b.tier].id).join(' and ')} into ${path}; other providers were kept. The first request asks to approve each one (or /rice-models approve <id>). /rice-models picker write lists the models in /model.`
}

async function searchCommand($: EngineInterface, args: string): Promise<string> {
  const checked = await detectRuntime($)
  if (checked.error || !checked.executable) return setupSummary(checked)
  return searchConfigurationCommand(args, { read: () => readSearchConfiguration($, checked), edit: edit => readSearchConfiguration($, checked, edit), ask: (question, options) => $.ui.ask(question, options) })
}

async function runCommand($: EngineInterface, args: string): Promise<string> {
  const [first, value] = args.trim().split(/\s+/)
  if (first === 'search') return searchCommand($, args.trim().replace(/^search(?:\s+|$)/, ''))
  if (first === 'setup') return setupCommand($, value)
  if (first === 'doctor') return doctorCommand($)
  if (first === 'opencode') return opencodeCommand($, args.trim().split(/\s+/).slice(1))
  if (!first || first === 'status') return statusText($)
  if (first === 'models') return modelsText($)
  if (first === 'picker') return value === 'write' ? writePicker($) : `${JSON.stringify({ modelPicker: { options: routedRows() } }, null, 2)}\n\n/rice-models picker write puts these rows in your user settings.`
  if (first === 'providers') return providerLines(loaded, await approvedSet($)).join('\n')
  if (first === 'reload' || first === 'refresh') {
    // A failed read of the tool definitions is tried again now.
    toolCaptureFailure = undefined
    await loadProviders($)
    await refreshCatalogue($)
    await syncPicker($, runtime, routedRows())
    return `${loaded.errors.length > 0 ? `${loaded.path} does not validate; no declared provider routes:\n${loaded.errors.join('\n')}` : providerLines(loaded, await approvedSet($)).join('\n')}\n\n${await discoveryText($, 'models')}`
  }
  if (first === 'approve') {
    const provider = value ? loaded.config?.providers[value] : undefined
    if (!provider) return `Usage: /rice-models approve <provider>; declared: ${Object.keys(loaded.config?.providers ?? {}).join(', ') || 'none'}`
    await $.store.set(`${TRUST_PREFIX}${fingerprint(provider)}`, true)
    await refreshCatalogue($)
    await syncPicker($, runtime, routedRows())

    return `Approved ${provider.id}: conversations for its models go to ${provider.origin}. A changed address or key command asks again.`
  }
  if (first === 'effort') {
    if (value === 'default') {
      await update($, prefsAtom, prefs => ({ ...prefs, effort: null }))

      return 'Effort back to the Codex default.'
    }
    if (!EFFORTS.includes(value as Effort)) return `Usage: /rice-models effort ${EFFORTS.join('|')}|default`
    await update($, prefsAtom, prefs => ({ ...prefs, effort: value as Effort }))

    return `Routed models think at ${value} effort in this session, unless a request sets its own.`
  }
  if (first === 'helper') {
    if (value !== 'session' && value !== 'once') return 'Usage: /rice-models helper session|once'
    const helper: 'session' | 'once' = value
    await update($, prefsAtom, prefs => ({ ...prefs, helper }))
    preferSession(value === 'session')

    return value === 'session' ? 'Steps go to the session helper (one connection per conversation).' : 'Each step starts its own helper (no local socket).'
  }
  if (first === 'transport') {
    if (value !== 'auto' && value !== 'ws' && value !== 'sse') return 'Usage: /rice-models transport auto|ws|sse'
    await update($, prefsAtom, prefs => ({ ...prefs, transport: value as Transport }))

    return `Routed requests use ${value === 'auto' ? 'a WebSocket, falling back to server-sent events' : value === 'ws' ? 'a WebSocket only' : 'server-sent events only'}.`
  }

  return 'Usage: /rice-models [setup [repair|codex] | search [setup|add|remove|priority] | doctor | status | models | picker [write] | providers | approve <provider> | refresh | reload | opencode [zen|go] [write] | effort <level> | transport auto|ws|sse | helper session|once]'
}

export const register: Register = on => {
  const evaluatorSources = createEvaluatorSources(BUILTIN_AGENTS)
  registerEvaluatorSources(on, evaluatorSources)
  registerEvaluators(on, {
    owner: async ({ agentId, mainModel, session }) => {
      const model = agentId === undefined ? mainModel : agentModels.get(agentId)
      if (!model) throw new Error('The configured evaluator has no verified conversation model.')
      if (claimedRefusal(model) || agentId !== undefined && spawnDecisions.get(agentId)?.family !== CLAUDE_FAMILY && spawnDecisions.has(agentId) && !isRouted(model)) throw new Error('The observed external evaluator model is unavailable.')
      return isRouted(model) ? { target: model, who: agentId ?? 'main', session } : null
    },
    outputLimit,
    refreshCapacity,
    complete: async (port, request, approved, _timeoutMs, signal) => {
      signal.throwIfAborted()
      const remote = targetOf(request.target)?.remote
      if (remote && !approved.includes(remote.fingerprint)) return { isAnswered: false }
      const answer = await collectText(port, { configText: loaded.text, approved, req: request, userAgent: USER_AGENT }, signal)
      signal.throwIfAborted()
      return { isAnswered: answer.error === undefined && ['end_turn', 'stop_sequence'].includes(answer.stopReason ?? '') && answer.text.trim() !== '', text: answer.text }
    },
    node: async () => {
      if (!runtime.executable || runtime.error) throw new Error(runtime.error || 'Node.js 22+ helper is unavailable.')
      return runtime.executable
    },
    sources: async event => evaluatorSources.sources(event),
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    await noteTranscript($, e).catch(() => {})
    const result = await next(e)
    if (result.block || result.preventContinuation || e.session_title || result.sessionTitle || e.source && e.source !== 'user' && e.source !== 'sdk') return result
    const model = await $.session.model()
    if (!isRouted(model)) return result
    let title = fallbackTitle(e.prompt)
    if (['1', 'true'].includes((await $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC') ?? '').toLowerCase())) return { ...result, sessionTitle: title }
    try {
      const answer = await complete($, titleRequest(model, await $.session.id(), e.prompt), 10_000, true)
      next.signal.throwIfAborted()
      if (answer.isAnswered) title = titleAnswer(answer.text) ?? title
    } catch {
      next.signal.throwIfAborted()
      $.ui.log(`${PLUGIN}: session naming used the local prompt title after the selected provider did not return a valid title`, { to: 'debug' })
    }
    return { ...result, sessionTitle: title }
  }).catch(async ($, e, next) => {
    // A failed hook is skipped and the host names the session with its own Claude request.
    let routed = false
    try { routed = isRouted(await $.session.model()) } catch { routed = false }
    if (!routed) return next.called ? {} : next(e)
    const result = next.called ? {} : await next(e)
    return e.session_title || result.sessionTitle ? result : { ...result, sessionTitle: fallbackTitle(e.prompt) }
  })
  // Startup, resume and every compaction name the transcript file; observe only.
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source !== 'compact') mainSnapshot = undefined
    await noteTranscript($, e).catch(() => {})
    return next(e)
  }).catch(($, e, next) => next.called ? {} : next(e))
  on('session.start', async ($, e, next) => {
    mainSnapshot = undefined
    interactiveSession = e.isInteractive
    permissionContextNonce = crypto.randomUUID()
    await $.env.set('RICE_MULTI_MODELS_PERMISSION_CONTEXT_NONCE', permissionContextNonce)
    const started = await next(e)
    // A reloaded module cannot finish a previous module's in-flight provider call.
    for (const row of (await read($, receiptsAtom)).entries) if (row.status === 'preparing') await saveReceipt($, { ...row, status: 'aborted', reason: 'interrupted' }, row)
    // Keep the repair and doctor command available even when runtime checks fail.
    await $.command.register({
      name: 'rice-models',
      description: 'Native model setup, repair, read-only doctor, candidates, approvals and preferences',
      argumentHint: '[setup [repair|codex] | search [setup|add|remove|priority] | doctor | status | models | picker [write] | providers | approve <provider> | refresh | reload | opencode [zen|go] [write] | effort <level> | transport auto|ws|sse | helper session|once]',
    })
    runtime = await detectRuntime($)
    codexDefaults = await readCodexDefaults($)
    await loadProviders($)
    agentModels.clear(); spawnDecisions.clear(); spawnBackground.clear(); liveWorkflowAgents.clear()
    for (const owner of (await read($, ownersAtom)).entries) cacheOwner(owner)
    await refreshCatalogue($)
    // A nested claude process can migrate settings; run it before any judgment
    // is pending so its settings change cannot invalidate one.
    let routedMain = false
    try { routedMain = isRouted(await $.session.model()) } catch {}
    const needsRouting = Boolean(routedFamilies().length || routedMain || Object.keys(loaded.config?.providers ?? {}).length)
    if (needsRouting) {
      void nativePermissionDefaults($).catch(() => {})
      // Ready before the first compaction; a one-shot run reads it only when it compacts.
      if (e.isInteractive) void nativeCompaction($).catch(() => {})
      // The tools' own definitions and agent prompts, ready before the first routed step.
      if (e.isInteractive) void $.tool.list().then(infos => stepTools($, builtinNames(infos)), () => {})
    }
    preferSession((await read($, prefsAtom)).helper !== 'once')
    if (needsRouting) await ensureHelper($)
    const rows = routedRows()
    const picker = runtime.error ? undefined : await syncPicker($, runtime, rows)
    await startupNotice($, e.isInteractive, runtime, picker, rows, defaultModel('codex'), undefined, await capabilitySummary($))

    return started
  })

  // Model-switch decisions and recovery belong to the native host, not an estimated plugin budget.
  on('classic.PreModelSwitch', ($, e, next) => next(e))

  on('classic.PostModelSwitch', async ($, e, next) => {
    await noteTranscript($, e).catch(() => {})
    const switched = await next(e)
    await syncNativeContext($)
    return switched
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      // If the host cuts its short session.end budget, doctor must not retain a success claim.
      lastContinuationStatus = 'clear-pending: deletion not confirmed'
      try {
        const hasRecords = (await $.store.keys()).some(key => key.startsWith(continuationSessionPrefix(e.sessionId)))
        const historyOnly = targetOf(await $.session.model())?.remote?.model.kind === 'openai'
        if (hasRecords || loaded.config?.continuation?.mode === 'durable' && !historyOnly) {
          if (!runtime.executable) throw new Error('Native helper unavailable')
          await withContinuationStore($, runtime.executable, store => clearContinuations(store, e.sessionId))
        }
        lastContinuationStatus = 'cleared'
      } catch {
        lastContinuationStatus = 'clear-failed: durable records may remain'
        $.ui.log(`${PLUGIN}: continuation deletion failed; durable records may remain. Inspect /rice-models doctor.`, { to: 'transcript' })
      }
    }
    if (e.reason === 'clear') for (const row of (await read($, receiptsAtom)).entries) if (['preparing', 'prepared'].includes(row.status)) await saveReceipt($, { ...row, status: 'aborted', reason: 'clear' }, row)
    await syncNativeContext($, true)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await reconcileCompaction($, e.agentId)
    return next(e)
  }).catch(($, e, next) => next.called ? { turnId: e.turnId } : next(e))

  on('prompt.compose', async ($, e, next) => {
    const answer = await next(e)
    const families = familyLines()
    return families.length ? { ...answer, sections: withDiscoverySection(answer.sections, discoveryGuidance(families)) } : answer
  })

  on('classic.ConfigChange', async ($, e, next) => { permissionRevision++; loadedPermissionContext = undefined; loadedInstructionFiles = false; $.ui.invalidate('prompt.context'); return next(e) })
  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    // This fires per conversation with no loop id. A child that omits CLAUDE.md
    // (Explore, Plan) must not strip it from the main loop's judgments, and an
    // unchanged context must not invalidate a pending judgment.
    const text = permissionContext(result)
    const files = (result.instructionFiles?.length ?? 0) > 0
    if (loadedPermissionContext !== undefined && loadedInstructionFiles && !files) return result
    if (text !== loadedPermissionContext) {
      loadedPermissionContext = text
      loadedInstructionFiles = files
      permissionRevision++
    }
    return result
  })
  on('agent.register', async ($, e, next) => {
    const result = await next(e)
    if (result.value) {
      const type = result.value.agent
      const actual = next.trace.find(link => link.plugin === 'engine' && link.tier === 'core' && ['returned', 'passed'].includes(link.outcome) && link.returned?.value?.agent === type)?.received
      if (actual) {
        registered.set(type, { name: actual.name, prompt: actual.prompt, model: actual.model, tools: actual.tools, disallowedTools: actual.disallowedTools,
          ...(typeof actual.effort === 'string' || typeof actual.effort === 'number' ? { effort: actual.effort } : {}), ...(actual.omitClaudeMd ? { omitClaudeMd: true } : {}), ...(actual.hooks ? { hooks: actual.hooks } : {}),
        })
      } else {
        registered.delete(type)
      }
    }
    return result
  })
  on('classic.PreToolUse', async ($, e, next) => {
    const result = await next(e)
    // A hot reload resets module state without a new session.start; the
    // session's nonce survives in the process environment.
    if (!permissionContextNonce) permissionContextNonce = await $.env.get('RICE_MULTI_MODELS_PERMISSION_CONTEXT_NONCE') ?? ''
    const context = consumePermissionContext(result.additionalContext ?? [], { nonce: permissionContextNonce, sessionId: await $.session.id(), toolUseId: e.tool_use_id })
    if (context.proof) toolModes.set(e.tool_use_id, { mode: context.proof.mode, agentId: context.proof.agentId })
    return { ...result, additionalContext: context.remaining }
  })

  // Let native rules and PreToolUse hooks decide the exact action first. A
  // one-shot refusal stops its old implementation before provider extraction.
  on('tool.call', async ($, e, next) => {
    if (e.tool === AGENT_TOOL) {
      try {
        const effort = typeof e.effort === 'string' || typeof e.effort === 'number' ? e.effort : undefined
        await rememberDisplay($, { toolUseId: e.tool_use_id, ...(effort === undefined ? {} : { effort }) })
        return await childHandback($, await agentCall($, e, next))
      } finally { toolModes.delete(e.tool_use_id) }
    }
    if (e.tool !== 'WebSearch' && e.tool !== 'WebFetch') return next(e).finally(() => { toolModes.delete(e.tool_use_id) })
    const initialModel = e.agentId === undefined ? await $.session.model() : agentModels.get(e.agentId)
    if (initialModel === undefined) return { deny: `${PLUGIN}: web tool conversation model is unknown; retry after its next observed turn` }
    if (!isRouted(initialModel)) return next(e).finally(() => { toolModes.delete(e.tool_use_id) })
    const ticket = webToolGate.begin(e)
    try {
      const nativeResult = await next(e)
      const gate = await webToolGate.finish(ticket, nativeResult, (question, options) => $.ui.ask(question, options), next.signal)
      if (!gate.approved) return { deny: gate.reason ?? `${PLUGIN}: the native web tool did not produce an approved replacement; its result was not used` }
      next.signal.throwIfAborted()
      const model = e.agentId === undefined ? await $.session.model() : agentModels.get(e.agentId)
      if (model !== initialModel || !model || !isRouted(model)) return { deny: `${PLUGIN}: the conversation model changed during web-tool approval; retry the action` }
      const remote = targetOf(model)?.remote
      const refused = remote ? await approval($, remote) : undefined
      if (refused) return { deny: refused }
      if (!runtime.executable || runtime.error) return { deny: `${PLUGIN}: web tools need the Node helper; /rice-models setup repair` }
      const wire = await wireFor($, { target: model, system: '', tools: [], transcript: [], who: e.agentId ?? 'main', session: await $.session.id() })
      const mode = e.tool === 'WebSearch' ? 'tool-search' : 'web-fetch'
      const input = gate.input as Omit<PublicWebFetchInput, 'wire'> | PublicWebSearchInput
      const run = await $.process.run([runtime.executable, helperFile($.plugin.root), mode], {
        stdin: JSON.stringify({ ...input, wire, ...(mode === 'tool-search' ? { maxUses: DEFAULT_WEB_SEARCH_MAX_USES } : {}) }), timeoutMs: 120_000,
      })
      next.signal.throwIfAborted()
      if (run.exitCode !== 0 || run.isStdoutTruncated) return { deny: `${PLUGIN}: ${e.tool} did not complete with the selected provider; inspect /rice-models doctor` }
      if (mode === 'web-fetch') {
        const outcome = JSON.parse(run.stdout) as WebFetchOutcome
        if (!outcome || typeof outcome !== 'object') return { deny: `${PLUGIN}: invalid WebFetch helper response` }
        if (!('kind' in outcome)) return { result: outcome }
        if (outcome.kind !== 'native-fallback' || typeof outcome.url !== 'string' || typeof outcome.prompt !== 'string') return { deny: `${PLUGIN}: invalid WebFetch fallback request` }
        try {
          const result = await runFinalNativeFetch(() => runNativeFetch({ url: outcome.url, prompt: outcome.prompt, ...(outcome.offset === undefined ? {} : { offset: outcome.offset }) }, {
              authorize: () => $.session.authorize(),
              fetch: (url, init) => $.http.fetch(url, init),
              checkDestination: async url => {
                const checked = await $.process.run([runtime.executable!, helperFile($.plugin.root), 'web-fetch-check-destination'], { stdin: JSON.stringify({ url }), timeoutMs: 15_000 })
                next.signal.throwIfAborted()
                if (checked.exitCode !== 0 || checked.isStdoutTruncated || checked.stdout.trim() !== JSON.stringify({ ok: true })) throw new Error('WebFetch destination could not be verified.')
              },
            }, next.signal), next.signal)
          return { result }
        } catch (error) {
          next.signal.throwIfAborted()
          if (error instanceof NativeFetchUnavailable && error.code === 'security') return { deny: `${PLUGIN}: native WebFetch returned an unsafe or unverifiable destination; no result was returned` }
          throw error
        }
      }
      const outcome = JSON.parse(run.stdout) as ToolSearchOutcome
      if (outcome.kind === 'answered') {
        $.ui.log(`${PLUGIN}: WebSearch answered via ${outcome.stage}`, { to: 'debug' })
        return { result: outcome.result }
      }
      if (outcome.kind !== 'native-fallback' || !outcome.request) return { deny: `${PLUGIN}: invalid web search helper response` }
      const result = await runNativeSearch(outcome.request, { authorize: () => $.session.authorize(), fetch: (url, init) => $.http.fetch(url, init) }, next.signal)
      $.ui.log(`${PLUGIN}: WebSearch answered via ${outcome.stage}`, { to: 'debug' })
      return { result }
    } finally { webToolGate.end(ticket); toolModes.delete(e.tool_use_id) }
  }).catch((_host, e, next) => ({ deny: e.tool === AGENT_TOOL ? next.called ? `${PLUGIN}: the Agent call failed after native dispatch; it may have started, and was not replayed. Existing transcript retained.` : `${PLUGIN}: the Agent model could not be resolved; no subagent was started` : `${PLUGIN}: the web tool failed; no action was approved or replayed automatically` }))

  on('tool.check', async ($, e, next) => {
    let verdict = await next(e)
    // SubagentHandback's ask is the native classifier's alone; the engine turns
    // any other allow into a deny and the child's report would be withheld.
    if (CLASSIFIER_ONLY_TOOLS.has(e.tool)) return verdict
    const context = e.tool_use_id ? toolModes.get(e.tool_use_id) : undefined
    const model = e.agentId === undefined ? await $.session.model() : agentModels.get(e.agentId)
    if (isRouted(model) && e.tool_use_id && verdict.decision === 'ask' && (!context || context.agentId !== e.agentId)) return { decision: 'deny', reason: `${PLUGIN}: native permission-mode metadata is unavailable; the action was not approved. Check /rice-models setup repair` }
    if (eligiblePermission(verdict, { realToolId: e.tool_use_id, actualMode: context?.mode, modelRouted: isRouted(model), tool: e.tool })) {
      if (!model || context?.agentId !== e.agentId) return { decision: 'deny', reason: `${PLUGIN}: the permission request has no verified conversation owner` }
      next.signal.throwIfAborted()
      const revision = permissionRevision
      // Child raw transcripts may have no opening user row. Human authority
      // belongs to the owning main conversation; the child's prompt and task
      // remain separately labeled constraints, never fabricated user intent.
      const transcript = await $.session.messages()
      if (!Array.isArray(transcript)) return { decision: 'deny', reason: `${PLUGIN}: the permission request has no readable user context` }
      const modeBefore = await mainModeFingerprint($)
      const request = permissionRequest({ target: model, who: e.agentId ?? 'main', session: await $.session.id(), tool: e.tool, input: e.input,
        transcript: permissionIntent(transcript), policy: await effectivePermissionPolicy($), workingDirectory: await $.session.cwd(),
        instructions: await permissionInstructions($, model, e.agentId),
      })
      const judged = await complete($, request, 30_000, true)
      next.signal.throwIfAborted()
      if (revision !== permissionRevision) return { decision: 'deny', reason: `${PLUGIN}: permission policy or loaded constraints changed during the judgment; retry the action` }
      const currentModel = e.agentId === undefined ? await $.session.model() : agentModels.get(e.agentId)
      if (currentModel !== model) return { decision: 'deny', reason: `${PLUGIN}: the conversation model changed during the permission judgment; retry the action` }
      if (await mainModeFingerprint($) !== modeBefore) return { decision: 'deny', reason: `${PLUGIN}: the permission mode changed during the judgment; retry the action` }
      next.signal.throwIfAborted()
      if (revision !== permissionRevision) return { decision: 'deny', reason: `${PLUGIN}: permission policy or loaded constraints changed during the judgment; retry the action` }
      verdict = permissionAnswer(judged)
    }
    const checked = webToolGate.check(e, verdict)
    const carried = e.tool === AGENT_TOOL && e.tool_use_id && checked.decision === 'ask' ? entryOf(await read($, carrierAtom), e.tool_use_id) : undefined
    return carried ? { ...checked, reason: `${checked.reason ? `${checked.reason} ` : ''}${PLUGIN}: this Agent will run on exact model ${JSON.stringify(carried.id)}; ${CARRIER_VALUE} is validation only.` } : checked
  }).catch(($, _e, next) => {
    $.ui.log(`${PLUGIN}: permission judgment ${next.error.kind}: ${(next.error.message ?? 'no message').slice(0, 300)}`, { to: 'debug' })
    return { decision: 'deny', reason: `${PLUGIN}: the selected-provider permission judgment failed; the action was not approved` }
  })

  on('agent.spawn', async ($, e, next) => {
    if (e.resume) {
      // A resumed invocation's content/model is immutable. Observe the host result, never
      // resolve it from today's main model or rewrite it with a fresh Agent request.
      const result = await next(e)
      if (result.agentId && result.model) {
        const effort = (await read($, ownersAtom)).entries.find(owner => owner.id === result.agentId)?.effort
        await rememberOwner($, result.agentId, result.model, e.background, effort)
        await rememberDisplay($, { toolUseId: e.tool_use_id, agentId: result.agentId, model: result.model, ...(effort === undefined ? {} : { effort }) })
        setCapped(agentModels, result.agentId, result.model)
        setCapped(spawnBackground, result.agentId, e.background)
        setCapped(spawnDecisions, result.agentId, { model: result.model, family: familyOf(result.model, familyPorts), explicit: true, reason: 'native resumed invocation model' })
      }
      return result
    }
    const description = unmarkDescription(e.description)
    const picked = pickRequested(await takeCarried($, e.tool_use_id), e.model, e.fork, description.marked)
    if ('deny' in picked) return { deny: picked.deny }
    const definition = e.fork ? undefined : registered.get(e.subagentType) ?? await definitionOf(promptsPort($), memory, e.subagentType)
    // The engine reports a parent's own model, which for a remapped loop (an
    // Explore haiku default, a forked skill alias) is a Claude alias.
    if (e.parentAgentId !== undefined) {
      await restoreOwner($, e.parentAgentId)
      if (!agentModels.has(e.parentAgentId) && (isNativeAlias(e.parentModel) || e.parentModel === 'inherit') && isRouted(await $.session.model())) return { deny: `${PLUGIN}: the nested Agent parent model is unknown; no subagent was started` }
      const owner = agentModels.get(e.parentAgentId)
      if (owner && (claimedRefusal(owner) || spawnDecisions.get(e.parentAgentId)?.family !== CLAUDE_FAMILY && !isRouted(owner))) return { deny: `${PLUGIN}: the nested Agent parent model is unavailable; no subagent was started` }
    }
    const parentModel = e.parentAgentId === undefined
      ? stepModel(e.parentModel, await $.session.model(), false, tiers(), familyPorts)
      : agentModels.get(e.parentAgentId) ?? e.parentModel
    const decision = spawnDecision({ parentModel, requested: picked.requested, definitionModel: definition?.model, fork: e.fork }, tiers(), familyPorts)
    $.ui.log(`${PLUGIN}: spawn ${e.subagentType} from ${parentModel}: ${decision.model ?? 'native resolution'} (${decision.reason})`, { to: 'debug' })
    if (picked.exact !== undefined && decision.model !== picked.exact) return { deny: `${PLUGIN}: Agent model ${picked.exact} cannot be run by this session (${decision.reason}); no subagent was started` }
    const pending = (await read($, agentDisplayAtom)).entries.find(entry => entry.toolUseId === e.tool_use_id)
    const parentEffort = e.parentAgentId === undefined ? undefined : (await read($, ownersAtom)).entries.find(owner => owner.id === e.parentAgentId)?.effort
    const resolved = decision.model ?? e.model
    const effort = e.fork ? parentEffort : resolved && isRouted(resolved) ? routedEffort(resolved, pending?.effort ?? definition?.effort, (await read($, prefsAtom)).effort) : pending?.effort ?? definition?.effort
    const restored = { ...e, description: resolved === undefined ? description.text : agentLabel(description.text, resolved, effort) }
    const result = await next(decision.model !== undefined && decision.model !== e.model ? { ...restored, model: decision.model } : restored)
    if (picked.exact !== undefined && result.model !== picked.exact) $.ui.log(`${PLUGIN}: Agent model ${picked.exact} was requested but the subagent started on ${result.model}`, { to: 'transcript' })
    if (result.agentId) {
      const observed = e.fork ? parentModel : result.model ?? decision.model
      if (observed) {
        await rememberOwner($, result.agentId, observed, e.background, effort)
        await rememberDisplay($, { toolUseId: e.tool_use_id, agentId: result.agentId, model: observed, ...(effort === undefined ? {} : { effort }) })
      }
      setCapped(spawnDecisions, result.agentId, observed ? { ...decision, model: observed, family: familyOf(observed, familyPorts) } : decision)
      if (observed) setCapped(agentModels, result.agentId, observed)
      if (e.workflow) setCapped(liveWorkflowAgents, result.agentId, true, 256)
      if (observed) await syncNativeContext($)
      setCapped(spawnBackground, result.agentId, e.background)
    }
    return result
  }).catch((_host, e, next) => next.called ? next(e) : { deny: `${PLUGIN}: the Agent model could not be resolved; no subagent was started` })

  // Preserve native rendering and behavior; only public display props change. There is no
  // public AgentList/agent-row renderer or child identity on Spinner in 2.1.310.
  on('ui.render', async ($, e, next) => {
    if (e.component === 'ToolUse' && e.props.tool === AGENT_TOOL && e.props.input && typeof e.props.input === 'object' && !Array.isArray(e.props.input)) {
      const entry = (await read($, agentDisplayAtom)).entries.find(row => row.toolUseId === e.props.tool_use_id)
      if (entry?.model) {
        const input = e.props.input as Record<string, unknown>
        return next({ ...e, props: { ...e.props, input: { ...input, description: agentLabel(typeof input['description'] === 'string' ? input['description'] : 'Agent', entry.model, entry.effort) } } })
      }
    } else if (e.component === 'ToolProgress') {
      const entry = (await read($, agentDisplayAtom)).entries.find(row => row.toolUseId === e.props.tool_use_id)
      if (entry?.model) return next({ ...e, props: { ...e.props, hint: agentLabel(e.props.hint, entry.model, entry.effort) } })
    } else if (e.component === 'UserMessage' && e.props.task?.id) {
      const owner = (await read($, ownersAtom)).entries.find(row => row.id === e.props.task!.id)
      if (owner) return next({ ...e, props: { ...e.props, text: agentLabel(e.props.text, owner.model, owner.effort) } })
    }
    return next(e)
  })

  // A workflow agent leaves the window data when its turn completes: no list row ends it.
  on('turn.complete', { agentId: /[\s\S]+/ }, async ($, e, next) => {
    try {
      return await next(e)
    } finally {
      if (e.agentId !== undefined && liveWorkflowAgents.delete(e.agentId)) await syncNativeContext($)
    }
  })

  on('tool.describe', async ($, e, next) => {
    const answer = await next(e)
    described.set(e.tool, { description: answer.description, isDeferred: answer.isDeferred ?? e.isDeferred })

    return e.tool === AGENT_TOOL ? { ...answer, description: withDescriptionSuffix(answer.description, exactModelIds(catalogue, loaded)) } : answer
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined && recordedMainModel !== e.model) await noteMainModel($, e.model)
    try {
      e = { ...e, model: await stepOwnerModel($, e) }
    } catch (error) {
      // A step whose family cannot be resolved is refused, never sent to
      // Claude: a hook failure would otherwise run the native request.
      return yield* refusedStep($, e, `${PLUGIN}: the model family of this conversation could not be resolved (${error instanceof Error ? error.message : String(error)}); nothing was sent`)
    }
    if (e.agentId !== undefined) await rememberOwner($, e.agentId, e.model, spawnBackground.get(e.agentId), isRouted(e.model) ? routedEffort(e.model, e.effort, (await read($, prefsAtom)).effort) : e.effort)
    // Ended subagents leave the window data at the next step of any loop.
    if (isRouted(e.model) || agentModels.size) await syncNativeContext($)
    await reconcileCompaction($, e.agentId, e.model)
    const claimed = claimedRefusal(e.model)
    if (claimed) return yield* refusedStep($, e, claimed)
    if (!isRouted(e.model)) return yield* next(e)

    return yield* routedStep($, e, next.signal)
  }).catch(async function* ($, e, next) {
    // The host skips a failed hook and sends the step to Claude. A routed
    // conversation is refused instead; a native one keeps native behavior.
    if (next.called) return yield* next(e)
    let routed = isRouted(e.model)
    if (!routed) {
      try { routed = isRouted((e.agentId === undefined ? undefined : agentModels.get(e.agentId)) ?? await $.session.model()) } catch { routed = true }
    }
    if (!routed) return yield* next(e)
    return yield* refusedStep($, e, `${PLUGIN}: this step failed before it was sent (${next.error.message}); nothing was sent to Claude`)
  })

  on('session.compact', async ($, e, next) => {
    const model = e.agentId === undefined ? await $.session.model() : agentModels.get(e.agentId)
    if (model === undefined) return { skip: `${PLUGIN}: subagent active model is unknown; compaction was not attempted, original transcript retained. Its next observed turn establishes the model after reload.` }
    const claimed = claimedRefusal(model)
    if (claimed || e.agentId !== undefined && spawnDecisions.get(e.agentId)?.family !== CLAUDE_FAMILY && spawnDecisions.has(e.agentId) && !isRouted(model)) return { skip: `${PLUGIN}: the observed compaction model is unavailable; original transcript retained` }
    if (!isRouted(model)) return next(e)
    const who = e.agentId ?? 'main'
    // Public reads can include archived history, or cap the complete event at 4096
    // rows. Validate the shared suffix, then compare like-for-like public snapshots.
    const snapshot = await $.session.messages(e.agentId === undefined ? {} : { agentId: e.agentId })
    const overlap = Array.isArray(snapshot) ? Math.min(snapshot.length, e.messages.length) : 0
    if (!Array.isArray(snapshot) || !overlap || snapshot.length < e.messages.length && snapshot.length !== 4096 || await historyDigest(snapshot.slice(-overlap)) !== await historyDigest(e.messages.slice(-overlap))) return { skip: `${PLUGIN}: compaction context changed before preparing; original transcript retained` }
    const now = await $.clock.now()
    const receipt: CompactionReceipt = { id: crypto.randomUUID(), session: await $.session.id(), owner: compactOwner(e.agentId), model, trigger: e.trigger, status: 'preparing', at: now, expiresAt: now + RECEIPT_TTL_MS, source: await historyDigest(snapshot) }
    await saveReceipt($, receipt)
    const skip = async (text: string, reason: CompactionReceipt['reason'] = 'failed') => {
      await saveReceipt($, { ...receipt, status: 'aborted', reason }, receipt)
      return { skip: text }
    }
    try {
      next.signal.throwIfAborted()
      // Core's configured PreCompact hooks do not run for this replacement. Never
      // execute their shell ourselves, or silently compact around a blocking policy.
      let hooks: unknown
      try { hooks = (await $.settings.read()).hooks } catch { return skip(`${PLUGIN}: effective compaction policy is unreadable; replacement refused, original transcript retained`, 'configured-policy') }
      if (compactionPolicyBlock(hooks)) return skip(`${PLUGIN}: configured PreCompact policy requires native dispatch, which the replacement cannot preserve; no hook was bypassed or manually run, original transcript retained`, 'configured-policy')
      // The engine cannot send its own summary request to another provider, so this hook sends it: the engine's
      // prompt and summary format (learned from the installed claude), over the conversation as the engine holds
      // it, to the conversation's own provider. Nothing is sent to Claude, and a failure keeps the transcript.
      let template: CompactionTemplate
      try {
        template = await nativeCompaction($)
      } catch (error) {
        return skip(`${PLUGIN}: Claude Code's own compaction text could not be read from the installed claude (${error instanceof Error ? error.message : String(error)}); ${model} was not asked to compact, original transcript retained`)
      }
      next.signal.throwIfAborted()
      const history = await $.session.messages({ as: 'api', ...(e.agentId === undefined ? {} : { agentId: e.agentId }) })
      if (!Array.isArray(history)) return skip(`${PLUGIN}: the conversation of ${who} is unreadable (${history.deny}); original transcript retained`)
      const apiSnapshot = JSON.stringify(history)
      let api: readonly ApiMessage[] = history
      if (snapshot.length < e.messages.length) {
        const path = e.agentId === undefined ? await transcriptPath($) : undefined
        if (!path) return skip(`${PLUGIN}: capped compaction context has no observed main-session transcript path; original transcript retained`)
        try {
          api = persistedCompactSource(await $.fs.read(path), e.messages, receipt.session, api)
        } catch (error) {
          return skip(`${PLUGIN}: ${error instanceof Error ? error.message : 'persisted compaction context is unreadable'}; original transcript retained`)
        }
      }
      await ensureFreshCapacity($)
      next.signal.throwIfAborted()
      const budget = summaryInputCapacity(model)
      let retained: readonly CompactMessage[]
      try {
        retained = retainedTail(e.messages, budget === null ? {} : { retainChars: Math.floor(budget * 0.15 * 3.5) })
      } catch (error) {
        return skip(`${PLUGIN}: ${error instanceof Error ? error.message : String(error)}; original transcript retained`)
      }
      const outputBound = outputLimit(model)
      const prefs = await read($, prefsAtom)
      const effort = prefs.effort ?? (model.startsWith('codex/') ? codexDefaults.effort : undefined)
      const system = rewriteMain((await $.prompt.compose({ model })).sections, identityLine(targetOf(model)?.model ?? model, targetOf(model)?.label ?? 'codex'))
      const prompt = compactionPrompt(template, e.instructions)
      const session = await $.session.id()
      // This is the existing native-dispatched summary's bounded source projection, not a
      // request guard or a compaction/retry controller. Ordinary turns are never pre-aborted.
      const room = Math.floor(budget * 0.9 * 3.5) - system.length - prompt.length - 2048
      const fitted = fitTranscript(api as ApiMessage[], Math.max(room, 0))
      if (!fitted.fits) return skip(`${PLUGIN}: the summary request does not fit ${model}'s bounded input capacity with intact tool pairs; original transcript retained`)
      const coverage = fitted.omitted || fitted.clipped ? fitted.explanation : ''
      const instructions = coverage ? `Source coverage notice: ${coverage}. Only summarize content actually supplied. Never reconstruct excluded content.\n\n${prompt}` : prompt
      const request: StepRequest = { target: model, system, tools: [], transcript: withUserText(fitted.messages, instructions), who, session, ...(effort === undefined ? {} : { effort }), native: { maxTokens: outputBound } }
      if (coverage) $.ui.log(`${PLUGIN}: compaction request coverage: ${coverage}`, { to: 'transcript' })
      const answer = await complete($, request, undefined, true, next.signal)
      receipt.usage = answer.usage
      next.signal.throwIfAborted()
      if (!answer.isAnswered) return skip(`${PLUGIN}: ${model} compaction failed (${answer.reason}); original transcript retained`, answer.reason === 'aborted' ? 'cancelled' : 'failed')
      const body = summaryBody(answer.text)
      if (body === undefined) return skip(`${PLUGIN}: ${model} returned no summary; original transcript retained`)
      // A context/model switch, superseding attempt or cancellation cannot install a
      // summary of an older snapshot. Original tail objects keep their opaque handles.
      const active = await $.session.messages(e.agentId === undefined ? {} : { agentId: e.agentId })
      // Public appends can be API-only meta rows. The projected snapshot alone
      // misses them, including while native headless compaction is awaiting I/O.
      const activeApi = await $.session.messages({ as: 'api', ...(e.agentId === undefined ? {} : { agentId: e.agentId }) })
      if (await $.session.id() !== receipt.session || (e.agentId === undefined ? await $.session.model() : agentModels.get(e.agentId)) !== model || !Array.isArray(active) || await historyDigest(active) !== receipt.source || JSON.stringify(activeApi) !== apiSnapshot) return skip(`${PLUGIN}: compaction context changed while preparing; stale result discarded, original transcript retained`, 'stale-context')
      const cite = e.agentId === undefined ? await transcriptPath($) : undefined
      const messages = [{ role: 'user' as const, text: summaryMessage(template, coverage ? `[Compaction source coverage: ${coverage}. Excluded content was not summarized.]\n\n${body}` : body, cite), toolUses: [] }, ...retained]
      next.signal.throwIfAborted()
      const expected = await historyDigest(messages)
      if (!await saveReceipt($, { ...receipt, status: 'prepared', expected, expectedCount: messages.length, expectedWasPresent: await historyContains(snapshot, expected, messages.length) }, receipt)) return { skip: `${PLUGIN}: compaction attempt was superseded; stale result discarded, original transcript retained` }
      return { messages }
    } catch {
      return skip(`${PLUGIN}: compaction ${next.signal.aborted ? 'cancelled' : 'failed'}; original transcript retained`, next.signal.aborted ? 'cancelled' : 'failed')
    }
  }).catch(() => ({ skip: `${PLUGIN}: compaction routing check failed; original transcript retained` }))


  on('model.complete', async ($, e, next) => {
    // This public contract names its model explicitly. It carries no loop provenance:
    // do not replace a child's or another plugin's choice with the main model.
    if (claimedRefusal(e.model)) return { value: { isAnswered: false, reason: 'api-error', status: null, error: 'invalid_request', usage: NO_USAGE } }
    if (!isRouted(e.model)) return next(e)
    const maxTokens = e.maxTokens ?? 1024
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 64000) return { value: { isAnswered: false, reason: 'api-error', status: null, error: 'invalid_request', usage: NO_USAGE } }
    const req: StepRequest = {
      target: e.model, system: e.system ?? '', tools: [],
      transcript: [{ role: 'user', content: [{ type: 'text', text: e.prompt }] }],
      ...(e.effort === undefined ? {} : { effort: e.effort }),
      who: auxiliaryOwner('complete', next.origin), session: await $.session.id(), native: { maxTokens },
    }
    return { value: await complete($, req, e.timeoutMs, false, next.signal) }
  }).catch((_host, _e, next) => ({ value: next.signal.aborted ? { isAnswered: false, reason: 'aborted', usage: NO_USAGE } : { isAnswered: false, reason: 'api-error', status: null, error: 'unknown', usage: NO_USAGE } }))

  on('model.classify', async ($, e, next) => {
    // Omitted model means the documented native small-model default, not guessed ownership.
    const model = e.options?.model
    if (model && claimedRefusal(model)) return { deny: `${PLUGIN}: the explicit classifier model is unavailable; no native fallback` }
    if (!isRouted(model)) return next(e)
    if (e.labels.length === 0) return { value: undefined }
    const contract = classifierRequest(await nativeClassifier($), e.text, e.labels)
    const result = await complete($, {
      target: model, system: contract.system, tools: [],
      transcript: [{ role: 'user', content: contract.prompt }],
      who: auxiliaryOwner('classify', next.origin), session: await $.session.id(), native: { maxTokens: Math.min(contract.maxTokens, outputLimit(model)) },
    }, undefined, true, next.signal)
    if (!result.isAnswered) throw new Error(`${PLUGIN}: routed classification failed (${result.reason})`)
    const label = result.text.trim()
    return { value: e.labels.includes(label) ? label : undefined }
  }).catch(() => ({ deny: `${PLUGIN}: routed classification failed; no native provider fallback` }))

  on('model.fork', async ($, e, next) => {
    const model = await $.session.model()
    if (claimedRefusal(model)) return { value: { isAnswered: false, reason: 'api-error', status: null, error: 'invalid_request', usage: NO_USAGE } }
    if (!isRouted(model)) return next(e)
    const snapshot = mainSnapshot
    if (!snapshot || snapshot.session !== await $.session.id()) return { value: { isAnswered: false, reason: 'nothing-to-fork' } }
    // Fork the last sent prefix, not today's transcript, prompt, model, or child loop.
    return { value: await complete($, { ...snapshot, tools: [], transcript: withUserText(snapshot.transcript, e.prompt), who: 'fork' }, undefined, false, next.signal) }
  }).catch((_host, _e, next) => ({ value: next.signal.aborted ? { isAnswered: false, reason: 'aborted', usage: NO_USAGE } : { isAnswered: false, reason: 'api-error', status: null, error: 'unknown', usage: NO_USAGE } }))

  on('command.run', { command: 'rice-models' }, async ($, e) => ({ text: await runCommand($, e.args) }))
}
