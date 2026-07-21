import {
  Container,
  Editor,
  Markdown,
  ProcessTerminal,
  SelectList,
  TUI,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type MarkdownTheme,
  type SelectListTheme,
  type Terminal,
} from "@earendil-works/pi-tui";
import type { ContextSnapshot } from "@noesis/context";
import { createId } from "@noesis/domain";
import { createLearningEngine } from "@noesis/learning";
import {
  compareTrailRecency,
  createDurableScheduler,
  type NoesisRuntime,
  type RuntimeAgentDefaults,
  type TrailState,
  type TrailSummary,
} from "@noesis/runtime";

export type Pane = "trail" | "context" | "capabilities" | "memory" | "evaluations" | "jobs";

export interface TuiMessage {
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
}

export type ExecutionState = "idle" | "thinking" | "streaming" | "tool" | "compacting" | "aborting" | "error";

export interface TuiContextUsage {
  readonly usedTokens: number;
  readonly contextWindow: number;
  readonly accuracy: "reported" | "estimated";
}

export interface NoesisTuiState {
  readonly trailId?: string;
  readonly title: string;
  readonly execution: ExecutionState;
  readonly provider: string;
  readonly model: string;
  readonly reasoningLevel: RuntimeAgentDefaults["thinkingLevel"];
  readonly runtime: string;
  readonly pane: Pane;
  readonly messages: readonly TuiMessage[];
  readonly context?: ContextSnapshot;
  readonly contextUsage?: TuiContextUsage;
  readonly turnCount: number;
  readonly capabilityVersions: Readonly<Record<string, number>>;
  readonly colorEnabled: boolean;
  readonly activeTool?: string;
  readonly error?: string;
}

export type NoesisTuiAction =
  | { readonly type: "trail-selected"; readonly trail: TrailState }
  | { readonly type: "prompt-submitted"; readonly text: string }
  | { readonly type: "stream-delta"; readonly text: string }
  | { readonly type: "stream-reconciled"; readonly text: string }
  | { readonly type: "tool-started"; readonly name: string }
  | { readonly type: "tool-ended" }
  | { readonly type: "execution-changed"; readonly execution: ExecutionState }
  | {
      readonly type: "model-metadata";
      readonly provider: string;
      readonly model: string;
      readonly contextWindow: number;
    }
  | ({ readonly type: "usage-updated" } & TuiContextUsage)
  | {
      readonly type: "turn-completed";
      readonly context: ContextSnapshot;
      readonly capabilities: Readonly<Record<string, number>>;
      readonly turnCount: number;
      readonly contextUsage?: TuiContextUsage;
    }
  | { readonly type: "turn-aborted" }
  | { readonly type: "compacted" }
  | { readonly type: "pane-selected"; readonly pane: Pane }
  | { readonly type: "failed"; readonly error: string }
  | { readonly type: "system-message"; readonly text: string };

export const initialTuiState = (
  runtime: string,
  options: {
    readonly provider?: string;
    readonly model?: string;
    readonly reasoningLevel?: RuntimeAgentDefaults["thinkingLevel"];
    readonly colorEnabled?: boolean;
  } = {},
): NoesisTuiState => ({
  title: "Noesis session",
  execution: "idle",
  provider: options.provider ?? "fake",
  model: options.model ?? "noesis-fake-1",
  reasoningLevel: options.reasoningLevel ?? "off",
  runtime,
  pane: "trail",
  messages: [],
  turnCount: 0,
  capabilityVersions: {},
  colorEnabled: options.colorEnabled ?? false,
});

export function reduceTui(state: NoesisTuiState, action: NoesisTuiAction): NoesisTuiState {
  switch (action.type) {
    case "trail-selected": {
      const {
        activeTool: _activeTool,
        context: _context,
        contextUsage: _contextUsage,
        error: _error,
        ...rest
      } = state;
      return {
        ...rest,
        trailId: action.trail.trailId,
        title: action.trail.title,
        provider: action.trail.provider,
        model: action.trail.model,
        messages: action.trail.turns.flatMap((turn) => [
          { role: "user" as const, text: turn.input },
          { role: "assistant" as const, text: turn.output },
        ]),
        ...(action.trail.context ? { context: action.trail.context } : {}),
        capabilityVersions: { ...action.trail.capabilityVersions },
        turnCount: action.trail.turns.length,
        execution: "idle",
      };
    }
    case "prompt-submitted": {
      const { error: _error, ...rest } = state;
      return {
        ...rest,
        execution: "thinking",
        messages: [...state.messages, { role: "user", text: action.text }, { role: "assistant", text: "" }],
      };
    }
    case "stream-delta": {
      const messages = [...state.messages];
      const last = messages.at(-1);
      if (last?.role === "assistant")
        messages[messages.length - 1] = { ...last, text: last.text + action.text };
      return { ...state, execution: "streaming", messages };
    }
    case "stream-reconciled": {
      const messages = [...state.messages];
      const last = messages.at(-1);
      if (last?.role === "assistant") messages[messages.length - 1] = { ...last, text: action.text };
      return { ...state, messages };
    }
    case "tool-started":
      return { ...state, execution: "tool", activeTool: action.name };
    case "tool-ended": {
      const { activeTool: _activeTool, ...rest } = state;
      return {
        ...rest,
        execution: state.messages.at(-1)?.text ? "streaming" : "thinking",
      };
    }
    case "execution-changed": {
      const { activeTool: _activeTool, ...rest } = state;
      return { ...rest, execution: action.execution };
    }
    case "model-metadata":
      return { ...state, provider: action.provider, model: action.model };
    case "usage-updated":
      return {
        ...state,
        contextUsage: {
          usedTokens: action.usedTokens,
          contextWindow: action.contextWindow,
          accuracy: action.accuracy,
        },
      };
    case "turn-completed": {
      const { contextUsage: _contextUsage, ...rest } = state;
      return {
        ...rest,
        execution: "idle",
        context: action.context,
        turnCount: action.turnCount,
        ...(action.contextUsage ? { contextUsage: action.contextUsage } : {}),
        capabilityVersions: { ...action.capabilities },
      };
    }
    case "turn-aborted": {
      const messages = [...state.messages];
      if (messages.at(-1)?.role === "assistant" && !messages.at(-1)?.text) messages.pop();
      return { ...state, execution: "idle", messages };
    }
    case "compacted": {
      const { contextUsage: _contextUsage, ...rest } = state;
      return { ...rest, execution: "idle" };
    }
    case "pane-selected":
      return { ...state, pane: action.pane };
    case "failed":
      return { ...state, execution: "error", error: action.error };
    case "system-message":
      return { ...state, messages: [...state.messages, { role: "system", text: action.text }] };
  }
}

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

const ANSI = {
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

const styled = (enabled: boolean, codes: string, text: string): string =>
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
  if (state.messages.length === 0)
    return [
      elideText(styled(state.colorEnabled, ANSI.dim, "A clear question is a good place to begin."), inner),
    ];
  return state.messages.flatMap((message, index) => [
    ...(index === 0 ? [] : [""]),
    ...renderMessageBlock(message, inner, state.colorEnabled),
  ]);
}

interface RenderedMessageBlock {
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
  const cache = new WeakMap<TuiMessage, { readonly key: string; readonly block: RenderedMessageBlock }>();
  let parsedBlocks = 0;
  let cacheHits = 0;
  let candidateBlocks = 0;
  const renderBlock = (message: TuiMessage, width: number, colorEnabled: boolean): RenderedMessageBlock => {
    const key = `${String(width)}:${colorEnabled ? "color" : "plain"}:${message.role}:${message.text}`;
    const cached = cache.get(message);
    if (cached?.key === key) {
      cacheHits += 1;
      return cached.block;
    }
    parsedBlocks += 1;
    const block = { lines: renderMessageBlock(message, width, colorEnabled) };
    cache.set(message, { key, block });
    return block;
  };
  return {
    renderViewport(state, width, rows) {
      if (width <= 0 || rows <= 0) return [];
      if (state.messages.length === 0)
        return [
          elideText(
            styled(state.colorEnabled, ANSI.dim, "A clear question is a good place to begin."),
            width,
          ),
        ];
      // Every semantic block costs at least a label and one body row. Starting from this bounded
      // tail is therefore sufficient to fill the viewport without parsing unrelated old history.
      const candidateLimit = Math.max(1, Math.ceil(rows / 2) + 1);
      const candidates = state.messages.slice(-candidateLimit);
      candidateBlocks += candidates.length;
      const blocks = candidates.map((message) => renderBlock(message, width, state.colorEnabled));
      const omittedCandidates = candidates.length < state.messages.length;
      const flattened = blocks.flatMap((block, index) => [...(index === 0 ? [] : [""]), ...block.lines]);
      if (!omittedCandidates && flattened.length <= rows) return flattened;

      const marker = elideText(styled(state.colorEnabled, ANSI.dim, "⋯ earlier messages"), width);
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
        // If the viewport begins inside a block, repeat its semantic owner before the body tail.
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
      ? [elideText(styled(state.colorEnabled, ANSI.dim, "? help · /quit exit · Ctrl+C stop"), safeWidth)]
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

interface NoesisView extends Component {
  readonly state: NoesisTuiState;
  readonly dispatch: (action: NoesisTuiAction) => void;
}

function createNoesisView(initialState: NoesisTuiState, height: () => number): NoesisView {
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

function createInputLabelView(colorEnabled: boolean, height: () => number): Component {
  return {
    invalidate() {},
    render(width) {
      if (height() < 6) return [];
      return [elideText(styled(colorEnabled, `${ANSI.bold}${ANSI.cyan}`, "› message"), width)];
    },
  };
}

function createStatusView(view: NoesisView, height: () => number): Component {
  return {
    invalidate() {},
    render(width) {
      if (height() < 2) return [];
      return [renderStatusLine(view.state, Math.max(0, width), height())];
    },
  };
}

function createHelpView(colorEnabled: boolean, height: () => number): Component {
  return {
    invalidate() {},
    render(width) {
      if (height() < 8) return [];
      return [elideText(styled(colorEnabled, ANSI.dim, "? help · /quit exit · Ctrl+C stop"), width)];
    },
  };
}

function createStaticLineView(text: string, visible: () => boolean = () => true): Component {
  return {
    invalidate() {},
    render: (width) => (visible() ? [elideText(text, Math.max(0, width))] : []),
  };
}

const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";
const SAFE_EDITOR_ESCAPE_AMBIGUITY_MS = 50;
const SAFE_EDITOR_MARKER_AMBIGUITY_MS = 150;
const SAFE_EDITOR_CLOSE_AMBIGUITY_MS = 75;
const SAFE_EDITOR_MAX_BUFFERED_CHARACTERS = 1024 * 1024;

type SafeEditorInputState =
  | { readonly kind: "keyboard"; readonly pending: string }
  | { readonly kind: "paste"; readonly text: string }
  | { readonly kind: "paste-close"; readonly text: string; readonly trailing: string };

const markerPrefixSuffixLength = (text: string, marker: string): number => {
  for (let length = Math.min(text.length, marker.length - 1); length > 0; length -= 1) {
    if (marker.startsWith(text.slice(-length))) return length;
  }
  return 0;
};

export function sanitizeEditorText(text: string): string {
  return [...text]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      if (code === 9 || code === 10) return character;
      if (code === 13) return "\n";
      return code >= 32 && !(code >= 127 && code <= 159) && code !== 0x1b ? character : " ";
    })
    .join("");
}

export interface SafeEditor extends Component, Focusable {
  onSubmit: ((text: string) => void) | undefined;
  disableSubmit: boolean;
  readonly getText: () => string;
}

export function createSafeEditor(
  tui: TUI,
  colorEnabled = false,
  selectTheme: SelectListTheme = createSelectTheme(colorEnabled),
  height: () => number = () => Number.POSITIVE_INFINITY,
): SafeEditor {
  const editor = new Editor(
    tui,
    {
      borderColor: (text) => styled(colorEnabled, ANSI.cyan, text),
      selectList: selectTheme,
    },
    { paddingX: 1 },
  );
  let inputState: SafeEditorInputState = { kind: "keyboard", pending: "" };
  let ambiguityTimer: NodeJS.Timeout | undefined;
  let submit: ((text: string) => void) | undefined;
  editor.onSubmit = (text) => submit?.(sanitizeEditorText(text));

  const clearAmbiguityTimer = (): void => {
    if (ambiguityTimer) clearTimeout(ambiguityTimer);
    ambiguityTimer = undefined;
  };

  const delegateKeyboardInput = (data: string): void => {
    // Outside bracketed paste, preserve terminal key events for pi-tui to interpret. In
    // particular, ordinary Backspace is DEL (0x7f) in most terminals and BS (0x08) in
    // some legacy terminals. Literal C1 characters are not key events and remain blocked;
    // bracketed-paste payloads take the stricter sanitize-before-insert path below.
    const safe = [...data]
      .filter((character) => {
        const code = character.codePointAt(0) ?? 0;
        return !(code >= 128 && code <= 159);
      })
      .join("");
    if (safe) editor.handleInput(safe);
  };

  const insertSanitizedPaste = (text: string): void => {
    if (!text) return;
    editor.insertTextAtCursor(sanitizeEditorText(text));
    tui.requestRender();
  };

  const boundPasteBuffer = (text: string, retainedSuffix: number): string => {
    if (text.length <= SAFE_EDITOR_MAX_BUFFERED_CHARACTERS) return text;
    const flushLength = Math.max(0, text.length - retainedSuffix);
    insertSanitizedPaste(text.slice(0, flushLength));
    return text.slice(flushLength);
  };

  const settleAmbiguity = (): void => {
    ambiguityTimer = undefined;
    if (inputState.kind === "keyboard") {
      const pending = inputState.pending;
      inputState = { kind: "keyboard", pending: "" };
      delegateKeyboardInput(pending);
      tui.requestRender();
      return;
    }
    if (inputState.kind === "paste-close") {
      const pasted = `${inputState.text}${inputState.trailing}`;
      inputState = { kind: "keyboard", pending: "" };
      insertSanitizedPaste(pasted);
    }
  };

  const scheduleAmbiguitySettlement = (delay: number): void => {
    clearAmbiguityTimer();
    ambiguityTimer = setTimeout(settleAmbiguity, delay);
    ambiguityTimer.unref();
  };

  const handleInput = (data: string): void => {
    clearAmbiguityTimer();
    if (inputState.kind === "keyboard") {
      const combined = `${inputState.pending}${data}`;
      const start = combined.indexOf(BRACKETED_PASTE_START);
      if (start >= 0) {
        delegateKeyboardInput(combined.slice(0, start));
        inputState = { kind: "paste", text: "" };
        handleInput(combined.slice(start + BRACKETED_PASTE_START.length));
        return;
      }
      const pendingLength = markerPrefixSuffixLength(combined, BRACKETED_PASTE_START);
      const readyLength = combined.length - pendingLength;
      delegateKeyboardInput(combined.slice(0, readyLength));
      const pending = combined.slice(readyLength);
      inputState = { kind: "keyboard", pending };
      if (pendingLength > 0)
        scheduleAmbiguitySettlement(
          pending === "\u001b" ? SAFE_EDITOR_ESCAPE_AMBIGUITY_MS : SAFE_EDITOR_MARKER_AMBIGUITY_MS,
        );
      return;
    }

    if (inputState.kind === "paste") {
      const combined = `${inputState.text}${data}`;
      const end = combined.indexOf(BRACKETED_PASTE_END);
      if (end < 0) {
        inputState = {
          kind: "paste",
          text: boundPasteBuffer(combined, BRACKETED_PASTE_END.length - 1),
        };
        return;
      }
      inputState = { kind: "paste-close", text: combined.slice(0, end), trailing: "" };
      handleInput(combined.slice(end + BRACKETED_PASTE_END.length));
      return;
    }

    let text = inputState.text;
    let trailing = `${inputState.trailing}${data}`;
    let nextClose = trailing.indexOf(BRACKETED_PASTE_END);
    while (nextClose >= 0) {
      // A later close proves that the previous candidate and all intervening bytes were
      // attacker-controlled paste data. Reject the marker itself and retain the bytes for
      // sanitize-before-insert processing; never reinterpret them as keyboard commands.
      text = `${text}${trailing.slice(0, nextClose)}`;
      trailing = trailing.slice(nextClose + BRACKETED_PASTE_END.length);
      nextClose = trailing.indexOf(BRACKETED_PASTE_END);
    }
    inputState = {
      kind: "paste-close",
      text: boundPasteBuffer(text, 0),
      trailing: boundPasteBuffer(trailing, BRACKETED_PASTE_END.length - 1),
    };
    scheduleAmbiguitySettlement(SAFE_EDITOR_CLOSE_AMBIGUITY_MS);
  };

  return {
    get focused() {
      return editor.focused;
    },
    set focused(focused: boolean) {
      editor.focused = focused;
    },
    get onSubmit() {
      return submit;
    },
    set onSubmit(next: ((text: string) => void) | undefined) {
      submit = next;
    },
    get disableSubmit() {
      return editor.disableSubmit;
    },
    set disableSubmit(disabled: boolean) {
      editor.disableSubmit = disabled;
    },
    getText: () => editor.getExpandedText(),
    handleInput,
    invalidate: () => editor.invalidate(),
    render: (width) => {
      const safeWidth = Math.max(0, width);
      if (safeWidth < 6 || height() < 4) {
        const lastLogicalLine = editor.getExpandedText().split("\n").at(-1) ?? "";
        return [elideText(lastLogicalLine || " ", safeWidth)];
      }
      return editor.render(safeWidth).map((line) => elideText(line, safeWidth));
    },
  };
}

function createSelectTheme(colorEnabled: boolean): SelectListTheme {
  return {
    selectedPrefix: (text) => styled(colorEnabled, `${ANSI.bold}${ANSI.cyan}`, text),
    selectedText: (text) => styled(colorEnabled, ANSI.bold, text),
    description: (text) => styled(colorEnabled, ANSI.dim, text),
    scrollInfo: (text) => styled(colorEnabled, ANSI.dim, text),
    noMatch: (text) => styled(colorEnabled, ANSI.yellow, text),
  };
}

const SHUTDOWN_GRACE_MS = 250;

export function streamingFrameDelay(activeCharacters: number, pendingCharacters: number): number {
  const total = Math.max(0, activeCharacters) + Math.max(0, pendingCharacters);
  return Math.min(80, 16 + Math.floor(total / 4_000) * 8);
}

type ShutdownSettlement =
  | { readonly status: "settled" }
  | { readonly status: "rejected"; readonly error: unknown }
  | { readonly status: "timed-out" };

export interface TuiStartOptions {
  readonly provider?: string;
  readonly model?: string;
  readonly thinkingLevel?: RuntimeAgentDefaults["thinkingLevel"];
  readonly session?:
    | { readonly mode: "new" }
    | { readonly mode: "pick" }
    | { readonly mode: "continue" }
    | { readonly mode: "resume"; readonly trailId: string };
}

export interface SessionPickerItem {
  readonly value: string;
  readonly label: string;
  readonly description: string;
}

const shortTrailId = (trailId: string): string => {
  const separator = trailId.indexOf("_");
  if (separator < 0) return elideText(trailId, 14);
  return `${trailId.slice(0, separator + 1)}${trailId.slice(separator + 1, separator + 9)}`;
};

const singleLine = (text: string): string => text.replace(/\s+/g, " ").trim();

export function createSessionPickerItems(summaries: readonly TrailSummary[]): readonly SessionPickerItem[] {
  return [...summaries].sort(compareTrailRecency).map((summary) => {
    const timestamp = `${summary.updatedAt.slice(0, 10)} ${summary.updatedAt.slice(11, 16)}Z`;
    const model = `${summary.provider}/${summary.model}`;
    const preview = singleLine(summary.preview || summary.title || "Untitled session");
    return {
      value: summary.trailId,
      label: `${shortTrailId(summary.trailId)}  ${timestamp}  ${summary.status}  ${model}  ${summary.turnCount}t/${summary.messageCount}m`,
      description: elideText(preview, 120),
    };
  });
}

export function sessionPickerVisibleCount(height: number): number {
  // Two heading rows plus a possible SelectList scroll indicator must always fit.
  return Math.max(1, Math.min(10, height - 3));
}

interface ResponsiveSessionPicker extends Component {
  onSelect?: (item: SessionPickerItem) => void;
  onCancel?: () => void;
}

function createResponsiveSessionPicker(
  items: readonly SessionPickerItem[],
  height: () => number,
  theme: SelectListTheme,
): ResponsiveSessionPicker {
  let visibleCount = -1;
  let picker: SelectList | undefined;
  let selectedValue = items[0]?.value;
  const responsive: ResponsiveSessionPicker = {
    render(width) {
      ensurePicker();
      const chromeRows = height() >= 3 ? 2 : height() >= 2 ? 1 : 0;
      return (
        picker
          ?.render(width)
          .map((line) => elideText(line, Math.max(0, width)))
          .slice(0, Math.max(1, height() - chromeRows)) ?? []
      );
    },
    handleInput(data) {
      ensurePicker();
      picker?.handleInput(data);
      selectedValue = picker?.getSelectedItem()?.value ?? selectedValue;
    },
    invalidate() {
      picker?.invalidate();
    },
  };
  const ensurePicker = (): void => {
    const nextVisibleCount = sessionPickerVisibleCount(height());
    if (picker && visibleCount === nextVisibleCount) return;
    const next = new SelectList([...items], nextVisibleCount, theme, {
      minPrimaryColumnWidth: 28,
      maxPrimaryColumnWidth: 72,
    });
    const selectedIndex = items.findIndex((item) => item.value === selectedValue);
    if (selectedIndex >= 0) next.setSelectedIndex(selectedIndex);
    next.onSelectionChange = (item) => {
      selectedValue = item.value;
    };
    next.onSelect = (item) => {
      const selected = items.find((candidate) => candidate.value === item.value);
      if (selected) responsive.onSelect?.(selected);
    };
    next.onCancel = () => responsive.onCancel?.();
    visibleCount = nextVisibleCount;
    picker = next;
  };
  return responsive;
}

async function resumableTrail(runtime: NoesisRuntime, trailId: string): Promise<TrailState> {
  try {
    return await runtime.resumeTrail(trailId);
  } catch (error) {
    if (error instanceof Error && error.message === `Trail not found: ${trailId}`)
      throw new Error(
        `Session ${trailId} was not found in ${runtime.ledger.paths.root}. Run noesis --resume to choose an available session.`,
        { cause: error },
      );
    throw error;
  }
}

export async function startNoesisTui(
  runtime: NoesisRuntime,
  options: TuiStartOptions = {},
  terminal: Terminal = new ProcessTerminal(),
): Promise<void> {
  const requestedSession = options.session ?? { mode: "new" };
  const session =
    requestedSession.mode === "continue"
      ? (() => {
          const latest = runtime.listTrailSummaries()[0];
          if (!latest)
            throw new Error(
              `No saved sessions were found in ${runtime.ledger.paths.root}. Start a new session with noesis (without --continue).`,
            );
          return { mode: "resume" as const, trailId: latest.trailId };
        })()
      : requestedSession;
  const tui = new TUI(terminal);
  const root = new Container();
  const requestedProvider = options.provider ?? runtime.agentDefaults.provider;
  const requestedModel = options.model ?? runtime.agentDefaults.model;
  const requestedReasoning = options.thinkingLevel ?? runtime.agentDefaults.thinkingLevel;
  const colorEnabled =
    terminal instanceof ProcessTerminal && shouldUseColor(process.env) && process.stdout.hasColors();
  const selectTheme = createSelectTheme(colorEnabled);
  const view = createNoesisView(
    initialTuiState(runtime.agent.name, {
      provider: requestedProvider,
      model: requestedModel,
      reasoningLevel: requestedReasoning,
      colorEnabled,
    }),
    () => terminal.rows,
  );
  const editor = createSafeEditor(tui, colorEnabled, selectTheme, () => terminal.rows);
  const statusView = createStatusView(view, () => terminal.rows);
  const inputLabelView = createInputLabelView(colorEnabled, () => terminal.rows);
  const helpView = createHelpView(colorEnabled, () => terminal.rows);
  let phase: "picker" | "main" | "stopped" = session.mode === "pick" ? "picker" : "main";
  let activeTurn: Promise<void> | undefined;
  let turnGeneration = 0;
  interface ActiveTurnToken {
    readonly generation: number;
    readonly trailId: string;
  }
  let activeTurnToken: ActiveTurnToken | undefined;
  let pendingStream: { readonly token: ActiveTurnToken; readonly text: string } | undefined;
  let streamRenderTimer: NodeJS.Timeout | undefined;
  let streamRenderTimerToken: ActiveTurnToken | undefined;
  const isCurrentTurn = (token: ActiveTurnToken): boolean =>
    phase === "main" && activeTurnToken === token && token.generation === turnGeneration;
  const flushStreamDelta = (token: ActiveTurnToken): void => {
    if (streamRenderTimer && streamRenderTimerToken !== token) return;
    if (streamRenderTimer) clearTimeout(streamRenderTimer);
    streamRenderTimer = undefined;
    streamRenderTimerToken = undefined;
    if (!isCurrentTurn(token) || pendingStream?.token !== token || !pendingStream.text) return;
    const text = pendingStream.text;
    pendingStream = undefined;
    view.dispatch({ type: "stream-delta", text });
    tui.requestRender();
  };
  const queueStreamDelta = (token: ActiveTurnToken, text: string): void => {
    if (!isCurrentTurn(token) || !text) return;
    pendingStream = {
      token,
      text: `${pendingStream?.token === token ? pendingStream.text : ""}${text}`,
    };
    if (streamRenderTimer) return;
    const activeCharacters =
      view.state.messages.at(-1)?.role === "assistant" ? (view.state.messages.at(-1)?.text.length ?? 0) : 0;
    streamRenderTimer = setTimeout(
      () => flushStreamDelta(token),
      streamingFrameDelay(activeCharacters, pendingStream.text.length),
    );
    streamRenderTimerToken = token;
  };
  let removeExitInputListener = (): void => undefined;
  let terminalStopped = false;
  let cancelPicker: (() => void) | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let resolveShutdown: (() => void) | undefined;
  let rejectShutdown: ((error: unknown) => void) | undefined;
  const shutdownCompleted = new Promise<void>((resolve, reject) => {
    resolveShutdown = resolve;
    rejectShutdown = reject;
  });
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      phase = "stopped";
      turnGeneration += 1;
      activeTurnToken = undefined;
      if (streamRenderTimer) clearTimeout(streamRenderTimer);
      streamRenderTimer = undefined;
      streamRenderTimerToken = undefined;
      pendingStream = undefined;
      editor.disableSubmit = true;
      editor.onSubmit = (): void => undefined;
      removeExitInputListener();
      try {
        await terminal.drainInput(1_000);
      } finally {
        if (!terminalStopped) {
          terminalStopped = true;
          tui.stop();
        }
      }
      const trailId = view.state.trailId;
      if (activeTurn && trailId) {
        const turn = activeTurn;
        const abortAndSettle = (async () => {
          await runtime.abort(trailId);
          await turn;
        })();
        let graceTimer: NodeJS.Timeout | undefined;
        // Terminal ownership is already released. Give a cooperative runtime a brief chance to
        // settle, then detach: a broken runtime must not keep the CLI lifecycle pending forever.
        const settlement = await Promise.race<ShutdownSettlement>([
          abortAndSettle.then<ShutdownSettlement, ShutdownSettlement>(
            () => ({ status: "settled" }),
            (error: unknown) => ({ status: "rejected", error }),
          ),
          new Promise<ShutdownSettlement>((resolve) => {
            graceTimer = setTimeout(() => resolve({ status: "timed-out" }), SHUTDOWN_GRACE_MS);
            graceTimer.unref();
          }),
        ]);
        if (graceTimer) clearTimeout(graceTimer);
        if (settlement.status === "rejected") throw settlement.error;
        if (settlement.status === "timed-out") {
          // The detached operation may still reject later; observe it without extending shutdown.
          void abortAndSettle.catch(() => undefined);
        }
      }
    })();
    shutdownPromise.then(resolveShutdown, rejectShutdown);
    return shutdownPromise;
  };
  removeExitInputListener = tui.addInputListener((data) => {
    if (matchesKey(data, "ctrl+c")) {
      cancelPicker?.();
      void shutdown();
      return { consume: true };
    }
    if (phase === "main" && data === "\n" && editor.getText().trim() === "/quit") {
      void shutdown();
      return { consume: true };
    }
    return undefined;
  });
  editor.onSubmit = (text) => {
    void (async () => {
      if (!view.state.trailId || !text.trim()) return;
      if (text === "/quit") {
        await shutdown();
        return;
      }
      if (activeTurn) {
        if (text.trim() === "/abort") {
          view.dispatch({ type: "execution-changed", execution: "aborting" });
          tui.requestRender();
          // Keep ABORTING observable for one throttled TUI render frame before a cooperative runtime settles.
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
          await runtime.abort(view.state.trailId);
        } else {
          view.dispatch({
            type: "system-message",
            text: "A turn is active. Use /abort to stop it before submitting another command.",
          });
          tui.requestRender();
        }
        return;
      }
      if (text === "/context") {
        view.dispatch({ type: "pane-selected", pane: "context" });
        tui.requestRender();
        return;
      }
      if (text === "/capabilities") {
        view.dispatch({ type: "pane-selected", pane: "capabilities" });
        tui.requestRender();
        return;
      }
      if (text === "?" || text === "/help") {
        view.dispatch({
          type: "system-message",
          text: [
            "/model provider/model · /context · /capabilities · /fork · /compact · /abort",
            "/learn · /evaluate · /promote · /rollback · /job prompt · /quit",
          ].join("\n"),
        });
        tui.requestRender();
        return;
      }
      if (text === "/abort") {
        view.dispatch({ type: "system-message", text: "No turn is active." });
        tui.requestRender();
        return;
      }
      if (text === "/compact") {
        view.dispatch({ type: "execution-changed", execution: "compacting" });
        tui.requestRender();
        await runtime.compact(view.state.trailId);
        view.dispatch({ type: "compacted" });
        view.dispatch({ type: "system-message", text: "Trail compacted." });
        tui.requestRender();
        return;
      }
      if (text === "/fork") {
        const trail = await runtime.forkTrail(view.state.trailId);
        view.dispatch({ type: "trail-selected", trail });
        tui.requestRender();
        return;
      }
      if (text.startsWith("/model ")) {
        const selection = text.slice(7).trim();
        const separator = selection.indexOf("/");
        if (separator <= 0 || separator === selection.length - 1) {
          view.dispatch({ type: "failed", error: "Use /model provider/model" });
        } else {
          const trail = await runtime.startTrail({
            title: `Model ${selection}`,
            provider: selection.slice(0, separator),
            model: selection.slice(separator + 1),
          });
          view.dispatch({ type: "trail-selected", trail });
        }
        tui.requestRender();
        return;
      }
      if (text === "/learn") {
        const learning = createLearningEngine(runtime.ledger);
        const workflow = (await learning.reflect(view.state.trailId)).find(
          (proposal) => proposal.kind === "workflow",
        );
        if (!workflow) throw new Error("Reflection did not produce a workflow proposal");
        const candidate = await runtime.capabilities.createCandidate(
          learning.candidateFromWorkflow(workflow, [
            {
              caseId: createId("case"),
              source: "source",
              input: "repeat the source workflow",
              expectedIncludes: ["evidenced", "completion"],
              baselineScore: 0.5,
            },
          ]),
        );
        view.dispatch({
          type: "system-message",
          text: `Created candidate ${candidate.name}@${candidate.version} from three evidence-linked proposals.`,
        });
        tui.requestRender();
        return;
      }
      if (text === "/evaluate" || text === "/promote") {
        const created = runtime.ledger.findByType("capability.candidate_created").at(-1);
        if (!created) throw new Error("No candidate exists; run /learn first");
        const capabilityId = String(created.payload["capabilityId"]);
        const version = Number(created.payload["version"]);
        const candidate = runtime.capabilities
          .getVersions(capabilityId)
          .find((item) => item.version === version);
        if (!candidate) throw new Error("Candidate projection is unavailable");
        if (text === "/evaluate") {
          const report = await runtime.evaluateCandidate(capabilityId, version);
          view.dispatch({
            type: "system-message",
            text: `Evaluation ${report.passed ? "passed" : "rejected"} at ${report.score.toFixed(2)}; negative results retained.`,
          });
        } else {
          await runtime.promoteCandidate(capabilityId, version);
          view.dispatch({ type: "system-message", text: `Promoted ${candidate.name}@${version}.` });
        }
        tui.requestRender();
        return;
      }
      if (text === "/rollback") {
        const active = runtime.capabilities.listActive().at(-1);
        if (!active) throw new Error("No active capability to roll back");
        await runtime.rollbackCapability(active.capabilityId, active.version, "TUI rollback");
        view.dispatch({ type: "system-message", text: `Rolled back ${active.name}@${active.version}.` });
        tui.requestRender();
        return;
      }
      if (text.startsWith("/job ")) {
        const scheduler = createDurableScheduler(runtime);
        const job = await scheduler.schedule({
          prompt: text.slice(5),
          schedule: "every 1h",
          budget: 2,
        });
        const output = await scheduler.run(job);
        view.dispatch({
          type: "system-message",
          text: `Background job ${job.jobId} delivered: ${output}`,
        });
        tui.requestRender();
        return;
      }
      view.dispatch({ type: "prompt-submitted", text });
      tui.requestRender();
      const trailId = view.state.trailId;
      if (!trailId) return;
      turnGeneration += 1;
      const token: ActiveTurnToken = { generation: turnGeneration, trailId };
      activeTurnToken = token;
      const turn = (async () => {
        try {
          const result = await runtime.runTurn(trailId, text, {
            ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
            onEvent: (event) => {
              if (!isCurrentTurn(token)) return;
              if (event.type === "delta") {
                queueStreamDelta(token, event.text);
                return;
              } else if (event.type === "tool-start") {
                flushStreamDelta(token);
                view.dispatch({ type: "tool-started", name: event.name });
              } else if (event.type === "tool-end") {
                flushStreamDelta(token);
                view.dispatch({ type: "tool-ended" });
              } else if (event.type === "model") {
                flushStreamDelta(token);
                view.dispatch({
                  type: "model-metadata",
                  provider: event.provider,
                  model: event.model,
                  contextWindow: event.contextWindow,
                });
              } else if (event.type === "usage") {
                flushStreamDelta(token);
                view.dispatch({
                  type: "usage-updated",
                  usedTokens: event.usedTokens,
                  contextWindow: event.contextWindow,
                  accuracy: event.accuracy,
                });
              } else if (event.type === "status" && event.status === "started") {
                flushStreamDelta(token);
                view.dispatch({ type: "execution-changed", execution: "thinking" });
              } else if (event.type === "status" && event.status === "aborted") {
                flushStreamDelta(token);
                view.dispatch({ type: "execution-changed", execution: "idle" });
              } else if (event.type === "status" && event.status === "failed") {
                flushStreamDelta(token);
                view.dispatch({ type: "failed", error: safeTerminalText(event.error) });
              }
              tui.requestRender();
            },
          });
          flushStreamDelta(token);
          if (!isCurrentTurn(token)) return;
          // Intermediate tool-loop messages are useful while a turn is live, but durable runtime
          // output is authoritative at settlement and replaces the current assistant block exactly.
          view.dispatch({ type: "stream-reconciled", text: safeTerminalText(result.output) });
          if (result.outcome === "aborted") {
            view.dispatch({ type: "turn-aborted" });
            view.dispatch({ type: "system-message", text: "Turn aborted." });
          } else {
            view.dispatch({
              type: "turn-completed",
              context: result.context,
              capabilities: result.usedCapabilities,
              turnCount: runtime.getTrail(trailId).turns.length,
              ...(result.contextUsage ? { contextUsage: result.contextUsage } : {}),
            });
          }
        } catch (error) {
          flushStreamDelta(token);
          if (!isCurrentTurn(token)) return;
          view.dispatch({
            type: "failed",
            error: safeTerminalText(error instanceof Error ? error.message : String(error)),
          });
        } finally {
          if (activeTurnToken === token) {
            activeTurnToken = undefined;
            pendingStream = undefined;
            if (streamRenderTimer) clearTimeout(streamRenderTimer);
            streamRenderTimer = undefined;
            streamRenderTimerToken = undefined;
            tui.requestRender();
          }
        }
      })();
      activeTurn = turn;
      await turn;
      if (activeTurn === turn) activeTurn = undefined;
    })().catch((error: unknown) => {
      view.dispatch({
        type: "failed",
        error: safeTerminalText(error instanceof Error ? error.message : String(error)),
      });
      tui.requestRender();
    });
  };
  tui.addChild(root);
  const mountMain = (trail: TrailState): void => {
    phase = "main";
    cancelPicker = undefined;
    view.dispatch({ type: "trail-selected", trail });
    root.clear();
    root.addChild(view);
    root.addChild(inputLabelView);
    root.addChild(editor);
    root.addChild(statusView);
    root.addChild(helpView);
    tui.setFocus(editor);
    tui.requestRender();
  };

  if (session.mode === "pick") {
    const items = createSessionPickerItems(runtime.listTrailSummaries());
    if (items.length === 0)
      throw new Error(
        `No saved sessions were found in ${runtime.ledger.paths.root}. Start a new session with noesis (without --resume).`,
      );
    const picker = createResponsiveSessionPicker(items, () => terminal.rows, selectTheme);
    const selected = new Promise<string | undefined>((resolve) => {
      let settled = false;
      const finish = (trailId: string | undefined): void => {
        if (settled) return;
        settled = true;
        resolve(trailId);
      };
      cancelPicker = () => finish(undefined);
      picker.onSelect = (item) => finish(item.value);
      picker.onCancel = () => {
        finish(undefined);
        void shutdown();
      };
    });
    root.addChild(
      createStaticLineView(
        `${styled(colorEnabled, `${ANSI.bold}${ANSI.cyan}`, "NOESIS")}  ${styled(
          colorEnabled,
          ANSI.dim,
          "resume a session",
        )}`,
        () => terminal.rows >= 2,
      ),
    );
    root.addChild(
      createStaticLineView(
        styled(colorEnabled, ANSI.dim, "↑/↓ navigate · Enter resume · Esc cancel"),
        () => terminal.rows >= 3,
      ),
    );
    root.addChild(picker);
    tui.setFocus(picker);
    tui.start();
    const trailId = await selected;
    if (!trailId) {
      await shutdown();
      await shutdownCompleted;
      return;
    }
    try {
      mountMain(await resumableTrail(runtime, trailId));
    } catch (error) {
      await shutdown();
      throw error;
    }
  } else {
    const trail =
      session.mode === "resume"
        ? await resumableTrail(runtime, session.trailId)
        : await runtime.startTrail({
            title: "Noesis session",
            provider: requestedProvider,
            model: requestedModel,
          });
    mountMain(trail);
    tui.start();
  }
  await shutdownCompleted;
}
