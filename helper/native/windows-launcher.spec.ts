import { expect, test } from 'bun:test'
import { WINDOWS_LAUNCHER_MARKER, windowsLauncher } from './windows-launcher.ts'

test('the Windows launcher quotes its fixed runtime and adjacent entry while preserving caller arguments', () => {
  const launcher = windowsLauncher('C:\\Program Files\\Node\\node.exe')
  expect(launcher.startsWith(WINDOWS_LAUNCHER_MARKER)).toBe(true)
  expect(launcher).toContain('setlocal DisableDelayedExpansion\r\n')
  expect(launcher).toContain('"C:\\Program Files\\Node\\node.exe" "%~dp0rice-claude.mjs" %*\r\n')
  expect(launcher).toEndWith('exit /b %errorlevel%\r\n')
})

test('the fixed Node path cannot introduce batch interpolation or extra commands', () => {
  expect(windowsLauncher('C:\\Users\\name%literal!\\node.exe')).toContain('name%%literal!')
  for (const value of ['node.exe', '\\runtime\\node.exe', 'C:\\node.exe\r\nwhoami', 'C:\\a"b\\node.exe', 'C:\\node.exe\0']) {
    expect(() => windowsLauncher(value)).toThrow('absolute Node executable')
  }
})
