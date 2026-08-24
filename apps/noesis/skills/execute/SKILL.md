---
name: execute
description: Compose multi-call work through Noesis Code Mode and its injected SDK. Use for tool discovery, session analysis, subagents, MCP access, or authoring and running Programs.
---

# Execute Code Mode

Compose one JavaScript program around the result the user needs. Keep intermediate data in code and return one JSON-compatible final value.

1. Call a known catalog tool with `tools.<family>.<operation>(input)`.
2. For a broader need, call `noesis.search(query)` once, inspect the selected tool with `noesis.describe(name)`, then invoke its exact contract.
3. Batch independent calls with `Promise.all`. Sequence calls when a later input depends on an earlier result.
4. Check result completeness before synthesis. For truncated `shell.run` output, inspect a complete `fullOutputPath` with bounded reads; narrow the collection when the artifact is incomplete.
5. Return the final result. Use `emit(value)` only for useful progress updates.

```js
const [readme, status] = await Promise.all([
  tools.files.read({ path: "README.md" }),
  tools.shell.run({ command: "git status --short" }),
]);
return { readme, status };
```

Read [the SDK reference](references/sdk.md) when the program needs session context, subagents, scratch state, progress events, or reusable Programs.
