import { JsonValueSchema, type JsonValue } from "@noesis/domain";
import type { NoesisWorkspaceStore, ToolCallRecord } from "@noesis/workspace";
import type { RuntimeTranscriptAction, RuntimeTranscriptEntry, RuntimeTranscriptMessage } from "./index.ts";

type TranscriptBlock = Readonly<{
  occurredAt: string;
  tieBreak: string;
  entries: readonly RuntimeTranscriptEntry[];
}>;

const optionalTurnId = (metadata: Readonly<Record<string, unknown>>): string | undefined => {
  const turnId = metadata["turnId"];
  if (typeof turnId === "string" && turnId) return turnId;
  const legacyEventId = metadata["legacyEventId"];
  return typeof legacyEventId === "string" && legacyEventId ? legacyEventId : undefined;
};

const jsonValue = (value: unknown): JsonValue | undefined => {
  const result = JsonValueSchema.safeParse(value);
  return result.success ? result.data : undefined;
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

const sortActions = (actions: readonly RuntimeTranscriptAction[]): readonly RuntimeTranscriptAction[] => {
  const byParent = new Map<string | undefined, RuntimeTranscriptAction[]>();
  for (const action of actions) {
    const siblings = byParent.get(action.parentActionId) ?? [];
    siblings.push(action);
    byParent.set(action.parentActionId, siblings);
  }
  const compare = (left: RuntimeTranscriptAction, right: RuntimeTranscriptAction): number =>
    (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER) ||
    left.actionId.localeCompare(right.actionId);
  for (const siblings of byParent.values()) siblings.sort(compare);
  const ordered: RuntimeTranscriptAction[] = [];
  const visited = new Set<string>();
  const append = (action: RuntimeTranscriptAction): void => {
    if (visited.has(action.actionId)) return;
    visited.add(action.actionId);
    ordered.push(action);
    for (const child of byParent.get(action.actionId) ?? []) append(child);
  };
  for (const action of byParent.get(undefined) ?? []) append(action);
  // Preserve malformed or legacy orphaned actions instead of dropping evidence.
  for (const action of [...actions].sort(compare)) append(action);
  return Object.freeze(ordered);
};

/**
 * Builds the one runtime transcript read model from authoritative operational rows.
 *
 * Historical assistant text was stored as one settled message, so a resumed transcript cannot
 * invent text fragments around tool calls. Within each turn the honest projection is therefore
 * user message, recorded actions, then the final assistant message.
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
  const actionsByTurn = new Map<string, RuntimeTranscriptAction[]>();
  const orphanActions: RuntimeTranscriptAction[] = [];
  for (const call of toolCalls) {
    const executionId = call.executionId ?? executionIdFrom(call.update, call.response, call.request);
    const derivedParent =
      call.parentToolCallId ??
      (executionId && call.toolName !== "execute" ? executionToTopAction.get(executionId) : undefined);
    const input = jsonValue(call.request);
    const update = call.update === undefined ? undefined : jsonValue(call.update);
    const output = call.response === undefined ? undefined : jsonValue(call.response);
    const action = Object.freeze({
      kind: "action" as const,
      actionId: call.toolCallId,
      sequence: call.sequence ?? Number.MAX_SAFE_INTEGER,
      ...(call.turnId ? { turnId: call.turnId } : { turnId: "" }),
      ...(derivedParent ? { parentActionId: derivedParent } : {}),
      ...(executionId && knownExecutionIds.has(executionId) ? { executionId } : {}),
      name: call.toolName,
      status: actionStatus(call, call.turnId ? turnStatus.get(call.turnId) : undefined),
      ...(input === undefined ? {} : { input }),
      ...(update === undefined ? {} : { update }),
      ...(output === undefined ? {} : { output }),
      startedAt: call.createdAt,
      ...(call.completedAt ? { completedAt: call.completedAt } : {}),
    }) satisfies RuntimeTranscriptAction;
    if (!call.turnId) orphanActions.push(action);
    else {
      const turnActions = actionsByTurn.get(call.turnId) ?? [];
      turnActions.push(action);
      actionsByTurn.set(call.turnId, turnActions);
    }
  }

  const messagesByTurn = new Map<string, RuntimeTranscriptMessage[]>();
  const blocks: TranscriptBlock[] = [];
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
    if (!turnId) {
      blocks.push(
        Object.freeze({
          occurredAt: message.createdAt,
          tieBreak: `message:${message.messageId}`,
          entries: Object.freeze([entry]),
        }),
      );
      continue;
    }
    const turnMessages = messagesByTurn.get(turnId) ?? [];
    turnMessages.push(entry);
    messagesByTurn.set(turnId, turnMessages);
  }
  for (const [turnId, turnMessages] of messagesByTurn) {
    const users = turnMessages.filter((message) => message.role === "user");
    const assistants = turnMessages.filter((message) => message.role === "assistant");
    const systems = turnMessages.filter((message) => message.role === "system");
    const actions = sortActions(actionsByTurn.get(turnId) ?? []);
    const entries = Object.freeze([...systems, ...users, ...actions, ...assistants]);
    const occurredAt =
      users.at(0)?.createdAt ??
      systems.at(0)?.createdAt ??
      actions.at(0)?.startedAt ??
      assistants.at(0)?.createdAt;
    if (!occurredAt) continue;
    blocks.push(Object.freeze({ occurredAt, tieBreak: `turn:${turnId}`, entries }));
    actionsByTurn.delete(turnId);
  }
  for (const [turnId, actions] of actionsByTurn) {
    const ordered = sortActions(actions);
    const first = ordered.at(0);
    if (!first) continue;
    blocks.push(
      Object.freeze({
        occurredAt: first.startedAt,
        tieBreak: `turn:${turnId}`,
        entries: ordered,
      }),
    );
  }
  for (const action of orphanActions) {
    blocks.push(
      Object.freeze({
        occurredAt: action.startedAt,
        tieBreak: `action:${action.actionId}`,
        entries: Object.freeze([action]),
      }),
    );
  }
  return Object.freeze(
    blocks
      .sort(
        (left, right) =>
          left.occurredAt.localeCompare(right.occurredAt) || left.tieBreak.localeCompare(right.tieBreak),
      )
      .flatMap((block) => block.entries),
  );
}
