import {
  Markdown,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
import type {
  NoesisTuiAction,
  NoesisTuiState,
  TuiAgentAction,
  TuiAgentActionEntry,
  TuiContextUsage,
  TuiMessage,
  TuiTimelineEntry,
} from "./state.ts";
import { reduceTui } from "./state.ts";

export type TuiWidthClass = "wide" | "normal" | "narrow";
export type HeaderMode = "ascii" | "compact" | "none";

export interface TuiLayout {
  readonly widthClass: TuiWidthClass;
  readonly headerMode: HeaderMode;
  readonly transcriptRows: number;
}

export const NOESIS_WORDMARK = [
  "███╗   ██╗ ██████╗ ███████╗███████╗██╗███████╗",
  "████╗  ██║██╔═══██╗██╔════╝██╔════╝██║██╔════╝",
  "██╔██╗ ██║██║   ██║█████╗  ███████╗██║███████╗",
  "██║╚██╗██║██║   ██║██╔══╝  ╚════██║██║╚════██║",
  "██║ ╚████║╚██████╔╝███████╗███████║██║███████║",
  "╚═╝  ╚═══╝ ╚═════╝ ╚══════╝╚══════╝╚═╝╚══════╝",
] as const;

export const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  italic: "\u001b[3m",
  underline: "\u001b[4m",
  strikethrough: "\u001b[9m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
} as const;

export const styled = (enabled: boolean, codes: string, text: string): string =>
  enabled ? `${codes}${text}${ANSI.reset}` : text;

export function shouldUseColor(env: Readonly<Record<string, string | undefined>>): boolean {
  return !("NO_COLOR" in env) && env["TERM"] !== "dumb";
}

export function elideText(text: string, width: number): string {
  const truncated = truncateToWidth(text, Math.max(0, width), "…");
  // pi-tui defensively appends resets while truncating. Do not introduce ANSI into plain text,
  // especially under NO_COLOR; preserve the helper's ANSI-safe behavior for styled input.
  return text.includes("\u001b[") ? truncated : truncated.replaceAll("\u001b[0m", "");
}

export function safeTerminalText(text: string): string {
  return [...text]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 9 || code === 10 || (code >= 32 && !(code >= 127 && code <= 159)) ? character : " ";
    })
    .join("")
    .replaceAll("\u001b", "");
}

export function createTuiLayout(width: number, height: number): TuiLayout {
  const widthClass: TuiWidthClass = width >= 120 ? "wide" : width >= 80 ? "normal" : "narrow";
  const headerMode: HeaderMode =
    width < 36 || height < 10 ? "none" : width >= 100 && height >= 30 ? "ascii" : "compact";
  const headerRows = headerMode === "ascii" ? 9 : headerMode === "compact" ? 3 : 0;
  return {
    widthClass,
    headerMode,
    // Input label + three-row editor + attached status + optional help.
    transcriptRows: Math.max(1, height - headerRows - 6),
  };
}

const shortSessionId = (trailId: string | undefined): string => {
  if (!trailId) return "new";
  const separator = trailId.indexOf("_");
  return trailId.slice(separator < 0 ? 0 : separator + 1, (separator < 0 ? 0 : separator + 1) + 8);
};

const formatTokenCount = (tokens: number): string => {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${Math.round(tokens / 1_000)}k`;
};

export function formatContextUsage(usage: TuiContextUsage | undefined): {
  readonly percent: string;
  readonly tokens?: string;
} {
  if (!usage || usage.contextWindow <= 0 || usage.usedTokens < 0) return { percent: "ctx   —" };
  const percent = Math.min(100, Math.max(0, Math.round((usage.usedTokens / usage.contextWindow) * 100)));
  return {
    percent: `ctx ${usage.accuracy === "estimated" ? "~" : " "}${String(percent).padStart(2)}%`,
    tokens: `${formatTokenCount(usage.usedTokens)}/${formatTokenCount(usage.contextWindow)}`,
  };
}

export function createStatusFields(state: NoesisTuiState, layout: TuiLayout): readonly string[] {
  const context = formatContextUsage(state.contextUsage);
  const execution = `● ${state.execution.toUpperCase().padEnd(10)}`;
  const model = `${state.provider}/${state.model}`;
  const session = `session ${shortSessionId(state.trailId)}`;
  const turns = `${String(state.turnCount).padStart(3)} ${state.turnCount === 1 ? "turn" : "turns"}`;
  const capabilities = Object.keys(state.capabilityVersions).length;
  if (layout.widthClass === "wide")
    return [
      execution,
      model,
      state.reasoningLevel,
      context.percent,
      ...(context.tokens ? [context.tokens] : []),
      session,
      turns,
      ...(capabilities > 0 ? [`${capabilities} caps`] : []),
    ];
  if (layout.widthClass === "normal")
    return [
      execution,
      model,
      state.reasoningLevel,
      context.percent,
      `s ${shortSessionId(state.trailId)}`,
      `${String(state.turnCount).padStart(3)}t`,
    ];
  return [execution, model, context.percent, turns];
}

export function fitStatusFields(fields: readonly string[], width: number): readonly string[] {
  if (fields.length < 2) return fields;
  const current = fields.join(" · ");
  if (visibleWidth(current) <= width) return fields;
  const model = fields[1] ?? "";
  const overflow = visibleWidth(current) - width;
  const modelWidth = Math.max(8, visibleWidth(model) - overflow);
  return fields.map((field, index) => (index === 1 ? elideText(field, modelWidth) : field));
}

function colorStatusLine(state: NoesisTuiState, fields: readonly string[]): string {
  const stateColor =
    state.execution === "error"
      ? ANSI.red
      : state.execution === "idle"
        ? ANSI.green
        : state.execution === "compacting" || state.execution === "aborting"
          ? ANSI.yellow
          : ANSI.cyan;
  return fields
    .map((field, index) =>
      index === 0
        ? styled(state.colorEnabled, `${ANSI.bold}${stateColor}`, field)
        : styled(state.colorEnabled, ANSI.dim, field),
    )
    .join(" · ");
}

const identity = (text: string): string => text;

function createMarkdownTheme(colorEnabled: boolean): MarkdownTheme {
  return {
    heading: (text) => styled(colorEnabled, ANSI.cyan, text),
    link: (text) => styled(colorEnabled, ANSI.cyan, text),
    linkUrl: (text) => styled(colorEnabled, ANSI.dim, text),
    code: (text) => styled(colorEnabled, ANSI.yellow, text),
    codeBlock: (text) => styled(colorEnabled, ANSI.green, text),
    codeBlockBorder: (text) => styled(colorEnabled, ANSI.dim, text),
    quote: (text) => styled(colorEnabled, ANSI.dim, text),
    quoteBorder: (text) => styled(colorEnabled, ANSI.cyan, text),
    hr: (text) => styled(colorEnabled, ANSI.dim, text),
    listBullet: (text) => styled(colorEnabled, ANSI.cyan, text),
    bold: colorEnabled ? (text) => `${ANSI.bold}${text}${ANSI.reset}` : identity,
    italic: colorEnabled ? (text) => `${ANSI.italic}${text}${ANSI.reset}` : identity,
    strikethrough: colorEnabled ? (text) => `${ANSI.strikethrough}${text}${ANSI.reset}` : identity,
    underline: colorEnabled ? (text) => `${ANSI.underline}${text}${ANSI.reset}` : identity,
  };
}

type RichTextSegment =
  | { readonly kind: "markdown"; readonly source: string }
  | { readonly kind: "math"; readonly source: string };

const fenceAtStart = (line: string): string | undefined => /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];

const isEscapedAt = (source: string, index: number): boolean => {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
};

function splitDisplayMath(source: string): readonly RichTextSegment[] {
  const segments: RichTextSegment[] = [];
  let segmentStart = 0;
  let index = 0;
  let codeFence: string | undefined;
  let lineStart = true;
  const push = (kind: RichTextSegment["kind"], start: number, end: number): void => {
    if (end > start) segments.push({ kind, source: source.slice(start, end) });
  };

  while (index < source.length) {
    if (lineStart) {
      const lineEnd = source.indexOf("\n", index);
      const end = lineEnd < 0 ? source.length : lineEnd;
      const fence = fenceAtStart(source.slice(index, end));
      if (fence && (!codeFence || (fence[0] === codeFence[0] && fence.length >= codeFence.length)))
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

function protectInlineMath(source: string): string {
  let codeFence: string | undefined;
  return source
    .split("\n")
    .map((line) => {
      const fence = fenceAtStart(line);
      if (codeFence) {
        if (fence && fence[0] === codeFence[0] && fence.length >= codeFence.length) codeFence = undefined;
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
      createMarkdownTheme(colorEnabled),
      undefined,
      { preserveOrderedListMarkers: true, preserveBackslashEscapes: true },
    )
      .render(width)
      .map((line) => line.trimEnd());
  });
}

export function renderMessageBlock(message: TuiMessage, width: number, colorEnabled = false): string[] {
  if (width <= 0) return [];
  const label = message.role === "user" ? "YOU" : message.role === "assistant" ? "NOESIS" : "NOTE";
  const labelColor =
    message.role === "user" ? ANSI.cyan : message.role === "assistant" ? ANSI.green : ANSI.yellow;
  const shownLabel = width === 1 ? (label[0] ?? "") : elideText(label, width);
  const rail = width >= 3 ? (message.role === "user" ? "│ " : "  ") : "";
  const bodyWidth = Math.max(1, width - visibleWidth(rail));
  const source = message.text || (message.role === "assistant" ? "…" : "");
  const renderedBody = renderRichText(source, bodyWidth, colorEnabled);
  const body = renderedBody.length > 0 ? renderedBody : [""];
  return [
    styled(colorEnabled, `${ANSI.bold}${labelColor}`, shownLabel),
    ...body.map((line) =>
      elideText(
        `${styled(colorEnabled, message.role === "user" ? ANSI.cyan : ANSI.dim, rail)}${line}`,
        width,
      ),
    ),
  ];
}

export function renderTranscriptLines(state: NoesisTuiState, inner: number): string[] {
  if (state.timeline.length === 0)
    return [
      elideText(styled(state.colorEnabled, ANSI.dim, "A clear question is a good place to begin."), inner),
    ];
  const actions = state.timeline.filter((entry): entry is TuiAgentActionEntry => entry.kind === "action");
  return state.timeline.flatMap((entry, index) => [
    ...(index === 0 ? [] : [""]),
    ...(entry.kind === "message"
      ? renderMessageBlock(entry, inner, state.colorEnabled)
      : renderAgentActionBlock(entry, actions, inner, state.agentActionsExpanded, state.colorEnabled)),
  ]);
}

const ACTION_DETAIL_MAX_CHARACTERS = 24_000;
const ACTION_COLLAPSED_LINES = 4;
const ACTION_AUTO_COLLAPSE_AFTER_LINES = 12;

function printableActionValue(value: unknown): string {
  if (typeof value === "string") return safeTerminalText(value);
  try {
    const encoded = JSON.stringify(value, undefined, 2);
    return safeTerminalText(encoded ?? String(value));
  } catch {
    return safeTerminalText(String(value));
  }
}

function boundedActionValue(value: unknown): string {
  const text = printableActionValue(value);
  if (text.length <= ACTION_DETAIL_MAX_CHARACTERS) return text;
  return `${text.slice(0, ACTION_DETAIL_MAX_CHARACTERS)}\n… action detail truncated`;
}

function actionDetailSection(label: string, value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const source = Reflect.get(value, "source");
    if (typeof source === "string") {
      const metadata = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "source"));
      const hasMetadata = Object.keys(metadata).length > 0;
      return [
        `${label}.source`,
        boundedActionValue(source),
        ...(hasMetadata ? ["", `${label}.metadata`, boundedActionValue(metadata)] : []),
      ].join("\n");
    }
  }
  return `${label}\n${boundedActionValue(value)}`;
}

function actionDetailSource(action: TuiAgentAction): string {
  return [
    ...(action.input === undefined ? [] : [actionDetailSection("input", action.input)]),
    ...(action.update === undefined ? [] : [actionDetailSection("progress", action.update)]),
    ...(action.output === undefined ? [] : [actionDetailSection("result", action.output)]),
  ].join("\n\n");
}

function actionDepth(action: TuiAgentAction, actions: readonly TuiAgentAction[]): number {
  let depth = 0;
  let parentId = action.parentActionId;
  const visited = new Set<string>();
  while (parentId && depth < 4 && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = actions.find((candidate) => candidate.actionId === parentId);
    if (!parent) break;
    depth += 1;
    parentId = parent.parentActionId;
  }
  return depth;
}

export function renderAgentActionBlock(
  action: TuiAgentAction,
  actions: readonly TuiAgentAction[],
  width: number,
  expanded: boolean,
  colorEnabled = false,
): string[] {
  if (width <= 0) return [];
  const depth = actionDepth(action, actions);
  const indent = "  ".repeat(depth);
  const status = action.status === "running" ? "●" : action.status === "failed" ? "×" : "✓";
  const statusColor =
    action.status === "running" ? ANSI.cyan : action.status === "failed" ? ANSI.red : ANSI.green;
  const header = elideText(
    `${indent}${styled(colorEnabled, `${ANSI.bold}${statusColor}`, status)} ${styled(
      colorEnabled,
      ANSI.bold,
      action.name,
    )}`,
    width,
  );
  const detail = actionDetailSource(action);
  if (!detail) return [header];
  const rail = `${indent}${styled(colorEnabled, ANSI.dim, "│ ")} `;
  const bodyWidth = Math.max(1, width - visibleWidth(rail));
  const lines = detail.split("\n").flatMap((line) => wrapTextWithAnsi(line, bodyWidth));
  const isLong = lines.length > ACTION_AUTO_COLLAPSE_AFTER_LINES;
  const visible =
    isLong && !expanded
      ? [
          ...lines.slice(0, ACTION_COLLAPSED_LINES),
          styled(
            colorEnabled,
            ANSI.dim,
            `… ${String(lines.length - ACTION_COLLAPSED_LINES)} more lines · Ctrl+O expand`,
          ),
        ]
      : lines;
  return [header, ...visible.map((line) => elideText(`${rail}${line}`, width))];
}

interface RenderedTimelineBlock {
  readonly lines: readonly string[];
}

export interface TranscriptRenderMetrics {
  readonly parsedBlocks: number;
  readonly cacheHits: number;
  readonly candidateBlocks: number;
}

export interface TranscriptRenderer {
  readonly renderViewport: (state: NoesisTuiState, width: number, rows: number) => readonly string[];
  readonly metrics: () => TranscriptRenderMetrics;
}

export function createTranscriptRenderer(): TranscriptRenderer {
  const cache = new WeakMap<
    TuiTimelineEntry,
    { readonly key: string; readonly block: RenderedTimelineBlock }
  >();
  let parsedBlocks = 0;
  let cacheHits = 0;
  let candidateBlocks = 0;
  const renderBlock = (
    entry: TuiTimelineEntry,
    actions: readonly TuiAgentAction[],
    width: number,
    expanded: boolean,
    colorEnabled: boolean,
  ): RenderedTimelineBlock => {
    const depth = entry.kind === "action" ? actionDepth(entry, actions) : 0;
    const key = `${String(width)}:${colorEnabled ? "color" : "plain"}:${
      entry.kind === "action" && expanded ? "expanded" : "collapsed"
    }:${String(depth)}`;
    const cached = cache.get(entry);
    if (cached?.key === key) {
      cacheHits += 1;
      return cached.block;
    }
    parsedBlocks += 1;
    const block = {
      lines:
        entry.kind === "message"
          ? renderMessageBlock(entry, width, colorEnabled)
          : renderAgentActionBlock(entry, actions, width, expanded, colorEnabled),
    };
    cache.set(entry, { key, block });
    return block;
  };
  return {
    renderViewport(state, width, rows) {
      if (width <= 0 || rows <= 0) return [];
      if (state.timeline.length === 0)
        return [
          elideText(
            styled(state.colorEnabled, ANSI.dim, "A clear question is a good place to begin."),
            width,
          ),
        ];
      // Select the smallest bounded tail whose minimum rendered height can fill the viewport.
      // Messages cost at least two rows; actions cost at least one. This avoids parsing unrelated
      // history while allowing mixed conversation and action blocks to flow chronologically.
      let candidateStart = state.timeline.length;
      let minimumRows = 0;
      while (candidateStart > 0 && minimumRows < rows) {
        candidateStart -= 1;
        const entry = state.timeline[candidateStart];
        minimumRows +=
          (entry?.kind === "message" ? 2 : 1) + (candidateStart < state.timeline.length - 1 ? 1 : 0);
      }
      const candidates = state.timeline.slice(candidateStart);
      candidateBlocks += candidates.length;
      const actions = state.timeline.filter((entry): entry is TuiAgentActionEntry => entry.kind === "action");
      const blocks = candidates.map((entry) =>
        renderBlock(entry, actions, width, state.agentActionsExpanded, state.colorEnabled),
      );
      const omittedCandidates = candidateStart > 0;
      const flattened = blocks.flatMap((block, index) => [...(index === 0 ? [] : [""]), ...block.lines]);
      if (!omittedCandidates && flattened.length <= rows) return flattened;

      const marker = elideText(styled(state.colorEnabled, ANSI.dim, "⋯ earlier conversation"), width);
      if (rows === 1) return [marker];
      let remaining = rows - 1;
      const visible: string[] = [];
      for (let index = blocks.length - 1; index >= 0 && remaining > 0; index -= 1) {
        const lines = blocks[index]?.lines ?? [];
        const separatorCost = visible.length > 0 ? 1 : 0;
        if (lines.length + separatorCost <= remaining) {
          if (separatorCost) visible.unshift("");
          visible.unshift(...lines);
          remaining -= lines.length + separatorCost;
          continue;
        }
        const available = remaining - separatorCost;
        if (available <= 0) break;
        // If the viewport begins inside a message or action, repeat its semantic owner before the
        // body tail so cropped output never loses who said or performed it.
        const header = lines[0];
        if (header) {
          const tail = available > 1 ? lines.slice(-(available - 1)) : [];
          if (separatorCost) visible.unshift("");
          visible.unshift(header, ...tail);
        }
        remaining = 0;
      }
      return [marker, ...visible].slice(-rows);
    },
    metrics: () => ({ parsedBlocks, cacheHits, candidateBlocks }),
  };
}

const defaultTranscriptRenderer = createTranscriptRenderer();

export function renderStatusLine(state: NoesisTuiState, width: number, height = 30): string {
  const layout = createTuiLayout(width, height);
  return elideText(colorStatusLine(state, fitStatusFields(createStatusFields(state, layout), width)), width);
}

export function renderBottomChrome(state: NoesisTuiState, width: number, height = 30): string[] {
  const safeWidth = Math.max(0, Math.floor(width));
  return [
    elideText(styled(state.colorEnabled, `${ANSI.bold}${ANSI.cyan}`, "› message"), safeWidth),
    renderStatusLine(state, safeWidth, height),
    ...(height >= 8
      ? [
          elideText(
            styled(state.colorEnabled, ANSI.dim, "? help · Ctrl+O actions · /quit exit · Ctrl+C stop"),
            safeWidth,
          ),
        ]
      : []),
  ];
}

export function renderNoesisState(
  state: NoesisTuiState,
  width: number,
  height = 30,
  transcriptRenderer: TranscriptRenderer = defaultTranscriptRenderer,
): string[] {
  const terminalWidth = Math.max(0, Math.floor(width));
  const inner = terminalWidth > 2 ? terminalWidth - 2 : terminalWidth;
  if (inner <= 0) return [];
  const layout = createTuiLayout(terminalWidth, height);
  const header =
    layout.headerMode === "ascii"
      ? [
          ...NOESIS_WORDMARK.map((line) => styled(state.colorEnabled, `${ANSI.bold}${ANSI.cyan}`, line)),
          styled(state.colorEnabled, ANSI.dim, "think · learn · create · grow"),
          styled(
            state.colorEnabled,
            ANSI.dim,
            `${elideText(state.title, Math.max(8, inner - 22))} · session ${shortSessionId(state.trailId)}`,
          ),
        ]
      : layout.headerMode === "compact"
        ? [
            `${styled(state.colorEnabled, `${ANSI.bold}${ANSI.cyan}`, "NOESIS")}${styled(
              state.colorEnabled,
              ANSI.dim,
              terminalWidth >= 52 && height >= 16 ? "  think · learn · create · grow" : "",
            )}`,
            styled(
              state.colorEnabled,
              ANSI.dim,
              `${elideText(state.title, Math.max(8, inner - 22))} · session ${shortSessionId(state.trailId)}`,
            ),
          ]
        : [];
  const allInspector =
    state.pane === "context" && state.context
      ? state.context.fragments.map(
          (fragment) =>
            `context> ${fragment.kind}:${fragment.id} ${fragment.tokens}t source=${fragment.provenance.join(",")}`,
        )
      : state.pane === "capabilities"
        ? Object.entries(state.capabilityVersions).map(([name, version]) => `capability> ${name}@${version}`)
        : [];
  const inspectorLimit = Math.floor(layout.transcriptRows / 2);
  const inspector = inspectorLimit > 0 ? allInspector.slice(-inspectorLimit) : [];
  const transcriptRows = Math.max(1, layout.transcriptRows - inspector.length - (state.error ? 1 : 0));
  const transcript = transcriptRenderer.renderViewport(state, inner, transcriptRows);
  return [
    ...header.map((line) => elideText(line, inner)),
    ...(layout.headerMode === "none" ? [] : [styled(state.colorEnabled, ANSI.dim, "─".repeat(inner))]),
    ...transcript,
    ...inspector.map((line) => elideText(line, inner)),
    ...(state.error
      ? [styled(state.colorEnabled, `${ANSI.bold}${ANSI.red}`, elideText(`Error · ${state.error}`, inner))]
      : []),
  ];
}

export interface NoesisView extends Component {
  readonly state: NoesisTuiState;
  readonly dispatch: (action: NoesisTuiAction) => void;
}

export function createNoesisView(initialState: NoesisTuiState, height: () => number): NoesisView {
  let state = initialState;
  const transcriptRenderer = createTranscriptRenderer();
  return {
    get state() {
      return state;
    },
    dispatch(action) {
      state = reduceTui(state, action);
    },
    invalidate() {},
    render(width) {
      if (height() < 5) return [];
      return renderNoesisState(state, width, height(), transcriptRenderer);
    },
  };
}

export function createInputLabelView(colorEnabled: boolean, height: () => number): Component {
  return {
    invalidate() {},
    render(width) {
      if (height() < 6) return [];
      return [elideText(styled(colorEnabled, `${ANSI.bold}${ANSI.cyan}`, "› message"), width)];
    },
  };
}

export function createStatusView(view: NoesisView, height: () => number): Component {
  return {
    invalidate() {},
    render(width) {
      if (height() < 2) return [];
      return [renderStatusLine(view.state, Math.max(0, width), height())];
    },
  };
}

export function createHelpView(colorEnabled: boolean, height: () => number): Component {
  return {
    invalidate() {},
    render(width) {
      if (height() < 8) return [];
      return [
        elideText(
          styled(colorEnabled, ANSI.dim, "? help · Ctrl+O actions · /quit exit · Ctrl+C stop"),
          width,
        ),
      ];
    },
  };
}

export function createStaticLineView(text: string, visible: () => boolean = () => true): Component {
  return {
    invalidate() {},
    render: (width) => (visible() ? [elideText(text, Math.max(0, width))] : []),
  };
}
