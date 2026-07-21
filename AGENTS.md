# Noesis engineering invariants

## Architecture

- Read `noesis-first-complete-iteration.html` before changing package ownership or protected boundaries.
- Pi executes turns only. Only `packages/runtime-pi` may import Pi agent/runtime types. Do not introduce `createAgentSession` or Pi `InteractiveMode` as a product root.
- The TUI uses `@earendil-works/pi-tui` directly and renders read models. UI components never own durable state.
- JSONL is the source of truth. SQLite and Markdown are rebuildable projections. Every durable schema is versioned and validated.
- Serialize the complete ledger append operation. Cooperating processes must honor the journal writer lock; never calculate a sequence or checksum outside that ownership window.
- Every meaningful transition appends an event. Never rewrite past events or make SQLite the only copy of history.
- Artifacts are content-addressed and immutable. Keep lineage in ledger events.
- Context fragments have provenance and hard per-fragment and total bounds. Capability versions are frozen at turn start.

## Protected control plane

- Reflection may propose memory, knowledge, workflows, cases, or candidates. It must never promote executable behavior.
- Permission, evaluation, ledger integrity, promotion, and rollback rules stay outside generated or self-modifiable content.
- All side effects and protected promotion, rollback, and scheduling transitions go through `AuthorityBoundary` and `EffectGateway`. Ordinary callers never install grants or mint receipts.
- Reserve grant use and cost durably before execution. Rehydrate reservations and completions from JSONL and fail closed when a reservation has no unambiguous outcome.
- Retries require stable idempotency keys. Never retry an incomplete effect by assuming it failed.
- Background jobs receive scheduler-specific grants that cannot widen themselves.
- Candidate authors provide source cases only. The evaluation package owns held-out cases separately; reports and promotions must bind the canonical candidate digest and protected suite digest. Retain failed evaluations and regression evidence.

## Local workflow

- Node >= 22.19, TypeScript strict ESM, exact direct dependency pins.
- Prefer immutable values, pure decision functions, typed results/errors, and dependency injection at I/O boundaries.
- Do not use `any`. Avoid assertions; validate unknown durable data at the boundary.
- Read a source file fully before a broad edit. Keep public package APIs narrow and add abstractions only with a consumer in this iteration.
- Run `pnpm format`, `pnpm lint`, `pnpm typecheck`, and `pnpm test` after code changes. `pnpm check` runs the full set.
- Use the fake runtime for tests and acceptance work. Never require paid model calls in CI.
- Do not edit the local Pi, Hermes, or Codex reference clones. Do not commit unless explicitly asked.
