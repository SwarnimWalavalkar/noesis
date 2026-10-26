import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { createConditionalObject } from "@noesis/domain";
import type { SubAgentSummary } from "@noesis/agent-types";
import {
  agentColor,
  agentDisplayName,
  agentElapsed,
  agentGlyph,
  agentOutcome,
  agentPulseDim,
} from "./agent-presentation.ts";
import { formatCount } from "./action-summary.ts";
import { renderRichText } from "./rich-text.ts";
import type { NoesisTuiState, TuiAgentViewState } from "./state.ts";
import { ANSI, elideText, safeTerminalText, styled } from "./theme.ts";
import { createTranscriptRenderer, type TranscriptRenderer } from "./transcript.ts";
import type { TuiTranscriptSlice } from "./transcript-slice.ts";
import { isWorkingExecution, WORKING_ANIMATION_INTERVAL_MS } from "./working-animation.ts";

/**
 * Rows below the transcript: a breathing row, the read-only agent line, a rule where the composer
 * would sit, the status line, and the key hints.
 */
const CHROME_ROWS = 5;
const SPEAKER_LABEL_MAX_COLUMNS = 24;

export interface RenderedAgentView {
  readonly rows: readonly string[];
  readonly maxScroll: number;
}

/** Time of day for today's agents; older retained agents also need their date. */
function startedLabel(createdAt: string): string {
  const started = new Date(createdAt);
  return started.toDateString() === new Date().toDateString()
    ? started.toLocaleTimeString()
    : started.toLocaleString();
}

const agentFrame = (clock: number): number => Math.floor(clock / WORKING_ANIMATION_INTERVAL_MS);

/** The opened agent's transcript as the same slice shape the session transcript renders. */
export function agentTranscriptSlice(
  state: NoesisTuiState,
  view: TuiAgentViewState,
  agent: SubAgentSummary | undefined,
): TuiTranscriptSlice {
  const assistant = (agent ? agentDisplayName(agent) : "agent").toUpperCase();
  return createConditionalObject({
    timeline: view.timeline,
    expandedActionIds: view.expandedActionIds,
    execution: view.execution,
    animationFrame: agentFrame(state.agentClock),
    colorEnabled: state.colorEnabled,
    subAgents: state.subAgents,
    subAgentPhases: state.subAgentPhases,
    agentClock: state.agentClock,
    speakerLabels: { user: "TASK", assistant: elideText(assistant, SPEAKER_LABEL_MAX_COLUMNS) },
  } as const)
    .addOptional(view.actionCursor ? { actionCursor: view.actionCursor } : undefined)
    .finish();
}

function headerLines(
  state: NoesisTuiState,
  view: TuiAgentViewState,
  agent: SubAgentSummary | undefined,
  width: number,
): readonly string[] {
  const color = state.colorEnabled;
  const rail = styled(color, ANSI.dim, "│ ");
  const railWidth = visibleWidth(rail);
  const route = agent ? `${agent.route.provider}/${agent.route.model} · ${agent.thinkingLevel}` : undefined;
  const lineage = [
    agent && agent.originSessionId !== state.trailId
      ? "subagent from an earlier session"
      : "subagent of this session",
    ...(route ? [route] : []),
    ...(agent?.createdAt ? [`started ${startedLabel(agent.createdAt)}`] : []),
  ].join(" · ");
  const prompt = view.systemPrompt;
  const promptLines = prompt
    ? view.systemPromptShown
      ? renderRichText(safeTerminalText(prompt), Math.max(1, width - railWidth), color)
      : []
    : [];
  const promptSummary = prompt
    ? `system prompt · ${formatCount(prompt.split("\n").length, "line")} · s ${view.systemPromptShown ? "hide" : "show"}`
    : view.status === "loading"
      ? "loading transcript…"
      : undefined;
  return [
    styled(color, `${ANSI.bold}${ANSI.magenta}`, "AGENT"),
    elideText(`${rail}${styled(color, ANSI.dim, lineage)}`, width),
    ...(promptSummary ? [elideText(`${rail}${styled(color, ANSI.dim, promptSummary)}`, width)] : []),
    ...promptLines.map((line) => elideText(`${rail}${line}`, width)),
  ];
}

/** Replaces the composer: says whose transcript this is and that it cannot be messaged. */
function agentLine(state: NoesisTuiState, agent: SubAgentSummary | undefined, width: number): string {
  const color = state.colorEnabled;
  const badge = styled(color, `${ANSI.bold}${ANSI.reverse}${ANSI.cyan}`, " ↳ SUBAGENT ");
  if (!agent)
    return elideText(`${badge}  ${styled(color, ANSI.dim, "this agent is no longer listed")}`, width);
  const outcome = agentOutcome(agent);
  const weight = agentPulseDim(outcome, state.agentClock) ? ANSI.dim : ANSI.bold;
  const glyph = styled(color, `${weight}${agentColor(outcome)}`, agentGlyph(outcome));
  const elapsed = agentElapsed(agent, state.agentClock);
  const status = [
    outcome === "stopped" ? (agent.latestTaskStatus ?? agent.status) : outcome,
    ...(elapsed ? [elapsed] : []),
  ];
  return elideText(
    `${badge}  ${glyph} ${styled(color, ANSI.bold, agentDisplayName(agent))}  ${styled(color, ANSI.dim, `${status.join(" · ")} · read-only`)}`,
    width,
  );
}

function statusLine(
  state: NoesisTuiState,
  view: TuiAgentViewState,
  agent: SubAgentSummary | undefined,
  width: number,
): string {
  const color = state.colorEnabled;
  const working = isWorkingExecution(view.execution);
  const executionLabel = working
    ? view.execution === "tool"
      ? "TOOL"
      : "WORKING"
    : view.status === "loading"
      ? "LOADING"
      : "IDLE";
  const executionColor = working ? ANSI.cyan : ANSI.green;
  const calls = view.timeline.filter((entry) => entry.kind === "action").length;
  const usage = view.contextUsage;
  const percent =
    usage && usage.contextWindow > 0
      ? `ctx ${String(Math.min(100, Math.round((usage.usedTokens / usage.contextWindow) * 100)))}%`
      : undefined;
  const fields = [
    ...(agent ? [`${agent.route.provider}/${agent.route.model}`, agent.thinkingLevel] : []),
    ...(percent ? [percent] : []),
    ...(view.totalTokens === undefined ? [] : [`${formatTokens(view.totalTokens)} tok`]),
    formatCount(calls, "call"),
  ];
  return elideText(
    `${styled(color, `${ANSI.bold}${executionColor}`, `● ${executionLabel}`)}${styled(color, ANSI.dim, ` · ${fields.join(" · ")}`)}`,
    width,
  );
}

const formatTokens = (tokens: number): string =>
  tokens < 1_000
    ? String(tokens)
    : tokens < 10_000
      ? `${(tokens / 1_000).toFixed(1)}k`
      : `${String(Math.round(tokens / 1_000))}k`;

export function agentViewHint(view: TuiAgentViewState): string {
  return view.actionCursor
    ? "↑/↓ move · space expand · enter open · esc stop selecting"
    : `↑/↓ select · pgup/pgdn scroll · ←/→ agents · s prompt · esc ${view.parents.length > 0 ? "back" : "close"}`;
}

const padTo = (line: string, width: number): string =>
  `${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`;

/**
 * A full-screen read-only view of one subagent. The transcript uses the session's renderer and
 * block styles; it follows live output unless the user scrolls or selects an action.
 */
export function renderAgentViewFrame(
  state: NoesisTuiState,
  width: number,
  height: number,
  renderer: TranscriptRenderer,
): RenderedAgentView {
  const view = state.agentView;
  const safeWidth = Math.max(0, Math.floor(width));
  if (!view || safeWidth < 8 || height < CHROME_ROWS + 1) return { rows: [], maxScroll: 0 };
  const agent = state.subAgents.find((candidate) => candidate.agentId === view.agentId);
  const inner = safeWidth > 2 ? safeWidth - 2 : safeWidth;
  const bodyRows = height - CHROME_ROWS;
  const slice = agentTranscriptSlice(state, view, agent);
  const header = headerLines(state, view, agent, inner);
  const transcript = renderer.render(slice, inner, Math.max(3, bodyRows - 2));
  const document = [...header, ...(transcript.length > 0 ? ["", ...transcript] : [])];
  let visible: readonly string[];
  let maxScroll = 0;
  if (view.actionCursor && document.length > bodyRows) {
    visible = renderer.renderWindow(slice, inner, bodyRows, Math.max(3, bodyRows - 2));
  } else {
    maxScroll = Math.max(0, document.length - bodyRows);
    const scroll = Math.min(view.scroll, maxScroll);
    visible = document.slice(Math.max(0, document.length - bodyRows - scroll), document.length - scroll);
  }
  const blank = Array.from({ length: Math.max(0, bodyRows - visible.length) }, () => "");
  const scrolled = view.scroll > 0 && !view.actionCursor;
  const hint = styled(
    state.colorEnabled,
    ANSI.dim,
    `${scrolled ? `${formatCount(Math.min(view.scroll, maxScroll), "row")} above live · ` : ""}${agentViewHint(view)}`,
  );
  const rows = [
    ...blank,
    ...visible,
    "",
    agentLine(state, agent, safeWidth),
    styled(state.colorEnabled, ANSI.dim, "─".repeat(safeWidth)),
    statusLine(state, view, agent, safeWidth),
    elideText(hint, safeWidth),
  ];
  return { rows: rows.map((line) => padTo(elideText(line, safeWidth), safeWidth)), maxScroll };
}

/**
 * Mounted as a full-screen overlay so opening an agent never rewrites the session transcript or
 * its terminal scrollback; closing it reveals the session exactly as it was.
 */
export function createAgentViewOverlay(
  read: () => NoesisTuiState,
  height: () => number,
  onBoundsMeasured: (maxScroll: number) => void,
): Component {
  const renderer = createTranscriptRenderer();
  return {
    invalidate() {},
    render(width) {
      const rendered = renderAgentViewFrame(read(), width, height(), renderer);
      onBoundsMeasured(rendered.maxScroll);
      return [...rendered.rows];
    },
  };
}
