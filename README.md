# rice-multi-models

A Claude Code mod that runs non-Anthropic models as ordinary session and
subagent models, with Claude Code's own tools, permissions, transcript and
compaction. No proxy: Claude Code keeps talking to Anthropic for Claude models,
and requests for a routed model never leave the session except to the
provider itself.

Providers:

- **OpenAI Codex through a ChatGPT subscription** (the Codex CLI login in
  `~/.codex/auth.json`): model ids `codex/<slug>`.
- **Any endpoint you declare** in `~/.claude/rice-multi-models.json`: Chat Completions,
  the OpenAI Responses API, Anthropic Messages, Google Gemini or Bedrock, chosen per model:
  Ollama, llama.cpp, vLLM, LM Studio, OpenRouter, OpenAI, Anthropic API keys, other clouds.
  Model ids `<provider>/<model>` or an alias. See `example.rice-multi-models.json`.
- **OpenCode Zen and OpenCode Go**: `/rice-models opencode write` declares every model
  each one serves, in its own protocol, with the key from OpenCode's login.
- **Agent CLIs as workers**: Antigravity (`agy`, Gemini) and Grok (`grok`) run their own loop and
  tools. Model ids `agy/<model>` and `grok/<model>`; agent types `rice-multi-models:agy`,
  `agy-write`, `grok`, `grok-write` (registered when the CLI is installed).

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

`/rice-models picker write` lists every routed model (Codex, declared providers, workers) in the
`/model` picker by writing `modelPicker` rows into `~/.claude/settings.json`; rows you wrote yourself
are kept, and `/rice-models picker` shows the rows without writing. A row looks like:

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

## Workers (Antigravity, Grok)

A worker step runs the CLI headless with the newest user turn: its narration, reasoning and
actions (`▸ view_file ...`) stream as thinking, and its final response is the answer (a
subagent's report). Each conversation keeps the CLI's own session, so a follow-up resumes it.
The read-only types run in the CLI's plan mode; the `-write` types allow file edits
(accept-edits). Neither skips the CLI's permission checks: a command the CLI would ask about
is refused in headless mode. As the main session model (`/model agy/gemini-3.8-flash-high`),
`/rice-models workers read|write` picks the mode. Sign in with the CLI first (`agy`, `grok login`).

## Declared providers

`~/.claude/rice-multi-models.json` (claude-styx's format, validated whole) names
each provider's `kind`, `baseUrl`, `auth` (a key command with an absolute path, such as
`/usr/bin/security find-generic-password ... -w`, or `"none"` for a local server; plain
http needs `"allowHttp": true`) and `models` (`contextWindow`, `maxOutputTokens`,
optional `effort` maps and `params`). A model's `tools` can list the only tools it is
sent, which keeps small local models inside their window:
`["Read", "Edit", "Write", "Bash", "Glob", "Grep"]`.

| `kind` | Protocol | Path under `baseUrl` | Key header |
| --- | --- | --- | --- |
| `openai` | Chat Completions | `/chat/completions` | `Authorization: Bearer` |
| `responses` | OpenAI Responses (`store: false`, reasoning carried back encrypted) | `/responses` | `Authorization: Bearer` |
| `anthropic` | Anthropic Messages | `/v1/messages` (`/messages` when the base ends in `/v1`) | `x-api-key` |
| `gemini` | Google generateContent (thought signatures carried back) | `/models/<id>:streamGenerateContent?alt=sse` | `x-goog-api-key` |
| `bedrock` | Amazon Bedrock Converse | `/model/<id>/converse-stream` | `Authorization: Bearer` |

A model may set its own `kind`, so one gateway that serves each model in its maker's
protocol is one provider. A provider's `authHeader` (`bearer`, `x-api-key` or
`x-goog-api-key`) sends every model's key one way. A `responses` model that does not
reason takes `"params": { "include": null }`. A provider's `sessionHeader` carries a
stable hash of the conversation, which some services route and cache by.

### OpenCode Zen and Go

`/rice-models opencode` builds both providers from each gateway's model list
(`/inference/v1/models`, `/inference/go/v1/models`) and the models.dev catalog OpenCode
itself reads: each model's protocol (Chat Completions, Responses, Anthropic Messages or
Gemini), limits, vision and effort levels. `/rice-models opencode write` saves them as
`opencode` (Zen, pay as you go) and `opencode-go` (the Go subscription) and keeps your
other providers; `zen` or `go` limits it to one. The key comes from OpenCode's own
`~/.local/share/opencode/auth.json` (`opencode auth login`): one console key serves both,
so each reads its own entry and falls back to the other's. Requests carry
`x-opencode-session` and name this mod as the client. Zen needs account credit and Go an
active subscription; the gateway's refusal says which. OpenCode's free Zen models answer
only OpenCode itself.

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

## Codex retries and account admission

A Codex step retries transient stream failures, early WebSocket closes (including code 1000),
and HTTP 408, 429 and 5xx failures, up to **three total attempts**. Known authentication,
permission, request, billing and policy errors are permanent. Unknown provider codes are not
assumed transient. An anonymous `response.failed` or `error` event is transient.

Backoff starts at 500 ms, doubles between attempts, and adds up to 100 percent jitter.
`Retry-After` seconds or an HTTP date is a minimum wait. Each wait is bounded at 30 seconds:
a larger provider wait ends the step rather than retrying before it permits. Cancellation
interrupts admission, connection setup and retry waits. The existing one-time HTTP 401 login
renewal remains separate from transient retries.

No attempt is replayed after it emits a whole tool call. Before that boundary, text, reasoning
and signatures are buffered until completion or the first tool call, then released in order.
This prevents a failed attempt's partial answer from contaminating the next one. Final errors
identify the event, provider code/type (or `unknown`), HTTP/close status when available, and
attempt count; login values and credential-shaped text are redacted. Bun does not expose the
HTTP status or headers of every refused WebSocket handshake: `auto` falls back to HTTP to
recover the structured rejection, while forced `ws` reports the transport error.

`RICE_CODEX_MAX_IN_FLIGHT` configures FIFO admission **per ChatGPT account in each helper
process**. Default: `6`; allowed: `1` through `15`; `0` disables it. Set it in the environment
before starting Claude Code. Waiting steps are cancellable and hold no provider connection.
A slot is held through all attempts and released on success, failure or cancellation. Separate
accounts have separate queues. This does not coordinate other Claude Code helpers or the
Codex CLI on the same account. The session helper's overall 16-step cap is unchanged.

## Update

Version 0.5.1 is published from this repository's `main`, which the `rice-mods` marketplace
tracks without a tag pin. Update the marketplace and installed mod, then restart the session:

```bash
claude plugin marketplace update rice-mods
claude plugin update rice-multi-models@rice-mods
```

## Requirements

- Claude Code 2.1.296 (tool schemas are generated per build:
  `NODE_PATH=<typescript install> bun scripts/gen-schemas.ts --tools <claude-code.d.ts>`).
- Bun on `PATH` or at `~/.bun/bin/bun`.
- The Codex CLI, signed in with ChatGPT (`codex login`).

## Tests

- `bun install --frozen-lockfile --ignore-scripts` installs the pinned development tools.
- `bun run check` runs every helper and routing unit test, the helper type-check and Git's
  whitespace check. Routing tests are pure and use Bun, without loading a mod into Claude Code.
- `bun test helper tests` runs all tests, including fake Responses/WebSocket failures,
  backoff, credential redaction, tool replay safety and account admission.
- The source CI runs the same checks on self-hosted Linux runners only.
- The mod itself type-checks against the engine's laid types; the helper's type-check does
  not establish a live plugin reload or engine lifecycle qualification.

## Credits

Adapted from [Trosfy/claude-styx](https://github.com/Trosfy/claude-styx) (MIT:
routing, prompts, transcript, assembler, schema generator) and
[greenpolo/cc-multi-cli-plugin](https://github.com/greenpolo/cc-multi-cli-plugin)
(Apache-2.0: Messages/Responses translation, Codex login renewal). See `THIRD_PARTY_NOTICES.md`.

## License

MIT, see `LICENSE`, except the files adapted from cc-multi-cli-plugin: they stay
under the Apache License 2.0 and say so in their headers. `THIRD_PARTY_NOTICES.md`
lists both upstreams.
