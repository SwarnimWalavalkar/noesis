import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frozenTurnPlanDigest, type FrozenTurnPlan } from "@noesis/agent-types";
import { sha256 } from "@noesis/domain";
import { afterEach, describe, expect, test } from "vitest";
import { createWorkspaceStore } from "../src/index.ts";
import { createWorkspaceRuntimeInternals } from "../src/protected-runtime.ts";

describe("durable compounding measurement reservations", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  const createPlan = (turnId: string): FrozenTurnPlan => {
    const body: Omit<FrozenTurnPlan, "canonicalDigest"> = {
      schemaVersion: 1,
      planId: `plan-${turnId}`,
      sessionId: "session-1",
      turnId,
      activationId: "activation_genesis",
      activationRevision: 1,
      selectedCapabilities: [],
      renderedSystemPrompt: "Noesis baseline",
      provider: "fake",
      model: "fake-1",
      thinkingLevel: "off",
      permissionSnapshot: { effects: [], resourcePatterns: [], credentialRefs: [] },
      retrievalCitations: [],
      routing: { strategyId: "baseline", reason: "No adaptation" },
      createdAt: "2026-07-25T00:00:00.000Z",
    };
    return { ...body, canonicalDigest: frozenTurnPlanDigest(body) };
  };

  test("reserves once, fails closed while unresolved, and replays completed evidence after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-compounding-measurements-"));
    roots.push(root);
    const store = await createWorkspaceStore(root);
    const protectedRuntime = createWorkspaceRuntimeInternals(store).protectedRuntime;
    await protectedRuntime.activations.bootstrapGenesis({
      capabilityRevision: {
        kind: "capability_revision",
        capabilityId: "general-collaboration",
        capabilityRevisionId: "general-collaboration-genesis-v1",
        bundleDigest: "a".repeat(64),
      },
      activeDefinitions: {},
    });
    const admitted = await protectedRuntime.activations.admitTurnPlan(createPlan("turn-1"));
    await protectedRuntime.measurements.putBudget({
      budgetId: "budget-1",
      maximumCalls: 1,
      maximumTokens: 100,
      maximumCost: 1,
    });
    await protectedRuntime.measurements.beginReplay({
      replayId: "replay-1",
      planId: admitted.planId,
      budgetId: "budget-1",
    });
    const reservation = {
      operationId: "operation-1",
      replayId: "replay-1",
      role: "served_arm" as const,
      requestDigest: sha256("request-1"),
      maximumTokens: 100,
      maximumCost: 1,
    };
    expect(await protectedRuntime.measurements.reserveRole(reservation)).toEqual({
      status: "reserved",
    });
    expect(await protectedRuntime.measurements.reserveRole(reservation)).toEqual({
      status: "unresolved",
    });
    const output = await store.evidence.appendEvidence({
      workingPath: "compounding-replays/replay-1/served.json",
      bytes: Buffer.from('{"text":"done"}'),
      evidenceKind: "output",
      actor: { actorId: "test", kind: "system" },
    });
    await protectedRuntime.measurements.completeRole({
      operationId: reservation.operationId,
      resultEvidence: output,
      usedTokens: 80,
      actualCost: 0.5,
    });
    store.close();

    const reopened = await createWorkspaceStore(root);
    const reopenedProtected = createWorkspaceRuntimeInternals(reopened).protectedRuntime;
    expect(await reopenedProtected.measurements.reserveRole(reservation)).toEqual({
      status: "completed",
      resultEvidence: output,
    });
    expect(await reopenedProtected.measurements.getBudget("budget-1")).toMatchObject({
      reservedCalls: 1,
      reservedTokens: 100,
      reservedCost: 1,
    });
    reopened.close();
  });
});
