import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCapabilityRegistry } from "@noesis/capabilities";
import { createExperienceLedger } from "@noesis/ledger";
import { describe, expect, test } from "vitest";
import {
  createEvaluationLab,
  PROTECTED_EVALUATION_SUITE_DIGEST,
  PROTECTED_PROMOTION_POLICY,
} from "../src/index.ts";

describe("candidate evaluation", () => {
  test("loads the immutable stored candidate and rejects digest-spoofed evaluation state", async () => {
    const ledger = createExperienceLedger(await mkdtemp(join(tmpdir(), "noesis-eval-spoof-")));
    await ledger.initialize();
    const registry = createCapabilityRegistry(ledger, PROTECTED_PROMOTION_POLICY);
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

    expect(registry.getVersions(unsafe.capabilityId)[0]?.status).toBe("rejected");
  });

  test("keeps held-out cases outside ordinary candidate authoring", async () => {
    const ledger = createExperienceLedger(await mkdtemp(join(tmpdir(), "noesis-eval-pass-")));
    await ledger.initialize();
    const registry = createCapabilityRegistry(ledger, PROTECTED_PROMOTION_POLICY);
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
  });
});
