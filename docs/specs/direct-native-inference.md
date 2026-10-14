# Direct native inference

Status: implementation specification, 2026-10-14. Baseline: 0.6.4.

## Outcome

A primary conversation and each of its child conversations own their selected
model and provider. Every inference operation uses that owner, including native
compaction, tool-internal inference, permission classifiers, lifecycle summaries
and auxiliary calls made by mods. An explicitly selected alternate child keeps
its own provider after nested delegation, resume and communication.

There is no network listener, inference proxy or gateway. The official native
Claude executable remains intact. Provider requests use the existing direct
clients. Native compaction keeps the host's prompt, transcript selection and
bookkeeping; the mod supplies the provider response rather than a replacement
summary algorithm.

## Established implementation seam

Claude Code 2.1.299 is a compiled Bun executable. Bun's documented `BUN_OPTIONS`
preload executes an owned module before the embedded program. A native runtime
proof intercepted a real streamed compaction request for `codex/owned` and the
host completed compaction. This is native protocol proof with a deterministic
response, not live provider proof.

The host also has an optimized `Bun.FetchSession` path. Its transport selects that
pool when the current global fetch equals the function captured at module load.
The adapter must cover this path. The proven fetch accessor supplies an owned
delegate with a distinct identity on each read; unrelated requests still invoke
the original fetch. Test this behavior on each supported native version.

`BUN_OPTIONS` does not decode shell or JSON quotation around a preload filename
in the tested binary. The launcher must validate its actual path transport,
including paths with spaces, and require a successful preload handshake.

Sources and alternative interfaces are recorded in
[the primary-source research](../research/native-inference-routing-20261014.md).

## Modules

Use TypeScript and the existing esbuild and Node 22+ workflow. The runtime adapter
is bundled JavaScript executed by the native host's Bun runtime. The launcher is
Node, using argument-vector process execution. No additional runtime installation
or native binary patch is required.

1. `native/ownership.ts`: immutable owners and correlation for actual Worker
   instances, dispatch IDs, environment ports, operations and continuations.
2. `native/requests.ts`: parse the authentic native request, resolve its owner,
   preserve its prompt/transcript, and construct the existing direct request.
3. `native/responses.ts`: convert direct provider events into complete native
   JSON or SSE responses, retaining text, tools, usage, errors and cancellation.
4. `native/preload.ts`: initialize ownership tracking and transport interception
   before native startup. It opens no network listener.
5. `native/launch.ts`: find the official executable, validate preload activation,
   preserve the caller's arguments/environment and bind the plugin payload.
6. Existing hooks publish current selection, catalogue and approved provider
   identities, use trusted caller metadata for exposed auxiliary operations, and
   allow authentic native compaction only when the adapter is healthy.

## Ownership contract

An owner contains the session identity, optional agent identity and exact selected
model. A request's native model alias is separate from that selection. Auxiliary
Haiku or Sonnet aliases do not choose another provider. The default routed target
is the owner's exact selected model; any family optimization must be explicit and
supported by fresh catalogue evidence.

Capture owners from authoritative native `turn.step` and other loop-bearing
events. Keys include the actual Worker instance and numeric dispatch ID, because
replacement Workers can restart their counters. Host-to-worker frames use
`dispatch` or `dispatch_stream`, `id`, `event`, `payload` and `environments`.

Worker `next` and `next_pull` continuations refer to that dispatch ID. Dedicated
environment ports are associated through the transferred port in `load`.
Operations carry `dispatchId`, `registration`, `serving`, `rootEvent`, `op` and
`args`; streaming operations carry the initial metadata in `open`. Custom noun
calls use their own `callId` and environment membership.

Run the corresponding native message callback under `AsyncLocalStorage` with its
captured owner. This preserves ownership through asynchronous native requests and
nested completion dispatches whose payload carries no agent ID. Preserve the
host's separate async context and cancellation signals.

Do not select the latest active child, infer an owner from prompt text, share a
single mutable current-model variable, or reinterpret requested auxiliary model
names as ownership. Refuse an ambiguous routed operation before provider dispatch.
Retain already captured operation contexts through cleanup of their originating
dispatch. Bound and clean correlations at native result, error, unload and stream
completion boundaries.

## Native request and response contract

Intercept actual inference endpoints before network transmission. Accept native
Messages JSON and streamed requests. Validate model, system, messages, tools and
limits with bounded inputs. Authentication headers are neither logged nor forwarded
to a different provider. Load credentials through the owning direct client.

Keep native prompts and transcript ordering. Use the existing protocol codecs for
Chat Completions, Responses, Anthropic Messages, Gemini and Bedrock. Codex retains
its direct ChatGPT transport and account admission; CLI workers retain their
declared execution model and capability limits. Do not claim an unavailable model
capability merely because its provider has been configured.

Streaming responses must contain the complete native message/block sequence and
terminal message events. Preserve tool identities and JSON arguments. Errors must
retain a useful nonsecret class and phase, disable unsafe native replay, and never
trigger an Anthropic or different-provider fallback. Abort the direct request when
the native request is abandoned.

Native token-count and quota probes must use the routed provider's supported
contract or the host's documented local estimation fallback. They must not contact
an exhausted Claude subscription to authorize unrelated inference.

Native web extraction keeps the host's retrieval behavior and routes its authentic
summarizer request. Server web search needs a supported direct provider capability
or a configured direct retrieval backend. Implement any required server-tool loop
within the same owner; preserve native search result shapes and domain constraints.
Retrieval endpoints are search/content services, never inference gateways.

## Launch and compatibility

The adapter must be present before process startup. A plugin cannot preload into
an already running native process. Supply an explicit owned launcher for terminal
and SDK use, preserving the managed native executable and its updater. Supported
background launches inherit or invoke that launcher. Do not silently certify
desktop, IDE or other launch paths until their actual environment is verified.

Probe actual native versions on macOS and Linux/WSL. Declare Windows support only
with meaningful native evidence. Unsupported or missing adapter activation is
reported clearly; legacy main-turn routing is not full native-inference coverage.

Original user sessions are not restarted, compacted or rewritten for validation.
Use owned test sessions and normal installation/update commands.

## Implementation waves

1. Runtime and ownership: loader, real transport interception, immutable dispatch
   correlation, explicit auxiliary owner metadata and concurrent native proofs.
2. Direct requests: native request conversion, bundled direct transport, JSON/SSE,
   abort/error handling, authentic native compaction and web extraction.
3. Complete inference inventory: web search, classifiers, prompt/agent evaluators,
   lifecycle requests, scheduling/communication and exact provider compatibility.
4. Delivery: assembled canonical check, required hosted CI, normal publication,
   GitHub publication. Installation and live validation on owner machines follow
   the owner's explicit post-publication "proceed" gate.

Each wave must close a named behavior or obtain missing integration proof. Reuse
existing successful release evidence for unchanged inputs; do not replay 0.6.4
installation merely because this specification is new.

## Acceptance

Test actual native entry points with Anthropic inference denied and independently
observed selected-provider requests. Deterministic fixtures prove routing and
native contracts. Separate live checks prove configured entitlement and output.

- Main, child, nested, resumed and messaged loops retain their selected providers.
- Overlapping children from different providers keep distinct auxiliary owners.
- Skill loading, temporary model overrides and deferred ToolSearch work.
- Completion, classification and appropriate transcript forks use their owners.
- Manual, automatic and precomputed compaction use native requests/bookkeeping.
- WebFetch and WebSearch complete through direct selected-provider inference.
- Auto classifiers and configured prompt/agent evaluators retain their native
  decisions while using the requesting conversation's provider.
- Resume summaries, prompt suggestions, titles, goals and scheduled/incoming turns
  follow their owner's route where enabled in the tested host.
- Token/quota probes, failure, cancellation and retry paths do not leak to Claude
  or replay committed provider work.
- All declared protocol families have meaningful contract tests; live configured
  provider results retain their actual availability and capability scope.
- The full gate and hosted checks pass for the assembled revision, and the published
  payload matches that revision and bundled runtime digests. Machine installation
  is a separate human gate after complete GitHub publication.

The task remains incomplete until the required behavior is proven. Refusing a
previously broken path or documenting its failure is not a working feature.
