import { NativeFetchUnavailable } from './native-fetch.ts'

export type WebFetchFinalTier = 'native-fallback' | 'direct-selected-extraction'
export type WebFetchFinalResult<T> = { tier: WebFetchFinalTier; result: T }

/** Run direct selected extraction only after the host native WebFetch is unavailable. */
export async function runNativeThenDirect<T>(native: () => Promise<T>, direct: () => Promise<T>, signal: AbortSignal): Promise<WebFetchFinalResult<T>> {
  try {
    const result = await native()
    signal.throwIfAborted()
    return { tier: 'native-fallback', result }
  } catch (error) {
    signal.throwIfAborted()
    if (!(error instanceof NativeFetchUnavailable) || error.code === 'security') throw error
    return { tier: 'direct-selected-extraction', result: await direct() }
  }
}
