# Noesis product experience

## The core loop

Noesis follows one broad loop, but it does not force every session through every step:

1. Understand what the user wants to achieve and how they want to work together.
2. Think together when the problem is unclear. Act directly when the request is clear.
3. Produce something useful now, such as an artifact, decision, explanation, sharper question, or experiment.
4. Reflect quietly after every settled foreground turn. Look for corrections, friction, outcomes, and repeated patterns without interrupting the conversation.
5. Return `no_change`, or create, revise, pause, restore, or retarget one exact Capability.
6. Activate ordinary instruction Capability revisions immediately. The agent still creates project tools and workflows directly through `execute`. Pause only the small class of autonomous changes with irreversible consequences for an approve, deny, or change decision.
7. Select globally eligible Capabilities by semantic relevance on later turns, unless the user has made one always active. Keep every reason and exact revision inspectable.

The current interaction must be useful on its own. Development over time is an added benefit, not a cost charged to every conversation.

An explicit project change does not wait for this loop. Noesis may publish and use a project script or workflow at once through `execute`. Reflection may later consolidate its lessons into a Capability.

## How Noesis works with the user

Noesis has two default ways of working. It infers them from the conversation. The user does not need to configure a mode.

| Approach     | When to use it                                                        | What Noesis does                                                                                                           |
| ------------ | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Work with me | The work is unclear, exploratory, educational, or calls for judgment. | Surface assumptions, develop the question, preserve uncertainty, offer alternatives, and keep the user's reasoning active. |
| Do for me    | The user asks for a clear outcome within a clear scope.               | Act directly, make reasonable decisions, report important tradeoffs, and return the finished result.                       |

The user's words take priority. Phrases such as "just do it," "think this through with me," or "teach me instead of solving it" should change how Noesis works without a setting or command.

The approach can change during a session. A build can expose something the user needs to learn. Reflection can turn into execution. An open discussion can end with a concrete task. Noesis should preserve why the change happened.

Long sessions may compact older settled turns into a continuation checkpoint while keeping recent transcript messages raw. Compaction never deletes or rewrites the visible transcript. Resume and search still use the complete original conversation; only future model context becomes smaller.

The visible user and assistant messages from a failed or aborted turn remain in later context and are labelled as unfinished. They are not queued again or retried automatically. A later request such as "keep going" can therefore refer to the same current-session history the user sees.

Prompts submitted while a turn or session-changing command is active are queued and delivered in order. Commands that change the session remain serialized so later prompts always reach the resulting session.

## Selective learning

### A contract for lasting learning

Every proposed lasting lesson must answer:

- What did Noesis observe?
- Which evidence supports it?
- Where should it apply?
- When should it help again?
- What behavior should change then?
- What would make it outdated, wrong, or harmful?

If Noesis cannot answer these questions well, it should make no lasting change.

New learning is globally eligible and relevant by default. Eligibility is not unconditional injection: a capable router selects it only for requests matching its recorded applicability. The reflector or user may instead choose project or session scope, and the user may make a Capability always active. Every scope or mode change is a new recorded binding revision; it does not rewrite history.

### Quiet, not compulsory

Reflection runs automatically after every settled foreground turn. It should stay quiet and accept `no_change` as a normal result. The user should not have to run learning commands or manage an experiment pipeline.

The interface shows important outcomes instead of pinning work in progress into the transcript. For example:

```text
adjusted · preserve review-only constraints in Noesis plans
unapplied · the project strategy did not help
```

Routine background work does not interrupt the conversation. A request for more access, credential use, or a broader effect is different. It requires clear user approval through protected code.

## Self-improvement the user can understand

Improvement may feel effortless, but it should never be hidden.

Each Capability has a history that the user can inspect. It connects:

- the observation and exact evidence
- the intended future use and where the change applies
- the old behavior and proposed change
- the prompt, skill, tool, router, or permission revision involved
- its immediate activation or pending consequence decision
- the exact version frozen into any turn, derivable from that turn plan
- later feedback and successor revisions
- prior revisions that the user can restore.

The main interaction remains conversational. A user can ask, "Why did you work with me instead of doing it?", "What have you learned about this project?", "Why did you use this ability?", or "Undo that change." Commands and detailed views can offer precise inspection, but they are not the only way to use the system.

`/learning` opens an interactive explorer built with the same terminal primitives as the rest of Noesis. Its default view highlights lasting changes, experiments, protected decisions, feedback, and failures. Activity is grouped by type. Failed reflections stay in a quiet expandable section so they do not crowd lasting changes. Routine `no_change` reflections appear as a bounded recent summary instead of flooding the timeline; durable job history remains authoritative for deeper diagnostics. Wide terminals show activity and decision detail together, while narrow terminals use a focused drill-down. Enter opens the highlighted record, or a related record only once Tab has moved focus there. Tab cycles expandable sections inside the open record — evidence cited, inputs considered, and related records — and wraps to the first of those sections. Escape leaves the record, one level back. Evidence cited and inputs considered show a few readable previews by default; Enter expands a larger bounded set, and the remainder stays in the raw audit view. Each record keeps its exact identity, readable bounded evidence, typed relationships, and a sensitivity-aware raw projection. The interface is a read model; it does not become another authority for learning state.

Challenging a lesson does not erase history. Noesis records the correction and may narrow or retire the current revision. It keeps the evidence behind the earlier behavior. A revert restores the prior complete version instead of rebuilding it from files that may have changed.

Generated reflection may activate an ordinary exact instruction Capability revision immediately. The user can inspect, pause, retarget, revise, or restore it from `/learning`. Project tool and workflow authoring remains available to the model through the direct `execute` path. Recovery or boot control, credential export, and irreversible external actions without foreground intent pause for an explicit approve, deny, or natural-language change decision. Workspace integrity and exact restoration remain protected code.

## Representative user flows

### A consequential question becomes a build

The user arrives with an important but unclear question about what to build or why a direction matters.

Noesis works with the user. It surfaces assumptions, recalls relevant prior thought, develops criteria, and keeps uncertainty visible. When the user asks for a concrete result, Noesis creates or revises the artifact using those criteria.

The question and decision stay linked to the reasons, alternatives, artifact, and remaining uncertainty. On return, Noesis can reopen the reasoning instead of showing only the last output.

### A build exposes a learning need

During execution, the user encounters a concept they cannot yet explain or apply with confidence. They say that they want to understand it instead of only unblocking the task.

Noesis shifts from doing to working together. It uses the real artifact as study material. It helps the user form and test an explanation, then apply that understanding to the work. The difficulty and explanation stay linked to the change and any remaining uncertainty.

A later problem can recall the principle and its concrete example. Contrary evidence can revise it. What remains is something the user can apply again, not an isolated answer.

### Repeated friction becomes a Capability

Across related work, Noesis receives a correction. Quiet reflection connects it to exact evidence and creates or revises a Capability with a clear future use.

The ordinary revision becomes active immediately and a compact TUI notification makes that visible without adding a transcript message. Later turns use the exact recorded revision when it is relevant. The user can also make it always active.

The user can ask why the Capability changed, inspect the evidence and reasoning, change its scope or selection mode, pause it, give feedback, or restore a prior revision. That feedback can produce another revision immediately.

### Clear execution remains simple

The user asks for a clear task. Noesis does it and reports important limits. Reflection finds no useful lesson and records no lasting change.

It is useful when the learning system stays out of sight. Not every session needs to become a memory, rule, or experiment.

### Useful execution becomes an inspectable program

The user asks Noesis to investigate a repository, change files, run commands, search the web, or create an artifact. Noesis uses a small set of direct tools for common work. It uses `execute` to discover and combine more tools with JavaScript. The conversation gets the final result, while the user can still inspect tool calls and revisions.

When a program has a clear use in the project, the user or agent may save it directly. One reusable computation becomes a typed script. Work with named phases and durable progress becomes a workflow. A workflow can also pause for corrections and resume later. Skills provide portable instructions, but they do not install executable access on their own.

Scripts and workflows remain ordinary editable files. Once published, they are available through `execute` with the current catalog, Broker, and permissions. Each run records the exact immutable revision it used. SQLite records the code, nested calls, workflow runs, and phases. After a correction, a workflow can resume from completed work instead of repeating it. Reflection observes the results and may consolidate useful behavior into a globally eligible Capability.
