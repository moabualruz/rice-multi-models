import type { StepWire } from './protocol.ts'

export type PublicWebFetchInput = {
  wire: StepWire
  url: string
  prompt: string
  offset?: number
}

/** The current native WebFetch result. No native artifact identity is invented. */
export type PublicWebFetchResult = {
  bytes: number
  code: number
  codeText: string
  result: string
  durationMs: number
  url: string
  artifactRead?: { slug: string; ver?: string; seeded?: false }
}
