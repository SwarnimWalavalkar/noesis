import { visibleWidth } from "@earendil-works/pi-tui";
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
const TAB = "\t";
const DOWN = "\u001b[B";
const ESCAPE = "\u001b";
const NOW = new Date("2026-08-14T12:00:00.000Z");

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
      title: "Use the existing adaptation path instead of editing protected files.",
      summary: "The correction establishes a reusable constraint.",
      sessionId: "session-1",
      occurredAt: "2026-08-14T00:00:02.000Z",
      evidence: Object.freeze([
        "messages:message-1",
        "messages:message-2",
        "messages:message-3",
        "messages:message-4",
        "messages:message-5",
      ]),
      evidencePreviews: Object.freeze([
        Object.freeze({
          identity: "messages:message-1",
          label: "USER",
          excerpt: "Please propose the capability through adapt.",
          occurredAt: "2026-08-14T00:00:00.000Z",
          redacted: false,
        }),
        Object.freeze({
          identity: "messages:message-2",
          label: "ASSISTANT",
          excerpt: "The existing adaptation path already covers this request.",
          occurredAt: "2026-08-14T00:00:00.250Z",
          redacted: false,
        }),
        Object.freeze({
          identity: "messages:message-3",
          label: "USER",
          excerpt: "Keep the change on the existing adaptation path.",
          occurredAt: "2026-08-14T00:00:00.500Z",
          redacted: false,
        }),
      ]),
      consideredEvidenceCount: 25,
      consideredEvidencePreviews: Object.freeze([
        Object.freeze({
          identity: "messages:message-considered",
          label: "TOOL",
          excerpt: "files.list completed with the project tree.",
          occurredAt: "2026-08-14T00:00:01.000Z",
          redacted: false,
        }),
        Object.freeze({
          identity: "messages:message-considered-2",
          label: "ASSISTANT",
          excerpt: "Listed the project files before proposing the change.",
          occurredAt: "2026-08-14T00:00:01.500Z",
          redacted: false,
        }),
        Object.freeze({
          identity: "tool_calls:call-considered-3",
          label: "TOOL",
          excerpt: "search.query returned the existing adaptation skill.",
          occurredAt: "2026-08-14T00:00:01.750Z",
          redacted: false,
        }),
      ]),
      detailSections: Object.freeze([
        Object.freeze({
          title: "Decision",
          entries: Object.freeze([
            Object.freeze({
              label: "Outcome",
              value: "Applied project strategy",
            }),
            Object.freeze({
              label: "Why",
              value: "The correction establishes a reusable constraint.",
            }),
          ]),
        }),
        Object.freeze({
          title: "What changed",
          entries: Object.freeze([
            Object.freeze({
              label: "Before",
              value: "No project strategy was active.",
            }),
            Object.freeze({
              label: "Now",
              value: "Use adapt for self-extension requests.",
            }),
            Object.freeze({
              label: "Success looks like",
              value: "Protected files remain unchanged.",
            }),
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
      id: "reflection:failed-1",
      kind: "reflection",
      group: "reflection",
      status: "failed",
      tone: "negative",
      title: "Reflection failed",
      summary: "The reflector stopped before a decision.",
      sessionId: "session-1",
      occurredAt: "2026-08-14T00:00:03.000Z",
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
      id: "trial:trial-1",
      kind: "trial",
      group: "evaluation",
      status: "completed · baseline",
      tone: "positive",
      title: "baseline trial",
      summary: "Use narrower research first",
      sessionId: "session-1",
      occurredAt: "2026-08-14T00:00:00.500Z",
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

function createHarness(focusRecordId?: string) {
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
    now: () => NOW,
    ...(focusRecordId ? { focusRecordId } : {}),
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
    expect(terminal.output).toContain("Use the existing adaptation path");
    expect(terminal.output).toContain("1 routine");
    terminal.send(ESCAPE);
    terminal.type("after audit\r");
    await vi.waitFor(() => expect(terminal.output).toContain("after audit"));

    terminal.type("/quit\n");
    await running;
  });

  test("shows noteworthy activity by default and keeps routine reflection auditable", async () => {
    const harness = createHarness();
    await vi.waitFor(() => expect(harness.output()).toContain("LEARNING · project evolution"));
    expect(harness.output()).toContain(
      "Use the existing adaptation path instead of editing protected files.",
    );
    expect(harness.output()).not.toContain("No lasting change");
    expect(harness.output()).not.toContain("baseline trial");
    expect(harness.output()).toContain("1 routine hidden");
    expect(harness.output()).toContain("1 failed · x shows");
    expect(harness.output()).toContain("◇ reflection");
    expect(harness.output()).toContain("◆ changes");
    expect(harness.output()).not.toContain("Reflection failed");
    expect(harness.output()).toContain("Use narrower research first");
    expect(harness.output()).toContain("12h ago");
    expect(harness.output()).toContain("r refresh");
    expect(harness.output()).not.toContain("\u001b]");

    harness.component.handleInput?.("x");
    expect(harness.output()).toContain("Reflection failed");
    expect(harness.output()).toContain("× failed");
    harness.component.handleInput?.("x");
    expect(harness.output()).not.toContain("Reflection failed");

    harness.component.handleInput?.("a");
    expect(harness.output()).toContain("No lasting change");
    expect(harness.output()).toContain("baseline trial");
    expect(harness.output()).not.toContain("Reflection failed");

    harness.component.handleInput?.("a");
    harness.component.handleInput?.("s");
    expect(harness.output()).toContain("current session · 1 visible");
    expect(harness.output()).not.toContain("Use narrower research first");

    harness.component.handleInput?.("s");
    harness.component.handleInput?.("f");
    expect(harness.output()).toContain("Nothing in this view.");
    expect(harness.output()).not.toContain("Use the existing adaptation path");
  });

  test("explains a decision with cited evidence and keeps identities in raw authority", async () => {
    const harness = createHarness();
    await vi.waitFor(() => expect(harness.output()).toContain("Use the existing adaptation path"));
    harness.component.handleInput?.(ENTER);
    expect(harness.output()).toContain("WHAT CHANGED");
    expect(harness.output()).toContain("Use adapt for self-extension requests.");
    expect(harness.output()).toContain("USER");
    expect(harness.output()).toContain("Please propose the capability through adapt.");
    expect(harness.output()).toContain("adjusted INJECTED STATUS ROW");
    expect(harness.output()).toContain("2026-08-14 00:00:02 UTC");
    expect(harness.output()).not.toContain("\nINJECTED STATUS ROW");
    expect(harness.output()).toContain("EVIDENCE CITED · 5");
    expect(harness.output()).toContain("Tab to choose");
    expect(harness.output()).toContain("Tab next");
    expect(harness.output()).not.toContain("i expands");
    expect(harness.output()).not.toContain("i inputs");
    expect(harness.output()).not.toContain("Keep the change on the existing adaptation path.");
    expect(harness.output()).not.toContain("search.query returned the existing adaptation skill.");
    expect(harness.output()).not.toContain("more exact references in raw");
    harness.component.handleInput?.(ENTER);
    expect(harness.output()).toContain("WHAT CHANGED");
    expect(harness.output()).toContain("Use the existing adaptation path");

    harness.component.handleInput?.(TAB);
    expect(harness.output()).toContain("Enter expands");
    expect(harness.output()).toContain("Please propose the capability through adapt.");
    expect(harness.output()).toContain("The existing adaptation path already covers this request.");
    expect(harness.output()).not.toContain("Keep the change on the existing adaptation path.");
    harness.component.handleInput?.(ENTER);
    expect(harness.output()).toContain("Keep the change on the existing adaptation path.");
    expect(harness.output()).toContain("+ 2 more exact references in raw");
    expect(harness.output()).toContain("Enter hides");
    harness.component.handleInput?.(TAB);
    expect(harness.output()).toContain("Enter expands");
    expect(harness.output()).toContain("25 inputs were reviewed; 5 were cited");
    expect(harness.output()).toContain("files.list completed with the project tree.");
    expect(harness.output()).toContain("Listed the project files before proposing the change.");
    expect(harness.output()).not.toContain("search.query returned the existing adaptation skill.");
    harness.component.handleInput?.(ENTER);
    expect(harness.output()).toContain("search.query returned the existing adaptation skill.");
    expect(harness.output()).toContain("+ 22 more exact references in raw");
    expect(harness.output()).toContain("Enter hides");
    expect(harness.output()).not.toContain("messages:message-considered");
    expect(harness.output()).not.toContain("messages:message-1");
    harness.component.handleInput?.(TAB);
    expect(harness.output()).toContain("Enter opens");
    harness.component.handleInput?.(TAB);
    expect(harness.output()).toContain("LEARNING · reflection");
    expect(harness.output()).toContain("Enter hides");
    expect(harness.output()).not.toContain("Tab decision");
    harness.component.handleInput?.(TAB);
    harness.component.handleInput?.(TAB);
    expect(harness.output()).toContain("Enter opens");
    harness.component.handleInput?.(ENTER);
    expect(harness.output()).toContain("Use narrower research first");
    harness.component.handleInput?.(" ");
    expect(harness.output()).toContain('"hypothesis"');
    harness.component.handleInput?.(ESCAPE);
    expect(harness.output()).toContain("Use the existing adaptation path");
  });

  test("supports keyboard navigation and closes cleanly", async () => {
    const harness = createHarness();
    await vi.waitFor(() => expect(harness.output()).toContain("Use the existing adaptation path"));
    harness.component.handleInput?.(DOWN);
    harness.component.handleInput?.(ENTER);
    expect(harness.output()).toContain("Use narrower research first");
    harness.component.handleInput?.(ESCAPE);
    harness.component.handleInput?.(ESCAPE);
    expect(harness.closes).toBe(1);
  });

  test("closes the overlay frame on every row", async () => {
    const harness = createHarness();
    await vi.waitFor(() => expect(harness.output(160)).toContain("LEARNING · project evolution"));
    const rows = harness.component.render(160);
    const plain = (line: string): string => line.replaceAll(/\u001b\[[0-9;]*m/gu, "");
    expect(plain(rows[0] ?? "")).toMatch(/^╭─+╮$/u);
    expect(plain(rows.at(-1) ?? "")).toMatch(/^╰─+╯$/u);
    for (const row of rows) {
      expect(visibleWidth(row)).toBe(160);
      expect(plain(row).startsWith("╭") || plain(row).startsWith("│") || plain(row).startsWith("╰")).toBe(
        true,
      );
      expect(plain(row).endsWith("╮") || plain(row).endsWith("│") || plain(row).endsWith("╯")).toBe(true);
    }
  });

  test("renders responsive master-detail panes at wide terminal widths", async () => {
    const harness = createHarness();
    await vi.waitFor(() => expect(harness.output(160)).toContain("▸ ACTIVITY"));
    const wide = harness.output(160);
    expect(wide).toContain("DECISION");
    expect(wide).toContain("Use the existing adaptation path");
    expect(wide).toContain("WHAT CHANGED");
    expect(wide).toContain("Enter opens");
    expect(wide).not.toContain("INPUTS CONSIDERED");
    expect(wide).toContain("│");

    const narrow = harness.output(90);
    expect(narrow).toContain("Use the existing adaptation path");
    expect(narrow).not.toContain("▸ DECISION");
    expect(narrow).not.toContain("WHAT CHANGED");

    harness.component.handleInput?.(ENTER);
    const focused = harness.output(160);
    expect(focused).toContain("▸ DECISION");
    expect(focused).toContain("EVIDENCE CITED");
    expect(focused).toContain("2026-08-14 00:00:02 UTC");
  });

  test("focuses related records with tab and up/down instead of left/right", async () => {
    const harness = createHarness();
    await vi.waitFor(() => expect(harness.output(160)).toContain("Use the existing adaptation path"));
    harness.component.handleInput?.(ENTER);
    expect(harness.output(160)).toContain("LEARNING · reflection");
    expect(harness.output(160)).toContain("Tab next");
    harness.component.handleInput?.(TAB);
    expect(harness.output(160)).toContain("Enter expands");
    harness.component.handleInput?.(TAB);
    expect(harness.output(160)).toContain("Enter expands");
    harness.component.handleInput?.(TAB);
    expect(harness.output(160)).toContain("Enter opens");
    expect(harness.output(160)).toContain("Enter open");
    harness.component.handleInput?.(TAB);
    expect(harness.output(160)).toContain("LEARNING · reflection");
    expect(harness.output(160)).toContain("Enter expands");
    expect(harness.output(160)).not.toContain("Tab decision");
    harness.component.handleInput?.(TAB);
    harness.component.handleInput?.(TAB);
    expect(harness.output(160)).toContain("Enter opens");
    harness.component.handleInput?.(ENTER);
    expect(harness.output(160)).toContain("Use narrower research first");
  });

  test("opens /learning onto a remembered decision", async () => {
    const harness = createHarness("experiment:experiment-1");
    await vi.waitFor(() => expect(harness.output(160)).toContain("LEARNING · experiment"));
    expect(harness.output(160)).toContain("Use narrower research first");
    expect(harness.output(160)).toContain("▸ DECISION");
  });

  test("finishes loading when a remembered record is outside the bounded snapshot", async () => {
    const harness = createHarness("experiment:outside-bounded-snapshot");
    await vi.waitFor(() => expect(harness.output(160)).toContain("LEARNING · project evolution"));
    expect(harness.output(160)).not.toContain("Refreshing the learning ledger");
    expect(harness.output(160)).toContain("Use the existing adaptation path");
  });

  test("expands quiet failed reflections when opening onto one", async () => {
    const harness = createHarness("reflection:failed-1");
    await vi.waitFor(() => expect(harness.output(160)).toContain("Reflection failed"));
    expect(harness.output(160)).toContain("× failed");
  });

  test("explains an empty noteworthy view when only routine reflections exist", async () => {
    const quiet: TuiLearningAuditSnapshot = Object.freeze({
      ...snapshot,
      primitives: Object.freeze([
        record({
          id: "reflection:quiet",
          kind: "reflection",
          group: "reflection",
          status: "no_change",
          title: "No lasting change",
          sessionId: "session-1",
        }),
      ]),
    });
    const component = createLearningAuditOverlay({
      runtime: { inspectLearningAudit: async () => quiet },
      sessionId: "session-1",
      colorEnabled: false,
      height: () => 32,
      requestRender: () => undefined,
      close: () => undefined,
      now: () => NOW,
    });
    await vi.waitFor(() => expect(component.render(110).join("\n")).toContain("No lasting changes yet"));
    expect(component.render(110).join("\n")).toContain("Ambient reflection is running.");
  });
});
