import type { Grant, JsonValue } from "@noesis/domain";
import { describe, expect, test } from "vitest";
import {
  createDurableAuthorityBoundary,
  type DurableAuthorityOperation,
  type DurableAuthorityReservation,
  type DurableAuthorityStatePort,
} from "../src/index.ts";

interface StoredOperation {
  readonly operation: DurableAuthorityOperation;
  status: "reserved" | "completed" | "failed";
  result?: JsonValue;
  reason?: string;
}

function createInMemoryDurableAuthorityState(): DurableAuthorityStatePort {
  const grants = new Map<string, Grant>();
  const operations = new Map<string, StoredOperation>();
  const usedByGrant = new Map<string, number>();
  const issueGrant = async (grant: Grant): Promise<void> => {
    grants.set(grant.grantId, grant);
  };
  const reserve = async (
    operation: DurableAuthorityOperation,
    grantId: string | undefined,
  ): Promise<DurableAuthorityReservation> => {
    const existing = operations.get(operation.identity.idempotencyKey);
    if (existing) {
      if (existing.operation.fingerprint !== operation.fingerprint)
        return { status: "collision", reason: "Idempotency key fingerprint collision" };
      if (existing.status === "reserved")
        return { status: "unresolved", reason: "Prior reservation has no unambiguous outcome" };
      if (existing.status === "completed") return { status: "completed", result: existing.result ?? null };
      return { status: "failed", reason: existing.reason ?? "Prior operation failed" };
    }
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
    operations.set(operation.identity.idempotencyKey, { operation, status: "reserved" });
    return { status: "reserved", grantId: grant.grantId };
  };
  return Object.freeze({
    issueGrant,
    getGrant: async (grantId: string) => grants.get(grantId),
    findSchedulerGrant: async (jobId: string) =>
      [...grants.values()].find(
        (grant) => grant.principal === "scheduler" && grant.resourcePrefixes.includes(`job:${jobId}:`),
      ),
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
  });
}

describe("durable authority boundary", () => {
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
        operationId:
          typeof firstReceipt === "object" &&
          firstReceipt !== null &&
          "operationId" in firstReceipt &&
          typeof firstReceipt.operationId === "string"
            ? firstReceipt.operationId
            : "",
      }),
    ).toBe(true);
    expect(
      second.receiptVerifier.verify(firstReceipt, {
        effect: "promote",
        resource: "capability:one",
        operationId:
          typeof firstReceipt === "object" &&
          firstReceipt !== null &&
          "operationId" in firstReceipt &&
          typeof firstReceipt.operationId === "string"
            ? firstReceipt.operationId
            : "",
      }),
    ).toBe(false);
  });
});
