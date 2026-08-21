import { Markdown, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { highlightCode } from "./syntax.ts";
import { ANSI, createMarkdownTheme, elideText, safeTerminalText, styled } from "./theme.ts";

type RichTextSegment =
  | { readonly kind: "markdown"; readonly source: string }
  | { readonly kind: "math"; readonly source: string };

interface SourceRange {
  readonly start: number;
  readonly end: number;
}

interface MarkdownFence {
  readonly marker: string;
  readonly blockquoteDepth: number;
}

const blockquoteDepth = (prefix: string): number =>
  [...prefix].filter((character) => character === ">").length;

const fenceAtStart = (line: string): MarkdownFence | undefined => {
  const match = /^((?: {0,3}>[ \t]?)*)(?: {0,3})(`{3,}|~{3,})/u.exec(line);
  const marker = match?.[2];
  if (!marker) return undefined;
  return {
    marker,
    blockquoteDepth: blockquoteDepth(match[1] ?? ""),
  };
};

const closesFence = (line: string, openingFence: MarkdownFence): boolean => {
  const match = /^((?: {0,3}>[ \t]?)*)(?: {0,3})(`{3,}|~{3,})[ \t]*\r?$/u.exec(line);
  const candidate = match?.[2];
  return (
    candidate !== undefined &&
    blockquoteDepth(match?.[1] ?? "") === openingFence.blockquoteDepth &&
    candidate[0] === openingFence.marker[0] &&
    candidate.length >= openingFence.marker.length
  );
};

const isEscapedAt = (source: string, index: number): boolean => {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
};

const lineEndFrom = (source: string, start: number): number => {
  const end = source.indexOf("\n", start);
  return end < 0 ? source.length : end;
};

const nextLineStart = (source: string, lineEnd: number): number =>
  lineEnd < source.length ? lineEnd + 1 : source.length;

function fencedCodeEnd(source: string, openingLineEnd: number, openingFence: MarkdownFence): number {
  let lineStart = nextLineStart(source, openingLineEnd);
  while (lineStart < source.length) {
    const lineEnd = lineEndFrom(source, lineStart);
    if (closesFence(source.slice(lineStart, lineEnd), openingFence)) return nextLineStart(source, lineEnd);
    lineStart = nextLineStart(source, lineEnd);
  }
  return source.length;
}

function codeSpanEnd(source: string, start: number, openingRun: string): number | undefined {
  let index = start + openingRun.length;
  while (index < source.length) {
    const nextBacktick = source.indexOf("`", index);
    if (nextBacktick < 0) return undefined;
    const run = /^`+/u.exec(source.slice(nextBacktick))?.[0] ?? "`";
    if (run.length === openingRun.length) return nextBacktick + run.length;
    index = nextBacktick + run.length;
  }
  return undefined;
}

function markdownCodeRangeAt(source: string, index: number): SourceRange | undefined {
  const atLineStart = index === 0 || source[index - 1] === "\n";
  if (atLineStart) {
    const lineEnd = lineEndFrom(source, index);
    const openingFence = fenceAtStart(source.slice(index, lineEnd));
    if (openingFence)
      return {
        start: index,
        end: fencedCodeEnd(source, lineEnd, openingFence),
      };
  }
  if (source[index] !== "`" || isEscapedAt(source, index)) return undefined;
  const openingRun = /^`+/u.exec(source.slice(index))?.[0] ?? "`";
  const end = codeSpanEnd(source, index, openingRun);
  return end === undefined ? undefined : { start: index, end };
}

/**
 * Locate Markdown regions whose contents are code rather than prose. Both display-math splitting
 * and inline-math protection consume these ranges, so fences and multiline code spans cannot
 * drift into two subtly different parsers.
 */
function markdownCodeRanges(source: string): readonly SourceRange[] {
  const ranges: SourceRange[] = [];
  let index = 0;
  while (index < source.length) {
    const range = markdownCodeRangeAt(source, index);
    if (range) {
      ranges.push(range);
      index = range.end;
      continue;
    }
    index += 1;
  }
  return ranges;
}

function displayMathEnd(source: string, start: number, closer: string): number {
  let index = start;
  while (index < source.length) {
    const codeRange = markdownCodeRangeAt(source, index);
    if (codeRange) {
      index = codeRange.end;
      continue;
    }
    if (source.startsWith(closer, index) && !isEscapedAt(source, index)) return index + closer.length;
    index += 1;
  }
  return source.length;
}

function splitDisplayMath(source: string): readonly RichTextSegment[] {
  const segments: RichTextSegment[] = [];
  let segmentStart = 0;
  let index = 0;
  const push = (kind: RichTextSegment["kind"], start: number, end: number): void => {
    if (end > start) segments.push({ kind, source: source.slice(start, end) });
  };

  while (index < source.length) {
    const codeRange = markdownCodeRangeAt(source, index);
    if (codeRange) {
      index = codeRange.end;
      continue;
    }
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    const opener =
      source.startsWith("$$", index) && !isEscapedAt(source, index)
        ? ({ open: "$$", close: "$$" } as const)
        : source.startsWith("\\[", index) && !isEscapedAt(source, index)
          ? ({ open: "\\[", close: "\\]" } as const)
          : undefined;
    if (!opener) {
      index += 1;
      continue;
    }
    push("markdown", segmentStart, index);
    const mathEnd = displayMathEnd(source, index + opener.open.length, opener.close);
    push("math", index, mathEnd);
    index = mathEnd;
    segmentStart = mathEnd;
  }
  push("markdown", segmentStart, source.length);
  return segments;
}

function asCodeSpan(source: string): string {
  const longestRun = Math.max(0, ...[...source.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longestRun + 1);
  const padding = source.startsWith("`") || source.endsWith("`") ? " " : "";
  return `${fence}${padding}${source}${padding}${fence}`;
}

function closingInlineDollar(line: string, start: number): number {
  for (let index = start; index < line.length; index += 1) {
    if (line[index] !== "$" || isEscapedAt(line, index)) continue;
    if (line[index - 1] === "$" || line[index + 1] === "$") continue;
    const previous = line[index - 1];
    const next = line[index + 1];
    if (!previous || /\s/u.test(previous)) continue;
    if (next && /[\p{L}\p{N}]/u.test(next)) continue;
    return index;
  }
  return -1;
}

function protectInlineMathLine(line: string): string {
  let rendered = "";
  let index = 0;
  while (index < line.length) {
    if (line[index] === "`" && !isEscapedAt(line, index)) {
      const run = /^`+/.exec(line.slice(index))?.[0] ?? "`";
      const end = codeSpanEnd(line, index, run);
      if (end !== undefined) {
        rendered += line.slice(index, end);
        index = end;
        continue;
      }
    }
    if (line.startsWith("\\(", index)) {
      const close = line.indexOf("\\)", index + 2);
      if (close >= 0) {
        const end = close + 2;
        rendered += asCodeSpan(line.slice(index, end));
        index = end;
        continue;
      }
    }
    const next = line[index + 1];
    if (line[index] === "$" && !isEscapedAt(line, index) && next !== "$" && next && !/\s/u.test(next)) {
      const close = closingInlineDollar(line, index + 1);
      if (close >= 0) {
        rendered += asCodeSpan(line.slice(index, close + 1));
        index = close + 1;
        continue;
      }
    }
    rendered += line[index];
    index += 1;
  }
  return rendered;
}

const protectInlineMathProse = (source: string): string =>
  source.split("\n").map(protectInlineMathLine).join("\n");

function protectInlineMath(source: string): string {
  const ranges = markdownCodeRanges(source);
  if (ranges.length === 0) return protectInlineMathProse(source);
  const rendered: string[] = [];
  let index = 0;
  for (const range of ranges) {
    rendered.push(protectInlineMathProse(source.slice(index, range.start)));
    rendered.push(source.slice(range.start, range.end));
    index = range.end;
  }
  rendered.push(protectInlineMathProse(source.slice(index)));
  return rendered.join("");
}

function renderMathBlock(source: string, width: number, colorEnabled: boolean): string[] {
  if (width <= 0) return [];
  const inner = Math.max(1, width - 2);
  const lines = [styled(colorEnabled, ANSI.dim, "╭─ math")];
  for (const sourceLine of source.split("\n")) {
    const wrapped = wrapTextWithAnsi(sourceLine, inner);
    for (const line of wrapped)
      lines.push(`${styled(colorEnabled, ANSI.dim, "│ ")}${styled(colorEnabled, ANSI.yellow, line)}`);
  }
  lines.push(styled(colorEnabled, ANSI.dim, "╰─"));
  return lines.map((line) => elideText(line, width));
}

export function renderRichText(source: string, width: number, colorEnabled = false): string[] {
  if (width <= 0) return [];
  const safeSource = safeTerminalText(source);
  return splitDisplayMath(safeSource).flatMap((segment) => {
    if (segment.kind === "math") return renderMathBlock(segment.source, width, colorEnabled);
    return new Markdown(
      protectInlineMath(segment.source),
      0,
      0,
      {
        ...createMarkdownTheme(colorEnabled),
        highlightCode: (code, language) => highlightCode(code, language, colorEnabled),
      },
      undefined,
      { preserveOrderedListMarkers: true, preserveBackslashEscapes: true },
    )
      .render(width)
      .map((line) => line.trimEnd());
  });
}
