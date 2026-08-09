# Noesis engineering invariants

## Product contract

- Read the relevant product doctrine under `docs/` before changing product behavior.
- Use capable models for decisions that depend on meaning, including intent, correction, feedback, relevance, progress, scope, and learning value. Do not use regular expressions, keyword lists, or fixed heuristics as semantic classifiers. Keep regular expressions for syntax and validation.
- Deliver immediate value first. Preserve a future advantage only when the evidence supports a credible future use.
- Infer collaboration posture. Ambiguous intellectual work defaults toward `work_with_me`, while explicit execution defaults toward `do_for_me`. A conversational instruction overrides the inference.
- Start new learning at the narrowest plausible scope. Every durable learning names its anticipated future use, and recurring evidence is required before its scope broadens.
- Run reflection ambiently after useful work. `no_change` is a valid result, and not every session must compound.
- Keep every adaptation inspectable, contestable, and revertible. Normal workflows stay conversational instead of becoming approval dialogs.
- An explicit foreground task may publish a project-local script or workflow and use it immediately through `execute` under the current authority. Do not force this path through reflection, a candidate, or evaluation. Reflection observes its results; broader learned or global consolidation still uses protected evaluation and activation.
- Generated content may create project-local executable definitions, but it cannot modify the protected control plane or approve broader promotion.
- Keep durable product doctrine under `docs/`. Keep implementation plans under `plans/`.

## Architecture

- Read the relevant implementation plans under `plans/` before changing package ownership, protected boundaries, tools, codemode, skills, scripts, workflows, or their TUI surfaces.
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
- Pi always sees the three semantic self tools plus `execute`. A small direct-tool hotbar may expose tools from the same frozen Tool Catalog and Broker; it never creates a second execution path or widens authority.
- Codemode is trusted local Node.js execution. It owns process lifecycle and the SDK bridge, not real tools, policy, durable state, or a second registry.
- Standard skills remain instructional resources with progressive disclosure. A skill package never registers executable extensions implicitly.
- Editable script and workflow files are declarative authority; immutable revisions pin executions. SQLite owns code execution, workflow run, phase, and nested-call state.
- Code executions retain exact source and bounded logs as artifact files. Workflow runs pin their definition, tool catalog, permission snapshot, and model routing; changed dependencies fail closed on resume.

## Protected control plane

- Reflection may propose memory, knowledge, workflows, cases, or candidates. It must never promote broader learned executable behavior. Explicit foreground publication of a project-local script or workflow is not promotion.
- Permission, evaluation, workspace integrity, activation, promotion, and rollback rules stay outside generated or self-modifiable content.
- All side effects and protected promotion, rollback, and scheduling transitions go through `AuthorityBoundary` and `EffectGateway`. Ordinary callers never install grants or mint receipts.
- Reserve grant use and cost durably in authoritative operational state before execution. Rehydrate reservations and completions from SQLite and fail closed when a reservation has no unambiguous outcome.
- Effectful retries require stable operation identities and idempotency keys bound to principal, effect class, resource, and request identity. Never retry an incomplete effect by assuming it failed.
- Background jobs receive scheduler-specific grants that cannot widen themselves.
- Candidate authors provide source cases only and cannot see judge decisions or protected cases. Evaluation owns comparison evidence; activation binds the exact candidate revision and preflight evidence. Retain failed evaluations and regression evidence.

## Local workflow

- Node >= 22.19, TypeScript strict ESM, exact direct dependency pins.
- Keep all planning artifacts under `plans/`.
- Prefer immutable values, pure decision functions, typed results/errors, and dependency injection at I/O boundaries.
- Do not use `any`. Avoid assertions; validate unknown durable data at the boundary.
- Read a source file fully before a broad edit. Keep public package APIs narrow and add abstractions only with a consumer in this iteration.
- Run `pnpm format`, `pnpm lint`, `pnpm typecheck`, and `pnpm test` after code changes. `pnpm check` runs the full set.
- Use Pi AgentHarness with a credential-free controlled provider for integration and acceptance work. Keep scripted runtime doubles test-only and limited to narrow unit seams. Never require credentials, network access, or paid model calls in CI.
- Do not edit the local Pi, Hermes, or Codex reference clones. Do not commit unless explicitly asked.
