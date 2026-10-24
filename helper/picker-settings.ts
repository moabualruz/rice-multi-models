import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export type PickerSyncInput = { configDir: string; rows: { model: string; label: string; description?: string }[]; modelSettings?: Record<string, Record<string, unknown>>; env?: Record<string, string> }
export type PickerSyncResult = { ok: boolean; changed: boolean; count: number; path: string; preserved?: number; error?: string }
type Json = Record<string, unknown>
type Ownership = { version: 1; rows: Json[]; edited: string[]; modelSettings?: Record<string, Json>; env?: Record<string, string> }
/** The keys of Claude's native `modelSettings.<id>` this mod fills from provider data. */
const NATIVE_SETTING_KEYS = ['autoCompactWindow', 'maxEffortLevel'] as const
/** Claude's environment keys for non-Claude models this mod fills from provider data. */
const NATIVE_ENV_KEYS = ['CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'CLAUDE_CODE_MODEL_CAPABILITIES'] as const
const object = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const canonical = (v: unknown): string => JSON.stringify(v, (_key, value) => object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value)

/** Pre-0.6 had no ownership file. Recognize its complete generated signature,
 * rather than treating a provider prefix or a Sonnet alias as ownership. */
function legacyGenerated(row: unknown): row is Json {
  if (!object(row) || Object.keys(row).sort().join(',') !== 'behavesAs,description,label,model' || row.behavesAs !== 'claude-sonnet-4-6') return false
  if (typeof row.model !== 'string' || typeof row.label !== 'string' || typeof row.description !== 'string') return false
  const slash = row.model.indexOf('/')
  if (slash < 1 || slash === row.model.length - 1) return false
  const provider = row.model.slice(0, slash)
  const model = row.model.slice(slash + 1)
  if (provider === 'codex') return /^.+ \(Codex\)$/.test(row.label) && /^ChatGPT subscription via rice-multi-models(?:, \d+k context)?$/.test(row.description)
  return row.label === `${model} (${provider})` && /^(?:openai|responses|anthropic|gemini|bedrock) endpoint https?:\/\/\S+ via rice-multi-models(?:, \d+k context)?$/.test(row.description)
}

async function readJson(file: string, absent: Json): Promise<Json> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (!object(parsed)) throw new Error('not an object')
    return parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return absent
    throw new Error(`${path.basename(file)} is malformed or unreadable; nothing was overwritten`)
  }
}

/** Windows reports a directory pending deletion, or a file another process holds open, with these codes. */
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY'])
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function atomicWrite(file: string, data: unknown): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    for (let attempt = 0; ; attempt++) {
      try { await rename(temp, file); break } catch (error) {
        if (process.platform !== 'win32' || !TRANSIENT.has((error as NodeJS.ErrnoException).code ?? '') || attempt >= 20) throw error
        await pause(25)
      }
    }
  } finally { await rm(temp, { force: true }).catch(() => {}) }
}

/** Serializes startup writers, rereads under the lock, and owns only exact rows it wrote. */
export async function syncPicker(input: PickerSyncInput): Promise<PickerSyncResult> {
  if (!input || typeof input.configDir !== 'string' || !path.isAbsolute(input.configDir) || !Array.isArray(input.rows) || input.rows.some(row => !object(row) || typeof row.model !== 'string' || typeof row.label !== 'string')) {
    return { ok: false, changed: false, count: 0, path: '', error: 'sync-picker requires an absolute configDir and valid rows' }
  }
  const file = path.join(input.configDir, 'settings.json')
  const record = path.join(input.configDir, '.rice-multi-models-picker.json')
  const lock = path.join(input.configDir, '.rice-multi-models-picker.lock')
  let locked = false
  try {
    await mkdir(input.configDir, { recursive: true })
    const deadline = Date.now() + 10_000
    do {
      try { await mkdir(lock); locked = true; break } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? ''
        if (code !== 'EEXIST' && !(process.platform === 'win32' && TRANSIENT.has(code))) throw error
        if (Date.now() >= deadline) throw new Error('Picker sync lock is busy; retry /rice-models setup repair. If no session is running, remove the stale .rice-multi-models-picker.lock directory')
        await pause(25)
      }
    } while (!locked)
    const settings = await readJson(file, {})
    const ownedJson = await readJson(record, { version: 1, rows: [], edited: [] })
    if (ownedJson.version !== 1 || !Array.isArray(ownedJson.rows) || ownedJson.rows.some(row => !object(row) || typeof row.model !== 'string') || !Array.isArray(ownedJson.edited) || ownedJson.edited.some(id => typeof id !== 'string')) throw new Error('Picker ownership record is malformed; nothing was overwritten')
    const ownership = ownedJson as unknown as Ownership
    if (settings.modelPicker !== undefined && !object(settings.modelPicker)) throw new Error('settings.json modelPicker is malformed; nothing was overwritten')
    const picker = (settings.modelPicker ?? {}) as Json
    if (picker.options !== undefined && !Array.isArray(picker.options)) throw new Error('settings.json modelPicker.options is malformed; nothing was overwritten')
    const options = (picker.options ?? []) as unknown[]
    const edited = new Set(ownership.edited)
    const old = new Map(ownership.rows.map(row => [row.model as string, row]))
    for (const row of options) {
      if (legacyGenerated(row) && !old.has(row.model as string) && !edited.has(row.model as string)) old.set(row.model as string, row)
    }
    const retained: unknown[] = []
    for (const row of options) {
      const id = object(row) && typeof row.model === 'string' ? row.model : undefined
      const ours = id ? old.get(id) : undefined
      if (id && ours && !edited.has(id)) {
        if (canonical(row) === canonical(ours)) continue
        edited.add(id)
      }
      retained.push(row)
    }
    const occupied = new Set(retained.flatMap(row => object(row) && typeof row.model === 'string' ? [row.model] : []))
    const added: Json[] = []
    for (const row of input.rows) {
      if (occupied.has(row.model) || edited.has(row.model)) continue
      added.push({ ...row })
      occupied.add(row.model)
    }
    // Claude's per-model settings: a key is filled only while it still holds what this mod last wrote there.
    if (settings.modelSettings !== undefined && !object(settings.modelSettings)) throw new Error('settings.json modelSettings is malformed; nothing was overwritten')
    const wanted = object(input.modelSettings) ? input.modelSettings : {}
    const ownedSettings = object(ownership.modelSettings) ? ownership.modelSettings : {}
    const modelSettings: Json = { ...((settings.modelSettings ?? {}) as Json) }
    const nextOwnedSettings: Record<string, Json> = {}
    // A per-model value replaces this file's own top-level one for that model, so provider data only ever lowers it.
    const levels = ['low', 'medium', 'high', 'xhigh', 'max']
    const belowOwn = (key: string, value: unknown): unknown => {
      const own = settings[key]
      if (value === undefined || own === undefined) return value
      if (key === 'maxEffortLevel') return levels.includes(own as string) && levels.indexOf(own as string) <= levels.indexOf(value as string) ? undefined : value
      return typeof own === 'number' && typeof value === 'number' && own <= value ? undefined : value
    }
    // Claude keys a model's settings case-insensitively, without a trailing date and then without a trailing
    // [1m], so the person's own entry under another spelling of the same model, whatever keys it holds (an
    // empty one included: the mod never leaves one), is theirs and the mod adds no key beside it.
    const sameModel = (id: string) => id.toLowerCase().replace(/-\d{8}$/, '').replace(/\[1m\]$/, '')
    const theirs = (id: string) => Object.entries(modelSettings).some(([other, entry]) =>
      other !== id && sameModel(other) === sameModel(id) && object(entry) && (Object.keys(entry).length === 0 || Object.keys(entry).some(key => !(object(ownedSettings[other]) && ownedSettings[other][key] === entry[key]))))
    for (const id of new Set([...Object.keys(ownedSettings), ...Object.keys(wanted)])) {
      const existing = modelSettings[id] === undefined ? {} : object(modelSettings[id]) ? { ...(modelSettings[id] as Json) } : undefined
      if (existing === undefined) continue
      const ours = object(ownedSettings[id]) ? ownedSettings[id] : {}
      const want = object(wanted[id]) ? wanted[id] : {}
      const mine: Json = {}
      for (const key of NATIVE_SETTING_KEYS) {
        if (existing[key] !== ours[key]) continue
        const value = theirs(id) ? undefined : belowOwn(key, want[key])
        if (value === undefined) delete existing[key]
        else { existing[key] = value; mine[key] = value }
      }
      if (Object.keys(existing).length) modelSettings[id] = existing
      else delete modelSettings[id]
      if (Object.keys(mine).length) nextOwnedSettings[id] = mine
    }
    // Claude's environment for non-Claude models, loaded at launch from the same file: a key is filled only
    // while it holds what this mod last wrote, so the person's own value always stays.
    if (settings.env !== undefined && !object(settings.env)) throw new Error('settings.json env is malformed; nothing was overwritten')
    const wantedEnv = object(input.env) ? input.env : {}
    const ownedEnv = object(ownership.env) ? ownership.env : {}
    const env: Json = { ...((settings.env ?? {}) as Json) }
    const nextOwnedEnv: Record<string, string> = {}
    for (const key of NATIVE_ENV_KEYS) {
      if (env[key] !== ownedEnv[key]) continue
      const value = wantedEnv[key]
      if (typeof value === 'string') { env[key] = value; nextOwnedEnv[key] = value }
      else delete env[key]
    }
    const settingsChanged = canonical(modelSettings) !== canonical(settings.modelSettings ?? {}) || canonical(env) !== canonical(settings.env ?? {})
    const ownedOf = (rows: Json[]): Ownership => ({ version: 1, rows, edited: [...edited].sort(), ...(Object.keys(nextOwnedSettings).length ? { modelSettings: nextOwnedSettings } : {}), ...(Object.keys(nextOwnedEnv).length ? { env: nextOwnedEnv } : {}) })
    // Never create a picker block just to hold nothing.
    if (settings.modelPicker === undefined && retained.length === 0 && added.length === 0 && !settingsChanged) {
      if (canonical(ownership) !== canonical(ownedOf([]))) await atomicWrite(record, ownedOf([]))
      return { ok: true, changed: false, count: 0, path: file, preserved: 0 }
    }
    const next = {
      ...settings,
      ...(settings.modelPicker !== undefined || retained.length || added.length ? { modelPicker: { ...picker, options: [...retained, ...added] } } : {}),
      ...(settings.modelSettings !== undefined || Object.keys(modelSettings).length ? { modelSettings } : {}),
      ...(settings.env !== undefined || Object.keys(env).length ? { env } : {}),
    }
    const nextOwned = ownedOf(added)
    const changed = canonical(settings) !== canonical(next)
    // Write settings first: a crash can lose ownership, but never claim and erase a user's row.
    if (changed) await atomicWrite(file, next)
    if (canonical(ownership) !== canonical(nextOwned)) await atomicWrite(record, nextOwned)
    return { ok: true, changed, count: added.length, path: file, preserved: retained.length }
  } catch (error) {
    return { ok: false, changed: false, count: 0, path: file, error: error instanceof Error ? error.message : 'Picker synchronization failed' }
  } finally { if (locked) await rm(lock, { recursive: true, force: true }).catch(() => {}) }
}
