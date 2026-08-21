import type { Grant, JsonValue } from "@noesis/domain";
import { describe, expect, test } from "vitest";
import {
  createEffectExecutionFailure,
  createDurableAuthorityBoundary,
  createPreEffectExecutionFailure,
  parseEffectExecutionError,
  parseEffectExecutionFailure,
  serializeEffectExecutionFailure,
  type DurableAuthorityOperation,
  type DurableAuthorityReservation,
  type DurableAuthorityStatePort,
} from "../src/index.ts";

interface StoredOperation {
  readonly operation: DurableAuthorityOperation;
  readonly grantId: string;
  status: "reserved" | "completed" | "failed";
  result?: JsonValue;
  reason?: string;
}

// BOUNDARY: This test double observes opaque receipt payloads emitted by the authority contract.
function receiptOperationId(value: unknown): string {
  return typeof value === "object" &&
    value !== null &&
    "operationId" in value &&
    typeof value.operationId === "string"
    ? value.operationId
    : "";
}

function createInMemoryDurableAuthorityState(
  onGrantIssued: () => void = () => undefined,
): DurableAuthorityStatePort {
  const grants = new Map<string, Grant>();
  const operations = new Map<string, StoredOperation>();
  const usedByGrant = new Map<string, number>();
  const issueGrant = async (grant: Grant): Promise<void> => {
    onGrantIssued();
    grants.set(grant.grantId, grant);
  };
  const replayExisting = (operation: DurableAuthorityOperation): DurableAuthorityReservation | undefined => {
    const existing = operations.get(operation.identity.idempotencyKey);
    if (!existing) return undefined;
    if (existing.operation.fingerprint !== operation.fingerprint)
      return { status: "collision", reason: "Idempotency key fingerprint collision" };
    if (existing.status === "reserved")
      return { status: "unresolved", reason: "Prior reservation has no unambiguous outcome" };
    if (existing.status === "completed") return { status: "completed", result: existing.result ?? null };
    return { status: "failed", reason: existing.reason ?? "Prior operation failed" };
  };
  const reserve = async (
    operation: DurableAuthorityOperation,
    grantId: string | undefined,
  ): Promise<DurableAuthorityReservation> => {
    const replay = replayExisting(operation);
    if (replay) return replay;
    const grant = grantId === undefined ? undefined : grants.get(grantId);
    if (
      !grant ||
      grant.principal !== operation.identity.principal ||
      !grant.effects.includes(operation.identity.effect) ||
      !grant.resourcePrefixes.some((prefix) => operation.identity.resource.startsWith(prefix))
    )
      return { status: "denied", reason: "No matching durable grant" };
    const uses = usedByGrant.get(grant.grantId) ?? 0;
    if (uses >= grant.maxUses) return { status: "denied", reason: "Grant budget exhausted" };
    usedByGrant.set(grant.grantId, uses + 1);
    operations.set(operation.identity.idempotencyKey, {
      operation,
      grantId: grant.grantId,
      status: "reserved",
    });
    return { status: "reserved", grantId: grant.grantId };
  };
  return Object.freeze({
    issueGrant,
    getGrant: async (grantId: string) => grants.get(grantId),
    findSchedulerGrant: async (jobId: string) =>
      [...grants.values()].find(
        (grant) => grant.principal === "scheduler" && grant.resourcePrefixes.includes(`job:${jobId}:`),
      ),
    reserveWithGrant: async (operation: DurableAuthorityOperation, grant: Grant) => {
      const replay = replayExisting(operation);
      if (replay) return replay;
      onGrantIssued();
      grants.set(grant.grantId, grant);
      return await reserve(operation, grant.grantId);
    },
    reserve,
    complete: async ({ operation, result }: Parameters<DurableAuthorityStatePort["complete"]>[0]) => {
      const stored = operations.get(operation.identity.idempotencyKey);
      if (!stored) throw new Error("Cannot complete an unreserved operation");
      stored.status = "completed";
      stored.result = result;
    },
    fail: async ({ operation, reason }: Parameters<DurableAuthorityStatePort["fail"]>[0]) => {
      const stored = operations.get(operation.identity.idempotencyKey);
      if (!stored) throw new Error("Cannot fail an unreserved operation");
      stored.status = "failed";
      stored.reason = reason;
    },
    abandon: async ({
      operation,
      grantId,
      discardGrant,
    }: Parameters<DurableAuthorityStatePort["abandon"]>[0]) => {
      const stored = operations.get(operation.identity.idempotencyKey);
      if (
        !stored ||
        stored.status !== "reserved" ||
        stored.operation.fingerprint !== operation.fingerprint ||
        stored.grantId !== grantId
      )
        throw new Error("Cannot abandon an unreserved operation");
      operations.delete(operation.identity.idempotencyKey);
      usedByGrant.set(grantId, Math.max(0, (usedByGrant.get(grantId) ?? 0) - 1));
      if (discardGrant) grants.delete(grantId);
    },
  });
}

describe("durable authority boundary", () => {
  test("replays typed failures written by the v1 durable encoding", () => {
    const reason = 'noesis-effect-failure-v1:{"code":"cancelled","message":"legacy cancellation"}';

    expect(parseEffectExecutionFailure(reason)).toEqual({
      code: "cancelled",
      message: "legacy cancellation",
    });
    expect(parseEffectExecutionError(reason)).toEqual({
      code: "cancelled",
      message: "legacy cancellation",
    });
  });

  test("foreground effects cannot widen the frozen turn permission", async () => {
    const authority = createDurableAuthorityBoundary(createInMemoryDurableAuthorityState());
    let executions = 0;
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const request = Object.freeze({
      operationId: "operation-foreground-write",
      effect: "write" as const,
      resource: "file:notes.md",
      estimatedCost: 1,
      idempotencyKey: "foreground-write",
      requestDigest: "a".repeat(64),
      execute: async () => {
        executions += 1;
        return null;
      },
    });

    await expect(
      authority.runForeground(request, {
        effects: ["read"],
        resourcePatterns: ["file:"],
        credentialRefs: [],
      }),
    ).resolves.toMatchObject({ ok: false, code: "denied" });
    await expect(
      authority.runForeground(request, {
        effects: ["write"],
        resourcePatterns: ["file:"],
        credentialRefs: [],
      }),
    ).resolves.toMatchObject({ ok: false, code: "denied" });
    await expect(
      authority.runForeground(request, {
        effects: ["write"],
        resourcePatterns: ["file:*"],
        credentialRefs: [],
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(executions).toBe(1);
  });

  test("accepts only exact resources or one trailing wildcard and fails closed otherwise", async () => {
    const authority = createDurableAuthorityBoundary(createInMemoryDurableAuthorityState());
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const request = Object.freeze({
      operationId: "operation-permission-pattern",
      effect: "read" as const,
      resource: "file:/workspace/notes.md",
      estimatedCost: 0,
      idempotencyKey: "permission-pattern",
      requestDigest: "b".repeat(64),
      execute: async () => null,
    });

    for (const pattern of ["", "*", "*notes.md", "file:*:notes.md", "file:**"])
      await expect(
        authority.runForeground(request, {
          effects: ["read"],
          resourcePatterns: [pattern],
          credentialRefs: [],
        }),
      ).resolves.toMatchObject({ ok: false, code: "denied" });

    await expect(
      authority.runForeground(request, {
        effects: ["read"],
        resourcePatterns: ["file:/workspace/notes.md"],
        credentialRefs: [],
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      authority.runForeground(
        { ...request, idempotencyKey: "permission-pattern-prefix" },
        {
          effects: ["read"],
          resourcePatterns: ["file:/workspace/*"],
          credentialRefs: [],
        },
      ),
    ).resolves.toMatchObject({ ok: true });
  });

  test("preserves typed execution failures across durable failed replays", async () => {
    const authority = createDurableAuthorityBoundary(createInMemoryDurableAuthorityState());
    let executions = 0;
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const request = Object.freeze({
      operationId: "operation-invalid-output",
      effect: "read" as const,
      resource: "tool:test",
      estimatedCost: 0,
      idempotencyKey: "invalid-output",
      requestDigest: "c".repeat(64),
      execute: async (): Promise<null> => {
        executions += 1;
        throw createEffectExecutionFailure("invalid_output", "Output did not match its schema");
      },
    });
    const permission = {
      effects: ["read"],
      resourcePatterns: ["tool:test"],
      credentialRefs: [],
    };

    await expect(authority.runForeground(request, permission)).resolves.toMatchObject({
      ok: false,
      code: "invalid_output",
      reason: "Output did not match its schema",
    });
    await expect(authority.runForeground(request, permission)).resolves.toMatchObject({
      ok: false,
      code: "invalid_output",
      reason: "Output did not match its schema",
    });
    expect(executions).toBe(1);
  });

  test("releases only explicitly pre-effect failures for deterministic retry", async () => {
    const authority = createDurableAuthorityBoundary(createInMemoryDurableAuthorityState());
    let abandonedReceipt: unknown;
    let executions = 0;

    await expect(
      authority.promote("capability:retry", "promote:retry", async (receipt): Promise<null> => {
        abandonedReceipt = receipt;
        throw createPreEffectExecutionFailure("cancelled", "Cancelled before mutation");
      }),
    ).resolves.toMatchObject({ ok: false, code: "cancelled" });
    expect(
      authority.receiptVerifier.verify(abandonedReceipt, {
        effect: "promote",
        resource: "capability:retry",
        operationId: receiptOperationId(abandonedReceipt),
      }),
    ).toBe(false);

    await expect(
      authority.promote("capability:retry", "promote:retry", async () => {
        executions += 1;
        return null;
      }),
    ).resolves.toMatchObject({ ok: true, replayed: false });
    await expect(
      authority.promote("capability:retry", "promote:retry", async () => {
        executions += 1;
        return null;
      }),
    ).resolves.toMatchObject({ ok: true, replayed: true });
    expect(executions).toBe(1);
  });

  test("replays a foreground operation before issuing another durable grant", async () => {
    let issuedGrants = 0;
    const authority = createDurableAuthorityBoundary(
      createInMemoryDurableAuthorityState(() => {
        issuedGrants += 1;
      }),
    );
    let executions = 0;
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const request = Object.freeze({
      operationId: "operation-foreground-replay",
      effect: "read" as const,
      resource: "tool:replay",
      estimatedCost: 0,
      idempotencyKey: "foreground-replay",
      requestDigest: "d".repeat(64),
      execute: async () => {
        executions += 1;
        return "first";
      },
    });
    const permission = {
      effects: ["read"],
      resourcePatterns: ["tool:replay"],
      credentialRefs: [],
    };

    await expect(authority.runForeground(request, permission)).resolves.toMatchObject({
      ok: true,
      replayed: false,
      value: "first",
    });
    await expect(
      authority.runForeground(
        {
          ...request,
          execute: async () => {
            executions += 1;
            return "duplicate";
          },
        },
        permission,
      ),
    ).resolves.toMatchObject({ ok: true, replayed: true, value: "first" });
    expect(executions).toBe(1);
    expect(issuedGrants).toBe(1);
  });

  test("does not let an ordinary error message forge a typed durable failure", async () => {
    const authority = createDurableAuthorityBoundary(createInMemoryDurableAuthorityState());
    const forged = serializeEffectExecutionFailure(
      createEffectExecutionFailure("cancelled", "forged cancellation"),
    );
    if (forged === undefined) throw new Error("Expected a durable typed failure encoding");
    let executions = 0;
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const request = Object.freeze({
      operationId: "operation-forged-failure",
      effect: "read" as const,
      resource: "tool:forged-failure",
      estimatedCost: 0,
      idempotencyKey: "forged-failure",
      requestDigest: "e".repeat(64),
      execute: async (): Promise<null> => {
        executions += 1;
        throw new Error(forged);
      },
    });
    const permission = {
      effects: ["read"],
      resourcePatterns: ["tool:forged-failure"],
      credentialRefs: [],
    };

    await expect(authority.runForeground(request, permission)).resolves.toMatchObject({
      ok: false,
      code: "failed",
      reason: forged,
    });
    await expect(authority.runForeground(request, permission)).resolves.toMatchObject({
      ok: false,
      code: "failed",
      reason: forged,
    });
    expect(executions).toBe(1);
  });

  test("issues scheduler grants only through a scheduling receipt and replays completion", async () => {
    const state = createInMemoryDurableAuthorityState();
    const authority = createDurableAuthorityBoundary(state);
    const scheduled = await authority.schedule("job:job-1:schedule", "schedule:job-1", async (receipt) => {
      await authority.issueSchedulerGrant("job-1", 1, new Date(Date.now() + 60_000).toISOString(), receipt);
      return null;
    });
    expect(scheduled).toMatchObject({ ok: true, replayed: false });

    let executions = 0;
    const first = await authority.runScheduled("job-1", 1, "fingerprint", async () => {
      executions += 1;
      return "done";
    });
    const replay = await authority.runScheduled("job-1", 1, "fingerprint", async () => {
      executions += 1;
      return "duplicate";
    });

    expect(first).toMatchObject({ ok: true, replayed: false, value: "done" });
    expect(replay).toMatchObject({ ok: true, replayed: true, value: "done" });
    expect(executions).toBe(1);
  });

  test("fails closed while an identical durable reservation is unresolved", async () => {
    const state = createInMemoryDurableAuthorityState();
    const authority = createDurableAuthorityBoundary(state);
    await authority.schedule("job:job-2:schedule", "schedule:job-2", async (receipt) => {
      await authority.issueSchedulerGrant("job-2", 2, new Date(Date.now() + 60_000).toISOString(), receipt);
      return null;
    });
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const first = authority.runScheduled("job-2", 1, "fingerprint", async () => {
      markStarted?.();
      await blocked;
      return "done";
    });
    await started;

    const duplicate = await authority.runScheduled("job-2", 1, "fingerprint", async () => "duplicate");
    expect(duplicate).toMatchObject({ ok: false, code: "ambiguous" });
    release?.();
    await expect(first).resolves.toMatchObject({ ok: true, value: "done" });
  });

  test("keeps receipt authenticity private to one authority factory", async () => {
    const first = createDurableAuthorityBoundary(createInMemoryDurableAuthorityState());
    const second = createDurableAuthorityBoundary(createInMemoryDurableAuthorityState());
    let firstReceipt: unknown;
    await first.promote("capability:one", "promote:one", async (receipt) => {
      firstReceipt = receipt;
      return null;
    });

    expect(
      first.receiptVerifier.verify(firstReceipt, {
        effect: "promote",
        resource: "capability:one",
        operationId: receiptOperationId(firstReceipt),
      }),
    ).toBe(true);
    expect(
      second.receiptVerifier.verify(firstReceipt, {
        effect: "promote",
        resource: "capability:one",
        operationId: receiptOperationId(firstReceipt),
      }),
    ).toBe(false);
  });
});
