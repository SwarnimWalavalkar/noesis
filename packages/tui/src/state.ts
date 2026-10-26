export { interactionViewFromSnapshot } from "./interaction-view.ts";
import { createConditionalObject, type JsonValue, type ComposerAttachment } from "@noesis/domain";
import type { ContextSnapshot } from "@noesis/context";
import type { AgentRuntimeEvent, SubAgentSummary } from "@noesis/agent-types";
import type { RuntimeAgentDefaults, RuntimeTranscriptEntry, TrailState } from "@noesis/runtime";
import { timelineEventForAgentEvent } from "./agent-event.ts";
import type { TuiExecutionDetail } from "./runtime-port.ts";
import { reduceSubAgentPhase, retainActiveSubAgentPhases } from "./subagent-presentation-state.ts";
import {
  lastContentEntryIndex,
  subAgentTimelineFromRuntime,
  tuiTimelineFromRuntime,
  tuiUserMessage,
  withLocalNotes,
} from "./timeline-adapter.ts";
import { numberField } from "./record-fields.ts";
import {
  mergeDurableTimeline,
  moveActionCursor,
  reduceTimeline,
  runningToolName,
  selectableActions,
  type TimelineEvent,
} from "./transcript-slice.ts";
export { tuiTimelineFromRuntime };
export type Pane = "trail" | "context" | "capabilities";
export type TuiAttachmentLabel = Pick<ComposerAttachment, "name" | "mimeType">;
export interface TuiMessage {
  readonly attachments?: readonly TuiAttachmentLabel[];
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  /** A collaboration reminder delivered to the model in the user role, not typed by the user. */
  readonly origin?: "collaboration";
  /** View-local identity used only until the runtime admits a submitted prompt. */
  readonly localSubmissionId?: string;
  readonly messageId?: string;
  readonly turnId?: string;
  readonly createdAt?: string;
}
export interface TuiAgentAction {
  readonly actionId: string;
  readonly turnId?: string;
  readonly parentActionId?: string;
  readonly executionId?: string;
  readonly name: string;
  readonly status: "running" | "completed" | "failed" | "denied" | "ambiguous" | "cancelled" | "interrupted";
  readonly input?: JsonValue;
  readonly update?: JsonValue;
  readonly output?: JsonValue;
  readonly startedAt?: number;
  readonly durationMs?: number;
}
export interface TuiMessageEntry extends TuiMessage {
  readonly kind: "message";
}
export interface TuiAgentActionEntry extends TuiAgentAction {
  readonly kind: "action";
}
export interface TuiReasoningEntry {
  readonly kind: "reasoning";
  readonly text: string;
  readonly reasoningId?: string;
  readonly turnId?: string;
  readonly createdAt?: string;
}
export type TuiTimelineEntry = TuiMessageEntry | TuiReasoningEntry | TuiAgentActionEntry;
export function isTuiMessageEntry(entry: TuiTimelineEntry): entry is TuiMessageEntry {
  return entry.kind === "message";
}
export function isTuiAgentActionEntry(entry: TuiTimelineEntry): entry is TuiAgentActionEntry {
  return entry.kind === "action";
}
export type ExecutionState =
  | "idle"
  | "thinking"
  | "streaming"
  | "tool"
  | "compacting"
  | "aborting"
  | "closing"
  | "error";
export function executionForInteractionPhase(
  current: ExecutionState,
  phase: TuiInteractionView["phase"],
): ExecutionState | undefined {
  if (phase === "interrupting") return "aborting";
  if (phase === "idle" && current !== "error" && current !== "compacting" && current !== "closing")
    return "idle";
  if (phase === "running" && (current === "idle" || current === "aborting")) return "thinking";
  return undefined;
}
export interface TuiContextUsage {
  readonly usedTokens: number;
  readonly contextWindow: number;
  readonly accuracy: "reported" | "estimated";
}
export interface TuiQueuedInput {
  readonly attachments?: readonly ComposerAttachment[];
  readonly queueId: string;
  readonly text: string;
  readonly createdAt: string;
  readonly status?: "pending" | "held" | "dispatching";
}
export interface TuiInteractionView {
  readonly phase: "idle" | "running" | "interrupting";
  readonly queuePaused: boolean;
  readonly active?: {
    readonly intentId: string;
    readonly turnId: string;
    readonly text: string;
  };
  readonly queuedInputs: readonly TuiQueuedInput[];
}
/** Overlay state for the run inspector opened from a transcript action. */
export interface TuiInspectorState {
  readonly actionId: string;
  /** `fallback` means no durable execution record resolved and the in-memory action is shown. */
  readonly status: "loading" | "ready" | "fallback";
  readonly detail?: TuiExecutionDetail;
  readonly view: "semantic" | "raw";
  readonly scroll: number;
}
/** The part of an agent view the user moved through, restored when they return to it. */
export type TuiAgentViewNavigation = Pick<
  TuiAgentViewState,
  "actionCursor" | "expandedActionIds" | "scroll" | "scrollAnchor"
>;
/** Rows a scrolled-back agent view sits above the newest output, including output since it scrolled. */
export function effectiveAgentScroll(view: TuiAgentViewState, documentRows: number): number {
  if (view.scroll <= 0) return 0;
  return view.scroll + Math.max(0, documentRows - (view.scrollAnchor ?? documentRows));
}
/** Collapsed or expanded presentation of the running-agent strip above the composer. */
export interface TuiAgentStripState {
  readonly expanded: boolean;
  /** While the strip has focus, list retained agents from every session instead of this one. */
  readonly allSessions: boolean;
}
/**
 * A read-only subagent transcript opened over the session. It is a disposable projection of the
 * runtime's durable child transcript plus live events; it is dropped when the view closes.
 */
export interface TuiAgentViewState {
  readonly agentId: string;
  /** Agents opened before this one through nested cards; Esc returns to the newest. */
  readonly parents: readonly string[];
  readonly status: "loading" | "ready";
  readonly timeline: readonly TuiTimelineEntry[];
  readonly expandedActionIds: ReadonlySet<string>;
  readonly actionCursor?: string;
  readonly execution: ExecutionState;
  /** Rows scrolled back from the newest content; zero follows live output. */
  readonly scroll: number;
  /** Document rows when `scroll` was set; later output deepens the offset so the view holds still. */
  readonly scrollAnchor?: number;
  readonly systemPrompt?: string;
  readonly systemPromptShown: boolean;
  /** Why the agent's latest task failed, as recorded by the runtime. */
  readonly taskError?: string;
  readonly totalTokens?: number;
  readonly contextUsage?: TuiContextUsage;
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
  readonly timeline: readonly TuiTimelineEntry[];
  /** Actions whose full payload is rendered inline. Empty by default; codemode payloads are large. */
  readonly expandedActionIds: ReadonlySet<string>;
  /** Set while the transcript is navigable by keyboard; undefined means the editor owns input. */
  readonly actionCursor?: string;
  /** Selected row of the agent strip while navigation owns input. */
  readonly subAgentCursor?: string;
  readonly subAgents: readonly SubAgentSummary[];
  /** Ephemeral live phase text; durable actor/task state remains authoritative in the runtime. */
  readonly subAgentPhases: Readonly<Record<string, string>>;
  /** View-local wall clock for agent elapsed time and pulse; zero until the first tick. */
  readonly agentClock: number;
  readonly agentStrip: TuiAgentStripState;
  readonly agentView?: TuiAgentViewState;
  readonly inspector?: TuiInspectorState;
  readonly context?: ContextSnapshot;
  readonly contextUsage?: TuiContextUsage;
  readonly interaction: TuiInteractionView;
  readonly turnCount: number;
  readonly capabilityVersions: Readonly<Record<string, number>>;
  readonly colorEnabled: boolean;
  readonly activeTool?: string;
  readonly error?: string;
  readonly notification?: Readonly<{
    readonly text: string;
    readonly tone: "info" | "success" | "attention" | "learning";
  }>;
  readonly animationFrame: number;
}
export type NoesisTuiAction =
  | {
      readonly type: "trail-selected";
      readonly trail: TrailState;
    }
  | {
      readonly type: "transcript-hydrated";
      readonly trailId: string;
      readonly transcript: readonly RuntimeTranscriptEntry[];
    }
  | {
      readonly type: "prompt-submitted";
      readonly attachments?: readonly TuiAttachmentLabel[];
      readonly text: string;
      readonly localSubmissionId?: string;
    }
  | {
      readonly type: "prompt-admitted";
      readonly attachments?: readonly ComposerAttachment[];
      readonly localSubmissionId: string;
      readonly turnId: string;
    }
  | {
      readonly type: "prompt-rejected";
      readonly localSubmissionId: string;
    }
  | {
      readonly type: "steer-delivered";
      readonly attachments?: readonly ComposerAttachment[];
      readonly text: string;
    }
  | {
      readonly type: "collaboration-delivered";
      readonly text: string;
    }
  | {
      readonly type: "stream-delta";
      readonly text: string;
    }
  | {
      readonly type: "stream-reconciled";
      readonly text: string;
    }
  | {
      readonly type: "reasoning-delta";
      readonly text: string;
    }
  | {
      readonly type: "reasoning-reconciled";
      readonly text: string;
    }
  | {
      readonly type: "action-started";
      readonly actionId: string;
      readonly parentActionId?: string;
      readonly name: string;
      readonly input?: JsonValue;
      readonly at?: number;
    }
  | {
      readonly type: "action-updated";
      readonly actionId: string;
      readonly update: JsonValue;
    }
  | {
      readonly type: "action-ended";
      readonly actionId: string;
      readonly output?: JsonValue;
      readonly isError: boolean;
      readonly at?: number;
    }
  | {
      readonly type: "action-expansion-toggled";
      readonly actionId: string;
    }
  | {
      readonly type: "action-cursor-moved";
      readonly direction: "previous" | "next";
    }
  | {
      readonly type: "action-cursor-cleared";
    }
  | {
      readonly type: "subagents-hydrated";
      readonly subAgents: readonly SubAgentSummary[];
    }
  | {
      /** Ctrl+O: focus the agent strip while agents run, otherwise the newest transcript action. */
      readonly type: "navigation-entered";
    }
  | {
      /** Spatial movement: transcript actions sit above the strip, which sits above the composer. */
      readonly type: "navigation-moved";
      readonly direction: "previous" | "next";
    }
  | {
      readonly type: "agent-strip-toggled";
    }
  | {
      readonly type: "agent-strip-scope-toggled";
    }
  | {
      readonly type: "agents-ticked";
      readonly now: number;
    }
  | {
      readonly type: "agent-view-opened";
      readonly agentId: string;
      readonly parents: readonly string[];
      /** Where the user was in this agent's view when they opened a nested agent from it. */
      readonly navigation?: TuiAgentViewNavigation;
    }
  | {
      readonly type: "agent-view-hydrated";
      readonly agentId: string;
      readonly transcript: readonly RuntimeTranscriptEntry[];
      readonly systemPrompt?: string;
      readonly taskError?: string;
    }
  | {
      readonly type: "agent-view-closed";
    }
  | {
      readonly type: "agent-view-cursor-moved";
      readonly direction: "previous" | "next";
    }
  | {
      readonly type: "agent-view-cursor-cleared";
    }
  | {
      readonly type: "agent-view-scrolled";
      readonly delta: number;
      readonly maxScroll: number;
      /** Rendered document rows, which anchor a scrolled-back position against new output. */
      readonly documentRows: number;
    }
  | {
      readonly type: "agent-view-expansion-toggled";
    }
  | {
      readonly type: "agent-view-system-prompt-toggled";
    }
  | {
      readonly type: "inspector-opened";
      readonly actionId: string;
    }
  | {
      readonly type: "inspector-loaded";
      readonly actionId: string;
      readonly detail?: TuiExecutionDetail;
    }
  | {
      readonly type: "inspector-scrolled";
      readonly delta: number;
      readonly maxScroll: number;
    }
  | {
      readonly type: "inspector-view-toggled";
    }
  | {
      readonly type: "inspector-closed";
    }
  | {
      readonly type: "subagent-live-event";
      readonly agentId: string;
      readonly event: AgentRuntimeEvent;
      readonly at?: number;
    }
  | {
      readonly type: "execution-changed";
      readonly execution: ExecutionState;
    }
  | {
      readonly type: "animation-tick";
    }
  | {
      readonly type: "reasoning-level-changed";
      readonly reasoningLevel: RuntimeAgentDefaults["thinkingLevel"];
    }
  | {
      readonly type: "model-metadata";
      readonly provider: string;
      readonly model: string;
      readonly contextWindow: number;
    }
  | ({
      readonly type: "usage-updated";
    } & TuiContextUsage)
  | {
      readonly type: "interaction-changed";
      readonly interaction: TuiInteractionView;
    }
  | {
      readonly type: "turn-completed";
      readonly context: ContextSnapshot;
      readonly capabilityVersions: Readonly<Record<string, number>>;
      readonly turnCount: number;
      readonly contextUsage?: TuiContextUsage;
    }
  | {
      readonly type: "turn-aborted";
    }
  | {
      readonly type: "compacted";
    }
  | {
      readonly type: "pane-selected";
      readonly pane: Pane;
    }
  | {
      readonly type: "failed";
      readonly error: string;
    }
  | {
      readonly type: "notification-shown";
      readonly text: string;
      readonly tone: "info" | "success" | "attention" | "learning";
    }
  | {
      readonly type: "notification-cleared";
    }
  | {
      readonly type: "system-message";
      readonly text: string;
    };
const NO_EXPANDED_ACTIONS: ReadonlySet<string> = new Set<string>();
const NO_AGENT_STRIP: TuiAgentStripState = Object.freeze({ expanded: false, allSessions: false });
const EMPTY_INTERACTION: TuiInteractionView = Object.freeze({
  phase: "idle",
  queuePaused: false,
  queuedInputs: Object.freeze([]),
});
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
  provider: options.provider ?? "openai-codex",
  model: options.model ?? "gpt-5.6-sol",
  reasoningLevel: options.reasoningLevel ?? "high",
  runtime,
  pane: "trail",
  timeline: [],
  subAgents: [],
  subAgentPhases: {},
  agentClock: 0,
  agentStrip: NO_AGENT_STRIP,
  expandedActionIds: NO_EXPANDED_ACTIONS,
  interaction: EMPTY_INTERACTION,
  turnCount: 0,
  capabilityVersions: {},
  colorEnabled: options.colorEnabled ?? false,
  animationFrame: 0,
});
export function timelineActions(timeline: readonly TuiTimelineEntry[]): readonly TuiAgentActionEntry[] {
  return timeline.filter((entry): entry is TuiAgentActionEntry => entry.kind === "action");
}
/** Nested calls a codemode `execute` action spawned, in timeline order. */
export function childActions(
  actions: readonly TuiAgentAction[],
  actionId: string,
): readonly TuiAgentAction[] {
  return actions.filter((action) => action.parentActionId === actionId);
}
export function visibleTranscriptActions(
  timeline: readonly TuiTimelineEntry[],
): readonly TuiAgentActionEntry[] {
  return timelineActions(timeline);
}
export const isActiveSubAgent = (agent: Pick<SubAgentSummary, "status">): boolean =>
  agent.status === "starting" || agent.status === "running";
export function hasSessionSubagents(state: NoesisTuiState): boolean {
  return (
    state.trailId !== undefined && state.subAgents.some((agent) => agent.originSessionId === state.trailId)
  );
}
const newestFirst = (agents: readonly SubAgentSummary[]): readonly SubAgentSummary[] =>
  agents.toSorted((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
/**
 * Whether an agent belongs to the current session: started by it, or by one of its agents.
 * Retained records from earlier sessions and processes are history, reached on request.
 */
export function isSessionAgent(state: NoesisTuiState, agent: SubAgentSummary): boolean {
  if (state.trailId === undefined) return false;
  const visited = new Set<string>();
  let current: SubAgentSummary | undefined = agent;
  while (current && !visited.has(current.agentId)) {
    if (current.originSessionId === state.trailId) return true;
    visited.add(current.agentId);
    const parentId: string | undefined = current.parentAgentId;
    current = parentId ? state.subAgents.find((candidate) => candidate.agentId === parentId) : undefined;
  }
  return false;
}
/**
 * Rows of the agent strip. Unfocused, it lists running agents from any session. With focus, or
 * when pinned open, it adds this session's finished agents, or every retained agent when the user
 * widens the scope.
 */
export function stripAgents(state: NoesisTuiState): readonly SubAgentSummary[] {
  const running = state.subAgents.filter(isActiveSubAgent);
  // A pinned strip keeps this session's finished agents after navigation leaves it.
  if (state.subAgentCursor === undefined && !state.agentStrip.expanded) return running;
  const finished = newestFirst(
    state.subAgents.filter(
      (agent) => !isActiveSubAgent(agent) && (state.agentStrip.allSessions || isSessionAgent(state, agent)),
    ),
  );
  const rows = [...running, ...finished];
  // A row selected before the scope narrowed stays visible until the cursor moves off it.
  const selected = rows.some((agent) => agent.agentId === state.subAgentCursor)
    ? undefined
    : state.subAgents.find((agent) => agent.agentId === state.subAgentCursor);
  return selected ? [...rows, selected] : rows;
}
/**
 * Agents that Left/Right cycle through from an opened agent: those started by the same requester,
 * running first, then finished ones newest first.
 */
export function siblingAgents(state: NoesisTuiState, agentId: string): readonly SubAgentSummary[] {
  const current = state.subAgents.find((agent) => agent.agentId === agentId);
  if (!current) return [];
  const family = state.subAgents.filter(
    (agent) =>
      agent.originSessionId === current.originSessionId && agent.parentAgentId === current.parentAgentId,
  );
  return [
    ...family.filter(isActiveSubAgent),
    ...newestFirst(family.filter((agent) => !isActiveSubAgent(agent))),
  ];
}
function focusStrip(state: NoesisTuiState, agentId: string): NoesisTuiState {
  const { actionCursor: _actionCursor, ...rest } = state;
  return { ...rest, subAgentCursor: agentId };
}
function focusTranscript(state: NoesisTuiState, actionId: string): NoesisTuiState {
  const { subAgentCursor: _subAgentCursor, ...rest } = state;
  return { ...rest, actionCursor: actionId, agentStrip: { ...state.agentStrip, allSessions: false } };
}
/** First strip row a focus move would land on: a running agent, else this session's newest. */
function firstFocusableAgent(state: NoesisTuiState): string | undefined {
  const running = state.subAgents.find(isActiveSubAgent);
  if (running) return running.agentId;
  return newestFirst(state.subAgents.filter((agent) => isSessionAgent(state, agent)))[0]?.agentId;
}
function enterNavigation(state: NoesisTuiState): NoesisTuiState {
  const running = state.subAgents.find(isActiveSubAgent);
  if (running) return focusStrip(state, running.agentId);
  const action = moveActionCursor(state.timeline, undefined, "previous");
  if (action) return focusTranscript(state, action);
  const agent = firstFocusableAgent(state);
  return agent ? focusStrip(state, agent) : state;
}
function moveNavigation(state: NoesisTuiState, direction: "previous" | "next"): NoesisTuiState {
  if (state.subAgentCursor !== undefined) {
    const rows = stripAgents(state);
    const index = rows.findIndex((agent) => agent.agentId === state.subAgentCursor);
    if (direction === "previous" && index <= 0) {
      const action = moveActionCursor(state.timeline, undefined, "previous");
      return action ? focusTranscript(state, action) : state;
    }
    const next = rows[Math.min(rows.length - 1, Math.max(0, index + (direction === "next" ? 1 : -1)))];
    return next ? { ...state, subAgentCursor: next.agentId } : state;
  }
  const atLast = selectableActions(state.timeline).at(-1)?.actionId === state.actionCursor;
  if (direction === "next" && atLast) {
    const agent = firstFocusableAgent(state);
    if (agent) return focusStrip(state, agent);
  }
  const action = moveActionCursor(state.timeline, state.actionCursor, direction);
  return action ? { ...state, actionCursor: action } : state;
}
function toggleExpansion(state: NoesisTuiState, actionId: string): NoesisTuiState {
  const expanded = new Set(state.expandedActionIds);
  if (expanded.has(actionId)) expanded.delete(actionId);
  else expanded.add(actionId);
  return { ...state, expandedActionIds: expanded };
}
function toggled(set: ReadonlySet<string>, value: string): ReadonlySet<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}
/** Model rounds are runtime bookkeeping rather than transcript content; only their usage is kept. */
const sumTokens = (transcript: readonly RuntimeTranscriptEntry[]): number | undefined => {
  let total: number | undefined;
  for (const entry of transcript) {
    if (entry.kind !== "action" || entry.name !== "model.round") continue;
    const tokens = numberField(entry.output, "totalTokens");
    if (tokens !== undefined) total = (total ?? 0) + tokens;
  }
  return total;
};
function reduceAgentView(
  view: TuiAgentViewState,
  event: AgentRuntimeEvent,
  at: number | undefined,
): TuiAgentViewState {
  if (event.type === "usage")
    return {
      ...view,
      contextUsage: {
        usedTokens: event.usedTokens,
        contextWindow: event.contextWindow,
        accuracy: event.accuracy,
      },
    };
  if (event.type === "status")
    return event.status === "started" ? { ...view, execution: "thinking" } : { ...view, execution: "idle" };
  const timelineEvent: TimelineEvent | undefined = timelineEventForAgentEvent(event, at);
  if (!timelineEvent) return view;
  const next = reduceTimeline(view, timelineEvent);
  return { ...view, timeline: next.timeline, execution: next.execution };
}
export function reduceTui(state: NoesisTuiState, action: NoesisTuiAction): NoesisTuiState {
  switch (action.type) {
    case "trail-selected": {
      const {
        activeTool: _activeTool,
        actionCursor: _actionCursor,
        subAgentCursor: _subAgentCursor,
        agentView: _agentView,
        context: _context,
        contextUsage: _contextUsage,
        error: _error,
        notification: _notification,
        inspector: _inspector,
        ...rest
      } = state;
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      return createConditionalObject({
        ...rest,
        trailId: action.trail.trailId,
        title: action.trail.title,
        provider: action.trail.provider,
        model: action.trail.model,
        reasoningLevel: action.trail.thinkingLevel,
        timeline: [],
      } as const)
        .addOptional(action.trail.context ? { context: action.trail.context } : undefined)
        .add({
          capabilityVersions: { ...action.trail.capabilityVersions },
          expandedActionIds: NO_EXPANDED_ACTIONS,
          interaction: EMPTY_INTERACTION,
          turnCount: action.trail.turns.length,
          execution: "idle",
          animationFrame: 0,
        } as const)
        .finish();
    }
    case "transcript-hydrated":
      if (state.trailId !== action.trailId) return state;
      return {
        ...state,
        timeline: withLocalNotes(tuiTimelineFromRuntime(action.transcript), state.timeline),
        expandedActionIds: NO_EXPANDED_ACTIONS,
      };
    case "prompt-submitted": {
      const { error: _error, notification: _notification, ...rest } = state;
      const message = createConditionalObject({
        kind: "message",
        role: "user",
        text: action.text,
      } as const)
        .addOptional(action.attachments ? { attachments: action.attachments } : undefined)
        .addOptional(action.localSubmissionId ? { localSubmissionId: action.localSubmissionId } : undefined)
        .finish();
      return {
        ...rest,
        execution: "thinking",
        animationFrame: 0,
        timeline: [...state.timeline, message],
      };
    }
    case "prompt-admitted":
      return {
        ...state,
        timeline: state.timeline.map((entry) => {
          if (entry.kind !== "message" || entry.localSubmissionId !== action.localSubmissionId) return entry;
          const { localSubmissionId: _localSubmissionId, ...message } = entry;
          return createConditionalObject({ ...message, turnId: action.turnId })
            .addOptional(action.attachments ? { attachments: action.attachments } : undefined)
            .finish();
        }),
      };
    case "prompt-rejected":
      return {
        ...state,
        timeline: state.timeline.filter(
          (entry) => entry.kind !== "message" || entry.localSubmissionId !== action.localSubmissionId,
        ),
      };
    case "steer-delivered":
      return {
        ...state,
        timeline: [...state.timeline, tuiUserMessage(action.text, action.attachments)],
      };
    case "collaboration-delivered":
      return {
        ...state,
        timeline: [
          ...state.timeline,
          { kind: "message", role: "user", origin: "collaboration", text: action.text },
        ],
      };
    case "stream-delta":
    case "stream-reconciled":
    case "reasoning-delta":
    case "reasoning-reconciled":
    case "action-updated": {
      const next = reduceTimeline(state, action);
      return { ...state, timeline: next.timeline, execution: next.execution };
    }
    case "action-started": {
      const next = reduceTimeline(state, action);
      return { ...state, timeline: next.timeline, execution: next.execution, activeTool: action.name };
    }
    case "action-ended": {
      const next = reduceTimeline(state, action);
      const activeTool = runningToolName(next.timeline);
      const { activeTool: _activeTool, ...rest } = state;
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      return createConditionalObject({ ...rest } as const)
        .addOptional(activeTool ? { activeTool } : undefined)
        .add({ timeline: next.timeline, execution: next.execution } as const)
        .finish();
    }
    case "action-expansion-toggled":
      return toggleExpansion(state, action.actionId);
    case "action-cursor-moved": {
      const { subAgentCursor: _subAgentCursor, ...rest } = state;
      const actionCursor = moveActionCursor(rest.timeline, rest.actionCursor, action.direction);
      return actionCursor ? { ...rest, actionCursor } : rest;
    }
    case "navigation-entered":
      return enterNavigation(state);
    case "navigation-moved":
      return moveNavigation(state, action.direction);
    case "agent-strip-toggled":
      return { ...state, agentStrip: { ...state.agentStrip, expanded: !state.agentStrip.expanded } };
    case "agent-strip-scope-toggled":
      return { ...state, agentStrip: { ...state.agentStrip, allSessions: !state.agentStrip.allSessions } };
    case "agents-ticked":
      return { ...state, agentClock: action.now };
    case "subagents-hydrated": {
      const subAgents = Object.freeze([...action.subAgents]);
      const subAgentPhases = retainActiveSubAgentPhases(action.subAgents, state.subAgentPhases);
      const cursorStillExists = action.subAgents.some((agent) => agent.agentId === state.subAgentCursor);
      const settledView =
        state.agentView &&
        !action.subAgents.some(
          (agent) => agent.agentId === state.agentView?.agentId && isActiveSubAgent(agent),
        )
          ? { ...state.agentView, execution: "idle" as const }
          : state.agentView;
      const next = createConditionalObject({ ...state, subAgents, subAgentPhases })
        .addOptional(settledView ? { agentView: settledView } : undefined)
        .finish();
      if (cursorStillExists || state.subAgentCursor === undefined) return next;
      const { subAgentCursor: _subAgentCursor, ...rest } = next;
      return rest;
    }
    case "action-cursor-cleared": {
      const { actionCursor: _actionCursor, subAgentCursor: _subAgentCursor, ...rest } = state;
      return {
        ...rest,
        expandedActionIds: NO_EXPANDED_ACTIONS,
        agentStrip: { ...state.agentStrip, allSessions: false },
      };
    }
    case "agent-view-opened": {
      const summary = state.subAgents.find((agent) => agent.agentId === action.agentId);
      // The session's navigation cursor is kept so closing the view returns to the same row, and a
      // parent agent's own position comes back when the user returns from a nested agent.
      const navigation = action.navigation;
      return {
        ...state,
        agentView: createConditionalObject({
          agentId: action.agentId,
          parents: Object.freeze([...action.parents]),
          status: "loading",
          timeline: [],
          expandedActionIds: navigation?.expandedActionIds ?? NO_EXPANDED_ACTIONS,
          execution: summary && isActiveSubAgent(summary) ? "thinking" : "idle",
          scroll: navigation?.scroll ?? 0,
          systemPromptShown: false,
        } as const)
          .addOptional(navigation?.actionCursor ? { actionCursor: navigation.actionCursor } : undefined)
          .addOptional(
            navigation?.scrollAnchor === undefined ? undefined : { scrollAnchor: navigation.scrollAnchor },
          )
          .finish(),
      };
    }
    case "agent-view-hydrated": {
      const view = state.agentView;
      if (view?.agentId !== action.agentId) return state;
      const totalTokens = sumTokens(action.transcript);
      // Each snapshot describes the latest task, so an earlier failure never outlives a later success.
      const { taskError: _taskError, ...current } = view;
      const hydrated = createConditionalObject({
        ...current,
        status: "ready",
        timeline: mergeDurableTimeline(
          subAgentTimelineFromRuntime(action.transcript, action.agentId),
          view.timeline,
        ),
      } as const)
        .addOptional(action.systemPrompt === undefined ? undefined : { systemPrompt: action.systemPrompt })
        .addOptional(action.taskError === undefined ? undefined : { taskError: action.taskError })
        .addOptional(totalTokens === undefined ? undefined : { totalTokens })
        .finish();
      return { ...state, agentView: hydrated };
    }
    case "agent-view-closed": {
      const { agentView: _agentView, ...rest } = state;
      return rest;
    }
    case "agent-view-cursor-moved": {
      const view = state.agentView;
      if (!view) return state;
      const actionCursor = moveActionCursor(view.timeline, view.actionCursor, action.direction);
      return actionCursor ? { ...state, agentView: { ...view, actionCursor, scroll: 0 } } : state;
    }
    case "agent-view-cursor-cleared": {
      const view = state.agentView;
      if (!view) return state;
      const { actionCursor: _actionCursor, ...rest } = view;
      return { ...state, agentView: { ...rest, expandedActionIds: NO_EXPANDED_ACTIONS } };
    }
    case "agent-view-scrolled": {
      const view = state.agentView;
      if (!view) return state;
      const current = effectiveAgentScroll(view, action.documentRows);
      const scroll = Math.min(Math.max(0, action.maxScroll), Math.max(0, current + action.delta));
      const { actionCursor: _actionCursor, scrollAnchor: _scrollAnchor, ...rest } = view;
      return {
        ...state,
        agentView: scroll > 0 ? { ...rest, scroll, scrollAnchor: action.documentRows } : { ...rest, scroll },
      };
    }
    case "agent-view-expansion-toggled": {
      const view = state.agentView;
      if (!view?.actionCursor) return state;
      return {
        ...state,
        agentView: { ...view, expandedActionIds: toggled(view.expandedActionIds, view.actionCursor) },
      };
    }
    case "agent-view-system-prompt-toggled": {
      const view = state.agentView;
      if (!view) return state;
      return { ...state, agentView: { ...view, systemPromptShown: !view.systemPromptShown } };
    }
    case "inspector-opened": {
      const inspector = {
        actionId: action.actionId,
        status: "loading",
        view: "semantic",
        scroll: 0,
      } as const;
      return state.agentView
        ? { ...state, inspector }
        : { ...state, inspector, actionCursor: action.actionId };
    }
    case "inspector-loaded": {
      // A slow inspector fetch must never replace a newer selection.
      if (state.inspector?.actionId !== action.actionId) return state;
      const inspector = createConditionalObject({
        actionId: action.actionId,
        status: action.detail ? "ready" : "fallback",
      } as const)
        .addOptional(action.detail ? { detail: action.detail } : undefined)
        .add({ view: state.inspector.view, scroll: 0 } as const)
        .finish();
      return { ...state, inspector };
    }
    case "inspector-scrolled": {
      if (!state.inspector) return state;
      return {
        ...state,
        inspector: {
          ...state.inspector,
          scroll: Math.min(Math.max(0, action.maxScroll), Math.max(0, state.inspector.scroll + action.delta)),
        },
      };
    }
    case "inspector-view-toggled": {
      if (!state.inspector) return state;
      return {
        ...state,
        inspector: {
          ...state.inspector,
          view: state.inspector.view === "semantic" ? "raw" : "semantic",
          scroll: 0,
        },
      };
    }
    case "inspector-closed": {
      const { inspector: _inspector, ...rest } = state;
      return rest;
    }
    case "subagent-live-event": {
      const subAgentPhases = reduceSubAgentPhase(state.subAgentPhases, action.agentId, action.event);
      const view = state.agentView;
      if (view?.agentId !== action.agentId) return { ...state, subAgentPhases };
      return { ...state, subAgentPhases, agentView: reduceAgentView(view, action.event, action.at) };
    }
    case "execution-changed": {
      const { activeTool: _activeTool, ...rest } = state;
      return {
        ...rest,
        execution: action.execution,
        animationFrame:
          action.execution === "idle" || action.execution === "error" || action.execution === "closing"
            ? 0
            : state.animationFrame,
      };
    }
    case "animation-tick":
      return state.execution === "idle" || state.execution === "error"
        ? state
        : { ...state, animationFrame: state.animationFrame + 1 };
    case "reasoning-level-changed":
      return { ...state, reasoningLevel: action.reasoningLevel };
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
    case "interaction-changed":
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      return {
        ...state,
        interaction: createConditionalObject({
          phase: action.interaction.phase,
          queuePaused: action.interaction.queuePaused,
        } as const)
          .addOptional(action.interaction.active ? { active: { ...action.interaction.active } } : undefined)
          .add({
            queuedInputs: [...action.interaction.queuedInputs],
          } as const)
          .finish(),
      };
    case "turn-completed": {
      const { contextUsage: _contextUsage, ...rest } = state;
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      return createConditionalObject({
        ...rest,
        execution: "idle",
        animationFrame: 0,
        context: action.context,
        turnCount: action.turnCount,
      } as const)
        .addOptional(action.contextUsage ? { contextUsage: action.contextUsage } : undefined)
        .add({
          capabilityVersions: { ...action.capabilityVersions },
        } as const)
        .finish();
    }
    case "turn-aborted": {
      const timeline = [...state.timeline];
      const index = lastContentEntryIndex(timeline);
      const last = timeline[index];
      if (last?.kind === "message" && last.role === "assistant" && !last.text) timeline.splice(index, 1);
      return { ...state, execution: "idle", animationFrame: 0, timeline };
    }
    case "compacted": {
      const { contextUsage: _contextUsage, ...rest } = state;
      return { ...rest, execution: "idle", animationFrame: 0 };
    }
    case "pane-selected":
      return { ...state, pane: action.pane };
    case "failed":
      return { ...state, execution: "error", animationFrame: 0, error: action.error };
    case "notification-shown":
      return { ...state, notification: Object.freeze({ text: action.text, tone: action.tone }) };
    case "notification-cleared": {
      const { notification: _notification, ...rest } = state;
      return rest;
    }
    case "system-message":
      return {
        ...state,
        timeline: [...state.timeline, { kind: "message", role: "system", text: action.text }],
      };
  }
}
