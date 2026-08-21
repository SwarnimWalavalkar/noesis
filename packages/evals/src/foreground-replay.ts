import type { AgentMessage, AgentThinkingLevel, FrozenTurnPlan } from "@noesis/agent-types";
import {
  createConditionalObject,
  canonicalJson,
  err,
  ok,
  sha256,
  type CapabilityRevisionRef,
  type CompoundingReplayExclusionReason,
  type CompoundingReplayRecord,
  type CompoundingReplayRole,
  type CorrectionExposure,
  type DataSensitivity,
  type EvidenceRef,
  type EvidenceRevisionRef,
  type JsonValue,
  type Result,
} from "@noesis/domain";
import { z } from "zod";
import { BlindJudgmentSchema, type BlindJudgment } from "./dynamic-contracts.ts";
export interface ClassifiedReplayProvenance {
  readonly ref: EvidenceRef;
  readonly sensitivity: DataSensitivity;
}
export interface ForegroundReplayMessage extends AgentMessage {
  readonly sourceRef: EvidenceRef;
  readonly sensitivity: DataSensitivity;
}
export interface RecordedReplayToolResult {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly request: unknown;
  readonly response?: unknown;
  readonly status: "completed" | "failed" | "denied" | "ambiguous";
  readonly sourceRef: EvidenceRef;
  readonly sensitivity: DataSensitivity;
}
export interface ForegroundReplayArm {
  readonly systemPrompt: string;
  readonly capabilityRevisions: readonly CapabilityRevisionRef[];
  readonly immutableRefs: readonly EvidenceRef[];
  readonly inputTokens: number;
  readonly promptLayerBytes: number;
  readonly injectedContextTokens: number;
}
export interface PrivateReplayAuthorization {
  readonly policyId: string;
  readonly allowsPrivateReplay: boolean;
  readonly authorizedProviders: readonly string[];
}
export interface ForegroundReplayRoleBudget {
  readonly maximumTokens: number;
  readonly maximumCost: number;
}
export interface ForegroundReplayBudget {
  readonly budgetId: string;
  readonly maximumCalls: number;
  readonly maximumTokens: number;
  readonly maximumCost: number;
  readonly roles: Readonly<Record<CompoundingReplayRole, ForegroundReplayRoleBudget>>;
}
export interface ForegroundReplayInput {
  readonly replayId: string;
  readonly plan: FrozenTurnPlan;
  readonly outcome: "accepted" | "corrected" | "failed" | "unknown" | "aborted";
  readonly occurredAt: string;
  readonly scope: string;
  readonly scopeRelated: boolean;
  readonly modelCohort: string;
  readonly messages: readonly ForegroundReplayMessage[];
  readonly toolResults: readonly RecordedReplayToolResult[];
  readonly provenance: readonly ClassifiedReplayProvenance[];
  readonly privateAuthorization?: PrivateReplayAuthorization;
  readonly served: ForegroundReplayArm;
  readonly baseline: ForegroundReplayArm;
  readonly correctionExposures: readonly CorrectionExposure[];
  readonly budget: ForegroundReplayBudget;
}
export interface EffectFreeForegroundReplayRequest {
  readonly operationId: string;
  readonly replayId: string;
  readonly planId: string;
  readonly arm: "served" | "baseline";
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: AgentThinkingLevel;
  readonly systemPrompt: string;
  readonly messages: readonly AgentMessage[];
  readonly recordedToolResults: readonly {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly request: unknown;
    readonly response: unknown;
  }[];
}
export interface EffectFreeForegroundReplayResult {
  readonly text: string;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCost: number;
  readonly unexpectedEffects: readonly string[];
}
export const EffectFreeForegroundReplayResultSchema = z.strictObject({
  text: z.string(),
  provider: z.string().min(1),
  model: z.string().min(1),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  estimatedCost: z.number().nonnegative(),
  unexpectedEffects: z.array(z.string().min(1)),
}) satisfies z.ZodType<EffectFreeForegroundReplayResult>;
export interface EffectFreeForegroundReplayPort {
  /**
   * Runs with no live tools or EffectGateway. Recorded tool results are inert inputs; adapters must
   * report any attempted effect in `unexpectedEffects`.
   */
  readonly run: (request: EffectFreeForegroundReplayRequest) => Promise<EffectFreeForegroundReplayResult>;
}
export interface ForegroundReplayJudgeRequest {
  readonly operationId: string;
  readonly replayId: string;
  readonly planId: string;
  readonly scope: string;
  readonly messages: readonly AgentMessage[];
  readonly arms: Readonly<
    Record<
      "A" | "B",
      {
        readonly text: string;
      }
    >
  >;
}
export interface ForegroundReplayJudgeResult {
  readonly judgment: BlindJudgment;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCost: number;
}
export const ForegroundReplayJudgeResultSchema = z.strictObject({
  judgment: BlindJudgmentSchema,
  provider: z.string().min(1),
  model: z.string().min(1),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  estimatedCost: z.number().nonnegative(),
}) satisfies z.ZodType<ForegroundReplayJudgeResult>;
export interface ForegroundReplayJudgePort {
  readonly judge: (request: ForegroundReplayJudgeRequest) => Promise<ForegroundReplayJudgeResult>;
}
export type ForegroundReplayReservationResult =
  | {
      readonly status: "reserved";
    }
  | {
      readonly status: "denied";
      readonly reason: "budget_exhausted";
    }
  | {
      readonly status: "unresolved";
    }
  | {
      readonly status: "completed";
      readonly resultEvidence: EvidenceRevisionRef<"output" | "judgment">;
    }
  | {
      readonly status: "failed";
      readonly failure: string;
    };
export interface ForegroundReplayPersistencePort {
  readonly putBudget: (request: Omit<ForegroundReplayBudget, "roles">) => Promise<void>;
  readonly beginReplay: (request: {
    readonly replayId: string;
    readonly planId: string;
    readonly budgetId: string;
  }) => Promise<void>;
  readonly reserveRole: (request: {
    readonly operationId: string;
    readonly replayId: string;
    readonly role: CompoundingReplayRole;
    readonly requestDigest: string;
    readonly maximumTokens: number;
    readonly maximumCost: number;
  }) => Promise<ForegroundReplayReservationResult>;
  readonly completeRole: (request: {
    readonly operationId: string;
    readonly resultEvidence: EvidenceRevisionRef<"output" | "judgment">;
    readonly usedTokens: number;
    readonly actualCost: number;
  }) => Promise<void>;
  readonly failRole: (operationId: string, failure: string) => Promise<void>;
  readonly appendOutputEvidence: (request: {
    readonly replayId: string;
    readonly role: "served_arm" | "baseline_arm";
    readonly value: EffectFreeForegroundReplayResult;
    readonly provenanceRefs: readonly EvidenceRef[];
  }) => Promise<EvidenceRevisionRef<"output">>;
  readonly appendJudgmentEvidence: (request: {
    readonly replayId: string;
    readonly value: BlindJudgment;
    readonly provenanceRefs: readonly EvidenceRef[];
  }) => Promise<EvidenceRevisionRef<"judgment">>;
  readonly readEvidence: (ref: EvidenceRevisionRef<"output" | "judgment">) => Promise<JsonValue>;
  readonly record: (record: CompoundingReplayRecord) => Promise<void>;
}
export interface ForegroundReplayCoordinator {
  readonly consider: (input: ForegroundReplayInput) => Promise<
    Result<
      CompoundingReplayRecord,
      {
        readonly message: string;
      }
    >
  >;
}
function referenceKey(ref: EvidenceRef): string {
  return canonicalJson(ref);
}
function maximumSensitivity(values: readonly DataSensitivity[]): DataSensitivity {
  if (values.includes("secret")) return "secret";
  if (values.includes("private")) return "private";
  return "normal";
}
function revisionRefs(plan: FrozenTurnPlan): readonly EvidenceRef[] {
  return Object.freeze(
    plan.selectedCapabilities.flatMap((selection) => [
      ...selection.promptModules.map((material) => material.revision),
      ...selection.skills.map((material) => material.revision),
      ...selection.tools.map((material) => material.revision),
      selection.router.revision,
    ]),
  );
}
function sameRevisionSet(
  actual: readonly CapabilityRevisionRef[],
  expected: readonly CapabilityRevisionRef[],
): boolean {
  const keys = (values: readonly CapabilityRevisionRef[]) =>
    values.map((value) => canonicalJson(value)).sort();
  return canonicalJson(keys(actual)) === canonicalJson(keys(expected));
}
function eligibilityFailure(input: ForegroundReplayInput):
  | {
      readonly reason: CompoundingReplayExclusionReason;
      readonly detail: string;
    }
  | undefined {
  if (input.outcome === "aborted")
    return { reason: "aborted_turn", detail: "Aborted turns are not replayed" };
  if (input.outcome !== "accepted" && input.outcome !== "corrected")
    return {
      reason: "unsettled_outcome",
      detail: `Foreground outcome ${input.outcome} is not eligible for replay`,
    };
  if (input.plan.selectedCapabilities.some((selection) => selection.baseline.kind === "unknown_legacy"))
    return {
      reason: "unknown_legacy_baseline",
      detail: "At least one served revision has no replayable baseline",
    };
  const expectedServed = input.plan.selectedCapabilities.map((selection) => selection.revision);
  const expectedBaseline = input.plan.selectedCapabilities.flatMap((selection) =>
    selection.baseline.kind === "capability_revision" ? [selection.baseline.revision] : [],
  );
  if (
    input.served.systemPrompt !== input.plan.renderedSystemPrompt ||
    !sameRevisionSet(input.served.capabilityRevisions, expectedServed) ||
    !sameRevisionSet(input.baseline.capabilityRevisions, expectedBaseline)
  )
    return {
      reason: "identity_mismatch",
      detail: "Replay arms do not match the authoritative served and baseline plan identities",
    };
  const requiredRefs = [
    ...revisionRefs(input.plan),
    ...input.plan.retrievalCitations,
    ...input.messages.map((message) => message.sourceRef),
    ...input.toolResults.map((tool) => tool.sourceRef),
    ...input.served.immutableRefs,
    ...input.baseline.immutableRefs,
  ];
  const classified = new Map(input.provenance.map((item) => [referenceKey(item.ref), item.sensitivity]));
  const missing = requiredRefs.filter((ref) => !classified.has(referenceKey(ref)));
  if (missing.length > 0)
    return {
      reason: "missing_provenance_classification",
      detail: `${missing.length} replay provenance references have no sensitivity classification`,
    };
  const sensitivity = maximumSensitivity([
    ...input.provenance.map((item) => item.sensitivity),
    ...input.messages.map((message) => message.sensitivity),
    ...input.toolResults.map((tool) => tool.sensitivity),
  ]);
  if (sensitivity === "secret") return { reason: "secret_data", detail: "Secret data is never replayed" };
  if (
    sensitivity === "private" &&
    (!input.privateAuthorization?.allowsPrivateReplay ||
      input.privateAuthorization.policyId.length === 0 ||
      !input.privateAuthorization.authorizedProviders.includes(input.plan.provider))
  )
    return {
      reason: "private_data_unauthorized",
      detail: `Private replay is not authorized for provider ${input.plan.provider}`,
    };
  const incomplete = input.toolResults.find(
    (tool) => tool.status !== "completed" || !Object.hasOwn(tool, "response"),
  );
  if (incomplete)
    return {
      reason: "incomplete_tool_result",
      detail: `Tool result ${incomplete.toolCallId} is not complete and replayable`,
    };
  return undefined;
}
function baseRecord(input: ForegroundReplayInput) {
  return Object.freeze({
    replayId: input.replayId,
    planId: input.plan.planId,
    sessionId: input.plan.sessionId,
    turnId: input.plan.turnId,
    occurredAt: input.occurredAt,
    scope: input.scope,
    modelCohort: input.modelCohort,
    servedRevisions: Object.freeze([...input.served.capabilityRevisions]),
    baselineRevisions: Object.freeze([...input.baseline.capabilityRevisions]),
    scopeRelated: input.scopeRelated,
    correctionExposures: Object.freeze([...input.correctionExposures]),
  });
}
function excludedRecord(
  input: ForegroundReplayInput,
  reason: CompoundingReplayExclusionReason,
  detail: string,
): CompoundingReplayRecord {
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return Object.freeze({
    ...baseRecord(input),
    status: "excluded" as const,
    exclusionReason: reason,
    exclusionDetail: detail,
  });
}
export function foregroundReplayOperationIdentity(input: {
  readonly replayId: string;
  readonly role: CompoundingReplayRole;
  readonly request: unknown;
}): {
  readonly operationId: string;
  readonly requestDigest: string;
} {
  const requestDigest = sha256(canonicalJson(input.request));
  return Object.freeze({
    operationId: `replay_role_${sha256(canonicalJson({ replayId: input.replayId, role: input.role, requestDigest })).slice(0, 32)}`,
    requestDigest,
  });
}
export function foregroundReplayBlindLabels(
  replayId: string,
): Readonly<Record<"A" | "B", "served" | "baseline">> {
  const swap = Number.parseInt(sha256(replayId).slice(0, 2), 16) % 2 === 1;
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return Object.freeze(
    swap
      ? { A: "served" as const, B: "baseline" as const }
      : { A: "baseline" as const, B: "served" as const },
  );
}
function winnerFromBlind(
  winner: BlindJudgment["winner"],
  labels: Readonly<Record<"A" | "B", "served" | "baseline">>,
): "served" | "baseline" | "tie" | "inconclusive" {
  return winner === "A" || winner === "B" ? labels[winner] : winner;
}
function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
export function createForegroundReplayCoordinator(options: {
  readonly replay: EffectFreeForegroundReplayPort;
  readonly judge: ForegroundReplayJudgePort;
  readonly persistence: ForegroundReplayPersistencePort;
}): ForegroundReplayCoordinator {
  const consider = async (
    input: ForegroundReplayInput,
  ): Promise<
    Result<
      CompoundingReplayRecord,
      {
        readonly message: string;
      }
    >
  > => {
    await options.persistence.putBudget({
      budgetId: input.budget.budgetId,
      maximumCalls: input.budget.maximumCalls,
      maximumTokens: input.budget.maximumTokens,
      maximumCost: input.budget.maximumCost,
    });
    await options.persistence.beginReplay({
      replayId: input.replayId,
      planId: input.plan.planId,
      budgetId: input.budget.budgetId,
    });
    const exclude = async (
      reason: CompoundingReplayExclusionReason,
      detail: string,
    ): Promise<
      Result<
        CompoundingReplayRecord,
        {
          readonly message: string;
        }
      >
    > => {
      const record = excludedRecord(input, reason, detail);
      await options.persistence.record(record);
      return ok(record);
    };
    const ineligible = eligibilityFailure(input);
    if (ineligible) return await exclude(ineligible.reason, ineligible.detail);
    const evidenceRefs = Object.freeze([
      ...new Map(input.provenance.map((item) => [referenceKey(item.ref), item.ref])).values(),
    ]);
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    const messages = Object.freeze(
      input.messages.map(({ role, content, name }) =>
        Object.freeze(
          createConditionalObject({
            role,
            content,
          } as const)
            .addOptional(!(name === undefined) ? { name } : undefined)
            .finish(),
        ),
      ),
    );
    const recordedToolResults = Object.freeze(
      input.toolResults.map((tool) =>
        Object.freeze({
          toolCallId: tool.toolCallId,
          toolName: tool.toolName,
          request: tool.request,
          response: tool.response,
        }),
      ),
    );
    const runArm = async (
      role: "served_arm" | "baseline_arm",
      armName: "served" | "baseline",
      arm: ForegroundReplayArm,
    ): Promise<
      Result<
        {
          readonly result: EffectFreeForegroundReplayResult;
          readonly evidence: EvidenceRevisionRef<"output">;
        },
        {
          readonly reason: CompoundingReplayExclusionReason;
          readonly detail: string;
        }
      >
    > => {
      const requestBody = Object.freeze({
        replayId: input.replayId,
        planId: input.plan.planId,
        arm: armName,
        provider: input.plan.provider,
        model: input.plan.model,
        thinkingLevel: input.plan.thinkingLevel,
        systemPrompt: arm.systemPrompt,
        messages,
        recordedToolResults,
      });
      const identity = foregroundReplayOperationIdentity({
        replayId: input.replayId,
        role,
        request: requestBody,
      });
      const budget = input.budget.roles[role];
      const reservation = await options.persistence.reserveRole({
        ...identity,
        replayId: input.replayId,
        role,
        maximumTokens: budget.maximumTokens,
        maximumCost: budget.maximumCost,
      });
      if (reservation.status === "denied")
        return err({ reason: "budget_exhausted", detail: `${role} exceeded the replay budget` });
      if (reservation.status === "unresolved")
        return err({
          reason: "unresolved_reservation",
          detail: `${role} has a reservation with no unambiguous outcome`,
        });
      if (reservation.status === "failed") return err({ reason: "role_failed", detail: reservation.failure });
      if (reservation.status === "completed") {
        if (reservation.resultEvidence.evidenceKind !== "output")
          return err({ reason: "role_failed", detail: `${role} recorded non-output evidence` });
        // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
        const outputEvidence = Object.freeze({
          ...reservation.resultEvidence,
          evidenceKind: "output" as const,
        });
        const restored = EffectFreeForegroundReplayResultSchema.safeParse(
          await options.persistence.readEvidence(outputEvidence),
        );
        return restored.success
          ? ok({ result: restored.data, evidence: outputEvidence })
          : err({ reason: "role_failed", detail: `${role} recorded malformed evidence` });
      }
      const request: EffectFreeForegroundReplayRequest = Object.freeze({
        operationId: identity.operationId,
        ...requestBody,
      });
      try {
        const result = EffectFreeForegroundReplayResultSchema.parse(await options.replay.run(request));
        if (result.provider !== input.plan.provider || result.model !== input.plan.model) {
          await options.persistence.failRole(
            identity.operationId,
            "Replay runtime did not use the frozen model cohort",
          );
          return err({
            reason: "identity_mismatch",
            detail: `${role} returned ${result.provider}/${result.model}`,
          });
        }
        const evidence = await options.persistence.appendOutputEvidence({
          replayId: input.replayId,
          role,
          value: result,
          provenanceRefs: evidenceRefs,
        });
        await options.persistence.completeRole({
          operationId: identity.operationId,
          resultEvidence: evidence,
          usedTokens: result.inputTokens + result.outputTokens,
          actualCost: result.estimatedCost,
        });
        return ok({ result, evidence });
      } catch (error) {
        await options.persistence.failRole(identity.operationId, errorMessage(error));
        return err({ reason: "role_failed", detail: `${role}: ${errorMessage(error)}` });
      }
    };
    const served = await runArm("served_arm", "served", input.served);
    if (!served.ok) return await exclude(served.error.reason, served.error.detail);
    if (served.value.result.unexpectedEffects.length > 0)
      return await exclude(
        "unexpected_effect",
        `Served replay attempted: ${served.value.result.unexpectedEffects.join(", ")}`,
      );
    const baseline = await runArm("baseline_arm", "baseline", input.baseline);
    if (!baseline.ok) return await exclude(baseline.error.reason, baseline.error.detail);
    if (baseline.value.result.unexpectedEffects.length > 0)
      return await exclude(
        "unexpected_effect",
        `Baseline replay attempted: ${baseline.value.result.unexpectedEffects.join(", ")}`,
      );
    const labels = foregroundReplayBlindLabels(input.replayId);
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    const armOutput = {
      served: { text: served.value.result.text },
      baseline: { text: baseline.value.result.text },
    } as const;
    const judgeBody = Object.freeze({
      replayId: input.replayId,
      planId: input.plan.planId,
      scope: input.scope,
      messages,
      arms: Object.freeze({ A: armOutput[labels.A], B: armOutput[labels.B] }),
    });
    const judgeIdentity = foregroundReplayOperationIdentity({
      replayId: input.replayId,
      role: "judge",
      request: judgeBody,
    });
    const judgeBudget = input.budget.roles.judge;
    const judgeReservation = await options.persistence.reserveRole({
      ...judgeIdentity,
      replayId: input.replayId,
      role: "judge",
      maximumTokens: judgeBudget.maximumTokens,
      maximumCost: judgeBudget.maximumCost,
    });
    if (judgeReservation.status === "denied")
      return await exclude("budget_exhausted", "Judge exceeded the replay budget");
    if (judgeReservation.status === "unresolved")
      return await exclude("unresolved_reservation", "Judge has a reservation with no unambiguous outcome");
    if (judgeReservation.status === "failed") return await exclude("role_failed", judgeReservation.failure);
    let judgment: BlindJudgment;
    let judgmentEvidence: EvidenceRevisionRef<"judgment">;
    if (judgeReservation.status === "completed") {
      if (judgeReservation.resultEvidence.evidenceKind !== "judgment")
        return await exclude("role_failed", "Judge recorded non-judgment evidence");
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      const restoredJudgmentEvidence = Object.freeze({
        ...judgeReservation.resultEvidence,
        evidenceKind: "judgment" as const,
      });
      const restored = BlindJudgmentSchema.safeParse(
        await options.persistence.readEvidence(restoredJudgmentEvidence),
      );
      if (!restored.success) return await exclude("role_failed", "Judge recorded malformed evidence");
      judgment = restored.data;
      judgmentEvidence = restoredJudgmentEvidence;
    } else {
      try {
        const judged = ForegroundReplayJudgeResultSchema.parse(
          await options.judge.judge(Object.freeze({ operationId: judgeIdentity.operationId, ...judgeBody })),
        );
        if (judged.provider !== input.plan.provider || judged.model !== input.plan.model) {
          await options.persistence.failRole(
            judgeIdentity.operationId,
            "Replay judge did not use the frozen model cohort",
          );
          return await exclude("identity_mismatch", `Judge returned ${judged.provider}/${judged.model}`);
        }
        judgment = judged.judgment;
        judgmentEvidence = await options.persistence.appendJudgmentEvidence({
          replayId: input.replayId,
          value: judgment,
          provenanceRefs: Object.freeze([...evidenceRefs, served.value.evidence, baseline.value.evidence]),
        });
        await options.persistence.completeRole({
          operationId: judgeIdentity.operationId,
          resultEvidence: judgmentEvidence,
          usedTokens: judged.inputTokens + judged.outputTokens,
          actualCost: judged.estimatedCost,
        });
      } catch (error) {
        await options.persistence.failRole(judgeIdentity.operationId, errorMessage(error));
        return await exclude("role_failed", `judge: ${errorMessage(error)}`);
      }
    }
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    const record: CompoundingReplayRecord = Object.freeze({
      ...baseRecord(input),
      status: "paired" as const,
      winner: winnerFromBlind(judgment.winner, labels),
      railsPassed: judgment.violations.length === 0,
      servedOutputEvidence: served.value.evidence,
      baselineOutputEvidence: baseline.value.evidence,
      judgmentEvidence,
      servedInputTokens: input.served.inputTokens,
      baselineInputTokens: input.baseline.inputTokens,
      injectedContextTokens: input.served.injectedContextTokens,
      servedPromptLayerBytes: input.served.promptLayerBytes,
      baselinePromptLayerBytes: input.baseline.promptLayerBytes,
    });
    await options.persistence.record(record);
    return ok(record);
  };
  return Object.freeze({ consider });
}
