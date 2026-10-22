// Final means terminal: no retrieval or selected-model extraction may follow native Claude.
export async function runFinalNativeFetch<T>(native: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  const result = await native()
  signal.throwIfAborted()
  return result
}
