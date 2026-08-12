import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { EXECUTE_ACTION_NAME, formatCount, sourceOf, summarizeAction } from "./action-summary.ts";
import { renderRichText } from "./rich-text.ts";
import {
  childActions,
  type NoesisTuiState,
  type TuiAgentAction,
  type TuiMessage,
  type TuiTimelineEntry,
  timelineActions,
} from "./state.ts";
import { ANSI, elideText, safeTerminalText, styled } from "./theme.ts";

const ACTION_DETAIL_MAX_CHARACTERS = 24_000;
const MAX_ACTION_DEPTH = 4;
const DEFAULT_EXPANDED_BODY_ROWS = 16;

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

export function actionDepth(action: TuiAgentAction, actions: readonly TuiAgentAction[]): number {
  let depth = 0;
  let parentId = action.parentActionId;
  const visited = new Set<string>();
  while (parentId && depth < MAX_ACTION_DEPTH && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = actions.find((candidate) => candidate.actionId === parentId);
    if (!parent) break;
    depth += 1;
    parentId = parent.parentActionId;
  }
  return depth;
}

const statusGlyph = (status: TuiAgentAction["status"]): string =>
  status === "running"
    ? "●"
    : status === "completed"
      ? "✓"
      : status === "failed"
        ? "×"
        : status === "cancelled" || status === "interrupted"
          ? "■"
          : "!";

const statusColor = (status: TuiAgentAction["status"]): string =>
  status === "running"
    ? ANSI.cyan
    : status === "completed"
      ? ANSI.green
      : status === "failed"
        ? ANSI.red
        : ANSI.yellow;

export interface ActionBlockOptions {
  readonly expanded?: boolean;
  readonly selected?: boolean;
  readonly colorEnabled?: boolean;
  /**
   * Inline expansion stays inside the visible screen. A block taller than the viewport would push
   * its own header above the top, and pi-tui repaints the whole screen when content above the
   * previous viewport changes, which erases terminal scrollback.
   */
  readonly maxBodyRows?: number;
}

/**
 * One transcript row per action. Codemode results routinely carry entire file contents, so the
 * payload is only rendered when the row is explicitly expanded.
 */
export function renderAgentActionBlock(
  action: TuiAgentAction,
  actions: readonly TuiAgentAction[],
  width: number,
  options: ActionBlockOptions = {},
): string[] {
  if (width <= 0) return [];
  const colorEnabled = options.colorEnabled ?? false;
  const depth = actionDepth(action, actions);
  const marker = options.selected ? "▸" : " ";
  const indent = `${marker}${"  ".repeat(depth)}`;
  const summary = summarizeAction(action, childActions(actions, action.actionId));
  const glyph = styled(colorEnabled, `${ANSI.bold}${statusColor(action.status)}`, statusGlyph(action.status));
  const name = styled(
    colorEnabled,
    options.selected ? `${ANSI.bold}${ANSI.underline}` : ANSI.bold,
    summary.name,
  );
  const trailing = [summary.subject, summary.outcome].filter((part): part is string => Boolean(part));
  const header = elideText(
    `${indent}${glyph} ${name}${trailing.length > 0 ? `  ${styled(colorEnabled, ANSI.dim, trailing.join(" · "))}` : ""}`,
    width,
  );
  if (!options.expanded) return [header];

  // Only the header carries the selection marker; the body keeps the gutter column blank.
  const rail = `${" ".repeat(visibleWidth(indent))}${styled(colorEnabled, ANSI.dim, "│ ")} `;
  const bodyWidth = Math.max(1, width - visibleWidth(rail));
  const source = action.name === EXECUTE_ACTION_NAME ? sourceOf(action) : undefined;
  // The codemode program is the substance of an execute call, so render it as code rather than as
  // one more quoted JSON field.
  const body = source
    ? [
        ...renderRichText(`\`\`\`js\n${safeTerminalText(source)}\n\`\`\``, bodyWidth, colorEnabled),
        ...(action.output === undefined
          ? []
          : actionDetailSection("result", action.output)
              .split("\n")
              .flatMap((line) => wrapTextWithAnsi(line, bodyWidth))),
      ]
    : actionDetailSource(action)
        .split("\n")
        .flatMap((line) => wrapTextWithAnsi(line, bodyWidth));
  const budget = options.maxBodyRows ?? DEFAULT_EXPANDED_BODY_ROWS;
  const shown = body.length > budget ? body.slice(0, Math.max(1, budget - 1)) : body;
  const overflow =
    body.length > budget
      ? [
          styled(
            colorEnabled,
            ANSI.dim,
            `… ${formatCount(body.length - shown.length, "more row")} · enter opens the run inspector`,
          ),
        ]
      : [];
  return [header, ...[...shown, ...overflow].map((line) => elideText(`${rail}${line}`, width))];
}

interface RenderedTimelineBlock {
  readonly lines: readonly string[];
}

export interface TranscriptRenderMetrics {
  readonly parsedBlocks: number;
  readonly cacheHits: number;
}

export interface TranscriptRenderer {
  /**
   * Renders the whole conversation. Output taller than the terminal scrolls into native terminal
   * scrollback rather than being cropped, so no transcript content is ever unreachable.
   */
  readonly render: (state: NoesisTuiState, width: number, maxBodyRows?: number) => readonly string[];
  readonly metrics: () => TranscriptRenderMetrics;
}

export const EMPTY_TRANSCRIPT_HINTS = Object.freeze([
  "What are you thinking about?",
  "What do you want to understand, make, or change?",
  "Bring a question, a half-formed idea, or a concrete task.",
  "What are you working on?",
  "Start anywhere. We can sharpen the question together.",
] as const);

export function selectEmptyTranscriptHint(randomValue = Math.random()): string {
  const bounded = Number.isFinite(randomValue) ? Math.min(Math.max(randomValue, 0), 1) : 0;
  const index = Math.min(
    EMPTY_TRANSCRIPT_HINTS.length - 1,
    Math.floor(bounded * EMPTY_TRANSCRIPT_HINTS.length),
  );
  return EMPTY_TRANSCRIPT_HINTS[index] ?? EMPTY_TRANSCRIPT_HINTS[0];
}

export function createTranscriptRenderer(random: () => number = Math.random): TranscriptRenderer {
  const emptyTranscriptHint = selectEmptyTranscriptHint(random());
  const cache = new WeakMap<
    TuiTimelineEntry,
    { readonly key: string; readonly block: RenderedTimelineBlock }
  >();
  let parsedBlocks = 0;
  let cacheHits = 0;
  const renderBlock = (
    entry: TuiTimelineEntry,
    actions: readonly TuiAgentAction[],
    width: number,
    state: NoesisTuiState,
    maxBodyRows: number,
  ): RenderedTimelineBlock => {
    const expanded = entry.kind === "action" && state.expandedActionIds.has(entry.actionId);
    const selected = entry.kind === "action" && state.actionCursor === entry.actionId;
    const depth = entry.kind === "action" ? actionDepth(entry, actions) : 0;
    // An execute row summarizes its direct children. Those children arrive and settle as separate
    // immutable timeline entries, so the parent object can remain identical while its rendered
    // summary changes.
    const childSummaryKey =
      entry.kind === "action" && entry.name === EXECUTE_ACTION_NAME
        ? JSON.stringify(childActions(actions, entry.actionId).map((child) => [child.name, child.status]))
        : "";
    const key = [
      String(width),
      state.colorEnabled ? "color" : "plain",
      expanded ? "expanded" : "collapsed",
      selected ? "selected" : "unselected",
      String(depth),
      String(maxBodyRows),
      childSummaryKey,
    ].join(":");
    const cached = cache.get(entry);
    if (cached?.key === key) {
      cacheHits += 1;
      return cached.block;
    }
    parsedBlocks += 1;
    const block = {
      lines:
        entry.kind === "message"
          ? renderMessageBlock(entry, width, state.colorEnabled)
          : renderAgentActionBlock(entry, actions, width, {
              expanded,
              selected,
              colorEnabled: state.colorEnabled,
              maxBodyRows,
            }),
    };
    cache.set(entry, { key, block });
    return block;
  };
  return {
    render(state, width, maxBodyRows = DEFAULT_EXPANDED_BODY_ROWS) {
      if (width <= 0) return [];
      if (state.timeline.length === 0)
        return [elideText(styled(state.colorEnabled, ANSI.dim, emptyTranscriptHint), width)];
      const actions = timelineActions(state.timeline);
      return state.timeline.flatMap((entry, index) => {
        // Nested codemode calls read as a list under their parent, so they are not separated.
        const separated = index > 0 && !(entry.kind === "action" && entry.parentActionId);
        return [...(separated ? [""] : []), ...renderBlock(entry, actions, width, state, maxBodyRows).lines];
      });
    },
    metrics: () => ({ parsedBlocks, cacheHits }),
  };
}
