# Codemode, context, and subagents

Codemode lets the model compose tool calls in JavaScript through `execute`. The direct tools are file read, file write with exact replacement, shell, and `execute`. Other tools are progressively discoverable through codemode.

Tool calls through codemode use the same frozen Tool Catalog, Broker, and authority as direct calls. Generated code can save project Programs in script or workflow mode. Reflection or the foreground agent can attach an exact saved Program revision to a Capability.

## Session context

`context` is an immutable, lazy view of the complete session before the current turn. It contains the visible messages and recorded tool, code, model, and workflow activity.

- `context.length` exposes the document length.
- `context.slice(start, end)` selects a slice without loading the whole document.
- `await context.text()` reads the complete document.

The agent API accepts context slices directly:

```js
const recent = context.slice(-20000);
const child = await agents.spawn({
  name: "decision-reviewer",
  prompt: ["Find the unresolved decisions.", recent],
});
// Continue the foreground task while the subagent runs.
return await agents.wait({ taskId: child.taskId });
```

Saved workflows keep the context document and model route from the run that started them, including after resume.

## Subagent lifecycle

`agents.spawn({ name?, systemPrompt?, prompt, tools?, thinkingLevel? })` records a subagent task and immediately returns stable `agentId` and `taskId` handles. Agents live within the Noesis process rather than one foreground turn or session.

`prompt` accepts text, a context slice, or an array of either. `tools` accepts canonical names from the frozen Tool Catalog.

`agents.send`, `agents.list`, `agents.inspect`, `agents.wait`, `agents.cancel`, and `agents.close` manage collaboration. Productive tasks have no independent provider-round, tool-call, or wall-clock ceiling.

Subagents use the same Broker, authority, and durable recording paths as other codemode tools. Recursive spawning is available only when explicitly granted.

## Model routing

The default subagent provider, model, and thinking level come from `agents` in `config.json`. Omitted fields inherit the foreground `agent` configuration. See the [configuration example](configuration.md#configure-models-and-context).

The parent may choose tools, prompt, and thinking level, but not the provider or model.

## Inspect subagents

A process-wide `SUBAGENTS` panel stays above the composer while agents are active, including after switching sessions. Idle and completed agents collapse by default.

In `Ctrl+O`, select an agent and press Enter to inspect its frozen prompt, reasoning, assistant messages, model rounds, mailbox messages, and complete nested tool tree. Child internals never interleave into the main transcript.
