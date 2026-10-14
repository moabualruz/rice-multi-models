# rice-multi-models

A Claude Code mod that runs non-Anthropic models as ordinary session and
subagent models, with Claude Code's own tools, permissions and transcript.
Native routed compaction is temporarily unavailable (see below). No proxy: Claude Code keeps talking to Anthropic for Claude models,
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

## Install

```text
/plugin install rice-multi-models --marketplace moabualruz/rice-mods
```

Install in a terminal session using Claude Code 2.1.296 and Node.js 22 or newer.
The mod ships its compiled helper and runtime dependencies: **Bun, a TypeScript
compiler, curl, jq and a manual package install are not consumer requirements.**

Fresh installation activates the function hooks in the current terminal session.
On every session startup, the mod checks Node and the bundled helper, fetches
fresh supported model catalogues and metadata, starts its private session helper,
and synchronizes discovered candidates into `/model`. It preserves your other
settings and model rows, including rows you customized. Cached models, bundled
model names and configured defaults are not discovery fallbacks. Failed discovery
reports an unavailable source rather than inventing candidates. Installing through the standalone CLI
prepares the mod for your next Claude Code session; after an update, use
`/reload-plugins` or restart to load the updated copy.

The first interactive activation explains what was configured and what still
needs your attention. Account login and provider approval are not automated:
installing a mod cannot grant a subscription, credit, API key or model entitlement.
Use `/rice-models setup` to recheck and repair setup, or `/rice-models doctor` for
read-only diagnostics. Neither changes your selected session model.

### First-run checklist

1. Make Node.js 22 or newer available to the process that starts Claude Code.
   `node --version` verifies your terminal's version. Desktop applications may
   have a different PATH; set `RICE_MULTI_MODELS_NODE` to an absolute Node
   executable path when needed, then restart the host.
2. Install the mod with the command above. Its own runtime dependencies are
   bundled; do not run `bun install` or `npm install` in the installed plugin.
3. Choose the provider you want and complete its login below. Already-installed
   CLIs and existing login/configuration are reused. Optional worker CLIs are not
   all downloaded or installed globally on your behalf.
4. Run `/rice-models setup` after changing runtime/login/configuration, then
   `/rice-models models` or `/model`. A listed candidate is not a live access check.
5. Select an exact model id with `/model <id>`. A provider's authentication,
   approval, subscription or quota refusal is reported; the mod never silently
   switches to another provider.

### Provider-specific setup

| Provider | What you supply | Login or configuration |
| --- | --- | --- |
| Codex / ChatGPT | Codex CLI and a ChatGPT account with access | `codex login`; reuse `$CODEX_HOME/auth.json` or the default `~/.codex/auth.json` |
| OpenCode Zen / Go | OpenCode CLI login, plus Zen credit or an active Go subscription | `opencode auth login`, then `/rice-models opencode write` |
| Declared API / local endpoint | Endpoint, model definitions and an auth command, or `auth: "none"` for a local server | `~/.claude/rice-multi-models.json`; approve the provider when prompted |
| Antigravity worker | Installed `agy` CLI and its own account | Sign in through `agy`; the CLI worker controls its own tools |
| Grok worker | Installed `grok` CLI and its own account | `grok login`; the CLI worker controls its own tools |

If Codex is not installed, run `/rice-models setup codex`. This explicitly
installs the verified, pinned Codex distribution into the mod's own directory
under your Claude config directory, using your installed npm. It does not install
anything globally. Existing Codex on PATH takes priority. Setup prints the exact
login command for the scoped CLI; run it in your terminal (PowerShell on native
Windows), then rerun setup.
No installer is run merely by listing models, invoking doctor, or using headless
startup. Other optional CLI workers require their vendor-supported installation.

Codex sends provider requests directly from the helper. Its CLI owns interactive
login and token renewal; the mod does not impersonate a login or replace your
credentials. OpenCode keys are read by the helper at request time, without jq.
A changed provider address or credential command requires provider approval again.

### Diagnostics and repair

`/rice-models doctor` checks Node and the shipped helper, resolves configuration
and login paths, and reports local CLI/login-file observations without changing
them. Use `/rice-models models` for the catalogue, `/rice-models picker` to inspect
picker candidates, and `/rice-models status` for approvals and reported quota.
A login file's presence is not proof that its credentials are valid. Access and
quota remain unknown until the provider supplies that evidence.

- **Models are missing:** run `/rice-models setup`, inspect its picker result,
  and reopen `/model`. If your host has retained old settings, restart once.
- **Node is missing or too old:** make a supported Node executable available to
  Claude Code, or set `RICE_MULTI_MODELS_NODE`, then run setup again.
- **Settings/configuration are invalid:** repair the JSON yourself, then run setup.
  The mod does not erase or silently replace malformed settings or providers.
- **Login or subscription is missing:** complete the provider-specific login or
  account requirement above. Reinstalling the mod does not grant access.
- **An update appears inactive:** update the marketplace and plugin, then run
  `/reload-plugins` or restart. Editing a source checkout does not update an
  already-installed Git-backed copy.
- **You are using headless mode:** startup remains deterministic and does not
  open interactive setup/login prompts. Inspect setup status and complete login
  in an interactive terminal before retrying.

`CLAUDE_CONFIG_DIR` changes the Claude settings/provider directory, `CODEX_HOME`
changes the Codex configuration/login directory, and `XDG_DATA_HOME` changes
OpenCode's default data-directory location. Keep credential values out of command
arguments and diagnostics; configure key commands or existing login references.

On WSL, the mod uses the Linux process's HOME and PATH. Existing WSL Codex login
under `$CODEX_HOME` (default `~/.codex`) is reused without
copying credentials or logging in again. A Windows-side login is not automatically
imported into the WSL home. Run doctor in the WSL session to see which paths it
actually resolves; do not reinstall Codex when its login is already present.

## Use

| Where | How |
| --- | --- |
| Main session | `/model codex/gpt-6.1-sol` (or any id from `/rice-models models`), `claude --model codex/...` |
| A subagent type of yours | `model: codex/gpt-6.1-sol` in its agent file (`.claude/agents/*.md`) |
| Ad hoc | the agent types `rice-multi-models:codex` and `rice-multi-models:codex-explore` |
| Mixed | a Claude session with Codex subagents, or a Codex session with Claude subagents (`model: haiku`) |

`/effort` and `--effort` reach the Codex request. Reasoning streams as thinking
and is carried back (encrypted) across tool calls. `/compact`, automatic and
precomputed compaction on routed models explicitly refuse without custom summaries,
provider fallback or transcript replacement. Native Claude compaction is unchanged
when its model is known. A subagent whose active model is unknown after reload also
refuses compaction until its next observed turn, rather than guessing a provider.

`/rice-models` shows the helper, transport, effort, ChatGPT rate limits and
the last step. `/rice-models effort <level>`, `/rice-models transport auto|ws|sse`
and `/rice-models helper session|once` change them for the session.

### Discover and use supplied models

Every session start performs bounded network discovery, including headless sessions.
Codex uses the authenticated first-party models endpoint with the installed CLI's
actual version, not `models_cache.json`. Approved declared providers use their
fresh `/models` APIs (OpenAI-compatible, Responses, Anthropic and Gemini); Bedrock
catalogue discovery is explicitly unavailable. Unapproved providers do not run key
commands or send discovery requests. Antigravity and Grok use their installed CLI's
`models` command; their unreported limits stay unknown. An exact OpenCode Zen/Go
provider and endpoint can supplement missing fields from a fresh models.dev entry
for that exact gateway/model id, with field-level provenance; endpoint fields win.

Reports include observation time, source, provider discovery status, context and
maximum context, input/output limits, auto-compaction limits, modalities, reasoning
efforts and reported tool capabilities. `null` means unreported, not unlimited or
a guessed default. `/rice-models refresh` fetches a new snapshot and repairs the
owned picker rows; models/status tools only read the session snapshot, never query
providers every turn. A configured default is selected only if discovered, and
manually declared routes remain configuration, not discovered candidates.

Setup also recognizes the complete generated picker-row format from releases
before 0.6 and replaces those rows with the current discovered catalogue. This
removes their obsolete `behavesAs: claude-sonnet-4-6` alias, which otherwise makes
the native engine enforce Sonnet's context window for a routed model. Custom rows,
rows with extra fields and rows marked edited in the ownership record are retained.

In a routed session, exposed auxiliary completions and classification requests
use the selected provider, including callers that request the host's small Claude
model. Explicit routed targets still select that exact route. An unreadable fork
transcript or a provider failure cannot fall back to native Claude. These hooks
cover the exposed plugin operations; they do not establish interception of every
internal inference path in the host.

Reported context/input bounds constrain this mod's request sizing; output ceilings
and unsupported capabilities constrain configured-provider requests without lifting
user restrictions. The request estimate and 95% safety threshold are local policy,
not exact tokenizer or available-output proof. Routed compaction is temporarily
unavailable: Claude Code 2.1.296's
public plugin API does not expose the actual native summary request on every path,
so the mod refuses rather than inventing a replacement or falling back to another
provider. The original transcript remains unchanged. Faithful native routed
compaction, preferably using the previous model when its discovered window is
larger, remains a tracked host-API blocker, not completed delivery.

Before a model switch, the mod denies a switch whose native `context_tokens` exceed
fresh exact destination metadata: the minimum of reported input limit and active
`contextWindow ?? maxContextWindow`, when available. It does not compact, change the
selected model, alter defaults or rewrite history. Unknown, stale, CLI-worker and
native Claude destination bounds are not inferred from the process-global override.
A switch allowed by this guard is not proof that the next request fits (for example,
new instructions and output also need room). Server-side search/fetch transcript
blocks are retained as historical data rather than rerun as client tools.

**Native primary-window integration:** For the main routed native-provider model,
the mod synchronizes Claude Code 2.1.296's supported process-local
`CLAUDE_CODE_MAX_CONTEXT_TOKENS` override from fresh metadata for the exact active
model, using `contextWindow ?? maxContextWindow`. This sets the native context
meter's window and automatic compaction threshold, not provider entitlement or
available input/output capacity. An existing explicit owner override remains
authoritative. On unknown routes, discovery failure or `session.end`, the mod
restores the value it owns; ownership state is preserved across hot reload.
External status-line output can retain its pre-reload text until the next normal
engine refresh; `/context` reads the current native window immediately.

**Remaining host limitations:** The exposed plugin API still cannot register
numeric per-model limits or capabilities. This process-global override does not
establish independent custom-subagent windows, so mixed custom models remain a
limitation. Restoration on plugin unload is also unsupported. Picker metadata
does not fix these limitations, and no `behavesAs` guess is used.

Fresh installation registers discovery tools and prompt guidance on activation.
After updating an already-loaded mod, run `/reload-plugins` or restart. Ask
`mcp__rice-multi-models__models` with `{ "action": "models" }` to list supplied
candidates, or `{ "action": "status" }` for the same catalogue plus current
session status, provider approvals and the last reported Codex usage-limit windows.
The tool does not read credentials or expose endpoint addresses. Quota details are
reported only when a routed Codex request has supplied them, with the observation
time; otherwise quota status is unavailable, not unlimited. Catalogue presence is
not proof of live entitlement or current quota.

To use a supplied model as a regular native subagent, call
`mcp__rice-multi-models__agent_type` with its exact model id and `mode: "read"`
or `mode: "write"` (read is the default). It returns a reusable
`rice-multi-models:model-N` type for that model and mode. Then call the standard
Claude Code Agent tool with that type. This only registers a type for the next
turn; the standard Agent call starts it and selects effort. Native provider models
use Claude Code's session tools and permissions. Antigravity (`agy/...`) and Grok
(`grok/...`) are labelled CLI workers because their own CLI tool loop runs them;
Codex login or refresh is not a CLI worker.

The catalogue describes general availability candidates only. Respect any
provider or model restrictions the user gives for the current session, provider
approval prompts and quota refusals. Discovery does not approve a provider, grant
entitlement, bypass a refusal or silently switch to another provider.

`/rice-models picker write` lists freshly discovered candidates (Codex, approved providers, workers) in the
`/model` picker by writing `modelPicker` rows into `~/.claude/settings.json`; rows you wrote yourself
are kept, and `/rice-models picker` shows the rows without writing. A row looks like:

```json
{
  "modelPicker": {
    "options": [
      { "model": "provider/discovered-id", "label": "Discovered model", "description": "native provider; reported context unknown, input unknown, output unknown; native context registration unsupported" }
    ]
  }
}
```

The row describes reported facts only. It does not claim another model's capabilities
or alter the engine's context accounting.

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
http needs `"allowHttp": true`) and optional `models` (request policy such as
`contextWindow`, `maxOutputTokens`, `effort` maps and `params`). Fresh discovery can
add routes and replace reported context/input facts without rewriting the source
file. Unknown limits are not fabricated; Anthropic/Bedrock require an explicit
output policy when discovery does not report an output ceiling. OpenAI-compatible
Chat Completions with a known output ceiling also requires an explicit
`maxTokensParam` (`max_tokens` or `max_completion_tokens`), since gateway dialects
cannot be guessed from a model name. A model's `tools` can list the only tools it is
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
itself reads: each model's explicitly reported SDK determines the supported protocol
(Chat Completions, Responses, Anthropic Messages or Gemini); reported limits and
modalities are imported without inventing output ceilings or reasoning efforts. `/rice-models opencode write` saves them as
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
model's input budget is not sent and asks for reduced context or a new session. `/rice-models providers` lists
them; `/rice-models reload` re-reads the file.

## How it works

1. `turn.step` sees a request whose model is `codex/<slug>` and answers it
   itself: the system prompt is the one Claude Code composes (a subagent's
   comes from its agent file, or a prompt written for the built-in type), the
   tools are the session's (with input schemas generated from this Claude Code
   build), and the transcript is the engine's own in Messages form.
2. At activation the mod starts the bundled Node session helper
   (`dist/helper.mjs serve`). It uses a private Unix socket on macOS/Linux or a
   named pipe on Windows, authenticates calls with a random token, and keeps one
   Codex WebSocket per conversation open between steps. It carries only routed
   requests and exits with Claude Code. A bundled Node client sends each step on
   stdin and streams its response; no curl is needed. A helper socket that was
   never reached can fall back to a one-shot helper (`once`). Failures after
   connection never trigger a fallback that could replay a dispatched request.
   `/rice-models helper once` routes requests through one-shot helpers.
   Leaving or interrupting a step cancels its request.
3. The helper translates Messages to the Responses API, sends it to
   `chatgpt.com/backend-api/codex/responses` over a WebSocket (falling back to
   server-sent events), and maps the stream back: text, reasoning, tool calls,
   usage. Requests say `originator: rice_multi_models`.
4. An expiring ChatGPT login is renewed by asking `codex app-server` to do it,
   so Codex rewrites its own `auth.json`.

## Codex retries and account admission

A Codex step retries ordinary transient stream failures, early WebSocket closes (including
code 1000), and HTTP 408, 429 and 5xx failures, up to **three total attempts**. Ordinary
backoff starts at 500 ms, doubles between attempts, and adds up to 100 percent jitter:
about 0.5 to 2 seconds per wait. An anonymous `response.failed` or `error` event is transient.

Provider overload gets **up to six total attempts**: overload/capacity/unavailable codes or
messages, and HTTP 503/529. Its exponential schedule is about 2, 4, 8, 16 and 30 seconds,
with jitter and each wait capped at 30 seconds. Known authentication, permission, request,
billing and policy error codes are permanent and never retry, even when the status or
message otherwise looks transient or overloaded. Other unknown provider codes are not
assumed transient.

`Retry-After` seconds or an HTTP date is a minimum wait. A value above 30 seconds fails
fast rather than retrying before the provider permits. Cancellation interrupts admission,
connection setup and retry waits. The existing one-time HTTP 401 login renewal remains
separate from transient retries.

An attempt whose connection or stream sends no bytes for `RICE_CODEX_STREAM_IDLE_MS`
(default `300000`, the Codex CLI stream idle default; `0` disables) is abandoned and retried as
a transient `stream.idle` failure, under the same tool-call replay boundary. A silent stream
no longer stalls a subagent until Claude Code stops it.

Function-call arguments that the model streams as invalid JSON are a transient
`response.function_arguments` failure: the attempt is discarded and the step sampled again, under
the same tool-call replay boundary, instead of ending the subagent on a decode error.

No attempt is replayed after it emits a whole tool call. Before that boundary, text, reasoning
and signatures are buffered until completion or the first tool call, then released in order.
This prevents a failed attempt's partial answer from contaminating the next one. Final errors
identify the event, provider code/type (or `unknown`), HTTP/close status when available, and
attempt count; login values and credential-shaped text are redacted. In `auto` mode,
a rejected WebSocket connection can fall back to HTTP to recover the structured rejection;
forced `ws` reports the transport error.

`RICE_CODEX_MAX_IN_FLIGHT` configures FIFO admission **per ChatGPT account in each helper
process**. Default: `0` (off: a queued step emits nothing, and Claude Code stops a subagent after 10 minutes without progress, so queueing behind long Codex steps killed agents); allowed: `1` through `15`. Set it in the environment
before starting Claude Code. Waiting steps are cancellable and hold no provider connection.
A slot is held through all attempts and released on success, failure or cancellation. Separate
accounts have separate queues. This does not coordinate other Claude Code helpers or the
Codex CLI on the same account. The session helper accepts up to 64 concurrent steps (16 refused real orchestrator fan-out); more fail fast with "too many steps at once".

## Update

Release **0.6.4** adds legacy picker migration and auxiliary completion and
classification routing without native provider fallback. It retains the shipped
Node helper, native discovery, primary-window synchronization and temporary
fail-closed routed compaction. The `rice-mods` marketplace tracks this repository's `main` without a
tag pin. Update both the marketplace and your installed mod, then reload or restart
the session:

```bash
claude plugin marketplace update rice-mods
claude plugin update rice-multi-models@rice-mods
```

## Requirements and platform scope

**Consumers:** Claude Code 2.1.296 and Node.js 22 or newer. Optional provider CLIs,
account access and credentials depend on the providers you actually use; Codex
login is not a requirement for using a declared local endpoint. The compiled
helper, authenticated WebSocket implementation and provider instruction asset
are included in the plugin payload. No consumer dependency installation is needed.

The implementation handles macOS/Linux paths and Unix sockets, and Windows
paths, npm shims and named pipes. Native Windows qualification must be performed
on a Windows executor; portable code and simulated Windows tests are not a
claim that Windows has been live-tested. WSL uses the Linux runtime and does not
qualify native Windows.

**Contributors:** pinned npm development tools build and typecheck the Node
helper. Bun is retained only for the existing contributor test suite, not for
installed sessions. Tool schemas are generated for a Claude Code build with
`NODE_PATH=<typescript install> bun scripts/gen-schemas.ts --tools <claude-code.d.ts>`;
that is release maintenance, not an installation step for every user.

## Build and tests

- `npm install --ignore-scripts` installs development/build tools using the
  committed npm lockfile; never run it inside an installed plugin cache.
- `npm run build` regenerates the shipped helper. Commit the artifact with its
  source changes so a Git-backed marketplace install includes executable code.
- `npm run build:check` verifies the committed artifact matches its source.
- `npm run typecheck` checks production helper source against Node types.
- `npm run test:node` exercises the Node helper and runtime-specific behavior.
- `npm run test:native` runs lifecycle fixtures through `claude plugin test` in
  an isolated temporary plugin payload, separate from Bun's test files.
- `npm run test:routing` uses the real engine to verify that migrated picker
  rows allow a supplied 500k context override and that exposed auxiliary
  completions and classifications route without native provider calls. Its
  metadata and provider events are deterministic fixtures, not live entitlement
  or discovery evidence.
- `node scripts/proof-clean-runtime.mjs` copies only the shipped artifact into
  an empty home/path with spaces and tests a local provider through one-shot and
  session-helper IPC, without Bun, curl, jq or development dependencies.
- `bun test helper tests` retains helper/routing/discovery coverage, including
  fake Responses/WebSocket failures, backoff, credential redaction, tool replay
  safety and account admission. `bun run check` includes the contributor tests,
  production typecheck and Git whitespace check.
- GitHub Actions runs `bun run check` on Ubuntu 24.04 with pinned Node.js, Bun
  and a job-local Claude Code test executable. The checks include Node runtime
  tests, clean shipped-payload proof and isolated native lifecycle fixtures.
- The mod itself must typecheck against the engine's plugin types and pass native
  validation. Helper typechecking alone does not establish activation, picker
  visibility, login, a live request or quota availability.

CI fixtures use local provider mocks and do not require personal accounts or
provider credentials. They verify routing and lifecycle behavior, not live
provider entitlement, quota or native Windows compatibility.

## Credits

Adapted from [Trosfy/claude-styx](https://github.com/Trosfy/claude-styx) (MIT:
routing, prompts, transcript, assembler, schema generator) and
[greenpolo/cc-multi-cli-plugin](https://github.com/greenpolo/cc-multi-cli-plugin)
(Apache-2.0: Messages/Responses translation, Codex login renewal). See `THIRD_PARTY_NOTICES.md`.

## License

MIT, see `LICENSE`, except the files adapted from cc-multi-cli-plugin: they stay
under the Apache License 2.0 and say so in their headers. `THIRD_PARTY_NOTICES.md`
lists both upstreams.
