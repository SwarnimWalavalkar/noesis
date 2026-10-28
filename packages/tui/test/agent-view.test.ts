import { visibleWidth } from "@earendil-works/pi-tui";
import type { SubAgentSummary } from "@noesis/agent-types";
import type { RuntimeTranscriptEntry } from "@noesis/runtime";
import { describe, expect, test } from "vitest";
import { renderAgentViewFrame } from "../src/agent-view.ts";
import { createTranscriptRenderer, initialTuiState, type NoesisTuiState, reduceTui } from "../src/index.ts";
import { siblingAgents } from "../src/state.ts";
import { mergeDurableTimeline } from "../src/transcript-slice.ts";

const SGR_PATTERN = new RegExp(`${String.fromCodePoint(27)}\\[[0-9;]*m`, "gu");
const stripAnsi = (text: string): string => text.replaceAll(SGR_PATTERN, "");

const agent = (agentId: string, status: SubAgentSummary["status"], name: string): SubAgentSummary =>
  Object.freeze({
    agentId,
    childSessionId: `session-${agentId}`,
    projectId: "project-test",
    originSessionId: "session-foreground",
    name,
    status,
    route: Object.freeze({ provider: "child-provider", model: "child-model" }),
    thinkingLevel: "high",
    latestTaskId: `task-${agentId}`,
    latestTaskStatus: status === "running" ? "running" : "completed",
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:01:00.000Z",
  });

const durableTranscript: readonly RuntimeTranscriptEntry[] = [
  {
    kind: "message",
    messageId: "m-task",
    role: "user",
    text: "Map how capability versions freeze.",
    createdAt: "2026-08-31T00:00:00.000Z",
  },
  {
    kind: "reasoning",
    reasoningId: "r-1",
    text: "Start with turn admission.",
    createdAt: "2026-08-31T00:00:01.000Z",
  },
  {
    kind: "action",
    actionId: "round-1",
    name: "model.round",
    status: "completed",
    input: { round: 1 },
    output: { inputTokens: 900, outputTokens: 300, totalTokens: 1200, estimatedCost: 0 },
    startedAt: "2026-08-31T00:00:01.000Z",
  },
  {
    kind: "action",
    actionId: "read-1",
    name: "files.read",
    status: "completed",
    input: { path: "src/turn.ts" },
    output: { path: "src/turn.ts", totalLines: 212 },
    startedAt: "2026-08-31T00:00:02.000Z",
    completedAt: "2026-08-31T00:00:03.000Z",
  },
];

function openedState(): NoesisTuiState {
  const state: NoesisTuiState = {
    ...initialTuiState("fake"),
    trailId: "session-foreground",
    title: "Capability audit",
    subAgents: [agent("agent-a", "running", "lifecycle"), agent("agent-b", "running", "runtime")],
  };
  return reduceTui(state, { type: "agent-view-opened", agentId: "agent-a", parents: [] });
}

describe("subagent view", () => {
  test("hydrates the child transcript without model rounds and totals their usage", () => {
    const state = reduceTui(openedState(), {
      type: "agent-view-hydrated",
      agentId: "agent-a",
      transcript: durableTranscript,
      systemPrompt: "You are a focused subagent.\nReport facts.",
    });
    const view = state.agentView;
    expect(view?.status).toBe("ready");
    expect(view?.timeline.map((entry) => (entry.kind === "action" ? entry.name : entry.kind))).toEqual([
      "message",
      "reasoning",
      "files.read",
    ]);
    expect(view?.totalTokens).toBe(1200);
  });

  test("streams live events in order and keeps the whole live message", () => {
    let state = openedState();
    for (const text of ["Looking ", "at ", "turn ", "admission."])
      state = reduceTui(state, {
        type: "subagent-live-event",
        agentId: "agent-a",
        event: { type: "reasoning-delta", text },
      });
    state = reduceTui(state, {
      type: "subagent-live-event",
      agentId: "agent-a",
      event: { type: "tool-start", actionId: "shell-1", name: "shell.run", input: { command: "rg freeze" } },
    });
    for (let index = 0; index < 150; index += 1)
      state = reduceTui(state, {
        type: "subagent-live-event",
        agentId: "agent-a",
        event: { type: "delta", text: "x" },
      });
    // Events for another agent never touch the opened view.
    state = reduceTui(state, {
      type: "subagent-live-event",
      agentId: "agent-b",
      event: { type: "delta", text: "other agent" },
    });
    const timeline = state.agentView?.timeline ?? [];
    expect(timeline.map((entry) => entry.kind)).toEqual(["reasoning", "action", "message"]);
    expect(timeline[0]).toMatchObject({ text: "Looking at turn admission." });
    expect(timeline[2]).toMatchObject({ role: "assistant", text: "x".repeat(150) });
    expect(state.agentView?.execution).toBe("streaming");
  });

  test("a durable reload replaces persisted live content and keeps what is still in flight", () => {
    const merged = mergeDurableTimeline(
      [
        { kind: "reasoning", reasoningId: "r-1", text: "Start with turn admission." },
        { kind: "action", actionId: "read-1", name: "files.read", status: "completed" },
      ],
      [
        { kind: "reasoning", text: "Start with turn" },
        { kind: "action", actionId: "read-1", name: "files.read", status: "running" },
        { kind: "action", actionId: "shell-2", name: "shell.run", status: "running" },
        { kind: "message", role: "assistant", text: "Partial answer" },
      ],
    );
    expect(merged).toEqual([
      { kind: "reasoning", reasoningId: "r-1", text: "Start with turn admission." },
      { kind: "action", actionId: "read-1", name: "files.read", status: "completed" },
      { kind: "action", actionId: "shell-2", name: "shell.run", status: "running" },
      { kind: "message", role: "assistant", text: "Partial answer" },
    ]);
  });

  test("a reload read before a tool finished keeps the live result", () => {
    const finished = {
      kind: "action",
      actionId: "shell-1",
      name: "shell.run",
      status: "completed",
      output: "ok",
    } as const;
    expect(
      mergeDurableTimeline(
        [{ kind: "action", actionId: "shell-1", name: "shell.run", status: "running" }],
        [finished],
      ),
    ).toEqual([finished]);
  });

  test("a reload keeps only live text that no newer durable entry holds", () => {
    const earlier = { kind: "message", messageId: "m-old", role: "assistant", text: "Done." } as const;
    const anchor = { kind: "action", actionId: "read-1", name: "files.read", status: "completed" } as const;
    // An older durable reply that starts with the same text is never mistaken for the live one.
    expect(
      mergeDurableTimeline(
        [earlier, anchor],
        [earlier, anchor, { kind: "message", role: "assistant", text: "Done" }],
      ),
    ).toEqual([earlier, anchor, { kind: "message", role: "assistant", text: "Done" }]);
    // A view opened mid-stream holds only a suffix of the persisted reply.
    const persisted = {
      kind: "message",
      messageId: "m-new",
      role: "assistant",
      text: "Full reply text.",
    } as const;
    expect(
      mergeDurableTimeline(
        [anchor, persisted],
        [anchor, { kind: "message", role: "assistant", text: "reply text." }],
      ),
    ).toEqual([anchor, persisted]);
    // One live entry can span a persisted message and text that is still streaming.
    expect(
      mergeDurableTimeline(
        [anchor, persisted],
        [anchor, { kind: "message", role: "assistant", text: "Full reply text. And more" }],
      ),
    ).toEqual([anchor, persisted, { kind: "message", role: "assistant", text: "And more" }]);
  });

  test("ends a failed agent's transcript with the recorded failure reason", () => {
    const state = reduceTui(openedState(), {
      type: "agent-view-hydrated",
      agentId: "agent-a",
      transcript: durableTranscript.slice(0, 1),
      taskError: "Provider rejected the request: quota exceeded",
    });
    const rows = renderAgentViewFrame(state, 90, 16, createTranscriptRenderer()).rows.map(stripAnsi);
    expect(rows.join("\n")).toContain("Error · Provider rejected the request: quota exceeded");
    // The failure still closes a long transcript while an action is selected.
    let selecting = state;
    for (let index = 0; index < 30; index += 1)
      selecting = reduceTui(selecting, {
        type: "subagent-live-event",
        agentId: "agent-a",
        event: { type: "tool-start", actionId: `step-${String(index)}`, name: "shell.run", input: {} },
      });
    selecting = reduceTui(selecting, { type: "agent-view-cursor-moved", direction: "previous" });
    expect(
      renderAgentViewFrame(selecting, 90, 16, createTranscriptRenderer()).rows.map(stripAnsi).join("\n"),
    ).toContain("Error · Provider rejected the request");
    // A long multi-line failure stays one row, so the selected action remains in view.
    const verbose = reduceTui(selecting, {
      type: "agent-view-hydrated",
      agentId: "agent-a",
      transcript: durableTranscript.slice(0, 1),
      taskError: Array.from({ length: 40 }, (_, index) => `stack frame ${String(index)}`).join("\n"),
    });
    const verboseRows = renderAgentViewFrame(verbose, 90, 16, createTranscriptRenderer()).rows.map(stripAnsi);
    expect(verboseRows.some((row) => row.includes("▸"))).toBe(true);
    expect(verboseRows.filter((row) => row.includes("stack frame"))).toHaveLength(1);
    // A later successful task replaces the earlier failure.
    const recovered = reduceTui(state, {
      type: "agent-view-hydrated",
      agentId: "agent-a",
      transcript: durableTranscript,
    });
    expect(recovered.agentView?.taskError).toBeUndefined();
  });

  test("shows the complete reply from its boundary even without streamed deltas", () => {
    const state = reduceTui(openedState(), {
      type: "subagent-live-event",
      agentId: "agent-a",
      event: { type: "assistant-message", text: "Final answer.", timelineSequence: 3, createdAt: "x" },
    });
    expect(state.agentView?.timeline).toEqual([
      { kind: "message", role: "assistant", text: "Final answer." },
    ]);
  });

  test("renders like the session transcript with a read-only agent line instead of the composer", () => {
    let state = reduceTui(openedState(), {
      type: "agent-view-hydrated",
      agentId: "agent-a",
      transcript: durableTranscript,
      systemPrompt: "You are a focused subagent.",
    });
    state = reduceTui(state, {
      type: "subagent-live-event",
      agentId: "agent-a",
      event: { type: "delta", text: "Versions freeze at admission." },
    });
    const frame = renderAgentViewFrame(state, 90, 24, createTranscriptRenderer());
    expect(frame.rows).toHaveLength(24);
    expect(frame.rows.every((row) => visibleWidth(row) === 90)).toBe(true);
    const text = frame.rows.map(stripAnsi);
    const body = text.join("\n");
    expect(body).toContain("subagent of this session · child-provider/child-model · high");
    expect(body).toContain("system prompt · 1 line · s show");
    expect(body).toContain("TASK");
    expect(body).toContain("Map how capability versions freeze.");
    expect(body).toContain("∴ THINKING");
    expect(body).toContain("files.read  turn.ts · 212 lines");
    expect(body).toContain("LIFECYCLE");
    expect(body).toContain("Versions freeze at admission.");
    expect(body).not.toContain("model.round");
    expect(body).not.toContain("› message");
    // The transcript breathes above the agent line, and a rule sits where the composer would be.
    expect(text.at(-5)?.trim()).toBe("");
    expect(text.at(-4)).toContain("↳ SUBAGENT");
    expect(text.at(-4)).toContain("lifecycle");
    expect(text.at(-4)).toContain("read-only");
    expect(text.at(-3)).toMatch(/^─+$/u);
    expect(text.at(-2)).toContain("1.2k tok");
    expect(text.at(-1)).toContain("←/→ agents");
  });

  test("follows live output until scrolled back, and clears a selection before closing", () => {
    let state = openedState();
    for (let index = 0; index < 40; index += 1)
      state = reduceTui(state, {
        type: "subagent-live-event",
        agentId: "agent-a",
        event: {
          type: "tool-start",
          actionId: `t-${String(index)}`,
          name: "shell.run",
          input: { command: `step ${String(index)}` },
        },
      });
    const renderer = createTranscriptRenderer();
    const live = renderAgentViewFrame(state, 80, 12, renderer).rows.map(stripAnsi).join("\n");
    expect(live).toContain("step 39");
    expect(live).not.toContain("step 20");
    const { maxScroll, documentRows } = renderAgentViewFrame(state, 80, 12, renderer);
    state = reduceTui(state, { type: "agent-view-scrolled", delta: 20, maxScroll, documentRows });
    const scrolled = renderAgentViewFrame(state, 80, 12, renderer).rows.map(stripAnsi);
    expect(scrolled.join("\n")).not.toContain("step 39");
    expect(scrolled.join("\n")).toContain("rows above live");
    // New output while scrolled back leaves the visible transcript where the user put it.
    for (let index = 40; index < 48; index += 1)
      state = reduceTui(state, {
        type: "subagent-live-event",
        agentId: "agent-a",
        event: {
          type: "tool-start",
          actionId: `t-${String(index)}`,
          name: "shell.run",
          input: { command: `step ${String(index)}` },
        },
      });
    const held = renderAgentViewFrame(state, 80, 12, renderer).rows.map(stripAnsi);
    expect(held.slice(0, 6)).toEqual(scrolled.slice(0, 6));
    // Opening the system prompt above the transcript is not new output either.
    const prompted = reduceTui(
      reduceTui(state, {
        type: "agent-view-hydrated",
        agentId: "agent-a",
        transcript: [],
        systemPrompt: Array.from({ length: 10 }, (_, index) => `rule ${String(index)}`).join("\n"),
      }),
      { type: "agent-view-system-prompt-toggled" },
    );
    const promptedRows = renderAgentViewFrame(prompted, 80, 12, renderer).rows.map(stripAnsi);
    expect(promptedRows.slice(0, 6)).toEqual(scrolled.slice(0, 6));
    state = reduceTui(state, { type: "agent-view-cursor-moved", direction: "previous" });
    expect(state.agentView?.actionCursor).toBe("t-47");
    expect(state.agentView?.scroll).toBe(0);
    state = reduceTui(state, { type: "agent-view-cursor-cleared" });
    expect(state.agentView?.actionCursor).toBeUndefined();
    expect(reduceTui(state, { type: "agent-view-closed" }).agentView).toBeUndefined();
  });

  test("restores a parent agent's selection, expansion, and scroll when returning to it", () => {
    const restored = reduceTui(openedState(), {
      type: "agent-view-opened",
      agentId: "agent-a",
      parents: [],
      navigation: {
        actionCursor: "read-1",
        expandedActionIds: new Set(["read-1"]),
        scroll: 4,
        scrollAnchor: 30,
      },
    });
    expect(restored.agentView).toMatchObject({ actionCursor: "read-1", scroll: 4, scrollAnchor: 30 });
    expect(restored.agentView?.expandedActionIds.has("read-1")).toBe(true);
  });

  test("keeps the session's navigation cursor while an agent is open", () => {
    const navigating: NoesisTuiState = {
      ...openedState(),
      subAgentCursor: "agent-b",
    };
    const reopened = reduceTui(navigating, { type: "agent-view-opened", agentId: "agent-b", parents: [] });
    expect(reopened.subAgentCursor).toBe("agent-b");
    expect(reduceTui(reopened, { type: "agent-view-closed" }).subAgentCursor).toBe("agent-b");
  });

  test("cycles agents from the same requester, running first, then finished newest first", () => {
    const at = (agentId: string, status: SubAgentSummary["status"], createdAt: string) => ({
      ...agent(agentId, status, agentId),
      createdAt,
    });
    const state: NoesisTuiState = {
      ...initialTuiState("fake"),
      subAgents: [
        at("newer", "idle", "2026-08-31T00:00:05.000Z"),
        at("live-1", "running", "2026-08-31T00:00:01.000Z"),
        at("old", "idle", "2026-08-31T00:00:00.000Z"),
        at("live-2", "running", "2026-08-31T00:00:02.000Z"),
        { ...at("other-session", "idle", "2026-08-31T00:00:09.000Z"), originSessionId: "session-other" },
      ],
    };
    expect(siblingAgents(state, "live-1").map((candidate) => candidate.agentId)).toEqual([
      "live-1",
      "live-2",
      "newer",
      "old",
    ]);
  });

  test("shows the agent's task as the requester's turn instead of a mailbox note", () => {
    const state = reduceTui(openedState(), {
      type: "agent-view-hydrated",
      agentId: "agent-a",
      transcript: [
        {
          kind: "message",
          messageId: "mail-1",
          role: "system",
          text: "[foreground:trail_1 → subagent:agent-a]\nList the largest files.",
          createdAt: "2026-08-31T00:00:00.000Z",
        },
        {
          kind: "message",
          messageId: "mail-2",
          role: "system",
          text: "[subagent:agent-a → foreground:trail_1]\nDone.",
          createdAt: "2026-08-31T00:00:01.000Z",
        },
      ],
    });
    expect(state.agentView?.timeline).toEqual([
      expect.objectContaining({ role: "user", text: "List the largest files." }),
      expect.objectContaining({ role: "system", text: "[subagent:agent-a → foreground:trail_1]\nDone." }),
    ]);
  });

  test("labels a settled agent by how its task ended and times the task, not the actor", () => {
    const retained: SubAgentSummary = {
      ...agent("clock", "suspended", "clock"),
      latestTaskStatus: "completed",
      latestActivity: "2026-08-31T00:00:03.000Z",
      updatedAt: "2026-09-11T00:00:00.000Z",
    };
    const frame = renderAgentViewFrame(
      reduceTui(
        { ...initialTuiState("fake"), subAgents: [retained] },
        {
          type: "agent-view-opened",
          agentId: "clock",
          parents: [],
        },
      ),
      90,
      12,
      createTranscriptRenderer(),
    ).rows.map(stripAnsi);
    expect(frame.at(-4)).toContain("✓ clock  done · 0:03 · read-only");
    expect(frame.join("\n")).toContain("subagent from an earlier session");
  });
});
