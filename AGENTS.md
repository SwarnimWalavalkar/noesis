# Noesis engineering invariants

## Product contract

- Read the relevant product doctrine under `docs/` before changing product behavior.
- Use capable models for decisions that depend on meaning, including intent, correction, feedback, relevance, progress, scope, and learning value. Do not use regular expressions, keyword lists, or fixed heuristics as semantic classifiers. Keep regular expressions for syntax and validation.
- Deliver immediate value first. Preserve a future advantage only when the evidence supports a credible future use.
- Infer collaboration posture. Ambiguous intellectual work defaults toward `work_with_me`, while explicit execution defaults toward `do_for_me`. A conversational instruction overrides the inference.
- New learned Capabilities default to global eligibility and semantic relevance. The model or user may narrow them to a project or session, or make them always active.
- Run reflection ambiently after every settled foreground turn, including failed and aborted work. `no_change` is a valid result.
- Keep every adaptation inspectable, contestable, and revertible. Normal workflows stay conversational instead of becoming approval dialogs.
- An explicit foreground task may publish a project-local Program in script or workflow mode and use its exact revision immediately through `execute` under the current authority. Do not force this path through reflection or evaluation. Reflection observes the result; ambient learning may author instruction and skill effects or attach an exact already-saved Program revision to a Capability, but it does not create a parallel executable definition.
- The foreground agent may deliberately author the same complete Capability decision as ambient reflection. Both paths use one protected publisher; the runtime supplies authoritative foreground evidence and binding versions and does not reinterpret the decision with another model call. Keep the operational guidance in the progressively disclosed built-in `noesis` skill, with `/refine` as an alias, instead of expanding the base system prompt. Subagents may advise but may not publish Capability changes.
- Generated content may author exact Capability materials. Credential export, recovery and audit control, and irreversible external actions without foreground user intent remain behind the small capability gate.
- Keep durable product doctrine under `docs/`. Keep implementation plans under `plans/`.

## Architecture

- Read the relevant implementation plans under `plans/` before changing package ownership, protected boundaries, tools, codemode, skills, Programs, or their TUI surfaces.
- Pi executes turns only. Only `packages/runtime-pi` may import Pi agent/runtime types. Do not introduce `createAgentSession` or Pi `InteractiveMode` as a product root.
- The TUI uses `@earendil-works/pi-tui` directly and renders read models. UI components never own durable state.
- `WorkspaceStore` owns persistence boundaries. SQLite is authoritative for operational state; ordinary editable workspace files are authoritative for declarative definitions.
- Recorded definition revisions and evaluation pins resolve to immutable, byte-stable snapshots. Experiments, turns, activation, inspection, and revert never depend on mutable working-file bytes.
- FTS, embedding, search-document, and UI read-model data are rebuildable indexes or projections. Derived data must cite an authoritative SQLite row or recorded file revision.
- Every persisted datum has exactly one declared authority. Do not dual-write competing canonical copies or reconstruct current operational state from activity history.
- SQLite transactions, constraints, migrations, integrity checks, and backups govern operational recovery. Activity and file-revision records preserve provenance and debugging history; they are not a universal recovery journal.
- Legacy JSONL support is import-only inside the workspace cutover. Do not recreate a runtime ledger, ledger package, or second operational authority around it.
- Large outputs remain ordinary artifact files with SQLite metadata. Evaluation evidence is revisioned and append-only once used by a decision; credentials remain only in the protected credential store or process environment.
- Context fragments have provenance and hard per-fragment and total bounds. Capability versions are frozen at turn start.
- Pi always sees exactly `execute`, file read, complete file write, and shell. Every other executable operation, including Capability inspection, Program management, MCP tools, and harness control, is a Broker tool taught through progressive disclosure. All four direct tools use the same frozen Tool Catalog, Broker, and authority as codemode.
- Codemode is trusted local Node.js execution. It owns process lifecycle and the SDK bridge, not real tools, policy, durable state, or a second registry.
- Standard skills remain instructional resources with progressive disclosure. A skill package never registers executable extensions implicitly.
- Editable Program files are declarative authority; immutable revisions pin executions. Script and workflow remain distinct execution modes. SQLite owns code execution, workflow run, phase, and nested-call state.
- Code executions retain exact source and bounded logs as artifact files. Workflow runs pin their definition, tool catalog, permission snapshot, and model routing; changed dependencies fail closed on resume.

## Protected control plane

- Reflection or the foreground agent may create or revise an exact Capability and activate ordinary revisions immediately through the same protected publisher. Explicit foreground publication of a project-local Program remains an independent direct path.
- Recovery and audit control, credential export, and irreversible external actions without foreground user intent require an explicit approve, deny, or change decision. Workspace integrity and truthful rollback remain protected code.
- All side effects and protected promotion, rollback, and scheduling transitions go through `AuthorityBoundary` and `EffectGateway`. Ordinary callers never install grants or mint receipts.
- Reserve grant use and cost durably in authoritative operational state before execution. Rehydrate reservations and completions from SQLite and fail closed when a reservation has no unambiguous outcome.
- Effectful retries require stable operation identities and idempotency keys bound to principal, effect class, resource, and request identity. Never retry an incomplete effect by assuming it failed.
- Background jobs receive scheduler-specific grants that cannot widen themselves.
- Capability revisions bind every exact effect and its evidence. Instruction and skill effects own immutable material revisions. Program effects reference the same immutable project definitions used by their ordinary runners; the model publishes new Programs through the explicit foreground `execute` path. Existing experiment and preflight records remain readable history; a future evaluation system must execute real candidate behavior before making comparative claims.

## Local workflow

- Node >= 22.19, TypeScript strict ESM, exact direct dependency pins.
- Keep all planning artifacts under `plans/`.
- Prefer immutable values, pure decision functions, typed results/errors, and dependency injection at I/O boundaries.
- Do not use `any`. Avoid assertions; validate unknown durable data at the boundary.
- Read a source file fully before a broad edit. Keep public package APIs narrow and add abstractions only with a consumer in this iteration.
- Run `pnpm format`, `pnpm lint`, `pnpm typecheck`, and `pnpm test` after code changes. `pnpm check` runs the full set.
- Use Pi AgentHarness with a credential-free controlled provider for integration and acceptance work. Keep scripted runtime doubles test-only and limited to narrow unit seams. Never require credentials, network access, or paid model calls in CI.
- Do not edit the local Pi, Hermes, or Codex reference clones. Do not commit unless explicitly asked.
