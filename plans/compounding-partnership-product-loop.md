# Compounding partnership product loop build plan

## Outcome

Build the first user-visible Noesis loop in which:

1. a foreground turn infers a corrigible collaboration posture;
2. the turn executes from one immutable, workspace-backed intelligence plan;
3. useful work is completed before ambient reflection begins;
4. reflection either makes no change or proposes the narrowest evidence-linked learning with an anticipated future use;
5. a candidate is evaluated and activated through the protected control plane;
6. a later relevant turn demonstrably serves the exact active revision; and
7. the user can understand, contest, and revert the adaptation through a conversational experience backed by precise inspection.

This plan builds on the implemented autonomous-compounding foundation. It does not replace the architecture in [the autonomous compounding plan](noesis-autonomous-compounding-implementation-plan.html).

## Settled product decisions

- Ambiguous intellectual work defaults toward **work with me**.
- Explicit execution defaults toward **do for me**.
- Collaboration posture is inferred with conversational override; users do not operate mandatory modes.
- New learning starts at the narrowest plausible scope and broadens only through recurring evidence.
- Every durable learning names an anticipated future use and the behavior it should improve there.
- Not every session must compound. `No change` is a successful reflection outcome.
- Reflection and evaluation are ambient and automatic.
- Self-improvement should feel magical but never mysterious: every change has an inspectable adaptation history and an easy path to contest or revert.
- Normal workflows stay conversational. Only genuine authority expansion interrupts with explicit approval.
- Generated content may propose memories, knowledge, workflows, cases, prompts, skills, tools, and routing changes. Protected permission, evaluation integrity, activation, promotion, and rollback remain outside generated content.

## Deliberately deferred learning questions

The following are not sufficiently settled to encode as final product rules:

- whether the compounding-practitioner persona generalizes beyond the initial user;
- the real frequency of builder, philosopher, learner, and researcher orientations;
- the final detection policy or exact UX for collaboration posture;
- the ideal granularity of continuity across artifacts, decisions, questions, explanations, summaries, and raw sessions;
- the exact inference policy for implicit feedback;
- final thresholds for automatic reflection, evaluation, activation, revision, and rollback;
- interface or communication-channel expansion beyond the current TUI;
- final product metrics, scoring rubrics, judge panels, evaluator aggregation, or statistical ceremony that require actual usage evidence.

The implementation should preserve evidence that helps answer these questions. It should not pretend to answer them in advance.

## Current-state audit

### Implemented foundations

| Area | Current implementation |
| --- | --- |
| Workspace authority | `packages/workspace` has SQLite migrations, operational repositories, canonical editable definitions, immutable revisions, evidence files, artifacts, backup/restore, durable jobs, activation state, and feedback state. |
| Longitudinal intelligence | `packages/intelligence` provides bounded history search, exact citations, FTS, deterministic embedding/rerank adapters, and session-tool definitions. |
| Model roles | `packages/agent-types` defines adapter-neutral role contracts. `packages/runtime-pi` owns Pi role execution, output repair, context isolation, session-tool adapters, and generated-tool broker adapters. |
| Learning | `packages/learning` harvests corrections and friction, retrieves recurrence, supports a first-class `no_change`, captures explicit criteria, authors coupled capability revisions, and persists experiment briefs and candidate manifests. |
| Evaluation | `packages/evals` runs generated cases, paired baseline/candidate trials, blinded judge/critic comparison, protected rails, criterion snapshots, and append-only evidence recording. |
| Capability control | `packages/capabilities` owns complete revision identity plus pin and veto controls. `packages/runtime` implements protected preflight policy, atomic activation, frozen activation pins, continuous feedback, and keep/revise/revert outcomes. |
| Generated tools | `packages/tool-runtime` runs generated code out of process with bounded local-preview execution, schemas, artifacts, traces, and `EffectGateway` mediation. |
| Ambient coordination | `packages/runtime` has a durable SQLite-backed reflect → author → preflight coordinator with leases, retry, cancellation, restart recovery, and automatic activation reconciliation. |

### Integration gaps that define the next work

1. **Foreground truth is still split.** `apps/noesis/src/cli.ts` creates the legacy `createNoesisRuntime` and then wraps it with `createApplicationRuntimeComposition`. `packages/runtime/src/index.ts` executes the foreground turn from the JSONL ledger, legacy memory, and legacy capability registry. The wrapper separately pins the workspace activation and writes session/message/outcome rows to SQLite. This is transitional dual writing, not the settled one-authority architecture.
2. **The frozen activation is not the behavior served to the model.** `apps/noesis/src/runtime-composition.ts` obtains a `TurnActivationPinRecord`, but the wrapped runtime builds the actual prompt and tool list from the legacy registry. Atomic capability revisions can activate without becoming the prompt, router, or generated tools used by the next foreground turn.
3. **Fresh workspaces cannot enter the automatic loop.** The application only calls `observeCompletedTurn` when the activation pin already contains a serving capability revision. The genesis activation is empty, so an ordinary first correction records operational data but does not start ambient reflection.
4. **Collaboration posture is not modeled.** The current path has no per-turn work-with-me/do-for-me decision, evidence, conversational override, or explanation. Corrections use a small regex and a fixed `"general"` signal scope.
5. **Durable learning lacks an anticipated-use contract.** Signals and experiment briefs carry evidence, scope, and hypotheses, but do not require the future situation and expected behavioral advantage that justify persistence.
6. **The new control plane is not yet the product experience.** `packages/tui/src/index.ts` still exposes the original manual `/learn`, `/evaluate`, `/promote`, and `/rollback` flow. It has no ambient activity, `/why`, adaptation history, criterion lifecycle, approval, pin, veto, or exact activation inspection.
7. **Existing intelligence and tool adapters are not registered in foreground turns.** `packages/runtime-pi/src/session-tool-registration.ts` and the generated-tool bridge exist, but `createPiAgentRuntime` currently registers only snapshot inspection.
8. **The fake application path does not exercise compounding.** Its role runner returns only reflector `no_change`; package acceptance tests prove the organs independently, but the shipped fake runtime does not prove the complete user journey.

## Coherent next product loop

```text
user message
  → resolve collaboration posture and conversational override
  → freeze activation, selected definitions, retrieval, prompt, tools, permissions
  → execute one foreground turn through runtime-pi
  → persist outcome and useful evidence in WorkspaceStore
  → ambient disposition: no_change | narrow learning proposal
  → author → evaluate → protected activate
  → quiet adaptation-history entry
  → later relevant turn pins and serves the exact revision
  → conversational explain, contest, or revert
```

The core implementation rule is that the plan inspected after a turn must be the plan that actually served that turn. There must not be a second registry, prompt reconstruction, or mutable working-file lookup on the execution path.

## Functional and domain conventions

- Use pure functions for posture defaults, scope narrowing/broadening decisions, prompt-layer selection, and user-facing read-model derivation.
- Use closure-based `create*` factories for stateful orchestration and dependency injection at I/O seams.
- Return typed results for expected conflicts, denials, stale revisions, and ambiguous outcomes.
- Validate unknown SQLite rows, files, IPC, tool payloads, and model outputs with Zod at the boundary.
- Keep immutable revision references in every turn, learning, evaluation, activation, and explanation record.
- Add a module or package only when this iteration has a real caller. Prefer package-local modules behind existing interfaces.
- Keep Pi execution types inside `packages/runtime-pi`. `apps/noesis` remains the composition root.
- Keep TUI state ephemeral. It consumes runtime read models and invokes protected operations; it never owns durable policy.

## Workstreams

### WS1 — One authoritative foreground turn

**Goal:** Replace the wrapper/mirror path with a workspace-backed turn module whose durable state, prompt, and served activation agree.

**Ownership**

- `packages/runtime/src/index.ts`: narrow the existing public runtime interface around the workspace-backed implementation while preserving session start/resume/fork/abort behavior.
- New package-local runtime modules such as `packages/runtime/src/foreground-turn.ts` and `packages/runtime/src/turn-intelligence.ts`: own the deep foreground-turn interface, frozen plan construction, and turn settlement.
- `packages/workspace/migrations/`, `packages/workspace/src/store.ts`, and the WorkspaceStore state ports: add the operational rows and transactional interfaces needed for turn intelligence, prompt snapshots, posture, settlement, grants, reservations, completions, receipts, budgets, and operation-identity collisions.
- `packages/policy`: move durable grant and effect state behind the WorkspaceStore interfaces while preserving `AuthorityBoundary` and `EffectGateway` as the only authority and side-effect entry points.
- `packages/context/src/index.ts`: compile the selected immutable prompt layers and bounded context with provenance.
- `apps/noesis/src/runtime-composition.ts`: compose the runtime directly from `WorkspaceStore`, role inference, Pi/fake execution, control plane, and protected authority.
- `packages/workspace/src/importer.ts`: reuse the existing one-time import seam for legacy trails and protected operational records; record a cutover marker and stop appending new turn, authority, grant, reservation, receipt, budget, and effect-completion state to the JSONL ledger after successful migration.

**Required behavior**

- SQLite is authoritative for new sessions, turns, messages, outcomes, activation pins, grants, reserved uses and costs, effect completions/failures, authority receipts, budgets, and idempotency bindings.
- The turn freezes one activation ID, posture decision, selected definition revisions, retrieval citations, prompt snapshot, tool revisions, permission snapshot, and routing decision before model execution.
- Turn execution reads only the frozen plan and immutable revision bytes.
- Grant use and estimated cost are reserved transactionally before execution. Stable operation identity binds the idempotency key to principal, effect class, resource, and request identity; a reused key with a different binding is a durable collision and is rejected.
- Restart rehydrates grants, reservations, completions, receipts, and remaining budgets from SQLite. A completed matching operation replays its recorded outcome, while a reservation without one unambiguous completion or failure remains unresolved and fails closed.
- Protected activation, generated-tool effects, rollback, and scheduling use the same SQLite-backed authority and effect interfaces. Ordinary callers still cannot install grants, mint receipts, or infer that an incomplete effect failed.
- Interrupted turns remain fail-closed and recoverable through explicit ownership/lease evidence; do not infer completion from absence.
- Existing workspace homes migrate once and retain their prior evidence. No new dual write is introduced.

**Acceptance**

- A fault injected before admission produces no visible turn.
- A fault after admission leaves one unambiguous running turn with its frozen plan.
- A settled turn has one SQLite authority and no new legacy event append.
- Inspecting the recorded prompt digest, tools, activation, and citations reproduces exactly what the fake runtime received.
- Restart preserves grant-use and cost budgets, rejects idempotency-key collisions, and cannot spend a reservation twice.
- Restart replays an exact completed operation without rerunning its effect and returns the recorded completion and receipt lineage.
- Restart treats a reserved operation with no unambiguous outcome as unresolved and fails closed instead of retrying or refunding it.

### WS2 — Collaboration posture and a genesis baseline

**Goal:** Give every turn a conservative, corrigible collaboration posture and allow a fresh workspace to participate in learning.

**Ownership**

- New `packages/runtime/src/collaboration-posture.ts`: own the posture resolver interface, pure default decision, override application, and explanation read model.
- `packages/agent-types/src/index.ts`: extend adapter-neutral structured inference only if the posture resolver needs a shared role request/result contract used by both runtime and `runtime-pi`.
- `packages/runtime-pi/src/role-runner.ts`: provide the Pi adapter for ambiguous posture interpretation without owning the product decision.
- `apps/noesis/src/runtime-composition.ts`: publish and activate one immutable, file-backed `general-collaboration` baseline capability at workspace initialization.

**Required behavior**

- Clear execution requests resolve to `do_for_me`.
- Ambiguous intellectual requests resolve conservatively to `work_with_me`.
- Explicit conversational instructions override inference immediately and cite the user message.
- A posture may change during a session; each turn records its own decision and reason.
- The baseline capability is ordinary immutable declarative behavior, separate from the protected kernel. It gives reflection and evaluation an exact baseline on a fresh workspace.

The first resolver is intentionally replaceable. It must be good enough for clear fixtures and honest about uncertainty; it is not the final mode-detection policy.

**Acceptance**

- “Implement this exact patch” resolves to `do_for_me`.
- “I am not sure what this means; think it through with me” resolves to `work_with_me`.
- “Just do it” and “teach me instead” override the prior posture without a mode command.
- `/why`-equivalent runtime inspection explains the decision from its pinned evidence.
- A correction on the first session queues reflection against the immutable baseline.

### WS3 — Selective learning with anticipated future use

**Goal:** Make every durable learning earn its place and stay narrowly scoped.

**Ownership**

- `packages/domain/src/research.ts` and `packages/domain/src/storage-schemas.ts`: extend shared learning and experiment contracts only for fields consumed by learning, workspace, evaluation, runtime, and inspection.
- `packages/learning/src/schemas.ts` and `packages/learning/src/organ.ts`: require the reflector to return either `no_change` or an evidence-linked proposal with anticipated future use, narrow scope, scope rationale, expected behavior, and stale/contradiction conditions.
- `packages/learning/src/durable.ts`: preserve these fields in immutable briefs and candidate manifests.
- `packages/runtime/src/coordinator-contracts.ts`: carry the exact learning disposition through durable jobs without giving generated roles activation handles.

**Required behavior**

- Reflection happens after useful turn settlement and never blocks the foreground response.
- `No change` remains first class and produces no memory, criterion, experiment, or capability merely to prove activity.
- Explicit normative statements may still create criteria, but only at the narrowest plausible scope.
- Scope broadening requires new recurring evidence from distinct relevant contexts and creates a new attributable revision.
- Every experiment and durable learning exposes its anticipated future use to evaluation and later inspection.
- Existing implicit-signal heuristics remain provisional. This work records evidence; it does not claim a final implicit-feedback policy.

**Acceptance**

- An ordinary successful execution can end in `no_change` with no durable learning object.
- A repository-specific correction cannot silently become a global rule.
- A repeated correction across distinct scopes can propose a broader successor while preserving the narrower revision and evidence.
- A candidate missing anticipated future use or evidence fails boundary validation.
- Secret turns do not enter learning or retrieval.

### WS4 — Serve the active revision and existing tool/intelligence modules

**Goal:** Make atomic activation causally affect later work.

**Ownership**

- `packages/runtime/src/turn-intelligence.ts`: resolve selected active capability revisions into exact prompt, skill, router, and tool revisions for one turn.
- `packages/agent-types/src/index.ts`: add the smallest adapter-neutral frozen-tool invocation interface needed by both runtime and `runtime-pi`.
- `apps/noesis/src/runtime-composition.ts`: as the composition root, construct turn-scoped retrieval and generated-tool executors from the frozen turn plan, WorkspaceStore artifact/evidence ports, `EffectGateway`, and the protected broker, then inject adapter-neutral registrations into `runtime-pi`.
- `packages/runtime-pi/src/index.ts`: adapt the supplied turn-scoped registrations to Pi tools without constructing product executors, selecting authority, or owning broker policy.
- `packages/runtime-pi/src/session-tool-registration.ts` and `packages/runtime-pi/src/generated-tool-broker.ts`: reuse the existing adapters; extend only for a proven foreground consumer.
- `packages/tool-runtime`: change only if application composition proves a genuinely missing broker-execution seam. Do not move composition into this package, redesign its backend, or claim production isolation.

**Required behavior**

- A later turn uses only the prompt, skill, router, and tool revisions named by its activation pin.
- The application composition root derives all retrieval and generated-tool executors from that frozen plan and injects them through adapter-neutral registrations; `runtime-pi` performs Pi adaptation only.
- Session retrieval stays bounded, citation-bearing, and untrusted.
- Generated tools execute out of process behind the existing broker and `EffectGateway`.
- Missing, digest-mismatched, or permission-incompatible material fails before model execution.
- Capability versions are never inferred from mutable working files or activity history.

**Acceptance**

- The fake runtime proves that a promoted prompt revision changes the next relevant completion and an unrelated turn does not select it.
- A generated-tool fixture proves the exact active source revision, permission manifest, trace, and result.
- Deleting rebuildable search indexes and rebuilding them preserves authoritative citations.
- A broader effect produces a protected approval requirement; the generated tool cannot approve itself.
- The application-level fake journey proves that the composition root injects only the frozen turn’s retrieval/generated-tool registrations, records artifacts through WorkspaceStore, mediates effects through the protected broker, and never lets `runtime-pi` construct or widen authority.

### WS5 — Adaptation history and conversation-first controls

**Goal:** Turn the control plane into a legible product experience without moving durable state into the TUI.

**Ownership**

- New `packages/runtime/src/adaptation-history.ts`: compose immutable user-facing read models from experiments, evidence, preflights, activations, feedback outcomes, criteria, and activity provenance.
- `packages/runtime/src/control-plane.ts`: expose narrow inspect, contest, approve, pin, veto, and revert operations backed by existing protected controllers.
- `packages/tui/src/index.ts`: render ambient learning status, quiet completion notices, adaptation history, and conversation results from runtime read models.
- `apps/noesis/src/cli.ts`: add non-interactive inspection/export commands only when they reuse the same runtime read models.

**Required behavior**

- Normal text remains a normal conversation. There is no mandatory mode picker or learning wizard.
- The foreground model can answer conversational questions about the active posture, retrieved context, and adaptations from bounded inspection tools or prompt context.
- Expert shortcuts include `/why`, `/changes`, `/change <id>`, criterion inspection/lifecycle, pin, veto, approval, and revert. They are precise shortcuts, not a second product model.
- Only authority expansion uses an interrupting approval. Other activity is ambient or opened by the user.
- Contesting creates a durable correction or narrower/retired revision. It never erases evidence.
- Revert restores the prior complete activation snapshot.

**Acceptance**

- A quiet notification names what changed, why, scope, anticipated future use, and whether authority changed.
- “Why did you do that?”, “What have you learned about this project?”, and “Undo that adaptation” work conversationally in the fake acceptance journey.
- Exact evidence, candidate diff, preflight, active revision, later feedback, and prior activation are inspectable.
- TUI reducer tests prove that restart reconstructs the same view from runtime read models and that no durable policy lives in UI state.

### WS6 — Fake-runtime product acceptance and evidence capture

**Goal:** Prove the shipped application path, not only independent organs.

**Ownership**

- `apps/noesis/test/` for complete application journeys.
- Focused package tests beside each owning module.
- `apps/noesis/src/runtime-composition.ts` for deterministic fake role scripts covering posture, reflection, authorship, evaluation, activation, explanation, and outcome.

**Journeys**

1. **Work with me:** an ambiguous architecture question selects collaborative posture, preserves alternatives and uncertainty, and makes no durable change when no reusable advantage is credible.
2. **Do for me:** an explicit bounded edit executes directly and remains free of visible learning machinery.
3. **First correction:** a fresh workspace correction produces a narrow proposal with anticipated future use, runs ambient authoring and evaluation, and activates a low-risk revision.
4. **Return:** a related later session retrieves exact evidence and serves the exact active revision; an unrelated session does not.
5. **Legibility:** a conversational why query and expert view show the complete adaptation history.
6. **Contest and revert:** a correction narrows the learning; a seeded hard regression restores the prior activation exactly.
7. **Authority expansion:** a candidate requesting a broader effect remains pending until protected explicit approval.

No paid model call is required in CI.

## Dependency and parallelization order

### Wave 0 — Authoritative turn barrier

Complete WS1 first. It changes both foreground and protected operational authority and must land before other work attaches new meaning or effects to a turn. The turn cutover and SQLite-backed policy/effect cutover are one barrier: do not release WS4 while activation, generated-tool effects, rollback, or scheduling can still consult operational JSONL. Run migration, collision, budget, idempotent-replay, unresolved-reservation, recovery, and architecture checks before continuing.

### Wave 1 — Intent and serving foundation

Run the package-local WS2 and WS4 modules in parallel after WS1:

- one owner handles collaboration-posture decisions and baseline publication modules;
- one owner handles exact activation-to-prompt/tool planning and adapter-neutral tool registration.

Neither parallel owner edits `apps/noesis/src/runtime-composition.ts`. After both module interfaces stabilize, one composition owner serially wires baseline initialization, posture inference, retrieval executors, generated-tool executors, WorkspaceStore artifacts, `EffectGateway`, the protected broker, and `runtime-pi` registrations in that file. Merge through a shared-contract barrier for changes to `packages/agent-types`, `packages/domain`, manifests, or the lockfile.

### Wave 2 — Learning and legibility

Run WS3 and the runtime read-model portion of WS5 in parallel after the Wave 1 contracts stabilize. Learning writes the new anticipated-use and scope evidence; adaptation history reads those authoritative records.

### Wave 3 — Product integration

Finish WS4 foreground registration and WS5 TUI/CLI controls against the real Wave 2 read models. Do not let TUI work invent a parallel state model.

### Wave 4 — Acceptance and focused review

Complete WS6, then perform one focused review of:

- single-authority turn persistence;
- exact served activation and prompt identity;
- baseline/candidate separation;
- protected promotion and approval;
- scope broadening evidence;
- conversation-first UX;
- restart recovery; and
- honest local-preview generated-tool limitations.

Fix material findings in the owning module, then run the full repository check.

## Verification

After each code-changing wave:

```sh
pnpm format
pnpm lint
pnpm typecheck
pnpm test
```

The final gate is `pnpm check`.

Required focused test classes:

- pure posture, override, scope, and prompt-selection decision tests;
- WorkspaceStore transaction, migration, cutover, backup/restore, and recovery tests;
- policy/effect restart tests for grant and cost budgets, idempotency-key collisions, exact completed replay, receipt lineage, and unresolved reservations failing closed;
- immutable prompt/revision identity tests;
- fake Pi adapter tests for session and generated tools;
- application-level fake composition tests proving turn-scoped retrieval/generated-tool injection, WorkspaceStore artifact recording, and protected broker mediation;
- automatic no-change, narrow-learning, broadening, and secret-data tests;
- baseline/candidate paired preflight and protected-rail tests;
- first-turn activation, later-turn use, unrelated-turn abstention, and revert tests;
- TUI reducer, rendering, terminal-width, shutdown, and conversation-control tests;
- fault injection around admission, role timeout, queue lease, activation publication, and effect reservation.

## Explicit non-goals

- Finalizing persona segmentation or claiming broad market fit.
- Building mode-selection screens or requiring mode commands.
- Finalizing implicit-feedback classifiers or universal collaboration-posture heuristics.
- Choosing a permanent continuity unit or injecting all prior context.
- Finalizing activation thresholds, quality metrics, evaluation rubrics, judge ensembles, or statistical policies without usage evidence.
- Adding web, mobile, messaging, voice, or other interfaces.
- Replacing Pi as the turn executor or allowing Pi types outside `packages/runtime-pi`.
- Making the TUI, generated content, or activity history authoritative.
- Moving protected promotion, permission, evaluation integrity, or rollback into prompts or generated code.
- Claiming the local generated-tool child process is a production security boundary.
- Broadening generated-tool dependency support, scheduler surfaces, or unrelated platform capabilities.

## Definition of done

The iteration is done when the fake application begins from a fresh workspace, resolves collaboration posture without a mandatory mode, completes useful work, ambiently chooses between no change and a narrow anticipated-use learning, activates a passing low-risk revision through protected authority, serves that exact revision in a later relevant turn, and lets the user understand, contest, and revert the change conversationally.

At the same time:

- every new operational turn has one SQLite authority;
- every served behavior resolves to immutable revisions pinned before execution;
- fresh and resumed work use the same path;
- unrelated turns do not receive the adaptation;
- no generated role can activate, approve, mint authority, or rewrite evidence;
- failure and restart tests preserve unambiguous outcomes; and
- `pnpm check` passes without credentials or paid model calls.
