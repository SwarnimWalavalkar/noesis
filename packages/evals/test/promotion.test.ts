import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { candidateDigest, createCapabilityRegistry, type CapabilityRegistry } from "@noesis/capabilities";
import { createExperienceLedger } from "@noesis/ledger";
import { createAuthorityBoundary, type AuthorityBoundary } from "@noesis/policy";
import {
  createEvaluationLab,
  PROTECTED_EVALUATION_SUITE_DIGEST,
  PROTECTED_PROMOTION_POLICY,
} from "../src/index.ts";

describe("candidate evaluation and promotion", () => {
  const promote = async (
    authority: AuthorityBoundary,
    registry: CapabilityRegistry,
    id: string,
    version: number,
  ) => {
    const resource = `capability:${id}@${version}:promote`;
    const decision = await authority.promote(resource, `promote:${id}:${version}`, async (receipt) => {
      await registry.promote(id, version, receipt);
      return null;
    });
    if (!decision.ok) throw new Error(decision.reason);
  };

  test("loads the immutable stored candidate and rejects a digest-spoofed evaluation", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-eval-spoof-"));
    const ledger = createExperienceLedger(root);
    await ledger.initialize();
    const authority = createAuthorityBoundary(ledger);
    const registry = createCapabilityRegistry(ledger, PROTECTED_PROMOTION_POLICY, authority.receiptVerifier);
    const unsafe = await registry.createCandidate({
      name: "research",
      description: "Research workflow",
      instructions: "do an unsafe shortcut",
      evidenceEventIds: ["evt-1"],
      manifest: { effects: ["read"], resourcePrefixes: ["workspace:"], maxCostPerRun: 1 },
      cases: [
        { caseId: "source", source: "source", input: "x", expectedIncludes: ["unsafe"], baselineScore: 0 },
      ],
    });
    const report = await createEvaluationLab(ledger, registry).evaluate(unsafe.capabilityId, unsafe.version);
    expect(report.candidateDigest).toBe(candidateDigest(unsafe));
    expect(report.passed).toBe(false);

    await ledger.append({
      type: "capability.evaluated",
      principal: "evaluator",
      payload: {
        capabilityId: unsafe.capabilityId,
        version: unsafe.version,
        candidateDigest: "0".repeat(64),
        suiteId: PROTECTED_PROMOTION_POLICY.suiteId,
        suiteDigest: PROTECTED_EVALUATION_SUITE_DIGEST,
        passed: true,
        score: 1,
      },
    });
    await expect(promote(authority, registry, unsafe.capabilityId, unsafe.version)).rejects.toThrow(
      /digest-bound|passing/,
    );
  });

  test("keeps held-out cases outside ordinary candidate authoring and promotes through authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-eval-pass-"));
    const ledger = createExperienceLedger(root);
    await ledger.initialize();
    const authority = createAuthorityBoundary(ledger);
    const registry = createCapabilityRegistry(ledger, PROTECTED_PROMOTION_POLICY, authority.receiptVerifier);
    const candidate = await registry.createCandidate({
      name: "research",
      description: "Research workflow",
      instructions: "apply an evidenced completion pattern",
      evidenceEventIds: ["evt-1"],
      manifest: { effects: ["read"], resourcePrefixes: ["workspace:"], maxCostPerRun: 1 },
      cases: [
        {
          caseId: "source",
          source: "source",
          input: "x",
          expectedIncludes: ["evidenced", "pattern"],
          baselineScore: 0.5,
        },
      ],
    });
    const report = await createEvaluationLab(ledger, registry).evaluate(
      candidate.capabilityId,
      candidate.version,
    );
    expect(report.results.some((result) => result.source === "held-out")).toBe(true);
    expect(report.passed).toBe(true);
    await promote(authority, registry, candidate.capabilityId, candidate.version);
    expect(registry.listActive()).toHaveLength(1);
    const rollbackResource = `capability:${candidate.capabilityId}@${candidate.version}:rollback`;
    const rollback = await authority.rollback(rollbackResource, "rollback:test", async (receipt) => {
      await registry.rollback(candidate.capabilityId, candidate.version, "regression observed", receipt);
      return null;
    });
    expect(rollback.ok).toBe(true);
    expect(registry.listActive()).toHaveLength(0);
  });

  test("a registry promotion API cannot be called without a non-forgeable authority receipt", async () => {
    const ledger = createExperienceLedger(await mkdtemp(join(tmpdir(), "noesis-eval-authority-")));
    await ledger.initialize();
    const authority = createAuthorityBoundary(ledger);
    const registry = createCapabilityRegistry(ledger, PROTECTED_PROMOTION_POLICY, authority.receiptVerifier);
    await expect(registry.promote("missing", 1, undefined as never)).rejects.toThrow("authority");
  });

  test("rejects a matching receipt issued by another ledger authority", async () => {
    const firstLedger = createExperienceLedger(await mkdtemp(join(tmpdir(), "noesis-eval-owner-a-")));
    const secondLedger = createExperienceLedger(await mkdtemp(join(tmpdir(), "noesis-eval-owner-b-")));
    await Promise.all([firstLedger.initialize(), secondLedger.initialize()]);
    const firstAuthority = createAuthorityBoundary(firstLedger);
    const secondAuthority = createAuthorityBoundary(secondLedger);
    const secondRegistry = createCapabilityRegistry(
      secondLedger,
      PROTECTED_PROMOTION_POLICY,
      secondAuthority.receiptVerifier,
    );
    const candidate = await secondRegistry.createCandidate({
      capabilityId: "shared-owner",
      name: "research",
      description: "Research workflow",
      instructions: "apply an evidenced completion pattern",
      evidenceEventIds: ["evt-1"],
      manifest: { effects: ["read"], resourcePrefixes: ["workspace:"], maxCostPerRun: 1 },
      cases: [
        {
          caseId: "source",
          source: "source",
          input: "x",
          expectedIncludes: ["evidenced", "pattern"],
          baselineScore: 0.5,
        },
      ],
    });
    await createEvaluationLab(secondLedger, secondRegistry).evaluate(
      candidate.capabilityId,
      candidate.version,
    );
    const resource = `capability:${candidate.capabilityId}@${candidate.version}:promote`;

    const foreignDecision = await firstAuthority.promote(
      resource,
      "promote:foreign-owner",
      async (receipt) => {
        await secondRegistry.promote(candidate.capabilityId, candidate.version, receipt);
        return null;
      },
    );
    expect(foreignDecision).toMatchObject({
      ok: false,
      code: "failed",
      reason: "Promotion requires authority",
    });
    expect(secondRegistry.listActive()).toHaveLength(0);

    await expect(
      promote(secondAuthority, secondRegistry, candidate.capabilityId, candidate.version),
    ).resolves.toBeUndefined();
    expect(secondRegistry.listActive()).toHaveLength(1);
  });
});
