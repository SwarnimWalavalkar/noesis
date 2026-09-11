---
name: noesis
description: Inspect and deliberately refine Noesis's lasting Capabilities, skills, and harness. Use for self-improvement, learned behavior, feedback, scope, activation, restoration, or managing and authenticating MCP servers.
---

# Working on Noesis itself

## Choose the smallest lasting form

- Answer normally when nothing should persist.
- Save a Program in `script` mode for one reusable computation or `workflow` mode for a durable multi-phase procedure. Verify a newly saved Program by running its exact revision before depending on it.
- Create or revise a Capability when a lasting fact, preference, criterion, or ability should change Noesis's behavior in future situations. A Capability may contain exact Instruction and Skill materials and may attach an exact already-saved Program revision.

Persist only when future behavior should change. `no_change` is a valid deliberate decision.

## Deliberate refinement

The foreground agent authors the complete semantic decision. Protected runtime code supplies the current turn identity and admissible evidence, resolves exact saved-program revisions, validates the decision, records immutable materials, performs compare-and-swap binding updates, and preserves gates and restoration.

Work in one coherent `execute` program when practical:

1. Use `capabilities.inspect` as the single learning inspector before creating an overlapping Capability. Start with the paginated `list`, request `detail` for one binding and lifecycle counts, then page through `revisions`, `feedback`, or `gates` and load an exact bounded `material` slice only when needed.
2. Gather the evidence needed to understand the problem using ordinary tools and session history. Tool calls completed earlier in the same foreground execution, together with the current user message, become authoritative publication evidence.
3. For a Program effect, load the `execute` skill, save and verify the Program, and then attach that immutable saved definition.
4. Ask `noesis.describe("capabilities.refine")` for the exact current input and output schemas. Author one complete decision and call `capabilities.refine` once.
5. Report what was activated, revised, paused, restored, retargeted, left unchanged, or sent to a protected decision gate.

Use `noesis.search("capability inspect refine")` to rediscover the relevant tools and `noesis.describe` to load their current schemas.

## Authoring standards

- State the future situation in `applicability`, not keywords or a regex.
- Make every effect complete enough to cause the intended behavior. Preserve useful predecessor behavior when revising.
- New portable Capabilities normally remain globally eligible and semantically `relevant`. Narrow to the current project or session only when the behavior truly belongs there. Program effects require current-project scope.
- Use `always` only when the behavior should apply to every eligible turn.
- Inspect the binding revision immediately before revising, pausing, restoring, or retargeting. Treat a stale result as a request to re-inspect, not permission to overwrite newer state.
- Describe consequences truthfully. Credential export, recovery or audit control, and irreversible external action without foreground user intent remain protected.
- A published revision affects formally frozen behavior from a later turn; it does not mutate the current turn plan. You may still use a project program saved during the current turn through its ordinary runner.
- Ambient reflection will still observe the settled foreground turn. A deliberate refinement already recorded in the trace should normally make duplicate learning unnecessary.

Use subagents to investigate, critique, or draft a proposed decision. The foreground agent inspects their evidence and publishes the final decision.

All lasting changes remain visible in `/learning`, retain exact evidence and predecessor lineage, and can be paused or restored.

## Manage MCP servers

Use `noesis.search("mcp")` and `noesis.describe` inside `execute` for exact schemas. The foreground agent can configure and authenticate servers without restarting the session. Subagents cannot manage connections.

1. Inspect `mcp.servers` and `mcp.status({ scope, name })` before changing an existing server. Choose `global` for personal integrations or `project` for the current project. Project servers require a trusted workspace and override global servers with the same name.
2. Call `mcp.configure({ scope, name, config })` with the complete desired definition; it replaces that entry and reloads connections. For stdio, use `type: "local"`, `command`, `args`, optional `cwd`, and `environment` references. For Streamable HTTP, use `type: "remote"`, `url`, and `transport: "streamable_http"`. Remote `auto` and legacy `sse` are also supported.
3. Specify authentication: remote `oauth: true` (the default) uses OAuth discovery; an OAuth object can set a registered `clientId`, `clientSecretEnvironment`, requested `scope`, and callback settings. Use `oauth: false` for anonymous or header-authenticated servers. `headers` maps HTTP header names to environment variable names; local `environment` maps child variable names to source variable names. These are references, never literal credentials.
4. When authentication is needed, call `mcp.authenticate({ scope, name })` and await it. OAuth opens the browser and waits for the verified callback, token exchange, and reconnect. Referenced header/stdio credentials use a masked form outside chat. The user enters a complete header value, including `Bearer ` when required. OAuth tokens and manually entered credentials persist in protected storage and restore automatically across sessions and restarts. Saved header/stdio credentials are bound to this scoped server and its connection settings; changing the destination requires fresh credentials. Never request or copy secrets into tool arguments, configuration files, chat, or logs.
5. Check `ready` and the connection status. A completed form or opened browser alone does not establish a connection. Cancellation and connection failures fail the authentication call. If the error says OAuth sign-in completed and credentials were saved, use `mcp.reconnect` to retry the connection; do not start another sign-in flow merely because the connection failed. A connected server may still require server-driven form or URL elicitation during a tool call; Noesis presents those requests and waits for the protocol result.
6. To use a newly connected server immediately, select a tool from the returned `tools`, inspect its native `definition.inputSchema`, and call `mcp.call_tool({ tool: entry.canonicalName, identityDigest: entry.identityDigest, arguments: {...} })`. The adapter validates the exact identity and schemas through the Broker. The ordinary catalog stays frozen for this turn; subsequent turns expose the discovered tools normally. After a configuration/schema change, inspect again and use the new identity. Never blindly retry a side effect with an unknown outcome.

Use `mcp.set_enabled`, `mcp.reconnect`, `mcp.remove`, and `mcp.reload` for lifecycle changes; `mcp.logout` forgets saved OAuth and header/stdio credentials and disconnects the server. Removing a server also deletes its saved header/stdio credentials. Launch-environment credentials remain environment-owned; disable a server to stop using those. Reload rereads configuration and reconnects servers; inspect status afterward rather than assuming every connection succeeded. `/mcp` remains the user's direct management UI.

Example setup and immediate use:

```js
const setup = await tools.mcp.configure({
  scope: "global",
  name: "docs",
  config: {
    type: "remote",
    url: "https://mcp.example.com/mcp",
    transport: "streamable_http",
    oauth: true,
  },
});
const connected = setup.ready ? setup : await tools.mcp.authenticate({ scope: "global", name: "docs" });
return connected; // Inspect tool schemas before selecting and invoking one.
```

Noesis supports MCP OAuth and server-driven MCP forms/URLs. A server-specific login protocol outside those mechanisms needs its documented setup; do not claim that opening an arbitrary URL proves authentication.
