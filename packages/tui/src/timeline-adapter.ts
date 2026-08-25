import { createConditionalObject } from "@noesis/domain";
import type { RuntimeTranscriptAction, RuntimeTranscriptEntry } from "@noesis/runtime";
import type { TuiTimelineEntry } from "./state.ts";

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
