# Public auxiliary inference boundaries, 2026-10-16

The current public API supplies an implementable replacement boundary for an unresolved automatic permission judgment and a typed replacement boundary for WebFetch. Neither requires a launcher, preload, proxy or native binary change. A web-tool takeover must deliberately retain permission checks: returning a result immediately from `tool.call` skips the ordinary checks beneath it. This note distinguishes observed behavior from the remaining integration work.

## Inputs and scope

- Source input: `rice-multi-models` main `2ce54c483bf5dc777ae2720c128eac86d0f18470`, with the coordinator's independent public compaction and search work preserved.
- Actual ordinary executable: the official Claude Code 2.1.301 native build.
- Native-generated API: `current-301-types.d.ts`, SHA256 `6331dd2362855a1e6e8f20dd3a1563485916dae913a71899c445106ae51a5da8`.
- Native authoring reference: `current-301-reference.md`, SHA256 `64023f5d43afcd52b375bfc3dad040fe89e4d06899b7f78fc4ece1e39a037e7e`.
- Evidence: owned fixture runs; receipts were retained outside the repository.

The probes used isolated HOME/config directories, synthetic credentials and owned HTTP stand-ins. They did not read real credentials, install a plugin, use a launcher, or send paid inference. `HEAD /api/hello` is native readiness traffic, distinct from an inference `POST /v1/messages`.

## Automatic permission judgment

`tool.check` runs after the ordinary tool and classic PreToolUse hooks, before the mode settles an unresolved ask. Its native verdict includes `decision`, with optional `reason`, `rule`, `hook`, `setting`, `decider` and `ceiling`. A hook can replace that verdict. This is explicitly a supported way to decide before the native auto classifier, not an SDK interception mechanism. See the generated types at lines 4056-4069 and 13444-13558, and the official [permission extension rules](https://code.claude.com/docs/en/permissions#extend-permissions-with-hooks).

The native 301 probe `proof-public-classifier.mjs` returned this core verdict for an owned Bash action in auto mode with `classifyAllShell` enabled:

```json
{"decision":"ask","reason":"This command requires approval"}
```

The public hook sent one request to an owned selected-provider OpenAI endpoint with model `main`, obtained an allow judgment, and returned `{decision:'allow', reason}`. Native Bash then produced `OWNED_CLASSIFIER_OK`. Native PID 76746 exited 0. There were zero native Messages POSTs. Evidence: `public-classifier-result.json`, fixture `public-classifier-xFTiTa`.

This proves that the supported boundary can route the judgment to the selected provider with an exhausted native subscription. It does not prove that a short fixture prompt reproduces the native classifier's policy.

The maintained helper in `hooks/permission.ts` therefore provides these separate contracts:

| Export | Contract |
| --- | --- |
| `eligiblePermission(core, context)` | Only a routed model, a real tool-use ID, actual `auto` mode, and an unresolved ask without any rule, classic hook, setting, ceiling or host-decider marker are eligible. Allows, denials, queries and other modes retain the native verdict. |
| `resolvePermissionPolicy(defaults, sources)` | Reproduces the native trusted-source list order and first-defaults-marker expansion from loaded user, flag and policy `autoMode` blocks. Project and local blocks do not enter this merge. |
| `permissionRequest(request)` | Builds a tool-free selected-provider request from the exact action, bounded owner user messages, loaded constraints and all four resolved policy lists. It never sends tool-result content as user authorization or silently truncates restrictions. |
| `permissionAnswer(completion)` | Accepts only an answered strict JSON object with an allow/deny decision and a bounded reason. Missing, refused, malformed, partial or failed judgments deny without native inference fallback. |

The caller must use the actual loop's `agentId` when selecting the owner model and transcript. A tool-check query has no real ID. Pass the final completion through the existing completion helper with its finished-response requirement enabled. Abort, mode change or owner revision change while the judgment is pending must invalidate that judgment before approval. The per-call mode proof below establishes the initial mode; cancellation or mode-change detection during an awaited judgment remains an integration obligation.

For policy, load version-bound native defaults with the supported `claude auto-mode defaults` command, then use `resolvePermissionPolicy` on the public source snapshots' `autoMode` blocks. A native executable inspection bound the source merger `Bx` to user, flag, then policy settings (byte offset 196468545), and the defaults expander `oon` to first-marker expansion at its original position (offset 199825228). Empty combined lists use defaults. Nonempty lists without a defaults marker replace that default section. Managed additions remain in the combined list. Evidence: `native-auto-mode-merger-snippet.json`.

An owned native CLI experiment established that `auto-mode config` still reads the user policy with `--setting-sources ''`. Passing an already combined user policy as an inline override therefore duplicates those entries. A public module experiment likewise found that `settings.read({source:'user'})` returns that trusted user snapshot with empty general setting sources. This matches the classifier's explicit trusted-source merger; neither read can be treated as proof that the general source is enabled. Do not reconstruct classifier policy from the blanket merged settings object or add project/local policy. A child also does not inherit the current invocation's inline `--settings` automatically, so read the actual flag snapshot through the API. Evidence: `auto-mode-merge-result.json` and `permission-context-result.json`.

All four resolver output lists matched retained actual native output digests for both explicit replacement and inherited-default cases (`permission-resolver-native-result.json`). Native 301 defaults contain 81,259 characters and pass the helper's bound. Do not send settings, environment or credential fields to the classifier. If policy cannot be obtained, deny rather than dropping restrictions. The official [auto-mode configuration reference](https://code.claude.com/docs/en/auto-mode-config#inspect-the-defaults-and-your-effective-config) documents effective policy inspection and its precedence.

The native private classifier prompt is not exposed by this contract. The helper implements a conservative explicit policy using the public configuration, rather than claiming identical hidden prompt wording or native denial-counter behavior. That limitation must remain visible in product documentation.

## Actual per-call permission mode

The function-hook `classic.PreToolUse` event has only `ToolCallEnvelope`, not the classic command hook's full stdin input (generated types, lines 1275-1286). Reading `e.permission_mode` from that module event would not establish the actual mode.

The maintained `scripts/permission-context.mjs` uses the supported classic command hook instead. It reads bounded stdin and a per-process `RICE_MULTI_MODELS_PERMISSION_CONTEXT_NONCE`, then returns only nonce, session ID, tool-use ID, optional agent ID and native permission mode inside a compact additional-context marker. It makes no permission decision, starts no inference, writes no file, and emits no tool arguments. Malformed or oversized input emits an empty hook answer.

The module wraps the classic event with `await next(e)`, verifies the matching nonce/session/tool identity, consumes that metadata and removes the marker from the forwarded `additionalContext`. The later tool check uses the native mode keyed to the same real invocation. Missing proof on an unresolved routed ask must refuse, rather than fall back to the native classifier.

The actual native proof used the exact maintained helper, SHA256 `b673cb89dba70532aa6351ece828172a329f1e44307ecc61ed60efc0cf690677`. Native PIDs 36152 and 36298 exited 0: command metadata reported `auto` and `default` respectively; the module event lacked a direct mode field; the tool check received the correct bound mode; and the tool result contained no marker. There were no native inference POSTs. Evidence: `proof-permission-context.mjs`, `permission-context-result.json`, fixture `permission-context-hYqe6S`. The official [classic hook output contract](https://code.claude.com/docs/en/hooks#add-context-for-claude) supplies the supported transport.

## WebFetch result contract

The tool takes `{url, prompt, offset?}`. Its replacement result has this exact public shape, nested inside the tool hook's `{result: ...}` answer:

```ts
{
  bytes: number,
  code: number,
  codeText: string,
  result: string,
  durationMs: number,
  url: string,
  artifactRead?: { slug: string, ver?: string, seeded?: false }
}
```

The generated declarations are at lines 17442-17448 and 21948-21965. A core tool maps a hook's answer through its own output schema and transcript mapper, so a fabricated generic text field is not the replacement contract.

The owned 301 fixture `proof-webfetch-permission.mjs` exercised the native validator and mapper with this schema. A native classic PreToolUse hook rewrote both URL and prompt. `tool.check` received those rewritten values, a domain allow rule matched the rewritten hostname, and the replacement result was accepted. PID 93810 exited 0, with zero native inference POSTs. This validates the typed result and permission boundary, not a finished page parser or extraction implementation.

Retrieval can use the public `http.fetch` host operation, whose API documents organization web-fetch policy enforcement. The extraction completion must use the resolved owner model with no tools and no native fallback. The implementation still needs bounded content, URL validation and redirect policy, HTTP errors, timeout/abort behavior, offset semantics and explicit handling of artifact reads. Do not claim native artifact credentials or origin policy are reproduced merely because an ordinary page result validates. See the generated types at lines 3552-3574 and 5340-5406.

## Permission-preserving WebSearch and WebFetch takeover

The following finite protocol is implementable with the supported public hooks:

1. The outer `tool.call` hook calls `next(e)` so ordinary classic checks run.
2. The inner `tool.check` hook calls its own `next(e)` and records the core verdict and exact checked input under the real tool-use ID.
3. A native deny stays denied. For allow/ask, the inner hook returns an owned nonce-bound refusal to stop before native execution.
4. The outer hook replaces only a verified native stopped/error result carrying its own one-shot nonce. Marker existence alone is insufficient: another mod could otherwise change a verdict and let the original operation run. Consume and clear the marker exactly once.
5. For an allowed action, run the replacement with the checked input. This preserves classic input rewrites; the outer event may still carry the original arguments.
6. For an ordinary ask, require one explicit approval through supported `ui.ask`, naming the exact checked action and native reason. Accept only the exact `Allow once` label. Denial, free text, dismissal, abort or absent interactive UI refuses. Do not persist a rule or a grant.
7. A host decider or organization ceiling is not replaced by a mod prompt. Refuse the replacement when that policy cannot be honored, with no original native inference fallback.

This deliberately uses the engine's AskUserQuestion interface for the mod's one-action checkpoint. It does not claim to be the original native permission dialog. The API expressly supports `ui.ask` and rejects it in a noninteractive `-p` run (generated types, lines 2450-2466). The native permission dialog itself is outside mod render sites (lines 9764-9771), consistent with the official [mods capability boundaries](https://code.claude.com/docs/en/plugins/mods#what-a-mod-can-do).

Observed native effects:

| Probe | Result |
| --- | --- |
| Native WebSearch allow, inner refusal, outer replacement | Classic check ran, replacement result accepted, no native inference POST. |
| Classic PreToolUse deny | Denial preserved, no replacement, no native inference POST. |
| Leave ask to native PermissionRequest, approve it | No second tool-check event occurs; original native WebSearch executes and reaches the owned exhausted endpoint. This disproves a sentinel protocol that only intercepts initial allows. |
| Intercept WebFetch ask, call mod `ui.ask` under `-p` | The prompt is unavailable, the operation refuses, no replacement and no native inference POST. |

The first three cases are in `auxiliary-permission-result.json`, fixture `auxiliary-permission-af2r8T`; all three native processes exited 0. The original supervisor assertion incorrectly counted readiness HEAD requests as inference. That failure is retained and the POST-only oracle was validated offline against the completed native results, without replay. The last case and the rewritten-input proof are in `webfetch-permission-result.json`, fixture `webfetch-permission-oFKWGL`; both native processes exited 0.

The maintained `hooks/tool-gate.ts` now implements the pure nonce-bound gate, input snapshot, one-shot prompt, abort and cleanup behavior. Its focused tests cover concurrent identities, denial preservation, post-classic input changes, rejected approvals and unavailable approval paths. The next work is coordinator integration, one actual interactive Allow once/Deny/dismiss proof and a production classifier proof through `complete`. Host/organization approval restrictions must remain fail-closed. This is a specific implementation and verification boundary, not a claim that the full plugin-only goal is impossible.
