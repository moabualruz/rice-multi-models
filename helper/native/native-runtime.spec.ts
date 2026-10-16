import { expect, test } from 'bun:test'
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { absoluteNativePath, readSelection, saveSelection, selectionPath } from './native-runtime.ts'

const selected = { format: 1 as const, executable: resolve(tmpdir(), 'qualified runtime', 'claude'), claudeVersion: '2.1.299' }

test('a verified selection persists atomically as private state in the active config directory', () => {
  const config = mkdtempSync(join(tmpdir(), 'rice-native-selection-'))
  try {
    expect(readSelection(config)).toBeUndefined()
    saveSelection(config, selected)
    expect(readSelection(config)).toEqual(selected)
    if (process.platform !== 'win32') expect(lstatSync(selectionPath(config)).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(config, 'rice-multi-models'))).toEqual(['native-launcher.json'])
    expect(() => saveSelection(config, { ...selected, claudeVersion: '2.1.300' })).toThrow('unqualified')
    expect(readSelection(config)).toEqual(selected)
  } finally { rmSync(config, { recursive: true, force: true }) }
})

test('malformed, relative and unsupported saved selections refuse rather than disappearing', () => {
  const config = mkdtempSync(join(tmpdir(), 'rice-native-selection-'))
  try {
    saveSelection(config, selected)
    for (const text of ['{not-json', 'null', JSON.stringify({ ...selected, executable: 'claude' }), JSON.stringify({ ...selected, claudeVersion: '2.1.300' })]) {
      writeFileSync(selectionPath(config), text)
      expect(() => readSelection(config)).toThrow('/rice-models setup native')
      expect(readFileSync(selectionPath(config), 'utf8')).toBe(text)
    }
  } finally { rmSync(config, { recursive: true, force: true }) }
})

test('selection reads and writes refuse symbolic links without changing their targets', () => {
  const config = mkdtempSync(join(tmpdir(), 'rice-native-selection-'))
  try {
    saveSelection(config, selected)
    const target = join(config, 'unrelated.json')
    writeFileSync(target, 'unrelated content')
    rmSync(selectionPath(config))
    symlinkSync(target, selectionPath(config))
    expect(() => readSelection(config)).toThrow('/rice-models setup native')
    expect(() => saveSelection(config, selected)).toThrow('/rice-models setup native')
    expect(readFileSync(target, 'utf8')).toBe('unrelated content')
  } finally { rmSync(config, { recursive: true, force: true }) }
})

test('explicit setup accepts absolute paths with spaces and rejects shell-relative or multiline values', () => {
  expect(absoluteNativePath('/private/qualified runtime/claude', 'darwin')).toBe(true)
  for (const path of ['claude', '~/claude', './claude', '/runtime/claude\nother', '/runtime/claude\0']) expect(absoluteNativePath(path)).toBe(false)
})

test('Windows runtime selections require a drive-qualified or UNC path', () => {
  for (const path of ['C:\\Program Files\\Claude\\claude.exe', 'C:/Users/name/claude.exe', '\\\\server\\share\\claude.exe']) expect(absoluteNativePath(path, 'win32')).toBe(true)
  for (const path of ['\\runtime\\claude.exe', 'C:claude.exe', 'claude.exe', '/runtime/claude.exe', 'C:\\claude.exe\nother']) expect(absoluteNativePath(path, 'win32')).toBe(false)
})
