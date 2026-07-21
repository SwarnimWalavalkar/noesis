import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { toJsonValue } from "@noesis/domain";
import { createExperienceLedger } from "@noesis/ledger";
import { createCapabilityRegistry } from "../src/index.ts";

const candidateInput = {
  name: "research",
  description: "Research workflow",
  instructions: "Use evidence",
  evidenceEventIds: ["evt-source"],
  manifest: { effects: ["read"], resourcePrefixes: ["workspace:"], maxCostPerRun: 1 },
  cases: [
    {
      caseId: "source",
      source: "source",
      input: "question",
      expectedIncludes: ["evidence"],
      baselineScore: 0,
    },
  ],
} as const;

describe("capability registry factory", () => {
  test("isolates version state across independent factory closures", async () => {
    const firstLedger = createExperienceLedger(await mkdtemp(join(tmpdir(), "noesis-capability-first-")));
    const secondLedger = createExperienceLedger(await mkdtemp(join(tmpdir(), "noesis-capability-second-")));
    await Promise.all([firstLedger.initialize(), secondLedger.initialize()]);
    const first = createCapabilityRegistry(firstLedger);
    const second = createCapabilityRegistry(secondLedger);

    await first.createCandidate({ ...candidateInput, capabilityId: "shared" });
    await first.createCandidate({ ...candidateInput, capabilityId: "shared" });
    await second.createCandidate({ ...candidateInput, capabilityId: "shared" });

    expect(Object.isFrozen(first)).toBe(true);
    expect(first.getVersions("shared").map((candidate) => candidate.version)).toEqual([1, 2]);
    expect(second.getVersions("shared").map((candidate) => candidate.version)).toEqual([1]);
  });

  test("allocates distinct durable versions for concurrent candidates with one id", async () => {
    const ledger = createExperienceLedger(await mkdtemp(join(tmpdir(), "noesis-capability-race-")));
    await ledger.initialize();
    const registry = createCapabilityRegistry(ledger);

    const candidates = await Promise.all([
      registry.createCandidate({ ...candidateInput, capabilityId: "concurrent" }),
      registry.createCandidate({ ...candidateInput, capabilityId: "concurrent" }),
    ]);

    expect(candidates.map((candidate) => candidate.version).sort()).toEqual([1, 2]);
    expect(registry.getVersions("concurrent").map((candidate) => candidate.version)).toEqual([1, 2]);
    expect(
      ledger.findByType("capability.candidate_created").map((event) => event.payload["version"]),
    ).toEqual([1, 2]);
  });

  test("rejects unknown candidate keys but preserves historically allowed nested extensions", async () => {
    const ledger = createExperienceLedger(await mkdtemp(join(tmpdir(), "noesis-capability-schema-")));
    await ledger.initialize();
    const registry = createCapabilityRegistry(ledger);
    await ledger.append({
      type: "capability.candidate_created",
      principal: "reflector",
      payload: {
        capabilityId: "nested",
        version: 1,
        candidate: toJsonValue({
          schemaVersion: 1,
          capabilityId: "nested",
          version: 1,
          ...candidateInput,
          manifest: { ...candidateInput.manifest, extension: "preserved" },
          cases: [{ ...candidateInput.cases[0], extension: true }],
        }),
      },
    });
    expect(registry.getCandidate("nested", 1)?.manifest).toMatchObject({ extension: "preserved" });
    expect(registry.getCandidate("nested", 1)?.cases[0]).toMatchObject({ extension: true });

    await ledger.append({
      type: "capability.candidate_created",
      principal: "reflector",
      payload: {
        capabilityId: "strict",
        version: 1,
        candidate: toJsonValue({
          schemaVersion: 1,
          capabilityId: "strict",
          version: 1,
          ...candidateInput,
          unexpected: true,
        }),
      },
    });
    expect(() => registry.getCandidate("strict", 1)).toThrow();
  });
});
