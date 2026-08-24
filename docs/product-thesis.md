# Noesis product thesis

## Product goal

Noesis is a personal agent that develops with its user. It learns from their sessions, the artifacts they create, and the feedback they exchange. The user gains knowledge, methods, and programs that make harder projects possible.

## The problem

Most agents either carry out isolated requests or offer a fixed form of personalization. The user must repeat context and rebuild useful methods between sessions. An agent may remember facts without learning a better way to help. It may improve its own performance without helping the user grow.

This creates several problems:

- The user remains responsible for carrying context and methods forward.
- Memory can preserve information without creating a useful new ability.
- Automation can complete a task without improving the user's understanding or judgment.
- Self-improvement can change the agent without helping either side develop.

Noesis asks whether a person and an agent can build a relationship that changes what each can do. The agent learns new ways to help from shared sessions and results. The user gains knowledge and methods that remain useful after the task ends.

## How we test the idea

The product and the research share the same test:

> Collaborate. Learn from each turn. Change how the agent helps. Take on something harder.

Real use gives self-improvement a purpose. Noesis can change its instructions and abilities. A change matters only if it helps the user and the agent do something better together.

The idea depends on four abilities. Noesis must:

1. Collaborate on open questions and complete the task when the goal is clear.
2. Carry useful context and methods across sessions.
3. Turn shared experience into new ways to help.
4. Let the user inspect and reverse each change.

The implementation splits along one line. Noesis uses capable models for decisions that depend on meaning. Regular code records where changes came from, makes them reversible, and protects permissions and recovery.

## Primary user

Noesis is built first for a person who thinks and makes. This person moves among four orientations. These are not product modes or steps that every session must follow.

| Orientation | What they are trying to do                                                            | What progress means                                                                                  |
| ----------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Builder     | Turn ideas into usable artifacts and changes close to the current task.               | An artifact exists, decisions become concrete, and the path from thought to action stays short.      |
| Philosopher | Examine aims, assumptions, meaning, and direction.                                    | The question becomes sharper, alternatives become visible, and judgment changes what is worth doing. |
| Learner     | Become capable of understanding and applying something, not merely receive an answer. | Understanding transfers into practice and can be recalled, challenged, or extended later.            |
| Researcher  | Turn observations about the human-agent system into experiments.                      | A hypothesis is tested through use and ends in retained, revised, or negative knowledge.             |

The transitions matter most. A build can expose a gap in understanding. Learning can change the build. Reflection can change what is worth making. Repeated friction can become a research question and change how Noesis works.

This user is a focus for the product, not a claim about every future user. Real use should be able to change that focus.

## What Noesis must do

### Remembering what helps

Noesis should remember what can help, not everything it can store. It should keep useful reasons, decisions, methods, and open questions. When it recalls something, it should show the source and leave unrelated sessions alone.

The test is whether the user spends less time rebuilding context and can continue from a richer shared understanding.

### Connecting thinking, learning, and making

Noesis should keep the reasons behind a direction alongside the artifact. A lesson can change what gets built. A build can reveal what the user needs to learn. Reflection can change what the pair chooses to do next.

The value lies in these transitions, not in producing more output alone.

### Collaboration matched to present intent

Noesis should collaborate with the user when a problem is unclear or calls for judgment. It should complete the task when the request is clear. The user can change this balance through conversation instead of a mode selector.

### Changes the user can understand

Noesis may change its own instructions and abilities. It can publish and use a project Program in script or workflow mode during a foreground turn. Ambient reflection can create a Capability with exact Instruction, Skill, or Program effects. The foreground agent can author the same complete Capability decision deliberately while it works with the user, without asking a second reflector to reinterpret it. Each Capability must connect an observed problem to evidence and a clear future use.

Useful changes should not require approval at every step. The user can still inspect, challenge, keep, or reverse them.

The built-in `noesis` skill explains this system progressively when the task calls for it. The user may invoke the same guidance directly with `/refine`; the stable system prompt does not carry the full self-improvement interface on every turn.

## Product principles

1. Help the user now. Each turn should be useful on its own. A session may also give the agent or user a new ability.
2. Judge the whole collaboration. A feature matters when it improves how the user and agent understand, decide, make, learn, or resume a task.
3. Match the user's intent. An unclear intellectual task should default to collaboration. A clear request for execution should default to direct action. A correction from the user overrides the guess.
4. Preserve the links among thinking, making, and learning. Keep the artifacts, reasons, questions, criteria, and feedback that let learning change a build or reflection change a decision.
5. Keep lasting learning specific. Each Capability names the future situation it should improve. It is globally eligible by default, selected only when relevant, and can be narrowed or made always active by the user.
6. Accept `no_change`. Ambient reflection should run quietly, and deliberate refinement should remain selective; neither should create a memory, rule, or ability merely because it can.
7. Make changes understandable and reversible. The user can see what changed, why it changed, where it applies, and how to undo it.
8. Add only what strengthens the main promise. New models, tools, interfaces, and research methods should help the user and agent develop together.
9. Let real use change the product. Evidence may revise the primary user, interaction patterns, learning reach, continuity choices, and defaults.
10. Prefer recovery over ceremony. Ordinary Capability revisions activate immediately. The model can publish project Programs through `execute`, while the provider-facing tool set remains fixed and every other operation is progressively disclosed through the same Broker. Because every revision is exact and reversible, a mistake costs little. Only credential export, recovery or audit control, and irreversible external actions without foreground user intent interrupt for approval.

## Non-goals

- It is not a generic agent built to cover as many isolated tasks as possible. Breadth matters when it strengthens a real collaboration or tests a useful idea.
- It is not a store of sessions, memories, prompts, and generated code. Storing more does not prove that either side has developed.
- It is not an agent that rewrites itself in ways the user cannot see. Every Capability records exact effects, evidence, scope, selection mode, and revision history. The user can restore any prior revision.
- It is not a research demo detached from daily value. Novelty does not replace repeated use, better results, stronger understanding, or less repeated explanation.
- It is not a productivity system that removes the user from important decisions. Execution that weakens judgment or learning conflicts with the product promise.
- It does not force every session through four modes. A session may use one orientation, blend several, or simply finish a task.
- It is not defined by the TUI. The TUI is the first direct interface, not the product thesis.
- It should not turn ordinary turns into approval dialogs. Reflection and ordinary Capability activation stay quiet. Only credential export, recovery or audit control, or an irreversible external action without foreground intent interrupts for approval.
- Trust should not make the system rigid. Durable records and exact revisions coexist with prompts, Capabilities, tools, and model roles that remain easy to change.
