# Noesis Programs and fixed tool surface

This plan supersedes the tool-hotbar and separate public Script/Workflow portions of `noesis-tools-codemode-workflows-plan.html`. The capability lifecycle and protected-boundary portions of the earlier plans remain applicable.

## Product contract

Pi's provider-facing tool set is fixed for every foreground turn:

- `file_read`, backed by `files.read`
- `file_write`, backed by `files.write`
- `shell`, backed by `shell.run`
- `execute`, backed by codemode

The set is not user-configurable and does not change when Noesis learns or saves executable behavior. Every direct tool is an adapter over the turn's frozen Tool Catalog and canonical Broker. Every other built-in, MCP, Capability, and Program operation is available inside `execute` and is discovered progressively through `noesis.search` and `noesis.describe`.

The direct `execute` descriptor stays small and points to a progressively loaded, turn-frozen built-in `execute` skill. That skill teaches Code Mode composition, the injected SDK, and Program authoring. Exact tool call shapes remain in the frozen Tool Catalog.

## Programs

Program is the one public reusable-execution primitive. Its `mode` selects one of two deliberately distinct runtimes:

- `script` is bounded rerunnable JavaScript with typed JSON input and output.
- `workflow` is a durable phased procedure with pause, correction, resume, and per-phase state.

The public codemode API is `programs.list`, `programs.describe`, `programs.save`, `programs.run`, `programs.runs`, and `programs.resume`. Saving returns an immutable definition revision. Running requires that exact revision ID. Program definitions live under `programs/projects/<project-id>/<mode>/<name>/`; ordinary editable files remain declarative authority, recorded revisions are execution authority, and SQLite remains operational run authority.

Workflow manifests do not yet declare exact saved-Program dependencies. Until they do, a paused workflow conservatively pins the complete visible Program library and fails closed after any library edit, as specified by the retained workflow plan. This is an explicit safety limitation rather than silent dependency drift.

A Program owns only executable mechanics: mode, schemas, required tools or phases, implementation source, immutable revisions, and run records. It does not independently own semantic applicability, scope, or activation.

## Capability exposure

A Capability may attach one exact Program revision with a single `program` effect containing its mode, name, project, and definition revision. The Capability owns the semantic contract: name, description, applicability, scope, activation, evidence, feedback, and restoration.

Selecting that Capability contributes a typed adapter for the pinned Program revision to the same frozen Tool Catalog and Broker used by codemode. The descriptor carries two orthogonal provenance fields:

- implementation: built-in, MCP, or Program, including the Program's mode, project, name, and exact revision;
- exposure: catalog or Capability, including the exact Capability revision when applicable.

This lets the model recognize that a discovered tool is editable Program behavior without confusing implementation with applicability. Saving a Program alone does not mutate the provider tool list or implicitly activate a new semantic tool.

## Self-improvement

The built-in `noesis` skill, with `/refine` as an alias, progressively teaches deliberate self-improvement. A coherent foreground improvement may inspect existing Capabilities, use the separate `execute` skill to save and verify a Program, and publish one complete Capability decision. Ambient reflection uses the same protected Capability publisher. Subagents may advise but may not publish.

## Acceptance

- Every ordinary turn exposes exactly the fixed four provider tools.
- Catalog creation and Program saving cannot change that provider-facing set.
- Both Program modes save, inspect, and run by exact immutable revision.
- Workflow-mode runs pause and resume durably.
- A Capability-backed Program tool exposes semantic applicability and structured implementation/exposure provenance.
- `noesis.search` and `noesis.describe` return that provenance without expanding the base prompt.
- Program execution, including from subagents, retains canonical Broker lineage and authority; descendant `agents.run` still fails closed.
- The TUI lists and inspects both modes through `/programs` and `/program <mode> <name>`.
