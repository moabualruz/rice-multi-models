import type { StepEvent, StepRequest } from '../../hooks/protocol.ts'

/** Provider APIs have different stop support. Enforce the host's exact strings locally too. */
export async function* nativeContracts(events: AsyncIterable<StepEvent>, constraints: StepRequest['native']): AsyncGenerator<StepEvent> {
  const stops = constraints?.stopSequences ?? []
  const keep = Math.max(0, ...stops.map(stop => stop.length - 1))
  let pending = '', tools = 0
  const flush = (): StepEvent[] => {
    const text = pending; pending = ''
    return text ? [{ type: 'text', text }] : []
  }
  for await (const event of events) {
    if (event.type === 'text' && stops.length) {
      pending += event.text
      const positions = stops.map(stop => pending.indexOf(stop)).filter(index => index >= 0)
      if (positions.length) {
        pending = pending.slice(0, Math.min(...positions))
        yield* flush(); yield { type: 'stop', reason: 'stop_sequence' }; return
      }
      const deliver = Math.max(0, pending.length - keep)
      if (deliver) { yield { type: 'text', text: pending.slice(0, deliver) }; pending = pending.slice(deliver) }
      continue
    }
    if (event.type === 'tool_use' && constraints?.toolChoice?.disable_parallel_tool_use && ++tools > 1) throw new Error('provider returned parallel tools contrary to the native request')
    if (event.type !== 'usage' && event.type !== 'limits' && event.type !== 'stats') yield* flush()
    yield event
  }
  yield* flush()
}
