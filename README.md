# Noesis

> The self-evolving agent harness for tinkerers.

Noesis learns how you think and work. It uses that shared experience to find better ways to help. It also helps you understand more and take on harder projects.

It is built for hackers, researchers, writers, and other curious people who move between thinking and making.

![The Noesis compounding loop. Every turn returns a result. Some turns teach Noesis a new way to help.](docs/noesis-compounding-loop.jpg)

You get a result from the current turn before any learning runs. After the turn settles, Noesis reflects. Most turns change nothing. When the evidence supports it, Noesis creates or revises a Capability. Later turns can use that Capability when it is relevant. You can inspect, pause, or restore any Capability with `/learning`.

If a problem is unclear, Noesis thinks with you. If the outcome is clear, it does the work. You can change that balance in ordinary conversation.

## Capabilities

A Capability is an ability Noesis can reuse. Each version has one or more exact effects:

- **Instruction** adds trusted instructions to a matching turn.
- **Skill** exposes an instructional package that the model loads only when needed.
- **Program** attaches one exact saved project Program revision in script or workflow mode.

Program effects use the same saved Programs you create during a turn. They stay in the project that owns that definition.

New Capabilities apply anywhere they are relevant. You can narrow one to a project or session, or make it always active.

## What you can do today

- Work in a local terminal with streaming responses and visible tool activity.
- Open a new session, continue the last one, resume an older one, or fork the current session. If you type while a turn is running, those messages wait in order.
- Search previous sessions with citations. You can compact older turns without changing the transcript you see.
- Use files, directories, the shell, Programs, and session search as tools. Combine them in JavaScript with `execute`.
- Keep the default direct surface small: file read, file write with exact replacement, shell, and `execute`. Everything else is progressively discoverable through codemode.
- Inspect the complete pre-turn session lazily in `execute`, and ask isolated models to analyze selected slices.
- Save project Programs in script or workflow mode and reuse their exact revisions.
- Connect local and remote MCP servers, including OAuth, from `/mcp`.
- Inspect what Noesis learned with `/learning`, and restore any earlier version.

Noesis is an early public beta. Its interfaces and internal design will change with use.

## Install Noesis

Noesis requires Node.js 22.19 or newer.

Install the public beta from npm:

```sh
npm install --global noesisai
noesis
```

The first launch asks you to choose a model and authenticate. Noesis supports OpenAI Codex, Anthropic, OpenRouter, OpenCode Zen, and OpenCode Go.

OpenCode Zen uses provider ID `opencode` and `OPENCODE_API_KEY`. OpenCode Go uses provider ID `opencode-go` and `OPENCODE_GO_API_KEY`. Keys stored through `noesis auth login` are likewise kept under those separate provider IDs.

Reopen a session:

```sh
noesis --continue
noesis --resume
noesis --resume SESSION_ID
```

`--continue` opens the most recently active session. `--resume` without an ID opens the session picker. Project skills and project MCP servers stay disabled unless you start with `--trust-workspace`.

Upgrade or uninstall the CLI with npm:

```sh
npm install --global noesisai@latest
npm uninstall --global noesisai
```

Uninstalling the package does not delete `~/.noesis/`, so your configuration, credentials, sessions, Programs, and Capability history remain available if you reinstall.

## Public beta

The `0.0.x` releases are a public beta. Noesis is intended for macOS and Linux terminals; Windows is not yet part of the release test matrix. Commands, configuration, and durable schemas may change before `1.0`, with migrations supplied for persisted state.

Noesis runs with the file-system and terminal access of its process. Start it in a directory you are comfortable letting an agent inspect and modify. Workspace-selected skills and MCP servers require `--trust-workspace`, but direct file and shell work can still affect anything the process can access.

Noesis does not send product analytics or usage telemetry. It does contact the model providers and MCP servers you configure, refresh compatible model metadata from `pi.dev`, and let the agent fetch HTTP or HTTPS URLs through its web tool. Those services and sites have their own data policies, and model providers may charge for usage.

Please report bugs and beta feedback through [GitHub Issues](https://github.com/SwarnimWalavalkar/noesis/issues). Report security problems privately as described in [SECURITY.md](SECURITY.md).

## Commands

| Command                                               | Result                                                                                       |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `/learning`                                           | Inspect and manage Capabilities, reflection, feedback, and history.                          |
| `/mcp`                                                | Add, authenticate, inspect, enable, disable, or remove MCP servers.                          |
| `/compact [FOCUS]`                                    | Compact older settled turns for future model context. The visible transcript stays complete. |
| `/context`                                            | Inspect the context for the current session.                                                 |
| `/capabilities`                                       | Inspect the Capabilities selected for the current turn.                                      |
| `/skills`, `/programs`, `/program MODE NAME`, `/runs` | Inspect instructional resources, Programs, and run records.                                  |
| `/fork`                                               | Create a new session from the current session.                                               |
| `/queue resume`                                       | Resume a queue that you paused.                                                              |

Press `?` in the terminal for the full command and keyboard reference.

## Local state and context

Noesis stores local state under `~/.noesis/` by default. The default context budget is 160,000 tokens. Set another positive value in `~/.noesis/config.json`:

```json
{
  "schemaVersion": 1,
  "agent": {},
  "agents": {
    "provider": "openai-codex",
    "model": "gpt-5.6-sol",
    "thinkingLevel": "medium"
  },
  "context": {
    "tokenBudget": 160000
  }
}
```

The budget covers the whole model request, not only the transcript. Noesis keeps it below the selected model's context window. It also reserves room for the model's maximum output.

`/compact` writes a summary checkpoint and keeps a recent raw tail. Noesis also compacts automatically when history would exceed the budget. Resume and session search still use the original messages.

## Program over session context

Codemode exposes a lazy context view and one composable agent API:

```js
const recent = context.slice(-20000);
const child = await agents.spawn({
  name: "decision-reviewer",
  prompt: ["Find the unresolved decisions.", recent],
});
// Continue useful foreground work here. Join only when the result is needed.
return await agents.wait({ taskId: child.taskId });
```

`context` is an immutable, lazy view of the complete session before the current turn. It contains the visible messages and recorded tool, code, model, and workflow activity. Use `context.length`, `context.slice(start, end)`, or `await context.text()`.

`agents.spawn({ name?, systemPrompt?, prompt, tools?, thinkingLevel? })` durably admits a retained process-scoped agent and immediately returns stable `agentId` and `taskId` handles. `prompt` accepts text, a context slice, or an array of either; `tools` accepts canonical names from the frozen Tool Catalog. The default subagent route comes from `agents` in `config.json`, with omitted fields inheriting the foreground `agent` route. The parent may choose tools, prompt, and thinking level, but not the provider or model. Productive tasks have no independent provider-round, tool-call, or wall-clock ceiling.

`agents.send`, `list`, `inspect`, `wait`, `cancel`, and `close` manage collaboration without tying a child's lifetime to one foreground turn or session. Subagents use the same Broker, authority, and durable recording paths as other Code Mode tools; recursive spawning is available only when explicitly granted. A bounded process-wide `SUBAGENTS` surface stays fixed above the composer while agents are active, including after switching sessions. Idle and completed agents collapse by default. In `Ctrl+O`, select an agent and press Enter to inspect its frozen prompt, reasoning, assistant messages, model rounds, mailbox messages, and complete nested tool tree. Child internals never interleave into the main transcript.

Saved workflows keep the context document and model route from the run that started them, including after resume.

## Connect MCP servers

Use `/mcp` to add a local or remote server. Global servers live in `~/.noesis/mcp.json`. Project servers live in `./.noesis/mcp.json`. A project entry replaces a global entry with the same name while that project is active.

This example configures a remote OAuth server:

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

Connected MCP tools join the same catalog as built-in tools. The model can call them through `execute` or use them from a saved Program.

## Trust

Generated code uses only the permissions granted for the current turn. It can save project Programs in script or workflow mode. Reflection or the foreground agent can attach an exact saved Program revision to a Capability.

Noesis asks before credential export, recovery or audit control, and irreversible external actions that you did not request in the current turn.

You can inspect every Capability, challenge it, pause it, or restore an earlier version.

## Develop Noesis

Development requires pnpm 10. Install the repository and start its source build with:

```sh
pnpm install
pnpm start
```

For regular local testing, install the repository-owned `noesis-dev` command:

```sh
pnpm dev:install
noesis-dev
```

The installer links `scripts/noesis-dev` into `~/.local/bin`. Set `NOESIS_DEV_BIN_DIR` to install the link elsewhere. The command runs the current checkout directly through its pinned `tsx`, works from any directory, and keeps its config, credentials, sessions, and other development state in this repository's ignored `.noesis/` directory. Run it without installing the link with `pnpm dev`.

Run the complete local check before sending a change:

```sh
pnpm check
```

The check formats, lints, type-checks, and tests the repository. Tests use controlled providers and do not require paid credentials.

The checked-in VS Code workspace recommends the Oxc extension. `Format Document` uses Oxfmt, while saving runs Oxfmt followed by Oxlint's safe fixes. Both read the same repository configuration as `pnpm check`.

Maintainers publish new npm versions by [creating a GitHub release](docs/releases.md). The release workflow tests and publishes the same package archive through npm trusted publishing.

## Documentation

[Product documentation](docs/README.md) describes the current product and architecture. [Implementation plans](plans/README.md) record the decisions behind shipped systems. You do not need the plans to use Noesis.
