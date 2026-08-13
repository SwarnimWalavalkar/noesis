import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { renderRunInspectorFrame } from "./run-inspector.ts";
import { type NoesisTuiAction, type NoesisTuiState, reduceTui, type TuiContextUsage } from "./state.ts";
import { ANSI, elideText, NOESIS_WORDMARK, safeTerminalText, styled } from "./theme.ts";
import { createTranscriptRenderer, type TranscriptRenderer } from "./transcript.ts";

export * from "./action-summary.ts";
export * from "./rich-text.ts";
export * from "./run-inspector.ts";
export * from "./syntax.ts";
export * from "./theme.ts";
export * from "./transcript.ts";

export type TuiWidthClass = "wide" | "normal" | "narrow";
export type HeaderMode = "ascii" | "compact" | "none";

export interface TuiLayout {
  readonly widthClass: TuiWidthClass;
  readonly headerMode: HeaderMode;
  /** Upper bound on inspector pane rows so a large context snapshot cannot dominate the screen. */
  readonly paneRows: number;
  /** Upper bound on an inline expanded action body, keeping its header on screen. */
  readonly expandedRowBudget: number;
}

export function createTuiLayout(width: number, height: number): TuiLayout {
  const widthClass: TuiWidthClass = width >= 120 ? "wide" : width >= 80 ? "normal" : "narrow";
  const headerMode: HeaderMode =
    width < 36 || height < 10 ? "none" : width >= 100 && height >= 30 ? "ascii" : "compact";
  return {
    widthClass,
    headerMode,
    paneRows: Math.max(1, Math.floor(height / 3)),
    // Six rows of bottom chrome plus a little breathing room above the expanded block.
    expandedRowBudget: Math.max(3, height - 10),
  };
}

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
  const turns = `${String(state.turnCount).padStart(3)} ${state.turnCount === 1 ? "turn" : "turns"}`;
  const capabilities = Object.keys(state.capabilityVersions).length;
  const queue =
    state.interaction.queuedInputs.length > 0
      ? `q ${String(state.interaction.queuedInputs.length)}${state.interaction.queuePaused ? " paused" : ""}`
      : undefined;
  if (layout.widthClass === "wide")
    return [
      execution,
      model,
      state.reasoningLevel,
      context.percent,
      ...(context.tokens ? [context.tokens] : []),
      turns,
      ...(queue ? [queue] : []),
      ...(capabilities > 0 ? [`${String(capabilities)} caps`] : []),
    ];
  if (layout.widthClass === "normal")
    return [
      execution,
      model,
      state.reasoningLevel,
      context.percent,
      `${String(state.turnCount).padStart(3)}t`,
      ...(queue ? [queue] : []),
    ];
  return [execution, model, context.percent, turns, ...(queue ? [queue] : [])];
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

export function renderStatusLine(state: NoesisTuiState, width: number, height = 30): string {
  const layout = createTuiLayout(width, height);
  return elideText(colorStatusLine(state, fitStatusFields(createStatusFields(state, layout), width)), width);
}

/** Keys change meaning while the transcript is navigable, so the hint follows the mode. */
export function helpHint(state: NoesisTuiState): string {
  if (state.inspector)
    return `↑/↓ scroll · space ${state.inspector.view === "raw" ? "semantic" : "exact"} · esc close`;
  if (state.actionCursor) return "↑/↓ select · space expand · enter inspect · esc leave · ctrl+c quit";
  if (state.interaction.phase !== "idle")
    return "enter queue · /steer redirect · alt+↑ edit newest · esc interrupt";
  if (state.execution === "compacting" && state.interaction.queuedInputs.length > 0)
    return "enter queue · waiting for compaction · alt+↑ edit newest";
  if (state.interaction.queuePaused && state.interaction.queuedInputs.length > 0)
    return "/queue resume · alt+↑ edit newest";
  return "? help · ctrl+o inspect runs · ctrl+c quit";
}

export function renderQueuedInputs(state: NoesisTuiState, width: number, maxVisible = 3): readonly string[] {
  const safeWidth = Math.max(0, Math.floor(width));
  const queued = state.interaction.queuedInputs;
  if (safeWidth <= 0 || queued.length === 0) return [];
  const shown = queued.slice(-Math.max(1, maxVisible));
  const hidden = Math.max(0, queued.length - shown.length);
  const heading = [
    `QUEUED · ${String(queued.length)}`,
    ...(state.interaction.queuePaused ? ["paused"] : []),
    ...(queued.some((item) => item.status === "held") ? ["holding steer"] : []),
    ...(queued.some((item) => item.status === "unresolved") ? ["unresolved"] : []),
  ].join(" · ");
  return [
    elideText(styled(state.colorEnabled, `${ANSI.bold}${ANSI.yellow}`, heading), safeWidth),
    ...(hidden > 0
      ? [elideText(styled(state.colorEnabled, ANSI.dim, `… ${String(hidden)} earlier`), safeWidth)]
      : []),
    ...shown.map((item, index) =>
      elideText(
        `${styled(state.colorEnabled, ANSI.dim, `${String(hidden + index + 1)}${item.status === "unresolved" ? "?" : item.status === "held" ? "→" : " "} `)}${safeTerminalQueueText(item.text)}`,
        safeWidth,
      ),
    ),
  ];
}

const safeTerminalQueueText = (text: string): string =>
  safeTerminalText(text).replaceAll(/\s+/gu, " ").trim() || "(empty)";

export function renderBottomChrome(state: NoesisTuiState, width: number, height = 30): string[] {
  const safeWidth = Math.max(0, Math.floor(width));
  return [
    elideText(styled(state.colorEnabled, `${ANSI.bold}${ANSI.cyan}`, "› message"), safeWidth),
    renderStatusLine(state, safeWidth, height),
    ...(height >= 8 ? [elideText(styled(state.colorEnabled, ANSI.dim, helpHint(state)), safeWidth)] : []),
  ];
}

export function renderHeader(colorEnabled: boolean, width: number, height: number): string[] {
  const terminalWidth = Math.max(0, Math.floor(width));
  const inner = terminalWidth > 2 ? terminalWidth - 2 : terminalWidth;
  if (inner <= 0) return [];
  const { headerMode } = createTuiLayout(terminalWidth, height);
  if (headerMode === "none") return [];
  const tagline = "think · learn · create · grow";
  const lines =
    headerMode === "ascii"
      ? [
          ...NOESIS_WORDMARK.map((line) => styled(colorEnabled, `${ANSI.bold}${ANSI.cyan}`, line)),
          styled(colorEnabled, ANSI.dim, tagline),
        ]
      : [
          `${styled(colorEnabled, `${ANSI.bold}${ANSI.cyan}`, "NOESIS")}${styled(
            colorEnabled,
            ANSI.dim,
            terminalWidth >= 52 && height >= 16 ? `  ${tagline}` : "",
          )}`,
        ];
  return [...lines, styled(colorEnabled, ANSI.dim, "─".repeat(inner))].map((line) => elideText(line, inner));
}

function paneLines(state: NoesisTuiState, layout: TuiLayout): readonly string[] {
  const all =
    state.pane === "context" && state.context
      ? state.context.fragments.map(
          (fragment) =>
            `context> ${fragment.kind}:${fragment.id} ${String(fragment.tokens)}t source=${fragment.provenance.join(",")}`,
        )
      : state.pane === "capabilities"
        ? Object.entries(state.capabilityVersions).map(
            ([name, version]) => `capability> ${name}@${String(version)}`,
          )
        : [];
  return all.slice(-layout.paneRows);
}

/**
 * Renders the conversation with no row budget. Output taller than the terminal scrolls into native
 * terminal scrollback, so the transcript is never cropped and history stays reachable.
 */
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
  return [
    ...transcriptRenderer.render(state, inner, layout.expandedRowBudget),
    ...paneLines(state, layout).map((line) => elideText(line, inner)),
    ...(state.error
      ? [styled(state.colorEnabled, `${ANSI.bold}${ANSI.red}`, elideText(`Error · ${state.error}`, inner))]
      : []),
  ];
}

const defaultTranscriptRenderer = createTranscriptRenderer();

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

/**
 * The banner is an ordinary first child of the render tree. It occupies the top of the line array
 * and scrolls out of the viewport into terminal scrollback as the conversation grows, so it costs
 * nothing after the first screen.
 */
export function createHeaderView(colorEnabled: boolean, height: () => number): Component {
  return {
    invalidate() {},
    render: (width) => renderHeader(colorEnabled, width, height()),
  };
}

/**
 * The inspector is mounted as a pi-tui overlay rather than a transcript child. An overlay
 * composites over the visible rows instead of changing the rendered line count, so opening and
 * closing it never shrinks content and never triggers a scrollback-clearing repaint.
 */
export function createRunInspectorOverlay(
  view: NoesisView,
  height: () => number,
  onBoundsMeasured: (maxScroll: number) => void = () => undefined,
): Component {
  return {
    invalidate() {},
    render(width) {
      const inspector = view.state.inspector;
      if (!inspector) return [];
      // This is the overlay's sole height bound. Keeping the returned rows within the terminal
      // means pi-tui never needs to clip them after maxScroll has already been calculated.
      const rendered = renderRunInspectorFrame(view.state, Math.max(0, width), Math.max(0, height() - 6));
      onBoundsMeasured(rendered.maxScroll);
      return [...rendered.rows];
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

export function createQueuedInputsView(view: NoesisView, height: () => number): Component {
  return {
    invalidate() {},
    render(width) {
      if (height() < 7) return [];
      return [...renderQueuedInputs(view.state, Math.max(0, width))];
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

export function createHelpView(view: NoesisView, height: () => number): Component {
  return {
    invalidate() {},
    render(width) {
      if (height() < 8) return [];
      return [elideText(styled(view.state.colorEnabled, ANSI.dim, helpHint(view.state)), Math.max(0, width))];
    },
  };
}

export function createStaticLineView(text: string, visible: () => boolean = () => true): Component {
  return {
    invalidate() {},
    render: (width) => (visible() ? [elideText(text, Math.max(0, width))] : []),
  };
}
