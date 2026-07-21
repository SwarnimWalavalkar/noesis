import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createExperienceLedger } from "@noesis/ledger";
import { createAuthorityBoundary, createEffectGateway } from "../src/index.ts";

describe("effect policy", () => {
  test("fails closed and records denial outside the mutable worker", async () => {
    const ledger = createExperienceLedger(await mkdtemp(join(tmpdir(), "noesis-policy-")));
    await ledger.initialize();
    const gateway = createEffectGateway(ledger);
    let executed = false;
    const decision = await gateway.run({
      principal: "reflector",
      effect: "promote",
      resource: "capability:x",
      estimatedCost: 0,
      idempotencyKey: "deny-1",
      execute: async () => {
        executed = true;
        return null;
      },
    });

    expect(decision).toMatchObject({ ok: false, code: "denied" });
    expect(executed).toBe(false);
    expect(ledger.findByType("effect.denied")).toHaveLength(1);
  });

  test("rehydrates completions and grant usage after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-policy-restart-"));
    const ledger = createExperienceLedger(root);
    await ledger.initialize();
    const authority = createAuthorityBoundary(ledger);
    await authority.schedule("job:job-1:schedule", "schedule:job-1", async (receipt) => {
      await authority.issueSchedulerGrant("job-1", 1, new Date(Date.now() + 60_000).toISOString(), receipt);
      return null;
    });
    let executions = 0;
    const first = await authority.runScheduled("job-1", 1, async () => {
      executions += 1;
      return "done";
    });
    expect(first).toMatchObject({ ok: true, replayed: false });

    const recoveredLedger = createExperienceLedger(root);
    await recoveredLedger.initialize();
    const recovered = createAuthorityBoundary(recoveredLedger);
    const replay = await recovered.runScheduled("job-1", 1, async () => {
      executions += 1;
      return "duplicate";
    });
    expect(replay).toMatchObject({ ok: true, replayed: true, value: "done" });
    const exhausted = await recovered.runScheduled("job-1", 2, async () => {
      executions += 1;
      return "duplicate";
    });
    expect(exhausted).toMatchObject({ ok: false, code: "denied" });
    expect(executions).toBe(1);
  });

  test("fails closed for a restart-visible in-flight reservation", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-policy-inflight-"));
    const ledger = createExperienceLedger(root);
    await ledger.initialize();
    await ledger.append({
      type: "effect.reserved",
      principal: "scheduler",
      payload: {
        reservationId: "reservation-1",
        grantId: "grant-1",
        effect: "execute",
        resource: "job:1:runtime",
        idempotencyKey: "inflight-1",
        estimatedCost: 1,
      },
    });
    const recoveredLedger = createExperienceLedger(root);
    await recoveredLedger.initialize();
    let executed = false;
    const decision = await createEffectGateway(recoveredLedger).run({
      principal: "scheduler",
      effect: "execute",
      resource: "job:1:runtime",
      estimatedCost: 1,
      idempotencyKey: "inflight-1",
      execute: async () => {
        executed = true;
        return null;
      },
    });
    expect(decision).toMatchObject({ ok: false, code: "ambiguous" });
    expect(executed).toBe(false);
  });

  test("allows only one concurrent reservation for an idempotency key", async () => {
    const ledger = createExperienceLedger(await mkdtemp(join(tmpdir(), "noesis-policy-concurrent-")));
    await ledger.initialize();
    const authority = createAuthorityBoundary(ledger);
    await authority.schedule("job:job-2:schedule", "schedule:job-2", async (receipt) => {
      await authority.issueSchedulerGrant("job-2", 2, new Date(Date.now() + 60_000).toISOString(), receipt);
      return null;
    });
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: (() => void) | undefined;
    const executing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const first = authority.runScheduled("job-2", 1, async () => {
      started?.();
      await blocked;
      return "first";
    });
    await executing;
    const second = await authority.runScheduled("job-2", 1, async () => "duplicate");
    expect(second).toMatchObject({ ok: false, code: "ambiguous" });
    release?.();
    await expect(first).resolves.toMatchObject({ ok: true, value: "first" });
    expect(ledger.findByType("effect.reserved")).toHaveLength(2); // schedule plus one execution
  });

  test("isolates authority dependencies across independent factories", async () => {
    const firstLedger = createExperienceLedger(await mkdtemp(join(tmpdir(), "noesis-policy-first-")));
    const secondLedger = createExperienceLedger(await mkdtemp(join(tmpdir(), "noesis-policy-second-")));
    await Promise.all([firstLedger.initialize(), secondLedger.initialize()]);
    const first = createAuthorityBoundary(firstLedger);
    const second = createAuthorityBoundary(secondLedger);

    await first.schedule("job:isolated:schedule", "schedule:isolated", async (receipt) => {
      await first.issueSchedulerGrant("isolated", 1, new Date(Date.now() + 60_000).toISOString(), receipt);
      return null;
    });

    expect(first.schedulerHandle("isolated")).toBeDefined();
    expect(second.schedulerHandle("isolated")).toBeUndefined();
  });
});
