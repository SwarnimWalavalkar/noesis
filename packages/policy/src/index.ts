import {
  assertGrant,
  createId,
  toJsonValue,
  type EffectClass,
  type Grant,
  type JsonValue,
  type Principal,
} from "@noesis/domain";
import { LedgerConflictError, type ExperienceLedger } from "@noesis/ledger";

export interface EffectRequest<T extends JsonValue> {
  readonly principal: Principal;
  readonly effect: EffectClass;
  readonly resource: string;
  readonly estimatedCost: number;
  readonly idempotencyKey: string;
  readonly execute: (receipt: AuthorityReceipt) => Promise<T>;
}

export type EffectDecision<T extends JsonValue> =
  | { readonly ok: true; readonly value: T; readonly replayed: boolean }
  | { readonly ok: false; readonly code: "denied" | "failed" | "ambiguous"; readonly reason: string };

export interface GrantHandle {
  readonly grantId: string;
}

export interface AuthorityReceipt {
  readonly effect: EffectClass;
  readonly resource: string;
}

export interface AuthorityReceiptVerifier {
  readonly isReceipt: (
    value: unknown,
    effect: EffectClass,
    resource: string,
    ledger: ExperienceLedger,
  ) => value is AuthorityReceipt;
}

interface AuthorityTokens {
  readonly createHandle: (grantId: string) => GrantHandle;
  readonly createReceipt: (effect: EffectClass, resource: string) => AuthorityReceipt;
  readonly ownsHandle: (value: unknown) => value is GrantHandle;
  readonly verifier: AuthorityReceiptVerifier;
}

function createAuthorityTokens(ownerLedger: ExperienceLedger): AuthorityTokens {
  const handles = new WeakSet<object>();
  const receipts = new WeakSet<object>();

  const createHandle = (grantId: string): GrantHandle => {
    const handle: GrantHandle = Object.freeze({ grantId });
    handles.add(handle);
    return handle;
  };

  const createReceipt = (effect: EffectClass, resource: string): AuthorityReceipt => {
    const receipt: AuthorityReceipt = Object.freeze({ effect, resource });
    receipts.add(receipt);
    return receipt;
  };

  const ownsHandle = (value: unknown): value is GrantHandle =>
    typeof value === "object" && value !== null && handles.has(value);

  const isReceipt = (
    value: unknown,
    effect: EffectClass,
    resource: string,
    ledger: ExperienceLedger,
  ): value is AuthorityReceipt =>
    ledger === ownerLedger &&
    typeof value === "object" &&
    value !== null &&
    receipts.has(value) &&
    "effect" in value &&
    "resource" in value &&
    value.effect === effect &&
    value.resource === resource;

  return Object.freeze({
    createHandle,
    createReceipt,
    ownsHandle,
    verifier: Object.freeze({ isReceipt }),
  });
}

function grantsFromLedger(ledger: ExperienceLedger): readonly Grant[] {
  return ledger.findByType("authority.grant_issued").flatMap((event) => {
    const grant = event.payload["grant"];
    try {
      assertGrant(grant);
      return [grant];
    } catch {
      return [];
    }
  });
}

export interface EffectGateway {
  run<T extends JsonValue>(request: EffectRequest<T>, handle?: GrantHandle): Promise<EffectDecision<T>>;
}

function createOwnedEffectGateway(ledger: ExperienceLedger, tokens: AuthorityTokens): EffectGateway {
  const deny = async <T extends JsonValue>(
    request: EffectRequest<T>,
    reason: string,
  ): Promise<EffectDecision<T>> => {
    await ledger.append({
      type: "effect.denied",
      principal: request.principal,
      payload: {
        effect: request.effect,
        resource: request.resource,
        idempotencyKey: request.idempotencyKey,
        reason,
      },
    });
    return { ok: false, code: "denied", reason };
  };

  const run = async <T extends JsonValue>(
    request: EffectRequest<T>,
    handle?: GrantHandle,
  ): Promise<EffectDecision<T>> => {
    const completion = ledger
      .findByType("effect.completed")
      .find((event) => event.payload["idempotencyKey"] === request.idempotencyKey);
    if (completion) {
      // The completion payload is schema-validated JSON; T is the caller's declared JSON result contract.
      return { ok: true, value: completion.payload["result"] as T, replayed: true };
    }
    const reservation = ledger
      .findByType("effect.reserved")
      .find((event) => event.payload["idempotencyKey"] === request.idempotencyKey);
    if (reservation) {
      const reason = "A durable reservation exists without a completion; execution outcome is ambiguous";
      await ledger.append({
        type: "effect.denied",
        principal: request.principal,
        payload: {
          effect: request.effect,
          resource: request.resource,
          reason,
          idempotencyKey: request.idempotencyKey,
        },
      });
      return { ok: false, code: "ambiguous", reason };
    }

    await ledger.append({
      type: "effect.requested",
      principal: request.principal,
      payload: {
        effectId: createId("effect"),
        effect: request.effect,
        resource: request.resource,
        idempotencyKey: request.idempotencyKey,
        estimatedCost: request.estimatedCost,
      },
    });

    if (!tokens.ownsHandle(handle)) return await deny(request, "No authority handle was supplied");

    for (;;) {
      const expectedSequence = ledger.readAll().length;
      const concurrentCompletion = ledger
        .findByType("effect.completed")
        .find((event) => event.payload["idempotencyKey"] === request.idempotencyKey);
      if (concurrentCompletion)
        return { ok: true, value: concurrentCompletion.payload["result"] as T, replayed: true };
      const concurrentReservation = ledger
        .findByType("effect.reserved")
        .find((event) => event.payload["idempotencyKey"] === request.idempotencyKey);
      if (concurrentReservation) {
        return {
          ok: false,
          code: "ambiguous",
          reason: "A concurrent durable reservation already owns this idempotency key",
        };
      }
      const grants = grantsFromLedger(ledger);
      const grant = grants.find((candidate) => candidate.grantId === handle.grantId);
      const reservations = ledger
        .findByType("effect.reserved")
        .filter((event) => event.payload["grantId"] === grant?.grantId);
      const usedCost = reservations.reduce(
        (sum, event) => sum + Number(event.payload["estimatedCost"] ?? 0),
        0,
      );
      if (
        !grant ||
        grant.principal !== request.principal ||
        !grant.effects.includes(request.effect) ||
        !grant.resourcePrefixes.some((prefix) => request.resource.startsWith(prefix)) ||
        new Date(grant.expiresAt) <= new Date() ||
        reservations.length >= grant.maxUses ||
        usedCost + request.estimatedCost > grant.maxCost
      ) {
        return await deny(
          request,
          "No unexpired durable grant covers this principal, effect, resource, usage, and cost budget",
        );
      }
      try {
        await ledger.append(
          {
            type: "effect.reserved",
            principal: request.principal,
            payload: {
              reservationId: createId("reservation"),
              grantId: grant.grantId,
              effect: request.effect,
              resource: request.resource,
              idempotencyKey: request.idempotencyKey,
              estimatedCost: request.estimatedCost,
            },
          },
          expectedSequence,
        );
        break;
      } catch (error) {
        if (error instanceof LedgerConflictError) continue;
        throw error;
      }
    }

    try {
      const value = await request.execute(tokens.createReceipt(request.effect, request.resource));
      await ledger.append({
        type: "effect.completed",
        principal: request.principal,
        payload: {
          effect: request.effect,
          resource: request.resource,
          idempotencyKey: request.idempotencyKey,
          grantId: handle.grantId,
          result: toJsonValue(value),
        },
      });
      return { ok: true, value, replayed: false };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await ledger.append({
        type: "effect.failed",
        principal: request.principal,
        payload: {
          effect: request.effect,
          resource: request.resource,
          idempotencyKey: request.idempotencyKey,
          grantId: handle.grantId,
          reason,
        },
      });
      return { ok: false, code: "failed", reason };
    }
  };

  return Object.freeze({ run });
}

export function createEffectGateway(ledger: ExperienceLedger): EffectGateway {
  return createOwnedEffectGateway(ledger, createAuthorityTokens(ledger));
}

/**
 * The only grant issuer. It exposes operation-shaped methods, never arbitrary grant minting.
 * Keep this boundary private inside NoesisRuntime; callers receive decisions, not grant material.
 */
export interface AuthorityBoundary {
  readonly receiptVerifier: AuthorityReceiptVerifier;
  promote<T extends JsonValue>(
    resource: string,
    idempotencyKey: string,
    execute: (receipt: AuthorityReceipt) => Promise<T>,
  ): Promise<EffectDecision<T>>;
  rollback<T extends JsonValue>(
    resource: string,
    idempotencyKey: string,
    execute: (receipt: AuthorityReceipt) => Promise<T>,
  ): Promise<EffectDecision<T>>;
  schedule<T extends JsonValue>(
    resource: string,
    idempotencyKey: string,
    execute: (receipt: AuthorityReceipt) => Promise<T>,
  ): Promise<EffectDecision<T>>;
  issueSchedulerGrant(
    jobId: string,
    budget: number,
    expiresAt: string,
    receipt: AuthorityReceipt,
  ): Promise<GrantHandle>;
  schedulerHandle(jobId: string): GrantHandle | undefined;
  runScheduled<T extends JsonValue>(
    jobId: string,
    runNumber: number,
    execute: (receipt: AuthorityReceipt) => Promise<T>,
  ): Promise<EffectDecision<T>>;
}

export function createAuthorityBoundary(ledger: ExperienceLedger): AuthorityBoundary {
  const tokens = createAuthorityTokens(ledger);
  const gateway = createOwnedEffectGateway(ledger, tokens);

  const issue = async (grant: Grant): Promise<GrantHandle> => {
    assertGrant(grant);
    await ledger.append({
      type: "authority.grant_issued",
      principal: "system",
      payload: { grant: toJsonValue(grant) },
    });
    return tokens.createHandle(grant.grantId);
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
    return await gateway.run(
      { principal, effect, resource, estimatedCost: cost, idempotencyKey, execute },
      grant,
    );
  };

  const promote = async <T extends JsonValue>(
    resource: string,
    idempotencyKey: string,
    execute: (receipt: AuthorityReceipt) => Promise<T>,
  ): Promise<EffectDecision<T>> =>
    await runProtected("promoter", "promote", resource, 0, 1, idempotencyKey, execute);

  const rollback = async <T extends JsonValue>(
    resource: string,
    idempotencyKey: string,
    execute: (receipt: AuthorityReceipt) => Promise<T>,
  ): Promise<EffectDecision<T>> =>
    await runProtected("promoter", "promote", resource, 0, 1, idempotencyKey, execute);

  const schedule = async <T extends JsonValue>(
    resource: string,
    idempotencyKey: string,
    execute: (receipt: AuthorityReceipt) => Promise<T>,
  ): Promise<EffectDecision<T>> =>
    await runProtected("foreground", "schedule", resource, 0, 1, idempotencyKey, execute);

  const issueSchedulerGrant = async (
    jobId: string,
    budget: number,
    expiresAt: string,
    receipt: AuthorityReceipt,
  ): Promise<GrantHandle> => {
    if (!tokens.verifier.isReceipt(receipt, "schedule", `job:${jobId}:schedule`, ledger))
      throw new Error("Scheduler grant issuance requires an authorized scheduling receipt");
    const existing = grantsFromLedger(ledger).find(
      (grant) => grant.principal === "scheduler" && grant.resourcePrefixes.includes(`job:${jobId}:`),
    );
    if (existing) return tokens.createHandle(existing.grantId);
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

  const schedulerHandle = (jobId: string): GrantHandle | undefined => {
    const grant = grantsFromLedger(ledger).find(
      (candidate) =>
        candidate.principal === "scheduler" && candidate.resourcePrefixes.includes(`job:${jobId}:`),
    );
    return grant ? tokens.createHandle(grant.grantId) : undefined;
  };

  const runScheduled = async <T extends JsonValue>(
    jobId: string,
    runNumber: number,
    execute: (receipt: AuthorityReceipt) => Promise<T>,
  ): Promise<EffectDecision<T>> => {
    const handle = schedulerHandle(jobId);
    return await gateway.run(
      {
        principal: "scheduler",
        effect: "execute",
        resource: `job:${jobId}:runtime`,
        estimatedCost: 1,
        idempotencyKey: `job:${jobId}:run:${runNumber}`,
        execute,
      },
      handle,
    );
  };

  return Object.freeze({
    receiptVerifier: tokens.verifier,
    promote,
    rollback,
    schedule,
    issueSchedulerGrant,
    schedulerHandle,
    runScheduled,
  });
}
