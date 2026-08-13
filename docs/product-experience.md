# Noesis product experience

## The core loop

Noesis follows one broad loop, but it does not force every session through every step:

1. Understand what the user wants to achieve and how they want to work together.
2. Think together when the problem is unclear. Act directly when the request is clear.
3. Produce something useful now, such as an artifact, decision, explanation, sharper question, or experiment.
4. Reflect quietly after the work. Look for corrections, friction, outcomes, and repeated patterns without interrupting the conversation.
5. Keep a lesson only when it has a credible future use. Give it the narrowest reach supported by the evidence.
6. Test broader behavior changes. Protected code decides whether they may become active.
7. Bring relevant context or active changes into later work. Keep the reason for their presence available for inspection.

The current interaction must be useful on its own. Development over time is an added benefit, not a cost charged to every conversation.

An explicit project change does not wait for this loop. Noesis may publish and use a project script or workflow at once through `execute`. Reflection and evaluation apply only when it considers a broader learned change.

## How Noesis works with the user

Noesis has two default ways of working. It infers them from the conversation. The user does not need to configure a mode.

| Approach | When to use it | What Noesis does |
| --- | --- | --- |
| Work with me | The work is unclear, exploratory, educational, or calls for judgment. | Surface assumptions, develop the question, preserve uncertainty, offer alternatives, and keep the user's reasoning active. |
| Do for me | The user asks for a clear outcome within a clear scope. | Act directly, make reasonable decisions, report important tradeoffs, and return the finished result. |

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

New learning stays narrow by default. A correction about one repository, project, relationship, workflow, or kind of task must not become a universal preference. Its reach may grow when repeated evidence shows that it helps in different settings. That expansion is a new recorded decision. It does not rewrite history.

### Quiet, not compulsory

Reflection and evaluation run automatically when there is useful evidence. They should stay quiet and accept `no change` as a normal result. The user should not have to run learning commands or manage an experiment pipeline.

The interface shows important outcomes instead of pinning work in progress into the transcript. For example:

```text
adjusted · preserve review-only constraints in Noesis plans
unapplied · the project strategy did not help
```

Routine background work does not interrupt the conversation. A request for more access, credential use, or a broader effect is different. It requires clear user approval through protected code.

## Self-improvement the user can understand

Improvement may feel effortless, but it should never be hidden.

Each lasting change has a history that the user can inspect. It connects:

- the observation and exact evidence
- the intended future use and where the change applies
- the old behavior and proposed change
- the prompt, skill, tool, router, or permission revision involved
- the evaluation and protected decision
- the version used for each turn
- later feedback and the experiment outcome
- prior revisions that the user can restore.

The main interaction remains conversational. A user can ask, "Why did you work with me instead of doing it?", "What have you learned about this project?", "Why did you use this ability?", or "Undo that change." Commands and detailed views can offer precise inspection, but they are not the only way to use the system.

`/learning` opens an interactive audit ledger built with the same terminal primitives as the rest of Noesis. It exposes memories, reflections including `no_change`, working adjustments, experiments, immutable revisions, evaluation, activation, feedback, outcomes, lineage, and background jobs. Each record keeps its exact identity, evidence, typed relationships, and a bounded sensitivity-aware raw projection. The interface is a read model; it does not become another authority for learning state.

Challenging a lesson does not erase history. Noesis records the correction and may narrow or retire the current revision. It keeps the evidence behind the earlier behavior. A revert restores the prior complete version instead of rebuilding it from files that may have changed.

Generated reflection cannot approve a broader change. Generated code may publish a project script or workflow with its current permissions. Evaluation, permissions, workspace integrity, activation, and rollback remain in protected code.

## Representative user flows

### A consequential question becomes a build

The user arrives with an important but unclear question about what to build or why a direction matters.

Noesis works with the user. It surfaces assumptions, recalls relevant prior thought, develops criteria, and keeps uncertainty visible. When the user asks for a concrete result, Noesis creates or revises the artifact using those criteria.

The question and decision stay linked to the reasons, alternatives, artifact, and remaining uncertainty. On return, Noesis can reopen the reasoning instead of showing only the last output.

### A build exposes a learning need

During execution, the user encounters a concept they cannot yet explain or apply with confidence. They say that they want to understand it instead of only unblocking the task.

Noesis shifts from doing to working together. It uses the real artifact as study material. It helps the user form and test an explanation, then apply that understanding to the work. The difficulty and explanation stay linked to the change and any remaining uncertainty.

A later problem can recall the principle and its concrete example. Contrary evidence can revise it. What remains is something the user can apply again, not an isolated answer.

### Repeated friction becomes an experiment

Across related work, Noesis receives the same kind of correction more than once. Quiet reflection notices the pattern and proposes a narrow change with a clear future use.

Noesis tests the change against the prior behavior. Protected code may activate a passing low-risk revision without turning the conversation into an approval flow. A short notice explains what changed. Later turns use the exact recorded revision when it is relevant.

The user can ask why the change happened, inspect the evidence, challenge where it applies, keep it, or reverse it. Even a rejected or reversed change provides useful evidence.

### Clear execution remains simple

The user asks for a clear task. Noesis does it and reports important limits. Reflection finds no useful lesson and records no lasting change.

It is useful when the learning system stays out of sight. Not every session needs to become a memory, rule, or experiment.

### Useful execution becomes an inspectable program

The user asks Noesis to investigate a repository, change files, run commands, search the web, or create an artifact. Noesis uses a small set of direct tools for common work. It uses `execute` to discover and combine more tools with JavaScript. The conversation gets the final result, while the user can still inspect tool calls and revisions.

When a program has a clear use in the project, the user or agent may save it directly. One reusable computation becomes a typed script. Work with named phases and durable progress becomes a workflow. A workflow can also pause for corrections and resume later. Skills provide portable instructions, but they do not install executable access on their own.

Scripts and workflows remain ordinary editable files. Once published, they are available through `execute` with the current catalog, Broker, and permissions. Each run records the exact immutable revision it used. SQLite records the code, nested calls, workflow runs, and phases. After a correction, a workflow can resume from completed work instead of repeating it. Reflection observes the results. Only broader learned or global changes require protected evaluation and activation.
