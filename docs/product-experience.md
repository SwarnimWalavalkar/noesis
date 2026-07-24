# Noesis product experience

## The core loop

A coherent Noesis experience follows one recurring shape without forcing every session through every step:

1. **Understand intent.** Interpret what the user is trying to accomplish and how they want to collaborate.
2. **Work in the right posture.** Explore and think together when the problem is ambiguous; execute directly when the request is explicit.
3. **Produce present value.** Create an artifact, understanding, decision, sharper question, or useful experiment.
4. **Reflect ambiently.** After the useful work, inspect corrections, friction, outcomes, and recurrence without interrupting the conversation.
5. **Compound selectively.** Preserve nothing when there is no credible future advantage. Otherwise propose the narrowest evidence-linked learning with an anticipated future use.
6. **Evaluate and adapt.** Test behavioral changes against the behavior they intend to improve. Protected code decides whether a candidate may activate.
7. **Return with continuity.** A later relevant turn retrieves the selected prior context or active adaptation, and the exact reason for its presence remains inspectable.

The loop is successful only when the present interaction is useful on its own. Compounding is an additional advantage, not a tax charged to every conversation.

## Collaboration posture

Noesis has two default postures. They are inferred behaviors, not mandatory modes that the user must configure.

| Posture | Default trigger | Noesis behavior |
| --- | --- | --- |
| Work with me | Ambiguous intellectual work, exploration, learning, reflection, framing, or consequential judgment. | Surface assumptions, develop the question, preserve uncertainty, offer alternatives, and keep the user’s reasoning active. |
| Do for me | Explicit execution with a sufficiently clear outcome and scope. | Act directly, make reasonable implementation decisions, report material tradeoffs, and return the finished result. |

Conversational overrides are authoritative. “Just do it,” “think this through with me,” “teach me rather than solving it,” or a correction during the interaction should change the posture without requiring a settings screen or mode command.

The posture is allowed to change within a session. A build can expose a study need; reflection can become execution; an exploratory discussion can end with a concrete implementation request. Noesis should preserve why the transition happened.

## Selective compounding

### A durable learning contract

Every proposed durable learning must answer:

- What did Noesis observe?
- Which evidence supports the observation?
- What is the narrowest plausible scope?
- In what anticipated future situation should this help?
- What behavior should change in that situation?
- What would make the learning stale, contradicted, or harmful?

If these questions cannot be answered credibly, the correct outcome is no durable change.

New learning stays narrow by default. A correction about one repository, project, relationship, workflow, or kind of task must not silently become a universal preference. Scope may broaden when recurring evidence shows the same behavior is useful across distinct contexts. Broadening is a new attributable decision, not a mutation of history.

### Ambient, not compulsory

Reflection and evaluation run automatically after suitable evidence appears. They should be low-noise and should accept `no change` as a normal result. The user should not have to issue learning commands or operate an experiment pipeline.

The interface may show quiet activity such as:

```text
learning · noticed a correction in Noesis planning
learning · comparing a narrower planning adaptation
learned  · preserve review-only constraints in Noesis plans
```

Routine ambient work does not interrupt the conversation. Authority expansion, credential use, or a broader effect is different: it requires explicit user authority through the protected control plane.

## Legible self-improvement

Adaptation should feel magical but never mysterious.

Each durable adaptation has an inspectable history that connects:

- the observation and exact evidence;
- the anticipated future use and scope;
- the baseline behavior and candidate change;
- the prompt, skill, tool, router, and permission revisions involved;
- the evaluation evidence and protected decision;
- the activation that served each turn;
- later feedback and experiment outcome; and
- prior revisions available for contest or revert.

The primary interaction remains conversational. A user can ask “Why did you approach this as a collaboration?”, “What have you learned about this project?”, “Why was this capability used?”, or “Undo that change.” Expert commands and views may provide precise inspection, but they are shortcuts into the same product model rather than the only way to use it.

Contesting a learning does not erase history. It records a correction, narrows or retires the current revision, and preserves the evidence behind earlier behavior. Revert restores the prior complete activation rather than reconstructing it from mutable files.

Generated reflection and candidate authorship never receive promotion authority. Protected evaluation, permission, workspace-integrity, activation, and rollback code remains outside generated or self-modifiable content.

## Representative user flows

### A consequential question becomes a build

The user arrives with an important but underspecified question about what should be built or why a direction matters.

Noesis defaults to working with the user. It surfaces assumptions, relates selected prior thought, develops criteria, and keeps unresolved uncertainty visible. When the user asks to make the result concrete, Noesis moves into execution and creates or revises the artifact using those criteria.

The question, alternatives, criteria, decision, artifact, and uncertainty remain linked. On return, Noesis can reopen the work from its reasoning rather than only from its last output.

### A build exposes a learning need

During execution, the user encounters a concept they cannot yet justify or apply confidently. They say, conversationally, that they want to understand it rather than merely unblock the task.

Noesis shifts from doing to working together. It uses the real artifact as the study context, helps the user form and test an explanation, and then applies that understanding back to the work. The difficulty, explanation, remaining uncertainty, and applied change remain connected.

A later related problem can retrieve the principle and its concrete example. Contrary evidence can revise it. The retained object is reusable capability, not an isolated answer.

### Repeated friction becomes a self-improvement experiment

Across related work, Noesis receives corrections about a recurring behavior. Ambient reflection detects the recurrence and proposes a narrow adaptation with a stated future use.

The candidate is evaluated against the prior behavior. A low-risk passing revision activates through the protected control plane without turning the conversation into an approval workflow. A quiet notification explains what improved. Later relevant turns pin and use the exact revision.

The user can ask why the change happened, inspect the evidence and comparison, contest its scope, pin it, or revert it. A retained change provides a traceable advantage; a revised or reverted change still contributes negative evidence.

### Clear execution remains simple

The user asks for a bounded, explicit task. Noesis defaults to doing it, produces the result, and reports material limitations. Ambient reflection finds no credible reusable learning and records no durable change.

The absence of compounding machinery in the visible experience is a feature: not every useful session needs to become memory, policy, or an experiment.
