# rice-multi-models

A Claude Code mod for models from other subscriptions, APIs and local servers.
Its function hooks can route main and subagent turns through direct provider
calls while retaining Claude Code's tools, permissions and transcript.

**Current status:** published **0.8.0** does not meet the full requirement inside
ordinary, unmodified `claude`. Its complete native inference coverage relied on
a startup preload integration that is no longer an accepted installation
mechanism. The previous launcher-based installation path is withdrawn.
It must not be recreated as part of setup. There is currently no recommended
activation command that restores that coverage through the exposed plugin API.

Main and subagent turn routing can work through function hooks. Native
compaction, tool-internal inference, automatic evaluators and the complete native
WebSearch fallback chain do not have equivalent coverage without the rejected
adapter. `/reload-plugins` reloads function hooks; it does not install that
adapter. The full plugin-only requirement remains unresolved. See the
[plugin API findings](docs/research/plugin-only-activation-20261016.md).

| Capability in ordinary Claude | Current status |
| --- | --- |
| Provider setup, approvals and fresh model discovery | Available through the plugin's commands and helper. Discovery does not establish entitlement. |
| Main and subagent turn routing | Available through exposed `turn.step` hooks on compatible builds. This does not cover every native inference path. |
| Selected-provider native compaction | Incomplete without the rejected adapter; guarded routed compaction refuses when it is absent. |
| Internal skill/tool inference and automatic evaluators | Full selected-provider coverage is incomplete. Exposed auxiliary hooks cover only the calls that reach them. |
| Search endpoint configuration and retrieval helper | Available; saving or testing an endpoint does not establish native WebSearch integration. |
| Complete native WebSearch and WebFetch inference routing | Incomplete without the rejected adapter. |

Use this mod for ChatGPT/Codex, API keys, local models and provider configuration.
For managing saved Anthropic OAuth accounts, see
[rice-session-accounts](https://github.com/moabualruz/rice-session-accounts), whose
account picker shows saved account names, emails and subscription tiers. Its
named switching is also blocked without the rejected bridge. Both
mods use your existing Claude configuration; extra account login folders are
only for authentication.

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

## Install and start

Use your machine's ordinary `claude` command with Node.js 22 or newer available
in its environment. Run this in a terminal on the machine where Claude runs:

```sh
claude plugin install rice-multi-models --marketplace moabualruz/rice-mods
```

The command adds the Rice marketplace if needed and installs the mod. Its helper
and dependencies are bundled. **No consumer build or dependency installation
inside the plugin cache is needed.** This installation exposes the available
function hooks; it does not resolve the native coverage limitations above.

1. Start ordinary Claude Code with `claude`, approve the mod's requested
   capabilities when prompted, then run:

   ```text
   /rice-models setup
   ```

   Setup checks Node and the bundled helper, reports login requirements,
   refreshes discovery and synchronizes model-picker candidates. For Codex,
   reuse your existing login or run the exact login command setup prints in a
   terminal. If Codex is missing, `/rice-models setup codex` installs a private
   copy and prints its login command. For another provider, follow the
   [provider setup table](#provider-specific-setup).

2. For a declared API or local provider, run `/rice-models providers`, then
   `/rice-models approve <provider>` with its configured provider name. Refresh
   the available catalogue:

   ```text
   /rice-models setup
   /rice-models models
   ```

3. Choose an exact model ID returned by that catalogue with `/model <id>`.
   Use `/rice-models doctor` and `/rice-models status` to inspect current state.
   A successful main turn confirms that route only; it does not establish
   compaction, internal-tool, evaluator or full native-search coverage.

For later sessions, continue using ordinary `claude`. Discovery lists candidates;
a live request establishes whether your account currently has access. No new
startup command, alias, wrapper, global preload or replacement executable is
recommended. Do not use the published version's historical native setup path.

### What setup does

At session startup, the function hooks check Node and the bundled helper, fetch
fresh supported model catalogues and metadata, start a private session helper,
and synchronize discovered candidates into `/model`. Setup preserves other
settings and model rows, including customized rows. Cached names and configured
defaults are not discovery fallbacks; failed discovery reports an unavailable
source rather than inventing candidates.

Installing through the standalone Claude plugin CLI prepares the mod for your
next Claude Code session. After an update, `/reload-plugins` or an ordinary
restart can load updated function hooks. Neither supplies the missing native
integration. Account login and provider approval remain explicit user actions;
installing a plugin cannot grant a subscription, credit, API key or entitlement.
`/rice-models setup` rechecks setup. `/rice-models doctor` provides read-only
diagnostics. Neither changes the selected session model.

### Web search

The published 0.8.0 native adapter implemented the following search order. This
is reference material for its search contracts, not a claim that ordinary
Claude currently runs the complete chain:

1. Search supplied by the selected provider and account, when its endpoint and model support the request.
2. Your saved search services, in ascending priority order. Put a self-hosted or free service first and cloud services after it.
3. Claude Code's native WebSearch, using the Anthropic account currently selected for this session.

The final Anthropic fallback is specific to dedicated WebSearch. It is not a
fallback for ordinary inference, compaction or subagents. The complete chain
depended on the rejected adapter, so native WebSearch through ordinary Claude
must not be promised to work when Claude's quota is exhausted. The configured
retrieval helper can query a working saved service independently of Anthropic
inference; that result alone does not prove native-tool integration.

Add services from inside the mod:

```text
/rice-models search setup
/rice-models search
```

The setup dialog asks for the service, endpoint, priority and credential reference.
You can also configure it directly:

```text
/rice-models search add home searxng https://search.example/search priority=10
/rice-models search add brave brave https://api.search.brave.com/res/v1/web/search priority=20 key-env=BRAVE_SEARCH_API_KEY
/rice-models search add tavily tavily https://api.tavily.com/search priority=30 key-env=TAVILY_API_KEY
/rice-models search priority home 0
/rice-models search remove tavily
```

Use your actual SearXNG URL with JSON results enabled. Supply cloud keys through
the named environment variable or an absolute credential-helper argv in
`<CLAUDE_CONFIG_DIR>/rice-multi-models/search.json`. Enter only variable names in
the session. Each service receives its own credential. Edits apply on the next helper
retrieval; no restart is needed. Existing `RICE_MULTI_MODELS_SEARCH_URL` configuration
remains a SearXNG fallback after saved services.

Official OpenAI Responses, Anthropic Messages and Google GenerateContent endpoints
have dedicated search contracts; actual account/model availability is checked
when searching. Codex uses its subscription backend and selected login. Ollama
cloud search uses the selected, explicitly configured Ollama cloud account;
localhost inference alone never enables cloud search. Other compatible endpoints
can opt in through the model's `"webSearch": "native"` setting; `"off"` skips that
provider's search. A protocol name alone does not establish search support.

Search restrictions are preserved. Unsupported domain, location or invocation
limits advance to saved services. In particular, Google grounding does not expose
an exact server-tool invocation limit, so requests requiring that bound use the
next search option. Codex accepts a bounded result only when its completed
response provides sufficient search-call accounting; that check cannot cap
already consumed server work. Provider/service output is buffered before failover,
and cancellation stops the chain. See the [provider research](docs/research/provider-web-search-20261016.md)
for contracts and limitations. The adapter also routed WebFetch summarization
through the conversation's selected provider while retaining native page
retrieval. That native inference coverage is incomplete in ordinary Claude.

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
- **Diagnostics report an inactive native adapter:** this is expected with
  ordinary Claude under the current limitation. Do not follow historical
  native-setup instructions in the published command output. Reloading or
  restarting cannot supply the missing API coverage.
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
| Main session | `/model <id>` using an actual id from `/rice-models models` in ordinary Claude |
| A subagent type of yours | `model: codex/gpt-6.1-sol` in its agent file (`.claude/agents/*.md`) |
| Ad hoc | the agent types `rice-multi-models:codex` and `rice-multi-models:codex-explore` |
| Mixed | a Claude session with Codex subagents, or a Codex session with Claude subagents (`model: haiku`) |

For routed turn hooks, `/effort` and `--effort` reach the selected provider, and
reasoning and tool calls retain their stream shapes. The required behavior also
includes native compaction, temporary skill aliases, background model aliases,
and every auxiliary request using its conversation's selected provider. That
complete behavior remains unresolved through the exposed plugin API. A routed
compaction refusal may still print a historical activation instruction in
0.8.0; that instruction is no longer recommended.

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

The historical native adapter correlates Worker instances, dispatch IDs and
operation ports,
then retains immutable ownership across asynchronous continuations. It routes
native Messages requests inside the host process using the existing direct
clients. Concurrent children keep distinct owners; child completions,
classification and transcript forks do not borrow the parent's provider.
Unknown ownership fails closed. This describes the rejected startup integration,
which ordinary Claude does not load. It is not evidence of full plugin-only
ownership coverage. Ordinary routed turn inference keeps its provider on failure;
the dedicated WebSearch exception is described above.

The adapter's protocol contracts preserve native request caps, named tool choice,
structured output, domain restrictions, cancellation and exact stop strings across
protocol families. Their native-path acceptance tests are historical evidence
for that integration, not full ordinary-Claude acceptance.
Configured ceilings remain in force. Codex subscription inference has no server
output-cap field; a reported overrun fails the native contract, while local stop
handling cancels the owned stream. This cannot guarantee a cap on billed server
generation. Model capabilities and provider entitlement still depend on the
actual selected model. Local input estimates remain estimates.

Before a model switch, the mod denies a switch whose native `context_tokens` exceed
fresh exact destination metadata: the minimum of reported input limit and active
`contextWindow ?? maxContextWindow`, when available. It does not compact, change the
selected model, alter defaults or rewrite history. Unknown, stale, CLI-worker and
native Claude destination bounds are not inferred from the process-global override.
A switch allowed by this guard is not proof that the next request fits (for example,
new instructions and output also need room). Server-side search/fetch transcript
blocks are retained as historical data rather than rerun as client tools.

**Primary context-window metadata:** For the main routed native-provider model,
the published function hooks synchronize Claude Code 2.1.299's process-local
`CLAUDE_CODE_MAX_CONTEXT_TOKENS` override from fresh metadata for the exact active
model, using `contextWindow ?? maxContextWindow`. This sets the native context
meter's window and automatic compaction threshold, not provider entitlement or
available input/output capacity. An existing explicit owner override remains
authoritative. On unknown routes, discovery failure or `session.end`, the mod
restores the value it owns; ownership state is preserved across hot reload.
External status-line output can retain its pre-reload text until the next normal
engine refresh. This meter integration does not route native compaction or
establish complete provider coverage, and its historical build checks do not
qualify every current host version.

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

Published **0.8.0** remains a historical release. Its complete native behavior
used the startup integration rejected by the current requirement. This README
correction does not supply a compliant replacement or announce a new runtime
release. Ordinary plugin updates do not remove the API coverage limitation.

The `rice-mods` marketplace tracks this repository's `main` without a
tag pin. Update both the marketplace and your installed mod, then reload or restart
the session:

```bash
claude plugin marketplace update rice-mods
claude plugin update rice-multi-models@rice-mods
```

## Requirements and platform scope

**Consumers:** Use ordinary Claude Code with Node.js 22 or newer. Optional
provider CLIs, account access and credentials depend on the providers you use;
Codex login is not required for a declared local endpoint. The compiled helper,
authenticated WebSocket implementation and provider instruction asset are
included in the plugin payload. No consumer dependency installation is needed.

The Node helper handles macOS/Linux paths and Unix sockets, plus native Windows
paths, npm shims and named pipes. WSL uses the Linux environment. These helper
capabilities do not establish complete native inference coverage through the
plugin API. Historical adapter qualification for Claude 2.1.299 on macOS, Linux
and Windows used the rejected startup integration. It is not an ordinary-Claude
compatibility guarantee. Claude's Chrome integration retains its native OS and
browser-login requirements; WSL Chrome control is outside this mod's scope.

**Contributors:** pinned npm development tools build and typecheck the Node
helper. Bun is retained only for the existing contributor test suite, not for
installed sessions. Tool schemas are generated for a Claude Code build with
`NODE_PATH=<typescript install> bun scripts/gen-schemas.ts --tools <claude-code.d.ts>`;
that is release maintenance, not an installation step for every user.

## Build and tests

These contributor checks exercise the published implementation, including its
historical startup integration. They do not certify full functionality through
ordinary Claude's exposed plugin API.

- `npm install --ignore-scripts` installs development/build tools using the
  committed npm lockfile; never run it inside an installed plugin cache.
- `npm run build` regenerates the shipped helper. Commit the artifact with its
  source changes so a Git-backed marketplace install includes executable code.
- `npm run build:check` verifies the committed artifact matches its source.
- `npm run typecheck` checks production helper and adapter source against Node types.
- `npm run test:node` exercises the Node helper and runtime-specific behavior.
- `npm run test:native` runs lifecycle fixtures through `claude plugin test` in
  an isolated temporary plugin payload, separate from Bun's test files.
- `npm run test:routing` uses the real engine to verify that migrated picker
  rows allow a supplied 500k context override and that exposed auxiliary
  completions and classifications route without native provider calls. Its
  metadata and provider events are deterministic fixtures, not live entitlement
  or discovery evidence.
- `npm run test:adapter` runs actual native main/child loops, mixed-provider
  auxiliary calls, skills, web tools, auto classifiers, prompt and agent hooks,
  manual/automatic compaction, UUID resume and partial-stream failure. Anthropic
  inference is denied; direct local providers exercise all five API protocols.
- `npm run test:launcher` installs only in an isolated home and verifies path
  spaces, unrelated-file protection and normal plugin-cache updates.
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
