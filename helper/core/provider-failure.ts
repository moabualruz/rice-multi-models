import { oneLine } from '../styx/errors.ts'

const TRANSIENT = new Set(['server_error', 'internal_server_error', 'internal_error', 'rate_limit_exceeded', 'rate_limit_error', 'too_many_requests', 'concurrency_limit_exceeded', 'concurrent_request_limit_exceeded', 'overloaded_error', 'service_unavailable', 'temporarily_unavailable', 'timeout', 'request_timeout'])
const PERMANENT = new Set(['authentication_error', 'invalid_api_key', 'unauthorized', 'permission_denied', 'permission_error', 'invalid_request_error', 'invalid_request', 'insufficient_quota', 'billing_hard_limit_reached', 'content_policy_violation', 'model_not_found'])
const TRANSIENT_CLOSE = new Set([1000, 1001, 1005, 1006, 1011, 1012, 1013, 1014])
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

export type FailureInfo = { event: string; code?: string; type?: string; status?: number; closeCode?: number; retryAfterMs?: number; transient?: boolean }

export class ProviderFailure extends Error {
  readonly transient: boolean
  constructor(message: string, readonly info: FailureInfo) {
    super(oneLine(message, 300))
    const labels = [info.code, info.type].filter((value): value is string => !!value)
    this.transient = labels.some(label => PERMANENT.has(label)) ? false
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
    return new ProviderFailure(string(outer.message) || string(inner.message) || 'OpenAI stream failed', {
      event: string(outer.type) || 'error',
      code: string(inner.code) || string(outer.code) || undefined,
      type: string(inner.type) || string(outer.error_type) || undefined,
      status: typeof status === 'number' ? status : undefined,
      retryAfterMs: retryAfterMs(headers['retry-after'] ?? outer.retry_after ?? inner.retry_after),
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
export const MAX_RETRY_WAIT_MS = 30_000

/** A Retry-After outside the bounded retry window is not shortened: fail rather than retry early. */
export function retryDelay(failure: ProviderFailure, attempt: number, random = Math.random): number | null {
  const delay = Math.max(500 * 2 ** (attempt - 1) * (1 + Math.max(0, Math.min(1, random()))), failure.info.retryAfterMs ?? 0)
  return delay <= MAX_RETRY_WAIT_MS ? delay : null
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
