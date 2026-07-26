import { describe, expect, test } from "vitest";
import { highlightCode, syntaxLanguage } from "../src/index.ts";

const ESC = String.fromCodePoint(27);
const SGR_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, "gu");
const stripAnsi = (text: string): string => text.replaceAll(SGR_PATTERN, "");

const MAGENTA = `${ESC}[35m`;
const GREEN = `${ESC}[32m`;
const YELLOW = `${ESC}[33m`;
const CYAN = `${ESC}[36m`;
const DIM = `${ESC}[2m`;
const RESET = `${ESC}[0m`;

const highlight = (code: string, language: string): string[] =>
  highlightCode(code, language, true);

describe("syntax language resolution", () => {
  test.each([
    ["js", "js"],
    ["JavaScript", "js"],
    ["ts", "js"],
    ["tsx", "js"],
    ["json", "json"],
    ["bash", "shell"],
    ["sh", "shell"],
  ] as const)("maps %s to %s", (alias, expected) => {
    expect(syntaxLanguage(alias)).toBe(expected);
  });

  test("leaves unknown and missing languages unresolved", () => {
    expect(syntaxLanguage("rust")).toBeUndefined();
    expect(syntaxLanguage(undefined)).toBeUndefined();
  });
});

describe("code highlighting", () => {
  test("returns the source unchanged for an unrecognized language", () => {
    expect(highlight("SELECT 1;\nSELECT 2;", "sql")).toEqual([
      "SELECT 1;",
      "SELECT 2;",
    ]);
  });

  test("emits no escape sequences when color is disabled", () => {
    const source = 'const path = "state.ts"; // note';

    expect(highlightCode(source, "js", false)).toEqual([source]);
  });

  test("classifies the parts of a codemode call", () => {
    const [line] = highlight(
      "const file = await tools.files.read({ n: 1 });",
      "js",
    );

    expect(line).toContain(`${MAGENTA}const${RESET}`);
    expect(line).toContain(`${MAGENTA}await${RESET}`);
    // `read` is called, so it reads as a function while its object path stays plain.
    expect(line).toContain(`${CYAN}read${RESET}`);
    expect(line).toContain("tools");
    expect(line).toContain(`${YELLOW}1${RESET}`);
    expect(line).toContain(`${DIM};${RESET}`);
    expect(stripAnsi(line ?? "")).toBe(
      "const file = await tools.files.read({ n: 1 });",
    );
  });

  test("dims comments and colors strings and constants", () => {
    const lines = highlight(
      '// why\nlet done = true;\nlet name = "noesis";',
      "js",
    );

    expect(lines[0]).toBe(`${DIM}// why${RESET}`);
    expect(lines[1]).toContain(`${YELLOW}true${RESET}`);
    expect(lines[2]).toContain(`${GREEN}"noesis"${RESET}`);
  });

  test("separates a regex literal from a division", () => {
    const [regex] = highlight("const matched = /ab+c/gu.test(value);", "js");
    const [division] = highlight("const ratio = total / count;", "js");

    expect(regex).toContain(`${GREEN}/ab+c/gu${RESET}`);
    expect(division).toContain(`${DIM}/${RESET}`);
    expect(division).not.toContain(GREEN);
  });

  test("highlights expressions inside a template interpolation", () => {
    const [line] = highlight("await run(`rg ${query} ${count + 1}`);", "js");

    expect(line).toContain(`${GREEN}\`rg ${RESET}`);
    expect(line).toContain(`${YELLOW}1${RESET}`);
    expect(stripAnsi(line ?? "")).toBe(
      "await run(`rg ${query} ${count + 1}`);",
    );
  });

  test("keeps a multi-line block comment on its own lines", () => {
    const lines = highlight("/* one\n   two */\nreturn 1;", "js");

    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(`${DIM}/* one${RESET}`);
    expect(lines[1]).toBe(`${DIM}   two */${RESET}`);
    expect(lines[2]).toContain(`${MAGENTA}return${RESET}`);
  });

  test("distinguishes JSON keys from string values", () => {
    const lines = highlight(
      '{\n  "path": "state.ts",\n  "ok": true\n}',
      "json",
    );

    expect(lines[1]).toContain(`${CYAN}"path"${RESET}`);
    expect(lines[1]).toContain(`${GREEN}"state.ts"${RESET}`);
    expect(lines[2]).toContain(`${MAGENTA}true${RESET}`);
  });

  test("marks shell commands, flags, and pipeline stages", () => {
    const [line] = highlight('rg -n "timeline" src | wc -l', "shell");

    expect(line).toContain(`${CYAN}rg${RESET}`);
    expect(line).toContain(`${YELLOW}-n${RESET}`);
    expect(line).toContain(`${GREEN}"timeline"${RESET}`);
    // The stage after the pipe is a command again rather than an argument.
    expect(line).toContain(`${CYAN}wc${RESET}`);
  });

  test("treats a redirection as part of the same command", () => {
    const [line] = highlight("pnpm test > out.log 2>&1", "shell");

    expect(line).toContain(`${CYAN}pnpm${RESET}`);
    expect(line).not.toContain(`${CYAN}1${RESET}`);
  });

  test("keeps shell keywords out of command position", () => {
    const [line] = highlight("for f in a b; do echo $f; done", "shell");

    expect(line).toContain(`${MAGENTA}for${RESET}`);
    expect(line).toContain(`${CYAN}echo${RESET}`);
    expect(line).toContain(`${MAGENTA}$f${RESET}`);
  });

  test("expands tabs and neutralizes escape sequences in the source", () => {
    const [line] = highlight(`\tconst x = 1; ${ESC}[31mred`, "js");

    expect(line?.startsWith("  ")).toBe(true);
    // The escape introducer becomes a space, so source text can never inject its own styling.
    expect(stripAnsi(line ?? "")).toBe("  const x = 1;  [31mred");
  });

  test("closes every style within the line that opened it", () => {
    const source = [
      "// leading note",
      "const query = `find ${root}/*.ts`;",
      "const total = items.filter((item) => /x/u.test(item)).length;",
    ].join("\n");

    for (const line of highlight(source, "js")) {
      const opened = [...line.matchAll(SGR_PATTERN)].filter(
        (match) => match[0] !== RESET,
      ).length;
      const closed = [...line.matchAll(SGR_PATTERN)].filter(
        (match) => match[0] === RESET,
      ).length;
      expect(closed).toBe(opened);
    }
  });

  test("terminates unterminated strings and comments at the source end", () => {
    expect(stripAnsi(highlight('const a = "open', "js").join("\n"))).toBe(
      'const a = "open',
    );
    expect(stripAnsi(highlight("const a = 1; /* open", "js").join("\n"))).toBe(
      "const a = 1; /* open",
    );
    expect(stripAnsi(highlight("const a = `open ${b", "js").join("\n"))).toBe(
      "const a = `open ${b",
    );
  });
});
