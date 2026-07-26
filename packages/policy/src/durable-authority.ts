import {
  StableEffectOperationIdentitySchema,
  assertGrant,
  canonicalJson,
  createId,
  effectOperationFingerprint,
  sha256,
  toJsonValue,
  type EffectClass,
  type Grant,
  type JsonValue,
  type PermissionManifest,
  type Principal,
} from "@noesis/domain";
import type {
  AuthorityBoundary,
  AuthorityReceipt,
  AuthorityReceiptVerifier,
  EffectDecision,
  EffectRequest,
  GrantHandle,
} from "./index.ts";

export interface DurableAuthorityOperation {
  readonly identity: ReturnType<typeof StableEffectOperationIdentitySchema.parse>;
  readonly fingerprint: string;
  readonly estimatedCost: number;
}

export type DurableAuthorityReservation =
  | { readonly status: "reserved"; readonly grantId: string }
  | { readonly status: "completed"; readonly result: JsonValue }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "unresolved"; readonly reason: string }
  | { readonly status: "collision"; readonly reason: string }
  | { readonly status: "denied"; readonly reason: string };

/**
 * SQLite-backed production implementations satisfy this seam. Reservation and grant-budget
 * checks must happen in one transaction; callers never reconstruct authority from activity.
 */
export interface DurableAuthorityStatePort {
  readonly issueGrant: (grant: Grant) => Promise<void>;
  readonly getGrant: (grantId: string) => Promise<Grant | undefined>;
  readonly findSchedulerGrant: (jobId: string) => Promise<Grant | undefined>;
  readonly reserve: (
    operation: DurableAuthorityOperation,
    grantId: string | undefined,
  ) => Promise<DurableAuthorityReservation>;
  readonly complete: (request: {
    readonly operation: DurableAuthorityOperation;
    readonly grantId: string;
    readonly result: JsonValue;
    readonly receiptLineageId: string;
  }) => Promise<void>;
  readonly fail: (request: {
    readonly operation: DurableAuthorityOperation;
    readonly grantId: string;
    readonly reason: string;
    readonly receiptLineageId: string;
  }) => Promise<void>;
}

function operationFromRequest<T extends JsonValue>(request: EffectRequest<T>): DurableAuthorityOperation {
  const identity = StableEffectOperationIdentitySchema.parse({
    operationId: request.operationId,
    idempotencyKey: request.idempotencyKey,
    principal: request.principal,
    effect: request.effect,
    resource: request.resource,
    requestDigest: request.requestDigest,
  });
  return Object.freeze({
    identity,
    fingerprint: effectOperationFingerprint(identity),
    estimatedCost: request.estimatedCost,
  });
}

export function authorityOperationFields(
  principal: Principal,
  effect: EffectClass,
  resource: string,
  estimatedCost: number,
  idempotencyKey: string,
): Pick<EffectRequest<JsonValue>, "operationId" | "requestDigest"> {
  const requestDigest = sha256(canonicalJson({ principal, effect, resource, estimatedCost }));
  return Object.freeze({
    operationId: `operation_${sha256(canonicalJson({ idempotencyKey, requestDigest }))}`,
    requestDigest,
  });
}

/**
 * Production authority boundary. Authenticity remains process-local and closure-private while
 * grants, reservations, outcomes, budgets, collisions, and receipt lineage are durable.
 */
export function createDurableAuthorityBoundary(state: DurableAuthorityStatePort): AuthorityBoundary {
  const handles = new WeakSet<object>();
  const receipts = new WeakSet<object>();

  const createHandle = (grantId: string): GrantHandle => {
    const handle = Object.freeze({ grantId });
    handles.add(handle);
    return handle;
  };
  const createReceipt = (
    operation: DurableAuthorityOperation,
  ): { readonly receipt: AuthorityReceipt; readonly lineageId: string } => {
    const lineageId = `receipt_${sha256(
      canonicalJson({
        operationId: operation.identity.operationId,
        fingerprint: operation.fingerprint,
      }),
    ).slice(0, 32)}`;
    const receipt: AuthorityReceipt = Object.freeze({
      effect: operation.identity.effect,
      resource: operation.identity.resource,
      operationId: operation.identity.operationId,
    });
    receipts.add(receipt);
    return Object.freeze({ receipt, lineageId });
  };
  const verifier: AuthorityReceiptVerifier = Object.freeze({
    verify: (
      value: unknown,
      expected: {
        readonly effect: EffectClass;
        readonly resource: string;
        readonly operationId: string;
      },
    ): value is AuthorityReceipt =>
      typeof value === "object" &&
      value !== null &&
      receipts.has(value) &&
      "effect" in value &&
      "resource" in value &&
      "operationId" in value &&
      value.effect === expected.effect &&
      value.resource === expected.resource &&
      value.operationId === expected.operationId,
  });

  const issue = async (grant: Grant): Promise<GrantHandle> => {
    assertGrant(grant);
    await state.issueGrant(grant);
    return createHandle(grant.grantId);
  };

  const run = async <T extends JsonValue>(
    request: EffectRequest<T>,
    handle?: GrantHandle,
  ): Promise<EffectDecision<T>> => {
    const operation = operationFromRequest(request);
    const ownedHandle =
      typeof handle === "object" && handle !== null && handles.has(handle) ? handle : undefined;
    const reservation = await state.reserve(operation, ownedHandle?.grantId);
    if (reservation.status === "completed")
      return Object.freeze({
        ok: true,
        value: reservation.result as T,
        replayed: true,
      });
    if (reservation.status !== "reserved")
      return Object.freeze({
        ok: false,
        code:
          reservation.status === "collision"
            ? "collision"
            : reservation.status === "unresolved"
              ? "ambiguous"
              : reservation.status === "failed"
                ? "failed"
                : "denied",
        reason: reservation.reason,
      });
    const lineage = createReceipt(operation);
    try {
      const value = await request.execute(lineage.receipt);
      await state.complete({
        operation,
        grantId: reservation.grantId,
        result: toJsonValue(value),
        receiptLineageId: lineage.lineageId,
      });
      return Object.freeze({ ok: true, value, replayed: false });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await state.fail({
        operation,
        grantId: reservation.grantId,
        reason,
        receiptLineageId: lineage.lineageId,
      });
      return Object.freeze({ ok: false, code: "failed", reason });
    }
  };

  const runProtected = async <T extends JsonValue>(
    principal: Principal,
    effect: EffectClass,
    resource: string,
    cost: number,
    maxUses: number,
    idempotencyKey: string,
    execute: (receipt: AuthorityReceipt) => Promise<T>,
  ): Promise<EffectDecision<T>> => {
    const grant = await issue({
      schemaVersion: 1,
      grantId: createId("grant"),
      principal,
      effects: [effect],
      resourcePrefixes: [resource],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      maxUses,
      maxCost: cost,
    });
    return await run(
      {
        ...authorityOperationFields(principal, effect, resource, cost, idempotencyKey),
        principal,
        effect,
        resource,
        estimatedCost: cost,
        idempotencyKey,
        execute,
      },
      grant,
    );
  };

  const promote: AuthorityBoundary["promote"] = async (resource, idempotencyKey, execute) =>
    await runProtected("promoter", "promote", resource, 0, 1, idempotencyKey, execute);
  const rollback: AuthorityBoundary["rollback"] = async (resource, idempotencyKey, execute) =>
    await runProtected("promoter", "promote", resource, 0, 1, idempotencyKey, execute);
  const schedule: AuthorityBoundary["schedule"] = async (resource, idempotencyKey, execute) =>
    await runProtected("foreground", "schedule", resource, 0, 1, idempotencyKey, execute);

  const issueSchedulerGrant: AuthorityBoundary["issueSchedulerGrant"] = async (
    jobId,
    budget,
    expiresAt,
    receipt,
  ) => {
    if (
      !verifier.verify(receipt, {
        effect: "schedule",
        resource: `job:${jobId}:schedule`,
        operationId: receipt.operationId,
      })
    )
      throw new Error("Scheduler grant issuance requires an authorized scheduling receipt");
    const existing = await state.findSchedulerGrant(jobId);
    if (existing) return createHandle(existing.grantId);
    return await issue({
      schemaVersion: 1,
      grantId: createId("grant"),
      principal: "scheduler",
      effects: ["execute"],
      resourcePrefixes: [`job:${jobId}:`],
      expiresAt,
      maxUses: budget,
      maxCost: budget,
    });
  };

  const runScheduled: AuthorityBoundary["runScheduled"] = async (
    jobId,
    runNumber,
    operationFingerprint,
    execute,
  ) => {
    const grant = await state.findSchedulerGrant(jobId);
    const handle = grant ? createHandle(grant.grantId) : undefined;
    const principal = "scheduler" as const;
    const effect = "execute" as const;
    const resource = `job:${jobId}:runtime:${operationFingerprint}`;
    const estimatedCost = 1;
    const idempotencyKey = `job:${jobId}:run:${runNumber}`;
    return await run(
      {
        ...authorityOperationFields(principal, effect, resource, estimatedCost, idempotencyKey),
        principal,
        effect,
        resource,
        estimatedCost,
        idempotencyKey,
        execute,
      },
      handle,
    );
  };

  const permits = (permission: PermissionManifest, effect: EffectClass, resource: string): boolean => {
    if (!permission.effects.includes(effect)) return false;
    return permission.resourcePatterns.some((pattern) => {
      if (pattern === "*") return true;
      const wildcard = pattern.indexOf("*");
      return resource.startsWith(wildcard === -1 ? pattern : pattern.slice(0, wildcard));
    });
  };

  return Object.freeze({
    receiptVerifier: verifier,
    runForeground: async <T extends JsonValue>(
      request: Omit<EffectRequest<T>, "principal">,
      permission: PermissionManifest,
    ): Promise<EffectDecision<T>> => {
      if (!permits(permission, request.effect, request.resource))
        return Object.freeze({
          ok: false,
          code: "denied" as const,
          reason: `Frozen turn permission does not allow ${request.effect} on ${request.resource}`,
        });
      const grant = await issue({
        schemaVersion: 1,
        grantId: createId("grant"),
        principal: "foreground",
        effects: [request.effect],
        resourcePrefixes: [request.resource],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        maxUses: 1,
        maxCost: request.estimatedCost,
      });
      return await run(Object.freeze({ ...request, principal: "foreground" }), grant);
    },
    promote,
    rollback,
    schedule,
    issueSchedulerGrant,
    runScheduled,
  });
}
