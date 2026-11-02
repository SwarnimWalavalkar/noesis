# Codemode, context, and subagents

Codemode lets the model compose tool calls in JavaScript through `execute`. The direct tools are file read, file write with exact replacement, shell, and `execute`. Other tools are progressively discoverable through codemode.

Tool calls through codemode use the same frozen Tool Catalog, Broker, and authority as direct calls. Generated code can save project or global Programs in script or workflow mode, and run them by name or by exact revision. Reflection or the foreground agent can attach an exact saved Program revision to a Capability.

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
  "query": "\"rollback decision\" migration error",
  "scope": "current",
  "after": "2026-10-01",
  "source": "tool_output",
  "maxResults": 8
}
```

Session search is a keyword search with stemming, ranked by BM25. It does not match by meaning, and no model call runs behind it, because the model calling it is the semantic layer. Any term in the query may match, and documents that match more of the terms rank higher. Double quotes require an exact phrase. A search for `deploying` also finds `deployed`, but a search for `rollout` does not find `release`. The agent therefore searches for the words the evidence would contain and runs several reformulated queries together:

```js
const queries = ["rollback decision", "revert migration", '"down migration"'];
return await Promise.all(queries.map((query) => tools.history.search_sessions({ query, maxResults: 8 })));
```

Results contain bounded evidence with exact citations. A search returns 20 results by default. The agent can use `history.open_session_evidence` to open a bounded window around a returned citation. Search defaults to previous sessions when scope is omitted. Use `"all"` to include both current and previous sessions, or supply an exact `sessionId` instead of `scope`.

The optional `after` and `before` filters take an ISO-8601 date or datetime. `after` is inclusive and `before` is exclusive. The optional `source` filter limits results to conversation messages (`"message"`) or tool calls and their output (`"tool_output"`).

All searches in one turn share a total budget of about 31,000 characters. When the budget withholds results, `telemetry.status` is `budget_exhausted` and `telemetry.omittedResults` counts them. That does not mean the words failed to match. A smaller `maxResults` cannot recover withheld results later in the same turn, so the agent should choose a smaller `maxResults`, about 8 per query, before fanning out.

## Read another session

`tools.history.open_session({ sessionId })` returns another session as the same kind of view as `context`, with `.length`, `.slice(start, end)`, and `await view.text()`. An `agents.spawn` prompt accepts its slices. Use it after search has identified a session, when the bounded evidence window is too small:

```js
const { fragments } = await tools.history.search_sessions({ query: "rollback decision", maxResults: 1 });
if (fragments.length === 0) return "No match";
const { citation } = fragments[0];
const past = await tools.history.open_session({ sessionId: citation.sessionIds[0] });
const rowId = citation.identity.messageId ?? citation.identity.toolCallId;
const at = rowId ? (await past.text()).indexOf(rowId) : -1;
if (at < 0) return await tools.history.open_session_evidence({ citation });
return await past.slice(Math.max(0, at - 2000), at + 4000).text();
```

The document contains the same recorded rows as `context`, one JSON value per line. A citation's offsets refer to its source row, not to this document, so find the row by its message or tool call id. A citation for a session title, an outcome, or a file or evidence revision has no row in the view, so open it with `history.open_session_evidence` instead.

The view follows the rules of the session search tools:

- Secret content is never included. Each secret row becomes an `omitted` line that keeps only the record type, time, and sensitivity, so the reader can tell that the view is partial.
- Private content is also omitted unless the call passes `includePrivate: true`. That flag is accepted only for the current session or an authorized session, and is otherwise rejected.
- A user message keeps its own label. Every other row can repeat anything the session had shown by then, so it takes the highest label recorded up to its time or anywhere in its turn. One secret row therefore hides every later row except user messages. A session with no labelled row counts as private.
- A session that does not exist or was deleted is rejected.
- Only views opened in the same execution can fill an `agents.spawn` prompt.

The view is frozen and verified against its digest in the same way as `context`, and it is a snapshot taken at the call. Opening the session again later can return newer content as a different view.

A workflow run pins the digest it first reads for each session and disclosure mode. Any later read in that run, including a resumed phase or a subagent it spawned, must match the pin. If the session changed, the read fails instead of returning different bytes, and the phase pauses. Start a new run to read the current content. A run should read its own session through `context`, because that session keeps changing while the run records its work.

## Subagent lifecycle

`agents.spawn({ name?, systemPrompt?, prompt, tools?, thinkingLevel? })` records a subagent task and immediately returns stable `agentId` and `taskId` handles. Agents live within the Noesis process rather than one foreground turn or session.

`prompt` accepts text, a slice of `context` or of a session view, or an array of those. `tools` accepts canonical names from the frozen Tool Catalog.

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
