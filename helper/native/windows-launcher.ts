import { absoluteNativePath } from './native-runtime.ts'

export const WINDOWS_LAUNCHER_MARKER = '@echo off\r\nrem rice-multi-models installed launcher\r\n'

/** Use the verified Node runtime without depending on cmd's PATH or delayed expansion. */
export function windowsLauncher(node: string): string {
  if (!absoluteNativePath(node, 'win32') || /"/.test(node)) throw new Error('the Windows launcher requires an absolute Node executable')
  const executable = node.replace(/%/g, '%%')
  return `${WINDOWS_LAUNCHER_MARKER}setlocal DisableDelayedExpansion\r\n"${executable}" "%~dp0rice-claude.mjs" %*\r\nexit /b %errorlevel%\r\n`
}
