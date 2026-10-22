# Host API requests

This document lists public Claude Code plugin API gaps that prevent a mod from closing specific compatibility gaps itself. Each request names the missing host hook or API, the current mod behavior, and the host change that would let plugins integrate without reproducing private engine behavior. These are requests for upstream API changes, not claims about implementation plans.

## MCP input schemas

**Missing host API:** The public tool metadata available to the mod does not include an MCP tool's input schema.

**Current mod behavior:** Built-in tool schemas come from an installed-engine capture with a generated schema fallback. MCP tools retain their host-provided description and use a loose object schema. The mod does not connect to MCP servers or inspect their credentials to recover schemas.

**Requested host change:** Include each MCP tool's validated JSON Schema in the public tool metadata returned to plugins, with a stable tool identity and an update signal when the server changes its schema.

## Inference outside model hooks

**Missing host hook:** There is no single public interception event for every inference request dispatched by the engine, including host-owned classifiers and other internal model calls.

**Current mod behavior:** The mod routes visible `turn.step` requests and the auxiliary model events the host exposes. An internal inference call with no public callback remains native and cannot be redirected or reported as routed.

**Requested host change:** Provide a cancellable model-request hook for every engine inference call. Include the requested model, purpose, normalized input, response contract, conversation or task identity, and a supported way to return the result without bypassing native policy checks.

## SubagentHandback classifier

**Missing host hook:** The auto-mode decision that admits or rejects `SubagentHandback` is made by a Claude Code classifier that plugins cannot observe or route.

**Current mod behavior:** The mod preserves the `SubagentHandback` tool name and input shape when it is offered. The host's classifier still decides whether the call is admitted, so this part is not provider-family parity.

**Requested host change:** Expose the admission decision as a documented classifier hook with the call, relevant policy context, selected model identity, cancellation signal, and a typed result. The hook must not bypass the host's native permission checks.

## Native-first integration boundary

The mod executes in process through supported hooks. Claude Code retains turn orchestration, native agent dispatch, tool execution, permission ceilings and conversation storage. Native Claude routes delegate unchanged. External inference is a typed adapter response, not a second harness. That does not make every replaced internal pipeline stock-equivalent.

## Provider error and cancellation results

**Missing host result:** `TurnStepResult` and its stop chunk expose a nullable stop reason and usage, but no typed provider-error value, HTTP status or error class. Throwing from a hook skips it and can dispatch the original native request, so throwing is not a safe external-provider error channel.

**Current mod behavior:** Errors are diagnostics, not successful assistant text or fabricated handbacks. Actual partial text and observed usage survive. Tools are withheld until the provider response succeeds. Failure ends with `stopReason: null`; cancellation uses the hook dispatch signal and stops owned helper work. An owned 2.1.308 failure proof shows that the CLI can still report `is_error: false` for this null-stop plugin response. Native API-error/StopFailure accounting, automatic error UI and machine exit-status parity are not available through this result shape.

**Requested host change:** Add a supported error/abort result carrying provider, status, error kind, partial-output state and observed usage. Core must stop tool execution and native fallback, run native failure bookkeeping, and expose an unsuccessful CLI result without treating the failure as an assistant answer. Until then, accepting the null-stop adapter boundary is a human activation decision.

## Compaction model selection

**Missing host field:** `session.compact` has no summarizer model selector or provider transport port. A 2.1.308 owned manual-compaction probe delegated `next(e)` unchanged and observed native PreCompact, SessionStart(compact), PostCompact, summary/boundary, usage and continuation. Its summarizer request did not traverse `turn.step`, `model.complete`, `model.fork`, `model.classify` or `http.fetch`; positive controls for those hooks succeeded. Native automatic summarizer transport was not established by that probe.

**Current mod behavior:** External compaction replaces core summarization through the public `session.compact` result, using version-bound captured native wording. The policy is the same exact active model only, including an observed child model. There is no alternate chooser, same-family substitution or implicit Claude fallback. Fresh active capacity or explicit configuration supplies bounded budgets with output and overhead reserve. A maximum ceiling alone never becomes active context; missing metadata never creates infinite room. Discovery is optional and can recover after refresh. Failed/cancelled compaction leaves history intact. If fitting excludes or clips source content, the request and resulting summary disclose that coverage, and tool pairs remain intact.

**Requested host change:** Expose the native summarizer request and its resolved owner/model through a supported transport seam, preserving native policy, lifecycle, handles and accounting. A model selector alone would not provide an external transport contract.

## Compaction lifecycle and collapsed row

**Missing host hooks and API:** Plugin-triggered compaction does not receive the normal `PreCompact` and `PostCompact` lifecycle callbacks, and plugins cannot create the engine's native collapsed "Compacted" transcript row.

**Current mod behavior:** The mod handles routed `session.compact` itself, uses the engine's summary prompt and message wording when available, and retains original handles and payloads. Bounded typed transaction receipts record preparing, prepared, aborted and installed-observed through system notices, status and doctor. A newly persisted whole summary/tail segment, absent before preparation, confirms installation; the successful hook return does not. Session reads can include old history, so confirmation does not assume that the replacement starts at row zero. Precompute remains pending until observed adoption; changed source/model/session, cancellation, clear, expiry and supersession cannot falsely confirm. Actual provider usage is separate from the native ledger. Pending receipts survive module reload, not process resume; saved notices are historical evidence only.

Merged-settings `PreCompact` policy, or an unreadable policy snapshot, refuses replacement. The mod never runs configured hook shell commands itself. Other public `session.compact` policy hooks remain authoritative. Classic callbacks installed only by other plugin code do not have a complete public inventory, and stock callbacks are not dispatched by this replacement. Post-compaction observers still receive an empty native summary, and the replacement summary is a regular message, not a collapsed native summary row. Idle/precompute adoption with legitimate interactive feature prerequisites remains unverified; a synthetic trigger fixture is not that proof.

**Requested host change:** Invoke compaction lifecycle hooks for plugin-provided compaction, pass the actual summary and compacted range to post-compaction observers, and expose a supported API for creating the same collapsed transcript row the native compactor uses.

## Evaluator provenance for hidden hook sources

**Missing host metadata:** Evaluator events do not provide one authoritative inventory of every effective hook source and its provenance, including sources added by enabled plugins, invoked skills and agent definition files.

**Current mod behavior:** The mod uses public settings, plugin registration, skill prompt and agent registration events to discover sources it can verify. If a source may be hidden or its definition is not attested by successful native registration, the mod leaves evaluation to Claude Code rather than claiming it has reproduced the complete hook set.

**Requested host change:** Attach the effective hook inventory to evaluator events. For each hook, include its event, enabled state, resolved definition, source kind and stable source identity. Exclude disabled sources and identify sources the host could not resolve.

## Agent model choices

**Missing host extension:** The native Agent tool's `model` schema is limited to the four aliases `fable`, `haiku`, `opus` and `sonnet`, and `tool.describe` cannot widen it: it changes the description only, and a `tool.call` rewrite is checked again against the same four values.

**Current mod behavior:** The mod widens the choice for routed sessions with a carrier on public hooks. `tool.call` sees the raw `model` before the engine checks it, records an exact discovered or declared `<provider>/<model>` id under the call's `tool_use_id`, and hands the engine a valid value; `agent.spawn` restores the id and the subagent runs on exactly that id. The schema and description shown to routed models list the accepted ids. An unknown id, a lost record and an id on a fork are refused with a visible message; none runs on the carrier value. The Claude-native API schema stays the engine's, so exact ids through `Agent.model` are for routed sessions; agent frontmatter `model: <provider>/<model>` works everywhere. The carrier relies on the engine running `tool.call` hooks before it checks arguments, which is undocumented (covered by isolated proofs on Claude Code 2.1.302, 2.1.306 and 2.1.308), and the permission input still has the carrier value. A visible description note names the real model and explains the carrier, and permission asks add the exact id to their reason without changing the decision. The note is removed from the child's description. Aliases (`haiku`, `sonnet`, `opus`, `fable`) still map to the current provider family.

**Requested host change:** Let `tool.describe` override input-schema fields that are not pinned, or let `Agent.model` accept any string that `agent.spawn` resolves or denies, preserving the host's access and permission checks. Either removes the carrier.

## Auxiliary ownership, snapshots and prompt contracts

**Missing host metadata:** Public `model.complete` and `model.classify` inputs have no loop id. Hidden title, safety-monitor, suggestion and memory inference does not have a universal request hook. `model.fork` has no exported native last-sent snapshot.

**Current mod behavior:** Explicit completion/classification models are honored, including native models. The host's `next.origin` plugin/tier scopes mod-owned completion/classification cache identity where available. It identifies the calling plugin, not an auxiliary call's loop or agent, and is never joined to the nearest active turn by timing. Omitted classification model keeps the documented native default, rather than borrowing main ownership. Native classification does not traverse `model.complete` on 2.1.308. The adapter captures its actual system/prompt contract from an isolated native invocation. Visible Stop and SubagentStop prompt evaluators likewise capture the version/event-specific native wrapper and output schema, then receive the observed owner's transcript and real condition/event. Internal inference is replaced; provider cache marks, reasoning budgets and error bookkeeping are not stock-equivalent. Hidden and agent evaluator sources run natively, never silently skipped.

Routed `model.fork` uses the immutable last dispatched main request prefix, including a request whose provider later fails, preserving its model/system and omitting tools. An unsent budget refusal does not replace the snapshot. It does not rebuild current context. No verified snapshot after reload, clear or resume means `nothing-to-fork`. This is a tool-free native-like completion, not a promise of native cache-hit identity or hidden iterative fork behavior. Titles retain the documented mod-written short-title request and deterministic fallback. Auto-permission prompts remain mod-written; native rules, forced approvals, managed ceilings and handback classification are not bypassed. Security-monitor and other hidden inference remains native or unverified, not claimed selected-provider traffic.

**Requested host change:** Add explicit owner/model provenance, exported immutable request snapshots, and normalized native prompt/output contracts for auxiliary operations. Expose hidden inference purposes separately without weakening safety or forcing a provider substitution.

## Child permission modes

**Verified on Claude Code 2.1.306:** A child created with explicit `permissionMode: 'auto'` under a plan-mode parent resolves to effective `plan`. This is the engine's effective-mode behavior, not a routing override or an unexplained permission-proof failure. The permission proof is version aware and asserts the effective mode.

**Current mod behavior:** The permission gate uses native `PreToolUse` permission-mode evidence. It does not infer a child's effective mode from registration settings or bypass the host's permission checks.

## Pinned teammate models

**Missing host API:** There is no public API to persist an explicit model assignment for a stable team teammate and retain it across later work or respawn.

**Current mod behavior:** Fresh workflow and teammate spawns follow the same explicit-id/alias resolution as native Agent dispatch. Native resume is not rewritten; its returned model is observed for subsequent requests, compaction and permission helpers. Observed child model, native-route and background facts survive mod reload in native session state. An unowned ambiguous alias is refused rather than assigned the main model from its list row; exact native requests remain native. Event-shape fixtures are not proof that a remote workflow or teammate in another process runs inside this mod. No in-process hook can route a loop the host never exposes. A respawned teammate is a new observed assignment, not a promised persistent pin.

**Requested host change:** Give plugins a stable teammate identity and a supported per-teammate model assignment that survives the teammate lifecycle. Expose assignment changes and the resolved model to plugins, and preserve native policy checks when a teammate is resumed or respawned.

## Provider cache and continuation state

**Current mod behavior:** A provider cache key hashes safe configured references: provider id/kind, validated endpoint origin, explicit endpoint/account `cacheScope` references when configured, exact model/protocol, session and loop/caller. Without explicit references a configured provider denotes one logical endpoint/account. Credential values, helper arguments and URL paths never enter the digest; identity changes within one provider/origin require updated references. A body parameter cannot override the owner-isolated key. Only protocols supporting the key receive it; cache controls, hit rules and usage remain provider-specific.

Opaque continuation remains transient. Its helper owner namespace now shares the cache identity boundary rather than provider/model alone. No persistence adapter is enabled: typed native state did not survive process resume in isolated 2.1.302, 2.1.306 and 2.1.308 probes, and runtime hot-reload/rendered-UI privacy proof remains incomplete. Synthetic state did not automatically enter model requests, transcripts or exported API messages. Other plugins can read session state, and typing does not runtime-validate it. This normal private harness visibility is not a credential incident; it is not itself a claim that persistence is impossible. Any future adapter still needs explicit validation, expiry/bounds, exact context/tool ownership and all required lifecycle proof. Provider signatures are never portable across providers/models.

**Remaining prerequisites:** Idle precompute needs legitimate interactive/account feature prerequisites. A new owned private interactive title/permission attempt stopped at the workspace trust gate without approval or inference. Registered exact-model availability still needs real documented approval/availability; the synthetic discovery returned approval-required and zero models. Native caller-to-loop correlation remains unverified. No hidden field, stock-error rewrite, patched binary, launcher, proxy or manual hook dispatch is used to bridge these gaps.
