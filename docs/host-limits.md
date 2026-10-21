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

## Compaction lifecycle and collapsed row

**Missing host hooks and API:** Plugin-triggered compaction does not receive the normal `PreCompact` and `PostCompact` lifecycle callbacks, and plugins cannot create the engine's native collapsed "Compacted" transcript row.

**Current mod behavior:** The mod handles routed `session.compact` itself, uses the engine's summary prompt and message wording when available, and retains the original transcript on failure. The normal pre-compaction hooks do not run for this replacement, post-compaction observers receive an empty summary, and the replacement summary appears as a regular message.

**Requested host change:** Invoke compaction lifecycle hooks for plugin-provided compaction, pass the actual summary and compacted range to post-compaction observers, and expose a supported API for creating the same collapsed transcript row the native compactor uses.

## Evaluator provenance for hidden hook sources

**Missing host metadata:** Evaluator events do not provide one authoritative inventory of every effective hook source and its provenance, including sources added by enabled plugins, invoked skills and agent definition files.

**Current mod behavior:** The mod uses public settings, plugin registration, skill prompt and agent registration events to discover sources it can verify. If a source may be hidden or its definition is not attested by successful native registration, the mod leaves evaluation to Claude Code rather than claiming it has reproduced the complete hook set.

**Requested host change:** Attach the effective hook inventory to evaluator events. For each hook, include its event, enabled state, resolved definition, source kind and stable source identity. Exclude disabled sources and identify sources the host could not resolve.

## Agent model choices

**Missing host extension:** The native Agent tool's `model` schema is limited to the four aliases `fable`, `haiku`, `opus` and `sonnet`, and `tool.describe` cannot widen it: it changes the description only, and a `tool.call` rewrite is checked again against the same four values.

**Current mod behavior:** The mod widens the choice for routed sessions with a carrier on public hooks. `tool.call` sees the raw `model` before the engine checks it, records an exact discovered or declared `<provider>/<model>` id under the call's `tool_use_id`, and hands the engine a valid value; `agent.spawn` restores the id and the subagent runs on exactly that id. The schema and description shown to routed models list the accepted ids. An unknown id, a lost record and an id on a fork are refused with a visible message; none runs on the carrier value. The Claude-native API schema stays the engine's, so exact ids through `Agent.model` are for routed sessions; agent frontmatter `model: <provider>/<model>` works everywhere. The carrier relies on the engine running `tool.call` hooks before it checks arguments, which is undocumented (verified on Claude Code 2.1.302 and 2.1.307), and the permission prompt shows the carrier value. Aliases (`haiku`, `sonnet`, `opus`, `fable`) still map to the current provider family.

**Requested host change:** Let `tool.describe` override input-schema fields that are not pinned, or let `Agent.model` accept any string that `agent.spawn` resolves or denies, preserving the host's access and permission checks. Either removes the carrier.

## Child permission modes

**Verified on Claude Code 2.1.306:** A child created with explicit `permissionMode: 'auto'` under a plan-mode parent resolves to effective `plan`. This is the engine's effective-mode behavior, not a routing override or an unexplained permission-proof failure. The permission proof is version aware and asserts the effective mode.

**Current mod behavior:** The permission gate uses native `PreToolUse` permission-mode evidence. It does not infer a child's effective mode from registration settings or bypass the host's permission checks.

## Pinned teammate models

**Missing host API:** There is no public API to persist an explicit model assignment for a stable team teammate and retain it across later work or respawn.

**Current mod behavior:** The mod chooses models through the available family, agent-type and spawn routing decisions. It cannot promise that a team teammate remains pinned to one configured model when the host recreates or reschedules that teammate.

**Requested host change:** Give plugins a stable teammate identity and a supported per-teammate model assignment that survives the teammate lifecycle. Expose assignment changes and the resolved model to plugins, and preserve native policy checks when a teammate is resumed or respawned.
