// Copied unchanged from greenpolo/cc-multi-cli-plugin plugins/multi-openai/src/instructions.ts at 3dcb057
// (Apache-2.0, Copyright 2026 greenpolo; see LICENSES/cc-multi-cli-plugin.Apache-2.0.txt and its NOTICE).
import { readFileSync } from 'node:fs';

// Claude-hosted compatibility only; workflow preferences come from the session.
const instructions = readFileSync(new URL('./instructions.md', import.meta.url), 'utf8').trim();

export function openaiInstructions(runtime: string): string {
  // Claude mixes built-in prose, appended policies and environment in one block.
  // Retain it intact: deleting that block would also delete user/worker restrictions.
  return `${runtime}\n\n# OpenAI provider instructions\n\n${instructions}`;
}
