// Node 22+ helper entry point. Source imports are inert; the bundled file dispatches only when run.
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { StepWire } from '../hooks/protocol.ts'
import { failedStep } from '../hooks/protocol.ts'
import { runStep } from './run.ts'
import { serve } from './serve.ts'
import { client } from './client.ts'
import { setupInfo, setupCodex } from './setup-info.ts'
import { syncPicker } from './picker-settings.ts'
import { opencodeEntries, opencodeKey } from './opencode-auth.ts'
import { discoverCodex } from './codex-catalog.ts'
import { discover } from './discover.ts'
import { searchConfiguration } from './search-config.ts'
import { runToolSearch } from './search/tool-search.ts'
import { runWebFetch } from './web-fetch.ts'
import { captureCompaction } from './native-compaction.ts'
import { captureTools } from './native-tools.ts'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

async function once(lifetime?: AbortSignal): Promise<void> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, abort)
  lifetime?.addEventListener('abort', abort, { once: true })
  if (lifetime?.aborted) abort()
  try {
    let wire: StepWire
    try {
      wire = JSON.parse(await readStdin()) as StepWire
    } catch (error) {
      for (const event of failedStep(`rice-multi-models: the step request did not parse: ${error instanceof Error ? error.message : String(error)}`)) process.stdout.write(`${JSON.stringify(event)}\n`)
      process.exitCode = 2
      return
    }
    try {
      for await (const event of runStep(wire, controller.signal)) {
        if (lifetime?.aborted) break
        process.stdout.write(`${JSON.stringify(event)}\n`)
      }
    } catch (error) {
      if (!lifetime?.aborted) for (const event of failedStep(`rice-multi-models: ${error instanceof Error ? error.message : String(error)}`)) process.stdout.write(`${JSON.stringify(event)}\n`)
      process.exitCode = 1
    }
  } finally {
    lifetime?.removeEventListener('abort', abort)
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.off(signal, abort)
  }
}

export async function main(lifetime?: AbortSignal): Promise<void> {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('rice-multi-models requires Node 22 or newer')
  const mode = process.argv[2] ?? 'once'
  if (mode === 'once') await once(lifetime)
  else if (mode === 'serve') serve(lifetime)
  else if (mode === 'client') {
    if (!process.argv[3]) throw new Error('client requires a socket path')
    process.exitCode = await client(process.argv[3], await readStdin(), lifetime)
  } else if (mode === 'discover') {
    process.stdout.write(`${JSON.stringify(await discover(JSON.parse(await readStdin()), lifetime))}\n`)
  } else if (mode === 'discover-codex') {
    const controller = new AbortController()
    const abort = () => controller.abort()
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, abort)
    lifetime?.addEventListener('abort', abort, { once: true })
    if (lifetime?.aborted) abort()
    try { process.stdout.write(`${JSON.stringify(await discoverCodex({ signal: controller.signal }))}\n`) } finally {
      lifetime?.removeEventListener('abort', abort)
      for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.off(signal, abort)
    }
  } else if (mode === 'doctor') process.stdout.write(`${JSON.stringify(await setupInfo())}\n`)
  else if (mode === 'setup-codex') {
    const result = await setupCodex()
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (!result.ok) process.exitCode = 1
  } else if (mode === 'sync-picker') {
    const result = await syncPicker(JSON.parse(await readStdin()))
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (!result.ok) process.exitCode = 1
  } else if (mode === 'search-config') {
    const result = await searchConfiguration(JSON.parse(await readStdin()))
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (!result.ok) process.exitCode = 1
  } else if (mode === 'tool-search' || mode === 'web-fetch') {
    const controller = new AbortController()
    const abort = () => controller.abort()
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, abort)
    lifetime?.addEventListener('abort', abort, { once: true })
    if (lifetime?.aborted) abort()
    try {
      const input = JSON.parse(await readStdin())
      const result = mode === 'tool-search' ? await runToolSearch(input, controller.signal) : await runWebFetch(input, controller.signal)
      process.stdout.write(`${JSON.stringify(result)}\n`)
    } finally {
      lifetime?.removeEventListener('abort', abort)
      for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.off(signal, abort)
    }
  } else if (mode === 'capture-compaction' || mode === 'capture-tools') {
    // The installed claude's own compaction text, or its tool definitions and agent prompts for the session's
    // built-in tools; the caller caches them per version. Ending the session stops it.
    const controller = new AbortController()
    const abort = () => controller.abort()
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, abort)
    lifetime?.addEventListener('abort', abort, { once: true })
    if (lifetime?.aborted) abort()
    try {
      if (mode === 'capture-compaction') process.stdout.write(`${JSON.stringify({ ok: true, template: await captureCompaction(controller.signal) })}\n`)
      else {
        const input = JSON.parse(await readStdin()) as { tools?: unknown }
        if (!Array.isArray(input.tools) || !input.tools.every(name => typeof name === 'string')) throw new Error('capture-tools reads {"tools": [names]} from its standard input')
        process.stdout.write(`${JSON.stringify({ ok: true, capture: await captureTools(input.tools, controller.signal) })}\n`)
      }
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`)
      process.exitCode = 1
    } finally {
      lifetime?.removeEventListener('abort', abort)
      for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.off(signal, abort)
    }
  } else if (mode === 'opencode-entries') {
    if (!process.argv[3]) throw new Error('opencode-entries requires an auth file')
    process.stdout.write(`${JSON.stringify(await opencodeEntries(process.argv[3]))}\n`)
  } else if (mode === 'opencode-key') {
    if (!process.argv[3] || !process.argv[4]) throw new Error('opencode-key requires a tier and auth file')
    // This is the sole intentional secret-output mode, used only by the credential runner.
    process.stdout.write(await opencodeKey(process.argv[3], process.argv[4]))
  } else {
    process.stderr.write(`rice-multi-models helper: unknown mode ${mode}\n`)
    process.exitCode = 2
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  // Abort routed work and await its cleanup instead of exiting ahead of detached worker termination.
  const lifetime = new AbortController()
  process.stdout.on('error', () => { process.exitCode = 1; lifetime.abort() })
  await main(lifetime.signal).catch(() => {
    process.stderr.write('rice-multi-models: helper command failed\n')
    process.exitCode = 1
  })
  if (lifetime.signal.aborted) process.exitCode = 1
}
