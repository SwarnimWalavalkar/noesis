import type { EffectClass, JsonValue, Principal } from "@noesis/domain";

export * from "./durable-authority.ts";

export interface EffectRequest<T extends JsonValue> {
  readonly operationId: string;
  readonly principal: Principal;
  readonly effect: EffectClass;
  readonly resource: string;
  readonly estimatedCost: number;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly execute: (receipt: AuthorityReceipt) => Promise<T>;
}

export type EffectDecision<T extends JsonValue> =
  | { readonly ok: true; readonly value: T; readonly replayed: boolean }
  | {
      readonly ok: false;
      readonly code: "denied" | "failed" | "ambiguous" | "collision";
      readonly reason: string;
    };

export interface GrantHandle {
  readonly grantId: string;
}

export interface AuthorityReceipt {
  readonly effect: EffectClass;
  readonly resource: string;
  readonly operationId: string;
}

export interface AuthorityReceiptVerifier {
  readonly verify: (
    value: unknown,
    expected: {
      readonly effect: EffectClass;
      readonly resource: string;
      readonly operationId: string;
    },
  ) => value is AuthorityReceipt;
}

export interface EffectGateway {
  run<T extends JsonValue>(request: EffectRequest<T>, handle?: GrantHandle): Promise<EffectDecision<T>>;
}

/** The only production grant and receipt issuer. Callers receive operation-shaped decisions. */
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
  runScheduled<T extends JsonValue>(
    jobId: string,
    runNumber: number,
    operationFingerprint: string,
    execute: (receipt: AuthorityReceipt) => Promise<T>,
  ): Promise<EffectDecision<T>>;
}
