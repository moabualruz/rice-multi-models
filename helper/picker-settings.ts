import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export type PickerSyncInput = { configDir: string; rows: { model: string; label: string; description?: string }[] }
export type PickerSyncResult = { ok: boolean; changed: boolean; count: number; path: string; preserved?: number; error?: string }
type Json = Record<string, unknown>
type Ownership = { version: 1; rows: Json[]; edited: string[] }
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
  const worker = provider === 'agy' ? 'Antigravity' : provider === 'grok' ? 'Grok' : undefined
  if (worker && row.label === `${model} (${worker})` && row.description === `${worker} CLI as a worker with its own tools, via rice-multi-models`) return true
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

async function atomicWrite(file: string, data: unknown): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await rename(temp, file)
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
    const deadline = Date.now() + 3000
    do {
      try { await mkdir(lock); locked = true; break } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (Date.now() >= deadline) throw new Error('Picker sync lock is busy; retry /rice-models setup repair. If no session is running, remove the stale .rice-multi-models-picker.lock directory')
        await new Promise(resolve => setTimeout(resolve, 25))
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
    const next = { ...settings, modelPicker: { ...picker, options: [...retained, ...added] } }
    const nextOwned: Ownership = { version: 1, rows: added, edited: [...edited].sort() }
    const changed = canonical(settings) !== canonical(next)
    // Write settings first: a crash can lose ownership, but never claim and erase a user's row.
    if (changed) await atomicWrite(file, next)
    if (canonical(ownership) !== canonical(nextOwned)) await atomicWrite(record, nextOwned)
    return { ok: true, changed, count: added.length, path: file, preserved: retained.length }
  } catch (error) {
    return { ok: false, changed: false, count: 0, path: file, error: error instanceof Error ? error.message : 'Picker synchronization failed' }
  } finally { if (locked) await rm(lock, { recursive: true, force: true }).catch(() => {}) }
}
