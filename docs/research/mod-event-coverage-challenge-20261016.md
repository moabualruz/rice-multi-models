# Adversarial check of mod event coverage

Date: 2026-10-16. Repository input: `2ce54c483bf5dc777ae2720c128eac86d0f18470`. Actual runtime: official Claude Code 2.1.301 on macOS arm64, binary SHA256 `1f04c69e1c24e4d0a716a863af0aad8fc64d49a499334c29701f073700276b99`.

## Result

A challenge to the earlier conclusion identifies a real weakness in the previous reasoning. Mods cover lifecycle events as well as API methods, and they can replace an operation at an enclosing event instead of intercepting its internal SDK call. Failure to load the current preload implementation does not prove that the requested behavior cannot be implemented through public mod events.

This investigation proved an affirmative example: ordinary Claude 2.1.301 accepted a public `tool.call` takeover of WebSearch, consumed its correctly shaped result and source URL, and made no native inference request. No custom launcher, preload, proxy or gateway was involved. The source was an owned synthetic fixture, so this is native protocol and extension coverage, not live search quality evidence.

It also proved a narrower limitation: an unmodified native WebSearch request did not produce `model.complete`, `model.fork`, `model.classify` or `http.fetch` events, even under a separate outer `on('*')` observer. Its enclosing tool events did run. Thus a universal SDK interception boundary and a complete implementation using several supported takeover boundaries are different questions. The latter must be evaluated feature by feature.

## The broader official promise

Anthropic's October 1 announcement says:

> Each time Claude Code does something, it emits an event.

The article describes running before, after, instead of, or around an event, replacing built-in features, and moving more features into mods over time. That is a broader extension promise than merely letting plugins call a fixed list of API methods. It does not specify an interface for naming an arbitrary internal JavaScript function and attaching to it. [Official launch article](https://claude.com/resources/articles/claude-code-mods).

The events guide states that a wildcard matches the event set, with a telemetry exception. It also documents separate tool, prompt, turn and classic-hook boundaries. A matcher filters fields of an event; it does not create a new dispatch location. The guide's examples explicitly allow answering an event without running the underlying operation. [React to events](https://code.claude.com/docs/en/plugins/mods/events#filter-which-events-a-hook-handles).

The overview describes sending a request to another model and replacing features. Its statement that mods are not sandboxed concerns their ability to act with the user's machine permissions through supported operations. An isolated JavaScript environment is therefore not evidence that a feature cannot be implemented. A mod can make direct network requests or run its own maintained provider client through the API. [Mods overview](https://code.claude.com/docs/en/plugins/mods/overview#what-a-mod-can-do), [mods API access](https://code.claude.com/docs/en/plugins/mods/api#reach-files-processes-and-the-network).

## Actual installed authoring instructions and types

The official 2.1.301 `plugin-authoring` skill was invoked through `Skill` in an isolated native session. An observer captured the final `skill.prompt` text after the built-in handler had expanded it. The skill also wrote its own build-specific reference and declarations. Those exact files were copied as read-only research evidence outside the repository.

The current skill instructs authors to identify both the event that represents a feature and the API operations it needs. Its reference describes observing, rewriting and answering events within their contracts. It does not restrict authors to mirroring the engine's internal implementation, and it does not promise arbitrary native function patching.

The build-specific declarations are materially more authoritative than assuming the older public GitHub type file is current. The [official authoring guide](https://code.claude.com/docs/en/plugins/mods/create#get-type-definitions-for-your-version) directs authors to the types written by their actual build.

| Contract in the actual 2.1.301 declarations | Relevant fields or behavior |
| --- | --- |
| `Pattern`, line 7626; `StarNext` | Named events, namespace patterns and negation; a wildcard handler can inspect `next.event`, narrow with `next.is`, and continue with `next(e)`. |
| `EngineEventOf` and `engine.create`, around line 4591 | Lifecycle events are distinct from mods API operations. `engine.create` builds the plugin-facing interface, adding nouns. Its contract prohibits replacing another step's noun. |
| `ModelCompleteInput`, line 6238 | Model, prompt, system, optional text blocks, token cap, effort and timeout. It does not include a native SDK client or an auxiliary caller agent ID. |
| `SessionCompactInput`, line 11223 | `trigger`, optional `agentId`, instructions and this loop's transcript messages. |
| `SessionCompacted`, line 11184 | A hook can return the resulting transcript as `messages`. Kept message handles preserve native messages; newly supplied messages are built from their declared fields. |
| `SessionCompactTrigger` | `manual`, `auto`, `plugin`, `precompute`. These are supported takeover opportunities, subject to actual semantic verification. |
| `ToolCallResult`, line 13340 | Core validates a hook-provided result against the tool's output schema and uses its native mapper to record and present it. |
| `BuiltinToolResults.WebSearch`, line 21967 | `query`, `results`, `durationSeconds`, optional `searchCount`; a result group has `tool_use_id` and source entries with `title`, `url`, optional `snippet`. |

The public [mods reference](https://code.claude.com/docs/en/plugins/mods/reference#events) confirms lifecycle events and explains that every mods API method is also an event. These are complementary sets. Custom nouns added by `engine.create` supply additional methods and corresponding events for cooperating plugins; adding such a noun does not itself redirect an unrelated internal engine call to it.

## Bounded native proofs

All probes used the unchanged official binary with isolated HOME/config, documented plugin directory loading, synthetic credentials and no `BUN_OPTIONS`. A local SDK stand-in returned deterministic fixture data without forwarding any request. It was used only to make native request observation safe and reproducible. There were no paid provider calls, real account reads, installation changes or protected-session interactions.

### Wildcard observation of native WebSearch

Two separate plugins prevented same-plugin re-entry suppression from explaining missing observations. The outer plugin registered:

```js
on('*', async ($, e, next) => {
  seen.push(next.event)
  return next(e)
})
```

An inner plugin's turn hook called the actual `Skill` and `WebSearch` tools, then performed a separate explicit `$.http.fetch` to the fixture server.

The wildcard saw `engine.create`, `plugin.register`, `session.start`, classic hooks, prompt composition and sections, `session.append`, `turn.start`, `turn.step`, tool calls and checks, `skill.prompt`, and completion events. Native WebSearch succeeded, and its source URL was consumed. The server observed one native `POST /v1/messages`, including the server-side `web_search` tool. The wildcard saw zero `model.complete`, `model.fork` or `model.classify` events. Its sole `http.fetch` event corresponded to the separate explicit fetch, not the native SDK POST.

This demonstrates the gap at the internal request boundary while confirming that the operation has an enclosing supported tool boundary. Native PID `49036` exited 0 with empty stderr.

### Public whole-tool takeover

The outer plugin then answered `tool.call` for WebSearch without calling `next`, using the exact current output schema. The inner plugin called WebSearch normally. The host accepted the result through its native tool handling, and the caller received the fixture source URL. The server observed zero native inference requests. The independent explicit HTTP operation still succeeded, confirming that the test had not disabled networking globally. Native PID `88731` exited 0 with empty stderr.

This is a concrete alternative to patching native WebSearch's internal request transport. Production implementation still needs real configured retrieval, selected-provider ownership, error handling and cancellation; this fixture does not claim those are implemented by returning synthetic data.

### Arbitrary event names

The actual 2.1.301 validator accepted `model.*`. It rejected `model.request`, `http.request` and `session.client` as unrecognized events in the reserved core namespaces. These are concrete tested names, not a claim that custom plugin nouns are forbidden. A wildcard observes dispatched events; it does not turn any chosen function name into an event.

## Host implementation cross-check

Read-only inspection of the same binary corroborates the runtime results:

| Actual source location | Meaning |
| --- | --- |
| Lifecycle event registry `iOe`, byte 196607116 | Includes tool, prompt, turn, session, classic-hook and interface events as well as API methods. Inspecting only the separate operation list would omit much of the extension surface. |
| Pattern matcher `FX` and `GNt`, byte 196625139 | Wildcards and namespace patterns select names at dispatch; telemetry receives special selection rules. |
| Native WebSearch request construction, byte 212331175 | Sends a native request labelled `web_search_tool`, with the server search schema, selected model and native agent/credential context. The wildcard proof observes the surrounding tool event, not a generated model-operation event for this request. |
| Worker dispatch entry, byte 198953278 | Operations cross the worker channel with dispatch identity. This explains API execution mechanics, but does not by itself determine whether a lifecycle takeover can satisfy a feature. |

Configuration affects loading and order. `prependPlugins`, `appendPlugins`, dependencies and managed restrictions select which handlers run and in what order; they do not document a new arbitrary native-function dispatch mechanism. Some managed environments skip installed user hooks on sensitive lifecycle events, so a public takeover must also declare its supported policy environment. [Mod configuration and order](https://code.claude.com/docs/en/plugins/mods/reference#settings-and-environment-variables).

## Consequence for the implementation plan

The correct next question is which public event can implement each required behavior with the selected session or child provider, preserving the expected behavior. The existing preload's successful private interception is one implementation, not the definition of the requirement.

Public WebSearch takeover is now proven feasible. Public compaction takeover is explicitly represented by the current types and needs separate native semantic proof for normal and automatic compaction, retained history and model ownership. Account switching and automatic permission classification have different boundaries and cannot be certified by this search fixture. Neither a universal impossibility claim nor a claim of complete plugin-only coverage follows from the evidence here.

The requirement to compact normally and avoid an invented, misleading summary remains a semantic acceptance criterion. A supported compaction hook is useful only if its implementation satisfies that criterion. This investigation makes no change to that requirement.

## Retained evidence

Receipts were retained outside the repository. All child operations exited and each owned session fixture was removed. The official skill's public resource cache was read, not altered.

| Evidence | SHA256 |
| --- | --- |
| `event-challenge-result.json` | `bf29828787acf32df4a668e38c9c8dd5d3a1aa9e722b286b547e163f70ec5b73` |
| `takeover-challenge-result.json` | `911d0080241db31cd57b681708fabeca42e82755a5cf10593b5bd6828b0dc025` |
| `authoring-current-301.md` | `475ee4d465ed365bcf7aaaeeed62e08d0b2e405b93e18d38dc59e7935e407f63` |
| `current-301-types.d.ts` | `6331dd2362855a1e6e8f20dd3a1563485916dae913a71899c445106ae51a5da8` |
| `current-301-reference.md` | `64023f5d43afcd52b375bfc3dad040fe89e4d06899b7f78fc4ece1e39a037e7e` |
| `event-name-validation.json` | `04379e9178252d20ca03b39a8d6128bc00c2162bfcb4819fec099f053af95603` |
| `event-dispatch-source-301.json` | `0ec77acdfa3d464faa5fb4395e15dd20b8b26ed71431560ed2facb2352ac31e3` |
