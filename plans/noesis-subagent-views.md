# Subagent strip and child transcript views

Status: active.

This plan replaces the TUI presentation of process-scoped subagents described in [process-scoped subagents](noesis-process-scoped-subagents.html) and extended by [subagent reminders and joins](noesis-subagent-reminders-and-joins.md). The runtime, mailbox, and persistence model are unchanged. Only the TUI read models, key routing, and rendering change.

## Problem

A UX audit on 2026-10-26 found:

- **The panel repeats facts and leaves out useful ones.** The header gives the count three times. Every row repeats status twice and shows the same model route. No row shows elapsed time, current activity, what the agent was asked, or what it concluded.
- **The pulse follows the foreground.** A running child's glyph animates only while the _foreground_ executes. After the recommended "spawn and end the turn" pattern, live agents look frozen.
- **The transcript repeats the panel.** It shows bare `agents.spawn` and `agents.wait` rows, and the wait rows don't name the agent.
- **"Inspect" means three things.** It names the `INSPECT` badge (which is really list selection), the `enter inspect` action, and an overlay titled `RUN`. Tab switches between two invisible navigation modes. The same keys are hinted in three places.
- **The inspector is a second transcript renderer, and a worse one.**
  - It leads with the full system prompt and puts the result last.
  - It never follows live output.
  - It keeps only the last 100 live events. Most are single-token deltas, so it shows fragments that start mid-sentence.
  - It groups live reasoning, text, and tools into separate buckets, so their order is lost.
  - It keeps live events across durable reloads, so persisted content probably appears twice.
  - It shows tool rows as truncated raw JSON, and you can't open them.

## Reference implementations

- **OpenCode** (`packages/tui`):
  - A child is a normal session with `parentID`, opened with the same session view.
  - In a child, the prompt is replaced by a subagent picker, which makes the child read-only.
  - A footer `↓ N subagents` count opens the picker. Esc, or Up on the first picker row, returns to the parent.
  - The picker shows only active children by default. `ctrl+a` reveals inactive ones and `ctrl+d` interrupts.
- **T3 Code** (`apps/web`):
  - Each subagent gets a one-line inline card: status dot, title, progress while running or a one-line result once settled, elapsed time, and a chevron.
  - Cards from one launch group into a collapsible batch card.
  - The raw delegate tool row is removed once its card exists.
  - Opening a card routes to the child thread, rendered by the same timeline.
  - The child header reads "Subagent of <parent>". A status strip replaces the composer.

## Decisions

1. **The child view is the main transcript view.** Opening an agent changes which timeline the transcript renders. The renderer, action cursor, expansion, and run inspector are the same ones the foreground uses. The subagent branch of the run inspector is deleted.
2. **Child views are read-only.** In a child view, a status strip replaces the composer. The user can't message a child from its view. The composer's draft is kept and returns when the user goes back.
3. **The agent strip shows only running agents.** It appears above the composer while at least one agent is `starting` or `running`. It covers the same actors across sessions as today's panel. It is collapsed to one line by default:

   ```
   ● 2 agents running · capability-lifecycle 1:42 · capability-runtime 1:38        ctrl+o
   ```

   - **Expanded**, it shows one row per running agent: glyph, name, elapsed time, and latest activity (current tool and subject, `thinking…`, or `responding…`).
   - The route appears only when it differs from the foreground route.
   - The collapsed or expanded state is ephemeral UI state, kept for the process lifetime.
   - The glyph pulses from the child's own liveness.
   - **Inactive agents.** While the strip is focused, one key reveals idle, suspended, and closed agents, as OpenCode's `ctrl+a` does. This is how retained agents from earlier sessions stay reachable.

4. **Navigation is spatial, and one key enters it.**
   - `ctrl+o` enters navigation. It starts at the strip when the strip is visible, and otherwise at the latest transcript action.
   - Within the strip, `↑/↓` move. `↑` from the top strip row continues into transcript actions, and `↓` from the last transcript action returns to the strip. This replaces the Tab toggle.
   - `enter` opens the selected agent or run. `esc` returns to the composer.
   - The mode badge says `NAVIGATE`, not `INSPECT`. Key hints appear only in the help line.
   - Composer input focus is not redesigned here. Any change to how navigation pauses the composer must be systemic, not specific to subagents.
5. **Inline cards in the parent transcript.**
   - An `agents.spawn` call renders as an agent card: `● name · progress-or-one-line-result · elapsed`.
   - Several spawns in one `execute` form a batch card: `3 agents · 2 working · 1 done · 1:42`. `space` expands the batch, and each member row can be selected and opened on its own.
   - `agents.wait` names the agent it joins.
   - The `AGENTS` completion block gets a `↳ name finished` / `failed` / `interrupted` heading.
   - `enter` on any card, member, or completion block opens that child.
6. **Child view chrome.**
   - The status strip reads `↳ subagent of <session title> · name · route thinking · status elapsed`, with the hint `←/→ siblings · esc back`.
   - The status line shows the child's own context use and tokens.
   - The child's task prompt is the first message.
   - The route, thinking level, and system prompt sit in a collapsed header block at the top of the child timeline. `space` expands it.
   - `←/→` cycle through the agents the strip would list. `esc` returns to the parent with its cursor and scroll position restored.
   - Nested agents, when granted, open the same way and add one level to the `↳` breadcrumb.

## Architecture

- **Transcript slice.** The transcript renderer reads only `timeline`, `actionCursor`, `expandedActionIds`, `execution`, `animationFrame`, and `colorEnabled`. Extract these into a `TranscriptSlice` read model. `NoesisTuiState` holds the foreground slice plus an optional `focusedAgent: { agentId; slice }`. The transcript view renders the focused slice, and cursor and expansion actions reduce whichever slice has focus.
- **Hydrating a child.** `getSubAgentTranscript(agentId)` already returns `RuntimeTranscriptEntry[]`, the same type as `getTranscript`. `tuiTimelineFromRuntime` builds the child timeline.
- **Live child events.** These are `AgentRuntimeEvent`s and go through `tuiActionForAgentEvent` and the existing delta buffering into the child slice. Each durable reload replaces the child timeline. Live state applies only after the reload's high-water mark. This removes the 100-event cap and the duplication.
- **State ownership.** The child slice is a disposable projection. It is dropped when the view returns to the parent and never persisted. Collapsed state and the navigation cursor are ephemeral UI state.
- **Card binding.** Card rendering binds a spawn or wait action to `state.subAgents` through the `agentId` in the spawn output or wait input. A card whose agent isn't in `state.subAgents` renders from the action alone and can't be opened.
- **Removals.** Delete `subagentSection`, `subagentTranscriptSection`, the synthetic subagent action, `subAgentCursor` Tab toggling, and the subagent-only inspector state (`liveEvents`). Update `docs/product-experience.md` and `docs/codemode.md`.

## Delivery

1. Extract `TranscriptSlice` with no behavior change. Existing transcript tests stay green.
2. Add the child view: focus state, hydration, live reduction, status strip, sibling cycling, and back navigation. Delete the subagent inspector branch.
3. Replace the panel with the agent strip, including collapse, the inactive toggle, the child-driven pulse, and spatial `ctrl+o` navigation.
4. Add inline agent cards, batch cards, the `agents.wait` subject, and the completion block heading.
5. Update the product docs.

## Validation

- **Unit tests** cover:
  - slice reduction
  - child hydration and reload deduplication
  - strip rendering, collapsed and expanded, with mixed routes
  - card and batch rendering and agent binding
  - the navigation key map
- **Acceptance** uses Pi AgentHarness with the credential-free controlled provider for the runtime identities a child view depends on; the keyboard flow is covered by a TUI lifecycle test.
- **Real-model check.** Verify locally against a real model through the real TUI over a PTY. CI stays credential-free.

## Implementation record

Built on 2026-10-26. Where the build departed from the decisions above, this record wins.

- **Overlay, not a transcript swap.** The session transcript lives in terminal scrollback, and pi-tui repaints the whole screen when rows above the viewport change. An opened agent is therefore a full-screen, non-capturing overlay (`agent-view.ts`) rendered by its own instance of the session's transcript renderer, with the read-only agent line, status line, and hints at the bottom. Closing it reveals the session unchanged.
- **Slice.** `TuiTranscriptSlice` (`transcript-slice.ts`) is what the renderer reads; `NoesisTuiState` satisfies it, and the agent view builds one from `agentView`. `reduceTimeline` is shared by the foreground reducer and live child events. Speaker labels are part of the slice: a child shows `TASK` for its requester and its own name for the assistant.
- **Cards stay static.** Spawn cards show the agent's outcome (`running`, `done · 0:15`, `failed`, `stopped`) and change only when it changes. Elapsed time, activity, and the pulse live in the strip and the agent view, which are always on screen. There is no batch card: spawns from one `execute` already render as sibling rows under it, each selectable and openable.
- **Completion blocks are not openable.** A reminder carries no structured agent identity, and reading one out of its text is not worth the coupling. The block's overflow hint points to `ctrl+o`.
- **Outcome before lifecycle.** A suspended or closed actor whose task completed reads as done. Settled elapsed time runs to the latest task's completion, not to the actor's last update.
- **Siblings** are agents with the same origin session and parent agent, running first, then finished newest first.
- **Task message.** The runtime records an agent's incoming mailbox messages as system notes headed `[sender → recipient]`. The child view parses that header syntactically and shows a message addressed to the agent as its `TASK` turn.
- **Runtime fixes found by the real-model run.**
  - Live subagent action events were published with Pi's raw call IDs, while the durable transcript uses task-prefixed IDs. A reload then duplicated every live tool row. `runtime-composition.ts` now emits the durable event, matching the foreground.
  - The transcript loader unwrapped the broker envelope only for nested calls, so direct `shell.run` and `files.read` rows lost their input after a reload, in children and in the foreground. It now unwraps any broker-recorded request.

### Validation run

- Unit and TUI tests: `packages/tui/test/agent-view.test.ts` (new), plus `rendering`, `reducer`, `run-inspector`, and `lifecycle` (an end-to-end keyboard test through `startNoesisTui`: strip, open, live delta, Right to the sibling, Esc twice, draft restored).
- Acceptance: `apps/noesis/test/codemode-acceptance.test.ts` asserts that live child action IDs equal durable IDs and that a direct child `files.read` keeps its input. The assertion fails with the runtime fix reverted.
- Real model: `openai-codex/gpt-6-astra` through `scripts/noesis-dev` over a PTY spawned two scouts. The collapsed strip, focused strip, spawn cards, live child view, sibling cycling, back navigation, and settled cards rendered as designed.

