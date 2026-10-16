import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

export const SUPPORTED_NATIVE_VERSIONS = new Set(['2.1.299'])
export type NativeSelection = { format: 1; executable: string; claudeVersion: string }
export const NATIVE_SELECTION_REPAIR = 'Run /rice-models setup native <absolute path to a qualified Claude executable>.'
export class NativeSelectionError extends Error {
  readonly code = 'RICE_NATIVE_SELECTION'
}

export function selectionPath(configDir: string): string {
  return join(configDir, 'rice-multi-models', 'native-launcher.json')
}

export function absoluteNativePath(value: string): boolean {
  return isAbsolute(value) && !/[\0\r\n]/.test(value)
}

function regularSelection(path: string): void {
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024) {
    throw new NativeSelectionError(`Native launcher selection is not a regular bounded file. ${NATIVE_SELECTION_REPAIR}`)
  }
}

export function readSelection(configDir: string): NativeSelection | undefined {
  const path = selectionPath(configDir)
  try {
    regularSelection(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new NativeSelectionError(`Cannot read the saved native Claude selection. ${NATIVE_SELECTION_REPAIR}`)
  }
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<NativeSelection> | null
    if (value?.format !== 1 || typeof value.executable !== 'string' || !absoluteNativePath(value.executable)
      || typeof value.claudeVersion !== 'string' || !SUPPORTED_NATIVE_VERSIONS.has(value.claudeVersion)) throw new Error('invalid selection')
    return { format: 1, executable: value.executable, claudeVersion: value.claudeVersion }
  } catch {
    throw new NativeSelectionError(`The saved native Claude selection is invalid or unsupported. ${NATIVE_SELECTION_REPAIR}`)
  }
}

/** Called only after the native preload handshake and host-version check succeed. */
export function saveSelection(configDir: string, selection: NativeSelection): void {
  if (!absoluteNativePath(selection.executable) || !SUPPORTED_NATIVE_VERSIONS.has(selection.claudeVersion)) {
    throw new NativeSelectionError(`Refused an unqualified native Claude selection. ${NATIVE_SELECTION_REPAIR}`)
  }
  const path = selectionPath(configDir)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  try { regularSelection(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(selection, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    renameSync(temporary, path)
  } finally { rmSync(temporary, { force: true }) }
}
