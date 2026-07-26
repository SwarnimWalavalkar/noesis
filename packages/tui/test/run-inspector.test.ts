import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import {
  initialTuiState,
  reduceTui,
  renderRunInspector,
  type NoesisTuiAction,
  type NoesisTuiState,
  type TuiExecutionDetail,
} from "../src/index.ts";

const PROGRAM = [
  "const state = await tools.files.read({ path: 'packages/tui/src/state.ts' });",
  "const hits = await tools.files.search({ query: 'timeline' });",
  "return { hits: hits.matches.length };",
].join("\n");

const DETAIL: TuiExecutionDetail = {
  kind: "codemode",
  executionId: "exec_7d31c0a4",
  label: "execute",
  status: "completed",
  toolNames: ["files.read", "files.search"],
  callCount: 2,
  startedAt: "2026-07-27T02:14:03Z",
  completedAt: "2026-07-27T02:14:04Z",
  catalogDigest: "sha256:1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
  sourceDigest: "sha256:8f21c0a4bb31de77aa04c1190f2e3d4c",
  stdoutArtifact: {
    artifactId: "artifact-1",
    path: ".noesis/artifacts/codemode/0370194c/stdout.log",
    mediaType: "text/plain",
    preview: "402",
    truncated: false,
  },
  result: '{\n  "hits": 23\n}',
};

function stateWithRun(
  options: {
    readonly failed?: boolean;
    readonly detail?: TuiExecutionDetail;
    readonly scroll?: number;
  } = {},
): NoesisTuiState {
  const events: NoesisTuiAction[] = [
    {
      type: "action-started",
      actionId: "x1",
      name: "execute",
      input: { source: PROGRAM },
      at: 0,
    },
    {
      type: "action-started",
      actionId: "x1:1",
      parentActionId: "x1",
      name: "files.read",
      input: { path: "packages/tui/src/state.ts" },
      at: 10,
    },
    {
      type: "action-ended",
      actionId: "x1:1",
      output: { path: "/repo/packages/tui/src/state.ts", totalLines: 402 },
      isError: false,
      at: 120,
    },
    {
      type: "action-started",
      actionId: "x1:2",
      parentActionId: "x1",
      name: "files.search",
      input: { query: "timeline" },
      at: 130,
    },
    {
      type: "action-ended",
      actionId: "x1:2",
      output: { matches: [{}, {}, {}] },
      isError: false,
      at: 400,
    },
    {
      type: "action-ended",
      actionId: "x1",
      output: options.failed
        ? { error: "ToolError: files.write denied by permission policy" }
        : {
            hits: 23,
            details: { kind: "result", executionId: "exec_7d31c0a4" },
          },
      isError: options.failed === true,
      at: 1240,
    },
    { type: "inspector-opened", actionId: "x1" },
    {
      type: "inspector-loaded",
      actionId: "x1",
      ...(options.detail ? { detail: options.detail } : {}),
    },
    ...(options.scroll
      ? ([
          { type: "inspector-scrolled", delta: options.scroll },
        ] as NoesisTuiAction[])
      : []),
  ];
  return events.reduce(reduceTui, initialTuiState("fake"));
}

const render = (state: NoesisTuiState, width = 88, height = 24): string[] =>
  renderRunInspector(state, width, height);

describe("run inspector panel", () => {
  test("frames every row to exactly the requested width", () => {
    const rows = render(stateWithRun({ detail: DETAIL }));

    expect(rows.length).toBeGreaterThan(3);
    for (const row of rows) expect(visibleWidth(row)).toBe(88);
    expect(rows.at(0)?.startsWith("╭")).toBe(true);
    expect(rows.at(-1)?.startsWith("╰")).toBe(true);
  });

  test("titles the panel with the action and its resolved status", () => {
    const [title] = render(stateWithRun({ detail: DETAIL }));

    expect(title).toContain("RUN");
    expect(title).toContain("execute");
    expect(title).toContain("✓ completed");
  });

  test("leads with identity, then calls, source, and provenance", () => {
    const rows = render(stateWithRun({ detail: DETAIL }), 88, 60);
    const body = rows.join("\n");
    const order = ["CALLS", "SOURCE", "RESULT", "STDOUT", "PROVENANCE"].map(
      (label) => body.indexOf(label),
    );

    expect(rows[1]).toContain("codemode · 2 calls · 1.2s · exec_7d31c0a4");
    expect(order.every((position) => position >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
  });

  test("summarizes each nested call with its subject, outcome, and duration", () => {
    const body = render(stateWithRun({ detail: DETAIL }), 88, 60).join("\n");

    // Names are padded to a common column so the summaries line up down the list.
    expect(body).toContain("1 ✓ files.read   state.ts · 402 lines · 110ms");
    expect(body).toContain('2 ✓ files.search "timeline" · 3 matches · 270ms');
  });

  test("numbers the program and keeps wrapped code clear of the gutter", () => {
    const body = render(stateWithRun({ detail: DETAIL }), 56, 60).join("\n");

    expect(body).toContain("1  const state = await");
    // The wrapped remainder is indented past the gutter rather than starting under the numbers.
    expect(body).toMatch(/\n│ {4}\S/u);
  });

  test("puts the error above the program and does not repeat it as a result", () => {
    const body = render(stateWithRun({ failed: true }), 88, 60).join("\n");

    expect(body).toContain("× failed");
    expect(body.indexOf("ERROR")).toBeLessThan(body.indexOf("SOURCE"));
    expect(body).toContain("ToolError: files.write denied");
    expect(body).not.toContain("RESULT");
  });

  test("says when no durable record backs the panel", () => {
    const body = render(stateWithRun()).join("\n");

    expect(body).toContain("no durable run record resolved");
    expect(body).not.toContain("PROVENANCE");
  });

  test("shortens digests so provenance stays on one row each", () => {
    const body = render(stateWithRun({ detail: DETAIL }), 88, 60).join("\n");

    expect(body).toContain("catalog    sha256:1a2b3c4d5e6f7a8b9…");
    expect(body).toContain("execution  exec_7d31c0a4");
  });

  test("reports the visible range and clamps scrolling to the content", () => {
    const whole = render(stateWithRun({ detail: DETAIL }), 88, 60);
    const scrolled = render(
      stateWithRun({ detail: DETAIL, scroll: 6 }),
      88,
      12,
    );
    const overscrolled = render(
      stateWithRun({ detail: DETAIL, scroll: 900 }),
      88,
      12,
    );

    expect(whole.at(-1)).toContain("25 rows");
    expect(scrolled.at(-1)).toContain("7–16 of 25");
    // Scrolling past the end settles on the last screen instead of running off it.
    expect(overscrolled.at(-1)).toContain("16–25 of 25");
  });

  test("renders nothing without an open inspector or usable space", () => {
    const state = stateWithRun({ detail: DETAIL });

    expect(
      renderRunInspector(
        reduceTui(state, { type: "inspector-closed" }),
        88,
        24,
      ),
    ).toEqual([]);
    expect(renderRunInspector(state, 8, 24)).toEqual([]);
    expect(renderRunInspector(state, 88, 2)).toEqual([]);
  });

  test("emits no styling when color is disabled", () => {
    const body = render(stateWithRun({ detail: DETAIL }), 88, 60).join("\n");

    expect(body).not.toContain(String.fromCodePoint(27));
  });
});
