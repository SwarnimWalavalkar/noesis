# Configuration and everyday use

Install and launch Noesis with the [README quick start](../README.md#install-noesis). The first launch asks you to choose a model and authenticate.

## Choose a provider

Noesis supports OpenAI Codex, Anthropic, OpenRouter, OpenCode Zen, and OpenCode Go. Use `noesis auth login` to store credentials for your provider.

OpenCode Zen and OpenCode Go use separate provider IDs and keys:

| Provider     | Provider ID   | Environment variable  |
| ------------ | ------------- | --------------------- |
| OpenCode Zen | `opencode`    | `OPENCODE_API_KEY`    |
| OpenCode Go  | `opencode-go` | `OPENCODE_GO_API_KEY` |

Keys stored through `noesis auth login` are kept under those separate provider IDs.

## Configure models and context

Noesis stores local state under `~/.noesis/` by default. Set model options and the context budget in `~/.noesis/config.json`:

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
    "tokenBudget": 160000,
    "autoCompact": true
  }
}
```

`agent` configures the foreground model. `agents` configures subagents, with omitted fields inherited from `agent`. See [subagent routing](codemode.md#model-routing) for the runtime contract.

The default context budget is 160,000 tokens. Set `context.tokenBudget` to another positive value to change it. The budget covers the whole model request, not only the transcript. Noesis keeps it below the selected model's context window and reserves room for the model's maximum output.

Use `/context` to inspect the current session's context. `/compact` appends immutable continuity notes from older settled turns and keeps a recent raw tail. Future turns receive a bounded notebook assembled from those notes. Later compaction never rewrites earlier notes. The visible transcript, resume, and session search retain the original messages and tool traces.

Automatic compaction is enabled by default. Before a new turn, Noesis uses the same notebook compactor if history exceeds its allocation. To disable automatic compaction, set `context.autoCompact` to `false` and restart Noesis. Manual `/compact` remains available. With automation disabled, an over-budget turn stops with guidance instead of silently dropping history.

The notebook uses at most one quarter of the history allocation, capped at 8,000 estimated tokens. If an existing note exceeds a reduced allocation, increase `context.tokenBudget` or shorten the new request. `/compact` cannot shrink an immutable note, and the selected model still limits the available budget.

## Reopen a session

Continue the most recently active session:

```sh
noesis --continue
```

Choose an older session from the picker:

```sh
noesis --resume
```

Open a specific session:

```sh
noesis --resume SESSION_ID
```

Use `/fork` within a session to create a new session from it. Messages submitted while a turn is running wait in order.

## Connect MCP servers

Use `/mcp` to add, authenticate, inspect, enable, disable, or remove a local or remote server.

Global servers live in `~/.noesis/mcp.json`. Project servers live in `./.noesis/mcp.json`. A project entry replaces a global entry with the same name while that project is active.

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

Project skills and project MCP servers stay disabled unless you start with `--trust-workspace`. This flag does not restrict direct file and shell access. See [public beta and trust](../README.md#public-beta-and-trust).

Connected MCP tools join the same catalog as built-in tools. The model can call them through `execute` or use them from a saved Program.

## Upgrade or uninstall

Upgrade to the latest published version:

```sh
npm install --global noesisai@latest
```

Remove the CLI:

```sh
npm uninstall --global noesisai
```

Uninstalling the package does not delete `~/.noesis/`. Your configuration, credentials, sessions, Programs, and Capability history remain available if you reinstall.
