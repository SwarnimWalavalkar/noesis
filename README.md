# Noesis

> The self-evolving agent harness for tinkerers.

Noesis learns how you think and work. It uses that shared experience to find better ways to help. It also helps you understand more and take on harder projects.

It is built for hackers, researchers, writers, and other curious people who move between thinking and making.

![Creative work leaves traces. Noesis uses selected traces to develop new ways to help.](docs/noesis-compounding-loop.jpg)

The aim is for you and Noesis to develop together. Noesis adapts as your goals and judgment change. You gain new understanding and better ways to work.

## What makes Noesis different

Noesis treats your ongoing collaboration with it as the core product loop. It can act now, learn from the work, and change how it helps.

It can search previous sessions when their context may help. It can preserve an effective project strategy across sessions. It can turn useful code into a project script or workflow. When evidence supports a broader change, it can evaluate that change against the current behavior before activation.

Noesis is built for people who move between open questions and direct execution. It can think with you when the problem is unclear. When the outcome is clear, it can do the work. You can change this balance through ordinary conversation.

## Three paths for improvement

Noesis uses three paths to improve:

1. It can save a project script or workflow and use it at once with its current permissions.
2. It can apply a temporary strategy to the current project. Further use shows whether to keep, replace, or remove it.
3. It can test a broader change as an experiment before protected code activates it.

All three paths use the same records, tools, and permissions. They do not create hidden execution systems.

## What is available today

Noesis currently includes:

- a local terminal interface with streaming responses and visible tool activity
- new, continued, and interactively resumed sessions
- search across previous sessions with source citations
- direct tools for files, directories, shell commands, saved workflows, and session search
- `execute` for combining tools with JavaScript
- project scripts and durable workflows with immutable execution revisions
- ambient reflection and temporary project strategies
- experiments, evaluation, activation, feedback, and rollback for broader learned changes
- SQLite storage for operational state, with ordinary files for editable definitions and artifacts.

Noesis is an early research preview. Its interfaces and internal design will change as we use it.

## Trust and control

Generated code can use the permissions already granted to the current turn. It can create project scripts and workflows. It cannot grant itself more access or change the protected control plane.

Protected code controls permissions, durable state, evaluation, activation, and rollback. Each turn and execution records the exact revision it used. Later inspection does not depend on files that may have changed.

Changes remain attributable and reversible. The user can inspect what changed, why it changed, where it applies, and which evidence supported it.

## Quick start

Noesis requires Node.js 22.19 or newer and pnpm 10.

```sh
pnpm install
pnpm check
pnpm start
```

The first launch guides you through model selection and authentication. A normal start creates a new session.
Supported providers are OpenAI Codex, Claude through Anthropic, OpenRouter, and OpenCode Zen.

Choose a prior session interactively:

```sh
pnpm start -- --resume
```

Resume an exact session:

```sh
pnpm start -- --resume SESSION_ID
```

Continue the most recently active session:

```sh
pnpm start -- --continue
```

Noesis stores local state in `~/.noesis/` by default.

## Documentation

Current product documentation lives in [docs/](docs/README.md). Implementation plans and historical design records live in `plans/` and are not required reading for using Noesis.
