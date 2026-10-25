export type NativeToolVerdict = {
  decision: 'allow' | 'ask' | 'deny'
  reason?: string
  rule?: string
  hook?: string
  setting?: string
  ceiling?: 'allow' | 'ask' | 'deny'
  decider?: string
}

export type ToolGateCall = { tool: string; tool_use_id: string; agentId?: string }
export type ToolGateTicket = Readonly<ToolGateCall & { nonce: string }>
export type ToolGateCheck = { tool: string; tool_use_id?: string; agentId?: string; input: unknown }
export type ToolGateResult = { approved: true; input: unknown } | { approved: false; reason?: string }
export type ToolGateAsk = (question: string, options: readonly string[]) => Promise<string>

type Held = {
  ticket: ToolGateTicket
  checked?: { verdict: NativeToolVerdict; input: unknown; serializable: boolean }
  repeated: boolean
  refused: boolean
}

const keyOf = (call: { tool: string; tool_use_id?: string; agentId?: string }) => JSON.stringify([call.tool, call.tool_use_id, call.agentId ?? null])
const stoppedReason = (ticket: ToolGateTicket) => `rice-multi-models stopped this tool before execution (${ticket.nonce})`
const denied = (reason?: string): ToolGateResult => reason ? { approved: false, reason } : { approved: false }

async function askOnce(ask: ToolGateAsk, question: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false
  let abort: (() => void) | undefined
  try {
    const canceled = signal ? new Promise<undefined>(resolve => {
      abort = () => resolve(undefined)
      signal.addEventListener('abort', abort, { once: true })
    }) : undefined
    const answer = ask(question, ['Allow once', 'Deny'])
    const result = canceled ? await Promise.race([answer, canceled]) : await answer
    return !signal?.aborted && result === 'Allow once'
  } catch { return false }
  finally { if (abort) signal?.removeEventListener('abort', abort) }
}

/** Stop only our own real call after native checks; substitute no persistent permission grant. */
export function createToolGate() {
  const active = new Map<string, Held>()
  const owned = (ticket: ToolGateTicket) => {
    const held = active.get(keyOf(ticket))
    return held?.ticket === ticket ? held : undefined
  }
  return {
    begin(call: ToolGateCall): ToolGateTicket {
      if (!call.tool || !call.tool_use_id) throw new Error('A tool permission gate requires a real tool call.')
      const key = keyOf(call)
      if (active.has(key)) throw new Error('A tool permission gate is already active for this call.')
      const ticket = Object.freeze({ tool: call.tool, tool_use_id: call.tool_use_id, ...(call.agentId === undefined ? {} : { agentId: call.agentId }), nonce: crypto.randomUUID() })
      active.set(key, { ticket, repeated: false, refused: false })
      return ticket
    },

    check<T extends NativeToolVerdict>(call: ToolGateCheck, verdict: T): T | { decision: 'deny'; reason: string } {
      if (!call.tool_use_id) return verdict
      const held = active.get(keyOf(call))
      if (!held) return verdict
      if (verdict.decision === 'deny') { held.refused = true; return verdict }
      if (held.refused) return { decision: 'deny', reason: 'A native permission check already refused this call.' }
      if (held.checked) {
        held.repeated = true
        return { decision: 'deny', reason: 'The replacement tool permission check was repeated.' }
      }
      if (verdict.decision !== 'allow' && verdict.decision !== 'ask') return verdict
      let input: unknown, serializable = false
      try {
        const encoded = JSON.stringify(call.input)
        if (encoded !== undefined) { input = JSON.parse(encoded) as unknown; serializable = true }
      } catch { /* Native input that cannot be snapshotted cannot be replaced. */ }
      held.checked = { verdict: { ...verdict }, input, serializable }
      return { decision: 'deny', reason: stoppedReason(held.ticket) }
    },

    async finish(ticket: ToolGateTicket, nativeResult: unknown, ask: ToolGateAsk, signal?: AbortSignal): Promise<ToolGateResult> {
      const held = owned(ticket)
      if (!held) return denied()
      active.delete(keyOf(ticket))
      if (!held.checked || held.repeated || held.refused || !held.checked.serializable || signal?.aborted || !nativeResult || typeof nativeResult !== 'object') return denied()
      const result = nativeResult as Record<string, unknown>
      if (result.isError !== true || typeof result.text !== 'string' || !result.text.includes(stoppedReason(ticket))) return denied()
      const { verdict, input } = held.checked
      if (verdict.ceiling === 'ask' || verdict.ceiling === 'deny' || verdict.decider !== undefined) return denied('This action requires its organization or host approval path; Rice did not run the replacement.')
      if (verdict.decision === 'allow') return { approved: true, input }
      let description: string | undefined
      try { description = JSON.stringify(input) } catch { /* Unrenderable actions cannot be approved. */ }
      if (description === undefined || description.length > 12_000 || (verdict.reason?.length ?? 0) > 2000) return denied('The complete action cannot be shown in this approval prompt. Rice did not run it.')
      const question = `Rice requests one-time approval for ${ticket.tool}.\n\nExact checked input:\n${description}\n\nNative reason: ${verdict.reason ?? 'This action requires approval.'}\n\nAllow this one action?`
      if (!await askOnce(ask, question, signal)) return denied('The replacement action was not explicitly approved.')
      return { approved: true, input }
    },

    end(ticket: ToolGateTicket): void {
      if (owned(ticket)) active.delete(keyOf(ticket))
    },
  }
}
