# Direct inference inside ordinary Claude

Status: implementation for 0.11.0. This release removes mod-owned agent types while
keeping Claude Code built-ins and user-supplied agent files native. Named host residuals
and current verification limits are listed below; unverified native text is not replaced.

## Required outcome

The main conversation and each subagent own their selected model and provider.
Ordinary turns and the auxiliary work they cause (compaction, titles, permission
judgments, web search and fetch, evaluators, forked skills) use that
conversation's provider family. A conversation stays in its family by default; a
different family is used only when the user or session instructions ask for it.

Users start the official, unmodified `claude` command. The mod works only through
supported plugin hooks. It registers no MCP tools, and it adds no launcher, alias,
preload, binary patch, inference proxy or gateway. Provider clients in the shipped
Node helper make direct requests.

## Families

A family is a provider id (`codex`, a declared provider such as `openrouter`, or
`claude` for native models).

| Situation | Result |
| --- | --- |
| Agent tool `model` alias (`haiku`, `sonnet`, `opus`, `fable`) under a routed parent | The tier inside the parent's family: `tiers.<family>.<alias>`, else `tiers.<family>.default`, else the parent's own model |
| Agent with no model, or a definition naming a native alias | Same as above |
| Agent definition naming `provider/model` | That exact model; the host passes the frontmatter id through unchanged |
| Agent tool `model` argument with an exact provider id | Rejected by Claude Code before hooks; only `haiku`, `sonnet`, `opus` or `fable` are accepted |
| Forks | Inherit the parent model (host rule) |
| Forked skill or skill `model:` alias in a routed conversation | Tier inside the owning conversation's family |
| Parent on native Claude | Native resolution unchanged |

`tiers` is an optional top-level block of `rice-multi-models.json`, keyed by family
id, mapping `default`, `haiku`, `sonnet`, `opus` and `fable` to routed model ids of
that family. Entries from another family are ignored.

The main prompt gets one session section that lists the available families,
default models and tiers, plus guidance to use exact provider/model ids in custom
agent frontmatter. It contains no tool instructions.

## Implementation boundaries

| Boundary | Behavior |
| --- | --- |
| `turn.step` | Answers routed steps for main and subagents from the engine's own transcript, prompt and tools. Native alias steps resolve inside the owner's family. A step whose family cannot be resolved is refused visibly; the hook never throws, because a throwing hook lets the host run the native request. |
| `agent.spawn` | Resolves native aliases inside the parent's family and honors routed ids in readable custom agent frontmatter before the engine resolves the model. Exact ids in the Agent tool argument are rejected by the host before hooks; the mod registers no provider-family or Claude wrapper types. |
| `session.compact` | Selected-provider summary with a bounded verbatim tail of recent engine messages split at an exchange boundary (tool pairs and pending calls kept whole). The summary request is fitted to the model's input bound by shortening tool outputs, then long texts, then leaving out the middle of the oldest history; failures keep the original transcript. |
| `tool.call` / `tool.check` for WebSearch and WebFetch | Native rules and classic PreToolUse run first; the checked input is then served by the selected provider, configured search services, then native search with the session's account (search only). WebFetch still uses the mod-authored extraction instruction. |
| `tool.check` (auto mode) | Unresolved asks for routed conversations are judged by the owner's provider with the effective auto-mode policy and mod-authored request. SubagentHandback is never judged here. |
| Classic PreToolUse command hook | Reports the native per-call permission mode (`scripts/permission-context.mjs`). |
| `classic.UserPromptSubmit` | Returns `sessionTitle` from the selected provider using the mod-authored title request, with a local fallback. |
| Classic Stop and SubagentStop | Prompt-type evaluators use the mod-authored evaluator request and are answered by the selected provider when every hook source of the event is visible to the mod. |
| `model.complete`, `model.classify`, `model.fork` | Routed through the main conversation's family (these public events carry no caller identity). |

### Permission judgments

A judgment is invalidated when policy or loaded instructions change
(`classic.ConfigChange`, `prompt.context`) or when the main permission mode
changes. Mode changes are detected by comparing core's own verdicts for harmless
`$.tool.check` queries (Bash, Write, Edit, Agent) taken before and after the
judgment. The native auto-mode defaults come from `claude auto-mode defaults`, run
once per Claude Code version in a mod-owned configuration folder so the user's
settings are never migrated, and cached per version so a background CLI update
does not break a running session.

### Input budget

The local 95% guard estimates a step from the provider-reported input of the
conversation's previous request (input plus cache reads and writes) and adds an
estimate only for messages appended since. The character heuristic is used only
without an anchor, after a model change or after compaction.

## Named host residuals

- **Auto-mode handoff review.** When a subagent finishes under an auto-mode
  parent, Claude Code reviews its report with a native classifier request. The
  host exposes no seam to route or skip it. It fails open: with Claude unavailable
  the report is delivered with an "unavailable" note.
- **Agent-type evaluators.** Stop and SubagentStop hooks of `type: "agent"` need a
  native verification loop; events containing one run natively, so every other
  configured hook still runs. Prompt-type evaluators are routed.
- **Hidden hook sources.** When another enabled plugin (including function hook
  modules registered before this mod), an invoked skill, an agent definition file
  or a session plugin directory may define hooks for the same event, evaluators run
  natively rather than risking dropped hooks.
- **Native auxiliary text.** The public title and permission events expose results
  and decision context, not Claude Code's internal prompts. Headless probes did not
  capture the title or auto-mode judge text. Stop and SubagentStop system blocks
  matched across marker runs, but their complete requests differed and independent
  byte-for-byte verification was not achieved. The WebFetch probe did not reach a
  successful extraction request. The mod keeps its existing text for these paths.
- **Restricted tool sessions and flagged paths.** Without any file-edit tool, or in
  a working directory the host flags as a suspicious Windows path (8.3 short
  names), an auto-to-plan switch during a pending judgment cannot be told apart by
  the query fingerprint; other mode switches still are. The probes use paths
  relative to the working directory so ordinary directories are unaffected by how
  the platform spells them.
- **Subagent transcripts.** Routed subagents, forked skills and fork subagents need
  session persistence (the default). Under `--no-session-persistence` their tasks
  are not readable by plugins and routed ones refuse without sending anything.
- **Resume model.** The host restores only the default model on resume and
  exposes no setter; the mod records each session's main model and, when a routed
  conversation resumes on another model, shows the `/model` command to return.

## Verification

`bun run check` is the full gate. It runs the unit suites, typechecks against the
installed build's generated API, the bundle check and the native proofs: compaction,
permissions, permission mode, search, evaluators, titles and the routing phases of
`npm run test:phases` (children with and without persistence, family, built-in tools,
compaction, classifier, skills, budget, partial failure, prompt evaluators, all five
protocols, automatic compaction and a throwing `turn.step` hook). The last recorded
CI matrix used Linux with Claude Code 2.1.301 and 2.1.302, plus native Windows with
2.1.302.

Focused evidence on Claude Code 2.1.306:

- `npm run test:tools` passed with 14 compared agent prompts, 12 captured tools, 3
  routed requests and no strict parity failures. The custom restricted agent proof
  resolved its exact frontmatter model `codex/owned-child`.
- `npm run test:permission-mode` remains red. The first three of four cases passed.
  In the explicit child-auto case, the native definition was unambiguous and the
  frontmatter and selected-provider path both recorded `auto`; the selected Bash
  judgment returned allow. The native host then issued two local security-monitor
  requests, including model `selected/main`, and logged `unrecognized_model`. The
  action was not approved and the marker was not written. The fixture did not use
  external inference or bypass the host classifier. This is not a passing permission
  proof; support for routed model ids in the host classifier is not documented here.

The full `bun run check` gate has not passed for this 0.11.0 lane.
