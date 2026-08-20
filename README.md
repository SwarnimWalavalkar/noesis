# Noesis

> The self-evolving agent harness for tinkerers.

Noesis learns how you think and work. It uses that shared experience to find better ways to help. It also helps you understand more and take on harder projects.

It is built for hackers, researchers, writers, and other curious people who move between thinking and making.

![Creative work leaves traces. Noesis uses selected traces to develop new ways to help.](docs/noesis-compounding-loop.jpg)

The aim is for you and Noesis to develop together. Noesis adapts as your goals and judgment change. You gain new understanding and better ways to work.

## What makes Noesis different

Noesis treats your ongoing collaboration with it as the core product loop. It can act now, learn from the work, and change how it helps.

It can search previous sessions when their context may help. It can turn useful code into a project script or workflow. After every settled turn, quiet reflection may create or revise an inspectable Capability that changes how Noesis helps.

Noesis is built for people who move between open questions and direct execution. It can think with you when the problem is unclear. When the outcome is clear, it can do the work. You can change this balance through ordinary conversation.

## Two paths for improvement

Noesis uses two direct paths to improve:

1. It can save a project script or workflow and use it at once with its current permissions.
2. It can create or revise a Capability with exact instruction, skill, saved-script, or saved-workflow effects. Ordinary revisions become active immediately and remain visible, reversible, and open to feedback.

A Capability that uses a script or workflow references the same immutable saved definition used by the ordinary runner. It does not create a second program or execution system.

## What is available today

Noesis currently includes:

- a local terminal interface with streaming responses and visible tool activity
- new, continued, and interactively resumed sessions
- durable session compaction with a complete original transcript
- search across previous sessions with source citations
- direct tools for files, directories, shell commands, saved workflows, and session search
- `execute` for combining tools with JavaScript
- local and remote MCP servers with OAuth, project overrides, and TUI management
- project scripts and durable workflows with immutable execution revisions
- ambient reflection after every settled foreground turn
- versioned Capabilities with exact instruction, skill, saved-script, and saved-workflow effects
- immediate activation, feedback, pause, scope changes, and exact restoration
- an interactive `/learning` explorer for inspecting each Capability, its concrete effects, evidence, and history
- SQLite storage for operational state, with ordinary files for editable definitions and artifacts.

Noesis is an early research preview. Its interfaces and internal design will change as we use it.

## Trust and control

Generated code can use the permissions already granted to the current turn. It can create project scripts and workflows, and reflection may attach an exact saved program to a Capability. Credential export, recovery and audit control, and irreversible external actions without foreground user intent remain protected.

Protected code controls durable state, effect settlement, recovery, and exact restoration. Each turn and execution records the exact revision it used. Later inspection does not depend on files that may have changed. The ordinary learning loop does not wait for speculative evaluation; a future evaluation system can be added when it executes real candidate behavior.

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

Use `/compact` to summarize older completed turns while keeping recent turns raw. The original transcript remains intact for resume and search. Noesis also compacts automatically before a future turn would exceed its history budget.

The default history budget is 160,000 tokens. Override it in `~/.noesis/config.json` when a smaller model or a different working style calls for another limit:

```json
{
  "schemaVersion": 1,
  "agent": {},
  "context": {
    "tokenBudget": 160000
  }
}
```

Noesis caps the effective budget below the selected model's context window and reserves that model's maximum output allowance.
After a model response, Noesis uses the provider's reported usage. Before then, it uses a provider-neutral estimate of roughly four UTF-8 bytes per token. Tool-heavy turns can replace older tool results in the next model request with bounded digest-backed references; the complete results remain available in the transcript.

## MCP servers

Use `/mcp` to add a local or remote server. The same screen lets you authenticate, enable or disable a server, reconnect, edit its settings, remove it, and inspect what it provides.

Global servers live in `~/.noesis/mcp.json`. Project servers live in `./.noesis/mcp.json`. A project server replaces a global server with the same name while you work in that project.
Project servers remain disabled until the workspace is trusted.

```json
{
  "servers": {
    "docs": {
      "type": "remote",
      "url": "https://mcp.example.com",
      "oauth": true
    }
  }
}
```

Connected MCP tools join the same tool catalog as built-in tools. The agent can call them through `execute`, add one to its direct tool set with `adapt`, or use one from a saved script or workflow.

## Documentation

Current product documentation lives in [docs/](docs/README.md). Implementation plans and historical design records live in `plans/` and are not required reading for using Noesis.
