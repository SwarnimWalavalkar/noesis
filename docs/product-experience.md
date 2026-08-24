# Noesis product experience

## The core loop

Noesis follows one broad loop, but it does not force every session through every step:

1. Understand what the user wants to achieve and how they want to work together.
2. Think together when the problem is unclear. Act directly when the request is clear.
3. Return something useful now, such as an artifact, decision, explanation, sharper question, or program.
4. Settle a durable turn trace with the messages, actions, outcome, and exact revisions involved.
5. Reflect on that trace without interrupting the conversation.
6. Record `no_change`, or create, revise, pause, restore, or retarget one exact Capability.
7. Activate ordinary Capability revisions immediately. A revision may contribute instructions, progressively loaded skills, or an exact saved Program revision.
8. Pause only credential export, recovery or audit control, and irreversible external actions without foreground user intent for an explicit decision.
9. Select globally eligible Capabilities by semantic relevance on later turns, unless the user has made one always active. Keep every reason and exact revision inspectable.

The current interaction must be useful on its own. Development over time is an added benefit, not a cost charged to every conversation.

An explicit project change does not wait for this loop. Noesis may publish and use a project Program in script or workflow mode at once through `execute`. Reflection may later consolidate its lessons into a Capability.

Deliberate self-improvement does not wait for the ambient loop either. While working with the user, the foreground agent can inspect current Capabilities, gather evidence, and author one complete create, revise, pause, restore, or binding-change decision. Protected code supplies the admitted turn and evidence, records exact immutable materials, checks the expected binding, and applies the same gate used by ambient reflection. It does not make a second model call to reinterpret the foreground decision. The resulting revision is eligible from a later frozen turn.

## How Noesis works with the user

Noesis has two default collaboration approaches. It infers them from the conversation. The user does not need to configure a mode.

| Approach     | When to use it                                                        | What Noesis does                                                                                                           |
| ------------ | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Work with me | The task is unclear, exploratory, educational, or calls for judgment. | Surface assumptions, develop the question, preserve uncertainty, offer alternatives, and keep the user's reasoning active. |
| Do for me    | The user asks for a clear outcome within a clear scope.               | Act directly, make reasonable decisions, report important tradeoffs, and return the finished result.                       |

The user's words take priority. Phrases such as "just do it," "think this through with me," or "teach me instead of solving it" should change how Noesis works without a setting or command.

The approach can change during a session. A build can expose something the user needs to learn. Reflection can turn into execution. An open discussion can end with a concrete task. Noesis should preserve why the change happened.

### Session continuity

Long sessions may compact older settled turns into a continuation checkpoint while keeping recent transcript messages raw. Compaction never deletes or rewrites the visible transcript. Resume and search still use the complete original conversation. Only future model context becomes smaller.

The visible user and assistant messages from a failed or aborted turn remain in later context and are labelled as unfinished. They are not queued again or retried automatically. A later request such as "keep going" can therefore refer to the same current-session history the user sees.

If the user submits a prompt while a turn or a session command is still running, Noesis queues it and delivers it in order. Commands that change the session run one at a time, so later prompts always reach the resulting session.

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

New learning is globally eligible and relevant by default. A capable router selects it only for requests that match its recorded applicability.

The reflector or the user may choose project or session scope. The user may also make a Capability always active. Every scope or mode change creates a binding revision instead of rewriting history.

### Quiet, not compulsory

Reflection runs automatically after every settled foreground turn. It should stay quiet and accept `no_change` as a normal result. The user should not have to run learning commands or manage an experiment pipeline.

The user may nevertheless ask Noesis to improve itself explicitly, or invoke `/refine`. Both load the built-in `noesis` skill, which progressively explains how to choose a lasting form, inspect current state, and publish an exact Capability decision. Program authoring guidance lives in the separate `execute` skill. This guidance is not repeated in the default system prompt.

The TUI shows important outcomes as notifications instead of adding them to the transcript. For example:

```text
Capability active · Preserve review-only constraints
Capability updated · Verify research against primary sources
```

Routine reflection does not interrupt the conversation. Credential export, recovery or audit control, and irreversible external actions without foreground user intent require an explicit decision through protected code.

## Self-improvement the user can understand

Improvement may feel effortless, but it should never be hidden.

Each Capability has a history that the user can inspect. A Capability describes an ability, and its exact effects show how that ability is delivered. It connects:

- the observation and exact evidence
- the intended future use and where the change applies
- the old behavior and proposed change
- the exact instruction, skill, saved script, or saved workflow revision involved
- its immediate activation or pending consequence decision
- the exact version frozen into any turn, derivable from that turn plan
- later feedback and successor revisions
- prior revisions that the user can restore.

The main interaction remains conversational. A user can ask, "Why did you work with me instead of doing it?", "What have you learned about this project?", "Why did you use this ability?", or "Undo that change." Commands and detailed views can offer precise inspection, but they are not the only way to use the system.

`/learning` opens an interactive explorer built with the same terminal components as the rest of Noesis. Wide terminals show the activity list and selected record together. Narrow terminals open the selected record as a separate view.

The default filter shows active and recently revised Capabilities, protected decisions, feedback, and failures. Routine `no_change` reflections appear as a bounded summary. Failed reflections remain in an expandable section. Historical experiments remain available for audit, but they do not compete with the current Capability lifecycle.

Each Capability is labelled by its Instruction, Skill, and Program effects. A Program effect also names its script or workflow mode. The detail pane opens the exact material or saved definition behind each effect. It also shows the decision, applicability, binding, revision history, cited evidence, considered inputs, feedback, and related records.

Enter opens the highlighted record. Tab moves among expandable sections inside the record. Escape moves back one level. Evidence sections show readable previews first, then a larger bounded set on demand. The raw view preserves exact IDs for debugging and still redacts sensitive material.

The `/learning` interface renders a read model. It never becomes a second authority for learning state.

Challenging a lesson does not erase history. Noesis records the correction and may narrow or retire the current revision. It keeps the evidence behind the earlier behavior. A revert restores the prior complete version instead of rebuilding it from files that may have changed.

Ambient reflection or the foreground agent may activate an ordinary exact Capability revision immediately. Both use the same publisher, evidence rules, immutable revision format, compare-and-swap binding, and protected consequence gate. The user can inspect its effects, pause it, retarget it, revise it, or restore it from `/learning`.

Subagents may investigate or critique a possible refinement, but they cannot publish it. The foreground agent retains the richer user collaboration context and makes the final semantic decision.

The model creates project Programs in script or workflow mode through `execute`. A Capability that uses a Program points to the same immutable definition revision. It never creates a parallel executable definition.

Credential export, recovery or audit control, and irreversible external actions without foreground intent pause for an explicit approve, deny, or natural-language change decision. Protected code retains ownership of workspace integrity and exact restoration.

## Representative user flows

### A consequential question becomes a build

The user arrives with an important but unclear question about what to build or why a direction matters.

Noesis works with the user. It surfaces assumptions, recalls relevant prior thought, develops criteria, and keeps uncertainty visible. When the user asks for a concrete result, Noesis creates or revises the artifact using those criteria.

The question and decision stay linked to the reasons, alternatives, artifact, and remaining uncertainty. On return, Noesis can reopen the reasoning instead of showing only the last output.

### A build exposes a learning need

During execution, the user encounters a concept they cannot yet explain or apply with confidence. They say that they want to understand it instead of only unblocking the task.

Noesis shifts from doing to working together. It uses the real artifact as study material. It helps the user form and test an explanation, then apply that understanding to the current artifact and task. The difficulty and explanation stay linked to the change and any remaining uncertainty.

A later problem can recall the principle and its concrete example. Contrary evidence can revise it. What remains is something the user can apply again, not an isolated answer.

### Repeated friction becomes a Capability

Across related sessions, the user corrects Noesis about the same behavior more than once. Quiet reflection connects the correction to exact evidence and creates or revises a Capability with a clear future use.

The ordinary revision becomes active immediately and a compact TUI notification makes that visible without adding a transcript message. Later turns use the exact recorded revision when it is relevant. The user can also make it always active.

The user can ask why the Capability changed, inspect the evidence and reasoning, change its scope or selection mode, pause it, give feedback, or restore a prior revision. That feedback can produce another revision immediately.

### The user deliberately teaches Noesis

The user asks Noesis to preserve a method they just developed, or uses `/refine` with a concrete request. Noesis loads its built-in self-knowledge, inspects overlapping Capabilities and exact predecessor material, and gathers relevant evidence during the same foreground execution.

If a lasting ability is justified, the foreground agent authors the complete Capability and exact effects itself. The runtime validates and publishes that decision without a separate reflector pass. If a reusable Program is part of the ability, Noesis first saves and verifies the ordinary project Program in the appropriate mode, then attaches its immutable revision. The final response reports the authoritative publication result. Ambient reflection later observes that recorded action and should normally avoid duplicating it.

### Clear execution remains simple

The user asks for a clear task. Noesis does it and reports important limits. Reflection finds no useful lesson and records no lasting change.

The learning system works best when `no_change` stays out of the way. Not every session needs to create a memory, rule, or Capability.

### Useful execution becomes an inspectable program

The user asks Noesis to investigate a repository, change files, run commands, search the web, or create an artifact. One simple file or shell operation can use a direct tool. Work that requires multiple tool calls or transforms intermediate results normally runs as one coherent JavaScript program through `execute`, rather than one wrapper for each known call. The program plans collection and synthesis together. It checks explicit completeness fields before synthesis: `shell.run` normally saves complete oversized output to an ordinary artifact file and returns its path, so the program inspects that file with bounded reads or ordinary Unix tools instead of rerunning the command. Shell output has a finite artifact limit; reaching it terminates the command and marks the saved evidence incomplete, prompting a narrower or safer rerun. Other required evidence marked `truncated: true` is narrowed or recollected with bounded calls, and omitted output is never treated as proof of absence. Session search already combines lexical and semantic retrieval with reranking, so one precise query normally suffices. It opens its strongest evidence before returning and reports an empty or irrelevant result only as a bounded search that found no relevant evidence instead of searching through paraphrases. The progressively loaded `execute` skill teaches Code Mode and links to its SDK reference; exact tools remain discoverable through the frozen catalog.

The conversation gets the final result. The user can still inspect each tool call and revision.

For analysis that benefits from more history than the foreground prompt should carry, `execute` can inspect the complete pre-turn session as a lazy immutable document. It may give one selected slice to `agents.run`, optionally select a bounded tool set for that subagent, and combine the answer with local code or other tools. A tool-free run is the isolated-model case of the same API. This keeps the ordinary prompt bounded without splitting model queries and agents into separate execution systems.

Every running subagent appears in a bounded surface fixed above the composer, so its status does not scroll away while the parent continues. Once settled, agents leave the ordinary footer instead of becoming stale persistent state. In `Ctrl+O`, selecting an `execute` run or one of its subagents restores that run's settled agents as navigable rows. The main transcript shows only a compact subagent summary and never interleaves the subagent's internal tool calls with the foreground conversation. The arrow keys select subagent rows, Space progressively discloses bounded prompt, result, and child-call summaries, and Enter opens the complete run inspector. Completed subagents remain reachable from their foreground execution instead of disappearing into an opaque background trace.

Session search covers only the current Noesis installation. A development installation with a project-local `.noesis` directory therefore searches its own sessions, not another installation's global history. Trusted local code may still inspect files elsewhere when the task requires it, but that is ordinary filesystem access rather than cross-installation session search.

When a program has a clear use in the project, the user or the agent may save it directly. One reusable computation becomes a typed script. A multi-phase program with durable progress becomes a workflow. A workflow can pause for corrections and resume later.

Skills provide portable instructions. Their compact metadata is visible at turn start; the model loads the selected frozen body through `execute` and `tools.skills.load({ name })`. Skills do not install executable access.

Ambient reflection receives a separate model-visible surface for the settled turn. It can tell that a selected skill began as metadata and whether `skills.load` exposed its body later. Predecessor bytes supplied for authoring do not count as foreground exposure.

Scripts and workflows remain editable files. Once published, they are available through `execute` with the current catalog, Broker, and permissions. Each run records the exact immutable revision it used.

SQLite records the code, nested calls, workflow runs, and phases. After a correction, a workflow can resume from completed phases. Reflection observes the results and may consolidate useful behavior into a globally eligible Capability.
