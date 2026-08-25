---
name: execute
description: Compose multi-call work through Noesis Code Mode and its injected SDK. Use for tool discovery, session analysis, subagents, MCP access, or authoring and running Programs.
---

# Execute Code Mode

Compose one JavaScript program around the result the user needs. Keep intermediate data in code and produce one JSON-compatible final value. Foreground `execute` returns its final top-level expression automatically; an explicit `return` also works. Saved Program bodies retain ordinary function-body semantics and must return their output explicitly.

1. Call a known catalog tool with `tools.<family>.<operation>(input)`.
2. For a broader need, call `noesis.search(query)` once, inspect the selected tool with `noesis.describe(name)`, then invoke its exact contract.
3. Batch independent calls with `Promise.all`. Sequence calls when a later input depends on an earlier result.
4. Check result completeness before synthesis. For truncated `shell.run` previews with `fullOutputComplete: true`, inspect `fullOutputPath` with bounded reads or ordinary Unix tools. If it is false, narrow or recollect the missing evidence.
5. Return the final result. Use `emit(value)` only for useful progress updates.

```js
const [readme, status] = await Promise.all([
  tools.files.read({ path: "README.md" }),
  tools.shell.run({ command: "git status --short" }),
]);
return { readme, status };
```

## SDK reference

- `tools.<family>.<operation>(input)` invokes a known canonical Broker tool.
- `noesis.search(query, limit?)` finds relevant tools in the frozen catalog.
- `noesis.describe(name)` returns one tool's exact input and output schemas.
- `noesis.invoke(name, input?)` invokes a tool by its exact string name.
- `context` is a lazy immutable view of the complete pre-turn session. Use `context.length`, `context.slice(start, end)`, and `await view.text()`.
- `agents.run({ systemPrompt?, prompt, tools?, thinkingLevel? })` runs an independent agent. Its prompt accepts text, a context view, or an array of both. Canonical tool names grant the selected frozen tools; omitting `tools` creates a tool-free query.
- `emit(value)` and `notify(value)` publish JSON-compatible progress updates.
- `store(key, value)` and `load(key)` manage bounded JSON scratch state for the Code Mode session.
- `input` is the validated input inside saved Program source. A foreground `execute` receives `null`.

Code Mode, subagents, and shell commands have no implicit duration or call-count ceiling. Pass an optional `timeoutMs` only when the task itself needs a deadline; the user can cancel active work at any time.

Pass a context view directly to `agents.run` when the child can analyze it without expanding the text in the parent execution.

## Programs

Load the current `programs.save` and `programs.run` contracts with `noesis.describe`; load `programs.resume` when recovery is relevant.

Choose `script` for one reusable computation and `workflow` for a durable sequence of phases. Each source is an async JavaScript function body: read `input`, call dependencies through `tools`, and return a value matching the output schema. Declare every canonical tool the source may call in `requiredTools`.

Workflow phases run in order and pass each returned value to the next phase. A failed phase pauses; `programs.resume` retries its recorded input or applies a supplied correction, while completed phases remain complete.

Save the Program, then run its exact returned `definitionRevisionId`. A Capability supplies its later applicability, scope, activation, and restoration.
