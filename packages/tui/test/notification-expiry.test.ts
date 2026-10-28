import type { SubAgentSummary } from "@noesis/agent-types";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createNoesisView, initialTuiState } from "../src/index.ts";
import { createNotificationExpiry, NOTIFICATION_TTL_MS } from "../src/notification-expiry.ts";
import { isSessionAgent } from "../src/state.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("notification expiry", () => {
  test("clears a one-line notification after its time, but keeps a newer one", () => {
    vi.useFakeTimers();
    let clock = 0;
    const view = createNoesisView(initialTuiState("fake"), () => 30);
    const expiry = createNotificationExpiry({ view, requestRender: () => undefined, now: () => clock });
    view.dispatch({ type: "notification-shown", text: "No turn is active.", tone: "attention" });
    vi.advanceTimersByTime(500);
    clock = NOTIFICATION_TTL_MS - 1;
    vi.advanceTimersByTime(500);
    expect(view.state.notification?.text).toBe("No turn is active.");
    view.dispatch({ type: "notification-shown", text: "Use /queue resume.", tone: "attention" });
    clock = NOTIFICATION_TTL_MS + 1;
    vi.advanceTimersByTime(500);
    expect(view.state.notification?.text).toBe("Use /queue resume.");
    clock = NOTIFICATION_TTL_MS * 3;
    vi.advanceTimersByTime(500);
    expect(view.state.notification).toBeUndefined();
    expiry.dispose();
  });

  test("keeps a multi-line notification until a key other than Escape is pressed", () => {
    vi.useFakeTimers();
    let clock = 0;
    const view = createNoesisView(initialTuiState("fake"), () => 30);
    const expiry = createNotificationExpiry({ view, requestRender: () => undefined, now: () => clock });
    view.dispatch({
      type: "notification-shown",
      text: "Attachments 2\n1. a.png\n2. b.png",
      tone: "attention",
    });
    vi.advanceTimersByTime(500);
    clock = NOTIFICATION_TTL_MS * 10;
    vi.advanceTimersByTime(500);
    expiry.observeInput("\u001b");
    expect(view.state.notification).toBeDefined();
    expiry.observeInput("x");
    expect(view.state.notification).toBeUndefined();
    expiry.dispose();
  });
});

describe("session agents", () => {
  test("an agent spawned by this session's agent belongs to the session", () => {
    const agent = (agentId: string, originSessionId: string): SubAgentSummary => ({
      agentId,
      childSessionId: `session-${agentId}`,
      projectId: "project-test",
      originSessionId,
      status: "idle",
      route: { provider: "p", model: "m" },
      thinkingLevel: "high",
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
    });
    const state = {
      ...initialTuiState("fake"),
      trailId: "session-now",
      subAgents: [
        agent("parent", "session-now"),
        { ...agent("child", "session-parent-child"), parentAgentId: "parent" },
        agent("old", "session-before"),
      ],
    };
    const [parent, child, old] = state.subAgents;
    expect(parent && isSessionAgent(state, parent)).toBe(true);
    expect(child && isSessionAgent(state, child)).toBe(true);
    expect(old && isSessionAgent(state, old)).toBe(false);
  });
});
