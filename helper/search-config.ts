import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { editSearchConfig, MAX_SEARCH_CONFIG_BYTES, parseSearchConfig, parseSearchEdit } from '../hooks/search-config.ts'
import type { SearchConfig, SearchConfigurationResult } from '../hooks/search-config.ts'

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const code = (error: unknown): string | undefined => object(error) && typeof error.code === 'string' ? error.code : undefined

async function read(file: string): Promise<SearchConfigurationResult> {
  try {
    const before = await lstat(file, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MAX_SEARCH_CONFIG_BYTES)) throw new Error('unsafe-file')
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const opened = await handle.stat({ bigint: true })
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > BigInt(MAX_SEARCH_CONFIG_BYTES)) throw new Error('changed-file')
      const bytes = Buffer.alloc(MAX_SEARCH_CONFIG_BYTES + 1)
      let length = 0
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, length)
        if (result.bytesRead === 0) break
        length += result.bytesRead
      }
      if (length > MAX_SEARCH_CONFIG_BYTES) throw new Error('large-file')
      const checked = parseSearchConfig(bytes.subarray(0, length).toString('utf8'))
      return { ok: checked.errors.length === 0, ...checked }
    } finally { await handle.close() }
  } catch (error) {
    if (code(error) === 'ENOENT') return { ok: true, ...parseSearchConfig(undefined) }
    return { ok: false, error: 'search.json is not a readable regular file within the 64 KiB limit; nothing was overwritten.' }
  }
}

async function atomicWrite(file: string, config: SearchConfig): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`
  let owned = false
  try {
    const handle = await open(temporary, 'wx', 0o600)
    owned = true
    try { await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`); await handle.sync() } finally { await handle.close() }
    await rename(temporary, file)
  } finally { if (owned) await rm(temporary, { force: true }).catch(() => {}) }
}

/** Status is read-only. Each edit rereads under one plugin-owned lock. */
export async function searchConfiguration(input: unknown): Promise<SearchConfigurationResult> {
  if (!object(input) || Object.keys(input).some(key => !['configDir', 'edit'].includes(key)) || typeof input.configDir !== 'string'
    || !path.isAbsolute(input.configDir) || /[\0\r\n]/.test(input.configDir)
    || process.platform === 'win32' && !/^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(input.configDir)) return { ok: false, error: 'Search configuration requires an absolute configDir and a valid edit.' }
  const edit = input.edit === undefined ? undefined : parseSearchEdit(input.edit)
  if (input.edit !== undefined && !edit) return { ok: false, error: 'Invalid search edit. Use only endpoint details and credential references, with no key values.' }
  const directory = path.join(input.configDir, 'rice-multi-models'), file = path.join(directory, 'search.json')
  if (!edit) return read(file)
  const lock = path.join(directory, '.search-config.lock')
  let locked = false
  try {
    await mkdir(directory, { recursive: true })
    const deadline = Date.now() + 3000
    while (!locked) {
      try { await mkdir(lock); locked = true } catch (error) {
        if (code(error) !== 'EEXIST') throw error
        if (Date.now() >= deadline) return { ok: false, error: 'Another search configuration edit is running. Retry after it finishes; if no session is editing, remove the stale rice-multi-models/.search-config.lock directory.' }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    }
    const current = await read(file)
    if (!current.ok || !current.config) return current
    const next = editSearchConfig(current.config, edit)
    if (next.errors.length) return { ok: false, ...next }
    const changed = JSON.stringify(current.config) !== JSON.stringify(next.config)
    if (changed) await atomicWrite(file, next.config)
    return { ok: true, changed, config: next.config }
  } catch { return { ok: false, error: 'The search configuration could not be saved; no other configuration was changed.' } }
  finally { if (locked) await rm(lock, { recursive: true }).catch(() => {}) }
}
