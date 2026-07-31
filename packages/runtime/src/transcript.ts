import { type JsonValue, JsonValueSchema } from "@noesis/domain";
import type { NoesisWorkspaceStore, ToolCallRecord } from "@noesis/workspace";
import type { RuntimeTranscriptAction, RuntimeTranscriptEntry, RuntimeTranscriptMessage } from "./index.ts";

type TranscriptPoint = Readonly<{
  occurredAt: string;
  entry: RuntimeTranscriptEntry;
  inheritedHistorySequence?: number;
  interactionSequence?: number;
  turnId?: string;
  timelineSequence?: number;
  steer?: boolean;
}>;

const optionalTurnId = (metadata: Readonly<Record<string, unknown>>): string | undefined => {
  const turnId = metadata["turnId"];
  if (typeof turnId === "string" && turnId) return turnId;
  const legacyEventId = metadata["legacyEventId"];
  return typeof legacyEventId === "string" && legacyEventId ? legacyEventId : undefined;
};

const inheritedHistorySequence = (metadata: Readonly<Record<string, unknown>>): number | undefined => {
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

const nonnegativeSequence = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const messageTieRank = (point: TranscriptPoint): number => {
  if (point.entry.kind !== "message") return Number.MAX_SAFE_INTEGER;
  if (point.entry.role === "system") return 0;
  if (point.entry.role === "user") return point.steer === true ? 2 : 1;
  return 3;
};

const jsonValue = (value: unknown): JsonValue | undefined => {
  const result = JsonValueSchema.safeParse(value);
  return result.success ? result.data : undefined;
};

const nestedBrokerPayload = (value: unknown, field: "input" | "output"): unknown => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  if (!Object.hasOwn(value, field)) return value;
  return Reflect.get(value, field);
};

const executionIdFrom = (...values: readonly unknown[]): string | undefined => {
  for (const value of values) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const executionId = Reflect.get(value, "executionId");
    if (typeof executionId === "string" && executionId) return executionId;
  }
  return undefined;
};

const interruptedResponse = (response: unknown): boolean =>
  response !== null &&
  typeof response === "object" &&
  !Array.isArray(response) &&
  Reflect.get(response, "reason") === "interrupted";

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

const entryRank = (entry: RuntimeTranscriptEntry): number => {
  if (entry.kind === "action") return 2;
  if (entry.role === "system") return 0;
  if (entry.role === "user") return 1;
  return 3;
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
  left: TranscriptPoint,
  right: TranscriptPoint,
): number => {
  if (left.inheritedHistorySequence !== undefined && right.inheritedHistorySequence !== undefined) {
    const inheritedOrder = left.inheritedHistorySequence - right.inheritedHistorySequence;
    if (inheritedOrder !== 0) return inheritedOrder;
  }
  if (
    left.turnId !== undefined &&
    left.turnId === right.turnId &&
    left.timelineSequence !== undefined &&
    right.timelineSequence !== undefined
  ) {
    const timelineOrder = left.timelineSequence - right.timelineSequence;
    if (timelineOrder !== 0) return timelineOrder;
  }
  const chronological = left.occurredAt.localeCompare(right.occurredAt);
  if (chronological !== 0) return chronological;
  if (left.entry.kind === "action" && right.entry.kind === "action") {
    return (
      (tiedActionOrder.get(left.entry.actionId) ?? Number.MAX_SAFE_INTEGER) -
        (tiedActionOrder.get(right.entry.actionId) ?? Number.MAX_SAFE_INTEGER) ||
      compareActionIdentity(left.entry, right.entry)
    );
  }
  if (left.entry.kind === "message" && right.entry.kind === "message") {
    const messageRank = messageTieRank(left) - messageTieRank(right);
    if (messageRank !== 0) return messageRank;
    if (
      left.steer === true &&
      right.steer === true &&
      left.interactionSequence !== undefined &&
      right.interactionSequence !== undefined
    ) {
      const interactionOrder = left.interactionSequence - right.interactionSequence;
      if (interactionOrder !== 0) return interactionOrder;
    }
  }
  const ranked = entryRank(left.entry) - entryRank(right.entry);
  if (ranked !== 0) return ranked;
  const leftId = left.entry.kind === "action" ? left.entry.actionId : left.entry.messageId;
  const rightId = right.entry.kind === "action" ? right.entry.actionId : right.entry.messageId;
  return leftId.localeCompare(rightId);
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
    const action = Object.freeze({
      kind: "action" as const,
      actionId: call.toolCallId,
      sequence: call.sequence ?? Number.MAX_SAFE_INTEGER,
      ...(call.turnId ? { turnId: call.turnId } : { turnId: "" }),
      ...(derivedParent ? { parentActionId: derivedParent } : {}),
      ...(!nested && executionId && knownExecutionIds.has(executionId) ? { executionId } : {}),
      name: call.toolName,
      status: actionStatus(call, call.turnId ? turnStatus.get(call.turnId) : undefined),
      ...(input === undefined ? {} : { input }),
      ...(update === undefined ? {} : { update }),
      ...(output === undefined ? {} : { output }),
      startedAt: call.createdAt,
      ...(call.completedAt ? { completedAt: call.completedAt } : {}),
    }) satisfies RuntimeTranscriptAction;
    actions.push(action);
    points.push(
      Object.freeze({
        occurredAt: action.startedAt,
        entry: action,
        ...(call.turnId ? { turnId: call.turnId } : {}),
        ...(call.timelineSequence === undefined ? {} : { timelineSequence: call.timelineSequence }),
      }),
    );
  }

  for (const message of messages) {
    if (message.role === "tool") continue;
    const turnId = optionalTurnId(message.metadata);
    const entry = Object.freeze({
      kind: "message" as const,
      messageId: message.messageId,
      ...(turnId ? { turnId } : {}),
      role: message.role,
      text: message.content,
      createdAt: message.createdAt,
    }) satisfies RuntimeTranscriptMessage;
    const sequence = inheritedHistorySequence(message.metadata);
    const steer = message.role === "user" && message.metadata["deliveryMode"] === "steer";
    const interactionSequence = steer
      ? nonnegativeSequence(message.metadata["interactionSequence"])
      : undefined;
    points.push(
      Object.freeze({
        occurredAt: entry.createdAt,
        entry,
        ...(sequence === undefined ? {} : { inheritedHistorySequence: sequence }),
        ...(interactionSequence === undefined ? {} : { interactionSequence }),
        ...(steer ? { steer: true } : {}),
        ...(turnId ? { turnId } : {}),
        ...(message.timelineSequence === undefined ? {} : { timelineSequence: message.timelineSequence }),
      }),
    );
  }
  const tiedActionOrder = actionOrderAtTimestampTies(actions);
  return Object.freeze(
    points
      .sort((left, right) => compareTranscriptPoints(tiedActionOrder, left, right))
      .map((point) => point.entry),
  );
}
