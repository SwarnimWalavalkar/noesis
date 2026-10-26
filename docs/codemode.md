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
// The result arrives as a system reminder when the task settles.
child;
```

Saved workflows keep the context document and model route from the run that started them, including after resume.

### Retrieve older session details

[Session compaction](session-compaction.md) reduces the history included in the foreground model request. The `context` document still contains the complete recorded session before the current turn. Reading a slice lets the agent examine a particular part without loading the whole document. Passing that text to a model still uses input tokens.

For a detail whose location is unknown, the agent can discover `history.search_sessions` through `execute` and search with `scope: "current"`. The tool accepts a query such as the following:

```json
{
  "query": "original migration error and rollback decision",
  "scope": "current",
  "maxResults": 3
}
```

Results contain bounded evidence with exact citations. The agent can use `history.open_session_evidence` to open a bounded window around a returned citation. Search defaults to previous sessions when scope is omitted. Use `"all"` to include both current and previous sessions, or supply an exact `sessionId` instead of `scope`.

## Subagent lifecycle

`agents.spawn({ name?, systemPrompt?, prompt, tools?, thinkingLevel? })` records a subagent task and immediately returns stable `agentId` and `taskId` handles. Agents live within the Noesis process rather than one foreground turn or session.

`prompt` accepts text, a context slice, or an array of either. `tools` accepts canonical names from the frozen Tool Catalog.

`agents.send`, `agents.list`, `agents.inspect`, `agents.wait`, `agents.cancel`, and `agents.close` manage collaboration. Productive tasks have no independent provider-round, tool-call, or wall-clock ceiling.

### Results and messages

When a task completes, fails, or is interrupted, Noesis sends a completion notice to the actor that requested it. The requester is the foreground session or agent that spawned the agent or sent the message that started the task. Mailbox messages and notices reach the recipient as one `<system-reminder>` block. The block says that its content comes from named agents and is not a user message.

- A running foreground turn receives the reminder at its next model step. Tool calls the model already proposed still run. A reminder delivered this way is stored in the session transcript, so later turns see it too.
- An idle foreground session starts a turn with the reminder as its input. A session whose queue is paused, for example after an interrupt, keeps the reminder until the user's next message.
- A running subagent receives completion notices at its next step. A message from another actor steers it, so tool calls it already proposed are skipped. An idle subagent starts a new task for either kind.

No notice is sent when the requester is already joined to the task through `agents.wait`, or when the task was cancelled. A task started by a completion notice does not send a notice of its own.

`agents.wait` is for using a result in later code. Execution is rejected before it starts if code discards a wait's value, for example `await agents.wait({ taskId });` as a statement or a discarded `Promise.all` of waits. Assigning the value, returning it, or passing it on is allowed.

When one agent's output feeds another agent or a later step, use a workflow Program. A phase can spawn agents and join them, and the next phase receives the joined values:

```js
// One workflow phase; requiredTools: ["agents.spawn", "agents.wait"]
const [left, right] = await Promise.all([
  agents.spawn({ name: "left", prompt: `Review the left side of ${input.topic}` }),
  agents.spawn({ name: "right", prompt: `Review the right side of ${input.topic}` }),
]);
const reports = await Promise.all([
  agents.wait({ taskId: left.taskId }),
  agents.wait({ taskId: right.taskId }),
]);
return { reports: reports.map((report) => report.result) };
```

Subagents use the same Broker, authority, and durable recording paths as other codemode tools. Recursive spawning is available only when explicitly granted.

## Model routing

The default subagent provider, model, and thinking level come from `agents` in `config.json`. Omitted fields inherit the foreground `agent` configuration. See the [configuration example](configuration.md#configure-models-and-context).

The parent may choose tools, prompt, and thinking level, but not the provider or model.

## Inspect subagents

A process-wide agent strip stays above the composer while agents are running, including after switching sessions. It collapses to one line and lists finished agents only on request.

When a subagent reports to the current session, a notice names the agent and says when the foreground agent will see the report. The report appears in the transcript under `AGENTS`, not as user input.

In `Ctrl+O`, select an agent in the strip or its spawn card and press Enter to open its read-only transcript: task, reasoning, assistant messages, mailbox messages, and the complete nested tool tree, with the system prompt one key away. Child internals never interleave into the main transcript.
