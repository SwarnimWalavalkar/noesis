import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FrozenTurnPlan } from "@noesis/agent-types";
import {
  type CapabilityRevisionRef,
  type FileRevisionRef,
  type JsonValue,
  sha256,
  type WorkingAdjustment,
} from "@noesis/domain";
import {
  type AuthorityBoundary,
  type AuthorityReceipt,
  authorityOperationFields,
  createDurableAuthorityBoundary,
  type DurableAuthorityOperation,
  type DurableAuthorityReservation,
  type DurableAuthorityStatePort,
  type ProtectedAuthorityExecutionOptions,
} from "@noesis/policy";
import { afterEach, describe, expect, test } from "vitest";
import { createWorkspaceStore, type NoesisWorkspaceStore } from "../src/index.ts";
import {
  createProtectedWorkspaceRuntime,
  createReceiptGuardedProtectedMutations,
  createWorkspaceRuntimeInternals,
} from "../src/protected-runtime.ts";
import type { ProtectedWorkingAdjustmentStore } from "../src/types.ts";

const roots: string[] = [];
const stores: NoesisWorkspaceStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

const unsupported = async (): Promise<never> => {
  throw new Error("unused protected mutation");
};

const project = Object.freeze({ projectId: "project-protected", root: "/tmp/project-protected" });

function adjustment(adjustmentId: string, scope: WorkingAdjustment["scope"] = project): WorkingAdjustment {
  return Object.freeze({
    adjustmentId,
    scope,
    observation: "Recent work exposed a project-level opportunity.",
    strategy: `Apply strategy ${adjustmentId}.`,
    successSignal: "The next relevant turn improves observably.",
    evidenceRefs: Object.freeze([
      Object.freeze({ kind: "database_row" as const, table: "sessions" as const, rowId: "session-1" }),
    ]),
    createdFromTurnId: "turn-1",
  });
}

function mutableWorkingAdjustments(): {
  readonly store: ProtectedWorkingAdjustmentStore;
  readonly applyCalls: () => number;
  readonly unapplyCalls: () => number;
} {
  const records = new Map<string, WorkingAdjustment>();
  const activeByProject = new Map<string, WorkingAdjustment>();
  let applyCalls = 0;
  let unapplyCalls = 0;
  const store: ProtectedWorkingAdjustmentStore = Object.freeze({
    get: async (adjustmentId: string) => records.get(adjustmentId),
    getActive: async (projectId: string) => activeByProject.get(projectId),
    list: async () => Object.freeze([...records.values()]),
    listSettledEvidence: async () => Object.freeze([]),
    apply: async (request: Parameters<ProtectedWorkingAdjustmentStore["apply"]>[0]) => {
      applyCalls += 1;
      const projectId = request.adjustment.scope.projectId;
      const currentActiveAdjustmentId = activeByProject.get(projectId)?.adjustmentId ?? null;
      if (currentActiveAdjustmentId !== request.expectedActiveAdjustmentId)
        return Object.freeze({
          status: "stale" as const,
          adjustmentId: request.adjustment.adjustmentId,
          currentActiveAdjustmentId,
        });
      records.set(request.adjustment.adjustmentId, request.adjustment);
      activeByProject.set(projectId, request.adjustment);
      return Object.freeze({
        status: "applied" as const,
        adjustment: request.adjustment,
        replacedAdjustmentId: currentActiveAdjustmentId,
      });
    },
    unapply: async (request: Parameters<ProtectedWorkingAdjustmentStore["unapply"]>[0]) => {
      unapplyCalls += 1;
      const currentActiveAdjustmentId = activeByProject.get(request.projectId)?.adjustmentId ?? null;
      if (currentActiveAdjustmentId !== request.expectedActiveAdjustmentId)
        return Object.freeze({
          status: "stale" as const,
          adjustmentId: request.expectedActiveAdjustmentId,
          currentActiveAdjustmentId,
        });
      activeByProject.delete(request.projectId);
      return Object.freeze({
        status: "unapplied" as const,
        adjustmentId: request.expectedActiveAdjustmentId,
      });
    },
  });
  return Object.freeze({
    store,
    applyCalls: () => applyCalls,
    unapplyCalls: () => unapplyCalls,
  });
}

async function runtimeWithWorkingAdjustments(
  workingAdjustments: ProtectedWorkingAdjustmentStore,
  wrapAuthority: (authority: AuthorityBoundary) => AuthorityBoundary = (authority) => authority,
) {
  const root = await mkdtemp(join(tmpdir(), "noesis-protected-adjustments-"));
  roots.push(root);
  const workspace = await createWorkspaceStore(root);
  stores.push(workspace);
  const internals = createWorkspaceRuntimeInternals(workspace);
  return createProtectedWorkspaceRuntime({
    workspaceRoot: root,
    authority: wrapAuthority(internals.authority),
    activations: internals.protectedRuntime.activations,
    feedback: internals.protectedRuntime.feedback,
    measurements: internals.protectedRuntime.measurements,
    workingAdjustments,
  });
}

function mutationPorts(onPin: () => void) {
  return Object.freeze({
    activations: Object.freeze({
      prepare: unsupported,
      supersede: unsupported,
      decideApproval: unsupported,
      commit: unsupported,
      pinTurn: async (request: { readonly sessionId: string; readonly turnId: string }) => {
        onPin();
        return Object.freeze({
          turnKey: `${request.sessionId}:${request.turnId}`,
          sessionId: request.sessionId,
          turnId: request.turnId,
          activationId: "activation-test",
          activationRevision: 1,
          activeDefinitions: Object.freeze({}) as Readonly<Record<string, FileRevisionRef>>,
          activeCapabilityRevisions: Object.freeze({}) as Readonly<Record<string, CapabilityRevisionRef>>,
          pinnedAt: "2026-07-25T00:00:00.000Z",
        });
      },
      admitTurnPlan: async (plan: FrozenTurnPlan) => plan,
      bootstrapGenesis: unsupported,
      recoverCommittedPublications: async () => 0,
    }),
    feedback: Object.freeze({
      recordObservation: unsupported,
      classifyObservations: unsupported,
      putResearchRun: unsupported,
      commitOutcome: unsupported,
    }),
    workingAdjustments: Object.freeze({
      apply: unsupported,
      unapply: unsupported,
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

  test("checks cancellation inside protected adjustment authority before store mutation", async () => {
    const mutations = mutableWorkingAdjustments();
    const runtime = await runtimeWithWorkingAdjustments(mutations.store);
    const first = adjustment("adjustment-cancelled-apply");
    const cancelledApply = new AbortController();
    cancelledApply.abort("cancelled");

    await expect(
      runtime.workingAdjustments.apply({
        adjustment: first,
        expectedActiveAdjustmentId: null,
        signal: cancelledApply.signal,
      }),
    ).rejects.toThrow("cancelled before protected state changed");
    expect(mutations.applyCalls()).toBe(0);

    const active = adjustment("adjustment-cancelled-unapply");
    await mutations.store.apply({ adjustment: active, expectedActiveAdjustmentId: null });
    const cancelledUnapply = new AbortController();
    cancelledUnapply.abort("cancelled");

    await expect(
      runtime.workingAdjustments.unapply({
        projectId: project.projectId,
        expectedActiveAdjustmentId: active.adjustmentId,
        signal: cancelledUnapply.signal,
      }),
    ).rejects.toThrow("cancelled before protected state changed");
    expect(mutations.unapplyCalls()).toBe(0);
    await expect(mutations.store.getActive(project.projectId)).resolves.toEqual(active);
  });

  test("rechecks cancellation after authority reservation and before adjustment mutation", async () => {
    const mutations = mutableWorkingAdjustments();
    let markAuthorityEntered: (() => void) | undefined;
    const authorityEntered = new Promise<void>((resolve) => {
      markAuthorityEntered = resolve;
    });
    let releaseAuthority: (() => void) | undefined;
    const authorityBlocked = new Promise<void>((resolve) => {
      releaseAuthority = resolve;
    });
    const runtime = await runtimeWithWorkingAdjustments(mutations.store, (authority) => {
      const promote: AuthorityBoundary["promote"] = async <Result extends JsonValue>(
        resource: string,
        idempotencyKey: string,
        execute: (receipt: AuthorityReceipt) => Promise<Result>,
        options?: ProtectedAuthorityExecutionOptions,
      ) => {
        markAuthorityEntered?.();
        await authorityBlocked;
        return await authority.promote(resource, idempotencyKey, execute, options);
      };
      return Object.freeze({
        ...authority,
        promote,
      });
    });
    const controller = new AbortController();
    const candidate = adjustment("adjustment-cancelled-during-authority");
    const pending = runtime.workingAdjustments.apply({
      adjustment: candidate,
      expectedActiveAdjustmentId: null,
      signal: controller.signal,
    });

    await authorityEntered;
    controller.abort("cancelled");
    releaseAuthority?.();

    await expect(pending).rejects.toThrow("cancelled before protected state changed");
    expect(mutations.applyCalls()).toBe(0);
    await expect(mutations.store.getActive(project.projectId)).resolves.toBeUndefined();

    await expect(
      runtime.workingAdjustments.apply({
        adjustment: candidate,
        expectedActiveAdjustmentId: null,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ status: "applied", replacedAdjustmentId: null });
    expect(mutations.applyCalls()).toBe(1);
    await expect(mutations.store.getActive(project.projectId)).resolves.toEqual(candidate);
  });

  test("retries the same unapply after cancellation during authority reservation", async () => {
    const mutations = mutableWorkingAdjustments();
    const active = adjustment("adjustment-unapply-cancelled-during-authority");
    await mutations.store.apply({ adjustment: active, expectedActiveAdjustmentId: null });
    let markAuthorityEntered: (() => void) | undefined;
    const authorityEntered = new Promise<void>((resolve) => {
      markAuthorityEntered = resolve;
    });
    let releaseAuthority: (() => void) | undefined;
    const authorityBlocked = new Promise<void>((resolve) => {
      releaseAuthority = resolve;
    });
    const runtime = await runtimeWithWorkingAdjustments(mutations.store, (authority) => {
      const rollback: AuthorityBoundary["rollback"] = async <Result extends JsonValue>(
        resource: string,
        idempotencyKey: string,
        execute: (receipt: AuthorityReceipt) => Promise<Result>,
        options?: ProtectedAuthorityExecutionOptions,
      ) => {
        markAuthorityEntered?.();
        await authorityBlocked;
        return await authority.rollback(resource, idempotencyKey, execute, options);
      };
      return Object.freeze({ ...authority, rollback });
    });
    const controller = new AbortController();
    const pending = runtime.workingAdjustments.unapply({
      projectId: project.projectId,
      expectedActiveAdjustmentId: active.adjustmentId,
      signal: controller.signal,
    });

    await authorityEntered;
    controller.abort("cancelled");
    releaseAuthority?.();

    await expect(pending).rejects.toThrow("cancelled before protected state changed");
    expect(mutations.unapplyCalls()).toBe(0);
    await expect(mutations.store.getActive(project.projectId)).resolves.toEqual(active);

    await expect(
      runtime.workingAdjustments.unapply({
        projectId: project.projectId,
        expectedActiveAdjustmentId: active.adjustmentId,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ status: "unapplied", adjustmentId: active.adjustmentId });
    expect(mutations.unapplyCalls()).toBe(1);
    await expect(mutations.store.getActive(project.projectId)).resolves.toBeUndefined();
  });

  test("abandons cancellation detected at the receipt callback boundary", async () => {
    const mutations = mutableWorkingAdjustments();
    const controller = new AbortController();
    let abortAfterAuthorityPreflight = true;
    const runtime = await runtimeWithWorkingAdjustments(mutations.store, (authority) => {
      const promote: AuthorityBoundary["promote"] = async <Result extends JsonValue>(
        resource: string,
        idempotencyKey: string,
        execute: (receipt: AuthorityReceipt) => Promise<Result>,
        options?: ProtectedAuthorityExecutionOptions,
      ) =>
        await authority.promote(resource, idempotencyKey, execute, {
          beforeExecute: () => {
            options?.beforeExecute?.();
            if (abortAfterAuthorityPreflight) controller.abort("cancelled after preflight");
          },
        });
      return Object.freeze({ ...authority, promote });
    });
    const candidate = adjustment("adjustment-cancelled-at-callback");

    await expect(
      runtime.workingAdjustments.apply({
        adjustment: candidate,
        expectedActiveAdjustmentId: null,
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled before protected state changed");
    expect(mutations.applyCalls()).toBe(0);

    abortAfterAuthorityPreflight = false;
    await expect(
      runtime.workingAdjustments.apply({ adjustment: candidate, expectedActiveAdjustmentId: null }),
    ).resolves.toMatchObject({ status: "applied" });
    expect(mutations.applyCalls()).toBe(1);
  });

  test("reports a replayed successful apply as stale after the active binding changes", async () => {
    const mutations = mutableWorkingAdjustments();
    const runtime = await runtimeWithWorkingAdjustments(mutations.store);
    const first = adjustment("adjustment-first");
    const replacement = adjustment("adjustment-replacement");

    await expect(
      runtime.workingAdjustments.apply({ adjustment: first, expectedActiveAdjustmentId: null }),
    ).resolves.toMatchObject({ status: "applied", replacedAdjustmentId: null });
    await expect(
      runtime.workingAdjustments.apply({
        adjustment: replacement,
        expectedActiveAdjustmentId: first.adjustmentId,
      }),
    ).resolves.toMatchObject({ status: "applied", replacedAdjustmentId: first.adjustmentId });
    await expect(
      runtime.workingAdjustments.apply({ adjustment: first, expectedActiveAdjustmentId: null }),
    ).resolves.toEqual({
      status: "stale",
      adjustmentId: first.adjustmentId,
      currentActiveAdjustmentId: replacement.adjustmentId,
    });
    expect(mutations.applyCalls()).toBe(2);
  });

  test("reports a replayed successful unapply as stale after the adjustment is reactivated", async () => {
    const mutations = mutableWorkingAdjustments();
    const runtime = await runtimeWithWorkingAdjustments(mutations.store);
    const first = adjustment("adjustment-first");
    const intermediate = adjustment("adjustment-intermediate");

    await runtime.workingAdjustments.apply({ adjustment: first, expectedActiveAdjustmentId: null });
    await expect(
      runtime.workingAdjustments.unapply({
        projectId: project.projectId,
        expectedActiveAdjustmentId: first.adjustmentId,
      }),
    ).resolves.toEqual({ status: "unapplied", adjustmentId: first.adjustmentId });
    await runtime.workingAdjustments.apply({ adjustment: intermediate, expectedActiveAdjustmentId: null });
    await runtime.workingAdjustments.apply({
      adjustment: first,
      expectedActiveAdjustmentId: intermediate.adjustmentId,
    });

    await expect(
      runtime.workingAdjustments.unapply({
        projectId: project.projectId,
        expectedActiveAdjustmentId: first.adjustmentId,
      }),
    ).resolves.toEqual({
      status: "stale",
      adjustmentId: first.adjustmentId,
      currentActiveAdjustmentId: first.adjustmentId,
    });
    expect(mutations.unapplyCalls()).toBe(1);
  });

  test("uses a new apply operation when the caller updates its expected active binding", async () => {
    const mutations = mutableWorkingAdjustments();
    const runtime = await runtimeWithWorkingAdjustments(mutations.store);
    const first = adjustment("adjustment-first");
    const next = adjustment("adjustment-next");

    await runtime.workingAdjustments.apply({ adjustment: first, expectedActiveAdjustmentId: null });
    await expect(
      runtime.workingAdjustments.apply({ adjustment: next, expectedActiveAdjustmentId: null }),
    ).resolves.toEqual({
      status: "stale",
      adjustmentId: next.adjustmentId,
      currentActiveAdjustmentId: first.adjustmentId,
    });
    await expect(
      runtime.workingAdjustments.apply({
        adjustment: next,
        expectedActiveAdjustmentId: first.adjustmentId,
      }),
    ).resolves.toMatchObject({ status: "applied", replacedAdjustmentId: first.adjustmentId });
    expect(mutations.applyCalls()).toBe(3);
  });

  test("does not replay adjustment operations across projects with the same adjustment identity", async () => {
    const mutations = mutableWorkingAdjustments();
    const runtime = await runtimeWithWorkingAdjustments(mutations.store);
    const firstProject = Object.freeze({ projectId: "project-first", root: "/tmp/project-first" });
    const secondProject = Object.freeze({ projectId: "project-second", root: "/tmp/project-second" });

    await expect(
      runtime.workingAdjustments.apply({
        adjustment: adjustment("adjustment-shared", firstProject),
        expectedActiveAdjustmentId: null,
      }),
    ).resolves.toMatchObject({ status: "applied" });
    await expect(
      runtime.workingAdjustments.apply({
        adjustment: adjustment("adjustment-shared", secondProject),
        expectedActiveAdjustmentId: null,
      }),
    ).resolves.toMatchObject({ status: "applied" });
    await expect(
      runtime.workingAdjustments.unapply({
        projectId: firstProject.projectId,
        expectedActiveAdjustmentId: "adjustment-shared",
      }),
    ).resolves.toMatchObject({ status: "unapplied" });
    await expect(
      runtime.workingAdjustments.unapply({
        projectId: secondProject.projectId,
        expectedActiveAdjustmentId: "adjustment-shared",
      }),
    ).resolves.toMatchObject({ status: "unapplied" });

    expect(mutations.applyCalls()).toBe(2);
    expect(mutations.unapplyCalls()).toBe(2);
  });

  test("canonicalizes apply identities so delimiter-shaped fields cannot replay another operation", async () => {
    const mutations = mutableWorkingAdjustments();
    const runtime = await runtimeWithWorkingAdjustments(mutations.store);
    const firstProject = Object.freeze({ projectId: "p", root: "/tmp/p" });
    const secondProject = Object.freeze({
      projectId: "p:apply:x:expected:id:v",
      root: "/tmp/p-delimiter",
    });

    await expect(
      runtime.workingAdjustments.apply({
        adjustment: adjustment("x:expected:id:v:apply:x", firstProject),
        expectedActiveAdjustmentId: "e",
      }),
    ).resolves.toMatchObject({ status: "stale" });
    await expect(
      runtime.workingAdjustments.apply({
        adjustment: adjustment("x", secondProject),
        expectedActiveAdjustmentId: "v:apply:x:expected:id:e",
      }),
    ).resolves.toMatchObject({ status: "stale" });

    expect(mutations.applyCalls()).toBe(2);
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
      activations: ports.activations,
      feedback: ports.feedback,
      workingAdjustments: ports.workingAdjustments,
    });
    const expected = Object.freeze({
      effect: "promote" as const,
      resource: "workspace:alpha:turn:session-1:turn-1:pin",
      idempotencyKey: "protected:turn:pin:session-1:turn-1",
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
          async () =>
            await guarded.activations.pinTurn(expected, receipt, {
              sessionId: "session-1",
              turnId: "turn-1",
            }),
        ),
      ).rejects.toThrow(/exact authority receipt/iu);
    expect(mutations).toBe(0);

    const valid = await captureReceipt(owner, expected.resource, expected.idempotencyKey);
    await expect(
      guarded.activations.pinTurn(expected, valid, {
        sessionId: "session-1",
        turnId: "turn-1",
      }),
    ).resolves.toMatchObject({ activationId: "activation-test" });
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
    const activations = Object.freeze({
      ...baseRuntime.activations,
      pinTurn: async (request: Parameters<typeof baseRuntime.activations.pinTurn>[0]) => {
        mutationCalls += 1;
        return await baseRuntime.activations.pinTurn(request);
      },
    });
    const runtime = createProtectedWorkspaceRuntime({
      workspaceRoot: root,
      authority,
      activations,
      feedback: baseRuntime.feedback,
      measurements: baseRuntime.measurements,
      workingAdjustments: baseRuntime.workingAdjustments,
    });

    await expect(
      runtime.activations.pinTurn({
        sessionId: "session-unresolved",
        turnId: "turn-unresolved",
      }),
    ).rejects.toThrow(/authority ambiguous.*authoritative outcome/iu);

    expect(attemptedOperations).toHaveLength(1);
    const attempted = attemptedOperations[0];
    if (!attempted) throw new Error("Expected the original protected operation attempt");
    expect(attempted.identity.idempotencyKey).toBe("protected:turn:pin:session-unresolved:turn-unresolved");
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
    expect(await baseRuntime.activations.getTurnPin("session-unresolved", "turn-unresolved")).toBeUndefined();
    workspace.close();
  });

  test("public workspace and package index expose no protected mutation or authority surface", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-protected-reachability-"));
    roots.push(root);
    const workspace = await createWorkspaceStore(root);
    expect("authority" in workspace).toBe(false);
    expect("protectedActivations" in workspace).toBe(false);
    expect("protectedFeedback" in workspace).toBe(false);
    expect("compoundingMeasurements" in workspace).toBe(false);
    expect(createWorkspaceRuntimeInternals(workspace).protectedRuntime.activations).toBeDefined();

    const publicIndex = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(publicIndex).not.toMatch(
      /createWorkspaceRuntimeInternals|ProtectedActivationStore|ProtectedFeedbackStore/iu,
    );
    const tui = await readFile(new URL("../../tui/src/index.ts", import.meta.url), "utf8");
    expect(tui).not.toMatch(/protected-runtime|protectedActivations|protectedFeedback/iu);
    const generatedRoleContext = await readFile(
      new URL("../../runtime-pi/src/role-context.ts", import.meta.url),
      "utf8",
    );
    const learningOrgan = await readFile(new URL("../../learning/src/organ.ts", import.meta.url), "utf8");
    expect(`${generatedRoleContext}\n${learningOrgan}`).not.toMatch(
      /workspace\/src\/protected-runtime|createWorkspaceRuntimeInternals/iu,
    );
    workspace.close();
  });
});
