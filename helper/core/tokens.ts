// Copied from greenpolo/cc-multi-cli-plugin plugins/multi-core/src/gateway/tokens.ts at 3dcb057
// (Apache-2.0, Copyright 2026 greenpolo; see LICENSES/cc-multi-cli-plugin.Apache-2.0.txt and its NOTICE).
// Modified by Mo Abualruz: a character-count estimate replaces js-tiktoken, so the helper has no dependencies.
import type { ResponsesInputContent, ResponsesRequest } from './responses.ts';

/** Shared local text estimate; providers may use different tokenizers. */
export function estimateTextTokens(value: string): number {
  // About 3.6 characters per token for English prose and code; a local estimate only.
  return Math.ceil(value.length / 3.6);
}

/** Local estimate, not a provider billing count. Media expansion uses heuristics. */
export function estimateInputTokens(request: ResponsesRequest): number {
  const text = estimateTextTokens;
  // ponytail: media allowances are heuristic; replace with provider counting if the subscription endpoint exposes it.
  const partTokens = (part: ResponsesInputContent): number => {
    if (part.type === 'input_image') {
      return 4096;
    }
    if (part.type === 'input_file') {
      return Math.ceil((Buffer.byteLength(part.file_data) * 3) / 4);
    }
    return text(part.text);
  };
  const parts = (content: ResponsesInputContent[]) =>
    content.reduce((total, part) => total + partTokens(part), 0);
  let total = text(request.instructions) + text(JSON.stringify(request.tools)) + 8;
  for (const item of request.input) {
    total += 8;
    if ('role' in item) {
      total += parts(item.content);
    } else if (item.type === 'function_call') {
      total += text(item.name) + text(item.arguments);
    } else if (item.type === 'function_call_output') {
      total += typeof item.output === 'string' ? text(item.output) : parts(item.output);
    }
    // Opaque reasoning is not text input; do not tokenize the ciphertext.
  }
  if (request.text) {
    total += text(JSON.stringify(request.text));
  }
  return total;
}
