import { createConditionalObject, type JsonValue } from "@noesis/domain";
import type { ContextSnapshot } from "@noesis/context";
import type { RuntimeAgentDefaults, RuntimeTranscriptEntry, TrailState } from "@noesis/runtime";
import { EXECUTE_ACTION_NAME, SUBAGENT_ACTION_NAME } from "./action-summary.ts";
import { appendReasoningDelta, reconcileReasoning } from "./reasoning-timeline.ts";
import type { TuiExecutionDetail, TuiInteractionSnapshot } from "./runtime-port.ts";
import { tuiTimelineFromRuntime } from "./timeline-adapter.ts";
export { tuiTimelineFromRuntime };
export type Pane = "trail" | "context" | "capabilities";
export interface TuiMessage {
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
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
export function interactionViewFromSnapshot(snapshot: TuiInteractionSnapshot): TuiInteractionView {
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return createConditionalObject({
    phase: snapshot.phase,
    queuePaused: snapshot.queuePaused,
  } as const)
    .addOptional(snapshot.active ? { active: { ...snapshot.active } } : undefined)
    .add({
      queuedInputs: snapshot.pending.map((input) => ({
        queueId: input.intentId,
        text: input.text,
        createdAt: input.createdAt,
        status: input.status,
      })),
    } as const)
    .finish();
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
      readonly text: string;
      readonly localSubmissionId?: string;
    }
  | {
      readonly type: "prompt-admitted";
      readonly localSubmissionId: string;
      readonly turnId: string;
    }
  | {
      readonly type: "prompt-rejected";
      readonly localSubmissionId: string;
    }
  | {
      readonly type: "steer-delivered";
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
/** Child activity remains inspectable through its subagent but does not become chat transcript noise. */
export function isSubAgentChildAction(action: TuiAgentAction, actions: readonly TuiAgentAction[]): boolean {
  let parentId = action.parentActionId;
  const visited = new Set<string>();
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = actions.find((candidate) => candidate.actionId === parentId);
    if (!parent) return false;
    if (parent.name === SUBAGENT_ACTION_NAME) return true;
    parentId = parent.parentActionId;
  }
  return false;
}
export function visibleTranscriptActions(
  timeline: readonly TuiTimelineEntry[],
): readonly TuiAgentActionEntry[] {
  const actions = timelineActions(timeline);
  return actions.filter((action) => !isSubAgentChildAction(action, actions));
}
/** The fixed surface always shows active agents and adds the run selected in transcript inspection. */
export function subAgentsForSurface(
  timeline: readonly TuiTimelineEntry[],
  actionCursor?: string,
): readonly TuiAgentActionEntry[] {
  const actions = timelineActions(timeline);
  const includedIds = new Set(
    actions
      .filter((action) => action.name === SUBAGENT_ACTION_NAME && action.status === "running")
      .map((action) => action.actionId),
  );
  let selected = actionCursor ? actions.find((action) => action.actionId === actionCursor) : undefined;
  const visited = new Set<string>();
  while (selected && !visited.has(selected.actionId)) {
    visited.add(selected.actionId);
    if (selected.name === EXECUTE_ACTION_NAME) {
      const byId = new Map(actions.map((action) => [action.actionId, action]));
      for (const action of actions) {
        if (action.name !== SUBAGENT_ACTION_NAME) continue;
        let parentId = action.parentActionId;
        const ancestry = new Set<string>();
        while (parentId && !ancestry.has(parentId)) {
          if (parentId === selected.actionId) {
            includedIds.add(action.actionId);
            break;
          }
          ancestry.add(parentId);
          parentId = byId.get(parentId)?.parentActionId;
        }
      }
      break;
    }
    const parentActionId = selected.parentActionId;
    selected = parentActionId ? actions.find((action) => action.actionId === parentActionId) : undefined;
  }
  return actions.filter((action) => includedIds.has(action.actionId));
}
function moveCursor(state: NoesisTuiState, direction: "previous" | "next"): NoesisTuiState {
  const actions = visibleTranscriptActions(state.timeline);
  if (actions.length === 0) return state;
  const currentIndex = actions.findIndex((action) => action.actionId === state.actionCursor);
  // Entering navigation with no cursor selects the most recent action, which is what the user
  // is almost always looking at when work has just finished.
  if (currentIndex < 0) {
    const last = actions.at(-1);
    return last ? { ...state, actionCursor: last.actionId } : state;
  }
  const nextIndex = Math.min(actions.length - 1, Math.max(0, currentIndex + (direction === "next" ? 1 : -1)));
  const next = actions[nextIndex];
  return next ? { ...state, actionCursor: next.actionId } : state;
}
function toggleExpansion(state: NoesisTuiState, actionId: string): NoesisTuiState {
  const expanded = new Set(state.expandedActionIds);
  if (expanded.has(actionId)) expanded.delete(actionId);
  else expanded.add(actionId);
  return { ...state, expandedActionIds: expanded };
}
export function reduceTui(state: NoesisTuiState, action: NoesisTuiAction): NoesisTuiState {
  switch (action.type) {
    case "trail-selected": {
      const {
        activeTool: _activeTool,
        actionCursor: _actionCursor,
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
        timeline: tuiTimelineFromRuntime(action.transcript),
        expandedActionIds: NO_EXPANDED_ACTIONS,
      };
    case "prompt-submitted": {
      const { error: _error, notification: _notification, ...rest } = state;
      const message = createConditionalObject({
        kind: "message",
        role: "user",
        text: action.text,
      } as const)
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
          return { ...message, turnId: action.turnId };
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
        timeline: [...state.timeline, { kind: "message", role: "user", text: action.text }],
      };
    case "stream-delta": {
      const timeline = [...state.timeline];
      const last = timeline.at(-1);
      if (last?.kind === "message" && last.role === "assistant") {
        timeline[timeline.length - 1] = {
          ...last,
          text: last.text + action.text,
        };
      } else {
        timeline.push({
          kind: "message",
          role: "assistant",
          text: action.text,
        });
      }
      return { ...state, execution: "streaming", timeline };
    }
    case "stream-reconciled": {
      const timeline = [...state.timeline];
      const last = timeline.at(-1);
      if (last?.kind === "message" && last.role === "assistant") {
        timeline[timeline.length - 1] = { ...last, text: action.text };
      } else {
        timeline.push({
          kind: "message",
          role: "assistant",
          text: action.text,
        });
      }
      return { ...state, timeline };
    }
    case "reasoning-delta": {
      return {
        ...state,
        execution: "thinking",
        timeline: appendReasoningDelta(state.timeline, action.text),
      };
    }
    case "reasoning-reconciled":
      return { ...state, timeline: reconcileReasoning(state.timeline, action.text) };
    case "action-started": {
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      const next: TuiAgentActionEntry = createConditionalObject({
        kind: "action",
        actionId: action.actionId,
      } as const)
        .addOptional(action.parentActionId ? { parentActionId: action.parentActionId } : undefined)
        .add({
          name: action.name,
          status: "running",
        } as const)
        .addOptional(!(action.input === undefined) ? { input: action.input } : undefined)
        .addOptional(!(action.at === undefined) ? { startedAt: action.at } : undefined)
        .finish();
      const existing = state.timeline.findIndex(
        (entry) => entry.kind === "action" && entry.actionId === action.actionId,
      );
      const timeline =
        existing < 0
          ? [...state.timeline, next]
          : state.timeline.map((entry, index) => (index === existing ? next : entry));
      return { ...state, execution: "tool", activeTool: action.name, timeline };
    }
    case "action-updated":
      return {
        ...state,
        timeline: state.timeline.map((entry) =>
          entry.kind === "action" && entry.actionId === action.actionId
            ? { ...entry, update: action.update }
            : entry,
        ),
      };
    case "action-ended": {
      const timeline = state.timeline.map((entry): TuiTimelineEntry => {
        if (entry.kind !== "action" || entry.actionId !== action.actionId) return entry;
        const durationMs =
          action.at !== undefined && entry.startedAt !== undefined
            ? Math.max(0, action.at - entry.startedAt)
            : undefined;
        // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
        return createConditionalObject({
          ...entry,
          status: action.isError ? "failed" : "completed",
        } as const)
          .addOptional(!(action.output === undefined) ? { output: action.output } : undefined)
          .addOptional(!(durationMs === undefined) ? { durationMs } : undefined)
          .finish();
      });
      const activeTool = [...timeline]
        .reverse()
        .find(
          (entry): entry is TuiAgentActionEntry => entry.kind === "action" && entry.status === "running",
        )?.name;
      const { activeTool: _activeTool, ...rest } = state;
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      return createConditionalObject({
        ...rest,
      } as const)
        .addOptional(activeTool ? { activeTool } : undefined)
        .add({
          timeline,
          execution: activeTool ? "tool" : "thinking",
        } as const)
        .finish();
    }
    case "action-expansion-toggled":
      return toggleExpansion(state, action.actionId);
    case "action-cursor-moved":
      return moveCursor(state, action.direction);
    case "action-cursor-cleared": {
      const { actionCursor: _actionCursor, ...rest } = state;
      return { ...rest, expandedActionIds: NO_EXPANDED_ACTIONS };
    }
    case "inspector-opened":
      return {
        ...state,
        actionCursor: action.actionId,
        inspector: {
          actionId: action.actionId,
          status: "loading",
          view: "semantic",
          scroll: 0,
        },
      };
    case "inspector-loaded": {
      // A slow inspector fetch must never replace a newer selection.
      if (state.inspector?.actionId !== action.actionId) return state;
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      return {
        ...state,
        inspector: createConditionalObject({
          actionId: action.actionId,
          status: action.detail ? "ready" : "fallback",
        } as const)
          .addOptional(action.detail ? { detail: action.detail } : undefined)
          .add({
            view: state.inspector.view,
            scroll: 0,
          } as const)
          .finish(),
      };
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
      const last = timeline.at(-1);
      if (last?.kind === "message" && last.role === "assistant" && !last.text) timeline.pop();
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
