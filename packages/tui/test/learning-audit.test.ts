import { createPiAgentRuntime } from "@noesis/runtime-pi";
import { describe, expect, test, vi } from "vitest";
import {
  CONTROLLED_PI_MODEL,
  CONTROLLED_PI_PROVIDER,
  createControlledPiModels,
} from "../../runtime-pi/test/support/controlled-pi-models.ts";
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
    evidencePreviews: Object.freeze([]),
    consideredEvidenceCount: 0,
    consideredEvidencePreviews: Object.freeze([]),
    relations: Object.freeze([]),
    detailSections: Object.freeze([]),
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
      status: "adjusted\nINJECTED STATUS ROW",
      tone: "positive",
      title: "Applied project strategy",
      summary: "Use the existing adaptation path instead of editing protected files.",
      sessionId: "session-1",
      occurredAt: "2026-08-14T00:00:02.000Z",
      evidence: Object.freeze(["messages:message-1"]),
      evidencePreviews: Object.freeze([
        Object.freeze({
          identity: "messages:message-1",
          label: "USER",
          excerpt: "Please propose the capability through adapt.",
          occurredAt: "2026-08-14T00:00:00.000Z",
          redacted: false,
        }),
      ]),
      consideredEvidenceCount: 25,
      detailSections: Object.freeze([
        Object.freeze({
          title: "Decision",
          entries: Object.freeze([
            Object.freeze({ label: "Outcome", value: "Applied project strategy" }),
            Object.freeze({ label: "Why", value: "The correction establishes a reusable constraint." }),
          ]),
        }),
        Object.freeze({
          title: "What changed",
          entries: Object.freeze([
            Object.freeze({ label: "Before", value: "No project strategy was active." }),
            Object.freeze({ label: "Now", value: "Use adapt for self-extension requests." }),
            Object.freeze({ label: "Success looks like", value: "Protected files remain unchanged." }),
          ]),
        }),
      ]),
      relations: Object.freeze([
        {
          label: "experiment",
          targetId: "experiment:experiment-1",
          targetTitle: "Use narrower\nresearch first",
        },
      ]),
    }),
    record({
      id: "reflection:reflection-routine",
      kind: "reflection",
      group: "reflection",
      status: "no_change",
      title: "No lasting change",
      summary: "The reflector found no durable lesson with a credible future use.",
      sessionId: "session-1",
      occurredAt: "2026-08-14T00:00:01.500Z",
      consideredEvidenceCount: 4,
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
    output: (width = 110) => component.render(width).join("\n"),
  };
}

describe("learning audit overlay", () => {
  test("opens from /learning as a focused Pi TUI overlay", async () => {
    const controlled = createControlledPiModels();
    const agent = createPiAgentRuntime(process.cwd(), controlled.models);
    const runtime = Object.freeze({
      ...createInMemoryTestRuntime(agent),
      inspectLearningAudit: async () => snapshot,
    });
    const terminal = createTestTerminal();
    const running = startNoesisTui(
      runtime,
      { provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL },
      terminal,
    );
    await vi.waitFor(() => expect(terminal.output).toContain("● IDLE"));

    terminal.type("  /learning\r");
    await vi.waitFor(() => expect(terminal.output).toContain("Controlled completion for:   /learning"));
    expect(terminal.output).not.toContain("LEARNING · audit ledger");

    terminal.type("/learning\r");
    await vi.waitFor(() => expect(terminal.output).toContain("LEARNING · project evolution"));
    expect(terminal.output).toContain("Applied project strategy");
    expect(terminal.output).toContain("routine reflections 1");
    terminal.send(ESCAPE);
    terminal.type("after audit\r");
    await vi.waitFor(() => expect(terminal.output).toContain("after audit"));

    terminal.type("/quit\n");
    await running;
  });

  test("shows noteworthy activity by default and keeps routine reflection auditable", async () => {
    const harness = createHarness();
    await vi.waitFor(() => expect(harness.output()).toContain("LEARNING · project evolution"));
    expect(harness.output()).toContain("Applied project strategy");
    expect(harness.output()).not.toContain("No lasting change");
    expect(harness.output()).toContain("1 routine no-change reflections hidden");
    expect(harness.output()).toContain("Use narrower research first");
    expect(harness.output()).not.toContain("\u001b]");

    harness.component.handleInput?.("a");
    expect(harness.output()).toContain("view all activity");
    expect(harness.output()).toContain("No lasting change");

    harness.component.handleInput?.("a");
    harness.component.handleInput?.("s");
    expect(harness.output()).toContain("current session · 1 visible");
    expect(harness.output()).not.toContain("Use narrower research first");

    harness.component.handleInput?.("s");
    harness.component.handleInput?.("f");
    harness.component.handleInput?.("f");
    expect(harness.output()).toContain("view memory");
  });

  test("explains a decision with cited evidence and keeps identities in raw authority", async () => {
    const harness = createHarness();
    await vi.waitFor(() => expect(harness.output()).toContain("Applied project strategy"));
    harness.component.handleInput?.(ENTER);
    expect(harness.output()).toContain("WHAT CHANGED");
    expect(harness.output()).toContain("Use adapt for self-extension requests.");
    expect(harness.output()).toContain("USER");
    expect(harness.output()).toContain("Please propose the capability through adapt.");
    expect(harness.output()).toContain("25 inputs were reviewed; 1 were cited");
    expect(harness.output()).not.toContain("messages:message-1");
    expect(harness.output()).toContain("adjusted INJECTED STATUS ROW · reflection");
    expect(harness.output()).not.toContain("\nINJECTED STATUS ROW");
    harness.component.handleInput?.("\u001b[6~");
    expect(harness.output()).toContain("experiment → Use narrower research first");

    harness.component.handleInput?.(ENTER);
    expect(harness.output()).toContain("Use narrower research first");
    harness.component.handleInput?.(" ");
    expect(harness.output()).toContain('"hypothesis"');
    harness.component.handleInput?.(ESCAPE);
    expect(harness.output()).toContain("Applied project strategy");
  });

  test("supports keyboard navigation and closes cleanly", async () => {
    const harness = createHarness();
    await vi.waitFor(() => expect(harness.output()).toContain("Applied project strategy"));
    harness.component.handleInput?.(DOWN);
    harness.component.handleInput?.(ENTER);
    expect(harness.output()).toContain("Use narrower research first");
    harness.component.handleInput?.(ESCAPE);
    harness.component.handleInput?.(ESCAPE);
    expect(harness.closes).toBe(1);
  });

  test("renders responsive master-detail panes at wide terminal widths", async () => {
    const harness = createHarness();
    await vi.waitFor(() => expect(harness.output(160)).toContain("ACTIVITY · FOCUSED"));
    const wide = harness.output(160);
    expect(wide).toContain("SELECTED DECISION");
    expect(wide).toContain("Applied project strategy");
    expect(wide).toContain("WHAT CHANGED");
    expect(wide).toContain("│");

    const narrow = harness.output(90);
    expect(narrow).toContain("Applied project strategy");
    expect(narrow).not.toContain("SELECTED DECISION");
    expect(narrow).not.toContain("WHAT CHANGED");
  });
});
