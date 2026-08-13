import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import {
  createSessionPickerItems,
  createStatusFields,
  createTuiLayout,
  elideText,
  executionForInteractionPhase,
  formatContextUsage,
  helpHint,
  initialTuiState,
  reduceTui,
  renderBottomChrome,
  renderHeader,
  renderNoesisState,
  renderQueuedInputs,
  safeTerminalText,
  sessionPickerVisibleCount,
  shouldUseColor,
} from "../src/index.ts";

describe("Noesis TUI reducer", () => {
  test("derives execution state from interaction lifecycle without hiding active work", () => {
    expect(executionForInteractionPhase("aborting", "running")).toBe("thinking");
    expect(executionForInteractionPhase("tool", "running")).toBeUndefined();
    expect(executionForInteractionPhase("error", "idle")).toBeUndefined();
    expect(executionForInteractionPhase("compacting", "idle")).toBeUndefined();
    expect(executionForInteractionPhase("streaming", "interrupting")).toBe("aborting");
  });

  test("uses the built-in Codex model and reasoning defaults", () => {
    expect(initialTuiState("pi")).toMatchObject({
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningLevel: "high",
    });
  });

  test("builds deterministic picker rows in most-recently-active order", () => {
    const items = createSessionPickerItems([
      {
        trailId: "trail_11111111-1111-1111-1111-111111111111",
        title: "older",
        status: "idle",
        provider: "fake",
        model: "model-1",
        runtime: "fake",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:01:00.000Z",
        turnCount: 1,
        messageCount: 2,
        preview: "first user message\nwith spacing",
      },
      {
        trailId: "trail_22222222-2222-2222-2222-222222222222",
        title: "newer",
        status: "failed",
        provider: "openrouter",
        model: "model-2",
        runtime: "pi",
        createdAt: "2026-01-01T00:02:00.000Z",
        updatedAt: "2026-01-01T00:03:00.000Z",
        turnCount: 3,
        messageCount: 6,
        preview: "newest conversation",
      },
      {
        trailId: "trail_00000000-0000-0000-0000-000000000000",
        title: "newer tie",
        status: "idle",
        provider: "fake",
        model: "model-3",
        runtime: "fake",
        createdAt: "2026-01-01T00:02:00.000Z",
        updatedAt: "2026-01-01T00:03:00.000Z",
        turnCount: 0,
        messageCount: 0,
        preview: "stable tie winner",
      },
    ]);

    expect(items.map((item) => item.value)).toEqual([
      "trail_00000000-0000-0000-0000-000000000000",
      "trail_22222222-2222-2222-2222-222222222222",
      "trail_11111111-1111-1111-1111-111111111111",
    ]);
    expect(items[1]?.label).toContain("trail_22222222");
    expect(items[1]?.label).toContain("failed  openrouter/model-2  3t/6m");
    expect(items[2]?.description).toBe("first user message with spacing");
  });

  test("renders polished transcript hierarchy and immutable inspection panes", () => {
    let state = reduceTui(initialTuiState("fake"), {
      type: "trail-selected",
      trail: {
        trailId: "trail-1",
        title: "test",
        status: "idle",
        provider: "fake",
        model: "model-1",
        runtime: "fake",
        turns: [],
        capabilityVersions: {},
      },
    });
    state = reduceTui(state, { type: "prompt-submitted", text: "hello" });
    state = reduceTui(state, { type: "stream-delta", text: "world" });
    state = reduceTui(state, {
      type: "turn-completed",
      context: {
        schemaVersion: 1,
        snapshotId: "ctx-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        maxTokens: 10,
        usedTokens: 1,
        fragments: [],
        capabilityVersions: { research: 2 },
      },
      capabilityVersions: { research: 2 },
      turnCount: 1,
    });
    const transcript = renderNoesisState(state, 100, 30).join("\n");
    const context = renderNoesisState(
      reduceTui(state, { type: "pane-selected", pane: "context" }),
      100,
      30,
    ).join("\n");
    const capabilities = renderNoesisState(
      reduceTui(state, { type: "pane-selected", pane: "capabilities" }),
      100,
      30,
    ).join("\n");

    expect(transcript).toContain("NOESIS\n  world");
    expect(renderBottomChrome(state, 100, 30).join("\n")).toContain("● IDLE");
    expect(renderBottomChrome(state, 100, 30).join("\n")).toContain("ctx   —");
    expect(context).toContain("NOESIS");
    expect(capabilities).toContain("capability> research@2");
  });

  test("keeps a delivered steer inline between streamed assistant segments", () => {
    let state = initialTuiState("fake");
    state = reduceTui(state, { type: "prompt-submitted", text: "initial" });
    state = reduceTui(state, { type: "stream-delta", text: "before steer" });
    state = reduceTui(state, { type: "steer-delivered", text: "change direction" });
    state = reduceTui(state, { type: "stream-delta", text: "after steer" });

    expect(state.timeline).toEqual([
      { kind: "message", role: "user", text: "initial" },
      { kind: "message", role: "assistant", text: "before steer" },
      { kind: "message", role: "user", text: "change direction" },
      { kind: "message", role: "assistant", text: "after steer" },
    ]);
  });

  test("chooses deterministic responsive header modes and bounds inspection panes", () => {
    expect(createTuiLayout(120, 35)).toMatchObject({
      widthClass: "wide",
      headerMode: "ascii",
    });
    expect(createTuiLayout(90, 28)).toMatchObject({
      widthClass: "normal",
      headerMode: "compact",
    });
    expect(createTuiLayout(70, 22)).toMatchObject({
      widthClass: "narrow",
      headerMode: "compact",
    });
    expect(createTuiLayout(50, 8)).toMatchObject({
      widthClass: "narrow",
      headerMode: "none",
    });
    expect(createTuiLayout(90, 28).paneRows).toBeGreaterThan(createTuiLayout(50, 8).paneRows);
    expect(sessionPickerVisibleCount(30)).toBe(10);
    expect(sessionPickerVisibleCount(7)).toBe(4);
    expect(sessionPickerVisibleCount(3)).toBe(1);
  });

  test("renders the whole conversation instead of cropping it to the viewport", () => {
    const crowded = {
      ...initialTuiState("fake"),
      timeline: Array.from({ length: 20 }, (_, index) => ({
        kind: "message" as const,
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        text: `message ${index}`,
      })),
    };
    const rendered = renderNoesisState(crowded, 50, 9);

    // Output taller than the terminal reaches native terminal scrollback, so nothing is dropped
    // and no "earlier conversation" placeholder stands in for unreachable history.
    expect(rendered.length).toBeGreaterThan(9);
    expect(rendered.join("\n")).toContain("message 0");
    expect(rendered.join("\n")).toContain("message 19");
    expect(rendered.join("\n")).not.toContain("earlier conversation");
  });

  test("shows the banner only while it fits and never pins it to the viewport", () => {
    expect(renderHeader(false, 100, 34).join("\n")).toContain("think · learn · create · grow");
    expect(renderHeader(false, 90, 28).join("\n")).toContain("NOESIS");
    expect(renderHeader(false, 30, 8)).toEqual([]);
    // The banner is not part of the conversation view, so a long transcript scrolls past it.
    expect(renderNoesisState(initialTuiState("fake"), 100, 34).join("\n")).not.toContain("NOESIS");
  });

  test("elides Unicode and ANSI text by visible columns", () => {
    const colored = "\u001b[31mNOESIS界面\u001b[0m";
    const elided = elideText(colored, 8);
    expect(visibleWidth(elided)).toBeLessThanOrEqual(8);
    expect(elided).toContain("…");
    expect(safeTerminalText("provider\u001b[31m error\u0007")).toBe("provider [31m error ");
  });

  test("formats context percentages honestly and clamps overflow", () => {
    expect(formatContextUsage(undefined)).toEqual({ percent: "ctx   —" });
    expect(
      formatContextUsage({
        usedTokens: 32_000,
        contextWindow: 114_000,
        accuracy: "reported",
      }),
    ).toEqual({
      percent: "ctx  28%",
      tokens: "32k/114k",
    });
    expect(
      formatContextUsage({
        usedTokens: 1_000,
        contextWindow: 8_000,
        accuracy: "estimated",
      }).percent,
    ).toBe("ctx ~13%");
    expect(
      formatContextUsage({
        usedTokens: 200_000,
        contextWindow: 100_000,
        accuracy: "reported",
      }).percent,
    ).toBe("ctx  100%");
  });

  test("drops low-priority status fields before essential state, model, and context", () => {
    const state = {
      ...initialTuiState("pi", {
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        reasoningLevel: "xhigh",
      }),
      trailId: "trail_69b186a1-0000-0000-0000-000000000000",
      turnCount: 12,
      contextUsage: {
        usedTokens: 32_000,
        contextWindow: 114_000,
        accuracy: "reported" as const,
      },
      capabilityVersions: { research: 1, writing: 2 },
    };
    const wide = createStatusFields(state, createTuiLayout(120, 35)).join(" | ");
    const normal = createStatusFields(state, createTuiLayout(90, 28)).join(" | ");
    const narrow = createStatusFields(state, createTuiLayout(70, 22)).join(" | ");

    expect(wide).toContain("32k/114k");
    expect(wide).toContain("2 caps");
    expect(wide).not.toContain("69b186a1");
    expect(wide).not.toContain("session");
    expect(normal).toContain("xhigh");
    expect(normal).not.toContain("2 caps");
    expect(normal).not.toContain("69b186a1");
    expect(narrow).toContain("openai-codex/gpt-5.6-sol");
    expect(narrow).toContain("ctx  28%");
    expect(narrow).not.toContain("session");
  });

  test("renders the newest queued inputs with delivery state and interaction shortcuts", () => {
    const state = reduceTui(initialTuiState("fake"), {
      type: "interaction-changed",
      interaction: {
        phase: "running",
        queuePaused: false,
        active: {
          intentId: "intent-active",
          turnId: "turn-active",
          text: "active",
        },
        queuedInputs: [
          { queueId: "q1", text: "first\nmessage", createdAt: "2026-07-31T10:00:00.000Z" },
          { queueId: "q2", text: "second", createdAt: "2026-07-31T10:00:01.000Z" },
          { queueId: "q3", text: "third", createdAt: "2026-07-31T10:00:02.000Z" },
          {
            queueId: "q4",
            text: "newest",
            createdAt: "2026-07-31T10:00:03.000Z",
            status: "held",
          },
        ],
      },
    });

    const queue = renderQueuedInputs(state, 60).join("\n");
    expect(queue).toContain("QUEUED · 4");
    expect(queue).toContain("holding steer");
    expect(queue).toContain("… 1 earlier");
    expect(queue).not.toContain("first message");
    expect(queue).toContain("4→ newest");
    expect(createStatusFields(state, createTuiLayout(120, 35))).toContain("q 4");
    expect(helpHint(state)).toContain("enter queue");
    expect(helpHint(state)).toContain("/steer redirect");
    expect(helpHint(state)).toContain("esc interrupt");
  });

  test("shows a resumed queue as paused until explicitly resumed", () => {
    const state = reduceTui(initialTuiState("fake"), {
      type: "interaction-changed",
      interaction: {
        phase: "idle",
        queuePaused: true,
        queuedInputs: [{ queueId: "q1", text: "continue later", createdAt: "2026-07-31T10:00:00.000Z" }],
      },
    });

    expect(renderQueuedInputs(state, 60).join("\n")).toContain("QUEUED · 1 · paused");
    expect(createStatusFields(state, createTuiLayout(90, 28))).toContain("q 1 paused");
    expect(helpHint(state)).toContain("/queue resume");
    expect(helpHint(state)).not.toContain("/steer promote newest");
  });

  test("shows command-owned queued work as waiting for compaction", () => {
    const queued = reduceTui(initialTuiState("fake"), {
      type: "interaction-changed",
      interaction: {
        phase: "idle",
        queuePaused: true,
        queuedInputs: [{ queueId: "q1", text: "after compact", createdAt: "2026-07-31T10:00:00.000Z" }],
      },
    });
    const state = reduceTui(queued, { type: "execution-changed", execution: "compacting" });

    expect(helpHint(state)).toBe("enter queue · waiting for compaction · alt+↑ edit newest");
    expect(helpHint(state)).not.toContain("/queue resume");
  });

  test("maps lifecycle actions to supported execution states", () => {
    let state = reduceTui(initialTuiState("fake"), {
      type: "prompt-submitted",
      text: "think",
    });
    expect(state.execution).toBe("thinking");
    state = reduceTui(state, { type: "stream-delta", text: "answer" });
    expect(state.execution).toBe("streaming");
    state = reduceTui(state, {
      type: "action-started",
      actionId: "tool-1",
      name: "inspect",
      input: { section: "memory" },
    });
    expect(state).toMatchObject({ execution: "tool", activeTool: "inspect" });
    state = reduceTui(state, {
      type: "action-updated",
      actionId: "tool-1",
      update: { status: "reading" },
    });
    state = reduceTui(state, {
      type: "action-ended",
      actionId: "tool-1",
      output: { memories: 2 },
      isError: false,
    });
    expect(state.execution).toBe("thinking");
    expect(state.timeline.filter((entry) => entry.kind === "action")).toEqual([
      {
        kind: "action",
        actionId: "tool-1",
        name: "inspect",
        status: "completed",
        input: { section: "memory" },
        update: { status: "reading" },
        output: { memories: 2 },
      },
    ]);
    state = reduceTui(state, {
      type: "action-expansion-toggled",
      actionId: "tool-1",
    });
    expect(state.expandedActionIds.has("tool-1")).toBe(true);
    state = reduceTui(state, {
      type: "action-started",
      actionId: "execute-1",
      name: "execute",
      input: { source: "return 1;" },
    });
    state = reduceTui(state, {
      type: "action-started",
      actionId: "execute-1:call:0",
      parentActionId: "execute-1",
      name: "shell.run",
      input: { command: "pwd" },
    });
    state = reduceTui(state, {
      type: "action-ended",
      actionId: "execute-1:call:0",
      output: { stdout: "/workspace" },
      isError: false,
    });
    expect(state).toMatchObject({ execution: "tool", activeTool: "execute" });
    state = reduceTui(state, {
      type: "action-ended",
      actionId: "execute-1",
      output: { calls: 1 },
      isError: false,
    });
    state = reduceTui(state, { type: "prompt-submitted", text: "next turn" });
    expect(
      state.timeline.filter((entry) => entry.kind === "action").map((entry) => entry.actionId),
    ).toContain("tool-1");
    // Expansion is a deliberate per-row choice, so a later prompt does not silently collapse it.
    expect(state.expandedActionIds.has("tool-1")).toBe(true);
    expect(state.expandedActionIds.has("execute-1")).toBe(false);
    state = reduceTui(state, {
      type: "execution-changed",
      execution: "compacting",
    });
    expect(state.execution).toBe("compacting");
    state = reduceTui(state, {
      type: "execution-changed",
      execution: "aborting",
    });
    expect(state.execution).toBe("aborting");
    state = reduceTui(state, { type: "failed", error: "provider failed" });
    expect(state.execution).toBe("error");
  });

  test("keeps assistant text and tool actions in their chronological order", () => {
    let state = reduceTui(initialTuiState("fake"), {
      type: "prompt-submitted",
      text: "find something",
    });
    state = reduceTui(state, { type: "stream-delta", text: "I will check." });
    state = reduceTui(state, {
      type: "action-started",
      actionId: "tool-1",
      name: "shell.run",
      input: { command: "pwd" },
    });
    state = reduceTui(state, {
      type: "action-ended",
      actionId: "tool-1",
      output: { stdout: "/workspace" },
      isError: false,
    });
    state = reduceTui(state, {
      type: "stream-delta",
      text: "The workspace is ready.",
    });

    expect(state.timeline).toEqual([
      { kind: "message", role: "user", text: "find something" },
      { kind: "message", role: "assistant", text: "I will check." },
      {
        kind: "action",
        actionId: "tool-1",
        name: "shell.run",
        status: "completed",
        input: { command: "pwd" },
        output: { stdout: "/workspace" },
      },
      { kind: "message", role: "assistant", text: "The workspace is ready." },
    ]);
    expect(state.execution).toBe("streaming");
  });

  test("updates nested tools in place while the outer tool remains active", () => {
    let state = reduceTui(initialTuiState("fake"), {
      type: "action-started",
      actionId: "execute-1",
      name: "execute",
      input: { source: "return await noesis.invoke('shell.run', {});" },
    });
    state = reduceTui(state, {
      type: "action-started",
      actionId: "execute-1:call:0",
      parentActionId: "execute-1",
      name: "shell.run",
      input: { command: "pwd" },
    });
    state = reduceTui(state, {
      type: "action-ended",
      actionId: "execute-1:call:0",
      output: { stdout: "/workspace" },
      isError: false,
    });

    expect(state.timeline.map((entry) => (entry.kind === "action" ? entry.actionId : entry.role))).toEqual([
      "execute-1",
      "execute-1:call:0",
    ]);
    expect(state).toMatchObject({ execution: "tool", activeTool: "execute" });

    state = reduceTui(state, {
      type: "action-ended",
      actionId: "execute-1",
      output: { calls: 1 },
      isError: false,
    });
    expect(state.execution).toBe("thinking");
    expect(state.activeTool).toBeUndefined();
  });

  test("reconciles only the final assistant segment around tool actions", () => {
    let state = reduceTui(initialTuiState("fake"), {
      type: "prompt-submitted",
      text: "inspect",
    });
    state = reduceTui(state, { type: "stream-delta", text: "Checking now." });
    state = reduceTui(state, {
      type: "action-started",
      actionId: "inspect-1",
      name: "inspect",
    });
    state = reduceTui(state, {
      type: "action-ended",
      actionId: "inspect-1",
      isError: false,
    });
    state = reduceTui(state, { type: "stream-delta", text: "Draft answer" });
    state = reduceTui(state, {
      type: "stream-reconciled",
      text: "Final answer",
    });

    expect(state.timeline).toEqual([
      { kind: "message", role: "user", text: "inspect" },
      { kind: "message", role: "assistant", text: "Checking now." },
      {
        kind: "action",
        actionId: "inspect-1",
        name: "inspect",
        status: "completed",
      },
      { kind: "message", role: "assistant", text: "Final answer" },
    ]);

    let withoutPostToolDelta = reduceTui(initialTuiState("fake"), {
      type: "stream-delta",
      text: "Checking now.",
    });
    withoutPostToolDelta = reduceTui(withoutPostToolDelta, {
      type: "action-started",
      actionId: "inspect-2",
      name: "inspect",
    });
    withoutPostToolDelta = reduceTui(withoutPostToolDelta, {
      type: "action-ended",
      actionId: "inspect-2",
      isError: false,
    });
    withoutPostToolDelta = reduceTui(withoutPostToolDelta, {
      type: "stream-reconciled",
      text: "Authoritative final answer",
    });
    expect(withoutPostToolDelta.timeline).toEqual([
      { kind: "message", role: "assistant", text: "Checking now." },
      {
        kind: "action",
        actionId: "inspect-2",
        name: "inspect",
        status: "completed",
      },
      {
        kind: "message",
        role: "assistant",
        text: "Authoritative final answer",
      },
    ]);
  });

  test("waits for the authoritative transcript instead of reconstructing trail turns", () => {
    const state = reduceTui(initialTuiState("fake"), {
      type: "trail-selected",
      trail: {
        trailId: "trail-1",
        title: "resumed",
        status: "idle",
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        runtime: "pi",
        turns: [
          { input: "first", output: "one" },
          { input: "second", output: "two" },
        ],
        capabilityVersions: {},
      },
    });

    expect(state.timeline).toEqual([]);
    expect(state.execution).toBe("idle");
    expect(state.turnCount).toBe(2);
  });

  test("hydrates the authoritative transcript with interleaved inspectable actions", () => {
    let state = reduceTui(initialTuiState("fake"), {
      type: "trail-selected",
      trail: {
        trailId: "trail-1",
        title: "resumed",
        status: "idle",
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        runtime: "pi",
        turns: [{ input: "legacy", output: "fallback" }],
        capabilityVersions: {},
      },
    });
    state = reduceTui(state, {
      type: "transcript-hydrated",
      trailId: "trail-1",
      transcript: [
        {
          kind: "message",
          messageId: "message-user",
          turnId: "turn-1",
          role: "user",
          text: "inspect the repo",
          createdAt: "2026-07-31T10:00:00.000Z",
        },
        {
          kind: "action",
          actionId: "execute-1",
          turnId: "turn-1",
          executionId: "execution-1",
          name: "execute",
          status: "completed",
          input: { source: "return await tools.files.read({ path: 'README.md' });" },
          output: { calls: 1 },
          startedAt: "2026-07-31T10:00:01.000Z",
          completedAt: "2026-07-31T10:00:03.500Z",
        },
        {
          kind: "action",
          actionId: "call-1",
          turnId: "turn-1",
          parentActionId: "execute-1",
          name: "files.read",
          status: "cancelled",
          input: { path: "README.md" },
          output: { error: "cancelled by user" },
          startedAt: "2026-07-31T10:00:02.000Z",
          completedAt: "2026-07-31T10:00:02.250Z",
        },
        {
          kind: "message",
          messageId: "message-assistant",
          turnId: "turn-1",
          role: "assistant",
          text: "I stopped before finishing.",
          createdAt: "2026-07-31T10:00:04.000Z",
        },
      ],
    });

    expect(state.timeline).toEqual([
      {
        kind: "message",
        messageId: "message-user",
        turnId: "turn-1",
        role: "user",
        text: "inspect the repo",
        createdAt: "2026-07-31T10:00:00.000Z",
      },
      {
        kind: "action",
        actionId: "execute-1",
        turnId: "turn-1",
        executionId: "execution-1",
        name: "execute",
        status: "completed",
        input: { source: "return await tools.files.read({ path: 'README.md' });" },
        output: { calls: 1 },
        startedAt: Date.parse("2026-07-31T10:00:01.000Z"),
        durationMs: 2_500,
      },
      {
        kind: "action",
        actionId: "call-1",
        turnId: "turn-1",
        parentActionId: "execute-1",
        name: "files.read",
        status: "cancelled",
        input: { path: "README.md" },
        output: { error: "cancelled by user" },
        startedAt: Date.parse("2026-07-31T10:00:02.000Z"),
        durationMs: 250,
      },
      {
        kind: "message",
        messageId: "message-assistant",
        turnId: "turn-1",
        role: "assistant",
        text: "I stopped before finishing.",
        createdAt: "2026-07-31T10:00:04.000Z",
      },
    ]);
    expect(renderNoesisState(state, 100, 30).join("\n")).toContain("■ files.read  README.md · cancelled");
  });

  test("ignores transcript hydration from a superseded session", () => {
    const state = reduceTui(
      reduceTui(
        reduceTui(initialTuiState("fake"), {
          type: "trail-selected",
          trail: {
            trailId: "trail-current",
            title: "current",
            status: "idle",
            provider: "fake",
            model: "model",
            runtime: "fake",
            turns: [{ input: "current", output: "answer" }],
            capabilityVersions: {},
          },
        }),
        {
          type: "transcript-hydrated",
          trailId: "trail-current",
          transcript: [
            {
              kind: "message",
              messageId: "current-user",
              turnId: "turn-current",
              role: "user",
              text: "current",
              createdAt: "2026-07-31T10:00:00.000Z",
            },
          ],
        },
      ),
      {
        type: "transcript-hydrated",
        trailId: "trail-stale",
        transcript: [],
      },
    );

    expect(state.timeline).toEqual([
      {
        kind: "message",
        messageId: "current-user",
        turnId: "turn-current",
        role: "user",
        text: "current",
        createdAt: "2026-07-31T10:00:00.000Z",
      },
    ]);
  });

  test("records action durations from the dispatched clock", () => {
    let state = reduceTui(initialTuiState("fake"), {
      type: "action-started",
      actionId: "execute-1",
      name: "execute",
      input: { source: "return 1;" },
      at: 1_000,
    });
    state = reduceTui(state, {
      type: "action-ended",
      actionId: "execute-1",
      output: { calls: 0 },
      isError: false,
      at: 2_500,
    });

    const [action] = state.timeline.filter((entry) => entry.kind === "action");
    expect(action).toMatchObject({ startedAt: 1_000, durationMs: 1_500 });
  });

  test("moves a transcript cursor across actions and leaves it on demand", () => {
    let state = initialTuiState("fake");
    for (const actionId of ["a1", "a2", "a3"])
      state = reduceTui(state, {
        type: "action-started",
        actionId,
        name: "files.read",
      });

    // Entering navigation lands on the most recent action.
    state = reduceTui(state, {
      type: "action-cursor-moved",
      direction: "previous",
    });
    expect(state.actionCursor).toBe("a3");
    state = reduceTui(state, {
      type: "action-cursor-moved",
      direction: "previous",
    });
    expect(state.actionCursor).toBe("a2");
    state = reduceTui(state, {
      type: "action-cursor-moved",
      direction: "next",
    });
    expect(state.actionCursor).toBe("a3");
    // The cursor clamps rather than wrapping, so it cannot fall off either end.
    state = reduceTui(state, {
      type: "action-cursor-moved",
      direction: "next",
    });
    expect(state.actionCursor).toBe("a3");
    state = reduceTui(state, { type: "action-cursor-cleared" });
    expect(state.actionCursor).toBeUndefined();
  });

  test("never enters navigation when the transcript holds no actions", () => {
    const state = reduceTui(initialTuiState("fake"), {
      type: "action-cursor-moved",
      direction: "previous",
    });
    expect(state.actionCursor).toBeUndefined();
  });

  test("drops inspector results that a newer selection has superseded", () => {
    let state = reduceTui(initialTuiState("fake"), {
      type: "action-started",
      actionId: "execute-1",
      name: "execute",
    });
    state = reduceTui(state, {
      type: "inspector-opened",
      actionId: "execute-1",
    });
    expect(state.inspector).toMatchObject({
      actionId: "execute-1",
      status: "loading",
      view: "semantic",
      scroll: 0,
    });

    const stale = reduceTui(state, {
      type: "inspector-loaded",
      actionId: "execute-0",
    });
    expect(stale.inspector?.status).toBe("loading");

    state = reduceTui(state, {
      type: "inspector-loaded",
      actionId: "execute-1",
    });
    expect(state.inspector?.status).toBe("fallback");

    state = reduceTui(state, {
      type: "inspector-scrolled",
      delta: 50,
      maxScroll: 8,
    });
    expect(state.inspector?.scroll).toBe(8);
    state = reduceTui(state, {
      type: "inspector-scrolled",
      delta: -50,
      maxScroll: 8,
    });
    expect(state.inspector?.scroll).toBe(0);
    state = reduceTui(state, {
      type: "inspector-scrolled",
      delta: 7,
      maxScroll: 8,
    });
    state = reduceTui(state, {
      type: "inspector-scrolled",
      delta: 0,
      maxScroll: 3,
    });
    expect(state.inspector?.scroll).toBe(3);

    state = reduceTui(state, { type: "inspector-view-toggled" });
    expect(state.inspector).toMatchObject({ view: "raw", scroll: 0 });
    state = reduceTui(state, { type: "inspector-view-toggled" });
    expect(state.inspector).toMatchObject({ view: "semantic", scroll: 0 });

    state = reduceTui(state, { type: "inspector-closed" });
    expect(state.inspector).toBeUndefined();
  });

  test("honors NO_COLOR and emits no styling when color is disabled", () => {
    expect(shouldUseColor({ TERM: "xterm-256color" })).toBe(true);
    expect(shouldUseColor({ TERM: "xterm-256color", NO_COLOR: "" })).toBe(false);
    expect(shouldUseColor({ TERM: "dumb" })).toBe(false);
    expect(renderNoesisState(initialTuiState("fake"), 70, 22).join("\n")).not.toContain("\u001b[");
    expect(
      renderNoesisState(
        initialTuiState("fake", {
          provider: "provider-with-a-very-long-name",
          model: "model-with-a-very-long-name",
        }),
        80,
        24,
      ).join("\n"),
    ).not.toContain("\u001b[");
    expect(renderNoesisState(initialTuiState("fake", { colorEnabled: true }), 70, 22).join("\n")).toContain(
      "\u001b[",
    );
  });
});
