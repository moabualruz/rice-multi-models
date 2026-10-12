// Copied unchanged from greenpolo/cc-multi-cli-plugin plugins/multi-core/src/gateway/record.ts at 3dcb057
// (Apache-2.0, Copyright 2026 greenpolo; see LICENSES/cc-multi-cli-plugin.Apache-2.0.txt and its NOTICE).
/** A plain JSON object: not null and not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
