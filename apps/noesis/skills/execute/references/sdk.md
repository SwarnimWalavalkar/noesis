# Code Mode SDK

## Tool catalog

- `tools.<family>.<operation>(input)` invokes a known canonical Broker tool.
- `noesis.search(query, limit?)` finds relevant tools in the frozen catalog.
- `noesis.describe(name)` returns one tool's exact input and output schemas.
- `noesis.invoke(name, input?)` invokes a tool by its exact string name.

Each successful awaited call becomes causally prior to later calls. Use `Promise.all` for independent work.

## Session context and subagents

- `context` is a lazy immutable view of the complete pre-turn session. Use `context.length`, `context.slice(start, end)`, and `await view.text()`.
- `agents.run({ systemPrompt?, prompt, tools?, thinkingLevel? })` runs an independent agent. `prompt` accepts text, a context view, or an array of both. Canonical tool names grant the selected frozen tools; omitting `tools` creates a tool-free query.

Pass a context view directly to `agents.run` when the child can analyze it without expanding the text in the parent execution.

## Values and progress

- `return` supplies the JSON-compatible result that enters conversation context.
- `emit(value)` and `notify(value)` publish JSON-compatible progress updates.
- `store(key, value)` and `load(key)` manage bounded JSON scratch state for the Code Mode session.
- `input` is the validated input inside saved Program source. A foreground `execute` receives `null`.

## Programs

Load the current `programs.save` and `programs.run` contracts with `noesis.describe`; load `programs.resume` when recovery is relevant.

Choose `script` for one reusable computation and `workflow` for a durable sequence of phases. Each source is an async JavaScript function body: read `input`, call dependencies through `tools`, and return a value matching the output schema. Declare every canonical tool the source may call in `requiredTools`.

Workflow phases run in order and pass each returned value to the next phase. A failed phase pauses; `programs.resume` retries its recorded input or applies a supplied correction, while completed phases remain complete.

Save the Program, then run its exact returned `definitionRevisionId`. A Capability supplies its later applicability, scope, activation, and restoration.
