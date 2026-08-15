import type { ContextSnapshot } from "@noesis/context";
import type {
  RuntimeAgentDefaults,
  RuntimeTranscriptAction,
  RuntimeTranscriptEntry,
  TrailState,
} from "@noesis/runtime";
import type { TuiExecutionDetail, TuiInteractionSnapshot } from "./runtime-port.ts";

export type Pane = "trail" | "context" | "capabilities";

export interface TuiMessage {
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
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
  readonly input?: unknown;
  readonly update?: unknown;
  readonly output?: unknown;
  readonly startedAt?: number;
  readonly durationMs?: number;
}

export interface TuiMessageEntry extends TuiMessage {
  readonly kind: "message";
}

export interface TuiAgentActionEntry extends TuiAgentAction {
  readonly kind: "action";
}

export type TuiTimelineEntry = TuiMessageEntry | TuiAgentActionEntry;

function parsedTimestamp(timestamp: string): number | undefined {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function actionDuration(action: RuntimeTranscriptAction): number | undefined {
  if (!action.completedAt) return undefined;
  const startedAt = parsedTimestamp(action.startedAt);
  const completedAt = parsedTimestamp(action.completedAt);
  if (startedAt === undefined || completedAt === undefined) return undefined;
  return Math.max(0, completedAt - startedAt);
}

/**
 * The runtime owns transcript ordering and durable payloads. This adapter only converts their
 * representation into the same immutable entry shape used by live TUI events.
 */
export function tuiTimelineFromRuntime(
  transcript: readonly RuntimeTranscriptEntry[],
): readonly TuiTimelineEntry[] {
  return transcript.map((entry): TuiTimelineEntry => {
    if (entry.kind === "message")
      return {
        kind: "message",
        role: entry.role,
        text: entry.text,
        messageId: entry.messageId,
        ...(entry.turnId ? { turnId: entry.turnId } : {}),
        createdAt: entry.createdAt,
      };
    const startedAt = parsedTimestamp(entry.startedAt);
    const durationMs = actionDuration(entry);
    return {
      kind: "action",
      actionId: entry.actionId,
      ...(entry.turnId ? { turnId: entry.turnId } : {}),
      ...(entry.parentActionId ? { parentActionId: entry.parentActionId } : {}),
      ...(entry.executionId ? { executionId: entry.executionId } : {}),
      name: entry.name,
      status: entry.status,
      ...(entry.input === undefined ? {} : { input: entry.input }),
      ...(entry.update === undefined ? {} : { update: entry.update }),
      ...(entry.output === undefined ? {} : { output: entry.output }),
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(durationMs === undefined ? {} : { durationMs }),
    };
  });
}

export function isTuiMessageEntry(entry: TuiTimelineEntry): entry is TuiMessageEntry {
  return entry.kind === "message";
}

export function isTuiAgentActionEntry(entry: TuiTimelineEntry): entry is TuiAgentActionEntry {
  return entry.kind === "action";
}

export type ExecutionState = "idle" | "thinking" | "streaming" | "tool" | "compacting" | "aborting" | "error";

export function executionForInteractionPhase(
  current: ExecutionState,
  phase: TuiInteractionView["phase"],
): ExecutionState | undefined {
  if (phase === "interrupting") return "aborting";
  if (phase === "idle" && current !== "error" && current !== "compacting") return "idle";
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
  readonly status?: "pending" | "held";
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
  return {
    phase: snapshot.phase,
    queuePaused: snapshot.queuePaused,
    ...(snapshot.active ? { active: { ...snapshot.active } } : {}),
    queuedInputs: snapshot.pending.map((input) => ({
      queueId: input.intentId,
      text: input.text,
      createdAt: input.createdAt,
      status: input.status,
    })),
  };
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
}

export type NoesisTuiAction =
  | { readonly type: "trail-selected"; readonly trail: TrailState }
  | {
      readonly type: "transcript-hydrated";
      readonly trailId: string;
      readonly transcript: readonly RuntimeTranscriptEntry[];
    }
  | { readonly type: "prompt-submitted"; readonly text: string }
  | { readonly type: "steer-delivered"; readonly text: string }
  | { readonly type: "stream-delta"; readonly text: string }
  | { readonly type: "stream-reconciled"; readonly text: string }
  | {
      readonly type: "action-started";
      readonly actionId: string;
      readonly parentActionId?: string;
      readonly name: string;
      readonly input?: unknown;
      readonly at?: number;
    }
  | {
      readonly type: "action-updated";
      readonly actionId: string;
      readonly update: unknown;
    }
  | {
      readonly type: "action-ended";
      readonly actionId: string;
      readonly output?: unknown;
      readonly isError: boolean;
      readonly at?: number;
    }
  | { readonly type: "action-expansion-toggled"; readonly actionId: string }
  | {
      readonly type: "action-cursor-moved";
      readonly direction: "previous" | "next";
    }
  | { readonly type: "action-cursor-cleared" }
  | { readonly type: "inspector-opened"; readonly actionId: string }
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
  | { readonly type: "inspector-view-toggled" }
  | { readonly type: "inspector-closed" }
  | { readonly type: "execution-changed"; readonly execution: ExecutionState }
  | {
      readonly type: "model-metadata";
      readonly provider: string;
      readonly model: string;
      readonly contextWindow: number;
    }
  | ({ readonly type: "usage-updated" } & TuiContextUsage)
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
  | { readonly type: "turn-aborted" }
  | { readonly type: "compacted" }
  | { readonly type: "pane-selected"; readonly pane: Pane }
  | { readonly type: "failed"; readonly error: string }
  | { readonly type: "system-message"; readonly text: string };

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

function moveCursor(state: NoesisTuiState, direction: "previous" | "next"): NoesisTuiState {
  const actions = timelineActions(state.timeline);
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
        inspector: _inspector,
        ...rest
      } = state;
      return {
        ...rest,
        trailId: action.trail.trailId,
        title: action.trail.title,
        provider: action.trail.provider,
        model: action.trail.model,
        timeline: [],
        ...(action.trail.context ? { context: action.trail.context } : {}),
        capabilityVersions: { ...action.trail.capabilityVersions },
        expandedActionIds: NO_EXPANDED_ACTIONS,
        interaction: EMPTY_INTERACTION,
        turnCount: action.trail.turns.length,
        execution: "idle",
      };
    }
    case "transcript-hydrated":
      if (state.trailId !== action.trailId) return state;
      return {
        ...state,
        timeline: tuiTimelineFromRuntime(action.transcript),
        expandedActionIds: NO_EXPANDED_ACTIONS,
      };
    case "prompt-submitted": {
      const { error: _error, ...rest } = state;
      return {
        ...rest,
        execution: "thinking",
        timeline: [...state.timeline, { kind: "message", role: "user", text: action.text }],
      };
    }
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
    case "action-started": {
      const next: TuiAgentActionEntry = {
        kind: "action",
        actionId: action.actionId,
        ...(action.parentActionId ? { parentActionId: action.parentActionId } : {}),
        name: action.name,
        status: "running",
        ...(action.input === undefined ? {} : { input: action.input }),
        ...(action.at === undefined ? {} : { startedAt: action.at }),
      };
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
        return {
          ...entry,
          status: action.isError ? "failed" : "completed",
          ...(action.output === undefined ? {} : { output: action.output }),
          ...(durationMs === undefined ? {} : { durationMs }),
        };
      });
      const activeTool = [...timeline]
        .reverse()
        .find(
          (entry): entry is TuiAgentActionEntry => entry.kind === "action" && entry.status === "running",
        )?.name;
      const { activeTool: _activeTool, ...rest } = state;
      return {
        ...rest,
        ...(activeTool ? { activeTool } : {}),
        timeline,
        execution: activeTool ? "tool" : "thinking",
      };
    }
    case "action-expansion-toggled":
      return toggleExpansion(state, action.actionId);
    case "action-cursor-moved":
      return moveCursor(state, action.direction);
    case "action-cursor-cleared": {
      const { actionCursor: _actionCursor, ...rest } = state;
      return rest;
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
      return {
        ...state,
        inspector: {
          actionId: action.actionId,
          status: action.detail ? "ready" : "fallback",
          ...(action.detail ? { detail: action.detail } : {}),
          view: state.inspector.view,
          scroll: 0,
        },
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
    case "interaction-changed":
      return {
        ...state,
        interaction: {
          phase: action.interaction.phase,
          queuePaused: action.interaction.queuePaused,
          ...(action.interaction.active ? { active: { ...action.interaction.active } } : {}),
          queuedInputs: [...action.interaction.queuedInputs],
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
        capabilityVersions: { ...action.capabilityVersions },
      };
    }
    case "turn-aborted": {
      const timeline = [...state.timeline];
      const last = timeline.at(-1);
      if (last?.kind === "message" && last.role === "assistant" && !last.text) timeline.pop();
      return { ...state, execution: "idle", timeline };
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
      return {
        ...state,
        timeline: [...state.timeline, { kind: "message", role: "system", text: action.text }],
      };
  }
}
