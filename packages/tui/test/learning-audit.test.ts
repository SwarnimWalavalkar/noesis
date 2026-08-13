import type { NoesisAgentRuntime } from "@noesis/agent-types";
import { describe, expect, test, vi } from "vitest";
import {
  createLearningAuditOverlay,
  startNoesisTui,
  type TuiLearningAuditSnapshot,
  type TuiLearningPrimitive,
} from "../src/index.ts";
import { createInMemoryTestRuntime } from "./support/in-memory-runtime.ts";
import { createTestTerminal } from "./support/test-terminal.ts";

const ENTER = "\r";
const DOWN = "\u001b[B";
const ESCAPE = "\u001b";

function record(
  input: Partial<TuiLearningPrimitive> & Pick<TuiLearningPrimitive, "id" | "kind" | "group" | "title">,
): TuiLearningPrimitive {
  return Object.freeze({
    status: "recorded",
    tone: "neutral",
    summary: "Inspectable learning evidence",
    evidence: Object.freeze([]),
    relations: Object.freeze([]),
    rawJson: '{"schemaVersion":1}',
    ...input,
  });
}

const snapshot: TuiLearningAuditSnapshot = Object.freeze({
  projectId: "project-1",
  sessionId: "session-1",
  generatedAt: "2026-08-14T00:00:00.000Z",
  primitives: Object.freeze([
    record({
      id: "reflection:reflection-1",
      kind: "reflection",
      group: "reflection",
      status: "no_change",
      title: "Reflection · no change",
      sessionId: "session-1",
      occurredAt: "2026-08-14T00:00:02.000Z",
      evidence: Object.freeze(["messages:message-1"]),
      relations: Object.freeze([{ label: "experiment", targetId: "experiment:experiment-1" }]),
    }),
    record({
      id: "experiment:experiment-1",
      kind: "experiment",
      group: "changes",
      status: "observing",
      title: "Use narrower research first",
      summary: "A project experiment",
      sessionId: "session-2",
      occurredAt: "2026-08-14T00:00:01.000Z",
      rawJson: '{"hypothesis":"Use narrower research first"}',
    }),
    record({
      id: "evaluation:evaluation-1",
      kind: "evaluation",
      group: "evaluation",
      status: "passed",
      title: "Evaluation\u001b]8;;https://hostile.test\u0007injected\u001b]8;;\u0007",
    }),
  ]),
});

function createHarness() {
  let closes = 0;
  const component = createLearningAuditOverlay({
    runtime: { inspectLearningAudit: async () => snapshot },
    sessionId: "session-1",
    colorEnabled: false,
    height: () => 32,
    requestRender: () => undefined,
    close: () => {
      closes += 1;
    },
  });
  return {
    component,
    get closes() {
      return closes;
    },
    output: () => component.render(110).join("\n"),
  };
}

describe("learning audit overlay", () => {
  test("opens from /learning as a focused Pi TUI overlay", async () => {
    const agent: NoesisAgentRuntime = {
      name: "learning-audit-scripted",
      async run(request) {
        return {
          text: request.prompt,
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      async steer() {
        return { status: "consumed", timelineSequence: 1, consumedAt: new Date().toISOString() };
      },
      async abort() {},
    };
    const runtime = Object.freeze({
      ...createInMemoryTestRuntime(agent),
      inspectLearningAudit: async () => snapshot,
    });
    const terminal = createTestTerminal();
    const running = startNoesisTui(runtime, {}, terminal);
    await vi.waitFor(() => expect(terminal.output).toContain("● IDLE"));

    terminal.type("/learning\r");
    await vi.waitFor(() => expect(terminal.output).toContain("LEARNING · audit ledger"));
    expect(terminal.output).toContain("Reflection · no change");
    terminal.send(ESCAPE);
    terminal.type("after audit\r");
    await vi.waitFor(() => expect(terminal.output).toContain("after audit"));

    terminal.type("/quit\n");
    await running;
  });

  test("makes every primitive group visible and filters to the current session", async () => {
    const harness = createHarness();
    await vi.waitFor(() => expect(harness.output()).toContain("LEARNING · audit ledger"));
    expect(harness.output()).toContain("Reflection · no change");
    expect(harness.output()).toContain("Use narrower research first");
    expect(harness.output()).not.toContain("\u001b]");

    harness.component.handleInput?.("s");
    expect(harness.output()).toContain("current session · 1 records");
    expect(harness.output()).not.toContain("Use narrower research first");

    harness.component.handleInput?.("s");
    harness.component.handleInput?.("f");
    expect(harness.output()).toContain("view memory");
  });

  test("inspects identity, evidence, raw authority, and follows typed lineage", async () => {
    const harness = createHarness();
    await vi.waitFor(() => expect(harness.output()).toContain("Reflection · no change"));
    harness.component.handleInput?.(ENTER);
    expect(harness.output()).toContain("messages:message-1");
    expect(harness.output()).toContain("experiment → experiment:experiment-1");

    harness.component.handleInput?.(ENTER);
    expect(harness.output()).toContain("Use narrower research first");
    harness.component.handleInput?.(" ");
    expect(harness.output()).toContain('"hypothesis"');
    harness.component.handleInput?.(ESCAPE);
    expect(harness.output()).toContain("Reflection · no change");
  });

  test("supports keyboard navigation and closes cleanly", async () => {
    const harness = createHarness();
    await vi.waitFor(() => expect(harness.output()).toContain("Reflection · no change"));
    harness.component.handleInput?.(DOWN);
    harness.component.handleInput?.(ENTER);
    expect(harness.output()).toContain("Use narrower research first");
    harness.component.handleInput?.(ESCAPE);
    harness.component.handleInput?.(ESCAPE);
    expect(harness.closes).toBe(1);
  });
});
