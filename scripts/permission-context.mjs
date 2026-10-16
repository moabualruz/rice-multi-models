#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const PREFIX = 'RICE_MULTI_MODELS_PERMISSION_CONTEXT:'
const MODES = new Set(['default', 'manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'])
const MAX_INPUT_BYTES = 1024 * 1024
const id = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value)

/** Native hook metadata only. Tool arguments, credentials and permission decisions never leave here. */
export function permissionContext(input, nonce) {
  if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{24,128}$/.test(nonce)) return {}
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.hook_event_name !== 'PreToolUse'
    || !id(input.session_id) || !id(input.tool_use_id) || !MODES.has(input.permission_mode)
    || (input.agent_id !== undefined && !id(input.agent_id))) return {}
  const context = {
    nonce, sessionId: input.session_id, toolUseId: input.tool_use_id,
    ...(input.agent_id === undefined ? {} : { agentId: input.agent_id }), mode: input.permission_mode,
  }
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: PREFIX + JSON.stringify(context) } }
}

async function run() {
  const chunks = []
  let size = 0, oversized = false
  try {
    for await (const chunk of process.stdin) {
      size += chunk.length
      if (size > MAX_INPUT_BYTES) oversized = true
      if (!oversized) chunks.push(chunk)
    }
    if (oversized) return {}
    return permissionContext(JSON.parse(Buffer.concat(chunks).toString('utf8')), process.env.RICE_MULTI_MODELS_PERMISSION_CONTEXT_NONCE)
  } catch { return {} }
}

let isMain = false
try { isMain = Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { /* Importers need not have a filesystem entry point. */ }
if (isMain) {
  process.stdout.write(`${JSON.stringify(await run())}\n`)
}
