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

/** Identities an entry keeps across a durable reload; an admitted prompt is also known by its turn. */
function durableIdentities(entry: TuiTimelineEntry): readonly string[] {
  if (entry.kind === "action") return [`action:${entry.actionId}`];
  if (entry.kind === "reasoning") return entry.reasoningId ? [`reasoning:${entry.reasoningId}`] : [];
  return [
    ...(entry.messageId ? [`message:${entry.messageId}`] : []),
    ...(entry.role === "user" && entry.turnId ? [`prompt:${entry.turnId}`] : []),
  ];
}

/**
 * Re-inserts UI-only notes into a reloaded transcript where they were shown. A note follows the
 * nearest earlier entry the reload still contains, resolved by exact identity before the turn
 * alias that a prompt shares with its steers. Live text between that entry and the note has no
 * identity yet, so it counts as an offset: a note shown after a streamed reply stays after the
 * reply once it is reloaded. A note with no earlier entry keeps its place at the top.
 */
export function withLocalNotes(
  durable: readonly TuiTimelineEntry[],
  previous: readonly TuiTimelineEntry[],
): readonly TuiTimelineEntry[] {
  if (!previous.some(isLocalSystemMessage)) return durable;
  const locate = (identities: readonly string[]): number => {
    for (const identity of identities) {
      const index = durable.findIndex((entry) => durableIdentities(entry).includes(identity));
      if (index >= 0) return index;
    }
    return -1;
  };
  const leading: TuiTimelineEntry[] = [];
  const trailing: TuiTimelineEntry[] = [];
  const placed = new Map<number, TuiTimelineEntry[]>();
  const anchors: (readonly string[])[] = [];
  let sinceAnchor = 0;
  for (const entry of previous) {
    if (!isLocalSystemMessage(entry)) {
      const identities = durableIdentities(entry);
      if (identities.length > 0) {
        anchors.push(identities);
        sinceAnchor = 0;
      } else sinceAnchor += 1;
      continue;
    }
    if (anchors.length === 0) {
      leading.push(entry);
      continue;
    }
    let position = -1;
    for (let back = anchors.length - 1; back >= 0 && position < 0; back -= 1) {
      const index = locate(anchors[back] ?? []);
      if (index >= 0) position = back === anchors.length - 1 ? index + sinceAnchor : index;
    }
    if (position < 0) trailing.push(entry);
    else {
      const at = Math.min(position, durable.length - 1);
      placed.set(at, [...(placed.get(at) ?? []), entry]);
    }
  }
  return [
    ...leading,
    ...durable.flatMap((entry, index) => [entry, ...(placed.get(index) ?? [])]),
    ...trailing,
  ];
}
