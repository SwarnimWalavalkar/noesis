# Noesis

> The self-evolving agent harness for tinkerers.

Noesis is for hackers, researchers, writers, and other curious people doing creative knowledge work. You can use it to think and make. As you work together, Noesis can improve its memory and skills. It can create tools and workflows. It can also change how it works with you.

![The Noesis loop: creative work leaves session traces, those traces guide selective evolution, and the evolved harness makes the next related session better.](docs/noesis-compounding-loop.jpg)

Self-evolution begins with the traces a session leaves behind. Noesis can learn from your corrections and from the way you steered it. It can notice repeated friction. It can preserve a tool or approach that proved useful. Noesis keeps a change only when there is a good reason to expect that it will help again.

The aim is a useful agent harness that remains open to inspection and change as it grows.

## Why Noesis

Current agents can carry context across requests and remember preferences. Many can search past conversations or reuse prior work. Noesis focuses on whether it can learn from those traces. The test is whether its judgment improves and it develops capabilities that help in later sessions.

Creative work depends on continuity. A question can lead to research. Research can change what you build. Building can expose something you need to learn. A useful tool can emerge from one project and change how you approach the next one.

Noesis records the traces that show these transitions and looks for narrow improvements that could help in related sessions.

> Create with it. Steer it. Learn from the traces. Change the harness. Keep what helps.

## A harness for creative knowledge work

Noesis is built for people who move between thinking and making.

A hacker may turn a repeated command into a tool. A researcher may develop a better way to gather and test evidence. A writer may teach the agent how to critique an argument without flattening their voice. The same person may do all of these things in one project.

Noesis does not force this work into fixed modes. When the problem is open, it can explore with you. When the task is clear, it can do the work. You can change that relationship through ordinary conversation.

Noesis lets you modify the harness while you use it. You can inspect its current behavior. You can teach it something new, try the result, and undo a change that did not work.

## What self-evolving means

Noesis can change parts of the system that shape its behavior. It can learn through memory and skills. It can create tools, scripts, and workflows. It can also change its instructions and decide when a capability should apply.

The ability to change is only the beginning. A useful change needs a reason, a scope, and evidence that it helped. Noesis treats self-evolution as an ongoing experiment:

1. During a session, Noesis records how you steered the agent and where it struggled. It also records which approaches worked.
2. Noesis studies those traces and forms a narrow hypothesis.
3. It proposes a concrete change for a future kind of work.
4. The candidate is compared with the current behavior.
5. A passing change becomes active only where it is meant to help.
6. Later sessions provide more evidence to keep, revise, broaden, or revert it.

Not every session needs to change the harness. A trace may contain no durable lesson. That is a successful outcome.

Every lasting change should remain open to inspection. You should be able to ask what changed, why it changed, where it applies, which evidence supported it, and how to undo it.

## How it works

Noesis separates behavior that may evolve from code that protects the user and the integrity of the system.

Instructions, knowledge, capabilities, and programs may change. A person or the agent can inspect and edit these resources.

Protected code controls permissions and durable state. It also controls evaluation, activation, and rollback. Generated content may propose a change, but it cannot approve itself or grant itself more authority.

Noesis records exact revisions when a session or experiment depends on them. This makes it possible to understand which version produced a result and to return to an earlier version.

The harness also separates different ways of extending the agent:

- Tools provide individual capabilities.
- Skills teach the agent how and when to use its capabilities.
- Scripts turn useful code into reusable programs.
- Workflows connect programs into longer work that can pause and resume.

Noesis currently runs locally and provides a terminal interface. It uses a language model to interpret, create, reflect, and judge. Dependable code retains control over permissions and changes to active behavior.

## Design principles

- Make something useful in the current session.
- Learn from past traces and explicit steering.
- Start every learning at the narrowest useful scope.
- Preserve the connections between thinking, learning, and making.
- Keep changes inspectable and reversible.
- Let generated behavior propose changes, but never approve its own authority.
- Treat the user as a participant in the evolving system.

## Project status

Noesis is an early research preview. It is ready to run and tinker with, but its interfaces and internal design will continue to change.

Product documentation lives under `docs/`.

The repository includes a local terminal experience, persistent sessions, tools, skills, reusable scripts, durable workflows, and the first complete path from reflection to evaluated and reversible behavior change. Some parts of the intended experience are still easier to inspect in the underlying records than through the interface.

The central research question remains open:

> Can an agent learn from how you steer it and become more useful without drifting or hiding how it changed?

Noesis is an attempt to answer that question by building the complete system and using it.

## Quick start

Noesis requires Node.js 22.19 or newer and pnpm 10.

```sh
pnpm install
pnpm check
```

The first launch guides you through choosing a model provider and signing in:

```sh
pnpm start
```

Start a new session with `pnpm start`. Resume a saved session with:

```sh
pnpm start -- --resume
```

Continue the most recently active session with:

```sh
pnpm start -- --continue
```

Noesis stores its local state in `~/.noesis` by default.

---

> Noesis is being built in public for people who want to do creative work with an agent and tinker with what that agent can become.
