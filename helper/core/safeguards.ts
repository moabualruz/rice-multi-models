// Adapted from greenpolo/cc-multi-cli-plugin plugins/multi-core/src/gateway/safeguards.ts at 3dcb057: changed to one honest unavailable verdict for every provider without a reviewer
// (Apache-2.0, Copyright 2026 greenpolo; see LICENSES/cc-multi-cli-plugin.Apache-2.0.txt and its NOTICE).
import type { ResponseContentBlock } from './messages.ts';
import { isRecord } from './record.ts';

type ToolVerdict =
  | { type: 'unavailable'; reason: 'error' }
  | { type: 'evaluated'; outcome: 'not_flagged' };

export type SafeguardResults = [
  {
    type: 'dangerous_tool_use';
    status: { type: 'available'; tool_uses: Record<string, ToolVerdict> };
  },
];

/**
 * Who answers the review: a provider without a reviewer reports every call as unavailable, which Claude treats as
 * "no server verdict" and settles with its own local classifier; `native` is a restored Claude run.
 */
export type SafeguardProvider = 'unreviewed' | 'native';

/** Whether the request asked for a dangerous_tool_use review. A malformed request asks for nothing. */
export function requestsDangerousToolReview(safeguards: unknown): boolean {
  return Array.isArray(safeguards) && safeguards.every(isRecord)
    && safeguards.some((item) => item.type === 'dangerous_tool_use');
}

export function safeguardResults(
  safeguards: unknown,
  content: readonly ResponseContentBlock[],
  provider: SafeguardProvider,
): SafeguardResults | undefined {
  return buildResults(requestsDangerousToolReview(safeguards), content, provider);
}

/** Restored native runs retain whether the original request asked for results. */
export function restoredNativeSafeguardResults(
  requested: boolean,
  content: readonly ResponseContentBlock[],
): SafeguardResults | undefined {
  return buildResults(requested, content, 'native');
}

function buildResults(
  requested: boolean,
  content: readonly ResponseContentBlock[],
  provider: SafeguardProvider,
): SafeguardResults | undefined {
  if (!requested) {
    return undefined;
  }
  const verdict: ToolVerdict = provider === 'native'
    ? { type: 'evaluated', outcome: 'not_flagged' }
    : { type: 'unavailable', reason: 'error' };
  const entries: Array<readonly [string, ToolVerdict]> = [];
  for (const block of content) {
    if (block.type === 'tool_use') {
      entries.push([block.id, verdict]);
    }
  }
  const tool_uses = Object.fromEntries(entries);
  return [{ type: 'dangerous_tool_use', status: { type: 'available', tool_uses } }];
}
