---
name: noesis
description: Understand and deliberately refine Noesis's memory, Capabilities, skills, scripts, workflows, and tool surface.
---

# Working on Noesis itself

Use this skill when the user asks you to improve how you work, preserve a useful ability, inspect what Noesis has learned, or change a lasting behavior. `/refine` invokes this same skill explicitly.

## Choose the smallest lasting form

- Answer normally when nothing should persist.
- Use `remember` for a direct lasting fact, preference, or criterion supplied by the user.
- Save a Script for one reusable computation. Save a Workflow for a durable multi-phase procedure. Verify a newly saved program by running it before depending on it.
- Create or revise a Capability when Noesis should acquire an inspectable, evidence-backed ability that can be selected in future situations. A Capability may contain exact Instruction and Skill materials and may attach exact already-saved project Scripts or Workflows.

Do not create a Capability merely because persistence is possible. `no_change` is a valid deliberate decision.

## Deliberate refinement

The foreground agent is the semantic author. There is no second reflector that rewrites your decision. Protected runtime code supplies the current turn identity and admissible evidence, resolves exact saved-program revisions, validates the complete decision, records immutable materials, performs compare-and-swap binding updates, and preserves gates and restoration.

Work in one coherent `execute` program when practical:

1. Inspect existing Capabilities before creating an overlapping one. Start with the paginated `list`, request `detail` for one binding and lifecycle counts, then page through `revisions`, `feedback`, or `gates` and load an exact bounded `material` slice only when needed.
2. Gather the evidence needed to understand the problem using ordinary tools and session history. Tool calls completed earlier in the same foreground execution, together with the current user message, become authoritative publication evidence.
3. For a Script or Workflow effect, save and verify that project program first. A Capability references the ordinary immutable saved definition; it never embeds a parallel executable form.
4. Ask `noesis.describe("capabilities.refine")` for the exact current input and output schemas. Author one complete decision and call `capabilities.refine` once.
5. Report what was activated, revised, paused, restored, retargeted, left unchanged, or sent to a protected decision gate.

Use `noesis.search("capability inspect refine")` if you need to rediscover the relevant tools. Do not copy a remembered schema from this document: the frozen Tool Catalog is authoritative.

## Authoring standards

- State the future situation in `applicability`, not keywords or a regex.
- Make every effect complete enough to cause the intended behavior. Preserve useful predecessor behavior when revising.
- New portable Capabilities normally remain globally eligible and semantically `relevant`. Narrow to the current project or session only when the behavior truly belongs there. Script and Workflow effects require current-project scope.
- Use `always` only when the behavior should apply to every eligible turn.
- Inspect the binding revision immediately before revising, pausing, restoring, or retargeting. Treat a stale result as a request to re-inspect, not permission to overwrite newer state.
- Describe consequences truthfully. Credential export, recovery or audit control, and irreversible external action without foreground user intent remain protected.
- A published revision affects formally frozen behavior from a later turn; it does not mutate the current turn plan. You may still use a project program saved during the current turn through its ordinary runner.
- Ambient reflection will still observe the settled foreground turn. A deliberate refinement already recorded in the trace should normally make duplicate learning unnecessary.

Subagents may investigate, critique, or draft a proposed decision. They cannot publish Capability changes; the foreground agent must inspect their evidence and make the final call.

All lasting changes remain visible in `/learning`, retain exact evidence and predecessor lineage, and can be paused or restored.
