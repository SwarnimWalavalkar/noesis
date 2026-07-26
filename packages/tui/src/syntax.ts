/**
 * Token-level syntax highlighting for the three languages the TUI actually shows: codemode
 * programs and scripts (JavaScript), tool results and schemas (JSON), and the command strings
 * passed to `shell.run`. Terminal highlighting needs token classes rather than a parse tree, so
 * this is a scanner, and anything it does not recognize degrades to plain text instead of being
 * guessed at.
 */

import { ANSI, safeTerminalText } from "./theme.ts";

export type SyntaxLanguage = "js" | "json" | "shell";

const LANGUAGE_ALIASES: Readonly<Record<string, SyntaxLanguage>> = {
  javascript: "js",
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  node: "js",
  ts: "js",
  tsx: "js",
  typescript: "js",
  json: "json",
  json5: "json",
  jsonc: "json",
  bash: "shell",
  console: "shell",
  sh: "shell",
  shell: "shell",
  zsh: "shell",
};

export function syntaxLanguage(
  language: string | undefined,
): SyntaxLanguage | undefined {
  if (!language) return undefined;
  return LANGUAGE_ALIASES[
    language.trim().toLowerCase().split(/[\s:]/u)[0] ?? ""
  ];
}

type TokenStyle =
  | "plain"
  | "comment"
  | "keyword"
  | "constant"
  | "number"
  | "string"
  | "regexp"
  | "callable"
  | "key"
  | "punctuation"
  | "operator";

interface Token {
  readonly text: string;
  readonly style: TokenStyle;
}

type PushToken = (text: string, style: TokenStyle) => void;

/**
 * Built lazily rather than at module scope so this module never reads `theme.ts` bindings while
 * either module is still initializing.
 */
const tokenAnsi = (style: TokenStyle): string =>
  ({
    plain: "",
    comment: ANSI.dim,
    keyword: ANSI.magenta,
    constant: ANSI.yellow,
    number: ANSI.yellow,
    string: ANSI.green,
    regexp: ANSI.green,
    callable: ANSI.cyan,
    key: ANSI.cyan,
    punctuation: ANSI.dim,
    operator: ANSI.dim,
  })[style];

const JS_KEYWORDS = new Set([
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "of",
  "private",
  "protected",
  "public",
  "readonly",
  "return",
  "satisfies",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "try",
  "type",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

const JS_CONSTANTS = new Set([
  "false",
  "Infinity",
  "NaN",
  "null",
  "true",
  "undefined",
]);

const JSON_CONSTANTS = new Set(["false", "null", "true"]);

const SHELL_KEYWORDS = new Set([
  "case",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "fi",
  "for",
  "function",
  "if",
  "in",
  "local",
  "return",
  "select",
  "then",
  "until",
  "while",
]);

/** Shell keywords after which the next word is a command again rather than an argument. */
const SHELL_COMMAND_KEYWORDS = new Set(["do", "else", "then"]);

const JS_PUNCTUATION = new Set([
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  ",",
  ";",
  ":",
  ".",
]);
const IDENTIFIER_START = /[A-Za-z_$]/u;
const JS_NUMBER =
  /^(?:0[xX][0-9a-fA-F][0-9a-fA-F_]*|0[bB][01][01_]*|0[oO][0-7][0-7_]*|(?:\d[\d_]*(?:\.\d[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?)n?/u;
const JSON_NUMBER = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/u;
const MAX_TEMPLATE_DEPTH = 4;

const isDigit = (character: string): boolean =>
  character >= "0" && character <= "9";

const nextNonSpace = (source: string, from: number): string => {
  for (let index = from; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (!/\s/u.test(character)) return character;
  }
  return "";
};

/** Returns the index just past the closing quote, or the line end for an unterminated quote. */
function scanQuoted(source: string, start: number): number {
  const quote = source[start];
  const multiline = quote === "`";
  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === quote) return index + 1;
    if (character === "\n" && !multiline) return index;
    index += 1;
  }
  return index;
}

function scanRegex(source: string, start: number): number | undefined {
  let index = start + 1;
  let inCharacterClass = false;
  while (index < source.length) {
    const character = source[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === "\n") return undefined;
    if (inCharacterClass) {
      if (character === "]") inCharacterClass = false;
    } else if (character === "[") inCharacterClass = true;
    else if (character === "/") {
      index += 1;
      while (index < source.length && /[A-Za-z]/u.test(source[index] ?? ""))
        index += 1;
      return index;
    }
    index += 1;
  }
  return undefined;
}

/** Locates the `}` closing a template interpolation, stepping over nested braces and quotes. */
function matchingBrace(source: string, from: number): number {
  let depth = 0;
  let index = from;
  while (index < source.length) {
    const character = source[index];
    if (character === "'" || character === '"' || character === "`") {
      index = scanQuoted(source, index);
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") {
      if (depth === 0) return index;
      depth -= 1;
    }
    index += 1;
  }
  return index;
}

/** A `/` opens a regex only where a value may start, which the preceding token settles. */
function regexAllowed(previous: Token | undefined): boolean {
  if (!previous) return true;
  if (previous.style === "keyword" || previous.style === "operator")
    return true;
  if (previous.style === "punctuation")
    return previous.text !== ")" && previous.text !== "]";
  return false;
}

function pushTemplate(
  source: string,
  start: number,
  push: PushToken,
  depth: number,
): number {
  let index = start + 1;
  let chunkStart = start;
  while (index < source.length) {
    const character = source[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === "`") {
      push(source.slice(chunkStart, index + 1), "string");
      return index + 1;
    }
    if (character === "$" && source[index + 1] === "{") {
      push(source.slice(chunkStart, index), "string");
      push("${", "punctuation");
      const end = matchingBrace(source, index + 2);
      const inner = source.slice(index + 2, end);
      if (depth < MAX_TEMPLATE_DEPTH)
        for (const token of tokenizeJs(inner, depth + 1))
          push(token.text, token.style);
      else push(inner, "plain");
      if (source[end] === "}") {
        push("}", "punctuation");
        index = end + 1;
      } else index = end;
      chunkStart = index;
      continue;
    }
    index += 1;
  }
  push(source.slice(chunkStart), "string");
  return index;
}

function tokenizeJs(source: string, depth = 0): readonly Token[] {
  const tokens: Token[] = [];
  let previous: Token | undefined;
  const push: PushToken = (text, style) => {
    if (text.length === 0) return;
    const token = { text, style };
    tokens.push(token);
    // Whitespace and comments never change what a following `/` or identifier means.
    if (style !== "comment" && text.trim().length > 0) previous = token;
  };
  let index = 0;
  while (index < source.length) {
    const character = source[index] ?? "";
    const rest = source.slice(index);
    if (/\s/u.test(character)) {
      const run = (/^\s+/u.exec(rest) ?? [""])[0];
      push(run, "plain");
      index += run.length;
      continue;
    }
    if (rest.startsWith("//")) {
      const end = source.indexOf("\n", index);
      const stop = end < 0 ? source.length : end;
      push(source.slice(index, stop), "comment");
      index = stop;
      continue;
    }
    if (rest.startsWith("/*")) {
      const end = source.indexOf("*/", index + 2);
      const stop = end < 0 ? source.length : end + 2;
      push(source.slice(index, stop), "comment");
      index = stop;
      continue;
    }
    if (character === "'" || character === '"') {
      const end = scanQuoted(source, index);
      push(source.slice(index, end), "string");
      index = end;
      continue;
    }
    if (character === "`") {
      index = pushTemplate(source, index, push, depth);
      continue;
    }
    if (
      isDigit(character) ||
      (character === "." && isDigit(source[index + 1] ?? ""))
    ) {
      const number = (JS_NUMBER.exec(rest) ?? [character])[0];
      push(number, "number");
      index += number.length;
      continue;
    }
    if (IDENTIFIER_START.test(character)) {
      const word = (/^[A-Za-z0-9_$]+/u.exec(rest) ?? [""])[0];
      const member = previous?.style === "punctuation" && previous.text === ".";
      const callable = nextNonSpace(source, index + word.length) === "(";
      const style: TokenStyle = callable
        ? "callable"
        : member
          ? "plain"
          : JS_KEYWORDS.has(word)
            ? "keyword"
            : JS_CONSTANTS.has(word)
              ? "constant"
              : "plain";
      push(word, style);
      index += word.length;
      continue;
    }
    if (character === "/" && regexAllowed(previous)) {
      const end = scanRegex(source, index);
      if (end !== undefined) {
        push(source.slice(index, end), "regexp");
        index = end;
        continue;
      }
    }
    if (JS_PUNCTUATION.has(character)) {
      push(character, "punctuation");
      index += 1;
      continue;
    }
    const operator = (/^[+\-*/%=<>!&|^~?]+/u.exec(rest) ?? [""])[0];
    if (operator) {
      push(operator, "operator");
      index += operator.length;
      continue;
    }
    push(character, "plain");
    index += 1;
  }
  return tokens;
}

function tokenizeJson(source: string): readonly Token[] {
  const tokens: Token[] = [];
  const push: PushToken = (text, style) => {
    if (text.length > 0) tokens.push({ text, style });
  };
  let index = 0;
  while (index < source.length) {
    const character = source[index] ?? "";
    const rest = source.slice(index);
    if (/\s/u.test(character)) {
      const run = (/^\s+/u.exec(rest) ?? [""])[0];
      push(run, "plain");
      index += run.length;
      continue;
    }
    if (character === '"') {
      const end = scanQuoted(source, index);
      push(
        source.slice(index, end),
        nextNonSpace(source, end) === ":" ? "key" : "string",
      );
      index = end;
      continue;
    }
    if (
      isDigit(character) ||
      (character === "-" && isDigit(source[index + 1] ?? ""))
    ) {
      const number = (JSON_NUMBER.exec(rest) ?? [character])[0];
      push(number, "number");
      index += number.length;
      continue;
    }
    const word = (/^[A-Za-z]+/u.exec(rest) ?? [""])[0];
    if (word) {
      push(word, JSON_CONSTANTS.has(word) ? "keyword" : "plain");
      index += word.length;
      continue;
    }
    push(character, "punctuation");
    index += 1;
  }
  return tokens;
}

function tokenizeShell(source: string): readonly Token[] {
  const tokens: Token[] = [];
  const push: PushToken = (text, style) => {
    if (text.length > 0) tokens.push({ text, style });
  };
  let index = 0;
  let commandPosition = true;
  while (index < source.length) {
    const character = source[index] ?? "";
    const rest = source.slice(index);
    if (character === "\n") {
      push(character, "plain");
      commandPosition = true;
      index += 1;
      continue;
    }
    if (/\s/u.test(character)) {
      const run = (/^[^\S\n]+/u.exec(rest) ?? [""])[0];
      push(run, "plain");
      index += run.length;
      continue;
    }
    if (
      character === "#" &&
      (index === 0 || /\s/u.test(source[index - 1] ?? ""))
    ) {
      const end = source.indexOf("\n", index);
      const stop = end < 0 ? source.length : end;
      push(source.slice(index, stop), "comment");
      index = stop;
      continue;
    }
    if (character === "'" || character === '"') {
      const end = scanQuoted(source, index);
      push(source.slice(index, end), "string");
      index = end;
      commandPosition = false;
      continue;
    }
    if (character === "$") {
      const variable =
        (/^\$(?:\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*|[@*#?$!0-9-])/u.exec(rest) ?? [
          "",
        ])[0];
      if (variable) {
        push(variable, "keyword");
        index += variable.length;
        commandPosition = false;
        continue;
      }
    }
    const operator = (/^(?:&&|\|\||>>|[|&;()<>])/u.exec(rest) ?? [""])[0];
    if (operator) {
      push(operator, "operator");
      // A redirection keeps the current command; a pipe or separator starts a new one.
      if (
        operator !== ">" &&
        operator !== ">>" &&
        operator !== "<" &&
        operator !== "&"
      )
        commandPosition = true;
      index += operator.length;
      continue;
    }
    const word = (/^[^\s|&;()<>'"]+/u.exec(rest) ?? [""])[0];
    if (word) {
      const keyword = SHELL_KEYWORDS.has(word);
      push(
        word,
        keyword
          ? "keyword"
          : commandPosition
            ? "callable"
            : word.startsWith("-")
              ? "constant"
              : "plain",
      );
      commandPosition = keyword && SHELL_COMMAND_KEYWORDS.has(word);
      index += word.length;
      continue;
    }
    push(character, "plain");
    index += 1;
  }
  return tokens;
}

function tokenize(source: string, language: SyntaxLanguage): readonly Token[] {
  if (language === "json") return tokenizeJson(source);
  if (language === "shell") return tokenizeShell(source);
  return tokenizeJs(source);
}

/**
 * Styles are closed on every line so wrapping, truncation, and overlay compositing can cut any
 * line without leaking colour into the rest of the screen.
 */
function renderTokens(
  tokens: readonly Token[],
  colorEnabled: boolean,
): string[] {
  const lines: string[] = [""];
  for (const token of tokens) {
    const parts = token.text.split("\n");
    for (const [position, part] of parts.entries()) {
      if (position > 0) lines.push("");
      if (part.length === 0) continue;
      const codes = tokenAnsi(token.style);
      lines[lines.length - 1] +=
        colorEnabled && codes ? `${codes}${part}${ANSI.reset}` : part;
    }
  }
  return lines;
}

/**
 * Highlights a code block into one string per source line. Tabs become spaces because terminal
 * width accounting, wrapping, and line-number gutters all measure columns rather than tab stops.
 */
export function highlightCode(
  code: string,
  language: string | undefined,
  colorEnabled: boolean,
): string[] {
  const source = safeTerminalText(code)
    .replaceAll("\t", "  ")
    .replace(/\n$/u, "");
  const resolved = syntaxLanguage(language);
  if (!resolved) return source.split("\n");
  return renderTokens(tokenize(source, resolved), colorEnabled);
}
