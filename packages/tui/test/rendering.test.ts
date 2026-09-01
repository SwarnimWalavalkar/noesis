import { type Terminal, TUI, visibleWidth } from "@earendil-works/pi-tui";
import type { SubAgentSummary } from "@noesis/agent-types";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createSafeEditor,
  createTranscriptRenderer,
  executionIdOf,
  formatDuration,
  initialTuiState,
  inputModeLine,
  NOESIS_STARTUP_NOTES,
  NOESIS_WORDMARK,
  type NoesisTuiState,
  pickStartupNote,
  renderAgentActionBlock,
  renderBottomChrome,
  renderHeader,
  renderMessageBlock,
  renderNoesisState,
  renderRichText,
  renderSubagents,
  safeTerminalText,
  sanitizeEditorText,
  streamingFrameDelay,
  summarizeAction,
} from "../src/index.ts";

const renderTranscriptLines = (state: NoesisTuiState, width: number): readonly string[] =>
  createTranscriptRenderer().render(state, width);

const SGR_PATTERN = new RegExp(`${String.fromCodePoint(27)}\\[[0-9;]*m`, "gu");

const stripAnsi = (text: string): string => text.replaceAll(SGR_PATTERN, "");

const subAgentSummary = (agentId: string, status: SubAgentSummary["status"], name: string): SubAgentSummary =>
  Object.freeze({
    agentId,
    childSessionId: `session-${agentId}`,
    projectId: "project-test",
    originSessionId: "session-foreground",
    name,
    status,
    route: Object.freeze({ provider: "test-provider", model: "test-model" }),
    thinkingLevel: "high",
    latestTaskId: `task-${agentId}`,
    latestTaskStatus: status === "running" || status === "starting" ? "running" : "completed",
    latestActivity: "2026-08-31T00:00:02.000Z",
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:02.000Z",
  });

const containsUnsafeTextControl = (text: string): boolean =>
  [...text].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (code < 32 && code !== 9 && code !== 10) || (code >= 127 && code <= 159);
  });

const inertTerminal: Terminal = {
  columns: 120,
  rows: 35,
  kittyProtocolActive: false,
  start() {},
  stop() {},
  async drainInput() {},
  write() {},
  moveBy() {},
  hideCursor() {},
  showCursor() {},
  clearLine() {},
  clearFromCursor() {},
  clearScreen() {},
  setTitle() {},
  setProgress() {},
};

afterEach(() => vi.useRealTimers());

const settleSafeEditorAmbiguity = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(200);
};

describe("Noesis safe editor key path", () => {
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  test.each([
    ["Shift+Enter", "\u001b[27;2;13~"],
    ["Ctrl+J", "\n"],
  ] as const)("preserves pi-tui native %s multiline input", (_key, sequence) => {
    const submitted: string[] = [];
    const editor = createSafeEditor(new TUI(inertTerminal));
    editor.onSubmit = (text) => submitted.push(text);
    editor.handleInput?.("first");

    editor.handleInput?.(sequence);
    editor.handleInput?.("second");

    expect(editor.getText()).toBe("first\nsecond");
    expect(submitted).toEqual([]);
  });

  test("sanitizes programmatic buffer replacement and insertion", () => {
    const editor = createSafeEditor(new TUI(inertTerminal));

    editor.setText("first\u001b[2J\r\nsecond");
    editor.insertText("\u0007\nthird");

    expect(editor.getText()).toBe("first [2J\nsecond \nthird");
    expect(containsUnsafeTextControl(editor.getText())).toBe(false);
  });

  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  test.each([
    ["DEL", "\u007f"],
    ["BS", "\u0008"],
  ] as const)("delegates ordinary %s Backspace to pi-tui", (_variant, backspace) => {
    const editor = createSafeEditor(new TUI(inertTerminal));
    editor.handleInput?.("abc");

    editor.handleInput?.(backspace);

    expect(editor.getText()).toBe("ab");
  });

  test("preserves pi-tui grapheme deletion semantics", () => {
    const editor = createSafeEditor(new TUI(inertTerminal));
    editor.handleInput?.("a👨‍👩‍👧‍👦");

    editor.handleInput?.("\u007f");

    expect(editor.getText()).toBe("a");
  });

  test("preserves the line-start deletion binding used by terminal Cmd+Backspace mappings", () => {
    const editor = createSafeEditor(new TUI(inertTerminal));
    editor.handleInput?.("abc");

    editor.handleInput?.("\u0015");

    expect(editor.getText()).toBe("");
  });

  test("recognizes a paste start fragmented beyond pi-tui's assembly window", async () => {
    vi.useFakeTimers();
    const editor = createSafeEditor(new TUI(inertTerminal));
    const standaloneEscape = vi.fn(() => true);
    editor.createStandaloneEscapeHandler = () => standaloneEscape;
    editor.handleInput?.("\u001b");
    await vi.advanceTimersByTimeAsync(20);
    editor.handleInput?.("[20");
    await vi.advanceTimersByTimeAsync(20);
    editor.handleInput?.("0~safe\u001b[201~");

    expect(editor.getText()).toBe("");
    await settleSafeEditorAmbiguity();

    expect(editor.getText()).toBe("safe");
    expect(standaloneEscape).not.toHaveBeenCalled();
  });

  test("routes a settled standalone Escape only after paste ambiguity expires", async () => {
    vi.useFakeTimers();
    const editor = createSafeEditor(new TUI(inertTerminal));
    const standaloneEscape = vi.fn(() => true);
    editor.createStandaloneEscapeHandler = () => standaloneEscape;

    editor.handleInput?.("\u001b");
    await vi.advanceTimersByTimeAsync(49);
    expect(standaloneEscape).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(standaloneEscape).toHaveBeenCalledOnce();
    expect(editor.getText()).toBe("");
  });

  test("routes a complete Kitty Escape sequence without paste ambiguity delay", () => {
    const editor = createSafeEditor(new TUI(inertTerminal));
    const standaloneEscape = vi.fn(() => true);
    editor.createStandaloneEscapeHandler = () => standaloneEscape;

    editor.handleInput?.("\u001b[27;1:1u");

    expect(standaloneEscape).toHaveBeenCalledOnce();
    expect(editor.getText()).toBe("");
  });

  test("sanitizes a bracketed-paste payload when its closing marker is split across chunks", async () => {
    vi.useFakeTimers();
    const editor = createSafeEditor(new TUI(inertTerminal));
    editor.handleInput?.("\u001b[200~safe\u001b[2J\u0007\u009b31m\u007f");
    editor.handleInput?.(" text\u001b[20");
    await vi.advanceTimersByTimeAsync(200);
    editor.handleInput?.("1~");

    await settleSafeEditorAmbiguity();

    expect(editor.getText()).toBe("safe [2J  31m  text");
    expect(containsUnsafeTextControl(editor.getText())).toBe(false);
  });

  test("quarantines an early close and malicious trailing Enter until the real close", async () => {
    vi.useFakeTimers();
    const submitted: string[] = [];
    const editor = createSafeEditor(new TUI(inertTerminal));
    editor.onSubmit = (text) => submitted.push(text);
    editor.handleInput?.("\u001b[200~safe\u001b[201~");
    editor.handleInput?.("\rBAD\u001b[2J\u0007\u009b31m\u007f\u001b[201~");

    expect(submitted).toEqual([]);
    await settleSafeEditorAmbiguity();

    expect(editor.getText()).toBe("safe\nBAD [2J  31m ");
    expect(containsUnsafeTextControl(editor.getText())).toBe(false);
    expect(submitted).toEqual([]);
    editor.handleInput?.("\r");
    expect(submitted).toEqual(["safe\nBAD [2J  31m "]);
  });

  test("treats bytes trailing a close in the same chunk as sanitized paste, never keys", async () => {
    vi.useFakeTimers();
    const submitted: string[] = [];
    const editor = createSafeEditor(new TUI(inertTerminal));
    editor.onSubmit = (text) => submitted.push(text);
    editor.handleInput?.("\u001b[200~safe\u001b[201~\r\u0003\u001b\u007f");

    await settleSafeEditorAmbiguity();

    expect(editor.getText()).toBe("safe\n   ");
    expect(containsUnsafeTextControl(editor.getText())).toBe(false);
    expect(submitted).toEqual([]);
  });

  test("settles standalone Escape without trapping later input and preserves key sequences", async () => {
    vi.useFakeTimers();
    const editor = createSafeEditor(new TUI(inertTerminal));
    editor.handleInput?.("\u001b");
    await settleSafeEditorAmbiguity();
    editor.handleInput?.("abc");
    editor.handleInput?.("\u001b[D");
    editor.handleInput?.("\u001b[3~");

    expect(editor.getText()).toBe("ab");
  });

  test("normalizes one CRLF when a large paste flush splits the pair", async () => {
    vi.useFakeTimers();
    const editor = createSafeEditor(new TUI(inertTerminal));
    const prefix = "x".repeat(1024 * 1024 - 5);

    editor.handleInput?.(`\u001b[200~${prefix}\r\nabcx\u001b[201~`);
    await settleSafeEditorAmbiguity();

    expect(editor.getText()).toBe(`${prefix}\nabcx`);
  });

  test("programmatic edits discard partial terminal input and its timers", async () => {
    vi.useFakeTimers();
    const editor = createSafeEditor(new TUI(inertTerminal));
    editor.handleInput?.("\u001b[200~discarded paste");

    editor.setText("replacement");
    editor.handleInput?.("\u001b");
    editor.insertText(" + inserted");
    await settleSafeEditorAmbiguity();

    expect(editor.getText()).toBe("replacement + inserted");
  });
});

describe("Noesis transcript rendering", () => {
  const codemodeActions = () => {
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const execute = {
      actionId: "execute-1",
      name: "execute",
      status: "completed" as const,
      input: {
        source: "const file = await tools.files.read({ path: 'state.ts' });\nreturn file.totalLines;",
      },
      output: { calls: 2, details: { kind: "result", executionId: "exec-9" } },
      durationMs: 1_240,
    };
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const read = {
      actionId: "execute-1:call:1",
      parentActionId: "execute-1",
      name: "files.read",
      status: "completed" as const,
      input: { path: "packages/tui/src/state.ts" },
      // Codemode returns whole file bodies; this is the payload that must not reach the transcript.
      output: {
        path: "/repo/packages/tui/src/state.ts",
        content: "x".repeat(50_000),
        totalLines: 287,
        truncated: false,
      },
    };
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const write = {
      actionId: "execute-1:call:2",
      parentActionId: "execute-1",
      name: "files.write",
      status: "completed" as const,
      input: { path: "notes.md", content: "y".repeat(1_234) },
      output: { path: "/repo/notes.md", bytes: 1_234 },
    };
    return { execute, read, write, all: [execute, read, write] };
  };

  test("leaves an empty transcript blank so the header startup note owns the invitation", () => {
    const state = initialTuiState("fake");
    expect(createTranscriptRenderer().render(state, 80)).toEqual([]);
  });

  test("renders transcript content once messages arrive", () => {
    const rendered = createTranscriptRenderer().render(
      {
        ...initialTuiState("fake"),
        timeline: [{ kind: "message", role: "user", text: "Begin." }],
      },
      80,
    );

    expect(rendered.join("\n")).toContain("Begin.");
  });

  test("collapses each codemode call to one summarized row", () => {
    const { execute, read, write, all } = codemodeActions();

    const executeRow = renderAgentActionBlock(execute, all, 100);
    const readRow = renderAgentActionBlock(read, all, 100);
    const writeRow = renderAgentActionBlock(write, all, 100);

    expect(executeRow).toHaveLength(1);
    expect(executeRow[0]).toContain("2 calls");
    expect(executeRow[0]).toContain("1 files.read");
    expect(executeRow[0]).toContain("1.2s");

    expect(readRow).toHaveLength(1);
    expect(readRow[0]).toContain("state.ts");
    expect(readRow[0]).toContain("287 lines");
    expect(readRow[0]).not.toContain("xxx");

    expect(writeRow[0]).toContain("notes.md");
    expect(writeRow[0]).toContain("1.2 kB");
  });

  test("summarizes selective file writes by replacement count", () => {
    const action = {
      actionId: "write-replacements",
      name: "files.write",
      status: "completed" as const,
      input: { mode: "replace", path: "notes.md", edits: [] },
      output: { mode: "replace", path: "/repo/notes.md", bytes: 120, replacements: 2 },
    };

    const row = renderAgentActionBlock(action, [action], 100);
    expect(row[0]).toContain("notes.md");
    expect(row[0]).toContain("2 replacements");
    expect(row[0]).not.toContain("120 B");
  });

  test("carries rounded duration boundaries into the next unit", () => {
    expect(formatDuration(999.4)).toBe("999ms");
    expect(formatDuration(999.5)).toBe("1.0s");
    expect(formatDuration(59_949)).toBe("59.9s");
    expect(formatDuration(59_950)).toBe("1m 00s");
    expect(formatDuration(119_999)).toBe("2m 00s");
  });

  test("resolves failed execute runs from their last durable activity update", () => {
    expect(
      executionIdOf({
        actionId: "execute-failed",
        name: "execute",
        status: "failed",
        update: {
          kind: "activity",
          executionId: "execution-failed",
          activity: { type: "tool-end", name: "shell.run", ok: false },
        },
        output: { content: [{ type: "text", text: "execution failed" }] },
      }),
    ).toBe("execution-failed");
  });

  test("uses a durable execution identity directly after session hydration", () => {
    expect(
      executionIdOf({
        actionId: "action-hydrated",
        executionId: "execution-hydrated",
        name: "execute",
        status: "interrupted",
      }),
    ).toBe("execution-hydrated");
  });

  test("reveals the codemode program only when its row is expanded", () => {
    const { execute, all } = codemodeActions();

    const collapsed = renderAgentActionBlock(execute, all, 100).join("\n");
    const expanded = renderAgentActionBlock(execute, all, 100, {
      expanded: true,
    }).join("\n");

    expect(collapsed).not.toContain("tools.files.read");
    expect(expanded).toContain("tools.files.read");
    expect(expanded).toContain("return file.totalLines;");
  });

  test("summarizes a failed nested call with its error rather than its payload", () => {
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const failed = {
      actionId: "execute-1:call:1",
      parentActionId: "execute-1",
      name: "shell.run",
      status: "failed" as const,
      input: { command: "pnpm test" },
      output: { error: "command exited with 1" },
    };

    const rendered = renderAgentActionBlock(failed, [failed], 72).join("\n");

    expect(rendered).toContain("× shell.run");
    expect(rendered).toContain("command exited with 1");
  });

  test("sanitizes hostile action summary fields and keeps them on one line", () => {
    const hostile = "safe\u001b[31m\u001b]0;owned\u0007\u009dC1\u009c\nSECOND-LINE";
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const actions = [
      {
        actionId: "shell",
        name: "shell.run",
        status: "completed" as const,
        input: { command: hostile },
        output: { exitCode: 0 },
      },
      {
        actionId: "read",
        name: "files.read",
        status: "completed" as const,
        input: { path: `/tmp/${hostile}` },
        output: { totalLines: 1 },
      },
      {
        actionId: "search",
        name: "files.search",
        status: "completed" as const,
        input: { query: hostile },
        output: { matches: [] },
      },
      {
        actionId: "fetch",
        name: "web.fetch",
        status: "completed" as const,
        input: { url: `https://${hostile}` },
        output: { status: 200 },
      },
      {
        actionId: "failed",
        name: "custom.tool",
        status: "failed" as const,
        output: { error: hostile },
      },
      {
        actionId: "execute",
        name: "execute",
        status: "running" as const,
        input: { source: hostile },
      },
    ];

    for (const action of actions) {
      const summary = summarizeAction(action, []);
      const rendered = [summary.name, summary.subject, summary.outcome]
        .filter((field): field is string => field !== undefined)
        .join(" ");
      expect(rendered).not.toContain("\u001b");
      expect(rendered).not.toContain("\u0007");
      expect(rendered).not.toContain("\u009d");
      expect(rendered).not.toContain("\u009c");
      expect(rendered).not.toContain("\n");
      expect(rendered).not.toContain("SECOND-LINE");
    }
  });

  test("previews the program while an execute call has produced no nested calls yet", () => {
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const running = {
      actionId: "execute-1",
      name: "execute",
      status: "running" as const,
      input: { source: "await tools.shell.run({ command: 'pnpm build' });" },
    };

    expect(renderAgentActionBlock(running, [running], 100).join("\n")).toContain("pnpm build");
  });

  test("summarizes direct noesis.search arrays semantically", () => {
    const search = summarizeAction(
      {
        actionId: "search-tools",
        name: "noesis.search",
        status: "completed",
        input: { query: "files" },
        output: [
          { name: "files.read", description: "Read files", score: 0.9 },
          { name: "files.search", description: "Search files", score: 0.8 },
        ],
      },
      [],
    );
    expect(search).toMatchObject({ subject: '"files"', outcome: "2 tools" });
  });

  test("pluralizes Capability inspection counts", () => {
    const singular = summarizeAction(
      {
        actionId: "inspect-one-capability",
        name: "capabilities.inspect",
        status: "completed",
        input: { view: "list" },
        output: { view: "list", total: 1 },
      },
      [],
    );
    const plural = summarizeAction(
      {
        actionId: "inspect-many-capabilities",
        name: "capabilities.inspect",
        status: "completed",
        input: { view: "list" },
        output: { view: "list", total: 3 },
      },
      [],
    );

    expect(singular).toMatchObject({ outcome: "1 Capability" });
    expect(plural).toMatchObject({ outcome: "3 Capabilities" });
  });

  test("summarizes generic result collection envelopes by item count", () => {
    const summary = summarizeAction(
      {
        actionId: "wrapped-results",
        name: "custom.search",
        status: "completed",
        output: { results: [{ id: "first" }, { id: "second" }] },
      },
      [],
    );

    expect(summary).toMatchObject({ outcome: "2 items" });
  });

  test("keeps process subagents fixed near the composer and their child tools out of the transcript", () => {
    const execute = {
      actionId: "execute-1",
      name: "execute",
      status: "running" as const,
    };
    const state: NoesisTuiState = {
      ...initialTuiState("fake"),
      timeline: [{ kind: "action", ...execute }],
      subAgents: [subAgentSummary("agent-inspect", "running", "Inspect the package metadata.")],
    };
    const transcript = stripAnsi(renderTranscriptLines(state, 72).join("\n"));
    expect(transcript).toContain("execute");
    expect(transcript).not.toContain("subagent");
    expect(transcript).not.toContain("files.read");
    expect(transcript).not.toContain("package.json");

    const fixed = stripAnsi(renderSubagents(state, 72, 30).join("\n"));
    expect(fixed).toContain("SUBAGENTS · 1");
    expect(fixed).toContain("Inspect the package metadata.");
    expect(fixed).toContain("running · test-provider");

    const inspecting: NoesisTuiState = {
      ...state,
      subAgentCursor: "agent-inspect",
    };
    const selectedPanel = stripAnsi(renderSubagents(inspecting, 72, 30).join("\n"));
    expect(selectedPanel).toContain("▸ ● Inspect the package metadata.");
    expect(stripAnsi(renderTranscriptLines(inspecting, 72).join("\n"))).not.toContain("files.read");
  });

  test("shows only active subagents until Ctrl+O reveals the selected run", () => {
    const state: NoesisTuiState = {
      ...initialTuiState("fake"),
      timeline: [{ kind: "action", actionId: "execute-1", name: "execute", status: "running" }],
      subAgents: [
        subAgentSummary("agent-running", "running", "Watch the active migration."),
        subAgentSummary("agent-completed", "idle", "Review the finished migration."),
      ],
    };

    const collapsed = stripAnsi(renderSubagents(state, 120, 30).join("\n"));
    expect(collapsed).toContain("SUBAGENTS · 2");
    expect(collapsed).toContain("1 running subagent · 1 idle subagent · ctrl+o expand");
    expect(collapsed).toContain("Watch the active migration.");
    expect(collapsed).not.toContain("completed subagent");
    expect(collapsed).not.toContain("Review the finished migration.");

    const inspecting: NoesisTuiState = {
      ...state,
      subAgentCursor: "agent-completed",
    };
    const expanded = stripAnsi(renderSubagents(inspecting, 120, 30).join("\n"));
    expect(expanded).toContain("SUBAGENTS · 2");
    expect(expanded).toContain("1 running subagent · 1 idle subagent");
    expect(expanded).toContain("enter inspect · tab transcript");
    expect(expanded).toContain("Watch the active migration.");
    expect(expanded).toContain("▸ ✓ Review the finished migration.");
  });

  test("shows the current live phase beside an active process subagent", () => {
    const state: NoesisTuiState = {
      ...initialTuiState("fake"),
      subAgents: [subAgentSummary("agent-running", "running", "Inspect active work.")],
      subAgentPhases: { "agent-running": "tool · shell.run" },
    };

    expect(stripAnsi(renderSubagents(state, 120, 30).join("\n"))).toContain(
      "running · tool · shell.run · test-provider/test-model",
    );
  });

  test("keeps settled process subagents collapsed until Ctrl+O selects the actor", () => {
    const state: NoesisTuiState = {
      ...initialTuiState("fake"),
      timeline: [
        { kind: "action", actionId: "execute-earlier", name: "execute", status: "completed" },
        { kind: "action", actionId: "execute-latest", name: "execute", status: "completed" },
      ],
      subAgents: [subAgentSummary("agent-earlier", "idle", "Inspect the earlier run.")],
    };

    expect(stripAnsi(renderSubagents(state, 120, 30).join("\n"))).not.toContain("Inspect the earlier run.");
    expect(
      stripAnsi(renderSubagents({ ...state, actionCursor: "execute-latest" }, 120, 30).join("\n")),
    ).not.toContain("Inspect the earlier run.");

    const inspectingEarlier = stripAnsi(
      renderSubagents({ ...state, subAgentCursor: "agent-earlier" }, 120, 30).join("\n"),
    );
    expect(inspectingEarlier).toContain("SUBAGENTS · 1");
    expect(inspectingEarlier).toContain("Inspect the earlier run.");
  });

  test("shows a retained subagent independently of the transcript action tree", () => {
    const state: NoesisTuiState = {
      ...initialTuiState("fake"),
      timeline: [
        { kind: "action", actionId: "execute-parent", name: "execute", status: "completed" },
        {
          kind: "action",
          actionId: "saved-script",
          parentActionId: "execute-parent",
          name: "programs.run",
          status: "completed",
        },
      ],
      subAgents: [subAgentSummary("agent-nested", "idle", "Inspect from the saved script.")],
      subAgentCursor: "agent-nested",
    };

    const rendered = stripAnsi(renderSubagents(state, 120, 30).join("\n"));
    expect(rendered).toContain("SUBAGENTS · 1");
    expect(rendered).toContain("Inspect from the saved script.");
  });

  test("indents nested codemode SDK calls under execute", () => {
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const parent = {
      actionId: "execute-1",
      name: "execute",
      status: "running" as const,
    };
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const child = {
      actionId: "execute-1:call:1",
      parentActionId: parent.actionId,
      name: "shell.run",
      status: "running" as const,
      input: { command: "pwd" },
    };

    const [rendered = ""] = renderAgentActionBlock(child, [parent, child], 72);

    expect(rendered).toContain("● shell.run");
    expect(rendered).toContain("pwd");
    expect(rendered.startsWith("   ")).toBe(true);
  });

  test("marks the selected row without shifting the content beside it", () => {
    const { read, all } = codemodeActions();

    const [plain = ""] = renderAgentActionBlock(read, all, 100);
    const [selected = ""] = renderAgentActionBlock(read, all, 100, {
      selected: true,
    });

    expect(plain.startsWith(" ")).toBe(true);
    expect(selected.startsWith("▸")).toBe(true);
    // A leading gutter column means selecting a row never reflows the transcript.
    expect(visibleWidth(selected)).toBe(visibleWidth(plain));
  });

  test("keeps the selected action inside a bounded transcript navigation window", () => {
    let state = initialTuiState("fake");
    for (let index = 1; index <= 12; index += 1)
      state = {
        ...state,
        timeline: [
          ...state.timeline,
          {
            kind: "action",
            actionId: `action-${String(index)}`,
            name: "files.read",
            status: "completed",
            input: { path: `file-${String(index)}.ts` },
          },
        ],
      };
    state = {
      ...state,
      actionCursor: "action-12",
    };
    const renderer = createTranscriptRenderer();

    const newest = renderer.renderWindow(state, 72, 5).join("\n");
    const earlier = renderer.renderWindow({ ...state, actionCursor: "action-2" }, 72, 5).join("\n");

    expect(newest).toContain("file-12.ts");
    expect(newest).not.toContain("file-1.ts");
    expect(earlier).toContain("file-2.ts");
    expect(earlier).not.toContain("file-12.ts");
  });

  test("scrolls the ordinary transcript view to the selected action without changing its height", () => {
    let state = initialTuiState("fake");
    for (let index = 1; index <= 24; index += 1)
      state = {
        ...state,
        timeline: [
          ...state.timeline,
          {
            kind: "action",
            actionId: `action-${String(index)}`,
            name: "files.read",
            status: "completed",
            input: { path: `file-${String(index)}.ts` },
          },
        ],
      };
    const ordinary = renderNoesisState(state, 72, 20);
    const navigated = renderNoesisState({ ...state, actionCursor: "action-2" }, 72, 20);
    const visibleTail = navigated.slice(-10).join("\n");

    expect(navigated).toHaveLength(ordinary.length);
    expect(visibleTail).toContain("file-2.ts");
    expect(visibleTail).not.toContain("file-24.ts");
    expect(visibleTail).not.toContain("TRANSCRIPT");
  });

  test("wraps long prose to the actual display width", () => {
    const paragraph = Array.from({ length: 32 }, (_, index) => `word-${index}`).join(" ");
    const lines = renderMessageBlock({ role: "assistant", text: paragraph }, 36);

    expect(lines.length).toBeGreaterThan(4);
    expect(lines.every((line) => visibleWidth(line) <= 36)).toBe(true);
    expect(lines.join(" ")).toContain("word-0");
    expect(lines.join(" ")).toContain("word-31");
  });

  test("separates successive semantic message blocks with one optical row", () => {
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const state = {
      ...initialTuiState("fake"),
      timeline: [
        {
          kind: "message" as const,
          role: "user" as const,
          text: "First question",
        },
        {
          kind: "message" as const,
          role: "assistant" as const,
          text: "First answer",
        },
        {
          kind: "message" as const,
          role: "system" as const,
          text: "Lifecycle note",
        },
      ],
    };
    const rendered = renderTranscriptLines(state, 60);

    expect(rendered.join("\n")).toContain("YOU\n│ First question\n\nNOESIS\n│ First answer\n\nNOTE");
    expect(rendered.filter((line) => line === "")).toHaveLength(2);
  });

  test("flows actions chronologically between assistant response segments without a separate panel", () => {
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const state = {
      ...initialTuiState("fake"),
      timeline: [
        {
          kind: "message" as const,
          role: "user" as const,
          text: "Check the repository.",
        },
        {
          kind: "message" as const,
          role: "assistant" as const,
          text: "I’ll inspect it first.",
        },
        {
          kind: "action" as const,
          actionId: "shell-1",
          name: "shell.run",
          status: "completed" as const,
          input: { command: "git status --short" },
          output: { stdout: "clean" },
        },
        {
          kind: "message" as const,
          role: "assistant" as const,
          text: "The worktree is clean.",
        },
      ],
    };

    const rendered = renderTranscriptLines(state, 72).join("\n");
    const user = rendered.indexOf("Check the repository.");
    const preTool = rendered.indexOf("I’ll inspect it first.");
    const action = rendered.indexOf("shell.run");
    const postTool = rendered.indexOf("The worktree is clean.");

    expect(user).toBeLessThan(preTool);
    expect(preTool).toBeLessThan(action);
    expect(action).toBeLessThan(postTool);
    expect(rendered).not.toContain("ACTIONS");
  });

  test("uses pi-tui Markdown for structured content", () => {
    const source = [
      "# Heading",
      "",
      "**bold** *emphasis* ~~removed~~ `inline()` [docs](https://example.com)",
      "",
      "1. ordered",
      "   - nested",
      "",
      "> quoted",
      "",
      "```ts",
      "const answer = 42;",
      "```",
      "",
      "| Name | Value |",
      "| --- | ---: |",
      "| alpha | 42 |",
    ].join("\n");
    const rendered = stripAnsi(renderRichText(source, 64, true).join("\n"));

    expect(rendered).toContain("Heading");
    expect(rendered).toContain("bold emphasis removed inline()");
    expect(rendered).toContain("docs (https://example.com)");
    expect(rendered).toContain("1. ordered\n    - nested");
    expect(rendered).toContain("│ quoted");
    expect(rendered).toContain("```ts\n  const answer = 42;\n```");
    expect(rendered).toContain("│ Name");
    expect(rendered).toContain("alpha");
  });

  test("preserves Unicode display width, indentation, and blank lines", () => {
    const source = "Emoji 🧠 and CJK 界面 stay visible.\n\n```text\n  indented\n\tTabbed\n```";
    const lines = renderRichText(source, 24);

    expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
    expect(lines.join("\n")).toContain("🧠");
    expect(lines.join("\n")).toContain("界面");
    expect(lines.join("\n")).toContain("    indented");
    expect(lines).toContain("");
  });

  test("protects inline math and separates display math without interpreting TeX", () => {
    const source = [
      "Inline $x_i^2 + **y**$ and \\(a_b = c\\) remain source.",
      "",
      "$$",
      "\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}",
      "$$",
      "",
      "\\[",
      "E = mc^2",
      "\\]",
    ].join("\n");
    const rendered = stripAnsi(renderRichText(source, 48, true).join("\n"));

    expect(rendered).toContain("$x_i^2 + **y**$");
    expect(rendered).toContain("\\(a_b = c\\)");
    expect(rendered).toContain("╭─ math\n│ $$\n│ \\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n│ $$\n╰─");
    expect(rendered).toContain("│ \\[\n│ E = mc^2\n│ \\]");
  });

  test("does not close display math on delimiters inside fenced code", () => {
    const source = [
      "$$",
      "before fence",
      "```text",
      "$$not a closer$$",
      "```",
      "after fence",
      "$$",
      "Outside math.",
    ].join("\n");
    const rendered = stripAnsi(renderRichText(source, 80, true).join("\n"));

    expect(rendered.match(/╭─ math/gu)).toHaveLength(1);
    expect(rendered).toContain("│ $$not a closer$$");
    expect(rendered).toContain("│ after fence");
    expect(rendered).toContain("Outside math.");
  });

  test("scans math delimiters conservatively around Markdown and streaming edges", () => {
    const source = [
      "Costs are $5 and $10; escaped \\$20 remains currency.",
      "Inline $x_i$ and \\(y = mx+b\\), then $a$ and $b$.",
      "Before $$x+y$$ after display math.",
      "Before \\[x+y\\] after bracket math.",
      "`code $not_math$`",
      "```text",
      "fenced $$not_math$$ and $still_code$",
      "```",
      "Unmatched stream $pending and \\(also pending",
    ].join("\n");
    const rendered = stripAnsi(renderRichText(source, 44, true).join("\n"));

    expect(rendered).toContain("Costs are $5 and $10; escaped \\$20 remains");
    expect(rendered).toContain("$x_i$");
    expect(rendered).toContain("\\(y = mx+b\\)");
    expect(rendered).toContain("╭─ math\n│ $$x+y$$\n╰─");
    expect(rendered).toContain("after display math.");
    expect(rendered).toContain("╭─ math\n│ \\[x+y\\]\n╰─");
    expect(rendered).toContain("after bracket math.");
    expect(rendered).toContain("code $not_math$");
    expect(rendered).toContain("fenced $$not_math$$ and $still_code$");
    expect(rendered).toContain("Unmatched stream $pending and \\(also pending");
    expect(renderRichText(source, 12).every((line) => visibleWidth(line) <= 12)).toBe(true);
  });

  test("never interprets inline or display math inside a multiline code span", () => {
    const source = [
      "Before `first line",
      "$$not display math$$ and $not inline math$",
      "\\(also not inline math\\) last line` after.",
    ].join("\n");
    const rendered = stripAnsi(renderRichText(source, 80, true).join("\n"));
    const unwrapped = rendered.replace(/\s+/gu, " ");

    expect(rendered).toContain("$$not display math$$");
    expect(rendered).toContain("$not inline math$");
    expect(unwrapped).toContain("\\(also not inline math\\)");
    expect(rendered).not.toContain("╭─ math");
  });

  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  test.each([
    ["backtick", "```", "````"],
    ["tilde", "~~~", "~~~~"],
  ] as const)(
    "requires a CommonMark-valid closer for a %s code fence",
    (_kind, openingFence, closingFence) => {
      const source = [
        `${openingFence}text`,
        "before",
        `${closingFence}not-a-closer`,
        "$$still code$$",
        `${closingFence} \t`,
        "$$display math$$",
      ].join("\n");
      const rendered = stripAnsi(renderRichText(source, 80, true).join("\n"));

      expect(rendered).toContain(`${closingFence}not-a-closer`);
      expect(rendered).toContain("$$still code$$");
      expect(rendered.match(/╭─ math/gu)).toHaveLength(1);
      expect(rendered).toContain("│ $$display math$$");
    },
  );

  test("closes fenced code blocks under CRLF line endings", () => {
    const source = ["```text", "$$still code$$", "```", "$$display math$$"].join("\r\n");
    const rendered = stripAnsi(renderRichText(source, 80, true).join("\n"));

    expect(rendered).toContain("$$still code$$");
    expect(rendered.match(/╭─ math/gu)).toHaveLength(1);
    expect(rendered).toContain("│ $$display math$$");
  });

  test("protects math inside blockquote-prefixed fenced code blocks", () => {
    const source = [
      "> ```text",
      "> $$still code$$ and $**still code**$",
      "> ```",
      "",
      "$$display math$$",
    ].join("\n");
    const rendered = stripAnsi(renderRichText(source, 80, true).join("\n"));

    expect(rendered).toContain("$$still code$$");
    expect(rendered).toContain("$**still code**$");
    expect(rendered.match(/╭─ math/gu)).toHaveLength(1);
    expect(rendered).toContain("│ $$display math$$");
  });

  test("does not treat escaped backticks as code-span openers", () => {
    const rendered = stripAnsi(
      renderRichText("Escaped \\` before $**x**$ remains prose.", 80, true).join("\n"),
    );

    expect(rendered).toContain("` before $**x**$ remains prose.");
  });

  test("neutralizes model-provided controls and ANSI sequences", () => {
    const hostile = "safe\u001b[2J text\u0007 and C1\u009b31m remains literal";
    const rendered = renderRichText(hostile, 60).join("\n");

    expect(rendered).not.toContain("\u001b");
    expect(rendered).not.toContain("\u0007");
    expect(rendered).not.toContain("\u009b");
    expect(rendered).toContain("safe [2J text  and C1 31m remains literal");
    expect(safeTerminalText(hostile)).toContain("safe [2J");
  });

  test("renders incomplete streaming fences and math delimiters safely", () => {
    const code = renderRichText("```ts\nconst pending = true;\n``", 40).join("\n");
    const math = renderRichText("Before\n\n$$\n\\frac{1}{2}", 40).join("\n");

    expect(code).toContain("```ts");
    expect(code).toContain("const pending = true;");
    expect(code).not.toContain("\u001b");
    expect(math).toContain("╭─ math");
    expect(math).toContain("│ $$");
    expect(math).toContain("│ \\frac{1}{2}");
    expect(math).toContain("╰─");
  });

  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  test("elides responsively and never emits an over-width line", () => {
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const state = {
      ...initialTuiState("fake", {
        provider: "provider-with-a-long-name",
        model: "model-with-a-long-name",
      }),
      timeline: [
        {
          kind: "message" as const,
          role: "assistant" as const,
          text: "A long answer with 🧠 Unicode and a table.\n\n| a | b |\n|---|---|\n| one | two |",
        },
      ],
    };
    for (const [width, height] of [
      [120, 35],
      [90, 28],
      [70, 22],
      [34, 8],
    ] as const) {
      const lines = [
        ...renderHeader(false, width, height),
        ...renderNoesisState(state, width, height),
        ...renderBottomChrome(state, width, height),
      ];
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
    expect(renderHeader(false, 120, 35).join("\n")).toContain(NOESIS_WORDMARK[0]);
    expect(renderHeader(false, 90, 28).join("\n")).not.toContain(NOESIS_WORDMARK[0]);
    expect(renderHeader(false, 34, 8).join("\n")).not.toContain(NOESIS_WORDMARK[0]);
  });

  test("picks a stable startup note from the invitation pool", () => {
    expect(NOESIS_STARTUP_NOTES.length).toBeGreaterThan(10);
    expect(NOESIS_STARTUP_NOTES.every((note) => [...note].length <= 46)).toBe(true);
    expect(pickStartupNote(() => 0)).toBe(NOESIS_STARTUP_NOTES[0]);
    expect(pickStartupNote(() => 0.999)).toBe(NOESIS_STARTUP_NOTES.at(-1));
  });

  test("keeps every owned emitted line inside terminal columns from 1 through 120", () => {
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const state = {
      ...initialTuiState("fake", {
        provider: "a-provider-name-that-must-elide",
        model: "a-model-name-that-must-elide",
        colorEnabled: true,
      }),
      error: "a deliberately long error with 界面 and 🧠 content",
      timeline: [
        {
          kind: "message" as const,
          role: "user" as const,
          text: "question with 界面",
        },
        {
          kind: "message" as const,
          role: "assistant" as const,
          text: "answer\n\n```ts\nconst x = 1;\n```\n$$x+y$$ after",
        },
        {
          kind: "message" as const,
          role: "system" as const,
          text: "a long ownership note",
        },
      ],
    };
    const editor = createSafeEditor(new TUI(inertTerminal));
    editor.focused = true;
    editor.handleInput?.("界面 and 🧠 input");
    for (let width = 1; width <= 120; width += 1) {
      for (const height of [1, 4, 8, 22, 35]) {
        const emitted = [
          ...renderNoesisState(state, width, height, createTranscriptRenderer()),
          ...renderBottomChrome(state, width, height),
        ];
        expect(
          emitted.every((line) => visibleWidth(line) <= width),
          `width=${String(width)} height=${String(height)}`,
        ).toBe(true);
      }
      expect(
        editor.render(width).every((line) => visibleWidth(line) <= width),
        `editor width=${String(width)}`,
      ).toBe(true);
    }
  });

  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  test.each(["user", "assistant", "system"] as const)(
    "keeps every line of a long %s message reachable",
    (role) => {
      // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
      const state = {
        ...initialTuiState("fake"),
        timeline: [
          {
            kind: "message" as const,
            role,
            text: Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n"),
          },
        ],
      };
      const rendered = createTranscriptRenderer().render(state, 22);
      const expectedLabel = role === "user" ? "YOU" : role === "assistant" ? "NOESIS" : "NOTE";

      expect(rendered[0]).toBe(expectedLabel);
      expect(rendered.join("\n")).toContain("line 0");
      expect(rendered.join("\n")).toContain("line 29");
      expect(rendered.every((line) => visibleWidth(line) <= 22)).toBe(true);
    },
  );

  test("bounds an expanded codemode program to the visible screen", () => {
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const state = {
      ...initialTuiState("fake"),
      timeline: [
        {
          kind: "action" as const,
          actionId: "execute-1",
          name: "execute",
          status: "completed" as const,
          input: {
            source: Array.from(
              { length: 30 },
              (_, index) => `const value${String(index)} = ${String(index)};`,
            ).join("\n"),
          },
        },
      ],
      expandedActionIds: new Set(["execute-1"]),
    };

    const rendered = createTranscriptRenderer().render(state, 32, 12);

    expect(rendered[0]).toContain("execute");
    expect(rendered.join("\n")).toContain("value0");
    // An inline body taller than the screen would push its own header above the viewport, which
    // makes pi-tui repaint everything and drop scrollback. The rest lives in the run inspector.
    expect(rendered.join("\n")).not.toContain("value29");
    expect(rendered.join("\n")).toContain("more rows");
    expect(rendered.length).toBeLessThanOrEqual(13);
    expect(rendered.every((line) => visibleWidth(line) <= 32)).toBe(true);
    expect(createTranscriptRenderer().render(state, 90, 12).join("\n")).toContain(
      "enter opens the run inspector",
    );
  });

  test("reuses settled blocks so a growing transcript reparses only what changed", () => {
    const renderer = createTranscriptRenderer();
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const completed = Array.from({ length: 100 }, (_, index) => ({
      kind: "message" as const,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `completed ${String(index)}`,
    }));
    let state = { ...initialTuiState("fake"), timeline: completed };
    renderer.render(state, 70);
    for (let index = 1; index <= 40; index += 1) {
      // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
      state = {
        ...state,
        execution: "streaming",
        timeline: [
          ...completed,
          {
            kind: "message",
            role: "assistant",
            text: "chunk ".repeat(index * 20),
          } as const,
        ],
      };
      renderer.render(state, 70);
    }
    const metrics = renderer.metrics();

    // 100 settled blocks parsed once, plus one reparse per streamed frame.
    expect(metrics.parsedBlocks).toBe(140);
    expect(metrics.cacheHits).toBe(4_000);
    expect(streamingFrameDelay(200_000, 20_000)).toBe(80);
  });

  test("invalidates an execute row when its child action summary changes", () => {
    const renderer = createTranscriptRenderer();
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const execute = {
      kind: "action" as const,
      actionId: "execute-1",
      name: "execute",
      status: "running" as const,
      input: { source: "return await noesis.invoke('shell.run', {});" },
    };
    const initial = {
      ...initialTuiState("fake"),
      timeline: [execute],
    };
    expect(renderer.render(initial, 80).join("\n")).toContain("noesis.invoke");

    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const runningChild = {
      kind: "action" as const,
      actionId: "execute-1:call:1",
      parentActionId: execute.actionId,
      name: "shell.run",
      status: "running" as const,
    };
    const withRunningChild = {
      ...initial,
      timeline: [execute, runningChild],
    };
    const running = renderer.render(withRunningChild, 80).join("\n");
    expect(running).toContain("1 call · 1 shell.run");
    expect(running).not.toContain("noesis.invoke");

    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const withFailedChild = {
      ...initial,
      timeline: [
        execute,
        {
          ...runningChild,
          status: "failed" as const,
          output: { error: "failed" },
        },
      ],
    };
    expect(renderer.render(withFailedChild, 80).join("\n")).toContain("1 call · 1 shell.run · 1 failure");
  });

  test("separates turns but keeps nested codemode calls tight under their parent", () => {
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const state = {
      ...initialTuiState("fake"),
      timeline: [
        {
          kind: "message" as const,
          role: "user" as const,
          text: "Audit the reducer.",
        },
        {
          kind: "action" as const,
          actionId: "execute-1",
          name: "execute",
          status: "completed" as const,
          input: { source: "return 1;" },
          output: { calls: 2 },
        },
        {
          kind: "action" as const,
          actionId: "execute-1:call:1",
          parentActionId: "execute-1",
          name: "files.read",
          status: "completed" as const,
          input: { path: "state.ts" },
          output: { path: "state.ts", totalLines: 12 },
        },
        {
          kind: "action" as const,
          actionId: "execute-1:call:2",
          parentActionId: "execute-1",
          name: "files.write",
          status: "completed" as const,
          input: { path: "notes.md" },
          output: { path: "notes.md", bytes: 20 },
        },
      ],
    };

    const rendered = createTranscriptRenderer().render(state, 80);

    // One row per action, one blank line before the execute block, none between nested calls.
    expect(rendered.filter((line) => line === "")).toHaveLength(1);
    expect(rendered).toHaveLength(6);
  });

  test("sanitizes live editor text without losing Unicode, newlines, or logical tabs", () => {
    const hostile = "hello\t界面\n\u001b[2J\u009b31m\u009dtitle\u009c\u007fworld";
    const safe = sanitizeEditorText(hostile);

    expect(safe).toContain("hello\t界面\n");
    expect(containsUnsafeTextControl(safe)).toBe(false);
    expect(safe).not.toContain("\u001b");
  });

  test("keeps the hand-owned wordmark stable and bottom chrome in input-status-help order", () => {
    expect(new Set(NOESIS_WORDMARK.map((line) => visibleWidth(line)))).toEqual(new Set([46]));
    expect(NOESIS_WORDMARK.every((line) => line === line.trimEnd() && line === line.trimStart())).toBe(true);

    const bottom = renderBottomChrome(initialTuiState("fake"), 90, 28);
    expect(bottom[0]).toContain("› message");
    expect(bottom[1]).toContain("● IDLE");
    expect(bottom[2]).toContain("? help");
  });

  test("labels subagent navigation as inspect mode while the editor is paused", () => {
    const state = { ...initialTuiState("fake"), subAgentCursor: "agent-live" };

    expect(inputModeLine(state, 90)).toContain("INSPECT");
    expect(inputModeLine(state, 90)).not.toContain("› message");
  });
});
