import type { FrozenTurnPlan } from "@noesis/agent-types";
import { canonicalJson, type JsonValue, sha256, toJsonValue, WorkingAdjustmentSchema } from "@noesis/domain";
import {
  type AuthorityBoundary,
  type AuthorityReceipt,
  type AuthorityReceiptVerifier,
  authorityOperationFields,
  createPreEffectExecutionFailure,
  type EffectDecision,
} from "@noesis/policy";
import { z } from "zod";
import type { McpConnectionCycleAllocator } from "./mcp-connection-cycles.ts";
import type {
  CompoundingMeasurementStore,
  NoesisWorkspaceStore,
  ProtectedTurnPlanStore,
  ProtectedWorkingAdjustmentStore,
  WorkingAdjustmentApplyResult,
  WorkingAdjustmentUnapplyResult,
} from "./types.ts";
import { isCapabilityBindingAdmissionConflictError } from "./types.ts";

type TurnPlanMutation = Pick<ProtectedTurnPlanStore, "admit">;
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
  readonly turnPlans: ProtectedTurnPlanStore;
  readonly measurements: CompoundingMeasurementStore;
  readonly workingAdjustments: ProtectedWorkingAdjustmentStore;
}

export interface WorkspaceRuntimeInternals {
  readonly authority: AuthorityBoundary;
  readonly mcpConnectionCycles: McpConnectionCycleAllocator;
  readonly protectedRuntime: ProtectedWorkspaceRuntime;
}

interface ProtectedMutationBinding {
  readonly effect: "promote";
  readonly resource: string;
  readonly idempotencyKey: string;
}

interface ReceiptGuardedProtectedMutations {
  readonly turnPlans: {
    readonly [Key in keyof TurnPlanMutation]: (
      binding: ProtectedMutationBinding,
      receipt: AuthorityReceipt,
      ...args: Parameters<TurnPlanMutation[Key]>
    ) => ReturnType<TurnPlanMutation[Key]>;
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
  readonly turnPlans: ProtectedTurnPlanStore;
  readonly measurements: CompoundingMeasurementStore;
  readonly workingAdjustments: ProtectedWorkingAdjustmentStore;
}

const runtimeInternals = new WeakMap<NoesisWorkspaceStore, WorkspaceRuntimeInternals>();

function workspaceResourceId(workspaceRoot: string): string {
  return `workspace:${sha256(workspaceRoot).slice(0, 24)}`;
}

function binding(workspaceId: string, resource: string, idempotencyKey: string): ProtectedMutationBinding {
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
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
  readonly turnPlans: TurnPlanMutation;
  readonly workingAdjustments: WorkingAdjustmentMutation;
}): ReceiptGuardedProtectedMutations {
  // BOUNDARY: This private wrapper preserves each exact mutation signature after receipt verification.
  const turnPlan = <Key extends keyof TurnPlanMutation>(
    method: Key,
  ): ReceiptGuardedProtectedMutations["turnPlans"][Key] =>
    // SAFETY: Key selects the same source and target mutation member; the wrapper only prepends receipt checks.
    ((mutation: ProtectedMutationBinding, receipt: AuthorityReceipt, ...args: unknown[]) => {
      assertMatchingReceipt(input.verifier, mutation, receipt);
      // BOUNDARY: Indexed mutation signatures are erased only inside this receipt-guarded dispatcher.
      // SAFETY: method selects this exact TurnPlanMutation member before its original arguments are forwarded.
      const invoke = input.turnPlans[method] as (...parameters: unknown[]) => unknown;
      return invoke(...args);
    }) as ReceiptGuardedProtectedMutations["turnPlans"][Key];
  // BOUNDARY: This private wrapper preserves each exact mutation signature after receipt verification.
  const workingAdjustment = <Key extends keyof WorkingAdjustmentMutation>(
    method: Key,
  ): ReceiptGuardedProtectedMutations["workingAdjustments"][Key] =>
    // SAFETY: Key selects the same source and target mutation member; the wrapper only prepends receipt checks.
    ((mutation: ProtectedMutationBinding, receipt: AuthorityReceipt, ...args: unknown[]) => {
      assertMatchingReceipt(input.verifier, mutation, receipt);
      // BOUNDARY: Indexed mutation signatures are erased only inside this receipt-guarded dispatcher.
      // SAFETY: method selects this exact WorkingAdjustmentMutation member before its original arguments are forwarded.
      const invoke = input.workingAdjustments[method] as (...parameters: unknown[]) => unknown;
      return invoke(...args);
    }) as ReceiptGuardedProtectedMutations["workingAdjustments"][Key];

  return Object.freeze({
    turnPlans: Object.freeze({ admit: turnPlan("admit") }),
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
): Promise<Result> {
  let result: Result | undefined;
  let completed = false;
  let callbackStarted = false;
  let callbackError: unknown;
  const decision = await authority.promote(mutation.resource, mutation.idempotencyKey, async (receipt) => {
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
    if (isCapabilityBindingAdmissionConflictError(callbackError)) throw callbackError;
    if (!callbackStarted) {
      try {
        const recovered = await rehydrate();
        if (recovered !== undefined) return recovered;
      } catch {
        // Preserve the original fail-closed authority decision when authoritative state
        // cannot be rehydrated.
      }
    }
    throw decisionFailure(decision);
  }
  if (!completed) {
    const replayed = await rehydrate();
    if (replayed === undefined)
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
  beforeExecute?: () => void,
): Promise<Result> {
  const authorize = authorityAction === "rollback" ? authority.rollback : authority.promote;
  const decision = await authorize(
    mutation.resource,
    mutation.idempotencyKey,
    async (receipt) => toJsonValue(await guarded(mutation, receipt)),
    beforeExecute === undefined ? undefined : Object.freeze({ beforeExecute }),
  );
  if (!decision.ok) throw decisionFailure(decision);
  return schema.parse(decision.value);
}

function workingAdjustmentIdempotencyKey(
  operation: "apply" | "unapply",
  identity: Readonly<Record<string, string | null>>,
): string {
  return `protected:working-adjustment:${operation}:${sha256(canonicalJson(identity))}`;
}

function assertWorkingAdjustmentMutationActive(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw createPreEffectExecutionFailure(
    "cancelled",
    "Working adjustment mutation was cancelled before protected state changed",
  );
}

async function reconcileApplyResult(
  store: WorkingAdjustmentInspection,
  request: Parameters<ProtectedWorkingAdjustmentStore["apply"]>[0],
  durableResult: WorkingAdjustmentApplyResult,
): Promise<WorkingAdjustmentApplyResult> {
  const active = await store.getActive(request.adjustment.scope.projectId);
  if (durableResult.status === "applied" && active?.adjustmentId === request.adjustment.adjustmentId)
    return durableResult;
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return Object.freeze({
    status: "stale" as const,
    adjustmentId: request.adjustment.adjustmentId,
    currentActiveAdjustmentId: active?.adjustmentId ?? null,
  });
}

async function reconcileUnapplyResult(
  store: WorkingAdjustmentInspection,
  request: Parameters<ProtectedWorkingAdjustmentStore["unapply"]>[0],
  durableResult: WorkingAdjustmentUnapplyResult,
): Promise<WorkingAdjustmentUnapplyResult> {
  const active = await store.getActive(request.projectId);
  if (durableResult.status === "unapplied" && active === undefined) return durableResult;
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return Object.freeze({
    status: "stale" as const,
    adjustmentId: request.expectedActiveAdjustmentId,
    currentActiveAdjustmentId: active?.adjustmentId ?? null,
  });
}

export function createProtectedWorkspaceRuntime(
  options: CreateProtectedWorkspaceRuntimeOptions,
): ProtectedWorkspaceRuntime {
  const workspaceId = workspaceResourceId(options.workspaceRoot);
  const guarded = createReceiptGuardedProtectedMutations({
    verifier: options.authority.receiptVerifier,
    turnPlans: options.turnPlans,
    workingAdjustments: options.workingAdjustments,
  });

  const turnPlans: ProtectedTurnPlanStore = Object.freeze({
    get: options.turnPlans.get,
    admit: async (plan: FrozenTurnPlan) =>
      await runAuthorized(
        options.authority,
        async (mutation, receipt) => await guarded.turnPlans.admit(mutation, receipt, plan),
        binding(
          workspaceId,
          `turn:${plan.sessionId}:${plan.turnId}:admit`,
          `protected:turn:admit:${plan.planId}:${plan.canonicalDigest}`,
        ),
        async () => await options.turnPlans.get(plan.sessionId, plan.turnId),
      ),
  });

  const workingAdjustments: ProtectedWorkingAdjustmentStore = Object.freeze({
    ...({
      get: options.workingAdjustments.get,
      getActive: options.workingAdjustments.getActive,
      list: options.workingAdjustments.list,
    } satisfies WorkingAdjustmentInspection),
    apply: async (request: Parameters<ProtectedWorkingAdjustmentStore["apply"]>[0]) => {
      assertWorkingAdjustmentMutationActive(request.signal);
      const durableResult = await runAuthorizedResult(
        options.authority,
        async (mutation, receipt) => {
          // Authority reservation can await after the coordinator's first cancellation check.
          // Keep the decisive check inside the receipt-guarded callback, directly before the
          // raw store method enters its synchronous SQLite transaction.
          assertWorkingAdjustmentMutationActive(request.signal);
          return await guarded.workingAdjustments.apply(mutation, receipt, request);
        },
        binding(
          workspaceId,
          `working-adjustment:${request.adjustment.scope.projectId}:apply:${request.adjustment.adjustmentId}`,
          workingAdjustmentIdempotencyKey("apply", {
            adjustmentId: request.adjustment.adjustmentId,
            expectedActiveAdjustmentId: request.expectedActiveAdjustmentId,
            projectId: request.adjustment.scope.projectId,
          }),
        ),
        WorkingAdjustmentApplyResultSchema,
        "promote",
        () => assertWorkingAdjustmentMutationActive(request.signal),
      );
      return await reconcileApplyResult(options.workingAdjustments, request, durableResult);
    },
    unapply: async (request: Parameters<ProtectedWorkingAdjustmentStore["unapply"]>[0]) => {
      assertWorkingAdjustmentMutationActive(request.signal);
      const durableResult = await runAuthorizedResult(
        options.authority,
        async (mutation, receipt) => {
          assertWorkingAdjustmentMutationActive(request.signal);
          return await guarded.workingAdjustments.unapply(mutation, receipt, request);
        },
        binding(
          workspaceId,
          `working-adjustment:${request.projectId}:unapply:${request.expectedActiveAdjustmentId}`,
          workingAdjustmentIdempotencyKey("unapply", {
            expectedActiveAdjustmentId: request.expectedActiveAdjustmentId,
            projectId: request.projectId,
          }),
        ),
        WorkingAdjustmentUnapplyResultSchema,
        "rollback",
        () => assertWorkingAdjustmentMutationActive(request.signal),
      );
      return await reconcileUnapplyResult(options.workingAdjustments, request, durableResult);
    },
  });

  return Object.freeze({
    turnPlans,
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
