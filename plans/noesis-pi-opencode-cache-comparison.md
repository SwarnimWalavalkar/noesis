# Pi and OpenCode: caching and token-efficiency comparison

Research date: 2026-09-11. Companion to the [Noesis audit](noesis-prompt-cache-token-efficiency-audit.md).

## Scope and evidence

Current upstream snapshots were downloaded into `/tmp/noesis-upstream-audit/` without modifying the user's reference clones:

- Pi `main`: [`f3c672245d25ef2283ffc0d9cdec8a5482651103`](https://github.com/badlogic/pi-mono/tree/f3c672245d25ef2283ffc0d9cdec8a5482651103), package version 0.85.1. Noesis currently pins 0.85.0.
- OpenCode `dev`: [`193de13a88d62a6409c6d385831180f1def527dc`](https://github.com/anomalyco/opencode/tree/193de13a88d62a6409c6d385831180f1def527dc), CLI package version 1.18.30.

The Pi comparison distinguishes its coding-agent application from its lower-level AgentHarness. The OpenCode snapshot contains both the established CLI session path under `packages/opencode` and a newer V2 core under `packages/core`. V2 findings below are implemented source with dedicated tests, not merely specifications; they are not a claim that every released frontend uses that path.

This is source-grounded research, not a live-provider performance comparison. Upstream suites were inspected but not installed or run. A pure Pi truncation function was executed locally. No paid calls were made.

## What they do differently

| Concern        | Pi coding-agent                                                                           | OpenCode                                                                                 | Lesson for Noesis                                                                     |
| -------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Cache identity | Uses the session manager's stable ID                                                      | Supplies logical session ID as cache key for supported SDKs and session-affinity headers | Separate logical cache grouping from ephemeral execution identity                     |
| History        | Retains typed assistant/tool/thinking messages                                            | Reconstructs typed calls, results, reasoning, and compatible provider metadata           | Preserve the serialized provider contract across turns, not just visible text         |
| Stable context | Reuses a base system prompt until rebuild/override                                        | Established path groups system blocks; V2 freezes a context baseline and appends updates | Treat prompt stability as explicit state                                              |
| Tool order     | Active tools can change; extensions can affect requests                                   | Established request preparation explicitly sorts tool names                              | Canonicalize semantically unordered material                                          |
| Output size    | Common tools default to 2,000 lines / 50 KiB                                              | Common wrapper and V2 output store default to 2,000 lines / 50 KiB                       | Bound presentation on initial ingestion, with recovery                                |
| Old output     | Main compaction removes older context                                                     | Established path additionally prunes older tool results in batches                       | Pruning has a cache tradeoff; avoid constant small rewrites                           |
| Compaction     | Updates a previous summary; keeps recent context; disables cache writes for summary calls | Previous summary plus selected history and retained recent context                       | Keep Noesis's immutable notes; borrow deliberate boundaries and call-specific caching |
| Accounting     | Session totals preserve cache reads/writes and include recorded summary usage             | Records per-step usage/cost and cache fields                                             | Distinguish cumulative spend from current context occupancy                           |

## Pi findings

### Stable session identity is application behavior we are bypassing

Pi's coding SDK constructs an agent with `sessionId: sessionManager.getSessionId()` and restores its existing message array on resume. The same agent handles successive prompts. Session-manager projection returns the original typed message for normal message entries, including tool results, rather than rebuilding every assistant as plain text.

Sources: [SDK creation](https://github.com/badlogic/pi-mono/blob/f3c672245d25ef2283ffc0d9cdec8a5482651103/packages/coding-agent/src/core/sdk.ts#L361), [session projection](https://github.com/badlogic/pi-mono/blob/f3c672245d25ef2283ffc0d9cdec8a5482651103/packages/coding-agent/src/core/session-manager.ts#L383).

Noesis uses the lower-level AgentHarness with a fresh in-memory session per foreground turn. Its changing cache identity is therefore an integration choice, not an inherent Pi limitation. We should preserve Noesis's WorkspaceStore authority and ephemeral execution lifecycle while fixing the provider grouping at the adapter boundary. Adopting Pi's application/session store wholesale would violate our ownership contract.

### Output truncation happens before context is exhausted

Pi's common truncation utility applies the first of 2,000 lines or 50 KiB. File reads retain the head and support continuation; shell output retains the tail and exposes a saved full-output path on truncation. Grep also limits each match line to 500 characters.

A local call to the pinned utility with 99,000 bytes of synthetic line-oriented output produced 51,182 bytes / 517 complete lines for either head or tail mode, before tool-specific recovery text. This verifies the byte/line boundary, not task success or billed token savings.

Sources: [truncation](https://github.com/badlogic/pi-mono/blob/f3c672245d25ef2283ffc0d9cdec8a5482651103/packages/coding-agent/src/core/tools/truncate.ts), [shell tool](https://github.com/badlogic/pi-mono/blob/f3c672245d25ef2283ffc0d9cdec8a5482651103/packages/coding-agent/src/core/tools/bash.ts), [read tool](https://github.com/badlogic/pi-mono/blob/f3c672245d25ef2283ffc0d9cdec8a5482651103/packages/coding-agent/src/core/tools/read.ts).

Fifty KiB is still roughly 12,800 estimated ASCII tokens. It is a useful comparison point, not evidence that it is the optimal default. Noesis can use smaller task-appropriate initial envelopes while retaining exact larger reads.

### Caching policy differs between conversation and one-off summaries

Pi's provider adapters translate cache retention into provider-specific keys and markers. Its coding-agent `completeSummarization` explicitly sets `cacheRetention: "none"` to avoid cache writes for one-off summaries. The compactor incorporates a previous summary into a new one and retains recent context; defaults include a 16,384-token reserve and 20,000 recent tokens.

Source: [compaction implementation](https://github.com/badlogic/pi-mono/blob/f3c672245d25ef2283ffc0d9cdec8a5482651103/packages/coding-agent/src/core/compaction/compaction.ts#L578).

Noesis disables Pi's automatic compactor and calls its own `session_compactor` role, so it does not inherit that no-cache summary policy. We should evaluate cache-write avoidance for genuinely one-off role evidence while retaining reusable static role instructions. Disabling all caching for every auxiliary role would discard potential reuse.

### Session accounting is stronger than our current context display

Pi's `getSessionStats()` walks all recorded entries, including compacted-away history, and adds assistant usage, recorded tool-result usage, and recorded compaction/branch-summary usage. It returns input, output, cache-read, cache-write, and cost totals separately from context occupancy.

Source: [session statistics](https://github.com/badlogic/pi-mono/blob/f3c672245d25ef2283ffc0d9cdec8a5482651103/packages/coding-agent/src/core/agent-session.ts#L3355).

This is the right distinction to copy. It does not automatically prove every failed transport attempt was billed and recorded; complete per-attempt accounting still needs deliberate coverage.

Pi is not immune to cache churn: active-tool changes, extension system-prompt overrides, resource reloads, model switches, and compaction can change requests. Its maintained base prompt is a useful default, not a guarantee of cache hits.

## OpenCode findings

### Established request preparation deliberately supports cache reuse

The established session path passes `sessionID` to provider option construction. Supported SDKs receive `promptCacheKey` or `prompt_cache_key`, with a provider override to disable/set it. Request preparation adds stable session-affinity headers, sorts tool names, and normally groups system instructions into one block. Plugin additions are consolidated into a second block when the original first block remains unchanged.

Anthropic-style caching marks up to the first two system messages and the final two non-system messages. The implementation adapts message-level versus content-level options to provider SDKs and avoids duplicating markers when Anthropic automatic caching is configured. These are conditional provider paths, not one universal setting.

Sources: [request preparation](https://github.com/anomalyco/opencode/blob/193de13a88d62a6409c6d385831180f1def527dc/packages/opencode/src/session/llm/request.ts), [cache markers](https://github.com/anomalyco/opencode/blob/193de13a88d62a6409c6d385831180f1def527dc/packages/opencode/src/provider/transform.ts#L358), [cache keys](https://github.com/anomalyco/opencode/blob/193de13a88d62a6409c6d385831180f1def527dc/packages/opencode/src/provider/transform.ts#L1310).

This path still admits mutable system text and plugin transformations. Keeping the first block together does not make its contents immutable. A sorted tool list also still changes when membership changes; Noesis's fixed four-tool surface is valuable here.

### V2 context epochs are the strongest additional design lesson

The newer core persists the exact initial system-context baseline and a separate snapshot of observed context sources. Subsequent changes publish a chronological System message and advance the snapshot atomically, while requests retain the original baseline. After completed compaction, it can replace the baseline from a new complete observation. Temporary observation failure preserves an existing usable baseline; initial incomplete observation blocks initialization.

The runner calls this mechanism before assembling model requests. A dedicated test changes the context producer between turns and asserts that both requests retain `Initial context`, while the second request appends `Changed context` as a System message. Additional tests cover restart-related persistence, model changes, temporary unavailability, and rebaselining after compaction.

Sources: [context epoch](https://github.com/anomalyco/opencode/blob/193de13a88d62a6409c6d385831180f1def527dc/packages/core/src/session/context-epoch.ts), [runner integration](https://github.com/anomalyco/opencode/blob/193de13a88d62a6409c6d385831180f1def527dc/packages/core/src/session/runner/llm.ts#L173), [baseline test](https://github.com/anomalyco/opencode/blob/193de13a88d62a6409c6d385831180f1def527dc/packages/core/test/session-runner.test.ts#L741).

For Noesis, adapt the principle to frozen Capability versions and authority: maintain an immutable prompt baseline and append explicit scoped changes at safe boundaries. Define replacement, removal, and precedence semantics so an old instruction does not remain accidentally active. Provider adapters must preserve those roles. Ordinary agent instructions can still precede OpenCode's epoch baseline, so this mechanism does not freeze every possible request component.

### Typed replay preserves the material needed for continuation

Established message conversion retains tool-call/result structure and reasoning/provider metadata with model-specific compatibility handling. Its source explicitly handles signed Anthropic reasoning separators. V2 likewise preserves reasoning and tool metadata when continuing on the same model, stripping incompatible metadata and converting visible reasoning to ordinary text on model switches.

Sources: [established replay](https://github.com/anomalyco/opencode/blob/193de13a88d62a6409c6d385831180f1def527dc/packages/opencode/src/session/message-v2.ts#L263), [V2 replay](https://github.com/anomalyco/opencode/blob/193de13a88d62a6409c6d385831180f1def527dc/packages/core/src/session/runner/to-llm-message.ts).

Reconstructing messages from SQLite is not itself a cache bug. New JavaScript object identities do not change the provider prompt; serialized content, structure, ordering, metadata, and boundaries matter. Our original Noesis finding concerns discarded tool/reasoning structure, not object allocation or database reads.

### Output limits and pruning solve different problems

The established tool wrapper applies a default 2,000-line / 50 KiB preview when a tool has not already supplied truncation metadata. Full oversized text goes to a file with a recovery hint. The newer `ToolOutputStore` bounds textual presentation, including serialized structured-only output, while retaining structured data for internal use. Its preview retains head and tail and budgets the recovery marker. Managed files have a seven-day cleanup policy, which Noesis should not copy for evidence that must remain durably inspectable.

Sources: [tool wrapper](https://github.com/anomalyco/opencode/blob/193de13a88d62a6409c6d385831180f1def527dc/packages/opencode/src/tool/tool.ts#L135), [established truncation](https://github.com/anomalyco/opencode/blob/193de13a88d62a6409c6d385831180f1def527dc/packages/opencode/src/tool/truncate.ts), [V2 output store](https://github.com/anomalyco/opencode/blob/193de13a88d62a6409c6d385831180f1def527dc/packages/core/src/tool-output-store.ts).

Separately, established session pruning walks backward, protects the recent turns and 40,000 estimated tokens of eligible tool output, exempts the `skill` tool, and marks older results compacted only when more than 20,000 tokens can be removed. Replay then substitutes an old-result-cleared marker. Compaction uses previous summary plus selected conversation and retained recent context; its model can be configured through the compaction agent.

Source: [pruning and compaction](https://github.com/anomalyco/opencode/blob/193de13a88d62a6409c6d385831180f1def527dc/packages/opencode/src/session/compaction.ts#L271).

Pruning still rewrites an existing prefix. The thresholds batch that tradeoff; they do not eliminate it. Protecting already-loaded skill instructions is particularly relevant to Noesis, where plain conversational replay can omit the skill-load result entirely.

### Usage is retained per completed model step

OpenCode records normalized tokens and cost in each `step-finish` part and updates the assistant message. Cache read/write fields survive this path. This is more useful for accounting than reporting only the final request's occupancy.

Source: [usage persistence](https://github.com/anomalyco/opencode/blob/193de13a88d62a6409c6d385831180f1def527dc/packages/opencode/src/session/processor.ts#L452).

## Revised recommendations

1. Fix stable cache identity and cumulative cache accounting first. Both projects provide concrete source examples.
2. Introduce provider-compatible, immutable message replay until deliberate context boundaries. Benchmark its total cost against our compact replay rather than assuming more raw tokens means more spend.
3. Bound tool-result presentation when first admitted, with stable recovery references. Keep exact data accessible to codemode and durable evidence inspection.
4. Design an immutable context baseline plus explicit chronological updates for Capability changes. OpenCode V2 provides the clearest implementation example, but Noesis must define its own authority and precedence rules.
5. Make auxiliary requests reusable where their inputs repeat, and avoid cache-write premiums for one-off content where provider policy permits. Keep capable semantic decisions and ambient reflection.
6. Preserve Noesis's four direct tools, progressive Broker discovery, and immutable note deltas. Neither upstream source establishes a reason to replace those advantages with larger tool catalogs or recursive summary rewriting.

Neither project establishes an optimal token budget, universal TTL, or verified savings percentage for Noesis. The next proof should be controlled request-shape regression tests followed by a separately authorized provider benchmark measuring cost per successful task.
