import type { FrozenTurnPlan } from "@noesis/agent-types";
import type { Capability, CapabilityRevisionRef, EvidenceRef } from "@noesis/domain";
import { detectExplicitCorrection } from "@noesis/learning";
import type { NoesisWorkspaceStore } from "@noesis/workspace";
import type { ContinuousFeedbackController } from "./continuous-feedback.ts";
import type { RuntimeControlPlane } from "./control-plane.ts";
import type { TurnResult } from "./index.ts";

export interface TurnSettlementRequest {
  readonly sessionId: string;
  readonly turnId: string;
  readonly input: string;
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
    const correction = detectExplicitCorrection(request.input);
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
          frozenTurnPlanId: request.plan.planId,
          frozenTurnPlanDigest: request.plan.canonicalDigest,
        }),
      }),
    );
    const serving = request.plan.selectedCapabilities.map((selection) => selection.revision);

    const record = async (
      status: "accepted" | "corrected" | "failed",
      summary: string,
      assistantMessage?: string,
      aborted = false,
    ): Promise<void> => {
      const assistantRef = assistantMessage
        ? await options.workspace.operational.messages.put(
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
          )
        : undefined;
      const evidenceRefs: readonly EvidenceRef[] = Object.freeze([
        userRef,
        ...(assistantRef ? [assistantRef] : []),
      ]);
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
        ...(correction.corrected
          ? {
              signal: {
                kind: "explicit_correction",
                scope: "general",
                strength: 1,
                novelty: 0.8,
              },
            }
          : {}),
        metrics: Object.freeze({ failed: status === "failed" }),
      });
      const routedSelection = [...request.plan.selectedCapabilities]
        .sort(
          (left, right) =>
            (left.scope === "general" ? 0 : left.scope.length) -
            (right.scope === "general" ? 0 : right.scope.length),
        )
        .at(-1);
      if (!routedSelection) return;
      const baseline = routedSelection.revision;
      const capability = options.resolveCapability(routedSelection.capabilityId);
      if (!capability) return;
      await options.controlPlane.observeCompletedTurn({
        turn: Object.freeze({
          sessionId: request.sessionId,
          turnId: request.turnId,
          scope: capability.scope,
          userMessage: request.input,
          ...(assistantMessage ? { assistantMessage } : {}),
          ...(correction.corrected ? { correction: request.input } : {}),
          outcome: status,
          occurredAt: request.occurredAt,
          evidenceRefs: [...evidenceRefs],
          sensitivity: "normal" as const,
          telemetry: Object.freeze({
            retryCount: 0,
            toolFailureCount: status === "failed" ? 1 : 0,
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
      await record("failed", "Turn aborted", result.output, true);
      return result;
    }
    await record(correction.corrected ? "corrected" : "accepted", result.output, result.output);
    return result;
  };

  return Object.freeze({ run });
}
