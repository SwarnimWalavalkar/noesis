import type { FrozenTurnPlan } from "@noesis/agent-types";
import { type JsonValue, sha256 } from "@noesis/domain";
import {
  type AuthorityBoundary,
  type AuthorityReceipt,
  type AuthorityReceiptVerifier,
  authorityOperationFields,
  type EffectDecision,
} from "@noesis/policy";
import type { McpConnectionCycleAllocator } from "./mcp-connection-cycles.ts";
import type { NoesisWorkspaceStore, ProtectedTurnPlanStore } from "./types.ts";
import { isCapabilityBindingAdmissionConflictError } from "./types.ts";

type TurnPlanMutation = Pick<ProtectedTurnPlanStore, "admit">;
export interface ProtectedWorkspaceRuntime {
  readonly turnPlans: ProtectedTurnPlanStore;
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
}

interface CreateProtectedWorkspaceRuntimeOptions {
  readonly workspaceRoot: string;
  readonly authority: AuthorityBoundary;
  readonly turnPlans: ProtectedTurnPlanStore;
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

  return Object.freeze({
    turnPlans: Object.freeze({ admit: turnPlan("admit") }),
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

export function createProtectedWorkspaceRuntime(
  options: CreateProtectedWorkspaceRuntimeOptions,
): ProtectedWorkspaceRuntime {
  const workspaceId = workspaceResourceId(options.workspaceRoot);
  const guarded = createReceiptGuardedProtectedMutations({
    verifier: options.authority.receiptVerifier,
    turnPlans: options.turnPlans,
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
        async () => {
          const existing = await options.turnPlans.get(plan.sessionId, plan.turnId);
          return existing?.planId === plan.planId && existing.canonicalDigest === plan.canonicalDigest
            ? existing
            : undefined;
        },
      ),
  });

  return Object.freeze({ turnPlans });
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
