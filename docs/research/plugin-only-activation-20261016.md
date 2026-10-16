# Plugin-only activation in ordinary Claude Code

Date: 2026-10-16. Reviewed product inputs: Models `0c1b2c6e855547575602d5b2e54dc12c0da6ccad` (0.8.0), Accounts `871ea1b` (0.3.0). The ordinary installed Claude executable was 2.1.301 during this investigation. Its native binary SHA256 was `1f04c69e1c24e4d0a716a863af0aad8fc64d49a499334c29701f073700276b99`.

## Verdict

An installed mod can start automatically inside an ordinary Claude session, register commands and tools, and replace supported turn streams. The documented API and the actual 2.1.301 operation dispatch inspected here do not expose a way for that mod to install the existing native request adapter or account cache bridge into the main process. No supported plugin-only mechanism satisfying the complete current feature contract was established.

This is a bounded finding about the inspected interfaces and implementation, not a claim that arbitrary future host changes or unsupported code execution are impossible. The existing full-feature implementation's Bun preloads need to run before the native entrypoint. A plugin startup hook runs after that entrypoint has already created its runtime. Replacing, renaming or automatically launching a wrapper would retain the same unmet owner requirement. Global preload configuration is also outside the accepted solution.

## Supported extension boundaries

| Surface | What it supports | Why it does not activate the current bridge |
| --- | --- | --- |
| `register(on, options)` and `session.start` | Automatic mod initialization, command/tool registration and supported API calls before the first prompt. | They execute in the mod's own environment, rather than receiving the native process or its SDK client. |
| `turn.step` | Observing or replacing a normal turn's model stream, including an event's agent identity. | It is a turn lifecycle boundary. It is not a promised interception point for every auxiliary native SDK request. |
| `model.complete`, `model.classify`, `model.fork` hooks | Intercepting corresponding mods API operations from cooperating callers. | Native SDK construction is a separate implementation route; these events do not make every internal native call use the mod's method. |
| `http.fetch` | HTTP operations performed through `$.http.fetch`. | It is not the main process's global fetch function or the native SDK's transport override. |
| `engine.create` | Building the API table delivered to mods, including a plugin-defined namespace. | Its result supplies plugin-facing methods. It does not replace the engine's internal SDK client constructor. |
| `plugin.register` | Inspecting or refusing another mod's registration. | It does not install native modules or change the process entrypoint. |
| `$.process.run` and `$.process.spawn` | Running child processes with supported input, output and cancellation behavior. | A child cannot retroactively preload the already running parent. Replacing the parent with another launch is prohibited by the owner. |
| `$.env.set` | Updating the running process's environment and future child environment. | Setting a startup flag after startup does not rerun initialization of the existing process. |

The [mods reference](https://code.claude.com/docs/en/plugins/mods/reference#mods-api-calls) distinguishes lifecycle events from calls on the mods API. The [official mods source README](https://github.com/anthropics/claude-code/blob/main/mods/README.md) describes the built-in mod sources and the plugin-facing `engine.create` contract. These sources establish supported behavior; the native inspection below checks the actual installed build rather than deriving impossibility merely from missing declarations.

The [mods API guide](https://code.claude.com/docs/en/plugins/mods/api#reach-files-processes-and-the-network) specifies that a hook has no Node.js, direct filesystem or network access. Access is mediated through `$`. In particular, importing a maintained native preload as a normal hooks module would put it into this restricted environment, not into its original native host context.

## Initialization, classic hooks and client modules

`session.start` is a real automatic initialization event. The public contract promises completion before the first prompt, but does not promise execution before every startup operation, credential read or startup compaction. It also has different reload/resume semantics from the classic `SessionStart` event. Neither contract grants a native entrypoint hook. The [event reference](https://code.claude.com/docs/en/plugins/mods/reference#session) defines those lifecycle semantics.

Classic `SessionStart` supports context, an initial prompt, a title, file watching and skill rescanning. `Setup` runs only under explicit initialization or maintenance flags. `CLAUDE_ENV_FILE` affects later shell commands. None of these is a same-process JavaScript evaluation or SDK replacement interface. The [classic hooks reference](https://code.claude.com/docs/en/hooks#sessionstart-decision-control) documents their output fields and [environment persistence scope](https://code.claude.com/docs/en/hooks#persist-environment-variables).

There is no `$.session.client` operation in the inspected 2.1.301 host's operation registry. The similarly named `Client` element renders a plugin surface module. Its `ClientModule` receives props and a `ClientSurface` for drawing, local state, input and posting messages to the hooks module. It is not an Anthropic SDK client. These are separate contracts in the [official TypeScript declarations](https://github.com/anthropics/claude-code/blob/main/mods/types/claude-code.d.ts). That public file identifies itself as 2.1.277, so it was used as public documentation, not mislabelled as generated 2.1.301 types.

The [plugin manifest](https://code.claude.com/docs/en/plugins-reference#fields) provides component declarations, dependencies and limited plugin settings. It does not declare a native main-process module entrypoint. The [corporate launcher interface](https://code.claude.com/docs/en/corporate-launcher) explicitly concerns another executable launching Claude processes. It is not a plugin-only activation mechanism and is excluded by the owner's constraint.

## Actual 2.1.301 native implementation evidence

Inspection read the installed official binary in memory and retained bounded snippets, without modifying it:

| Native location, byte offset | Observation |
| --- | --- |
| Operation registry `rqn`, `196606217` | Includes the three `model` methods, session methods, `http.fetch`, process methods and environment methods. No native transport installation, preload loader, account-cache reset or `session.client` operation is present. |
| API factory `sE`, approximately `198895329` | Constructs the session API as serialized host operations. `session.usage` accepts only `breakdown` and `columns`; it has no force-refresh or account transition option. |
| VM factory `yPo`, `198879607` | Creates the plugin VM context with string and WebAssembly code generation disabled, then wraps values crossing its boundary. |
| Module loader `kPo`, approximately `198921176` | Loads `SourceTextModule` into that context, validates imports against the plugin graph and supplies its import resolver. |
| Worker entry, `198953278` | Imports `workerData`; plugin API calls cross a message port as operation frames with dispatch identity and arguments. They are not native function references exposed to the plugin. |
| Native model operation `ygn`, `206664341`; operation table `MPr`, `206704143` | `model.complete` dispatch invokes the host completion implementation. This is a discrete operation route, not global replacement of SDK calls. |
| Usage reader `_lo`, `206142115`; identity operation near `206700075` | Usage reads existing native state. `session.identity` is a managed-policy-gated identity reader, not a user-mod account setter or cache invalidator. |

The native SDK also contains direct message creation routes, including compaction code. The prior qualified 2.1.299 integration audit already reproduced authentic compaction, web-tool and permission-classifier calls bypassing the exposed completion hooks. See [the retained native-routing research](./native-inference-routing-20261014.md). Those runtime results remain 2.1.299 evidence. They were not silently promoted to a claim that every 2.1.301 native path was rerun.

## Smallest isolated runtime proof

A synthetic plugin was loaded using the official 2.1.301 executable and documented `--plugin-dir` flag, with isolated HOME/config, no `BUN_OPTIONS`, no custom launcher and no account credentials. It registered `session.start`, `model.complete`, `session.compact`, `turn.step` and `turn.complete`. The native debug receipt identified it as a worker-hosted mod. Its startup hook ran and its turn hook supplied the final marker without any HTTP request.

Inside the real hook, all six inspected globals were absent: `process`, `Bun`, `fetch`, `require`, `Worker` and `MessageChannel`. This proves automatic supported hook execution and the relevant isolation boundary in the actual host. It does not prove that the published native adapter can run there.

The fixture attempted compaction after its turn, but did not establish an authentic native compaction request or result. That attempt is not counted as current-build inference coverage. A first fixture registry was also rejected because its fabricated marketplace had not been registered. Its local synthetic SDK response is retained as setup failure, not as evidence of plugin behavior. The successful test used the documented developer loading path; it does not claim to validate a marketplace installation.

Private receipts are retained under the execution-state directory `rice-multi-models/plugin-only-activation-20261016`, outside the repository. No real provider request, global setting change, installation or protected-session interaction occurred. The successful native PID `8761` exited 0 and stderr was empty. No owned operation remains running.

| Receipt | SHA256 |
| --- | --- |
| `result.json` | `4c9123b11b23b61b54ccc03896309b3df3aa31ee65edadc01ab8e2e43f6f0179` |
| `validation.json` | `25e279a812b67372475bf2cf372a1fde8c8bbb8fbe682c38db379ffc3168cec9` |
| `current-301-native-contract.json` | `5851f5da7abaa7abb8127c161bca0cbbab9bf4a753f7514df9a57a0bac59a571` |
| `source-snippets.json` | `98cc6598234490f75e7fcf84eb2fc717b3157d4ad6712c077e943728773a1e76` |
| `proof.mjs` | `aa0b8841d5ab4cfe9560793d661c8ccab9c725fc96c21adf4d71b566075a90d4` |

## Minimum host support needed

For Models, the missing capability is an authenticated native inference request/response boundary available to an installed mod before any startup inference, carrying immutable session/agent ownership, requested purpose/model, native request data, cancellation and streaming results. It must cover the internal paths already required by the product, not just ordinary turns or cooperative mods API calls.

For Accounts, the missing capability is a supported per-session account transition that updates the native credential source and invalidates authentication, identity, browser eligibility and usage state together, rejects late responses from the previous account, and is available before startup inference. Environment switching can support a subset of behavior; it does not itself establish this complete cache and startup contract.

These are proposed host requirements, not existing Anthropic APIs. Without an equivalent supported host extension, the current complete-feature mods cannot be represented honestly as ordinary-plugin-only implementations. A reduced implementation would need an explicit product scope decision, with every omitted behavior visible, rather than silent native Claude fallback.
