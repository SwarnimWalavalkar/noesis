import { createConditionalObject, type ComposerAttachment } from "@noesis/domain";
import type { RuntimeTranscriptAction, RuntimeTranscriptEntry } from "@noesis/runtime";
import type { TuiTimelineEntry, TuiMessageEntry, NoesisTuiAction } from "./state.ts";

/** UI-only command feedback has no durable message identity and never enters model history. */
export function isLocalSystemMessage(entry: TuiTimelineEntry): boolean {
  return entry.kind === "message" && entry.role === "system" && entry.messageId === undefined;
}

/** Local feedback must not split an in-progress assistant or reasoning segment. */
export function lastContentEntryIndex(timeline: readonly TuiTimelineEntry[]): number {
  return timeline.findLastIndex((entry) => !isLocalSystemMessage(entry));
}

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
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      return createConditionalObject({
        kind: "message",
        role: entry.role,
        text: entry.text,
        messageId: entry.messageId,
      } as const)
        .addOptional(entry.attachments?.length ? { attachments: entry.attachments } : undefined)
        .addOptional(entry.origin ? { origin: entry.origin } : undefined)
        .addOptional(entry.turnId ? { turnId: entry.turnId } : undefined)
        .add({
          createdAt: entry.createdAt,
        } as const)
        .finish();
    if (entry.kind === "reasoning")
      return createConditionalObject({
        kind: "reasoning",
        text: entry.text,
        reasoningId: entry.reasoningId,
      } as const)
        .addOptional(entry.turnId ? { turnId: entry.turnId } : undefined)
        .add({ createdAt: entry.createdAt } as const)
        .finish();
    const startedAt = parsedTimestamp(entry.startedAt);
    const durationMs = actionDuration(entry);
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    return createConditionalObject({
      kind: "action",
      actionId: entry.actionId,
    } as const)
      .addOptional(entry.turnId ? { turnId: entry.turnId } : undefined)
      .addOptional(entry.parentActionId ? { parentActionId: entry.parentActionId } : undefined)
      .addOptional(entry.executionId ? { executionId: entry.executionId } : undefined)
      .add({
        name: entry.name,
        status: entry.status,
      } as const)
      .addOptional(!(entry.input === undefined) ? { input: entry.input } : undefined)
      .addOptional(!(entry.update === undefined) ? { update: entry.update } : undefined)
      .addOptional(!(entry.output === undefined) ? { output: entry.output } : undefined)
      .addOptional(!(startedAt === undefined) ? { startedAt } : undefined)
      .addOptional(!(durationMs === undefined) ? { durationMs } : undefined)
      .finish();
  });
}

export function tuiUserMessage(
  text: string,
  attachments: readonly ComposerAttachment[] | undefined,
): TuiMessageEntry {
  return createConditionalObject({ kind: "message", role: "user", text } as const)
    .addOptional(attachments ? { attachments } : undefined)
    .finish();
}

export function tuiUserInputAction(
  type: "prompt-submitted" | "steer-delivered",
  text: string,
  attachments: readonly ComposerAttachment[] | undefined,
): NoesisTuiAction {
  return createConditionalObject({ type, text })
    .addOptional(attachments ? { attachments } : undefined)
    .finish();
}

/** Model rounds are runtime bookkeeping, not conversation; a subagent view omits them. */
export const MODEL_ROUND_ACTION_NAME = "model.round";

/** The runtime's inspection header on a mailbox message: `[sender → recipient]`. */
const MAILBOX_HEADER = /^\[(?<sender>[a-z]+:[^\s\]]+) → (?<recipient>[a-z]+:[^\s\]]+)\]\n/u;

/**
 * A subagent's durable transcript in the same entry shape the session transcript renders. A
 * mailbox message addressed to the agent is its task, shown as the requester's turn rather than
 * a system note carrying actor identifiers.
 */
export function subAgentTimelineFromRuntime(
  transcript: readonly RuntimeTranscriptEntry[],
  agentId: string,
): readonly TuiTimelineEntry[] {
  return tuiTimelineFromRuntime(
    transcript.filter((entry) => entry.kind !== "action" || entry.name !== MODEL_ROUND_ACTION_NAME),
  ).map((entry) => {
    if (entry.kind !== "message" || entry.role !== "system") return entry;
    const header = MAILBOX_HEADER.exec(entry.text);
    if (header?.groups?.["recipient"] !== `subagent:${agentId}`) return entry;
    return { ...entry, role: "user", text: entry.text.slice(header[0].length) };
  });
}
