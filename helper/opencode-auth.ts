import { readFile } from 'node:fs/promises'

async function authObject(file: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('OpenCode auth file is not a JSON object')
  return parsed as Record<string, unknown>
}

/** Lists entry names only. The doctor never calls the secret-reading function. */
export async function opencodeEntries(file: string): Promise<string[]> {
  try { return Object.keys(await authObject(file)).sort() } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error('OpenCode auth file is malformed or unreadable')
  }
}

/** Called only by the approved provider's key command. Never logs or persists the key. */
export async function opencodeKey(tier: string, file: string): Promise<string> {
  const keys = tier === 'zen' ? ['opencode', 'opencode-go'] : tier === 'go' ? ['opencode-go', 'opencode'] : undefined
  if (!keys) throw new Error('Usage: opencode-key zen|go <authFile>')
  const auth = await authObject(file).catch(() => { throw new Error('OpenCode auth file is missing, malformed or unreadable; run opencode auth login') })
  for (const name of keys) {
    const entry = auth[name]
    if (entry && typeof entry === 'object' && !Array.isArray(entry) && typeof (entry as Record<string, unknown>).key === 'string') {
      const key = (entry as { key: string }).key.trim()
      if (key && !/[\r\n]/.test(key)) return key
    }
  }
  throw new Error('OpenCode console key is missing; run opencode auth login')
}
