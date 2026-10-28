---
name: noesis
description: Inspect and change Noesis itself. Use for its configuration (models, reasoning, subagent routes, context budget, compaction), the current session (model, reasoning, title, context use, compaction history), provider sign-in, MCP servers, built-in skills, and deliberate refinement of lasting Capabilities, learned behavior, feedback, scope, activation, or restoration.
---

# Working on Noesis itself

## What Noesis can change about itself

When the user asks what can be configured, answer from this table and from `config.inspect`. When they ask for a change, make it with the listed tool, then report what changed and when it takes effect.

| Surface                                            | Tools                                                          | Notes                                                                                                                                                                                 |
| -------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foreground model, provider, and reasoning defaults | `config.inspect`, `config.update` (`agent`)                    | Used when Noesis next starts a session, normally the next launch.                                                                                                                     |
| This session's reasoning level and title           | `session.inspect`, `session.update`                            | See [Change this session](#change-this-session).                                                                                                                                      |
| Subagent model route                               | `config.update` (`agents`)                                     | Applies from the next turn. `null` inherits the foreground session route.                                                                                                             |
| Context budget and automatic compaction            | `config.update` (`context`)                                    | Applies from the next turn.                                                                                                                                                           |
| Model provider sign-in                             | `providers.list`, `providers.authenticate`, `providers.logout` | Sign-in runs the `/provider` flow in the TUI.                                                                                                                                         |
| MCP servers                                        | `mcp.*`                                                        | See [Manage MCP servers](#manage-mcp-servers).                                                                                                                                        |
| Lasting behavior, preferences, and abilities       | `capabilities.inspect`, `capabilities.refine`                  | See [Deliberate refinement](#deliberate-refinement).                                                                                                                                  |
| Reusable scripts and workflows                     | `programs.*`                                                   | Load the `execute` skill.                                                                                                                                                             |
| Built-in skill text                                | file read and write                                            | Edit `<home>/skills/builtin/<name>/SKILL.md`, using `home` from `config.inspect`. Later turns load the edit. Upgrades back up an edited file before installing a new bundled version. |

Only the user enters credentials, through the sign-in flows above. Workspace trust (`--trust-workspace`) and audit and recovery controls are not agent-editable.

## Inspect this session

Call `session.inspect` for questions about the running session, such as which model it uses, how full the context is, or whether it was compacted. It returns:

- `session`: ID, title, project, start time, and completed turns.
- `route`: the provider, model, and reasoning level this turn runs on, the configured default, which fields differ from it, the reasoning level the next turn will use, and this turn's subagent defaults.
- `context`: the context window, request budget, output reserve, estimated tokens used, and the same per-component breakdown as `/context`. It describes the last model request, so it reflects this turn's input but not your reply.
- `compaction`: each compaction checkpoint with when it was made, how many messages it covered, its size, and the model that wrote it. The notes themselves are already in your prompt.
- `permissions`: the effects and resources this turn may use.

The full transcript before this turn is the codemode `context` object, not part of this result. Past sessions are under `history.*`.

## Change this session

`session.update({ thinkingLevel?, title? })` changes the running session:

- `thinkingLevel` must be one the session's model supports; `providers.list({ provider })` lists them. Settings are frozen when a turn starts, so the new level applies from the next turn. Tell the user that.
- `title` names the session in `/resume`. Sessions start named after their model, so offer a short descriptive title when the user asks or when the topic is clear.

Two session changes stay with the user. Explain why and name the command instead of trying a workaround:

- **Switching the model or provider.** A session is pinned to one model for its whole life. `/provider` and `/model` start a new session with the transcript left in `/resume`, and the turn you are running belongs to the current session, so you cannot move it. You can change the default for future sessions with `config.update`, and reasoning with `session.update`.
- **Compacting.** Your context for this turn was fixed when the turn started, so compacting now could not free room for you. The user runs `/compact`, optionally with a focus, between turns. You can turn automatic compaction on or off with `config.update({ context: { autoCompact } })`.

## Configure Noesis

`noesis.describe(name)` starts with `signature.input` and `signature.output`, compact types for each tool's fields. Read them before guessing a field name. The shapes you need most:

- `config.update` input: `{ agent?, agents?, context? }`, where `agent` and `agents` take `{ provider?, model?, thinkingLevel? }` and `context` takes `{ tokenBudget?, autoCompact? }`. Reasoning is `thinkingLevel`.
- `config.update` result: `previous`, `effective`, `overridden`, `providers`, and `appliesWhen`.
- `providers.list({ provider })` models: `{ model, name, default, thinkingLevels }`.

1. Call `config.inspect` before changing anything. It returns the stored file, effective values, where each foreground value came from, and what each setting does. `effective.agent` is only the default for new sessions; the current session's model comes from `session.inspect`.
2. For a provider or model change, call `providers.list` for valid provider IDs, then `providers.list({ provider })` for its models and supported reasoning levels.
3. Call `config.update` once with only the fields to change. `null` clears a field so its default applies. The update result already has the previous and new values, so do not inspect again to confirm it. If `overridden` is not empty, a command-line flag or environment variable still wins for that field; tell the user.
4. If a changed provider's `authentication.configured` is false, offer to call `providers.authenticate({ provider })`. It opens a sign-in overlay and waits. OAuth opens the browser; API keys use a masked form. Never ask the user to paste a credential into chat. A cancelled or failed sign-in fails the call; report it and do not retry unless the user asks.
5. Tell the user when the change takes effect, using `appliesWhen` from the result.

If a program fails after a write, its error lists the tools that already succeeded. Do not repeat a listed `config.update`; return the values you need from a new read instead.

Make the defaults match the current session:

```js
const { route } = await tools.session.inspect({});
const result = await tools.config.update({
  agent: { provider: route.provider, model: route.model, thinkingLevel: route.thinkingLevel },
});
return { previous: result.previous.agent, now: result.effective.agent, overridden: result.overridden };
```

Route subagents to a provider's default model:

```js
const routes = await tools.providers.list({ provider: "anthropic" });
const result = await tools.config.update({
  agents: { provider: "anthropic", model: routes.models.find((entry) => entry.default).model },
});
const signedIn = result.providers.every((entry) => entry.authentication?.configured !== false)
  ? null
  : await tools.providers.authenticate({ provider: "anthropic" });
return { previous: result.previous.agents, now: result.effective.agents, signedIn };
```

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
