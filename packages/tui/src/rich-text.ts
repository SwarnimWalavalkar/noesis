import { Markdown, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { highlightCode } from "./syntax.ts";
import {
  ANSI,
  createMarkdownTheme,
  elideText,
  safeTerminalText,
  styled,
} from "./theme.ts";

type RichTextSegment =
  | { readonly kind: "markdown"; readonly source: string }
  | { readonly kind: "math"; readonly source: string };

const fenceAtStart = (line: string): string | undefined =>
  /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];

const isEscapedAt = (source: string, index: number): boolean => {
  let slashes = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && source[cursor] === "\\";
    cursor -= 1
  )
    slashes += 1;
  return slashes % 2 === 1;
};

function splitDisplayMath(source: string): readonly RichTextSegment[] {
  const segments: RichTextSegment[] = [];
  let segmentStart = 0;
  let index = 0;
  let codeFence: string | undefined;
  let lineStart = true;
  const push = (
    kind: RichTextSegment["kind"],
    start: number,
    end: number,
  ): void => {
    if (end > start) segments.push({ kind, source: source.slice(start, end) });
  };

  while (index < source.length) {
    if (lineStart) {
      const lineEnd = source.indexOf("\n", index);
      const end = lineEnd < 0 ? source.length : lineEnd;
      const fence = fenceAtStart(source.slice(index, end));
      if (
        fence &&
        (!codeFence ||
          (fence[0] === codeFence[0] && fence.length >= codeFence.length))
      )
        codeFence = codeFence ? undefined : fence;
      if (codeFence || fence) {
        index = lineEnd < 0 ? source.length : lineEnd + 1;
        lineStart = true;
        continue;
      }
    }
    lineStart = source[index] === "\n";
    if (source[index] === "`" && !isEscapedAt(source, index)) {
      const run = /^`+/.exec(source.slice(index))?.[0] ?? "`";
      const close = source.indexOf(run, index + run.length);
      const lineEnd = source.indexOf("\n", index + run.length);
      index =
        close >= 0 && (lineEnd < 0 || close < lineEnd)
          ? close + run.length
          : lineEnd < 0
            ? source.length
            : lineEnd;
      continue;
    }
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
    let close = index + opener.open.length;
    while (close < source.length) {
      close = source.indexOf(opener.close, close);
      if (close < 0 || !isEscapedAt(source, close)) break;
      close += opener.close.length;
    }
    const mathEnd = close < 0 ? source.length : close + opener.close.length;
    push("math", index, mathEnd);
    index = mathEnd;
    segmentStart = mathEnd;
    lineStart = index === 0 || source[index - 1] === "\n";
  }
  push("markdown", segmentStart, source.length);
  return segments;
}

function asCodeSpan(source: string): string {
  const longestRun = Math.max(
    0,
    ...[...source.matchAll(/`+/g)].map((match) => match[0].length),
  );
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
    if (line[index] === "`") {
      const run = /^`+/.exec(line.slice(index))?.[0] ?? "`";
      const close = line.indexOf(run, index + run.length);
      const end = close < 0 ? line.length : close + run.length;
      rendered += line.slice(index, end);
      index = end;
      continue;
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
    if (
      line[index] === "$" &&
      !isEscapedAt(line, index) &&
      next !== "$" &&
      next &&
      !/\s/u.test(next)
    ) {
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

function protectInlineMath(source: string): string {
  let codeFence: string | undefined;
  return source
    .split("\n")
    .map((line) => {
      const fence = fenceAtStart(line);
      if (codeFence) {
        if (
          fence &&
          fence[0] === codeFence[0] &&
          fence.length >= codeFence.length
        )
          codeFence = undefined;
        return line;
      }
      if (fence) {
        codeFence = fence;
        return line;
      }
      return protectInlineMathLine(line);
    })
    .join("\n");
}

function renderMathBlock(
  source: string,
  width: number,
  colorEnabled: boolean,
): string[] {
  if (width <= 0) return [];
  const inner = Math.max(1, width - 2);
  const lines = [styled(colorEnabled, ANSI.dim, "╭─ math")];
  for (const sourceLine of source.split("\n")) {
    const wrapped = wrapTextWithAnsi(sourceLine, inner);
    for (const line of wrapped)
      lines.push(
        `${styled(colorEnabled, ANSI.dim, "│ ")}${styled(colorEnabled, ANSI.yellow, line)}`,
      );
  }
  lines.push(styled(colorEnabled, ANSI.dim, "╰─"));
  return lines.map((line) => elideText(line, width));
}

export function renderRichText(
  source: string,
  width: number,
  colorEnabled = false,
): string[] {
  if (width <= 0) return [];
  const safeSource = safeTerminalText(source);
  return splitDisplayMath(safeSource).flatMap((segment) => {
    if (segment.kind === "math")
      return renderMathBlock(segment.source, width, colorEnabled);
    return new Markdown(
      protectInlineMath(segment.source),
      0,
      0,
      {
        ...createMarkdownTheme(colorEnabled),
        highlightCode: (code, language) =>
          highlightCode(code, language, colorEnabled),
      },
      undefined,
      { preserveOrderedListMarkers: true, preserveBackslashEscapes: true },
    )
      .render(width)
      .map((line) => line.trimEnd());
  });
}
