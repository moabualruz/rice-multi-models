# rice-multi-models

A Claude Code mod that runs models from other subscriptions, APIs and local
servers as ordinary Claude Code session and subagent models. Claude Code keeps
its own tools, permissions, transcript, compaction and agents; the mod answers
each routed request with a direct call to the provider you selected. It works
inside the normal `claude` command through supported plugin hooks. Release
0.11.0 removed every mod-owned agent type; Claude Code built-ins and user-supplied
agent files remain native. Release 0.12.0 added credential-free web-tier
eligibility and configuration diagnostics. Release 0.13.0 preserves more document
and image content across provider codecs and reports configured model capabilities,
including tool coverage and web tiers, in setup, doctor and status. Release 0.14.0 lets the
Agent tool's `model` argument name any discovered `<provider>/<model>` id exactly. It registers no
MCP tools and needs no launcher, proxy or gateway.

**Each conversation stays on its own provider family.** A Codex session's
routed subagents, skills, compaction, titles, permission judgments, web search
and web fetch use Codex too. A subagent you deliberately put on another provider
keeps that provider. Some engine-owned classifiers remain native Claude Code
behavior, as listed in [Known limits](#known-limits). See [Families](#families).

Providers:

- **OpenAI Codex through a ChatGPT subscription** (the Codex CLI login in
  `~/.codex/auth.json`): model ids `codex/<slug>`.
- **Any endpoint you declare** in `~/.claude/rice-multi-models.json`: Chat Completions,
  the OpenAI Responses API, Anthropic Messages, Google Gemini or Bedrock, chosen per model:
  Ollama, llama.cpp, vLLM, LM Studio, OpenRouter, OpenAI, Anthropic API keys, other clouds.
  Model ids `<provider>/<model>` or an alias. See `example.rice-multi-models.json`.
- **OpenCode Zen and OpenCode Go**: `/rice-models opencode write` declares every model
  each one serves, in its own protocol, with the key from OpenCode's login.
For switching between saved Anthropic OAuth accounts in one session, use the
companion [rice-session-accounts](https://github.com/moabualruz/rice-session-accounts).

## Install and start

You need Claude Code 2.1.301 or newer and Node.js 22 or newer on the PATH
Claude Code starts with. CI covers 2.1.301, 2.1.302 and 2.1.306 on Linux, plus
2.1.302 on native Windows. Install from a terminal:

```sh
claude plugin install rice-multi-models --marketplace moabualruz/rice-mods
```

The helper and its dependencies are bundled; nothing is built or installed
inside the plugin cache. Then:

1. Start `claude` as usual and run `/rice-models setup`. It checks Node and the
   helper, discovers the models your logins and providers offer, and adds them to
   the `/model` picker without touching your other picker rows or settings.
2. Sign in to the providers you want (see [Provider setup](#provider-setup)).
   Codex reuses your existing `codex login`; `/rice-models setup codex` installs a
   private copy of the Codex CLI if you have none and prints its login command.
3. For a declared API or local provider, approve it once with
   `/rice-models approve <provider>` (or accept the prompt on first use).
4. Pick a model with `/model <id>`, for example `/model codex/gpt-6.1-sol`.
   `/rice-models models` lists every discovered id with its reported limits.

`/rice-models setup`, `/rice-models status` and `/rice-models doctor` report the
capability contract for every configured provider model. It covers the configured
tool allowlist and provider cap, schema mapping, vision and document handling,
known or unknown token bounds, parallel calls, effort, cache and web settings.
The report describes this mod's configuration and request mapping, not a vendor
certification or a guarantee that a model accepts every schema keyword. Unknown
metadata stays unknown. A routed model offered fewer tools than the session has
adds a coverage warning. Discovery lists candidates; a real request is what
establishes access and quota.

## Families

A family is a provider: `codex`, each declared provider id, or `claude` for
Anthropic's native models.

| You do | What runs |
| --- | --- |
| `/model codex/...` and ask for a subagent | The subagent runs on the same Codex model |
| Agent tool `model: haiku`, `sonnet`, `opus` or `fable` in a routed session | That tier inside the session's family (see `tiers` below), not Claude |
| Agent tool `model` argument with an exact discovered id, such as `codex/gpt-6.1-sol` (see below) | Exactly that model, with no tier mapping |
| Agent tool `model` argument with an id nothing discovered | Refused with the list of valid ids; no subagent starts |
| Built-in agents with their own default (Explore uses haiku) | The session's family |
| A custom agent file with `model: openrouter/some-model` | Exactly that model |
| A skill with `model: haiku` (or another alias) or `context: fork` | The family of the conversation that runs it |
| A skill with `model: provider/model` | Exactly that model |
| A session on native Claude | Claude Code's own behavior, unchanged |

Claude Code's built-in agents and user-supplied agent files stay native. The mod
registers no agent types of its own. Global, project, and plugin agent files keep
their frontmatter, aliases, tools, and prompt; a file without `model` or with a
native Claude model keeps Claude Code's normal resolution.

To route a custom agent to an exact model, put its full id in the agent
frontmatter, for example `model: codex/gpt-6.1-sol`. That id reaches the engine
unchanged and `agent.spawn` routes the resulting step. Frontmatter works in every
session, routed or native. The main prompt gets a short section listing discovered
families and models; no tools are added.

### Exact ids in the Agent tool

`Agent({ model: '<provider>/<model>' })` runs the subagent on exactly that id. The
id is any model the mod discovers (a Codex model, a declared provider's model, OpenCode,
a local model) or a declared alias, spelled as `/rice-models models` lists it. There is
no tier mapping, wrapper agent or proxy: the engine's own Agent tool starts the subagent
on the id.

- **What the model sees.** In a routed session the Agent tool's `model` schema is the
  engine's own enum plus every accepted id (with more than 200 ids the enum is dropped for a
  plain string), and the tool description gets one separated line, derived
  from discovery at runtime, naming the accepted ids. The engine's own description text is
  kept as it is. A Claude-native parent sees the same description line, but the API schema
  it receives is the engine's, so exact ids through `Agent.model` are meant for routed
  sessions. Use frontmatter anywhere else.
- **How it works.** The engine checks `model` against four values, but only after the
  mod's `tool.call` hook has seen the raw call. The hook records the exact id under the
  call's `tool_use_id` (in host session state, so a hot reload keeps it), passes the
  engine a valid value (`haiku`) and adds a visible description note naming the exact
  model and explaining that `haiku` is validation only. `agent.spawn` takes the id back,
  removes the note and runs the subagent on the id. Each parallel call has its own record; a record is removed when its spawn takes
  it, and when its call ends for any reason.
- **How failure looks.** An id nothing discovered or declared is refused before the engine
  runs the call: `rice-multi-models: Agent model "<id>" is not a model this session can
  run, so no subagent was started. Valid values: haiku, sonnet, opus, fable, <ids>.` A
  marked spawn whose record is missing is refused, not run as `haiku`: `this Agent call's
  exact model could not be recovered (no record for it), so it was not run as haiku`. An
  exact id on a fork is refused, because a fork runs on its parent's model. A resumed
  agent and a workflow agent keep their own model.
- **The honest limit.** This relies on the engine calling `tool.call` hooks before it
  checks the arguments, which no documentation promises (verified on Claude Code 2.1.302
  and 2.1.307). If a later engine checks first, an exact id fails in the engine's own
  validation with its message, and nothing runs on the wrong model. The Agent permission
  input still has the carrier value (`haiku`), but its description visibly names the exact
  model and permission asks add the exact id to their reason without changing the decision.
  Transcripts can retain that visible note; the child task description does not. Upstream
  requests: let `tool.describe` override input-schema fields that are not pinned, or let
  `Agent.model` accept any string that `agent.spawn` resolves or denies.

Map tiers to specific models per family in `rice-multi-models.json`:

```json
{
  "tiers": {
    "codex": { "haiku": "codex/gpt-6-luna", "opus": "codex/gpt-6.1-sol" },
    "openrouter": { "default": "openrouter/qwen3-coder" }
  }
}
```

Use ids from `/rice-models models`. Without a tier entry, a subagent uses the
parent's own model. Entries naming a model from another family are ignored.

## What runs where

| Claude Code feature | In a routed conversation |
| --- | --- |
| Main and subagent turns | Selected provider, with Claude Code's tools and permissions; each built-in tool with the description and input schema the installed `claude` sends, and a subagent with the system prompt and tools the engine gives its agent type (see Known limits) |
| `/compact` and automatic compaction | Claude Code's own summary prompt (with your `/compact` instructions in its slot) over the conversation as real messages, answered by the selected provider with its reported output bound; the engine's own summary message wording, citing the transcript file; a bounded tail of recent messages and their tool pairs kept verbatim; a failed or unreadable-prompt compaction keeps the original transcript |
| Session titles | Selected provider, local fallback, manual names kept |
| Auto-mode permission judgments | Selected provider receives your effective auto-mode policy; Claude Code's native classifier, rules, hooks and managed limits can still decide the action |
| SubagentHandback admission classifier | Claude Code's native classifier; the public plugin API does not route this engine-owned decision |
| WebFetch | Provider-native retrieval where supported, configured fetch services, Claude Code native WebFetch, then direct fetch with selected-provider extraction if native fallback is unavailable |
| WebSearch | Selected provider's own search, then your saved search services, then Claude's native search with the session's account |
| Stop / SubagentStop prompt hooks | Selected provider |
| Plugin auxiliary calls (`model.complete`, `classify`, `fork`) | The main conversation's family |
| Context meter and automatic compaction threshold | The selected model's reported context window |

### Known limits

These come from what Claude Code exposes to plugins today:

- **Compaction.** The engine cannot send its own summary request to another provider, so the mod sends it: once per Claude Code version it runs the installed `claude` for a few seconds in a throwaway folder against a loopback stub (no network, none of your settings or sessions) to read the engine's own summary prompt and summary-message wording, and keeps them. Nothing of that text is copied into this repository. If it cannot be read, a routed conversation is not compacted and says why. Two things the host gives a plugin no way to do: your `PreCompact` hooks do not run for a routed compaction and `PostCompact` hooks receive an empty summary, and the summary appears as a message in the conversation, not as the collapsed "Compacted" row.
- **Tool definitions and agent prompts.** A routed session builds no Anthropic request, so the engine never renders its tools or a subagent's prompt for the mod. Once per Claude Code version and combination of your session's built-in tools, the mod runs the installed `claude` for about a second in a throwaway folder against a loopback stub (no network, none of your settings, plugins or sessions): the engine's first request gives the tools as it sends them, and the stub has it start every agent type it lists, plus a marker agent, in the foreground and in the background, to read each agent's system prompt, the text the engine puts around every subagent prompt (agent files included), and the tools it offers each type. The result is kept in the plugin's store; nothing of that text is copied into this repository. The identity line the engine opens a subagent prompt with is left out, as the main prompt's identity sections are; the subagent's environment and model notice reach it in its transcript, as natively. Without the capture a main step sends the schema table generated for this build and the descriptions the session lists, a routed subagent step is refused rather than run on a made-up prompt, and `/rice-models status`, `doctor` and the debug log say so; a failed read is tried again after a minute or at `/rice-models refresh`. What the capture cannot reach:
  - The run is headless with default settings and permission mode. Where the engine words a tool differently in an interactive session, under another permission mode or for an account feature, the routed model gets the headless wording; in 2.1.302 that is the Agent and Bash descriptions in an interactive session, and Bash under `bypassPermissions`.
  - Tools a headless run never offers (AskUserQuestion, EnterPlanMode, ExitPlanMode) keep the session's description and the generated schema. MCP tools keep the session's description and a loose schema: the capture runs without your servers and credentials, and the host gives a plugin an MCP tool's description but not its input schema.
  - An agent type the engine lists only in some sessions (claude-code-guide is not listed to a headless run without an account) has no captured prompt; a routed step of it is refused.
  - SubagentHandback is offered only in auto mode, where every Agent call passes the engine's own classifier, so the capture cannot start one; the mod keeps its own definition of that tool (the engine's name and input shape).
  - A headless foreground subagent is offered a few more tools than a background one, and an interactive session's subagents get the background set; the mod follows that.
- **Auxiliary prompt text.** Session titles, auto-mode permission judgments, WebFetch extraction, and Stop or SubagentStop prompt evaluators still use text written by this mod. These are headless capture limits, not substitutes claimed to be native:
  - The title hook receives the host's title event/result, not the internal title-generation request. The isolated title proof verifies selected-provider generation, persisted titles, manual titles, and failure fallback, but cannot capture Claude's native title prompt.
  - The permission hook receives the pending action and effective policy, not the host classifier's prompt. The isolated auto-mode proof verifies selected-provider judgments and actual native mode controls; it did not expose a stable native classifier prompt to the plugin.
  - Stop and SubagentStop system blocks matched across marker runs, but the full requests differed, so no independently stable byte-for-byte prompt was established. Prompt evaluators continue to route to the selected provider; agent-type evaluators remain native.
  - The WebFetch proof verifies the configured provider-native, saved-service, host-native and direct-fetch chain with selected-provider extraction, and refusal on selected-provider failure. It does not capture Claude's internal extraction prompt.

  No native auxiliary prompt was substituted without an independently verifiable capture. The plugin does not silently fall back from an unavailable native prompt capture to invented agent/tool text; routed built-in agent steps without a valid capture are refused with a visible diagnostic.
- **Transcript content.** Text, images, inline PDF and plain-text documents, tool calls and results are retained or translated by each supported codec. Unsupported reasoning, source shapes and provider-specific blocks produce visible omission notes. Chat Completions accepts plain-text documents as text but cannot accept PDF document blocks; image and document URL sources are not fetched by the adapter.
- **Host API gaps.** MCP input schemas, engine-owned inference hooks, compaction lifecycle callbacks, full evaluator-source provenance, Agent model choices and pinned teammate models need host support. The current behavior and specific API requests are documented in [Host limits](docs/host-limits.md).
- **A long step shows a stale label.** After a compaction or a subagent spawn the engine's spinner keeps reading "Running SessionStart hooks..." for the whole next routed step, which can take minutes on a large context. The session is working; the label is the engine's.
- **Child permission modes.** On Claude Code 2.1.306, a child created with explicit
  `permissionMode: 'auto'` under a plan-mode parent resolves to effective `plan`.
  The version-aware proof checks the host's effective mode, and the permission gate
  uses native `PreToolUse` mode evidence rather than inferring a child's mode from
  its registration settings. The selected-provider judgment does not replace the
  host classifier or bypass native permission checks.
- **Auto-mode handoff review.** When a subagent finishes while its parent is in
  auto mode, Claude Code reviews the report with its own classifier, which uses
  Claude. If Claude is unavailable the report is still delivered, with a note.
- **Agent-type Stop hooks** (`type: "agent"`) run natively, so every other hook
  for that event still runs. Prompt-type hooks are routed.
- **Hooks the mod cannot see.** If another enabled plugin (including one with
  function hook modules), an invoked skill, an agent definition file or a session
  plugin directory may add Stop hooks, that event runs natively rather than risk
  skipping a hook.
- **`--no-session-persistence`.** Routed subagents, forked skills and fork
  subagents need session persistence (the default). Without it their transcripts
  are not readable by plugins, so a routed one reports that instead of answering;
  nothing is sent to Claude in its place.
- **Resuming.** `--resume` and `/resume` start on your default model. When a
  conversation that last ran on a routed model resumes on another one, the mod
  shows the `/model` command that continues it on its previous model.
- **Invalid configuration.** If `rice-multi-models.json` does not validate, its
  declared models are refused with the validation error until it is fixed and
  reloaded; they are never sent to Claude.
- **Mode detection limits.** A switch from auto to plan mode during a pending
  permission judgment is found by comparing the host's own answers for harmless
  probes. It cannot be found in a session without file-edit tools, or in a working
  directory the host flags as a suspicious Windows path (for example an 8.3 short
  name such as `RUNNER~1`), where every path asks before the mode is checked.
  Other mode changes are found in both cases.

## Web search

WebSearch tries, in order:

1. The selected provider's own search, when its endpoint and model support it.
2. Your saved search services, by ascending priority. Put a self-hosted or free
   service first and paid cloud services after it.
3. Claude Code's native WebSearch with the Anthropic account selected for this
   session. This fallback applies to search only, never to ordinary inference.

Add services from inside a session:

```text
/rice-models search setup
/rice-models search
/rice-models search add home searxng https://search.example/search priority=10
/rice-models search add brave brave https://api.search.brave.com/res/v1/web/search priority=20 key-env=BRAVE_SEARCH_API_KEY
/rice-models search add tavily tavily https://api.tavily.com/search priority=30 key-env=TAVILY_API_KEY
/rice-models search priority home 0
/rice-models search remove tavily
```

Use your own SearXNG URL with JSON results enabled. Give cloud keys as the name
of an environment variable or an absolute credential-helper command in
`<CLAUDE_CONFIG_DIR>/rice-multi-models/search.json`; never paste a key into the
session. Changes apply on the next search.

Official OpenAI Responses, Anthropic Messages and Google endpoints have their own
search contracts, checked when searching. Codex uses its subscription backend.
Other compatible endpoints opt in with the model's `"webSearch": "native"`
setting; `"off"` skips that provider's search. A native route is skipped before
its call whenever it cannot enforce a requested restriction, including Codex
`maxUses` and blocked-domain filtering. The routed WebSearch applies an 8-use
bound, so Codex uses a later tier for those requests. A valid empty result is
terminal and does not trigger another service. `/rice-models doctor` and
`/rice-models status` show the selected model's native eligibility and reasons,
configured services in priority order, and whether the Claude fallback can be
attempted. This metadata omits endpoint URLs and credential references; live
Claude account access is verified only if that fallback is used. Safe debug
messages identify the stage that answered. The same doctor/status object now
includes ordered fetch tiers, safe configured service names and priorities,
configuration-read status, and readiness notes for Claude Code native WebFetch
and direct retrieval with selected-model extraction. No endpoint URL or auth
reference is returned. See the [provider research](docs/research/provider-web-search-20261016.md).

## WebFetch

WebFetch follows this order and stops at the first successful result:

1. **Provider hosted fetch**, only where a supported protocol and exact official endpoint provide it. This mod supports Anthropic Messages `web_fetch` at `https://api.anthropic.com` and Google Gemini GenerateContent URL Context at `https://generativelanguage.googleapis.com`. A compatible server hosted elsewhere is not assumed to implement either tool.
2. **Configured fetch services**, tried serially by ascending priority.
3. **Claude Code native WebFetch**, using the current session's host authorization and HTTP handle.
4. **`direct-selected-extraction`**, only after Claude Code native WebFetch is unavailable. The mod resolves the page destination, rejects non-public addresses, pins each connection to a checked address, manually follows and rechecks redirects, bounds the response, then asks the selected provider to extract from the fetched text. This is a recovery tier, not provider-native fetch: the mod itself retrieves the page.

Claude Code's native permission processing still runs first. The hook gates the exact checked WebFetch input before replacing the engine implementation. A broad permission rule or a URL supplied by a caller does not skip that native gate. An unsafe or unresolved destination fails closed. Provider output that has started is not switched to another tier after a later provider error. Valid empty page content is a successful terminal result.

Provider-native eligibility is checked before the provider request. Anthropic requires
an `anthropic` model, a `claude-` model id and the exact HTTPS API origin. The encoder
uses `web_fetch_20260318` for Claude 4.6+, Claude 5 and Mythos Preview; other Claude
model ids use `web_fetch_20250910`. The official reference does not provide a complete
model-by-model eligibility list for the basic tool, so local checks cannot prove that
every Claude model or account accepts it. Doctor says when this remains provider-verified;
a rejection before output begins advances to the configured-service tier.

Gemini uses the GenerateContent `url_context` tool, not the newer Interactions API.
Automatic eligibility is restricted to the documented model ids `gemini-4-argon`,
`gemini-3.8-flash`, `gemini-3.6-flash`, `gemini-3.5-flash-lite`,
`gemini-3.1-pro-preview`, `gemini-3.1-flash-lite`, `gemini-3-flash-preview`,
`gemini-2.5-pro`, `gemini-2.5-flash` and `gemini-2.5-flash-lite` at the exact
Google API origin. The provider can still reject a model/account request. Doctor and
status report this local eligibility separately from whether the account has been
verified.

### Configured fetch services

Save version 1 configuration in `<CLAUDE_CONFIG_DIR>/rice-multi-models/fetch.json` (or `~/.claude/rice-multi-models/fetch.json` when `CLAUDE_CONFIG_DIR` is unset). The file is read for each WebFetch call. Each endpoint receives a JSON POST with `url` and `maxBytes`; successful responses must be JSON objects with the same `url`, string `content`, and optional string `contentType`. Redirects are rejected and response bodies are limited.

```json
{
  "version": 1,
  "endpoints": [
    {
      "name": "self-hosted",
      "url": "https://fetch.example/api/fetch",
      "priority": 10,
      "auth": { "env": "FETCH_SERVICE_TOKEN" }
    },
    {
      "name": "hosted-backup",
      "url": "https://fetch-backup.example/v1/fetch",
      "priority": 20
    }
  ]
}
```

`auth` may reference an environment variable by name or an absolute credential-helper command. The referenced secret value is read only at request time, is sent only to that endpoint as a Bearer token, and is not returned by status state. Authenticated endpoints must use HTTPS. Do not put a credential value in the JSON file or URL. Endpoint priorities are nonnegative integers; ties retain file order. An empty `content` string is a valid success and prevents later services from being tried.

The pure hook-side state interface is exported from `hooks/fetch-config.ts` as `fetchTierConfigState(config, providerNative)`. It accepts endpoint metadata and a boolean indicating whether the selected route passes the local protocol eligibility checks. It always reports all four runtime tiers, with `eligible: false` and a skip reason for provider-native fetch when the route does not qualify. Configured service names and priorities are ordered without endpoint URLs, credential references or values. Provider/account model support is not claimed unless confirmed by the actual request. The final two entries are always `native-fallback` and `direct-selected-extraction`.

Protocol support is intentionally narrow. Anthropic Messages has a hosted `web_fetch` server tool. Gemini URL Context retrieves supplied URLs and returns model-generated text with URL retrieval metadata, rather than raw page text. OpenAI Responses web search is not treated as arbitrary URL fetch. OpenCode's `webfetch` is an application tool, and Ollama's web fetch is a separate REST endpoint; neither is a provider-protocol tool in this chain. The current Bedrock Converse adapter has no hosted fetch contract. Bedrock Mantle Responses is a separate API surface.

## Provider setup

| Provider | What you supply | Login or configuration |
| --- | --- | --- |
| Codex / ChatGPT | Codex CLI and a ChatGPT account with access | `codex login`; reuse `$CODEX_HOME/auth.json` or the default `~/.codex/auth.json` |
| OpenCode Zen / Go | OpenCode CLI login, plus Zen credit or an active Go subscription | `opencode auth login`, then `/rice-models opencode write` |
| Declared API / local endpoint | Endpoint, model definitions and an auth command, or `auth: "none"` for a local server | `~/.claude/rice-multi-models.json`; approve the provider when prompted |

`/rice-models setup codex` installs the pinned official Codex CLI into the mod's
own state folder (never globally) and shows its login command.
An existing Codex on PATH takes priority. The helper calls providers directly;
Codex's CLI keeps owning login and token renewal. A changed provider address or
key command asks for approval again.

## Diagnostics and repair

- **Models are missing:** run `/rice-models setup`, then reopen `/model`.
- **Node is missing or too old:** make Node.js 22+ available to Claude Code, or
  set `RICE_MULTI_MODELS_NODE` to an absolute Node path, then run setup again.
- **Invalid settings or provider file:** fix the JSON; the mod never overwrites
  a malformed file.
- **Login or subscription missing:** finish that provider's login; reinstalling
  the mod does not grant access.
- **An update seems inactive:** update the marketplace and plugin (see
  [Update](#update)), then `/reload-plugins` or restart.
- **Headless runs:** startup never opens login or approval prompts; finish those
  in an interactive session first.

`CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `XDG_DATA_HOME` move the Claude, Codex and
OpenCode folders. On WSL the Linux HOME and PATH are used; a Windows-side login
is not imported.

## Use

| Where | How |
| --- | --- |
| Main session | `/model <id>` or `claude --model <id>` with an id from `/rice-models models` |
| Your own subagent type | `model: provider/model` in its agent frontmatter (`.claude/agents/*.md`), for example `model: codex/gpt-6.1-sol` |
| Ad hoc | Create or choose an agent definition with the desired exact `model` id in frontmatter |
| Mixed | A Claude session with routed subagents, or a routed session with Claude subagents whose agent frontmatter names a Claude model id |

`/effort` and `--effort` reach the selected provider. `/rice-models effort <level>`,
`/rice-models transport auto|ws|sse` and `/rice-models helper session|once` change
them for the session.

### Discovery and picker

Every session start runs bounded discovery: Codex's authenticated models
endpoint and approved declared providers' `/models` APIs. Unapproved providers
are not contacted. Reported context, input and output limits, modalities, efforts
and tool support are kept as reported; `null` means not reported.
`/rice-models refresh` fetches a new snapshot.

The `/model` picker gets one row per discovered model in `~/.claude/settings.json`
(`modelPicker`). Rows you wrote or edited are kept, no row claims another model's
capabilities, and older generated rows with a `behavesAs` alias are replaced (that
alias made Claude Code enforce the wrong context window).

For the main routed model, the mod sets Claude Code's process-local
`CLAUDE_CODE_MAX_CONTEXT_TOKENS` from the model's reported context window, so the
context meter and automatic compaction use the real window. An override you set
yourself wins. The guard before each routed request estimates its size from the
provider's own usage report for the previous request plus the messages added
since, and stops a request that would exceed 95% of the reported input bound.
Before a model switch, a switch whose context exceeds the destination's reported
bound is denied.

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
`maxTokensParam` (`max_tokens` or `max_completion_tokens`), since endpoint dialects
cannot be guessed from a model name. A model's `tools` can list the only tools it is
sent, which keeps small local models inside their window:
`["Read", "Edit", "Write", "Bash", "Glob", "Grep"]`. The optional top-level `tiers`
block is described under [Families](#families).

| `kind` | Protocol | Path under `baseUrl` | Key header |
| --- | --- | --- | --- |
| `openai` | Chat Completions | `/chat/completions` | `Authorization: Bearer` |
| `responses` | OpenAI Responses (`store: false`, reasoning carried back encrypted) | `/responses` | `Authorization: Bearer` |
| `anthropic` | Anthropic Messages | `/v1/messages` (`/messages` when the base ends in `/v1`) | `x-api-key` |
| `gemini` | Google generateContent (thought signatures carried back) | `/models/<id>:streamGenerateContent?alt=sse` | `x-goog-api-key` |
| `bedrock` | Amazon Bedrock Converse | `/model/<id>/converse-stream` | `Authorization: Bearer` |

A model may set its own `kind`, so one service that serves each model in its maker's
protocol is one provider. A provider's `authHeader` (`bearer`, `x-api-key` or
`x-goog-api-key`) sends every model's key one way. A `responses` model that does not
reason takes `"params": { "include": null }`. A provider's `sessionHeader` carries a
stable hash of the conversation, which some services route and cache by.

Each provider is approved once: the first step asks (or run
`/rice-models approve <provider>`), and a changed address or key command asks again.
Keys are read only by the helper, at request time, and never logged. A step past the
model's input budget is not sent and asks for reduced context or a new session.
`/rice-models providers` lists them; `/rice-models reload` re-reads the file.

### OpenCode Zen and Go

`/rice-models opencode` builds both providers from each service's model list
(`/inference/v1/models`, `/inference/go/v1/models`) and the models.dev catalog OpenCode
itself reads: each model's explicitly reported SDK determines the supported protocol
(Chat Completions, Responses, Anthropic Messages or Gemini); reported limits and
modalities are imported without inventing output ceilings or reasoning efforts.
`/rice-models opencode write` saves them as `opencode` (Zen, pay as you go) and
`opencode-go` (the Go subscription) and keeps your other providers; `zen` or `go`
limits it to one. The key comes from OpenCode's own `~/.local/share/opencode/auth.json`
(`opencode auth login`): one console key serves both, so each reads its own entry and
falls back to the other's. Requests carry `x-opencode-session` and name this mod as the
client. Zen needs account credit and Go an active subscription; the service's refusal
says which. OpenCode's free Zen models answer only OpenCode itself.

## How it works

1. `agent.spawn` decides each new subagent's model with the family rules above,
   before Claude Code resolves it.
2. `turn.step` sees each step of the main conversation and of every subagent. A
   routed step is answered by the mod: the main system prompt is the one Claude Code
   composes, a subagent's is the one the installed `claude` sends for its agent type
   (or its agent file's body inside the engine's text), the tools are the session's
   with the definitions the installed `claude` sends (the schema table generated
   from this build is the fallback), and the transcript is the engine's own. A step whose family cannot be resolved is refused
   visibly; it is never sent to Claude instead.
3. `session.compact`, the WebSearch and WebFetch tools, `tool.check` (auto-mode
   judgments), the title hook, Stop and SubagentStop prompt hooks and the plugin
   `model.*` events are answered the same way for routed conversations. Native
   permission rules and hooks always run first.
4. At activation the mod starts the bundled Node session helper
   (`dist/helper.mjs serve`) on a private Unix socket (macOS, Linux, WSL) or named
   pipe (Windows), authenticated with a random token. It keeps one Codex WebSocket
   per conversation between steps, carries only routed requests and exits with
   Claude Code. A helper that was never reached can fall back to a one-shot helper
   (`/rice-models helper once` forces that); failures after connection never retry
   in a way that could replay a dispatched request. Interrupting a step cancels it.
5. The helper sends each request straight to the provider: Codex's Responses
   backend over a WebSocket (falling back to server-sent events) with
   `originator: rice_multi_models`, or the declared endpoint in its own protocol.
   The stream is mapped back to text, reasoning, tool calls and usage.
6. An expiring ChatGPT login is renewed by asking `codex app-server` to do it, so
   Codex rewrites its own `auth.json`.

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
connection setup and retry waits. The one-time HTTP 401 login renewal is separate from
transient retries.

An attempt whose connection or stream sends no bytes for `RICE_CODEX_STREAM_IDLE_MS`
(default `300000`, the Codex CLI stream idle default; `0` disables) is abandoned and retried as
a transient `stream.idle` failure, under the same tool-call replay boundary.

Function-call arguments that the model streams as invalid JSON are a transient
`response.function_arguments` failure: the attempt is discarded and the step sampled again,
under the same tool-call replay boundary.

No attempt is replayed after it emits a whole tool call. Before that boundary, text, reasoning
and signatures are buffered until completion or the first tool call, then released in order,
so a failed attempt's partial answer never mixes into the next one. Final errors identify the
event, provider code/type (or `unknown`), HTTP/close status when available, and attempt count;
login values and credential-shaped text are redacted. In `auto` transport, a rejected
WebSocket connection can fall back to HTTP to recover the structured rejection; forced `ws`
reports the transport error.

`RICE_CODEX_MAX_IN_FLIGHT` configures FIFO admission **per ChatGPT account in each helper
process**. Default `0` (off; Claude Code stops a subagent after 10 minutes without progress,
so queueing behind long steps can end agents); allowed `1` through `15`. Set it in the
environment before starting Claude Code. Waiting steps are cancellable and hold no provider
connection. Separate accounts have separate queues; other Claude Code sessions and the Codex
CLI on the same account are not coordinated. The session helper accepts up to 64 concurrent
steps; more fail fast with "too many steps at once".

## Update

The `rice-mods` marketplace tracks this repository's `main`. Update both the
marketplace and the installed mod, then run `/reload-plugins` or restart:

```sh
claude plugin marketplace update rice-mods
claude plugin update rice-multi-models@rice-mods
```

0.9.1 and later register no MCP tools. If you followed older instructions that used the
`mcp__rice-multi-models__*` tools or a separate startup launcher, use `/rice-models
models` and put exact provider/model ids in your custom agent frontmatter, then start the
ordinary `claude` command.

## Requirements and platform scope

Claude Code 2.1.301 or newer and Node.js 22 or newer. CI covers Claude Code
2.1.301, 2.1.302 and 2.1.306 on Linux, plus 2.1.302 on native Windows. Provider CLIs,
accounts and keys depend on the providers you use; a declared local endpoint needs
no Codex login. The compiled helper, its WebSocket library and the provider
instruction asset are part of the plugin; nothing is installed at runtime.

macOS, Linux, WSL and native Windows are supported: Unix sockets or named pipes,
native Windows paths and npm shims. WSL uses its Linux environment. Claude Code's
Chrome integration keeps its own OS and browser requirements; Chrome control from
WSL is outside this mod's scope.

## Build and tests

- `npm install --ignore-scripts` installs the pinned development tools; never run
  it inside an installed plugin cache.
- `npm run build` regenerates `dist/helper.mjs`; commit it with its source so a
  marketplace install includes it. `npm run build:check` verifies it is current.
- `npm run typecheck` checks the helper; `npm run typecheck:hooks` loads the
  installed Claude Code build's own plugin declarations (no inference) and checks
  every hook against them.
- `bun run test` runs the unit and integration suites, `npm run test:node` the
  Node runtime tests and `npm run test:native` the lifecycle fixtures through
  `claude plugin test`.
- `npm run test:install` copies only the shipped payload into an empty home with
  spaces in its path and runs a local provider through both helper modes.
- The `test:routing`, `test:phases`, `test:protocols`, `test:compaction`, `test:tools`,
  `test:permissions`, `test:permission-mode`, `test:search`, `test:evaluators` and
  `test:titles` proofs start the real `claude` with `--plugin-dir`, local stand-in
  providers and an Anthropic endpoint that refuses everything, and fail if any
  routed request reaches it. `test:tools` checks installed and target engine versions,
  compares shared tool input schemas and captured agent prompts with an independent
  native run, verifies routed schemas against captured, native or fallback schemas, and
  confirms the base's native plugin behavior remains intact.
- `bun run check` runs all of the above plus `git diff --check`. GitHub Actions runs
  it on Linux for Claude Code 2.1.301, 2.1.302 and 2.1.306 and on native Windows for
  2.1.302.

The proofs use local fixtures, never personal accounts; they establish routing and
lifecycle behavior, not a provider's live entitlement or quota.

## Credits

Adapted from [Trosfy/claude-styx](https://github.com/Trosfy/claude-styx) (MIT:
routing, prompts, transcript, assembler, schema generator) and
[greenpolo/cc-multi-cli-plugin](https://github.com/greenpolo/cc-multi-cli-plugin)
(Apache-2.0: Messages/Responses translation, Codex login renewal). See `THIRD_PARTY_NOTICES.md`.

## License

MIT, see `LICENSE`, except the files adapted from cc-multi-cli-plugin: they stay
under the Apache License 2.0 and say so in their headers. `THIRD_PARTY_NOTICES.md`
lists both upstreams.
