import { createConditionalObject } from "@noesis/domain";
import type { FrozenTurnPlan } from "@noesis/agent-types";
import type { EvidenceRef, ProjectRef } from "@noesis/domain";
import type { NoesisWorkspaceStore } from "@noesis/workspace";
import type { CapabilityCoordinator } from "./capability-coordinator.ts";
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
  readonly run: (request: TurnSettlementRequest) => Promise<TurnSettlementResult>;
}
export interface TurnSettlementResult {
  readonly result: TurnResult;
  /** Exact durable reflection job created from this settled foreground turn. */
  readonly reflectionJobId?: string;
}
export interface TurnSettlementOptions {
  readonly workspace: NoesisWorkspaceStore;
  readonly coordinator: Pick<CapabilityCoordinator, "observeSettledTurn">;
  readonly project: ProjectRef;
  readonly now?: () => string;
  readonly onReflectionFailure?: (
    cause: unknown,
    turn: Readonly<{
      sessionId: string;
      turnId: string;
    }>,
  ) => void | Promise<void>;
}
export function createTurnSettlement(options: TurnSettlementOptions): TurnSettlement {
  const now = options.now ?? (() => new Date().toISOString());
  const run = async (request: TurnSettlementRequest): Promise<TurnSettlementResult> => {
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    const userRef = await options.workspace.operational.messages.put(
      Object.freeze({
        messageId: `${request.turnId}:user`,
        sessionId: request.sessionId,
        role: "user" as const,
        content: request.input,
        sensitivity: "normal" as const,
        createdAt: request.occurredAt,
        metadata: Object.freeze(
          createConditionalObject({
            turnId: request.turnId,
          } as const)
            .addOptional(request.sourceIntentId ? { sourceIntentId: request.sourceIntentId } : undefined)
            .add({
              frozenTurnPlanId: request.plan.planId,
              frozenTurnPlanDigest: request.plan.canonicalDigest,
            } as const)
            .finish(),
        ),
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
    ): Promise<string | undefined> => {
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
        // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
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
        // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
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
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
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
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
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
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
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
      const outcomeId = `${request.turnId}:outcome`;
      try {
        type SettledLearningTurn = Parameters<CapabilityCoordinator["observeSettledTurn"]>[0]["turn"];
        // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
        const reflection = await options.coordinator.observeSettledTurn({
          turn: Object.freeze(
            createConditionalObject({
              sessionId: request.sessionId,
              turnId: request.turnId,
              outcomeId,
              project: options.project,
              servedWorkingAdjustmentOutcomes: Object.freeze([]),
              scope: "global",
              userMessage: request.input,
            } satisfies Pick<
              SettledLearningTurn,
              | "sessionId"
              | "turnId"
              | "outcomeId"
              | "project"
              | "servedWorkingAdjustmentOutcomes"
              | "scope"
              | "userMessage"
            >)
              .addOptional(assistantMessage ? { assistantMessage } : undefined)
              .add({
                outcome: status === "failed" ? "failed" : "unknown",
                occurredAt: request.occurredAt,
                evidenceRefs: [...evidenceRefs],
                sensitivity: "normal" as const,
                telemetry: Object.freeze({
                  retryCount: 0,
                  toolFailureCount,
                  aborted,
                }),
              } satisfies Pick<
                SettledLearningTurn,
                "outcome" | "occurredAt" | "evidenceRefs" | "sensitivity" | "telemetry"
              >)
              .finish(),
          ),
          project: options.project,
          selectedCapabilities: serving,
        });
        return reflection.job.jobId;
      } catch (error) {
        try {
          await options.onReflectionFailure?.(
            error,
            Object.freeze({ sessionId: request.sessionId, turnId: request.turnId }),
          );
        } catch {
          // Reflection diagnostics must never rewrite an already-settled foreground result.
        }
        return undefined;
      }
    };
    let result: TurnResult;
    try {
      result = await request.execute();
    } catch (error) {
      await record("failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
    if (result.outcome === "aborted") {
      const reflectionJobId = await record(
        "failed",
        "Turn aborted",
        result.output,
        true,
        result.assistantMessages,
      );
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      return Object.freeze(
        createConditionalObject({
          result,
        } as const)
          .addOptional(reflectionJobId ? { reflectionJobId } : undefined)
          .finish(),
      );
    }
    const reflectionJobId = await record(
      "unknown",
      result.output,
      result.output,
      false,
      result.assistantMessages,
    );
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    return Object.freeze(
      createConditionalObject({
        result,
      } as const)
        .addOptional(reflectionJobId ? { reflectionJobId } : undefined)
        .finish(),
    );
  };
  return Object.freeze({ run });
}
