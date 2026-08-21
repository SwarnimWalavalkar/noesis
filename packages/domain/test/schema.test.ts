import { describe, expect, test } from "vitest";
import {
  ArtifactFileRefSchema,
  GrantSchema,
  LedgerEventSchema,
  StableEffectOperationAttemptSchema,
  assertLedgerEvent,
  durableJobFailureError,
  durableJobFailureFromError,
  effectOperationFingerprint,
  toJsonValue,
} from "../src/index.ts";

// SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
const ledgerEvent = {
  schemaVersion: 1,
  eventId: "evt-1",
  sequence: 1,
  occurredAt: "2026-01-01T00:00:00.000Z",
  principal: "system",
  type: "projection.rebuilt",
  payload: { nested: [null, true, 1, "value", { durable: true }] },
  previousChecksum: null,
  checksum: "a".repeat(64),
} as const;

describe("domain Zod schemas", () => {
  test("accepts the durable event shape and rejects unknown top-level keys with a JSON-pointer path", () => {
    expect(LedgerEventSchema.parse(ledgerEvent)).toEqual(ledgerEvent);
    expect(() => assertLedgerEvent({ ...ledgerEvent, unexpected: true })).toThrow("/unexpected");
  });

  test("preserves grant constraints and strict unknown-key rejection", () => {
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const grant = {
      schemaVersion: 1,
      grantId: "grant-1",
      principal: "foreground",
      effects: ["read"],
      resourcePrefixes: ["workspace:"],
      expiresAt: "2026-01-01T00:00:00.000Z",
      maxUses: 1,
      maxCost: 0,
    } as const;
    expect(GrantSchema.safeParse(grant).success).toBe(true);
    expect(GrantSchema.safeParse({ ...grant, maxUses: 0 }).success).toBe(false);
    expect(GrantSchema.safeParse({ ...grant, unexpected: true }).success).toBe(false);
  });

  test("accepts recursive JSON and rejects non-JSON values", () => {
    expect(toJsonValue({ values: [null, true, 1, "text"] })).toEqual({
      values: [null, true, 1, "text"],
    });
    expect(() => toJsonValue({ value: undefined })).toThrow();
    expect(() => toJsonValue(Number.POSITIVE_INFINITY)).toThrow();
  });

  test("rejects artifact paths that can escape their workspace", () => {
    const artifact = {
      kind: "artifact_file" as const,
      artifactId: "artifact-1",
      path: "artifacts/context.jsonl",
      mediaType: "application/x-ndjson",
    };

    expect(ArtifactFileRefSchema.safeParse(artifact).success).toBe(true);
    for (const path of [
      "/tmp/context.jsonl",
      "../context.jsonl",
      "artifacts/../../context.jsonl",
      "C:\\context.jsonl",
    ])
      expect(ArtifactFileRefSchema.safeParse({ ...artifact, path }).success).toBe(false);
  });

  test("binds stable effect-operation identity to the request authority tuple", () => {
    const attempt = StableEffectOperationAttemptSchema.parse({
      identity: {
        operationId: "operation-1",
        idempotencyKey: "send:message-1",
        principal: "foreground",
        effect: "network",
        resource: "provider:messages",
        requestDigest: "b".repeat(64),
      },
      estimatedCost: 1,
      attempt: 1,
    });
    const fingerprint = effectOperationFingerprint(attempt.identity);

    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(effectOperationFingerprint({ ...attempt.identity, resource: "provider:other-account" })).not.toBe(
      fingerprint,
    );
    expect(StableEffectOperationAttemptSchema.safeParse({ ...attempt, attempt: 0 }).success).toBe(false);
  });

  test("classifies only errors created by the private durable failure contract", () => {
    const failure = durableJobFailureError("retry the operation", {
      code: "transient_operation_failure",
      retryable: true,
    });
    Reflect.set(failure, "coordinatorCode", "forged_code");
    Reflect.set(failure, "coordinatorRetryable", false);
    Reflect.set(failure, Symbol.for("@noesis/domain/durable-job-failure"), {
      code: "forged_code",
      retryable: false,
      ambiguous: true,
    });

    const classified = durableJobFailureFromError(failure);
    expect(Object.isFrozen(classified)).toBe(true);
    expect(classified).toEqual({
      code: "transient_operation_failure",
      message: "retry the operation",
      retryable: true,
      ambiguous: false,
    });
    expect(
      durableJobFailureFromError(
        Object.assign(new Error("forged"), {
          coordinatorCode: "transient_operation_failure",
          coordinatorRetryable: true,
        }),
      ),
    ).toBeUndefined();
  });
});
