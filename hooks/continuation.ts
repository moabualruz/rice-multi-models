// Operational protocol extras only. The native transcript remains the conversation owner.
import type { Kind } from './config'
import type { Placed } from '../helper/styx/history'

export type ContinuationPolicy = { mode: 'off' } | { mode: 'durable'; maxAgeSeconds: number }
export const CONTINUATION_OFF: ContinuationPolicy = { mode: 'off' }
export const CONTINUATION_BUDGET = 2 * 1024 * 1024
export const CONTINUATION_RECORD_MAX = 128 * 1024
export const CONTINUATION_OWNER_MAX = 256
export const CONTINUATION_PREFIX = 'continuation:v1:'
export type ContinuationAdapter = Kind | 'codex-responses'
export type ContinuationRecord = {
  version: 1
  owner: string
  scope: string
  adapter: ContinuationAdapter
  createdAt: number
  expiresAt: number
  boundary: { turnId: string; index: number }
  prefixLength: number
  prefixDigest: string
  contextDigest: string
  dispatchedDigest: string
  callsDigest: string
  assistantDigest: string
  calls: readonly { id: string; providerId?: string }[]
  blocks: readonly Placed[]
  integrity: string
}

// Exhaustive wire contracts, not configured provider names. A new adapter must declare and test its contract.
const CONTRACTS: Readonly<Record<ContinuationAdapter, 'none' | 'opaque'>> = {
  openai: 'none', responses: 'opaque', 'codex-responses': 'opaque', gemini: 'opaque', anthropic: 'opaque', bedrock: 'opaque',
}
export function continuationCapability(adapter: ContinuationAdapter) {
  return { adapter, history: 'native replay', extra: CONTRACTS[adapter],
    detail: CONTRACTS[adapter] === 'none' ? 'no extra protocol state required'
      : adapter === 'anthropic' || adapter === 'bedrock' ? 'redacted/empty-text signed extras only; plaintext signed state blocked' : 'exact-scope opaque provider protocol extras',
  } as const
}

export function parseContinuation(value: unknown, errors: string[]): ContinuationPolicy {
  if (value === undefined) return CONTINUATION_OFF
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push('continuation: must be { mode: "off" } or { mode: "durable", maxAgeSeconds: 1..86400 }')
    return CONTINUATION_OFF
  }
  const v = value as Record<string, unknown>
  if (Object.keys(v).some(key => key !== 'mode' && key !== 'maxAgeSeconds') ||
      v['mode'] !== 'off' && v['mode'] !== 'durable' ||
      v['mode'] === 'off' && v['maxAgeSeconds'] !== undefined ||
      v['mode'] === 'durable' && (!Number.isSafeInteger(v['maxAgeSeconds']) || Number(v['maxAgeSeconds']) < 1 || Number(v['maxAgeSeconds']) > 86400)) {
    errors.push('continuation: off by default; durable requires an explicit maxAgeSeconds from 1 to 86400 after owner policy review')
    return CONTINUATION_OFF
  }
  return v['mode'] === 'durable' ? { mode: 'durable', maxAgeSeconds: Number(v['maxAgeSeconds']) } : CONTINUATION_OFF
}

export function continuationStatus(policy: ContinuationPolicy, adapters: readonly ContinuationAdapter[], last = 'not used', expiredRecordsRemoved = 0) {
  return { mode: policy.mode, history: 'native replay', capabilities: [...new Set(adapters)].map(continuationCapability),
    maxAgeSeconds: policy.mode === 'durable' ? policy.maxAgeSeconds : null,
    budgetBytes: CONTINUATION_BUDGET, recordMaxBytes: CONTINUATION_RECORD_MAX, recordsPerOwner: CONTINUATION_OWNER_MAX, status: last, expiredRecordsRemoved,
    privacy: 'plugin-wide native store; logical owner separation, not host-enforced isolation',
    cleanup: 'read-time expiry; serialized expiry cleanup; synchronous session clear; no active-owner eviction',
    policy: 'owner review required before real-data activation; 24h is a configurable proposal ceiling, not approved retention',
  }
}

export const continuationOwnerPrefix = (session: string, owner: string) => `${CONTINUATION_PREFIX}${encodeURIComponent(session)}:${encodeURIComponent(owner)}:`
export const continuationSessionPrefix = (session: string) => `${CONTINUATION_PREFIX}${encodeURIComponent(session)}:`
