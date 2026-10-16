# Provider web search contracts, 2026-10-16

This note records primary documentation and the qualified Claude Code 2.1.299 implementation. It proposes the requested search order: the selected provider and account, explicitly configured search services in their configured order, then the harness's native Claude WebSearch. It is research and an implementation contract, not evidence of live search entitlement. No paid search or real credential operation was used for this research.

## Required routing rule

Search capability belongs to a concrete endpoint, account, model and API transport. An OpenAI-compatible request format does not establish an OpenAI search entitlement. A model supporting custom functions does not establish support for a hosted search tool. Conversely, hosted grounding can work independently of ordinary function calling.

1. Try provider-native search only when the selected provider's actual transport has an implemented native-search contract and that endpoint/account is eligible or explicitly configured for it. Preserve the conversation owner's exact model and account.
2. Try configured retrieval services in an explicit ordered list. Each service owns its own authentication reference; never send conversation-provider credentials to another service. Retrieved evidence returns to the selected model for synthesis.
3. Use the native Claude WebSearch fallback through the existing harness account and SDK request context. Record this stage visibly. This is an explicitly requested search fallback, not permission to change the session's model/provider for other inference.

Buffer each bounded search attempt before emitting native response blocks. After visible response output begins, do not restart it against a different provider. Cancellation and invalid caller input stop the chain. Unsupported capability, unavailable service and unconfigured credentials produce distinct stage outcomes; transport failures do not permanently mark a model unsupported. An empty successful result is a successful search, not a reason to try every endpoint.

## Provider contracts

| Selected integration | Documented request and result | Capability boundary |
| --- | --- | --- |
| OpenAI Responses API | `POST /v1/responses`, `tools:[{type:"web_search"}]`. Use `tool_choice:"required"` or the specific tool choice for an explicit search operation. Preserve `web_search_call` and text URL citations; request `include:["web_search_call.action.sources"]` when full consulted sources are needed. Filters and live-access controls belong to the hosted tool. | Requires the actual OpenAI API account/model to support hosted search. A generic Responses endpoint must declare/prove this capability separately. Specialized Chat Completions search models are a separate contract. [OpenAI web search](https://developers.openai.com/api/docs/guides/tools-web-search). |
| Codex using ChatGPT subscription | Codex documents hosted web search modes `disabled`, `cached`, `indexed`, `live`, and separate provider capability controls. Its `supports_standalone_web_search` flag concerns a separate endpoint that remains under development and disabled by default. | A ChatGPT sign-in grants subscription access; Platform API-key access has separate billing and controls. Do not send its ChatGPT token to `api.openai.com` or assume the public Responses API contract grants access to Codex's subscription backend. Preserve Rice's existing selected Codex account and exact backend. Current official docs establish the Codex feature, but not every third-party direct subscription request shape or model entitlement. [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference), [authentication](https://learn.chatgpt.com/docs/auth). |
| Anthropic Messages API | `tools:[{type:"web_search_20250305",name:"web_search",max_uses:N}]` is the simplest basic contract. Preserve native server-tool results and citations. More recent tool versions add dynamic filtering with different `allowed_callers` defaults. Models API `capabilities.server_tools.web_search.supported` supplies model capability evidence. | Organization settings can disable search. HTTP 200 may still contain `web_search_tool_result_error`; inspect it. Do not conflate API-key organization access with Claude OAuth subscription access. Native Claude Code's existing SDK/account path is the evidence for the latter. [Anthropic web search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool). |
| Gemini GenerateContent | Rice's existing transport can add the native `googleSearch:{}` tool, represented as `google_search:{}` in the documented REST example. Preserve `groundingMetadata.webSearchQueries`, `groundingChunks`, `groundingSupports`, and the search entry point, not only final text. | Use a supporting Gemini model and the selected Google account/project. Enabling a tool does not guarantee that the model actually searches. Google's newer Interactions API has different search steps and citation shapes; do not accidentally send that schema to GenerateContent. [GenerateContent grounding](https://ai.google.dev/gemini-api/docs/generate-content/google-search), [Interactions grounding](https://ai.google.dev/gemini-api/docs/google-search). |
| Ollama local or cloud inference | Ollama documents a separate `POST https://ollama.com/api/web_search` with `{query,max_results}`, Bearer API-key authentication and `results:[{title,url,content}]`. Maximum results is 10. | Local inference alone does not provide this cloud search entitlement. A free Ollama account and API key are required for that search service. A selected, explicitly configured Ollama cloud account may reuse its authorized cloud-search credential; a local endpoint must not silently consult an unrelated global Ollama login. No documented localhost search endpoint was established. [Ollama search](https://docs.ollama.com/capabilities/web-search). |
| Amazon Bedrock | AWS hosted search exists for supported OpenAI GPT models through **bedrock-mantle Responses**, using `tools:[{type:"web_search"}]`, regional support and search/fetch IAM permissions. | Rice's existing Bedrock **ConverseStream** transport cannot use this Responses-only facility. Do not advertise native search for all Bedrock models or Anthropic on Bedrock. AWS also distinguishes external fetching permissions from indexed/cached results. Implementing Mantle would be a separate explicit provider transport. [AWS search](https://docs.aws.amazon.com/bedrock/latest/userguide/web-search.html), [AWS endpoint restriction](https://aws.amazon.com/blogs/machine-learning/introducing-web-search-on-amazon-bedrock-for-foundation-model-grounding/). |

For provider-native search, normalize a completed attempt into an answer plus actual sources and provider usage. Retain opaque provider citation references for continuation; do not invent an Anthropic encrypted citation from an unrelated provider's text. If the native provider cannot honor a requested domain policy, skip that contract or reject the restriction explicitly. Post-filtering result URLs cannot prove that no excluded source influenced a provider-generated answer.

The official Codex serializer provides a narrower subscription-compatible starting point than the public Responses example. Its `WebSearch` variant emits `type:"web_search"` with optional `external_web_access`, `indexed_web_access`, `filters.allowed_domains`, location and context controls. This proves how the official client serializes the tool; it does not prove every model/account entitlement. [Codex tool serializer](https://github.com/openai/codex/blob/main/codex-rs/tools/src/tool_spec.rs).

The ordinary Codex request builder uses `tool_choice:"auto"`. Its include list requests encrypted reasoning and optionally encrypted output; it does not request `web_search_call.action.sources`. Its request structure has no `max_tool_calls` field. Mirror this subset for the subscription backend until an owned backend proof establishes more. Detect whether an actual search call occurred and treat a response without search as unavailable for this operation. Do not copy public API forced-choice, source-include or call-budget fields into the subscription path merely because the protocols share a name. [Codex request builder](https://github.com/openai/codex/blob/main/codex-rs/core/src/client.rs), [Codex request structure](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/common.rs).

Maintain a separate native-search capability declaration on each configured provider. Automatic recognition should use an implemented contract and a verified official origin. An arbitrary OpenAI-compatible or Gemini-compatible origin requires explicit capability configuration. A provider-family label is insufficient. This declaration enables an attempt; actual account permission still comes from the response.

## Finite configured retrieval adapters

These three adapters cover self-hosted/free software and managed search services without an open-ended plugin protocol.

| Adapter | Wire request and normalized evidence | Authentication, bounds and policy |
| --- | --- | --- |
| SearXNG | GET `/search?q=...&format=json`; POST form encoding is also documented. Normalize `results[].title/url/content`. | The instance must enable JSON; disabled formats return 403 and public instances commonly disable them. Instance authentication is deployment-specific, not a universal SearXNG API key. `site:` query syntax is engine-dependent, so apply local URL/domain validation before returning results. [SearXNG API](https://docs.searxng.org/dev/search_api.html), [search syntax](https://docs.searxng.org/user/search-syntax.html). |
| Brave Web Search | GET `https://api.search.brave.com/res/v1/web/search?q=...&count=N`; normalize `web.results[].title/url/description`. | Header `X-Subscription-Token`. Query maximum 600 characters and 75 words; `count` 1-20 and `offset` 0-9. Explicit country/language/freshness fields are preferable to query-string guessing. Return provider status and quota classification. [Brave search](https://api-dashboard.search.brave.com/api-reference/web/search/get), [authentication](https://api-dashboard.search.brave.com/documentation/guides/authentication). |
| Tavily Search | POST `https://api.tavily.com/search`, JSON `{query,max_results,search_depth:"basic",include_answer:false,include_raw_content:false}`. Normalize `results[].title/url/content`. | Bearer API-key header. `max_results` is 0-20. Domain lists support inclusion/exclusion; use `include_domains_mode:"restrict"`, not `prefer`, for a hard allowlist. Keep automatic parameter selection off to avoid an implicit depth/credit change. [Tavily API](https://docs.tavily.com/documentation/api-reference/endpoint/search). |

The maintained service configuration in `<CLAUDE_CONFIG_DIR>/rice-multi-models/search.json` uses credential references rather than inline secrets:

```json
{
  "version": 1,
  "endpoints": [
    { "name": "home", "kind": "searxng", "url": "https://search.example/search", "priority": 0 },
    { "name": "brave", "kind": "brave", "url": "https://api.search.brave.com/res/v1/web/search", "priority": 10, "auth": { "env": "BRAVE_SEARCH_API_KEY" } },
    { "name": "tavily", "kind": "tavily", "url": "https://api.tavily.com/search", "priority": 20, "auth": { "env": "TAVILY_API_KEY" } }
  ]
}
```

This is a Rice schema, not a provider API schema. Lower priority numbers run first; equal numbers preserve saved order. Names are unique and adapter kinds are validated. Cloud adapters suggest their official URLs during setup. An alternate endpoint is an explicitly configured service. The old SearXNG environment variable follows saved services as a compatibility entry. Invalid configuration never overwrites a saved document. Provider capability is separate: each declared model can set `webSearch` to `auto`, `native` or `off`.

Normalize retrieval to `{title,url,content}` and metadata-only stage/service/status observations. Current local limits include 2 MiB responses, 10 results, 15 seconds per service and 30 seconds for the configured-service stage, reserving time for native fallback. These are Rice limits, not claims about provider quotas. Preserve AbortSignal cancellation. An adapter may send native domain filters where supported, but always validate normalized result URLs locally. Avoid forwarding credentials across redirects. Report the selected search stage without logging keys or private query text.

## Native Claude 2.1.299 fallback seam

The inspected official 2.1.299 implementation builds WebSearch using a `web_search_20250305` server tool, `max_uses:8`, forced `toolChoice:{type:"tool",name:"web_search"}`, and `querySource:"web_search_tool"`. Its query receives the active tool context's `credentials` and `storageV5`. The model is either the native helper resolver `_E()` or `mainLoopModel()`, depending on a native feature flag. This is primary installed implementation evidence, not a public stable API. The ordinary CLI and plugin documentation does not promise those internal symbols. [Official distribution](https://www.npmjs.com/package/@anthropic-ai/claude-code/v/2.1.299), [Claude Code CLI](https://code.claude.com/docs/en/cli-reference).

Rice already captures the original host fetch in [preload.ts](../../helper/native/preload.ts) and its [transport.ts](../../helper/native/transport.ts) uses a private `AsyncLocalStorage` scope to bypass interception during provider I/O. That is the in-process seam, with no HTTP listener or gateway.

Owned native Bun import/call proofs qualified these 2.1.299 Haiku-family default exports, including an actual external-model WebSearch context. Each full function source matched its platform's installed implementation before invocation:

| Qualified native build | Model resolver module | Export |
| --- | --- | --- |
| macOS arm64 | `/$bunfs/root/chunk-fk9f23h5.js` | `oG` |
| Linux x64 | `/$bunfs/root/chunk-xywp7esx.js` | `Kz` |
| Windows x64 | `B:/~BUN/root/chunk-v7m9g1fp.js` | `Yz` |

The returned model is observed at runtime, not hardcoded. The helpers honor `ANTHROPIC_DEFAULT_HAIKU_MODEL`, so reject a result outside the native Claude namespace. The earlier small/fast getters `_E`/`yv`/`Sv` were inadequate: an actual external-model session showed them following the current main model. Retained qualification evidence includes `native-leaf-active.Gh5Fp7` and `search-leaf-20261016-vVNPZV`; native default overrides passed and external overrides were rejected.

The proposed exact fallback operation is:

1. Recognize the dedicated native WebSearch server-tool request. The qualified host may label it `auxiliary`. A normal inference request must never acquire the exception merely because it mentions search.
2. Obtain a verified stock Claude model ID before any inference. No public 299 model resolver was established in this investigation; use the qualified version/platform-specific native default above and validate its result. Never hardcode a remembered current model or reuse `codex/...` as an Anthropic model.
3. Clone the already-built native SDK request, preserving its current account's authorization, original endpoint, native search tool, forced choice, domain restrictions, signal and relevant beta headers. Replace only the external routed model with the verified native model. Do not read or substitute another account's credential, set a global model, or mutate `CLAUDE_CONFIG_DIR`.
4. Invoke the captured original fetch directly under the private bypass scope. Calling the intercepted global fetch or `runStep` would re-enter search routing. The bypass is internal and purpose-scoped, not a caller-settable request header.
5. Return the authentic native response to the stock WebSearch consumer, or extract its completed cited evidence and let the selected external model synthesize it. A buffered failure must keep its real HTTP/tool-error classification. A stream with already emitted content cannot be replayed through another stage.

This mechanism preserves SDK-selected account headers and avoids recursion. Native resolver import/call is qualified for the three builds above. The maintained `npm run test:search` executes the real 2.1.299 consumer with isolated configuration and synthetic native authentication: configured retrieval completes without Anthropic inference, and native fallback sends exactly one request with the verified native model and unchanged SDK authentication. The actual Codex backend separately completed two accounted search invocations and returned the official authentication documentation. These proofs establish their stated controlled/live scopes; public API documents alone cannot qualify a private Claude host resolver.

## Required acceptance cases

1. Selected provider-native search succeeds: no configured service or Anthropic fallback request occurs; returned citations identify actual searched sources.
2. Generic compatible endpoint has no declared hosted-search support: no guessed tool is sent. Explicit disabled capability remains disabled even when ordinary function tools work.
3. Parent and two concurrent children use different providers/accounts: each search attempt keeps its own owner, including delayed auxiliary continuations.
4. Provider tool returns an error inside HTTP 200, unsupported tool, 401, quota error, timeout, malformed result or valid empty result: assert distinct outcomes and the exact configured transition. Cancellation and invalid input never advance.
5. Configured service order is stable: first success stops the chain; no implicit alphabetical sorting, parallel credential fan-out or extra paid request. Wrong credentials stay confined to their endpoint.
6. Each retrieval adapter has one recorded successful response and representative native error fixture. Assert auth header, request shape, provider bounds, domain filtering and normalized source fields.
7. Local Ollama has no configured cloud account: no hidden Ollama cloud request. Explicit selected cloud account uses its own credential only. Bedrock Converse never receives the Mantle-only search schema.
8. Native fallback receives the current selected Claude OAuth/account headers and a verified native model ID. Qualify the dedicated server-tool shape: the actual 2.1.299 WebSearch path can use request class `auxiliary`. Assert one original native request, zero recursive adapter calls and unchanged session/default-model settings.
9. After switching the Claude account, the next fallback request uses the new account. A concurrent older attempt cannot overwrite current usage/account state.
10. Buffer bounds and partial-output failure are enforced. No invented search citations or opaque provider tokens; no fallback after already committed output. Search remains a direct provider/service call with no proxy or gateway.

Implementation should expose metadata-only doctor output for the selected provider's search capability, configured service order and native fallback readiness. It must distinguish documented support, explicit configuration, successful owned protocol proof and actual live account entitlement.
