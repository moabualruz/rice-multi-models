import { oneLine, openaiFailureCause } from '../styx/errors.ts'
import type { StepFailureCause } from '../../hooks/protocol.ts'

const TRANSIENT = new Set(['server_error', 'internal_server_error', 'internal_error', 'rate_limit_exceeded', 'rate_limit_error', 'too_many_requests', 'concurrency_limit_exceeded', 'concurrent_request_limit_exceeded', 'overloaded_error', 'service_unavailable', 'temporarily_unavailable', 'timeout', 'request_timeout'])
const PERMANENT = new Set(['authentication_error', 'invalid_api_key', 'unauthorized', 'permission_denied', 'permission_error', 'invalid_request_error', 'invalid_request', 'insufficient_quota', 'billing_hard_limit_reached', 'content_policy_violation', 'model_not_found'])
const TRANSIENT_CLOSE = new Set([1000, 1001, 1005, 1006, 1011, 1012, 1013, 1014])
// Provider-side saturation ("server_is_overloaded", "model at capacity", 503/529): recovers in minutes, not seconds.
const OVERLOAD = /overload|capacity|unavailable/i
const record = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
const string = (value: unknown): string => typeof value === 'string' ? value : ''

export function retryAfterMs(value: unknown, now = Date.now()): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const text = String(value).trim()
  if (!text) return undefined
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const ms = Number(text) * 1000
    return Number.isFinite(ms) ? ms : undefined
  }
  const date = Date.parse(text)
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined
}

export type FailureInfo = { event: string; code?: string; type?: string; status?: number; closeCode?: number; retryAfterMs?: number; transient?: boolean; cause?: StepFailureCause }

export class ProviderFailure extends Error {
  readonly transient: boolean
  readonly overloaded: boolean
  constructor(message: string, readonly info: FailureInfo) {
    super(oneLine(message, 300))
    const labels = [info.code, info.type].filter((value): value is string => !!value)
    this.overloaded = info.cause !== 'context_overflow' && !labels.some(label => PERMANENT.has(label))
      && (labels.some(label => OVERLOAD.test(label)) || info.status === 503 || info.status === 529 || OVERLOAD.test(message))
    this.transient = info.cause === 'context_overflow' || labels.some(label => PERMANENT.has(label)) ? false
      : this.overloaded ? true
      : info.status !== undefined
        ? info.status === 408 || info.status === 429 || (info.status >= 500 && info.status <= 599)
        : info.closeCode !== undefined
          ? TRANSIENT_CLOSE.has(info.closeCode)
          : labels.some(label => TRANSIENT.has(label)) || (labels.length === 0 && (info.event === 'response.failed' || info.event === 'error')) || info.transient === true
  }

  static event(event: unknown): ProviderFailure {
    const outer = record(event)
    const response = record(outer.response)
    const inner = record(outer.error ?? response.error)
    const status = outer.status ?? outer.status_code ?? inner.status ?? inner.status_code
    const headers = record(outer.headers)
    const cause = openaiFailureCause(inner) ?? openaiFailureCause(outer)
    return new ProviderFailure(string(outer.message) || string(inner.message) || 'OpenAI stream failed', {
      event: string(outer.type) || 'error',
      code: string(inner.code) || string(outer.code) || undefined,
      type: string(inner.type) || string(outer.error_type) || undefined,
      status: typeof status === 'number' ? status : undefined,
      retryAfterMs: retryAfterMs(headers['retry-after'] ?? outer.retry_after ?? inner.retry_after),
      ...(cause ? { cause } : {}),
    })
  }

  finalText(attempts: number): string {
    const label = (value: string | undefined) => value && (TRANSIENT.has(value) || PERMANENT.has(value)) ? value : oneLine(value ?? 'unknown', 100)
    const metadata = [`event=${label(this.info.event)}`, `code=${label(this.info.code)}`, `type=${label(this.info.type)}`]
    if (this.info.status !== undefined) metadata.push(`HTTP ${this.info.status}`)
    if (this.info.closeCode !== undefined) metadata.push(`close=${this.info.closeCode}`)
    return `${metadata.join(', ')}; ${attempts} attempt${attempts === 1 ? '' : 's'}: ${this.message}`
  }
}

export const MAX_ATTEMPTS = 3
/** Provider overload gets a longer schedule (about 2, 4, 8, 16, 30 s) before the step fails. */
export const OVERLOAD_MAX_ATTEMPTS = 6
export const MAX_RETRY_WAIT_MS = 30_000

export function maxAttempts(failure: ProviderFailure): number {
  return failure.overloaded ? OVERLOAD_MAX_ATTEMPTS : MAX_ATTEMPTS
}

/** A Retry-After outside the bounded retry window is not shortened: fail rather than retry early. */
export function retryDelay(failure: ProviderFailure, attempt: number, random = Math.random): number | null {
  const after = failure.info.retryAfterMs ?? 0
  if (after > MAX_RETRY_WAIT_MS) return null
  const base = failure.overloaded ? 2000 : 500
  const backoff = Math.min(base * 2 ** (attempt - 1) * (1 + Math.max(0, Math.min(1, random()))), MAX_RETRY_WAIT_MS)
  return Math.max(backoff, after)
}

export function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}
