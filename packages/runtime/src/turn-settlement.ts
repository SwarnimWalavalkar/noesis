import type { FrozenTurnPlan } from "@noesis/agent-types";
import type { Capability, CapabilityRevisionRef, EvidenceRef } from "@noesis/domain";
import type { NoesisWorkspaceStore } from "@noesis/workspace";
import type { ContinuousFeedbackController } from "./continuous-feedback.ts";
import type { RuntimeControlPlane } from "./control-plane.ts";
import type { TurnResult } from "./index.ts";

export interface TurnSettlementRequest {
  readonly sessionId: string;
  readonly turnId: string;
  readonly input: string;
  readonly sourceIntentId?: string;
  readonly occurredAt: string;
  readonly plan: FrozenTurnPlan;
  readonly execute: () => Promise<TurnResult>;
}

export interface TurnSettlement {
  readonly run: (request: TurnSettlementRequest) => Promise<TurnResult>;
}

export interface TurnSettlementOptions {
  readonly workspace: NoesisWorkspaceStore;
  readonly feedback: ContinuousFeedbackController;
  readonly controlPlane: Pick<RuntimeControlPlane, "observeCompletedTurn">;
  readonly resolveCapability: (capabilityId: string) => Capability | undefined;
  readonly now?: () => string;
}

export function createTurnSettlement(options: TurnSettlementOptions): TurnSettlement {
  const now = options.now ?? (() => new Date().toISOString());

  const run = async (request: TurnSettlementRequest): Promise<TurnResult> => {
    const userRef = await options.workspace.operational.messages.put(
      Object.freeze({
        messageId: `${request.turnId}:user`,
        sessionId: request.sessionId,
        role: "user" as const,
        content: request.input,
        sensitivity: "normal" as const,
        createdAt: request.occurredAt,
        metadata: Object.freeze({
          turnId: request.turnId,
          ...(request.sourceIntentId ? { sourceIntentId: request.sourceIntentId } : {}),
          frozenTurnPlanId: request.plan.planId,
          frozenTurnPlanDigest: request.plan.canonicalDigest,
        }),
        timelineSequence: 0,
      }),
    );
    const serving = request.plan.selectedCapabilities.map((selection) => selection.revision);

    const record = async (
      status: "corrected" | "failed" | "unknown",
      summary: string,
      assistantMessage?: string,
      aborted = false,
      assistantBoundaries: TurnResult["assistantMessages"] = [],
    ): Promise<void> => {
      for (const boundary of assistantBoundaries) {
        const messageId = `${request.turnId}:assistant:${String(boundary.timelineSequence)}`;
        const existing = await options.workspace.operational.messages.get(messageId);
        if (existing !== undefined) {
          if (
            existing.sessionId !== request.sessionId ||
            existing.role !== "assistant" ||
            existing.content !== boundary.text ||
            existing.createdAt !== boundary.createdAt ||
            existing.timelineSequence !== boundary.timelineSequence
          )
            throw new Error(`Assistant boundary ${messageId} has conflicting durable content`);
          continue;
        }
        await options.workspace.operational.messages.put(
          Object.freeze({
            messageId,
            sessionId: request.sessionId,
            role: "assistant" as const,
            content: boundary.text,
            sensitivity: "normal" as const,
            createdAt: boundary.createdAt,
            metadata: Object.freeze({
              turnId: request.turnId,
              frozenTurnPlanId: request.plan.planId,
            }),
            timelineSequence: boundary.timelineSequence,
          }),
        );
      }
      const durableAssistantMessages = (
        await options.workspace.operational.messages.listForSession(request.sessionId)
      )
        .filter((message) => message.role === "assistant" && message.metadata["turnId"] === request.turnId)
        .sort(
          (left, right) =>
            (left.timelineSequence ?? Number.MAX_SAFE_INTEGER) -
              (right.timelineSequence ?? Number.MAX_SAFE_INTEGER) ||
            left.createdAt.localeCompare(right.createdAt) ||
            left.messageId.localeCompare(right.messageId),
        );
      if (durableAssistantMessages.length === 0 && assistantMessage) {
        await options.workspace.operational.messages.put(
          Object.freeze({
            messageId: `${request.turnId}:assistant`,
            sessionId: request.sessionId,
            role: "assistant" as const,
            content: assistantMessage,
            sensitivity: "normal" as const,
            createdAt: now(),
            metadata: Object.freeze({
              turnId: request.turnId,
              frozenTurnPlanId: request.plan.planId,
            }),
          }),
        );
      }
      const settledAssistantMessages =
        durableAssistantMessages.length > 0
          ? durableAssistantMessages
          : (await options.workspace.operational.messages.listForSession(request.sessionId)).filter(
              (message) => message.role === "assistant" && message.metadata["turnId"] === request.turnId,
            );
      const assistantRefs: readonly EvidenceRef[] = Object.freeze(
        settledAssistantMessages.map((message) =>
          Object.freeze({
            kind: "database_row" as const,
            table: "messages" as const,
            rowId: message.messageId,
          }),
        ),
      );
      const toolCalls = [
        ...(await options.workspace.operational.toolCalls.listForTurn(request.sessionId, request.turnId)),
      ].sort(
        (left, right) =>
          (left.timelineSequence ?? Number.MAX_SAFE_INTEGER) -
            (right.timelineSequence ?? Number.MAX_SAFE_INTEGER) ||
          left.createdAt.localeCompare(right.createdAt) ||
          left.toolCallId.localeCompare(right.toolCallId),
      );
      const toolRefs: readonly EvidenceRef[] = Object.freeze(
        toolCalls.map((toolCall) =>
          Object.freeze({
            kind: "database_row" as const,
            table: "tool_calls" as const,
            rowId: toolCall.toolCallId,
          }),
        ),
      );
      const toolFailureCount = toolCalls.filter((toolCall) => toolCall.status === "failed").length;
      const evidenceRefs: readonly EvidenceRef[] = Object.freeze([userRef, ...assistantRefs, ...toolRefs]);
      await options.workspace.operational.outcomes.put(
        Object.freeze({
          outcomeId: `${request.turnId}:outcome`,
          sessionId: request.sessionId,
          turnId: request.turnId,
          status,
          summary,
          sensitivity: "normal" as const,
          createdAt: now(),
          metadata: Object.freeze({
            source: "turn-settlement",
            aborted,
            replayEligible: !aborted,
            frozenTurnPlanId: request.plan.planId,
          }),
        }),
      );
      await options.workspace.operational.foregroundTurns.settle({
        turnId: request.turnId,
        outcomeId: `${request.turnId}:outcome`,
        status: aborted ? "aborted" : status === "failed" ? "failed" : "completed",
        settledAt: now(),
      });
      if (aborted || serving.length === 0) return;
      const outcomeId = `${request.turnId}:outcome`;
      await options.feedback.observeTurnOutcome({
        sessionId: request.sessionId,
        turnId: request.turnId,
        outcomeId,
        status,
        summary,
        sensitivity: "normal",
        usedCapabilityIds: serving.map((reference) => reference.capabilityId),
        evidenceRefs,
        metrics: Object.freeze({ failed: status === "failed" }),
      });
      const learningAttribution = request.plan.routing.learningAttribution;
      const routedSelection = learningAttribution
        ? request.plan.selectedCapabilities.find(
            (selection) => selection.capabilityId === learningAttribution.capabilityId,
          )
        : request.plan.selectedCapabilities.find((selection) => selection.baseline.kind === "genesis");
      if (learningAttribution && !routedSelection)
        throw new Error(
          `Frozen turn plan ${request.plan.planId} attributes learning to unselected capability ${learningAttribution.capabilityId}`,
        );
      if (!routedSelection) return;
      const baseline = routedSelection.revision;
      const capability = options.resolveCapability(routedSelection.capabilityId);
      if (!capability) return;
      await options.controlPlane.observeCompletedTurn({
        turn: Object.freeze({
          sessionId: request.sessionId,
          turnId: request.turnId,
          outcomeId,
          scope: capability.scope,
          userMessage: request.input,
          ...(assistantMessage ? { assistantMessage } : {}),
          outcome: status === "failed" ? "failed" : "unknown",
          occurredAt: request.occurredAt,
          evidenceRefs: [...evidenceRefs],
          sensitivity: "normal" as const,
          telemetry: Object.freeze({
            retryCount: 0,
            toolFailureCount,
            aborted: false,
          }),
        }),
        baselineRevision: baseline,
        capability,
        activeCapabilities: serving.flatMap((reference: CapabilityRevisionRef) => {
          const active = options.resolveCapability(reference.capabilityId);
          return active ? [active] : [];
        }),
        routingStrategyId: request.plan.routing.strategyId,
      });
    };

    let result: TurnResult;
    try {
      result = await request.execute();
    } catch (error) {
      await record("failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
    if (result.outcome === "aborted") {
      await record("failed", "Turn aborted", result.output, true, result.assistantMessages);
      return result;
    }
    await record("unknown", result.output, result.output, false, result.assistantMessages);
    return result;
  };

  return Object.freeze({ run });
}
