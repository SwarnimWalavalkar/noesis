import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import {
  initialTuiState,
  type NoesisTuiAction,
  type NoesisTuiState,
  reduceTui,
  renderRunInspector,
  renderRunInspectorFrame,
  type TuiExecutionDetail,
} from "../src/index.ts";

const ESC = String.fromCodePoint(27);
const YELLOW = `${ESC}[33m`;
const RESET = `${ESC}[0m`;

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
  options: { readonly failed?: boolean; readonly detail?: TuiExecutionDetail; readonly scroll?: number } = {},
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
          {
            type: "inspector-scrolled",
            delta: options.scroll,
            maxScroll: options.scroll,
          },
        ] as NoesisTuiAction[])
      : []),
  ];
  return events.reduce(reduceTui, initialTuiState("fake"));
}

const render = (state: NoesisTuiState, width = 88, height = 24): string[] =>
  renderRunInspector(state, width, height);

function stateWithAction(name: string, input: unknown, output: unknown): NoesisTuiState {
  const events: NoesisTuiAction[] = [
    { type: "action-started", actionId: "semantic-action", name, input, at: 0 },
    {
      type: "action-ended",
      actionId: "semantic-action",
      output,
      isError: false,
      at: 10,
    },
    { type: "inspector-opened", actionId: "semantic-action" },
    { type: "inspector-loaded", actionId: "semantic-action" },
  ];
  return events.reduce(reduceTui, initialTuiState("fake"));
}

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
    const order = ["CALLS", "SOURCE", "RESULT", "STDOUT", "PROVENANCE"].map((label) => body.indexOf(label));

    expect(rows[1]).toContain("codemode · 2 calls · 1.2s · exec_7d31c0a4");
    expect(order.every((position) => position >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
  });

  test("unwraps Pi text envelopes while keeping the exact response one keypress away", () => {
    const envelope = {
      content: [
        {
          type: "text",
          text: JSON.stringify("first semantic line\nsecond semantic line"),
        },
      ],
      details: { semantic: true },
    };
    const semantic = stateWithAction("inspect_self", { section: "system-prompt" }, envelope);
    const semanticBody = render(semantic, 88, 60).join("\n");

    expect(semanticBody).toContain("first semantic line");
    expect(semanticBody).toContain("second semantic line");
    expect(semanticBody).not.toContain('"content"');
    expect(semanticBody).not.toContain("\\\\n");
    expect(semanticBody).toContain("semantic · space for exact");

    const rawBody = render(reduceTui(semantic, { type: "inspector-view-toggled" }), 88, 60).join("\n");
    expect(rawBody).toContain("RAW RESULT");
    expect(rawBody).toContain('"content"');
    expect(rawBody).toContain('"details"');
    expect(rawBody).toContain("space semantic");
  });

  test("presents tool catalogs as readable discovery lists instead of schema dumps", () => {
    const catalog = {
      catalogId: "catalog-local",
      catalogDigest: "sha256:1234567890abcdefghijklmnopqrstuvwxyz",
      permissions: {
        effects: ["filesystem.read", "process.execute"],
        resourcePatterns: ["/**"],
        credentialRefs: [],
      },
      tools: Array.from({ length: 18 }, (_, index) => ({
        name: `tool.${String(index + 1)}`,
        description: `Useful tool ${String(index + 1)}`,
        revisionId: `revision-${String(index + 1)}`,
        inputSchema: {
          type: "object",
          properties: { path: { type: "string", description: "A deliberately verbose schema field" } },
        },
        outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
      })),
    };
    const envelope = {
      content: [{ type: "text", text: JSON.stringify(catalog) }],
      details: { semantic: true },
    };
    const semantic = stateWithAction("inspect_self", { section: "tools" }, envelope);
    const semanticFrame = renderRunInspectorFrame(semantic, 100, 100);
    const semanticBody = semanticFrame.rows.join("\n");

    expect(semanticBody).toContain("18 tools");
    expect(semanticBody).toContain("tool.1");
    expect(semanticBody).toContain("Useful tool 18");
    expect(semanticBody).toContain("catalog-local");
    expect(semanticBody).toContain("effects      2");
    expect(semanticBody).not.toContain("inputSchema");
    expect(semanticFrame.maxScroll).toBe(0);

    const rawBody = render(reduceTui(semantic, { type: "inspector-view-toggled" }), 100, 500).join("\n");
    expect(rawBody).toContain("inputSchema");
    expect(rawBody).toContain("outputSchema");
    expect(rawBody).toContain("revision-18");
  });

  test("sanitizes and bounds tool names before measuring discovery rows", () => {
    const hostileName = `files.read${ESC}[31m\nforged-row\t${"x".repeat(10_000)}-TAIL`;
    const state = stateWithAction("noesis.search", { query: "read" }, [
      { name: hostileName, description: "Hostile persisted tool name", score: 1 },
      { name: "files.write", description: "Normal tool", score: 0.5 },
    ]);
    const rows = render(state, 100, 100);
    const body = rows.join("\n");

    expect(body).toContain("files.read [31m forged-row");
    expect(body).toContain("files.write");
    expect(body).not.toContain(ESC);
    expect(body).not.toContain("\t");
    expect(body).not.toContain("-TAIL");
    for (const row of rows) expect(visibleWidth(row)).toBe(100);
  });

  test("renders noesis.search results as ranked tools with their useful provenance", () => {
    const state = stateWithAction("noesis.search", { query: "read files" }, [
      { name: "files.read", description: "Read a file", revisionId: "rev-read", score: 0.98 },
      { name: "files.search", description: "Search files", revisionId: "rev-search", score: 0.82 },
    ]);
    const body = render(state, 100, 60).join("\n");

    expect(body).toContain("2 tools");
    expect(body).toContain("files.read");
    expect(body).toContain("Read a file");
    expect(body).toContain("score 0.98");
    expect(body).toContain("rev rev-read");
  });

  test("summarizes each nested call with its subject, outcome, and duration", () => {
    const body = render(stateWithRun({ detail: DETAIL }), 88, 60).join("\n");

    // Names are padded to a common column so the summaries line up down the list.
    expect(body).toContain("1 ✓ files.read   state.ts · 402 lines · 110ms");
    expect(body).toContain('2 ✓ files.search "timeline" · 3 matches · 270ms');
  });

  test("bounds hostile nested call subjects and outcomes before wrapping", () => {
    const hostileSubject = `subject-${"s".repeat(50_000)}-SUBJECT-END${ESC}[2J`;
    const hostileOutcome = `outcome-${"o".repeat(50_000)}-OUTCOME-END${ESC}[31m`;
    const state = stateWithRun({ detail: DETAIL });
    const timeline = state.timeline.map((entry) =>
      entry.kind === "action" && entry.actionId === "x1:1"
        ? {
            ...entry,
            name: "workflows.run",
            input: { name: hostileSubject },
            output: { status: hostileOutcome },
          }
        : entry,
    );
    const body = render({ ...state, timeline }, 88, 100).join("\n");

    expect(body).toContain("subject-");
    expect(body).toContain("outcome-");
    expect(body).toContain("…");
    expect(body).not.toContain("SUBJECT-END");
    expect(body).not.toContain("OUTCOME-END");
    expect(body).not.toContain(ESC);
    expect(body.length).toBeLessThan(5_000);
  });

  test("numbers the program and keeps wrapped code clear of the gutter", () => {
    const body = render(stateWithRun({ detail: DETAIL }), 56, 60).join("\n");

    expect(body).toContain("1  const state = await");
    // The wrapped remainder is indented past the gutter rather than starting under the numbers.
    expect(body).toMatch(/\n│ {4}\S/u);
  });

  test("labels a truncated durable source preview when no exact action source exists", () => {
    const detail: TuiExecutionDetail = {
      ...DETAIL,
      sourceArtifact: {
        artifactId: "artifact-source",
        path: ".noesis/artifacts/codemode/0370194c/source.js",
        mediaType: "text/javascript",
        preview: "const partial = true;",
        truncated: true,
      },
    };
    const state = stateWithRun({ detail });
    const timeline = state.timeline.map((entry) =>
      entry.kind === "action" && entry.actionId === "x1" ? { ...entry, input: undefined } : entry,
    );
    const body = render({ ...state, timeline }, 88, 60).join("\n");

    expect(body).toContain("SOURCE preview truncated");
    expect(body).toContain("1  const partial = true;");
  });

  test("scrolls to the exact tail of a large resumed action result", () => {
    const exactTail = "EXACT-PERSISTED-TAIL";
    const largeResult = `${"x".repeat(2 * 1024 * 1024)}${exactTail}`;
    let state = reduceTui(initialTuiState("fake"), {
      type: "trail-selected",
      trail: {
        trailId: "resumed-session",
        title: "resumed",
        status: "idle",
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        runtime: "pi",
        turns: [],
        capabilityVersions: {},
      },
    });
    state = reduceTui(state, {
      type: "transcript-hydrated",
      trailId: "resumed-session",
      transcript: [
        {
          kind: "action",
          actionId: "resumed-action",
          turnId: "turn-1",
          name: "files.read",
          status: "completed",
          input: { path: "large.txt" },
          update: { progress: "complete" },
          output: { content: largeResult },
          startedAt: "2026-07-31T10:00:01.000Z",
          completedAt: "2026-07-31T10:00:02.000Z",
        },
      ],
    });
    state = reduceTui(state, { type: "inspector-opened", actionId: "resumed-action" });
    state = reduceTui(state, {
      type: "inspector-loaded",
      actionId: "resumed-action",
      detail: { ...DETAIL, result: '{ "content": "artifact preview only" }' },
    });

    const stringify = vi.spyOn(JSON, "stringify");
    try {
      const firstFrame = renderRunInspectorFrame(state, 88, 12);
      expect(firstFrame.maxScroll).toBeGreaterThan(20_000);
      expect(firstFrame.rows.join("\n")).not.toContain(exactTail);
      const stringifyCalls = stringify.mock.calls.length;
      let tailFrame: readonly string[] | undefined;
      for (let offset = 40; offset >= 0; offset -= 1) {
        const tailState = reduceTui(state, {
          type: "inspector-scrolled",
          delta: firstFrame.maxScroll - offset,
          maxScroll: firstFrame.maxScroll,
        });
        const candidate = renderRunInspectorFrame(tailState, 88, 12).rows;
        if (candidate.join("\n").includes(exactTail)) {
          tailFrame = candidate;
          break;
        }
      }

      expect(tailFrame?.join("\n")).toContain(exactTail);
      expect(tailFrame?.join("\n")).not.toContain("artifact preview only");
      expect(stringify.mock.calls).toHaveLength(stringifyCalls);
    } finally {
      stringify.mockRestore();
    }
  });

  test("puts the error above the program and does not repeat it as a result", () => {
    const body = render(stateWithRun({ failed: true }), 88, 60).join("\n");

    expect(body).toContain("× failed");
    expect(body.indexOf("ERROR")).toBeLessThan(body.indexOf("SOURCE"));
    expect(body).toContain("ToolError: files.write denied");
    expect(body).not.toContain("RESULT");
  });

  test("keeps a failed action's exact structured output in raw mode", () => {
    const failed = stateWithRun({ failed: true });
    const timeline = failed.timeline.map((entry) =>
      entry.kind === "action" && entry.actionId === "x1"
        ? {
            ...entry,
            output: {
              error: "ToolError: files.write denied by permission policy",
              diagnostics: { operationId: "write-17", attempts: 2 },
            },
          }
        : entry,
    );
    const semantic = render({ ...failed, timeline }, 88, 60).join("\n");
    const raw = render(reduceTui({ ...failed, timeline }, { type: "inspector-view-toggled" }), 88, 60).join(
      "\n",
    );

    expect(semantic).toContain("ToolError: files.write denied");
    expect(semantic).not.toContain("RESULT");
    expect(semantic).not.toContain("diagnostics");
    expect(raw).toContain("RAW RESULT");
    expect(raw).toContain('"diagnostics"');
    expect(raw).toContain('"operationId": "write-17"');
    expect(raw).toContain('"attempts": 2');
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

  test("sanitizes hostile terminal controls in phase text before rendering", () => {
    const detail: TuiExecutionDetail = {
      ...DETAIL,
      phases: [
        {
          index: 0,
          name: `prepare${ESC}[31m\u0007phase`,
          status: `pending${ESC}[32m`,
          error: `bad${ESC}[2J\u0000news`,
        },
      ],
    };
    const body = render(stateWithRun({ detail }), 88, 60).join("\n");

    expect(body).not.toContain(ESC);
    expect(body).not.toContain("\u0007");
    expect(body).not.toContain("\u0000");
    expect(body).toContain("prepare [31m phase");
    expect(body).toContain("pending [32m");
    expect(body).toContain("bad [2J news");
  });

  test("sanitizes every scalar metadata boundary without flattening content sections", () => {
    const hostile = `${ESC}]52;c;copied\u0007\nINJECTED`;
    const detail: TuiExecutionDetail = {
      ...DETAIL,
      executionId: `exec${hostile}`,
      parentExecutionId: `parent${hostile}`,
      catalogDigest: `catalog${hostile}`,
      sourceDigest: `source${hostile}`,
      startedAt: `started${hostile}`,
      completedAt: `completed${hostile}`,
      stdoutArtifact: {
        artifactId: "artifact-hostile",
        path: `stdout${hostile}`,
        mediaType: "text/plain",
        preview: "first\nsecond",
        truncated: false,
      },
    };
    const state = stateWithRun({ detail });
    const timeline = state.timeline.map((entry) =>
      entry.kind === "action"
        ? {
            ...entry,
            name: `${entry.name}${hostile}`,
          }
        : entry,
    );
    const rows = render({ ...state, timeline }, 120, 100);
    const body = rows.join("\n");

    expect(body).not.toContain(ESC);
    expect(body).not.toContain("\u0007");
    expect(body).toContain("]52;c;copied  INJECTED");
    expect(rows.findIndex((row) => row.includes("first")) + 1).toBe(
      rows.findIndex((row) => row.includes("second")),
    );
  });

  test("preserves leading, trailing, and whitespace-only artifact preview rows", () => {
    const detail: TuiExecutionDetail = {
      ...DETAIL,
      stdoutArtifact: {
        artifactId: "artifact-1",
        path: ".noesis/artifacts/codemode/0370194c/stdout.log",
        mediaType: "text/plain",
        preview: "\n  indented\ntrailing\n",
        truncated: false,
      },
      stderrArtifact: {
        artifactId: "artifact-2",
        path: ".noesis/artifacts/codemode/0370194c/stderr.log",
        mediaType: "text/plain",
        preview: " \n\t",
        truncated: false,
      },
    };
    const rows = render(stateWithRun({ detail }), 88, 80);
    const stdout = rows.findIndex((row) => row.includes("STDOUT"));
    const content = (offset: number): string => (rows[stdout + offset]?.slice(2, -2) ?? "").trimEnd();
    const body = rows.join("\n");

    expect(stdout).toBeGreaterThanOrEqual(0);
    expect(content(1)).toBe("");
    expect(content(2)).toBe("  indented");
    expect(content(3)).toBe("trailing");
    expect(content(4)).toBe("");
    expect(body).not.toContain("(empty)");
  });

  test("renders pending and unknown statuses without success semantics", () => {
    const detail: TuiExecutionDetail = {
      ...DETAIL,
      phases: [
        { index: 0, name: "queued", status: "pending" },
        { index: 1, name: "unexpected", status: "mystery" },
      ],
    };
    const colored = render({ ...stateWithRun({ detail }), colorEnabled: true }, 88, 60).join("\n");
    const fallback = stateWithRun();
    const [unknownTitle] = render({ ...fallback, timeline: [], colorEnabled: false }, 88, 24);

    expect(colored).toContain(`${YELLOW}○${RESET} queued`);
    expect(colored).toContain(`${YELLOW}?${RESET} unexpected`);
    expect(colored).not.toContain("✓ queued");
    expect(colored).not.toContain("✓ unexpected");
    expect(unknownTitle).toContain("? unknown");
    expect(unknownTitle).not.toContain("✓ unknown");
  });

  test("reports the visible range and clamps scrolling to the content", () => {
    const whole = render(stateWithRun({ detail: DETAIL }), 88, 60);
    const scrolled = render(stateWithRun({ detail: DETAIL, scroll: 6 }), 88, 12);
    const overscrolled = render(stateWithRun({ detail: DETAIL, scroll: 900 }), 88, 12);

    expect(whole.at(-1)).toContain("29 rows");
    expect(scrolled.at(-1)).toContain("7–16 of 29");
    // Scrolling past the end settles on the last screen instead of running off it.
    expect(overscrolled.at(-1)).toContain("20–29 of 29");
  });

  test("renders nothing without an open inspector or usable space", () => {
    const state = stateWithRun({ detail: DETAIL });

    expect(renderRunInspector(reduceTui(state, { type: "inspector-closed" }), 88, 24)).toEqual([]);
    expect(renderRunInspector(state, 8, 24)).toEqual([]);
    expect(renderRunInspector(state, 88, 2)).toEqual([]);
  });

  test("emits no styling when color is disabled", () => {
    const body = render(stateWithRun({ detail: DETAIL }), 88, 60).join("\n");

    expect(body).not.toContain(String.fromCodePoint(27));
  });
});
