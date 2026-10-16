import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accountCache, prepareAccounts } from './account-cache.ts'

test('account cache composition is optional for old installs and required for newer installed accounts', () => {
  const config = mkdtempSync(join(tmpdir(), 'rice-account-compose-'))
  try {
    expect(accountCache(config, config)).toBeUndefined()
    mkdirSync(join(config, 'plugins'))
    const root = join(config, 'account plugin')
    mkdirSync(join(root, '.claude-plugin'), { recursive: true })
    const ledger = join(config, 'plugins/installed_plugins.json')
    const install = { scope: 'user', installPath: root }
    writeFileSync(ledger, JSON.stringify({ plugins: { 'rice-session-accounts@rice-local-repair': [install] } }))
    expect(accountCache(config, config)).toBeUndefined()
    writeFileSync(ledger, JSON.stringify({ plugins: { 'rice-session-accounts@rice-mods': [install] } }))
    const manifest = join(root, '.claude-plugin/plugin.json')
    writeFileSync(manifest, JSON.stringify({ version: '0.2.0' }))
    expect(accountCache(config, config)).toBeUndefined()
    writeFileSync(manifest, JSON.stringify({ version: '0.3.0' }))
    expect(() => accountCache(config, config)).toThrow('native cache support is missing')
    mkdirSync(join(root, 'native'))
    const path = join(root, 'native/cache.mjs')
    writeFileSync(path, '')
    expect(() => accountCache(config, config)).toThrow('startup support is missing')
    writeFileSync(join(root, 'native/startup.mjs'), '')
    expect(accountCache(config, config)).toBe(path)
  } finally { rmSync(config, { recursive: true, force: true }) }
})

test('account startup selection uses the installed helper before native args and preserves literal prompts', async () => {
  const config = mkdtempSync(join(tmpdir(), 'rice-account-startup-'))
  try {
    expect(await prepareAccounts(undefined, ['--', '--account=literal-prompt'], { HOME: config }, config)).toEqual({ args: ['--', '--account=literal-prompt'], env: { HOME: config } })
    await expect(prepareAccounts(undefined, ['--account', 'personal'], {}, config)).rejects.toThrow('requires Rice Accounts')
    const cache = join(config, 'cache.mjs')
    writeFileSync(join(config, 'startup.mjs'), `export function prepareAccountLaunch(args, env, config) {
      if (args[0] !== '--account=personal') throw new Error('fixture private bytes');
      return {args:args.slice(1),env:{...env,CLAUDE_SECURESTORAGE_CONFIG_DIR:config+'/isolated-personal'}};
    }`)
    expect(await prepareAccounts(cache, ['--account=personal', '--resume', 'owned-session'], { CLAUDE_CONFIG_DIR: config }, config)).toEqual({ args: ['--resume', 'owned-session'], env: { CLAUDE_CONFIG_DIR: config, CLAUDE_SECURESTORAGE_CONFIG_DIR: config + '/isolated-personal' } })
    await expect(prepareAccounts(cache, ['--account', 'unknown'], {}, config)).rejects.toThrow('could not prepare')
  } finally { rmSync(config, { recursive: true, force: true }) }
})
