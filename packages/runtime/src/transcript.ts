import {
  createConditionalObject,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  JsonValueSchema,
} from "@noesis/domain";
import type { NoesisWorkspaceStore, ToolCallRecord } from "@noesis/workspace";
import type {
  RuntimeTranscriptAction,
  RuntimeTranscriptEntry,
  RuntimeTranscriptMessage,
  RuntimeTranscriptReasoning,
} from "./index.ts";
type TranscriptPoint = Readonly<{
  occurredAt: string;
  entry: RuntimeTranscriptEntry;
  inheritedHistorySequence?: number;
  interactionSequence?: number;
  turnId?: string;
  timelineSequence?: number;
  steer?: boolean;
}>;
const optionalTurnId = (metadata: JsonObject): string | undefined => {
  const turnId = metadata["turnId"];
  if (typeof turnId === "string" && turnId) return turnId;
  const legacyEventId = metadata["legacyEventId"];
  return typeof legacyEventId === "string" && legacyEventId ? legacyEventId : undefined;
};
const inheritedHistorySequence = (metadata: JsonObject): number | undefined => {
  if (
    metadata["replayEligible"] !== true ||
    typeof metadata["inheritedFromSessionId"] !== "string" ||
    metadata["inheritedFromSessionId"].length === 0 ||
    typeof metadata["inheritedFromMessageId"] !== "string" ||
    metadata["inheritedFromMessageId"].length === 0
  )
    return undefined;
  const sequence = metadata["historySequence"];
  return typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence >= 0
    ? sequence
    : undefined;
};
// BOUNDARY: Legacy transcript metadata stores optional sequence values without a shared row schema.
const nonnegativeSequence = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const jsonValue = (value: unknown): JsonValue | undefined => {
  const result = JsonValueSchema.safeParse(value);
  return result.success ? result.data : undefined;
};
const nestedBrokerPayload = (value: unknown, field: "input" | "output"): JsonValue | undefined => {
  const parsed = JsonValueSchema.safeParse(value);
  if (!parsed.success) return undefined;
  if (!isJsonObject(parsed.data) || !Object.hasOwn(parsed.data, field)) return parsed.data;
  return parsed.data[field];
};
const executionIdFrom = (...values: readonly unknown[]): string | undefined => {
  for (const value of values) {
    const parsed = JsonValueSchema.safeParse(value);
    if (!parsed.success || !isJsonObject(parsed.data)) continue;
    const executionId = parsed.data["executionId"];
    if (typeof executionId === "string" && executionId) return executionId;
  }
  return undefined;
};
const interruptedResponse = (response: unknown): boolean =>
  (() => {
    const parsed = JsonValueSchema.safeParse(response);
    return parsed.success && isJsonObject(parsed.data) && parsed.data["reason"] === "interrupted";
  })();
const actionStatus = (
  record: ToolCallRecord,
  terminalTurnStatus: "completed" | "aborted" | "failed" | undefined,
): RuntimeTranscriptAction["status"] => {
  if (record.status === "requested" || record.status === "running")
    return terminalTurnStatus === "aborted" || terminalTurnStatus === "failed" ? "interrupted" : "running";
  if (record.status === "completed") return "completed";
  if (record.status === "denied") return "denied";
  if (record.status === "ambiguous") return "ambiguous";
  return interruptedResponse(record.response) ? "interrupted" : "failed";
};
const pointTieRank = (point: TranscriptPoint): number => {
  if (point.entry.kind === "action") return 3;
  if (point.entry.kind === "reasoning") return 3;
  if (point.entry.role === "system") return 0;
  if (point.entry.role === "user") return point.steer === true ? 2 : 1;
  return 4;
};
const compareActionIdentity = (left: RuntimeTranscriptAction, right: RuntimeTranscriptAction): number =>
  (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER) ||
  left.actionId.localeCompare(right.actionId);
const actionOrderAtTimestampTies = (
  actions: readonly RuntimeTranscriptAction[],
): ReadonlyMap<string, number> => {
  const byTimestamp = new Map<string, RuntimeTranscriptAction[]>();
  for (const action of actions) {
    const group = byTimestamp.get(action.startedAt) ?? [];
    group.push(action);
    byTimestamp.set(action.startedAt, group);
  }
  const order = new Map<string, number>();
  for (const group of byTimestamp.values()) {
    const pending = new Map(group.map((action) => [action.actionId, action]));
    let index = 0;
    while (pending.size > 0) {
      const ready = [...pending.values()]
        .filter((action) => !action.parentActionId || !pending.has(action.parentActionId))
        .sort(compareActionIdentity);
      const next = ready.at(0) ?? [...pending.values()].sort(compareActionIdentity).at(0);
      if (!next) break;
      order.set(next.actionId, index);
      index += 1;
      pending.delete(next.actionId);
    }
  }
  return order;
};
const compareTranscriptPoints = (
  tiedActionOrder: ReadonlyMap<string, number>,
  turnAnchors: ReadonlyMap<string, string>,
  completeTimelineTurns: ReadonlySet<string>,
  left: TranscriptPoint,
  right: TranscriptPoint,
): number => {
  const leftInherited = left.inheritedHistorySequence !== undefined;
  const rightInherited = right.inheritedHistorySequence !== undefined;
  if (leftInherited !== rightInherited) return leftInherited ? -1 : 1;
  if (left.inheritedHistorySequence !== undefined && right.inheritedHistorySequence !== undefined) {
    const inheritedOrder = left.inheritedHistorySequence - right.inheritedHistorySequence;
    if (inheritedOrder !== 0) return inheritedOrder;
  }
  if (!leftInherited && !rightInherited) {
    const leftAnchor = left.turnId ? (turnAnchors.get(left.turnId) ?? left.occurredAt) : left.occurredAt;
    const rightAnchor = right.turnId ? (turnAnchors.get(right.turnId) ?? right.occurredAt) : right.occurredAt;
    const anchorOrder = leftAnchor.localeCompare(rightAnchor);
    if (anchorOrder !== 0) return anchorOrder;
    const leftGroup = left.turnId ? `turn:${left.turnId}` : `entry:${entryId(left.entry)}`;
    const rightGroup = right.turnId ? `turn:${right.turnId}` : `entry:${entryId(right.entry)}`;
    const groupOrder = leftGroup.localeCompare(rightGroup);
    if (groupOrder !== 0) return groupOrder;
  }
  if (
    left.turnId !== undefined &&
    left.turnId === right.turnId &&
    completeTimelineTurns.has(left.turnId) &&
    left.timelineSequence !== undefined &&
    right.timelineSequence !== undefined
  ) {
    const timelineOrder = left.timelineSequence - right.timelineSequence;
    if (timelineOrder !== 0) return timelineOrder;
  }
  const chronological = left.occurredAt.localeCompare(right.occurredAt);
  if (chronological !== 0) return chronological;
  const ranked = pointTieRank(left) - pointTieRank(right);
  if (ranked !== 0) return ranked;
  if (left.entry.kind === "action" && right.entry.kind === "action") {
    return (
      (tiedActionOrder.get(left.entry.actionId) ?? Number.MAX_SAFE_INTEGER) -
        (tiedActionOrder.get(right.entry.actionId) ?? Number.MAX_SAFE_INTEGER) ||
      compareActionIdentity(left.entry, right.entry)
    );
  }
  if (
    left.steer === true &&
    right.steer === true &&
    left.interactionSequence !== undefined &&
    right.interactionSequence !== undefined
  ) {
    const interactionOrder = left.interactionSequence - right.interactionSequence;
    if (interactionOrder !== 0) return interactionOrder;
  }
  return entryId(left.entry).localeCompare(entryId(right.entry));
};
const entryId = (entry: RuntimeTranscriptEntry): string =>
  entry.kind === "action" ? entry.actionId : entry.kind === "reasoning" ? entry.reasoningId : entry.messageId;
const transcriptTurnOrder = (
  points: readonly TranscriptPoint[],
): {
  readonly anchors: ReadonlyMap<string, string>;
  readonly completeTimelines: ReadonlySet<string>;
} => {
  const anchors = new Map<string, string>();
  const incompleteTimelines = new Set<string>();
  const seenTurns = new Set<string>();
  for (const point of points) {
    if (point.inheritedHistorySequence !== undefined || !point.turnId) continue;
    seenTurns.add(point.turnId);
    const currentAnchor = anchors.get(point.turnId);
    if (currentAnchor === undefined || point.occurredAt < currentAnchor)
      anchors.set(point.turnId, point.occurredAt);
    if (point.timelineSequence === undefined) incompleteTimelines.add(point.turnId);
  }
  return Object.freeze({
    anchors,
    completeTimelines: new Set([...seenTurns].filter((turnId) => !incompleteTimelines.has(turnId))),
  });
};
/**
 * Builds the one runtime transcript read model from authoritative operational rows.
 *
 * Historical assistant text is one settled message, but all durable entries still retain their
 * cross-type chronology. This lets later user steering interleave honestly with recorded actions.
 */
export async function loadRuntimeTranscript(
  workspace: NoesisWorkspaceStore,
  sessionId: string,
): Promise<readonly RuntimeTranscriptEntry[]> {
  const [messages, toolCalls, codeExecutions] = await Promise.all([
    workspace.operational.messages.listForSession(sessionId),
    workspace.operational.toolCalls.listForSession(sessionId),
    workspace.operational.codeExecutions.listForSession(sessionId),
  ]);
  const executionToTopAction = new Map<string, string>();
  for (const call of toolCalls) {
    if (call.parentToolCallId || call.toolName !== "execute") continue;
    const executionId = call.executionId ?? executionIdFrom(call.update, call.response, call.request);
    if (executionId) executionToTopAction.set(executionId, call.toolCallId);
  }
  const knownExecutionIds = new Set(codeExecutions.map((execution) => execution.executionId));
  const turnStatus = new Map<string, "completed" | "aborted" | "failed" | undefined>();
  for (const turnId of new Set(toolCalls.flatMap((call) => (call.turnId ? [call.turnId] : [])))) {
    const turn = await workspace.operational.foregroundTurns.get(turnId);
    turnStatus.set(turnId, turn?.status === "running" ? undefined : turn?.status);
  }
  const points: TranscriptPoint[] = [];
  const actions: RuntimeTranscriptAction[] = [];
  for (const call of toolCalls) {
    const executionId = call.executionId ?? executionIdFrom(call.update, call.response, call.request);
    const derivedParent =
      call.parentToolCallId ??
      (executionId && call.toolName !== "execute" ? executionToTopAction.get(executionId) : undefined);
    const nested = derivedParent !== undefined;
    const input = jsonValue(nested ? nestedBrokerPayload(call.request, "input") : call.request);
    const update = call.update === undefined ? undefined : jsonValue(call.update);
    const output =
      call.response === undefined
        ? undefined
        : jsonValue(nested ? nestedBrokerPayload(call.response, "output") : call.response);
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    const action = Object.freeze(
      createConditionalObject({
        kind: "action" as const,
        actionId: call.toolCallId,
        sequence: call.sequence ?? Number.MAX_SAFE_INTEGER,
      } as const)
        .addOptional(call.turnId ? { turnId: call.turnId } : undefined)
        .addOptional(derivedParent ? { parentActionId: derivedParent } : undefined)
        .addOptional(
          !nested && executionId && knownExecutionIds.has(executionId) ? { executionId } : undefined,
        )
        .add({
          name: call.toolName,
          status: actionStatus(call, call.turnId ? turnStatus.get(call.turnId) : undefined),
        } as const)
        .addOptional(!(input === undefined) ? { input } : undefined)
        .addOptional(!(update === undefined) ? { update } : undefined)
        .addOptional(!(output === undefined) ? { output } : undefined)
        .add({
          startedAt: call.createdAt,
        } as const)
        .addOptional(call.completedAt ? { completedAt: call.completedAt } : undefined)
        .finish(),
    ) satisfies RuntimeTranscriptAction;
    actions.push(action);
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    points.push(
      Object.freeze(
        createConditionalObject({
          occurredAt: action.startedAt,
          entry: action,
        } as const)
          .addOptional(call.turnId ? { turnId: call.turnId } : undefined)
          .addOptional(
            !(call.timelineSequence === undefined) ? { timelineSequence: call.timelineSequence } : undefined,
          )
          .finish(),
      ),
    );
  }
  for (const message of messages) {
    if (message.role === "tool") continue;
    const turnId = optionalTurnId(message.metadata);
    if (message.role === "system" && message.metadata["presentation"] === "reasoning") {
      const entry = Object.freeze(
        createConditionalObject({
          kind: "reasoning" as const,
          reasoningId: message.messageId,
          text: message.content,
          createdAt: message.createdAt,
        } as const)
          .addOptional(turnId ? { turnId } : undefined)
          .finish(),
      ) satisfies RuntimeTranscriptReasoning;
      points.push(
        Object.freeze(
          createConditionalObject({
            occurredAt: entry.createdAt,
            entry,
          } as const)
            .addOptional(turnId ? { turnId } : undefined)
            .addOptional(
              !(message.timelineSequence === undefined)
                ? { timelineSequence: message.timelineSequence }
                : undefined,
            )
            .finish(),
        ),
      );
      continue;
    }
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    const entry = Object.freeze(
      createConditionalObject({
        kind: "message" as const,
        messageId: message.messageId,
      } as const)
        .addOptional(turnId ? { turnId } : undefined)
        .add({
          role: message.role,
          text: message.content,
          createdAt: message.createdAt,
        } as const)
        .finish(),
    ) satisfies RuntimeTranscriptMessage;
    const sequence = inheritedHistorySequence(message.metadata);
    const steer = message.role === "user" && message.metadata["deliveryMode"] === "steer";
    const interactionSequence = steer
      ? nonnegativeSequence(message.metadata["interactionSequence"])
      : undefined;
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    points.push(
      Object.freeze(
        createConditionalObject({
          occurredAt: entry.createdAt,
          entry,
        } as const)
          .addOptional(!(sequence === undefined) ? { inheritedHistorySequence: sequence } : undefined)
          .addOptional(!(interactionSequence === undefined) ? { interactionSequence } : undefined)
          .addOptional(steer ? { steer: true } : undefined)
          .addOptional(turnId ? { turnId } : undefined)
          .addOptional(
            !(message.timelineSequence === undefined)
              ? {
                  timelineSequence: message.timelineSequence,
                }
              : undefined,
          )
          .finish(),
      ),
    );
  }
  const tiedActionOrder = actionOrderAtTimestampTies(actions);
  const turnOrder = transcriptTurnOrder(points);
  return Object.freeze(
    points
      .sort((left, right) =>
        compareTranscriptPoints(tiedActionOrder, turnOrder.anchors, turnOrder.completeTimelines, left, right),
      )
      .map((point) => point.entry),
  );
}
