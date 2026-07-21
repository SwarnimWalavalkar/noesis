import { TUI, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  NOESIS_WORDMARK,
  createSafeEditor,
  createTranscriptRenderer,
  initialTuiState,
  renderBottomChrome,
  renderMessageBlock,
  renderNoesisState,
  renderRichText,
  renderTranscriptLines,
  safeTerminalText,
  sanitizeEditorText,
  streamingFrameDelay,
} from "../src/index.ts";

const stripAnsi = (text: string): string =>
  [0, 1, 2, 3, 4, 9, 31, 32, 33, 36].reduce((plain, code) => plain.replaceAll(`\u001b[${code}m`, ""), text);

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
    editor.handleInput?.("\u001b");
    await vi.advanceTimersByTimeAsync(20);
    editor.handleInput?.("[20");
    await vi.advanceTimersByTimeAsync(20);
    editor.handleInput?.("0~safe\u001b[201~");

    expect(editor.getText()).toBe("");
    await settleSafeEditorAmbiguity();

    expect(editor.getText()).toBe("safe");
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
    expect(submitted).toEqual(["safe\nBAD [2J  31m"]);
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
});

describe("Noesis transcript rendering", () => {
  test("wraps long prose to the actual display width", () => {
    const paragraph = Array.from({ length: 32 }, (_, index) => `word-${index}`).join(" ");
    const lines = renderMessageBlock({ role: "assistant", text: paragraph }, 36);

    expect(lines.length).toBeGreaterThan(4);
    expect(lines.every((line) => visibleWidth(line) <= 36)).toBe(true);
    expect(lines.join(" ")).toContain("word-0");
    expect(lines.join(" ")).toContain("word-31");
  });

  test("separates successive semantic message blocks with one optical row", () => {
    const state = {
      ...initialTuiState("fake"),
      messages: [
        { role: "user" as const, text: "First question" },
        { role: "assistant" as const, text: "First answer" },
        { role: "system" as const, text: "Lifecycle note" },
      ],
    };
    const rendered = renderTranscriptLines(state, 60);

    expect(rendered.join("\n")).toContain("YOU\n│ First question\n\nNOESIS\n  First answer\n\nNOTE");
    expect(rendered.filter((line) => line === "")).toHaveLength(2);
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

  test("elides responsively and never emits an over-width line", () => {
    const state = {
      ...initialTuiState("fake", {
        provider: "provider-with-a-long-name",
        model: "model-with-a-long-name",
      }),
      messages: [
        {
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
      const lines = [...renderNoesisState(state, width, height), ...renderBottomChrome(state, width, height)];
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
    expect(renderNoesisState(state, 120, 35).join("\n")).toContain(NOESIS_WORDMARK[0]);
    expect(renderNoesisState(state, 90, 28).join("\n")).not.toContain(NOESIS_WORDMARK[0]);
    expect(renderNoesisState(state, 34, 8).join("\n")).not.toContain(NOESIS_WORDMARK[0]);
  });

  test("keeps every owned emitted line inside terminal columns from 1 through 120", () => {
    const state = {
      ...initialTuiState("fake", {
        provider: "a-provider-name-that-must-elide",
        model: "a-model-name-that-must-elide",
        colorEnabled: true,
      }),
      error: "a deliberately long error with 界面 and 🧠 content",
      messages: [
        { role: "user" as const, text: "question with 界面" },
        { role: "assistant" as const, text: "answer\n\n```ts\nconst x = 1;\n```\n$$x+y$$ after" },
        { role: "system" as const, text: "a long ownership note" },
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

  test.each([
    "user",
    "assistant",
    "system",
  ] as const)("repeats %s ownership when cropping into one long semantic block", (role) => {
    const state = {
      ...initialTuiState("fake"),
      messages: [{ role, text: Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n") }],
    };
    const rendered = createTranscriptRenderer().renderViewport(state, 22, 5);
    const expectedLabel = role === "user" ? "YOU" : role === "assistant" ? "NOESIS" : "NOTE";

    expect(rendered[0]).toContain("earlier messages");
    expect(rendered[1]).toBe(expectedLabel);
    expect(rendered.join("\n")).toContain("line 29");
    expect(rendered.every((line) => visibleWidth(line) <= 22)).toBe(true);
  });

  test("reuses completed semantic blocks and bounds history rendering work", () => {
    const renderer = createTranscriptRenderer();
    const completed = Array.from({ length: 100 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `completed ${String(index)}`,
    }));
    let state = { ...initialTuiState("fake"), messages: completed };
    renderer.renderViewport(state, 70, 12);
    for (let index = 1; index <= 40; index += 1) {
      state = {
        ...state,
        execution: "streaming",
        messages: [...completed, { role: "assistant", text: "chunk ".repeat(index * 20) }],
      };
      renderer.renderViewport(state, 70, 12);
    }
    const metrics = renderer.metrics();

    expect(metrics.parsedBlocks).toBeLessThanOrEqual(47);
    expect(metrics.cacheHits).toBeGreaterThanOrEqual(200);
    expect(metrics.candidateBlocks).toBeLessThanOrEqual(287);
    expect(streamingFrameDelay(200_000, 20_000)).toBe(80);
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
});
