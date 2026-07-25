import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FrozenTurnPlan } from "@noesis/agent-types";
import type { CapabilityRevisionRef, FileRevisionRef } from "@noesis/domain";
import { createExperienceLedger } from "../../ledger/src/index.ts";
import { authorityOperationFields, createAuthorityBoundary, type AuthorityReceipt } from "@noesis/policy";
import { afterEach, describe, expect, test } from "vitest";
import { createWorkspaceStore } from "../src/index.ts";
import {
  createReceiptGuardedProtectedMutations,
  createWorkspaceRuntimeInternals,
} from "../src/protected-runtime.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

const unsupported = async (): Promise<never> => {
  throw new Error("unused protected mutation");
};

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
      putResearchRun: unsupported,
      commitOutcome: unsupported,
    }),
  });
}

async function authorityAt(path: string) {
  const ledger = createExperienceLedger(path);
  await ledger.initialize();
  return createAuthorityBoundary(ledger);
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
