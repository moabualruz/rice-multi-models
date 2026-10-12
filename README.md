# rice-multi-models

A Claude Code mod that runs non-Anthropic models as ordinary session and
subagent models, with Claude Code's own tools, permissions, transcript and
compaction. No proxy: Claude Code keeps talking to Anthropic for Claude models,
and requests for a routed model never leave the session except to the
provider itself.

Providers:

- **OpenAI Codex through a ChatGPT subscription** (the Codex CLI login in
  `~/.codex/auth.json`): model ids `codex/<slug>`.
- **Any endpoint you declare** in `~/.claude/rice-multi-models.json`, OpenAI-style
  (`/chat/completions`), Anthropic-style (`/v1/messages`) or Bedrock: Ollama,
  llama.cpp, vLLM, LM Studio, OpenRouter, OpenAI, Anthropic API keys, other clouds.
  Model ids `<provider>/<model>` or an alias. See `example.rice-multi-models.json`.

## Use

| Where | How |
| --- | --- |
| Main session | `/model codex/gpt-6.1-sol` (or any id from `/rice-models models`), `claude --model codex/...` |
| A subagent type of yours | `model: codex/gpt-6.1-sol` in its agent file (`.claude/agents/*.md`) |
| Ad hoc | the agent types `rice-multi-models:codex` and `rice-multi-models:codex-explore` |
| Mixed | a Claude session with Codex subagents, or a Codex session with Claude subagents (`model: haiku`) |

`/effort` and `--effort` reach the Codex request. Reasoning streams as thinking
and is carried back (encrypted) across tool calls. `/compact` and automatic
compaction are answered by the Codex model itself.

`/rice-models` shows the helper, transport, effort, ChatGPT rate limits and
the last step. `/rice-models effort <level>`, `/rice-models transport auto|ws|sse`
and `/rice-models helper session|once` change them for the session.

To list Codex models in the `/model` picker, add rows to `~/.claude/settings.json`:

```json
{
  "modelPicker": {
    "options": [
      { "model": "codex/gpt-6.1-sol", "label": "GPT-6.1-Sol (Codex)", "behavesAs": "claude-sonnet-4-6" }
    ]
  }
}
```

`behavesAs` gives the row a known model's capabilities (no unknown-model
warning). Claude Code keeps a 200k window for these models, under Codex's own.

## Declared providers

`~/.claude/rice-multi-models.json` (claude-styx's format, validated whole) names
each provider's `kind` (`openai`, `anthropic`, `bedrock`), `baseUrl`, `auth` (a key
command with an absolute path, such as `/usr/bin/security find-generic-password ... -w`,
or `"none"` for a local server; plain http needs `"allowHttp": true`) and `models`
(`contextWindow`, `maxOutputTokens`, optional `effort` maps and `params`). A model's
`tools` can list the only tools it is sent, which keeps small local models inside
their window: `["Read", "Edit", "Write", "Bash", "Glob", "Grep"]`.
A provider's `sessionHeader` (for OpenCode Go and Zen: `"x-opencode-session"`) carries a
stable hash of the conversation, which those services route and cache by.

Each provider is approved once: the first step asks (or run
`/rice-models approve <provider>`), and a changed address or key command asks again.
Keys are read only by the helper, at request time, and never logged. A step past the
model's input budget is not sent and says to `/compact`. `/rice-models providers` lists
them; `/rice-models reload` re-reads the file.

## How it works

1. `turn.step` sees a request whose model is `codex/<slug>` and answers it
   itself: the system prompt is the one Claude Code composes (a subagent's
   comes from its agent file, or a prompt written for the built-in type), the
   tools are the session's (with input schemas generated from this Claude Code
   build), and the transcript is the engine's own in Messages form.
2. At session start the mod starts the session helper (`helper/main.ts serve`, on
   Bun). It listens on a Unix socket in a private (0700) folder, answers only calls
   that carry the random token it gave the mod, keeps one Codex WebSocket per
   conversation open between steps, carries nothing but routed requests, and
   exits with Claude Code. Each step reaches it through `curl` with the step on
   stdin. If it is not running, a step starts a one-shot helper (`once`) instead.
   `/rice-models helper once` uses only one-shot helpers (no local socket).
   Leaving or interrupting a step cancels its request.
3. The helper translates Messages to the Responses API, sends it to
   `chatgpt.com/backend-api/codex/responses` over a WebSocket (falling back to
   server-sent events), and maps the stream back: text, reasoning, tool calls,
   usage. Requests say `originator: rice_multi_models`.
4. An expiring ChatGPT login is renewed by asking `codex app-server` to do it,
   so Codex rewrites its own `auth.json`.

## Requirements

- Claude Code 2.1.296 (tool schemas are generated per build:
  `NODE_PATH=<typescript install> bun scripts/gen-schemas.ts --tools <claude-code.d.ts>`).
- Bun on `PATH` or at `~/.bun/bin/bun`.
- The Codex CLI, signed in with ChatGPT (`codex login`).

## Tests

- `claude plugin test .` runs the mod tests (`tests/`).
- `bun test helper` runs the helper tests against captured Codex streams.
- Type-check: `tsc -p helper/tsconfig.json --typeRoots <bun @types>`; the mod
  type-checks against the engine's laid types.

## Credits

Adapted from [Trosfy/claude-styx](https://github.com/Trosfy/claude-styx) (MIT:
routing, prompts, transcript, assembler, schema generator) and
[greenpolo/cc-multi-cli-plugin](https://github.com/greenpolo/cc-multi-cli-plugin)
(Apache-2.0: Messages/Responses translation, Codex login renewal). See `THIRD_PARTY_NOTICES.md`.
