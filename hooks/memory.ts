/**
 * What the copied prompt and agent modules keep for a session: the agent files read (by path), the notes said
 * once, the notes worth showing in /rice-multi-models, and the platform. A stand-in for claude-styx's Session.
 */
export type Memory = {
  agentFiles: Map<string, unknown>
  agentNotes: Set<string>
  notes: string[]
  platform: string | null | undefined
}

export function createMemory(): Memory {
  return { agentFiles: new Map(), agentNotes: new Set(), notes: [], platform: undefined }
}

/** A subagent as the prompt modules see it: its type, how it is named, and the worktree it runs in, if any. */
export type Route = { type?: string; label: string; worktree?: { path: string } }
