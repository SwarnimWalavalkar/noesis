import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frozenTurnPlanDigest, type FrozenTurnPlan } from "@noesis/agent-types";
import { sha256 } from "@noesis/domain";
import {
  type AuthorityReceipt,
  authorityOperationFields,
  createDurableAuthorityBoundary,
  type DurableAuthorityOperation,
  type DurableAuthorityReservation,
  type DurableAuthorityStatePort,
} from "@noesis/policy";
import { afterEach, describe, expect, test } from "vitest";
import { createWorkspaceStore, type NoesisWorkspaceStore } from "../src/index.ts";
import {
  createProtectedWorkspaceRuntime,
  createReceiptGuardedProtectedMutations,
  createWorkspaceRuntimeInternals,
} from "../src/protected-runtime.ts";

const roots: string[] = [];
const stores: NoesisWorkspaceStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

function turnPlan(sessionId: string, turnId: string): FrozenTurnPlan {
  const body: Omit<FrozenTurnPlan, "canonicalDigest"> = {
    schemaVersion: 1,
    planId: `plan-${turnId}`,
    sessionId,
    turnId,
    selectedCapabilities: [],
    renderedSystemPrompt: "Noesis",
    provider: "fake",
    model: "fake-1",
    thinkingLevel: "off",
    permissionSnapshot: { effects: [], resourcePatterns: [], credentialRefs: [] },
    retrievalCitations: [],
    routing: { strategyId: "fixture", reason: "No Capability" },
    createdAt: "2026-07-25T00:00:00.000Z",
  };
  return { ...body, canonicalDigest: frozenTurnPlanDigest(body) };
}

function mutationPorts(onAdmit: () => void) {
  return Object.freeze({
    turnPlans: Object.freeze({
      admit: async (plan: FrozenTurnPlan) => {
        onAdmit();
        return plan;
      },
    }),
  });
}

async function authorityAt(path: string) {
  const workspace = await createWorkspaceStore(path);
  stores.push(workspace);
  return createWorkspaceRuntimeInternals(workspace).authority;
}

async function captureReceipt(
  authority: Awaited<ReturnType<typeof authorityAt>>,
  resource: string,
  idempotencyKey: string,
): Promise<AuthorityReceipt> {
  let captured: AuthorityReceipt | undefined;
  const decision = await authority.promote(resource, idempotencyKey, async (receipt) => {
    captured = receipt;
    return null;
  });
  if (!decision.ok || !captured) throw new Error("Could not capture authority receipt");
  return captured;
}

describe("protected workspace runtime", () => {
  test("allocates MCP connection cycles durably and advances only after terminal authority state", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-mcp-connection-cycles-"));
    roots.push(root);
    const connectionIdentity = sha256("controlled MCP connection");
    const firstWorkspace = await createWorkspaceStore(root);
    const firstOperationId =
      await createWorkspaceRuntimeInternals(firstWorkspace).mcpConnectionCycles.claim(connectionIdentity);
    firstWorkspace.close();

    const workspace = await createWorkspaceStore(root);
    stores.push(workspace);
    const internals = createWorkspaceRuntimeInternals(workspace);
    await expect(internals.mcpConnectionCycles.claim(connectionIdentity)).resolves.toBe(firstOperationId);

    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resource = `mcp:project:server:${connectionIdentity}:connection`;
    const requestDigest = sha256("controlled connection request");
    const running = internals.authority.runForeground(
      {
        operationId: firstOperationId,
        effect: "execute",
        resource,
        estimatedCost: 1,
        idempotencyKey: `mcp-lifecycle:${firstOperationId}`,
        requestDigest,
        execute: async () => {
          markStarted?.();
          await blocked;
          return null;
        },
      },
      Object.freeze({
        effects: Object.freeze(["execute"]),
        resourcePatterns: Object.freeze([resource]),
        credentialRefs: Object.freeze([]),
      }),
    );
    await started;
    await expect(internals.mcpConnectionCycles.claim(connectionIdentity)).resolves.toBe(firstOperationId);
    release?.();
    await expect(running).resolves.toMatchObject({ ok: true });

    const secondOperationId = await internals.mcpConnectionCycles.claim(connectionIdentity);
    expect(secondOperationId).not.toBe(firstOperationId);
    const failed = await internals.authority.runForeground(
      {
        operationId: secondOperationId,
        effect: "execute",
        resource,
        estimatedCost: 1,
        idempotencyKey: `mcp-lifecycle:${secondOperationId}`,
        requestDigest,
        execute: async () => {
          throw new Error("controlled connection failure");
        },
      },
      Object.freeze({
        effects: Object.freeze(["execute"]),
        resourcePatterns: Object.freeze([resource]),
        credentialRefs: Object.freeze([]),
      }),
    );
    expect(failed).toMatchObject({ ok: false, code: "failed" });
    await expect(internals.mcpConnectionCycles.claim(connectionIdentity)).resolves.not.toBe(
      secondOperationId,
    );
  });

  test("rejects forged, foreign, wrong-effect, wrong-resource, and wrong-workspace receipts before mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-protected-receipts-"));
    roots.push(root);
    const owner = await authorityAt(join(root, "owner"));
    const foreign = await authorityAt(join(root, "foreign"));
    let mutations = 0;
    const ports = mutationPorts(() => {
      mutations += 1;
    });
    const guarded = createReceiptGuardedProtectedMutations({
      verifier: owner.receiptVerifier,
      turnPlans: ports.turnPlans,
    });
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const expected = Object.freeze({
      effect: "promote" as const,
      resource: "workspace:alpha:turn:session-1:turn-1:admit",
      idempotencyKey: "protected:turn:admit:session-1:turn-1",
    });
    const operation = authorityOperationFields(
      "promoter",
      expected.effect,
      expected.resource,
      0,
      expected.idempotencyKey,
    );
    const forged: AuthorityReceipt = Object.freeze({
      effect: expected.effect,
      resource: expected.resource,
      operationId: operation.operationId,
    });
    const foreignReceipt = await captureReceipt(foreign, expected.resource, expected.idempotencyKey);
    const wrongResource = await captureReceipt(
      owner,
      `${expected.resource}:other`,
      `${expected.idempotencyKey}:wrong-resource`,
    );
    const wrongWorkspace = await captureReceipt(
      owner,
      expected.resource.replace("workspace:alpha", "workspace:beta"),
      `${expected.idempotencyKey}:wrong-workspace`,
    );
    let wrongEffect: AuthorityReceipt | undefined;
    await owner.schedule(expected.resource, `${expected.idempotencyKey}:wrong-effect`, async (receipt) => {
      wrongEffect = receipt;
      return null;
    });
    if (!wrongEffect) throw new Error("Could not capture wrong-effect receipt");

    for (const receipt of [forged, foreignReceipt, wrongEffect, wrongResource, wrongWorkspace])
      await expect(
        Promise.resolve().then(
          async () => await guarded.turnPlans.admit(expected, receipt, turnPlan("session-1", "turn-1")),
        ),
      ).rejects.toThrow(/exact authority receipt/iu);
    expect(mutations).toBe(0);

    const valid = await captureReceipt(owner, expected.resource, expected.idempotencyKey);
    await expect(
      guarded.turnPlans.admit(expected, valid, turnPlan("session-1", "turn-1")),
    ).resolves.toMatchObject({ planId: "plan-turn-1" });
    expect(mutations).toBe(1);
  });

  test("fails closed on an unresolved reservation without minting a recovery identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-protected-unresolved-"));
    roots.push(root);
    const workspace = await createWorkspaceStore(root);
    const baseRuntime = createWorkspaceRuntimeInternals(workspace).protectedRuntime;
    const attemptedOperations: DurableAuthorityOperation[] = [];
    let mutationCalls = 0;
    let terminalWrites = 0;
    const state: DurableAuthorityStatePort = Object.freeze({
      issueGrant: async () => undefined,
      getGrant: async () => undefined,
      findSchedulerGrant: async () => undefined,
      reserve: async (operation: DurableAuthorityOperation): Promise<DurableAuthorityReservation> => {
        attemptedOperations.push(operation);
        return Object.freeze({
          status: "unresolved",
          reason: "A durable reservation exists without an authoritative outcome",
        });
      },
      reserveWithGrant: async (
        operation: DurableAuthorityOperation,
      ): Promise<DurableAuthorityReservation> => {
        attemptedOperations.push(operation);
        return Object.freeze({
          status: "unresolved",
          reason: "A durable reservation exists without an authoritative outcome",
        });
      },
      complete: async () => {
        terminalWrites += 1;
      },
      fail: async () => {
        terminalWrites += 1;
      },
      abandon: async () => {
        terminalWrites += 1;
      },
    });
    const authority = createDurableAuthorityBoundary(state);
    const turnPlans = Object.freeze({
      ...baseRuntime.turnPlans,
      admit: async (plan: FrozenTurnPlan) => {
        mutationCalls += 1;
        return await baseRuntime.turnPlans.admit(plan);
      },
    });
    const runtime = createProtectedWorkspaceRuntime({
      workspaceRoot: root,
      authority,
      turnPlans,
    });

    await expect(runtime.turnPlans.admit(turnPlan("session-unresolved", "turn-unresolved"))).rejects.toThrow(
      /authority ambiguous.*authoritative outcome/iu,
    );

    expect(attemptedOperations).toHaveLength(1);
    const attempted = attemptedOperations[0];
    if (!attempted) throw new Error("Expected the original protected operation attempt");
    const unresolvedPlan = turnPlan("session-unresolved", "turn-unresolved");
    expect(attempted.identity.idempotencyKey).toBe(
      `protected:turn:admit:${unresolvedPlan.planId}:${unresolvedPlan.canonicalDigest}`,
    );
    expect(attempted.identity.operationId).toBe(
      authorityOperationFields(
        "promoter",
        "promote",
        attempted.identity.resource,
        0,
        attempted.identity.idempotencyKey,
      ).operationId,
    );
    expect(mutationCalls).toBe(0);
    expect(terminalWrites).toBe(0);
    expect(await baseRuntime.turnPlans.get("session-unresolved", "turn-unresolved")).toBeUndefined();
    workspace.close();
  });

  test("public workspace and package index expose no protected mutation or authority surface", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-protected-reachability-"));
    roots.push(root);
    const workspace = await createWorkspaceStore(root);
    expect("authority" in workspace).toBe(false);
    expect("protectedTurnPlans" in workspace).toBe(false);
    expect(createWorkspaceRuntimeInternals(workspace).protectedRuntime.turnPlans).toBeDefined();

    const publicIndex = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(publicIndex).not.toMatch(
      /createWorkspaceRuntimeInternals|createProtectedTurnPlanStore|createProtectedWorkspaceRuntime/iu,
    );
    const tui = await readFile(new URL("../../tui/src/index.ts", import.meta.url), "utf8");
    expect(tui).not.toMatch(/protected-runtime|protectedTurnPlans/iu);
    const generatedRoleContext = await readFile(
      new URL("../../runtime-pi/src/role-context.ts", import.meta.url),
      "utf8",
    );
    expect(generatedRoleContext).not.toMatch(
      /workspace\/src\/protected-runtime|createWorkspaceRuntimeInternals/iu,
    );
    workspace.close();
  });
});
