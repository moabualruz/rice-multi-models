type Waiter = { grant: () => void; signal: AbortSignal; abort: () => void }
type Account = { active: number; waiting: Waiter[] }

export function codexStepLimit(env: Record<string, string | undefined> = process.env): number {
  const value = env.RICE_CODEX_MAX_IN_FLIGHT ?? '6'
  if (!/^(?:[0-9]|1[0-5])$/.test(value)) throw new Error('RICE_CODEX_MAX_IN_FLIGHT must be 0 (disabled) or an integer from 1 to 15')
  return Number(value)
}

/** FIFO admission per account inside one helper process, including cancellation while queued. */
export class AccountSteps {
  private readonly accounts = new Map<string, Account>()

  acquire(key: string, limit: number, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted()
    if (!Number.isInteger(limit) || limit < 0 || limit > 15) throw new Error('Codex account limit must be an integer from 0 to 15')
    if (limit === 0) return Promise.resolve(() => {})
    const account = this.accounts.get(key) ?? { active: 0, waiting: [] }
    this.accounts.set(key, account)
    return new Promise((resolve, reject) => {
      const grant = () => {
        account.active++
        let released = false
        resolve(() => {
          if (released) return
          released = true
          account.active--
          const next = account.waiting.shift()
          if (next) {
            next.signal.removeEventListener('abort', next.abort)
            next.grant()
          } else if (account.active === 0) this.accounts.delete(key)
        })
      }
      if (account.active < limit && account.waiting.length === 0) {
        grant()
        return
      }
      const waiter: Waiter = {
        grant,
        signal,
        abort: () => {
          const index = account.waiting.indexOf(waiter)
          if (index < 0) return
          account.waiting.splice(index, 1)
          signal.removeEventListener('abort', waiter.abort)
          if (account.active === 0 && account.waiting.length === 0) this.accounts.delete(key)
          reject(signal.reason)
        },
      }
      account.waiting.push(waiter)
      signal.addEventListener('abort', waiter.abort, { once: true })
      if (signal.aborted) waiter.abort()
    })
  }
}

export const codexAccounts = new AccountSteps()
