---
name: noesis
description: Inspect and deliberately refine Noesis's lasting Capabilities, skills, and harness. Use for self-improvement, learned behavior, feedback, scope, activation, or restoration.
---

# Working on Noesis itself

## Choose the smallest lasting form

- Answer normally when nothing should persist.
- Save a Program in `script` mode for one reusable computation or `workflow` mode for a durable multi-phase procedure. Verify a newly saved Program by running its exact revision before depending on it.
- Create or revise a Capability when a lasting fact, preference, criterion, or ability should change Noesis's behavior in future situations. A Capability may contain exact Instruction and Skill materials and may attach an exact already-saved Program revision.

Persist only when future behavior should change. `no_change` is a valid deliberate decision.

## Deliberate refinement

The foreground agent authors the complete semantic decision. Protected runtime code supplies the current turn identity and admissible evidence, resolves exact saved-program revisions, validates the decision, records immutable materials, performs compare-and-swap binding updates, and preserves gates and restoration.

Work in one coherent `execute` program when practical:

1. Use `capabilities.inspect` as the single learning inspector before creating an overlapping Capability. Start with the paginated `list`, request `detail` for one binding and lifecycle counts, then page through `revisions`, `feedback`, or `gates` and load an exact bounded `material` slice only when needed.
2. Gather the evidence needed to understand the problem using ordinary tools and session history. Tool calls completed earlier in the same foreground execution, together with the current user message, become authoritative publication evidence.
3. For a Program effect, load the `execute` skill, save and verify the Program, and then attach that immutable saved definition.
4. Ask `noesis.describe("capabilities.refine")` for the exact current input and output schemas. Author one complete decision and call `capabilities.refine` once.
5. Report what was activated, revised, paused, restored, retargeted, left unchanged, or sent to a protected decision gate.

Use `noesis.search("capability inspect refine")` to rediscover the relevant tools and `noesis.describe` to load their current schemas.

## Authoring standards

- State the future situation in `applicability`, not keywords or a regex.
- Make every effect complete enough to cause the intended behavior. Preserve useful predecessor behavior when revising.
- New portable Capabilities normally remain globally eligible and semantically `relevant`. Narrow to the current project or session only when the behavior truly belongs there. Program effects require current-project scope.
- Use `always` only when the behavior should apply to every eligible turn.
- Inspect the binding revision immediately before revising, pausing, restoring, or retargeting. Treat a stale result as a request to re-inspect, not permission to overwrite newer state.
- Describe consequences truthfully. Credential export, recovery or audit control, and irreversible external action without foreground user intent remain protected.
- A published revision affects formally frozen behavior from a later turn; it does not mutate the current turn plan. You may still use a project program saved during the current turn through its ordinary runner.
- Ambient reflection will still observe the settled foreground turn. A deliberate refinement already recorded in the trace should normally make duplicate learning unnecessary.

Use subagents to investigate, critique, or draft a proposed decision. The foreground agent inspects their evidence and publishes the final decision.

All lasting changes remain visible in `/learning`, retain exact evidence and predecessor lineage, and can be paused or restored.
