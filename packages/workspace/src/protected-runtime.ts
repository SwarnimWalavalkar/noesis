import { type JsonValue, sha256, toJsonValue, WorkingAdjustmentSchema } from "@noesis/domain";
import {
  type AuthorityBoundary,
  type AuthorityReceipt,
  type AuthorityReceiptVerifier,
  authorityOperationFields,
  type EffectDecision,
} from "@noesis/policy";
import { z } from "zod";
import type {
  ClassifyExperimentObservationsRequest,
  CommitExperimentOutcomeRequest,
  CompoundingMeasurementStore,
  ExperimentObservationRecord,
  ExperimentResearchRunRecord,
  NoesisWorkspaceStore,
  PrepareActivationOperationRequest,
  ProtectedActivationStore,
  ProtectedFeedbackStore,
  ProtectedWorkingAdjustmentStore,
  WorkingAdjustmentApplyResult,
  WorkingAdjustmentUnapplyResult,
} from "./types.ts";
import { isWorkingAdjustmentAdmissionConflictError } from "./types.ts";

type ActivationMutation = Pick<
  ProtectedActivationStore,
  | "prepare"
  | "supersede"
  | "decideApproval"
  | "commit"
  | "pinTurn"
  | "admitTurnPlan"
  | "bootstrapGenesis"
  | "recoverCommittedPublications"
>;

type ActivationInspection = Omit<ProtectedActivationStore, keyof ActivationMutation>;

type FeedbackMutation = Pick<
  ProtectedFeedbackStore,
  "recordObservation" | "classifyObservations" | "putResearchRun" | "commitOutcome"
>;

type FeedbackInspection = Omit<ProtectedFeedbackStore, keyof FeedbackMutation>;
type WorkingAdjustmentMutation = Pick<ProtectedWorkingAdjustmentStore, "apply" | "unapply">;
type WorkingAdjustmentInspection = Omit<ProtectedWorkingAdjustmentStore, keyof WorkingAdjustmentMutation>;

const WorkingAdjustmentApplyResultSchema: z.ZodType<WorkingAdjustmentApplyResult> = z.discriminatedUnion(
  "status",
  [
    z.strictObject({
      status: z.literal("applied"),
      adjustment: WorkingAdjustmentSchema,
      replacedAdjustmentId: z.string().min(1).nullable(),
    }),
    z.strictObject({
      status: z.literal("stale"),
      adjustmentId: z.string().min(1),
      currentActiveAdjustmentId: z.string().min(1).nullable(),
    }),
  ],
);

const WorkingAdjustmentUnapplyResultSchema: z.ZodType<WorkingAdjustmentUnapplyResult> = z.discriminatedUnion(
  "status",
  [
    z.strictObject({
      status: z.literal("unapplied"),
      adjustmentId: z.string().min(1),
    }),
    z.strictObject({
      status: z.literal("stale"),
      adjustmentId: z.string().min(1),
      currentActiveAdjustmentId: z.string().min(1).nullable(),
    }),
  ],
);

export interface ProtectedWorkspaceRuntime {
  readonly activations: ProtectedActivationStore;
  readonly feedback: ProtectedFeedbackStore;
  readonly measurements: CompoundingMeasurementStore;
  readonly workingAdjustments: ProtectedWorkingAdjustmentStore;
}

export interface WorkspaceRuntimeInternals {
  readonly authority: AuthorityBoundary;
  readonly protectedRuntime: ProtectedWorkspaceRuntime;
}

interface ProtectedMutationBinding {
  readonly effect: "promote";
  readonly resource: string;
  readonly idempotencyKey: string;
}

interface ReceiptGuardedProtectedMutations {
  readonly activations: {
    readonly [Key in keyof ActivationMutation]: (
      binding: ProtectedMutationBinding,
      receipt: AuthorityReceipt,
      ...args: Parameters<ActivationMutation[Key]>
    ) => ReturnType<ActivationMutation[Key]>;
  };
  readonly feedback: {
    readonly [Key in keyof FeedbackMutation]: (
      binding: ProtectedMutationBinding,
      receipt: AuthorityReceipt,
      ...args: Parameters<FeedbackMutation[Key]>
    ) => ReturnType<FeedbackMutation[Key]>;
  };
  readonly workingAdjustments: {
    readonly [Key in keyof WorkingAdjustmentMutation]: (
      binding: ProtectedMutationBinding,
      receipt: AuthorityReceipt,
      ...args: Parameters<WorkingAdjustmentMutation[Key]>
    ) => ReturnType<WorkingAdjustmentMutation[Key]>;
  };
}

interface CreateProtectedWorkspaceRuntimeOptions {
  readonly workspaceRoot: string;
  readonly authority: AuthorityBoundary;
  readonly activations: ProtectedActivationStore;
  readonly feedback: ProtectedFeedbackStore;
  readonly measurements: CompoundingMeasurementStore;
  readonly workingAdjustments: ProtectedWorkingAdjustmentStore;
}

const runtimeInternals = new WeakMap<NoesisWorkspaceStore, WorkspaceRuntimeInternals>();

function workspaceResourceId(workspaceRoot: string): string {
  return `workspace:${sha256(workspaceRoot).slice(0, 24)}`;
}

function binding(workspaceId: string, resource: string, idempotencyKey: string): ProtectedMutationBinding {
  return Object.freeze({
    effect: "promote" as const,
    resource: `${workspaceId}:${resource}`,
    idempotencyKey,
  });
}

function assertMatchingReceipt(
  verifier: AuthorityReceiptVerifier,
  mutation: ProtectedMutationBinding,
  receipt: AuthorityReceipt,
): void {
  const expected = authorityOperationFields(
    "promoter",
    mutation.effect,
    mutation.resource,
    0,
    mutation.idempotencyKey,
  );
  if (
    !verifier.verify(receipt, {
      effect: mutation.effect,
      resource: mutation.resource,
      operationId: expected.operationId,
    })
  )
    throw new Error(
      `Protected workspace mutation requires its exact authority receipt: ${mutation.resource}`,
    );
}

/**
 * Internal test seam for the inseparable verifier + raw mutation pair. Production callers receive
 * only createProtectedWorkspaceRuntime(), which mints and verifies receipts inside one closure.
 */
export function createReceiptGuardedProtectedMutations(input: {
  readonly verifier: AuthorityReceiptVerifier;
  readonly activations: ActivationMutation;
  readonly feedback: FeedbackMutation;
  readonly workingAdjustments: WorkingAdjustmentMutation;
}): ReceiptGuardedProtectedMutations {
  const activation = <Key extends keyof ActivationMutation>(
    method: Key,
  ): ReceiptGuardedProtectedMutations["activations"][Key] =>
    ((mutation: ProtectedMutationBinding, receipt: AuthorityReceipt, ...args: unknown[]) => {
      assertMatchingReceipt(input.verifier, mutation, receipt);
      const invoke = input.activations[method] as (...parameters: unknown[]) => unknown;
      return invoke(...args);
    }) as ReceiptGuardedProtectedMutations["activations"][Key];
  const feedback = <Key extends keyof FeedbackMutation>(
    method: Key,
  ): ReceiptGuardedProtectedMutations["feedback"][Key] =>
    ((mutation: ProtectedMutationBinding, receipt: AuthorityReceipt, ...args: unknown[]) => {
      assertMatchingReceipt(input.verifier, mutation, receipt);
      const invoke = input.feedback[method] as (...parameters: unknown[]) => unknown;
      return invoke(...args);
    }) as ReceiptGuardedProtectedMutations["feedback"][Key];
  const workingAdjustment = <Key extends keyof WorkingAdjustmentMutation>(
    method: Key,
  ): ReceiptGuardedProtectedMutations["workingAdjustments"][Key] =>
    ((mutation: ProtectedMutationBinding, receipt: AuthorityReceipt, ...args: unknown[]) => {
      assertMatchingReceipt(input.verifier, mutation, receipt);
      const invoke = input.workingAdjustments[method] as (...parameters: unknown[]) => unknown;
      return invoke(...args);
    }) as ReceiptGuardedProtectedMutations["workingAdjustments"][Key];

  return Object.freeze({
    activations: Object.freeze({
      prepare: activation("prepare"),
      supersede: activation("supersede"),
      decideApproval: activation("decideApproval"),
      commit: activation("commit"),
      pinTurn: activation("pinTurn"),
      admitTurnPlan: activation("admitTurnPlan"),
      bootstrapGenesis: activation("bootstrapGenesis"),
      recoverCommittedPublications: activation("recoverCommittedPublications"),
    }),
    feedback: Object.freeze({
      recordObservation: feedback("recordObservation"),
      classifyObservations: feedback("classifyObservations"),
      putResearchRun: feedback("putResearchRun"),
      commitOutcome: feedback("commitOutcome"),
    }),
    workingAdjustments: Object.freeze({
      apply: workingAdjustment("apply"),
      unapply: workingAdjustment("unapply"),
    }),
  });
}

function decisionFailure(decision: Extract<EffectDecision<JsonValue>, { readonly ok: false }>): Error {
  return new Error(`Protected workspace authority ${decision.code}: ${decision.reason}`);
}

async function runAuthorized<Result>(
  authority: AuthorityBoundary,
  guarded: (mutation: ProtectedMutationBinding, receipt: AuthorityReceipt) => Promise<Result>,
  mutation: ProtectedMutationBinding,
  rehydrate: () => Promise<Result | undefined>,
  acceptRehydrated: (result: Result) => boolean = () => true,
  recoverCurrentFailure = false,
  authorityAction: "promote" | "rollback" = "promote",
): Promise<Result> {
  let result: Result | undefined;
  let completed = false;
  let callbackStarted = false;
  let callbackError: unknown;
  const authorize = authorityAction === "rollback" ? authority.rollback : authority.promote;
  const decision = await authorize(mutation.resource, mutation.idempotencyKey, async (receipt) => {
    callbackStarted = true;
    try {
      result = await guarded(mutation, receipt);
      completed = true;
      return null;
    } catch (error) {
      callbackError = error;
      throw error;
    }
  });
  if (!decision.ok) {
    if (isWorkingAdjustmentAdmissionConflictError(callbackError)) throw callbackError;
    if (!callbackStarted || recoverCurrentFailure) {
      try {
        const recovered = await rehydrate();
        if (recovered !== undefined && acceptRehydrated(recovered)) return recovered;
      } catch {
        // Preserve the original fail-closed authority decision when authoritative state
        // cannot be rehydrated.
      }
    }
    throw decisionFailure(decision);
  }
  if (!completed) {
    const replayed = await rehydrate();
    if (replayed === undefined || !acceptRehydrated(replayed))
      throw new Error("Protected workspace mutation replayed without authoritative durable state");
    return replayed;
  }
  if (result === undefined)
    throw new Error("Protected workspace mutation completed without returning its result");
  return result;
}

async function runAuthorizedResult<Result>(
  authority: AuthorityBoundary,
  guarded: (mutation: ProtectedMutationBinding, receipt: AuthorityReceipt) => Promise<Result>,
  mutation: ProtectedMutationBinding,
  schema: z.ZodType<Result>,
  authorityAction: "promote" | "rollback" = "promote",
): Promise<Result> {
  const authorize = authorityAction === "rollback" ? authority.rollback : authority.promote;
  const decision = await authorize(mutation.resource, mutation.idempotencyKey, async (receipt) =>
    toJsonValue(await guarded(mutation, receipt)),
  );
  if (!decision.ok) throw decisionFailure(decision);
  return schema.parse(decision.value);
}

export function createProtectedWorkspaceRuntime(
  options: CreateProtectedWorkspaceRuntimeOptions,
): ProtectedWorkspaceRuntime {
  const workspaceId = workspaceResourceId(options.workspaceRoot);
  const guarded = createReceiptGuardedProtectedMutations({
    verifier: options.authority.receiptVerifier,
    activations: options.activations,
    feedback: options.feedback,
    workingAdjustments: options.workingAdjustments,
  });

  const activations: ProtectedActivationStore = Object.freeze({
    ...({
      getOperation: options.activations.getOperation,
      listOperations: options.activations.listOperations,
      getApproval: options.activations.getApproval,
      current: options.activations.current,
      getTurnPin: options.activations.getTurnPin,
      getTurnPlan: options.activations.getTurnPlan,
    } satisfies ActivationInspection),
    prepare: async (request: PrepareActivationOperationRequest) =>
      await runAuthorized(
        options.authority,
        async (mutation, receipt) => await guarded.activations.prepare(mutation, receipt, request),
        binding(
          workspaceId,
          `activation:${request.operationId}:prepare`,
          `protected:activation:prepare:${request.idempotencyKey}`,
        ),
        async () => await options.activations.getOperation(request.operationId),
      ),
    supersede: async (request: Parameters<ProtectedActivationStore["supersede"]>[0]) =>
      await runAuthorized(
        options.authority,
        async (mutation, receipt) => await guarded.activations.supersede(mutation, receipt, request),
        binding(
          workspaceId,
          `activation:${request.operationId}:supersede:${request.supersededByOperationId}`,
          `protected:activation:supersede:${request.operationId}:${request.supersededByOperationId}`,
        ),
        async () => await options.activations.getOperation(request.operationId),
      ),
    decideApproval: async (request: Parameters<ProtectedActivationStore["decideApproval"]>[0]) =>
      await runAuthorized(
        options.authority,
        async (mutation, receipt) => await guarded.activations.decideApproval(mutation, receipt, request),
        binding(
          workspaceId,
          `activation:${request.operationId}:approval:${request.decision}`,
          `protected:activation:approval:${request.approvalId}:${request.decision}:${request.bindingDigest}`,
        ),
        async () => await options.activations.getOperation(request.operationId),
      ),
    commit: async (request: Parameters<ProtectedActivationStore["commit"]>[0]) =>
      await runAuthorized(
        options.authority,
        async (mutation, receipt) => await guarded.activations.commit(mutation, receipt, request),
        binding(
          workspaceId,
          `activation:${request.operationId}:commit`,
          `protected:activation:commit:${request.operationId}:${request.bindingDigest}`,
        ),
        async () => await options.activations.getOperation(request.operationId),
        (operation) => operation.status === "committed",
      ),
    pinTurn: async (request: Parameters<ProtectedActivationStore["pinTurn"]>[0]) =>
      await runAuthorized(
        options.authority,
        async (mutation, receipt) => await guarded.activations.pinTurn(mutation, receipt, request),
        binding(
          workspaceId,
          `turn:${request.sessionId}:${request.turnId}:pin`,
          `protected:turn:pin:${request.sessionId}:${request.turnId}`,
        ),
        async () => await options.activations.getTurnPin(request.sessionId, request.turnId),
      ),
    admitTurnPlan: async (plan: Parameters<ProtectedActivationStore["admitTurnPlan"]>[0]) =>
      await runAuthorized(
        options.authority,
        async (mutation, receipt) => await guarded.activations.admitTurnPlan(mutation, receipt, plan),
        binding(
          workspaceId,
          `turn:${plan.sessionId}:${plan.turnId}:admit`,
          `protected:turn:admit:${plan.planId}:${plan.canonicalDigest}`,
        ),
        async () => await options.activations.getTurnPlan(plan.sessionId, plan.turnId),
      ),
    bootstrapGenesis: async (request: Parameters<ProtectedActivationStore["bootstrapGenesis"]>[0]) =>
      await runAuthorized(
        options.authority,
        async (mutation, receipt) => await guarded.activations.bootstrapGenesis(mutation, receipt, request),
        binding(
          workspaceId,
          `activation:genesis:${request.capabilityRevision.capabilityRevisionId}`,
          `protected:activation:genesis:${request.capabilityRevision.bundleDigest}`,
        ),
        options.activations.current,
      ),
    recoverCommittedPublications: async () =>
      await runAuthorized(
        options.authority,
        async (mutation, receipt) =>
          await guarded.activations.recoverCommittedPublications(mutation, receipt),
        binding(workspaceId, "activation:recover-publications", "protected:activation:recover-publications"),
        async () => 0,
      ),
  });

  const feedback: ProtectedFeedbackStore = Object.freeze({
    ...({
      operationForActivation: options.feedback.operationForActivation,
      getObservation: options.feedback.getObservation,
      getObservationClassification: options.feedback.getObservationClassification,
      listObservationsForOutcome: options.feedback.listObservationsForOutcome,
      listObservations: options.feedback.listObservations,
      getResearchRun: options.feedback.getResearchRun,
      listResearchRuns: options.feedback.listResearchRuns,
      getOutcome: options.feedback.getOutcome,
      getSuccessorInput: options.feedback.getSuccessorInput,
    } satisfies FeedbackInspection),
    recordObservation: async (
      record: Omit<ExperimentObservationRecord, "createdAt">,
      maximumObservations: number,
    ) =>
      await runAuthorized(
        options.authority,
        async (mutation, receipt) =>
          await guarded.feedback.recordObservation(mutation, receipt, record, maximumObservations),
        binding(
          workspaceId,
          `feedback:${record.experimentId}:observation:${record.observationId}`,
          `protected:feedback:observation:${record.dedupeKey}`,
        ),
        async () => await options.feedback.getObservation(record.observationId),
      ),
    classifyObservations: async (request: ClassifyExperimentObservationsRequest) =>
      await runAuthorized(
        options.authority,
        async (mutation, receipt) => await guarded.feedback.classifyObservations(mutation, receipt, request),
        binding(
          workspaceId,
          `feedback:outcome:${request.outcomeId}:classification:${request.classification}`,
          `protected:feedback:classification:${request.outcomeId}:${request.classification}`,
        ),
        async () => await options.feedback.getObservationClassification(request),
      ),
    putResearchRun: async (record: Omit<ExperimentResearchRunRecord, "createdAt" | "updatedAt">) =>
      await runAuthorized(
        options.authority,
        async (mutation, receipt) => await guarded.feedback.putResearchRun(mutation, receipt, record),
        binding(
          workspaceId,
          `feedback:${record.experimentId}:research:${record.runId}:${record.status}`,
          `protected:feedback:research:${record.runId}:${record.inputDigest}:${record.status}:${record.attempt}`,
        ),
        async () => await options.feedback.getResearchRun(record.runId),
        (run) =>
          run.status === record.status &&
          run.inputDigest === record.inputDigest &&
          run.attempt === record.attempt,
      ),
    commitOutcome: async (request: CommitExperimentOutcomeRequest) =>
      await runAuthorized(
        options.authority,
        async (mutation, receipt) => await guarded.feedback.commitOutcome(mutation, receipt, request),
        binding(
          workspaceId,
          // AuthorityBoundary.rollback intentionally uses the protected "promote" effect too:
          // the resource binds whether this transition keeps, revises, or restores state.
          `feedback:${request.experimentId}:outcome:${request.decision}`,
          `protected:feedback:outcome:${request.idempotencyKey}`,
        ),
        async () => await options.feedback.getOutcome(request.experimentId),
        (outcome) => outcome.operationId === request.operationId,
        true,
        request.decision === "revert" ? "rollback" : "promote",
      ),
  });

  const workingAdjustments: ProtectedWorkingAdjustmentStore = Object.freeze({
    ...({
      get: options.workingAdjustments.get,
      getActive: options.workingAdjustments.getActive,
      listSettledEvidence: options.workingAdjustments.listSettledEvidence,
    } satisfies WorkingAdjustmentInspection),
    apply: async (request: Parameters<ProtectedWorkingAdjustmentStore["apply"]>[0]) =>
      await runAuthorizedResult(
        options.authority,
        async (mutation, receipt) => await guarded.workingAdjustments.apply(mutation, receipt, request),
        binding(
          workspaceId,
          `working-adjustment:${request.adjustment.scope.projectId}:apply:${request.adjustment.adjustmentId}`,
          `protected:working-adjustment:apply:${request.adjustment.adjustmentId}`,
        ),
        WorkingAdjustmentApplyResultSchema,
      ),
    unapply: async (request: Parameters<ProtectedWorkingAdjustmentStore["unapply"]>[0]) =>
      await runAuthorizedResult(
        options.authority,
        async (mutation, receipt) => await guarded.workingAdjustments.unapply(mutation, receipt, request),
        binding(
          workspaceId,
          `working-adjustment:${request.projectId}:unapply:${request.expectedActiveAdjustmentId}`,
          `protected:working-adjustment:unapply:${request.expectedActiveAdjustmentId}`,
        ),
        WorkingAdjustmentUnapplyResultSchema,
        "rollback",
      ),
  });

  return Object.freeze({
    activations,
    feedback,
    measurements: options.measurements,
    workingAdjustments,
  });
}

export function registerWorkspaceRuntimeInternals(
  workspace: NoesisWorkspaceStore,
  internals: WorkspaceRuntimeInternals,
): void {
  if (runtimeInternals.has(workspace)) throw new Error("Workspace runtime internals were already registered");
  runtimeInternals.set(workspace, Object.freeze(internals));
}

/**
 * Composition-only accessor. This module is intentionally absent from the package export map.
 */
export function createWorkspaceRuntimeInternals(workspace: NoesisWorkspaceStore): WorkspaceRuntimeInternals {
  const internals = runtimeInternals.get(workspace);
  if (!internals) throw new Error("Workspace runtime internals are unavailable for this store");
  return internals;
}
