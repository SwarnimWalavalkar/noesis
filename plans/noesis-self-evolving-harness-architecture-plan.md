# Noesis project-level self-evaluation loop

Status: implemented. This file is the historical design record for the project working adjustment loop.

This is the smallest useful next step toward a self-evolving harness. It adds a fast project-local branch to the learning loop Noesis already has.

This plan governs ambient strategy learning only. Explicit foreground work may publish and immediately use a project-local Program in script or workflow mode through the existing execution authority. Reflection observes those runs; the experiment path is required only for broader learned or global consolidation.

## Decision

After a completed turn, the existing reflector may make one temporary adjustment for the active project. For now, the project is the canonical active directory.

The adjustment is immediately visible, affects later work in that directory across sessions, and is evaluated by the same reflection loop that created it.

```text
work in project
  → existing reflection
  → no change | working adjustment | durable experiment
  → later work in the same project
  → existing reflection evaluates the result
```

There is no separate fast-learning system. A working adjustment is an intermediate outcome between `no_change` and the existing experiment → candidate → preflight → activation path.

## Project identity

The host derives project identity; the model never chooses it.

```ts
interface ProjectRef {
  readonly projectId: string;
  readonly root: string;
}
```

At startup, Noesis resolves the active directory to its canonical absolute path. `projectId` is a stable digest of that path. The same directory maps to the same project across sessions; another directory is another project.

`ProjectRef` is pinned into the frozen turn plan and the completed-turn learning input. Symlink normalization and path identity happen once at the host seam.

This is intentionally not a general project-detection system. There are no repository heuristics, workspace manifests, project graphs, or user-managed project objects.

## One new product abstraction

`WorkingAdjustment` is a bounded live hypothesis about how Noesis should behave before that change has earned durable status.

The abstraction is generic around its lifecycle, evidence, and evaluation. Within this ambient reflection branch, the only supported scope is `ProjectRef`, and the only supported change is a temporary strategy. Do not add a generic scope union or change-kind registry until a second real use requires one.

```ts
interface WorkingAdjustment {
  readonly adjustmentId: string;
  readonly scope: ProjectRef;
  readonly observation: string;
  readonly strategy: string;
  readonly successSignal: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly createdFromTurnId: string;
}
```

`adjustmentId` identifies the exact immutable adjustment. Revising an adjustment creates a new adjustment with a new ID. No separate revision abstraction is needed.

Only one adjustment may be active for a project. Applying a new one atomically replaces the active adjustment. This keeps prompt cost bounded and preserves attribution.

Every transition is stale-safe. The frozen turn and reflection job carry the `expectedActiveAdjustmentId` that the reflector evaluated. Apply, replace, and unapply compare that ID with the current project binding in one SQLite transaction. If the binding has changed, the old reflection becomes an inspectable stale no-op rather than mutating newer state.

A new `adjustmentId` is derived deterministically from the reflection job and its canonical decision. Retrying the same decision therefore reuses the same immutable row. If that exact adjustment is already active, the retry succeeds idempotently; it never creates another adjustment or replaces newer state.

Its lifecycle is:

```text
proposed by reflection
  → applied to this project
  → served by later project turns
  → left applied | replaced | unapplied | used as evidence for an experiment
```

Working adjustments are short-term operational state, not editable durable definitions. SQLite stores each immutable adjustment by `adjustmentId` and the active project binding. The target project directory is not modified.

There is no separate authoritative served-turn table. The admitted frozen turn plan records which adjustment was selected, and foreground-turn settlement records whether that turn executed and its outcome. The exact served evidence is derived from those two authoritative records. A rebuildable lookup projection may index that relationship if querying the JSON plan becomes expensive.

## Extend the existing reflector

Do not add another model role, scheduler, coordinator, or self-evaluation module.

Extend the existing reflector decision from:

```text
no_change | experiment
```

to:

```text
no_change | apply_working_adjustment | unapply_working_adjustment | experiment
```

The new branches are narrow:

```ts
type WorkingAdjustmentDecision =
  | {
      readonly decision: "apply_working_adjustment";
      readonly expectedActiveAdjustmentId: string | null;
      readonly rationale: string;
      readonly strategy: string;
      readonly successSignal: string;
      readonly evidenceCitationIndexes: readonly number[];
    }
  | {
      readonly decision: "unapply_working_adjustment";
      readonly expectedActiveAdjustmentId: string;
      readonly reason: string;
      readonly evidenceCitationIndexes: readonly number[];
    };
```

These branches retain the reflector's existing structured semantic `observation`; `rationale` explains the proposed adjustment without overloading that field.

The current `experiment` decision remains behaviorally unchanged. It still requires anticipated future use, scope reasoning, source cases, candidate authorship, preflight, and protected activation. The durable `Experiment` record and protected activation binding gain only an optional immutable `sourceAdjustmentId`. No new adjustment-revision reference is introduced.

The reflector receives the active working adjustment, the current outcome, and a bounded recent selection of exact settled turns in which the adjustment was served. Older evidence remains queryable through `WorkspaceStore`; it is not injected without bound. This lets the model judge whether to leave the adjustment applied, replace it, unapply it, or use the accumulated evidence to propose a durable experiment.

The model may interpret whether the adjustment helped. Code only validates citations, project identity, adjustment identity, bounds, deterministic identity, and lifecycle transitions, then performs the expected-binding compare-and-swap. The learning organ returns the semantic decision; coordinator and store code own its operational effect.

## How the adjustment affects work

Turn preparation loads the active adjustment for the pinned `ProjectRef` and records its exact `adjustmentId` in the frozen turn plan. Admission verifies that the project binding still matches that snapshot; if it changed while the plan was assembled, planning retries instead of serving stale strategy.

It enters context as bounded strategy data inside a stable protected envelope. The envelope identifies the adjustment, delimits its free-form content, and says that it is a tentative project-local hypothesis: use it only when compatible with the current request and higher-priority instructions. The strategy cannot escape that envelope or create authority merely by containing imperative text.

It is not part of the user constitution, learned profile, skill library, capability set, or permission snapshot. The current user request and all protected instructions remain authoritative. The focused instruction-hierarchy doctrine must be updated to acknowledge this protected temporary-strategy envelope instead of silently treating model-authored text as an activated capability instruction.

A working adjustment cannot:

- affect another active directory;
- add or remove tools;
- change permissions, credentials, models, or budgets;
- write files or execute code;
- activate or promote a capability.

It changes strategy, not authority.

## One feedback loop, two speeds

The same `runtime.reflect_turn` job now has three useful outcomes:

1. `no_change` when the evidence supports no adaptation.
2. A working adjustment when one observation supports a cheap, reversible local hypothesis.
3. An experiment when the evidence supports the existing slower evaluation path.

After a working adjustment is admitted and the foreground turn actually settles, the next reflection receives its exact `adjustmentId` together with the bounded outcome evidence. Admission without execution does not count as serving. If the adjustment repeatedly helps, the reflector may choose the existing `experiment` branch. The resulting experiment records `sourceAdjustmentId` and cites the working adjustment and served-turn evidence; it does not silently promote the adjustment.

Opening an experiment does not unapply the working adjustment. It remains useful while the slow path evaluates the hypothesis. If the resulting durable candidate activates, the existing protected activation commit transaction conditionally clears the project binding only when it still points to `sourceAdjustmentId`. A newer replacement remains active. Candidate authorship and preflight remain unchanged.

If the adjustment is wrong, the reflector unapplies or replaces it. The user can override it through ordinary conversation at any time.

Existing durable capability observation, outcome judging, revision, and rollback remain unchanged. This plan only supplies earlier project-local evidence to that loop.

## Immediate visibility

Reuse the existing learning job and TUI read model.

```text
adjusted · noesis project · verify observable state before claiming success
```

Later, when evidence argues against it:

```text
unapplied · evidence suggests the working adjustment did not help
```

Leaving an adjustment applied is the ordinary `no_change` outcome, not a recurring TUI notification. Its current state and evidence remain inspectable on demand.

In-progress reflection stays out of the transcript. The TUI watches the exact job quietly and surfaces only a material adjustment outcome or diagnostic.

The assistant's useful answer remains visible first. Turn settlement surfaces the exact reflection `jobId`, and the composition root retains the latest such ID per project for the running process. Add a bounded `waitForTerminal(jobId, deadline)` operation to the existing coordinator. Before freezing another turn in that project, the runtime observes only that exact durable job until it reaches a terminal state or its deadline. It must not await the coordinator's general drain, candidate authorship, preflight, activation, or outcome judging.

A timeout allows the next turn to proceed; a late adjustment begins with a following turn in the same project. After process restart there is no ephemeral barrier pointer to recover, so planning proceeds normally. Durable job recovery and the expected-binding compare-and-swap still prevent a late or retried reflection from corrupting newer project state.

## Existing architecture reused

- `runtime.reflect_turn` remains the only post-turn semantic decision job.
- The existing reflector and Pi inference adapter produce the decision.
- The existing coordinator owns execution, budget, cancellation, retry, and recovery.
- Immutable SQLite rows record exact adjustment content and provenance.
- `WorkspaceStore` owns the active project binding; frozen plans plus foreground settlement own exact serving evidence.
- The frozen turn plan pins project identity and `adjustmentId`.
- The existing learning-status read model and TUI render the visible result.
- The existing experiment, candidate, preflight, activation, continuous-feedback, and rollback path remains the only durable-learning path.

No new package or top-level module is needed.

## Implemented slice

1. Add host-derived `ProjectRef` to turn planning, the frozen turn plan, settlement, and learning input.
2. Add immutable working-adjustment rows plus one SQLite-owned active binding per project.
3. Extend the reflector output with stale-safe `apply_working_adjustment` and `unapply_working_adjustment` decisions while retaining its existing semantic observation.
4. Handle those results inside the existing reflection job using deterministic IDs and an expected-binding SQLite compare-and-swap, without enqueueing author or preflight work.
5. Surface the exact reflection job ID from settlement, add bounded `waitForTerminal`, and use it before the next turn in that project freezes.
6. Inject and pin the active `adjustmentId` only for matching-project turns, verifying the binding again at admission.
7. Derive served evidence from the admitted frozen plan and settled foreground turn, and include only a bounded recent selection in subsequent reflections.
8. Add optional immutable `sourceAdjustmentId` to the experiment and protected activation binding; conditionally unapply it inside the existing activation commit transaction.
9. Extend the existing learning read model and TUI status lines for apply, replace, stale no-op, and unapply while keeping ordinary `no_change` quiet.
10. Update the focused instruction-hierarchy doctrine for the protected temporary-strategy envelope.
11. Add one credential-free cross-session, two-project acceptance journey and focused failure tests.

Run `pnpm check`, then dogfood this loop before adding another adaptation surface.

## What we are choosing not to build

- A session adjustment or per-conversation adaptation store.
- A separate self-review role, module, job kind, scheduler, or coordinator.
- General project detection or project-management UI.
- More than one active adjustment per project.
- Automatic expiry or a fixed turn-count lifetime for an adjustment.
- Ambient reflection silently creating executable project Programs or changing the fixed provider-facing tool set. Explicit foreground publication uses the Program path.
- Parallel model workers or a sub-agent system.
- Prompt, memory, skill, workflow, router, or capability CRUD in the ambient working-adjustment branch.
- Direct promotion from a working adjustment to active durable behavior.
- New pull-rate, opportunity-classification, or compounding dashboards.
- Model-weight training.

These exclusions keep the ambient working-adjustment branch narrow.

## Definition of done

One credential-free acceptance journey proves:

1. Turn A in directory P completes normally and the existing reflection job applies one cited working adjustment.
2. The TUI immediately shows what changed and why.
3. Turn B starts in a new session but the same directory P, pins the exact `adjustmentId`, verifies the active binding at admission, and receives it in bounded context.
4. Turn B settlement plus its admitted frozen plan establish that the adjustment was served, and its reflection can leave it applied, replace it, unapply it, or choose the existing experiment branch.
5. A turn in directory Q never receives P's adjustment.
6. Replacing or unapplying an adjustment preserves its immutable row and evidence.
7. No adjustment can change tools, permissions, durable activation, or another project's state.
8. An adjustment remains applied until the reflector or user unapplies or replaces it, or a derived durable candidate activates.
9. Opening an experiment does not remove the active adjustment; successful durable activation conditionally removes only its exact source adjustment in the same commit transaction.
10. `no_change`, malformed output, timeout, cancellation, restart, retry, stale decisions, and concurrent reflection fail safely without creating multiple active adjustments or overwriting newer state.
11. A seeded durable-learning decision still follows the existing experiment → author → preflight → activation path unchanged.
12. `pnpm check` passes without credentials, network access, or paid model calls.
