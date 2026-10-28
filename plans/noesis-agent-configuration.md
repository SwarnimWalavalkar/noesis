# Agent-managed configuration

Let the foreground agent explain and change Noesis's own configuration through codemode, and let it ask the user to sign in to a model provider without moving credentials through the conversation.

## Scope

- `config.inspect` returns the effective configuration, the file contents, the source of each foreground value, and when each setting takes effect.
- `config.update` applies one validated patch to `config.json` under the existing writer lock. `null` clears a field so it falls back to its default or, for subagents, to the foreground route. There is no revision history; the result returns the previous effective values.
- `providers.list`, `providers.authenticate`, and `providers.logout` expose provider status, model routes, sign-in, and sign-out.
- MCP management, Capabilities, Programs, and editable built-in skills already exist and stay where they are. The `noesis` skill documents every surface in one place.
- `session.inspect` reports the running session: identity, the pinned model route compared with the default, context window use from the same read model as `/context`, compaction checkpoint history, and the turn's permission snapshot. It is bound to the turn's frozen plan. Cumulative token usage is not reported because foreground turns do not persist it.
- All new tools are foreground-only. Subagents do not receive them.

## Session control

`session.update` changes the running session's reasoning level and title. The session record is the only authority for its reasoning level: the TUI no longer sends its own copy with each turn, turns read the session's level when they start, and the TUI refreshes its status from the session after each turn settles. Turn settlement keeps title and reasoning changes made while the turn ran instead of writing back the turn's starting copy.

The agent cannot switch the session's model or provider, because a session is pinned to one route and `/model` or `/provider` starts a new one, which would strand the running turn. It cannot compact, because the running turn's context is already frozen. The `noesis` skill tells the agent to explain this and name the user's command.

## Session titles

A `session_titler` background role names each new session from its first message. It starts when the first turn starts, runs beside it, and writes the title through the same serialized session-settings write as `session.update`. The `titles` config section turns it off or gives it its own provider, model, and reasoning level; an unset provider or model uses the session's own, and reasoning defaults to `off`. The session record marks a title as `titled` once it is generated or set by `session.update`. A generated title never replaces a marked one, and `/resume` lists a marked session by its title instead of its latest message. Titling is best effort: a failure keeps the default title, and shutdown aborts a titler still running. Forked sessions keep their inherited title.

## Live application

The runtime keeps one live resolved configuration. After `config.update`, it rereads the file while preserving command-line and environment overrides.

- Foreground model defaults apply to sessions started afterward. A running session keeps its pinned route; the user switches it with `/model`, `/provider`, or `/reasoning`.
- Subagent defaults and context settings apply from the next turn because they are frozen at turn start.
- Background role routes are fixed at startup and follow the new defaults after a restart.

## Elicitation bridge

The MCP-only TUI interaction bridge becomes a general elicitation bridge for runtime code that needs the user to complete a sensitive step. It queues requests until the TUI attaches a presenter and settles them as cancelled on abort or shutdown. Request kinds:

- `form`: masked or plain fields (MCP server forms and MCP header/stdio credentials).
- `url`: confirm and open a browser URL (MCP URL elicitation).
- `provider-authentication`: run the same provider sign-in overlay as `/provider`, including OAuth, device codes, and masked API keys.

Values entered in these flows never become tool arguments, tool results, or transcript text. The TUI presenter is attached by one interaction orchestration instead of the MCP manager.

## Removed configuration

`learning`, `autonomy`, and `experiments` were validated but never read by the runtime. They are removed from the schema and resolved configuration. Existing files containing them still load; the retired sections are ignored and dropped on the next write.

## Codemode ergonomics

A real session showed the model guessing field names (`thinking` for `thinkingLevel`, `defaults` for `effective`) and losing track of a write that succeeded before its program threw. The harness now gives it the shapes up front:

- Config, provider, and session tools declare typed output schemas instead of opaque JSON.
- `noesis.describe` leads with `signature.input` and `signature.output`, compact TypeScript-like types rendered by one shared JSON Schema renderer in `@noesis/domain`. The `shell.run` contract in the `execute` description uses the same renderer.
- An invalid input error includes the expected input signature, so recovery needs no extra `describe` call.
- When a program fails after Broker calls succeeded, the error names those calls so the model does not repeat or doubt a completed write.

## Validation

- Config package: patch application, clearing, validation errors, retired sections, override-preserving reload, and the existing writer-lock tests.
- TUI: elicitation bridge queuing, cancellation, and provider-authentication presentation.
- Application: a controlled Pi turn that inspects and updates configuration, observes the next-turn effect, and signs in to a provider through a presented elicitation without leaking the entered value.
