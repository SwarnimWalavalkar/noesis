import { createConditionalObject, type JsonValue } from "@noesis/domain";
import type { SubAgentSummary } from "@noesis/agent-types";
import { appendReasoningDelta, reconcileReasoning } from "./reasoning-timeline.ts";
import { lastContentEntryIndex } from "./timeline-adapter.ts";
import type { ExecutionState, TuiAgentActionEntry, TuiMessageEntry, TuiTimelineEntry } from "./state.ts";

/** Speaker labels a transcript uses; a subagent's requester is the foreground agent, not the user. */
export interface TranscriptSpeakerLabels {
  readonly user: string;
  readonly assistant: string;
}

/**
 * Everything the transcript renderer reads. The foreground state satisfies it directly, and a
 * subagent view supplies its own timeline, cursor, and expansion with the shared agent directory.
 */
export interface TuiTranscriptSlice {
  readonly timeline: readonly TuiTimelineEntry[];
  readonly expandedActionIds: ReadonlySet<string>;
  readonly actionCursor?: string;
  readonly execution: ExecutionState;
  readonly animationFrame: number;
  readonly colorEnabled: boolean;
  readonly subAgents: readonly SubAgentSummary[];
  readonly subAgentPhases: Readonly<Record<string, string>>;
  /** Wall clock for live agent elapsed time; zero means unknown and elapsed is omitted. */
  readonly agentClock: number;
  readonly speakerLabels?: TranscriptSpeakerLabels;
}

/** Live timeline events shared by the foreground session and an opened subagent view. */
export type TimelineEvent =
  | { readonly type: "stream-delta"; readonly text: string }
  | { readonly type: "stream-reconciled"; readonly text: string }
  | { readonly type: "reasoning-delta"; readonly text: string }
  | { readonly type: "reasoning-reconciled"; readonly text: string }
  | {
      readonly type: "action-started";
      readonly actionId: string;
      readonly parentActionId?: string;
      readonly name: string;
      readonly input?: JsonValue;
      readonly at?: number;
    }
  | { readonly type: "action-updated"; readonly actionId: string; readonly update: JsonValue }
  | {
      readonly type: "action-ended";
      readonly actionId: string;
      readonly output?: JsonValue;
      readonly isError: boolean;
      readonly at?: number;
    };

export interface TimelineState {
  readonly timeline: readonly TuiTimelineEntry[];
  readonly execution: ExecutionState;
}

function appendAssistantText(
  timeline: readonly TuiTimelineEntry[],
  text: string,
  replace: boolean,
): readonly TuiTimelineEntry[] {
  const next = [...timeline];
  const index = lastContentEntryIndex(next);
  const last = next[index];
  if (last?.kind === "message" && last.role === "assistant")
    next[index] = { ...last, text: replace ? text : last.text + text };
  else next.push({ kind: "message", role: "assistant", text });
  return next;
}

/** The newest still-running action, which names the tool the agent is waiting on. */
export function runningToolName(timeline: readonly TuiTimelineEntry[]): string | undefined {
  return [...timeline]
    .reverse()
    .find((entry): entry is TuiAgentActionEntry => entry.kind === "action" && entry.status === "running")
    ?.name;
}

/** Pure timeline reduction for one live event; callers own any session-level bookkeeping. */
export function reduceTimeline(state: TimelineState, event: TimelineEvent): TimelineState {
  switch (event.type) {
    case "stream-delta":
      return { execution: "streaming", timeline: appendAssistantText(state.timeline, event.text, false) };
    case "stream-reconciled":
      return { execution: state.execution, timeline: appendAssistantText(state.timeline, event.text, true) };
    case "reasoning-delta":
      return { execution: "thinking", timeline: appendReasoningDelta(state.timeline, event.text) };
    case "reasoning-reconciled":
      return { execution: state.execution, timeline: reconcileReasoning(state.timeline, event.text) };
    case "action-started": {
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      const next: TuiAgentActionEntry = createConditionalObject({
        kind: "action",
        actionId: event.actionId,
      } as const)
        .addOptional(event.parentActionId ? { parentActionId: event.parentActionId } : undefined)
        .add({ name: event.name, status: "running" } as const)
        .addOptional(event.input === undefined ? undefined : { input: event.input })
        .addOptional(event.at === undefined ? undefined : { startedAt: event.at })
        .finish();
      const existing = state.timeline.findIndex(
        (entry) => entry.kind === "action" && entry.actionId === event.actionId,
      );
      return {
        execution: "tool",
        timeline:
          existing < 0
            ? [...state.timeline, next]
            : state.timeline.map((entry, index) => (index === existing ? next : entry)),
      };
    }
    case "action-updated":
      return {
        execution: state.execution,
        timeline: state.timeline.map((entry) =>
          entry.kind === "action" && entry.actionId === event.actionId
            ? { ...entry, update: event.update }
            : entry,
        ),
      };
    case "action-ended": {
      const timeline = state.timeline.map((entry): TuiTimelineEntry => {
        if (entry.kind !== "action" || entry.actionId !== event.actionId) return entry;
        const durationMs =
          event.at !== undefined && entry.startedAt !== undefined
            ? Math.max(0, event.at - entry.startedAt)
            : undefined;
        // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
        return createConditionalObject({ ...entry, status: event.isError ? "failed" : "completed" } as const)
          .addOptional(event.output === undefined ? undefined : { output: event.output })
          .addOptional(durationMs === undefined ? undefined : { durationMs })
          .finish();
      });
      return { timeline, execution: runningToolName(timeline) ? "tool" : "thinking" };
    }
  }
}

/** Selectable transcript actions, in timeline order. */
export function selectableActions(timeline: readonly TuiTimelineEntry[]): readonly TuiAgentActionEntry[] {
  return timeline.filter((entry): entry is TuiAgentActionEntry => entry.kind === "action");
}

/**
 * Moves an action cursor one step. With no cursor the newest action is selected, which is what
 * the user is almost always looking at when work has just finished.
 */
export function moveActionCursor(
  timeline: readonly TuiTimelineEntry[],
  cursor: string | undefined,
  direction: "previous" | "next",
): string | undefined {
  const actions = selectableActions(timeline);
  if (actions.length === 0) return undefined;
  const currentIndex = actions.findIndex((action) => action.actionId === cursor);
  if (currentIndex < 0) return actions.at(-1)?.actionId;
  const nextIndex = Math.min(actions.length - 1, Math.max(0, currentIndex + (direction === "next" ? 1 : -1)));
  return actions[nextIndex]?.actionId;
}

const sameLiveMessage = (live: TuiMessageEntry, durable: TuiTimelineEntry): boolean =>
  durable.kind === "message" && durable.role === live.role && durable.text.startsWith(live.text);

/**
 * Replaces a timeline with its durable record while keeping live content the record has not
 * caught up with yet. Durable entries always win: a live action is kept only while its exact
 * identity is absent, and live text only while no durable entry already contains it.
 */
export function mergeDurableTimeline(
  durable: readonly TuiTimelineEntry[],
  previous: readonly TuiTimelineEntry[],
): readonly TuiTimelineEntry[] {
  const durableActionIds = new Set(selectableActions(durable).map((action) => action.actionId));
  const tail = previous.filter((entry) => {
    if (entry.kind === "action") return !durableActionIds.has(entry.actionId);
    if (entry.kind === "reasoning")
      return (
        entry.reasoningId === undefined &&
        !durable.some((candidate) => candidate.kind === "reasoning" && candidate.text.startsWith(entry.text))
      );
    return (
      entry.messageId === undefined &&
      entry.role === "assistant" &&
      !durable.some((candidate) => sameLiveMessage(entry, candidate))
    );
  });
  return [...durable, ...tail];
}
