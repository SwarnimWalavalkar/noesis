import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { formatCount } from "./action-summary.ts";
import { renderRunInspectorFrame } from "./run-inspector.ts";
import {
  type ExecutionState,
  type NoesisTuiAction,
  type NoesisTuiState,
  reduceTui,
  type TuiContextUsage,
} from "./state.ts";
import { ANSI, brandGradient, elideText, NOESIS_WORDMARK, safeTerminalText, styled } from "./theme.ts";
import { NOESIS_STARTUP_NOTES } from "./startup-note.ts";
import { createTranscriptRenderer, type TranscriptRenderer } from "./transcript.ts";
import { isPulseDimFrame, isWorkingExecution, WORKING_ANIMATION_INTERVAL_MS } from "./working-animation.ts";

export * from "./action-summary.ts";
export * from "./rich-text.ts";
export * from "./run-inspector.ts";
export * from "./startup-note.ts";
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
  /** Fixed subagent activity stays useful without consuming the whole terminal. */
  readonly subagentRows: number;
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
    subagentRows: Math.max(1, Math.min(6, Math.floor(height / 5))),
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

const CONTEXT_METER_CELLS = 8;

/** A glanceable pressure gauge next to the exact percentage: fills and warms as context tightens. */
export function contextMeter(usage: TuiContextUsage | undefined, colorEnabled: boolean): string | undefined {
  if (!usage || usage.contextWindow <= 0 || usage.usedTokens < 0) return undefined;
  const ratio = Math.min(1, Math.max(0, usage.usedTokens / usage.contextWindow));
  const filled = Math.round(ratio * CONTEXT_METER_CELLS);
  const color = ratio >= 0.9 ? ANSI.red : ratio >= 0.7 ? ANSI.yellow : ANSI.green;
  return `${styled(colorEnabled, color, "▰".repeat(filled))}${styled(colorEnabled, ANSI.dim, "▱".repeat(CONTEXT_METER_CELLS - filled))}`;
}

// Motion carries meaning: a thought-comet orbits with a trailing tail, tool work ticks,
// compaction squeezes.
const THOUGHT_FRAMES = ["⠉", "⠃", "⠆", "⡄", "⣀", "⢠", "⠰", "⠘"] as const;
const TOOL_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const COMPACT_FRAMES = ["░", "▒", "▓", "▒"] as const;
// Closing dissolves into emptiness and reconstitutes: a clear wind-down, not another spinner.
const CLOSING_FRAMES = ["⣿", "⣷", "⣶", "⣦", "⣤", "⣄", "⣀", "⣄", "⣤", "⣦", "⣶", "⣷"] as const;
const ORBIT_FRAMES = ["◐", "◓", "◑", "◒"] as const;

function workingGlyph(execution: ExecutionState, frame: number): string {
  const frames =
    execution === "thinking" || execution === "streaming"
      ? THOUGHT_FRAMES
      : execution === "tool"
        ? TOOL_FRAMES
        : execution === "compacting"
          ? COMPACT_FRAMES
          : execution === "closing"
            ? CLOSING_FRAMES
            : ORBIT_FRAMES;
  return frames[frame % frames.length] ?? frames[0];
}

/** Fixed-width turn clock derived from the animation frame, so ticking never shifts the layout. */
export function formatWorkingClock(frame: number): string {
  const totalSeconds = Math.floor((frame * WORKING_ANIMATION_INTERVAL_MS) / 1000);
  const minutes = Math.min(99, Math.floor(totalSeconds / 60));
  const seconds = minutes >= 99 ? 59 : totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function createStatusFields(state: NoesisTuiState, layout: TuiLayout): readonly string[] {
  const context = formatContextUsage(state.contextUsage);
  const meter = contextMeter(state.contextUsage, state.colorEnabled);
  const animated = isWorkingExecution(state.execution);
  // Closing animates without the turn clock: the frame counter no longer measures a turn.
  const glyph =
    animated || state.execution === "closing" ? workingGlyph(state.execution, state.animationFrame) : "●";
  // Status uses WORKING for the thinking phase so the bar reads as general progress; reasoning
  // blocks keep their own ∴ THINKING label in the transcript.
  const executionLabel = (state.execution === "thinking" ? "working" : state.execution)
    .toUpperCase()
    .padEnd(10);
  const execution = `${glyph} ${executionLabel}${animated ? ` ${formatWorkingClock(state.animationFrame)}` : ""}`;
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
      ...(meter ? [meter] : []),
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
      ...(meter ? [meter] : []),
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
        : state.execution === "compacting" || state.execution === "aborting" || state.execution === "closing"
          ? ANSI.yellow
          : ANSI.cyan;
  return fields
    .map((field, index) =>
      index === 0
        ? styled(state.colorEnabled, `${ANSI.bold}${stateColor}`, field)
        : field.includes("\u001b[")
          ? field
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
  if (state.execution === "closing") return "closing session…";
  if (state.inspector)
    return `↑/↓ scroll · space ${state.inspector.view === "raw" ? "semantic" : "exact"} · esc close`;
  if (state.subAgentCursor) return "↑/↓ agents · enter inspect · tab transcript · esc leave · ctrl+c quit";
  if (state.actionCursor)
    return "↑/↓ transcript · space expand · enter inspect · tab subagents · esc leave · ctrl+c quit";
  if (state.interaction.phase !== "idle")
    return "enter queue · /steer redirect · alt+↑ edit newest · esc esc interrupt";
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
    ...(queued.some((item) => item.status === "dispatching") ? ["steering at next safe boundary"] : []),
  ].join(" · ");
  return [
    elideText(styled(state.colorEnabled, `${ANSI.bold}${ANSI.yellow}`, heading), safeWidth),
    ...(hidden > 0
      ? [elideText(styled(state.colorEnabled, ANSI.dim, `… ${String(hidden)} earlier`), safeWidth)]
      : []),
    ...shown.map((item, index) =>
      elideText(
        `${styled(state.colorEnabled, ANSI.dim, `${String(hidden + index + 1)}${item.status === "held" ? "→" : item.status === "dispatching" ? "⇢" : " "} `)}${safeTerminalQueueText(item.text)}`,
        safeWidth,
      ),
    ),
  ];
}

const safeTerminalQueueText = (text: string): string =>
  safeTerminalText(text).replaceAll(/\s+/gu, " ").trim() || "(empty)";

/**
 * The prompt label doubles as the mode indicator: cyan `› message` means the editor owns input.
 * Inspect mode replaces it with a reverse-video badge because the editor is hidden and paused,
 * so this line is the one place that says where keystrokes are going.
 */
export function inputModeLine(state: NoesisTuiState, width: number): string {
  if (!state.actionCursor && !state.subAgentCursor && !state.inspector)
    return elideText(styled(state.colorEnabled, `${ANSI.bold}${ANSI.cyan}`, "› message"), width);
  const badge = styled(state.colorEnabled, `${ANSI.bold}${ANSI.reverse}${ANSI.yellow}`, " ⊙ INSPECT ");
  const hint = styled(state.colorEnabled, ANSI.dim, "  typing paused · esc to return");
  return elideText(`${badge}${hint}`, width);
}

/** The badge shape carries the tone even without color; learning gets its own signature glyph. */
export function notificationBadge(tone: "info" | "success" | "attention" | "learning"): {
  readonly glyph: string;
  readonly color: string;
} {
  if (tone === "success") return { glyph: "✓", color: ANSI.green };
  if (tone === "attention") return { glyph: "▲", color: ANSI.yellow };
  if (tone === "learning") return { glyph: "✦", color: ANSI.magenta };
  return { glyph: "◆", color: ANSI.cyan };
}

const subagentStatusGlyph = (status: NoesisTuiState["subAgents"][number]["status"]): string =>
  status === "running" || status === "starting"
    ? "●"
    : status === "idle"
      ? "✓"
      : status === "closed"
        ? "○"
        : "■";

const subagentStatusColor = (status: NoesisTuiState["subAgents"][number]["status"]): string =>
  status === "running" || status === "starting"
    ? ANSI.cyan
    : status === "idle"
      ? ANSI.green
      : status === "closed"
        ? ANSI.dim
        : ANSI.yellow;

/** A footer-adjacent projection inspired by agent tabs/panels, never a second state authority. */
export function renderSubagents(state: NoesisTuiState, width: number, height = 30): readonly string[] {
  const safeWidth = Math.max(0, Math.floor(width));
  const subagents = state.subAgents;
  if (safeWidth <= 0 || subagents.length === 0 || height < 10) return [];
  const running = subagents.filter((agent) => agent.status === "running" || agent.status === "starting");
  const idle = subagents.filter((agent) => agent.status === "idle");
  const stopped = subagents.filter((agent) => agent.status === "suspended" || agent.status === "closed");
  const maximumRows = createTuiLayout(safeWidth, height).subagentRows;
  const inspecting = state.subAgentCursor !== undefined;
  const selected = inspecting ? subagents.find((agent) => agent.agentId === state.subAgentCursor) : undefined;
  const priority = [
    ...(selected ? [selected] : []),
    ...running.filter((agent) => agent.agentId !== selected?.agentId),
  ].slice(0, maximumRows);
  const priorityIds = new Set(priority.map((agent) => agent.agentId));
  const additionalCapacity = Math.max(0, maximumRows - priority.length);
  const additional =
    !inspecting || additionalCapacity === 0
      ? []
      : subagents.filter((agent) => !priorityIds.has(agent.agentId)).slice(-additionalCapacity);
  const shownIds = new Set([...priority, ...additional].map((agent) => agent.agentId));
  const candidates = inspecting ? subagents : running;
  const shown = candidates.filter((agent) => shownIds.has(agent.agentId));
  const hidden = candidates.length - shown.length;
  const collapsed = inspecting ? 0 : subagents.length - running.length;
  const headerColor = running.length > 0 ? ANSI.cyan : stopped.length > 0 ? ANSI.yellow : ANSI.green;
  const headerStatus = [
    ...(running.length > 0 ? [formatCount(running.length, "running subagent")] : []),
    ...(idle.length > 0 ? [formatCount(idle.length, "idle subagent")] : []),
    ...(stopped.length > 0 ? [formatCount(stopped.length, "stopped subagent")] : []),
  ].join(" · ");
  const headerHint = inspecting
    ? "enter inspect · tab transcript"
    : collapsed > 0
      ? "ctrl+o expand"
      : "ctrl+o inspect";
  return [
    elideText(
      `${styled(state.colorEnabled, `${ANSI.bold}${headerColor}`, `SUBAGENTS · ${String(subagents.length)}`)}${headerStatus ? `  ${styled(state.colorEnabled, ANSI.dim, `${headerStatus} · ${headerHint}`)}` : ""}`,
      safeWidth,
    ),
    ...shown.map((agent, index) => {
      const selected = state.subAgentCursor === agent.agentId;
      const subject = safeTerminalText(agent.name ?? `Subagent ${String(index + 1)}`)
        .replaceAll(/\s+/gu, " ")
        .trim();
      const outcome = [
        agent.status,
        state.subAgentPhases[agent.agentId],
        agent.latestTaskStatus === agent.status ? undefined : agent.latestTaskStatus,
        `${agent.route.provider}/${agent.route.model}`,
      ]
        .filter((part): part is string => Boolean(part))
        .join(" · ");
      // The glyph character stays stable; only its intensity breathes while work is live.
      const pulseDim =
        (agent.status === "running" || agent.status === "starting") &&
        isWorkingExecution(state.execution) &&
        isPulseDimFrame(state.animationFrame);
      const glyphStyle = `${pulseDim ? ANSI.dim : ANSI.bold}${subagentStatusColor(agent.status)}`;
      return elideText(
        `${selected ? "▸" : " "} ${styled(state.colorEnabled, glyphStyle, subagentStatusGlyph(agent.status))} ${styled(state.colorEnabled, selected ? `${ANSI.bold}${ANSI.underline}` : "", subject)}${outcome ? `  ${styled(state.colorEnabled, ANSI.dim, outcome)}` : ""}`,
        safeWidth,
      );
    }),
    ...(hidden > 0
      ? [
          elideText(
            styled(
              state.colorEnabled,
              ANSI.dim,
              `  … ${formatCount(hidden, inspecting ? "more subagent" : "more active subagent")} in this run · ${headerHint}`,
            ),
            safeWidth,
          ),
        ]
      : []),
  ];
}

export function renderBottomChrome(state: NoesisTuiState, width: number, height = 30): string[] {
  const safeWidth = Math.max(0, Math.floor(width));
  const badge = state.notification ? notificationBadge(state.notification.tone) : undefined;
  return [
    ...renderSubagents(state, safeWidth, height),
    ...(state.notification && badge
      ? [
          elideText(
            styled(
              state.colorEnabled,
              `${ANSI.bold}${badge.color}`,
              `${badge.glyph} ${safeTerminalText(state.notification.text)}`,
            ),
            safeWidth,
          ),
        ]
      : []),
    inputModeLine(state, safeWidth),
    renderStatusLine(state, safeWidth, height),
    ...(height >= 8 ? [elideText(styled(state.colorEnabled, ANSI.dim, helpHint(state)), safeWidth)] : []),
  ];
}

export function renderHeader(
  colorEnabled: boolean,
  width: number,
  height: number,
  trueColorEnabled = false,
  note: string = NOESIS_STARTUP_NOTES[0],
): string[] {
  const terminalWidth = Math.max(0, Math.floor(width));
  const inner = terminalWidth > 2 ? terminalWidth - 2 : terminalWidth;
  if (inner <= 0) return [];
  const { headerMode } = createTuiLayout(terminalWidth, height);
  if (headerMode === "none") return [];
  const lines =
    headerMode === "ascii"
      ? [
          ...NOESIS_WORDMARK.map((line) => brandGradient(line, colorEnabled, trueColorEnabled)),
          styled(colorEnabled, ANSI.dim, note),
        ]
      : [
          `${brandGradient("NOESIS", colorEnabled, trueColorEnabled)}${styled(
            colorEnabled,
            ANSI.dim,
            terminalWidth >= 52 && height >= 16 ? `  ${note}` : "",
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
  const transcriptState = mainTranscriptState(state);
  const transcript = transcriptRenderer.render(transcriptState, inner, layout.expandedRowBudget);
  const visibleTranscript = state.actionCursor
    ? renderTranscriptNavigationWindow(
        transcript,
        transcriptRenderer.renderWindow(state, inner, layout.expandedRowBudget, layout.expandedRowBudget),
        layout.expandedRowBudget,
      )
    : transcript;
  return [
    ...visibleTranscript,
    ...paneLines(state, layout).map((line) => elideText(line, inner)),
    ...(state.error
      ? [styled(state.colorEnabled, `${ANSI.bold}${ANSI.red}`, elideText(`Error · ${state.error}`, inner))]
      : []),
  ];
}

const defaultTranscriptRenderer = createTranscriptRenderer();
const NO_NAVIGATION_EXPANSIONS: ReadonlySet<string> = new Set<string>();

/**
 * Keeps the ordinary transcript's off-screen prefix intact while replacing only its visible tail
 * with the window around the selected action. Short transcripts may grow to the viewport budget
 * so an expanded action remains useful; long transcripts keep exactly the same line count. This
 * makes Ctrl-O feel like the existing view scrolled to the action without introducing a modal.
 */
const renderTranscriptNavigationWindow = (
  transcript: readonly string[],
  window: readonly string[],
  rowBudget: number,
): readonly string[] => {
  const visibleRows = Math.max(0, Math.floor(rowBudget));
  if (visibleRows === 0) return transcript;
  const prefixRows = Math.max(0, transcript.length - visibleRows);
  const targetRows = Math.max(transcript.length, visibleRows);
  const shown = window.slice(-visibleRows);
  return [
    ...transcript.slice(0, prefixRows),
    ...Array.from({ length: targetRows - prefixRows - shown.length }, () => ""),
    ...shown,
  ];
};

const mainTranscriptState = (state: NoesisTuiState): NoesisTuiState => {
  if (!state.actionCursor) return state;
  const { actionCursor: _actionCursor, ...rest } = state;
  return { ...rest, expandedActionIds: NO_NAVIGATION_EXPANSIONS };
};

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
export function createHeaderView(
  colorEnabled: boolean,
  height: () => number,
  trueColorEnabled = false,
  note: string = NOESIS_STARTUP_NOTES[0],
): Component {
  return {
    invalidate() {},
    render: (width) => renderHeader(colorEnabled, width, height(), trueColorEnabled, note),
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

export function createInputLabelView(view: NoesisView, height: () => number): Component {
  return {
    invalidate() {},
    render(width) {
      if (height() < 6) return [];
      const notification = view.state.notification;
      const badge = notification ? notificationBadge(notification.tone) : undefined;
      return [
        ...(notification && badge
          ? safeTerminalText(notification.text)
              .split("\n")
              .map((line, index) =>
                elideText(
                  styled(
                    view.state.colorEnabled,
                    `${ANSI.bold}${badge.color}`,
                    `${index === 0 ? `${badge.glyph} ` : "  "}${line}`,
                  ),
                  Math.max(0, width),
                ),
              )
          : []),
        inputModeLine(view.state, Math.max(0, width)),
      ];
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

export function createSubagentsView(view: NoesisView, height: () => number): Component {
  return {
    invalidate() {},
    render(width) {
      return [...renderSubagents(view.state, Math.max(0, width), height())];
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
