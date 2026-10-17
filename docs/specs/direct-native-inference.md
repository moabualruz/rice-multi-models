# Direct inference inside ordinary Claude

Status: implemented in the 0.9 releases against Claude Code 2.1.301 and 2.1.302. Named host
residuals are listed at the end; they are documented, not hidden.

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
| Agent definition naming `provider/model` | That exact model |
| Agent type `rice-multi-models:<family>` | That family, tier from the alias |
| Agent type `rice-multi-models:claude` | Native Claude, alias honored |
| Forks | Inherit the parent model (host rule) |
| Forked skill or skill `model:` alias in a routed conversation | Tier inside the owning conversation's family |
| Parent on native Claude | Native resolution unchanged |

`tiers` is an optional top-level block of `rice-multi-models.json`, keyed by family
id, mapping `default`, `haiku`, `sonnet`, `opus` and `fable` to routed model ids of
that family. Entries from another family are ignored.

The main prompt gets one session section that lists the available families, their
default models, tiers and agent types. It contains no tool instructions.

## Implementation boundaries

| Boundary | Behavior |
| --- | --- |
| `turn.step` | Answers routed steps for main and subagents from the engine's own transcript, prompt and tools. Native alias steps resolve inside the owner's family. A step whose family cannot be resolved is refused visibly; the hook never throws, because a throwing hook lets the host run the native request. |
| `agent.spawn` | Applies the family table above before the engine resolves the model, using the parent's effective (remapped) model; the mod's own agent types carry their registered model. |
| `session.compact` | Selected-provider summary with a bounded verbatim tail of recent engine messages split at an exchange boundary (tool pairs and pending calls kept whole). The summary request is fitted to the model's input bound by shortening tool outputs, then long texts, then leaving out the middle of the oldest history; failures keep the original transcript. |
| `tool.call` / `tool.check` for WebSearch and WebFetch | Native rules and classic PreToolUse run first; the checked input is then served by the selected provider, configured search services, then native search with the session's account (search only). |
| `tool.check` (auto mode) | Unresolved asks for routed conversations are judged by the owner's provider with the effective auto-mode policy. SubagentHandback is never judged here. |
| Classic PreToolUse command hook | Reports the native per-call permission mode (`scripts/permission-context.mjs`). |
| `classic.UserPromptSubmit` | Returns `sessionTitle` from the selected provider, with a local fallback. |
| Classic Stop and SubagentStop | Prompt-type evaluators are answered by the selected provider when every hook source of the event is visible to the mod. |
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

`bun run check` runs the unit suites, typechecks against the installed build's
generated API, the bundle check and the native proofs: compaction, permissions,
permission mode, search, evaluators, titles and the routing phases of
`npm run test:phases` (children with and without persistence, family, built-in
tools, compaction, classifier, skills, budget, partial failure, prompt evaluators,
all five protocols, automatic compaction and a throwing `turn.step` hook). CI runs
it on Linux for Claude Code 2.1.301 and 2.1.302 and on native Windows for 2.1.302.
