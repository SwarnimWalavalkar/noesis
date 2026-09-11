# Prompt caching and token efficiency audit

Date: 2026-09-11. Audited commit: `075f84e99559f3033ca731c422cc0510bf63fc4d`. Pi dependencies: 0.85.0.

Follow-up: [Pi and OpenCode implementation comparison](noesis-pi-opencode-cache-comparison.md), with pinned upstream sources and implications for these findings.

## Assessment

Noesis has a strong foundation for limiting context, but significant avoidable costs remain at request boundaries. Its strongest features are the four direct tools, progressively disclosed skills and Broker operations, code-side composition, and immutable bounded continuity notes. Its main weaknesses are cache identity across turns, reconstructed conversation history, changing material before reusable history, large model-visible results, and incomplete accounting across all inference calls.

The first objective should be **lower total cost per successfully completed task with unchanged authority, evidence access, learning, and answer quality**. Raw tokens, uncached input, output/reasoning tokens, latency, and cache reads are separate measurements. A shorter request can cost more if shortening destroys useful cache reuse or causes repeated retrieval.

This is a source audit plus credential-free controlled execution, not a production cost benchmark. No live provider calls were made. No production traces or personal session databases were inspected. Savings percentages and actual hit rates remain unknown. The audit itself made no runtime changes. Subsequent implementation is tracked in [the implementation plan](noesis-token-efficiency-implementation.md). Findings below describe the audited commit.

## Verified measurements

| Probe                                                                                                                     | Result                                                                               | What it establishes                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two calls through `createPiAgentRuntime` with the same Noesis `trailId`, stable system instructions, and replayed history | Different provider `sessionId` values, both ending in `:main`                        | The cache identity supplied by Pi changes between foreground turns.                                                                                                             |
| Render a role prompt twice, changing only `run-A` to `run-B`                                                              | 18 shared characters in an 18,342-character user prompt; estimated size 4,586 tokens | The run identifier defeats reuse of the user-prompt prefix very early. The separate system prompt can still be reusable.                                                        |
| Give the request projector a 100,000-character tool result under a 160,000-token budget                                   | Zero projected results; estimated request size 25,129 tokens                         | The budget guard is an overflow defense, not an ordinary output-efficiency policy.                                                                                              |
| Compact the synthetic role JSON instead of pretty-printing                                                                | 18,342 → 18,255 characters                                                           | Whitespace is a minor opportunity in this example, much smaller than prefix layout. Character reduction is not a measured tokenizer saving.                                     |
| Existing focused tests                                                                                                    | 99 passed across 5 files                                                             | Current runtime, role runner, budget projection, cache inspection, and compaction behavior passed their existing checks. These tests do not establish live cache effectiveness. |

Tests: `pnpm exec vitest run packages/runtime-pi/test/context-budget.test.ts packages/runtime-pi/test/context-inspection.test.ts packages/runtime-pi/test/role-runner.test.ts packages/runtime-pi/test/runtime.test.ts packages/runtime/test/session-compaction.test.ts`.

The standalone probe used the repository's controlled Pi provider through the real AgentHarness. It ran with `node --import tsx /tmp/noesis-cache-audit.mts`; results were written to `/tmp/noesis-cache-audit-results.json`. These temporary files are supporting local evidence, not durable product state.

## Findings, ordered by recommended action

### 1. Provider cache identity follows an ephemeral execution session

**High priority; confirmed adapter behavior.** `packages/runtime-pi/src/index.ts:547` creates a new ephemeral session for each foreground run. `session-lifecycle.ts:37` creates a fresh `MemorySessionRepo` session. The installed Pi harness's `harness/runtime/drive/generation.js:136` passes `${session.metadata.id}:${lane.name}` to the provider. The Responses adapters use that value as `prompt_cache_key` (`pi-ai/dist/api/openai-responses.js:220`, and the Codex adapter's request builder).

This splits requests from one logical Noesis conversation into different cache groups. Within one foreground run the identity remains stable, so this is specifically a cross-turn problem. It is not evidence that every provider misses every request: provider routing and caching differ, and Anthropic caching primarily follows content and breakpoints.

**Change:** separate stable provider cache grouping from execution/resource identity at the runtime-pi model boundary. Use an opaque stable group within the correct user/workspace/provider isolation boundary; evaluate conversation-level grouping versus a safe shared role group. Keep ephemeral execution identities and cleanup intact. Simply making every Pi session use one ID risks resource collisions and cleanup errors. The installed harness overrides `sessionId` after stream options, so adding a stream option alone is insufficient.

### 2. Auxiliary requests put changing content before reusable material

**High priority; confirmed.** `role-context.ts:179` renders one pretty-printed JSON user message with `runId` first, then role, variant, messages, and evidence references. The ID is operational provenance that the model usually does not need. `role-runner.ts:337` appends the fixed JSON output schema after the dynamic evidence. Router inputs start with the current turn (`runtime-composition.ts:300`); reflection starts with the settled turn before current Capability materials (`capability-loop.ts:892`).

Removing the ID alone is insufficient: the current input still precedes reusable history/material, and a single serialized message does not expose useful internal cache boundaries.

**Change:** keep run IDs in authoritative telemetry. Construct actual ordered messages/blocks: stable role instructions and output contract; stable, canonically ordered reference material where needed; reusable history; current request/evidence. Preserve instructional versus evidence roles. Select explicit provider breakpoints where supported. Use a stable role cache group within the authorized isolation boundary. Compact serialization is secondary.

### 3. Cross-turn history is rebuilt without the original tool and reasoning structure

**High priority; confirmed representation change, financial impact unmeasured.** `index.ts:212` obtains frozen user/assistant text. `index.ts:293` reconstructs assistant messages using only text and zero usage. `index.ts:700` appends that reconstruction to a new lane. The previous run's provider messages included tool calls/results and potentially thinking blocks; they are not replayed here. Even separate assistant text messages lose their associated tool-call structure.

This saves raw history tokens, but it prevents the next request from extending the exact prior tool-heavy transcript. It can also require rereading files or reloading skill instructions that were previously tool results. Ordinary text-only turns can preserve more of their prefix.

**Change:** benchmark two deliberate policies: immutable provider-compatible replay until an explicit compaction boundary; and compact conversational replay with an explicit reusable boundary. Preserve tool-call/result pairs and required provider reasoning signatures in exact replay. Store provider message evidence under WorkspaceStore ownership with a declared authority; do not introduce a competing Pi operational store. Do not assume replaying every historical tool output is automatically cheaper.

### 4. Changing Capability selection changes the system prefix

**High priority; confirmed.** `turn-intelligence.ts:643` preserves router selection order. `:717` builds instruction layers in that order; `:762` adds them to the base system prompt. `runtime-pi/src/index.ts:614` then appends the skill listing. A change in selected instructions, their revisions, or their order changes content before the skill listing and all history. The same selected set returned in a different order is an avoidable source of change unless ordering represents intended precedence.

**Change:** define deterministic precedence and canonical ordering for semantically unordered selections. Put stable base instructions and stable skill metadata before more variable material. Consider a turn-scoped instruction message near the current request where provider roles permit equivalent semantics. Evaluate this with conflicting-instruction tests: moving system instructions into ordinary user data would change the contract. Exact revisions must remain frozen and inspectable. Required learning changes may legitimately invalidate a prefix.

### 5. Large results enter the model before ordinary efficiency limits apply

**High priority; confirmed.** `tools/src/limits.ts` permits 128 KiB of tool text. `codemode/src/index.ts` retains up to 256 KiB of stdout/stderr by default; the terminal result frame is exempt from the ordinary frame-size check at `:574`. `runtime-pi/src/execute-tool.ts:251` sends the returned value and captured logs directly to the model. `runtime-composition.ts:3771` validates/persists the returned value and forwards it; there is no small model-visible result envelope on this path.

For ASCII text, the current estimator assigns roughly 32,768 tokens to 128 KiB and 65,536 to 256 KiB, before wrappers. These are permitted sizes, not measured typical outputs. A result may also repeat information in both its return value and stdout.

**Change:** separate complete execution evidence from model-visible presentation. Save large results/logs with exact recoverable references and send a bounded initial result containing status, useful preview, size, completeness, and a paging/read handle. Let callers select fields, line ranges, tails, or explicit larger budgets. Keep full outputs available inside codemode for composition. Bound presentation, not useful execution duration or number of calls. Reuse existing evidence/artifact ownership; do not add a second canonical result store.

### 6. Overflow projection rewrites already-sent tool messages

**Medium priority; confirmed.** `context-budget.ts:290` only shortens results after the complete request exceeds its budget. It chooses results in history order and replaces them with a 1,200-character preview plus provenance. Once selected, a result stays projected for the remainder of that run, which avoids repeated toggling. However, the initial replacement changes an earlier prefix, and the candidate set can include the newest result.

**Change:** prefer a stable bounded projection when the result first enters model context. Preserve that exact projection on subsequent requests. Keep the overflow guard as a last defense, and group unavoidable context changes into deliberate compaction boundaries. Ensure the newest essential evidence remains recoverable. Merely shrinking the total context budget can increase churn and retrieval cost.

### 7. Background intelligence can add several capable-model calls per turn

**Medium/high priority; confirmed call paths, workload cost unknown.** `runtime-composition.ts:1393` gives the router, compactor, reranker, and reflector the same configured provider, model, and thinking level. The built-in thinking default is `high` (`config/src/index.ts:114`). `pi-role-backend.ts:90` forwards reasoning, with no role-specific generation allowance on this path.

Routing is correctly skipped when no narrow eligible candidates exist (`turn-intelligence.ts:570`). Reflection searches previous-session history before making its decision (`capability-loop.ts:847`). That search can invoke an additional model reranker when multiple candidates exist and reranking is enabled (`intelligence/src/index.ts:233`). A task may therefore incur foreground calls, a router call, a history-reranker call, reflection, compaction when needed, and repair calls—not merely one foreground completion plus one reflector.

**Change:** account for each call first. Add independently configurable capable role routes and reasoning effort, validated on role-specific quality cases. Investigate whether reflection can make the needed evidence-selection judgment directly over a bounded candidate set, avoiding a separate reranking pass on that path. Preserve ambient reflection after every eligible settled turn, including failed/aborted work, and preserve model-based semantic decisions. Do not replace these decisions with keywords or skip reflection based on a heuristic.

### 8. Current usage reporting cannot establish whole-task savings

**High priority as an enabler; confirmed.** Foreground `/context` keeps the latest request inspection in memory (`index.ts:667`, `:756`) and reports the terminal assistant's context usage (`:891`). This is useful context occupancy information, but not cumulative foreground spend. Role and subagent `usageOf` merge uncached input, cache reads, and cache writes into `inputTokens`. Subagents do sum calls (`subagent-run.ts:435`), but lose the cache split. Some composition consumers use the inferred value without exposing its trace in the returned result, notably routing.

**Change:** record one normalized usage observation per provider attempt in SQLite, linked to turn, role, child execution, retry, and model. Preserve uncached input, cache read, cache write, output, separately reported reasoning, cost, latency, and missing/unknown values. Avoid double-counting reasoning included in output. Record cache-group identity, stable component digests, and actual request-boundary fingerprints without logging credentials. Include failure and repair attempts. Build task totals as projections of this authority, while keeping `/context` explicitly about the latest request.

### 9. Structured-output repairs omit the original output contract

**Medium priority; confirmed source defect.** `role-runner.ts:416` calls the runner with `addOutputContract(request, outputSchema)`. On parse/validation failure, `:430` instead calls `repairRequest(request, ...)` using the original request. The repair modifies its last input message and does not restore the appended schema. Default repair allowance is one.

This can make the retry less likely to produce a valid result, after spending another inference call. It also retains the changing run-ID prefix issue.

**Change:** build repairs from the same contract-bearing request, adding bounded validation feedback and malformed output in a separate suffix. Test first-response failure followed by schema-dependent recovery. Evaluate native structured output where the provider supports this exact schema; maintain runtime validation and evidence boundaries.

### 10. Retention and breakpoint policy are mostly inherited from Pi

**Medium priority; provider-dependent.** Noesis does not configure a first-class cache-retention policy on the audited foreground/role paths. Installed Anthropic Pi defaults to short retention unless the environment requests long retention, marks system material and the final tool, and marks the latest user content. The Responses adapter supplies a session-derived key and compatibility-dependent retention; it understands newer cache-write usage fields, so those are not missing upstream.

**Change:** expose provider-aware policy with model compatibility checks and request-payload tests. Preserve a reusable static boundary for isolated roles. Test long tool loops and human pauses. Do not blanket-enable the longest TTL or assume the same option works for Anthropic, OpenAI API, OpenRouter, and Codex OAuth.

Anthropic documents breakpoint matching and a limited lookback; static content inside one changing serialized block will not automatically become a written cache boundary. Longer retention also changes write pricing. [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

Current OpenAI documentation distinguishes model generations: newer models expose message-boundary caching and explicit controls; older models use different implicit boundaries and retention settings. Cache keys separate reuse groups. A prefix match alone does not prove a reusable written entry. [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).

## Existing strengths to preserve

- Exactly four direct tools. Adding Broker tools or Programs does not automatically add all their schemas to every provider request.
- Effects-first skills load progressively; ordinary skill descriptions are sorted. Legacy Capability skills still enter system text in full (`turn-intelligence.ts:717`), so installations retaining them should measure migration value.
- Codemode can process many intermediate results without parent-model mediation; only deliberately returned values and logs need enter model context.
- Notebook notes are immutable, bounded, and based only on newly covered conversation. The notebook cap is `min(8,000, floor(historyBudget / 4))`. Compaction itself still changes the history prefix.
- No per-compaction relevance search. Old evidence remains retrievable on demand.
- Request projection uses provider-reported usage when available and fails before dispatch if the budget cannot be met.
- Stable tool definitions and exact frozen revisions provide the necessary foundation for reproducible cache testing.

## Implementation order and acceptance evidence

1. **Make costs observable and remove avoidable prefix noise.** Add normalized per-attempt usage; separate provider cache identity from resource identity; remove model-visible run IDs; place fixed role contracts first; fix repair contract preservation. Use controlled AgentHarness captures and actual adapter payload captures. Assert stable identity across turns and restart, independent resource cleanup, and unchanged semantics.
2. **Make prompt assembly deterministic.** Define instruction precedence, stable skill/catalog layout, and provider-specific block boundaries. Assert identical bytes for unchanged material; changing one selected Capability must produce an explainable boundary change. Include explicit skills, failed turns, steering, retries, forks, and model switches.
3. **Reduce model-visible evidence at ingestion.** Add recoverable bounded result envelopes and stable projections. Compare direct tools, `execute`, large shell output, repeated skill loading, nested calls, and error recovery. Check that omitted evidence can be read exactly and no task silently succeeds on incomplete output.
4. **Choose replay and compaction policy from measurements.** Compare exact replay against compact conversational replay on identical tool-heavy tasks. Include long sessions, compaction, restart, and repeated retrieval. Measure whole-task input/cache/output cost and answer correctness; do not optimize hit percentage alone.
5. **Tune background inference.** Measure costs of router, reranker, reflector, compactor, and repairs separately. Compare capable role routes/efforts and evidence-selection consolidation while holding semantic accuracy and publication safety constant.

Benchmark matrix: text-only chat; repeated coding turns; large file/search/shell outputs; unchanged versus changing Capability sets; 10/100/500 available skills; short and long tool loops; deliberate pause/retention boundaries; automatic/manual compaction; restart; subagent continuation; malformed structured output; failed/aborted foreground work.

Report per scenario: task success, corrections, evidence rereads, total inference calls, uncached input, cache reads/writes, output/reasoning, time to first token, total latency, and cost. Split warm/cold runs and providers. Use bounded repeated trials and distinguish normalized usage from model estimates. Controlled tests run without credentials in CI; real-provider benchmark results must be explicitly identified and require a separate paid execution run.

Do not claim a savings percentage until this benchmark exists. The strongest immediate candidates are stable cache grouping and role-prefix structure; the biggest workload-dependent candidates are tool-result presentation, cross-turn replay, and background reasoning.
