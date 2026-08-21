import {
  sha256,
  type CapabilityRevisionRef,
  type CompoundingReplayRecord,
  type EvidenceRevisionRef,
} from "@noesis/domain";
import { describe, expect, test } from "vitest";
import { computeCompoundingMetrics } from "../src/index.ts";

const servedRevision: CapabilityRevisionRef = {
  kind: "capability_revision",
  capabilityId: "cap-research",
  capabilityRevisionId: "r2",
  bundleDigest: sha256("r2"),
};
const baselineRevision: CapabilityRevisionRef = {
  kind: "capability_revision",
  capabilityId: "cap-research",
  capabilityRevisionId: "r1",
  bundleDigest: sha256("r1"),
};
const evidence = <Kind extends "output" | "judgment">(
  id: string,
  evidenceKind: Kind,
): EvidenceRevisionRef<Kind> => ({
  kind: "evidence_revision",
  revisionId: id,
  workingPath: `evidence/${id}`,
  snapshotPath: `evidence/${id}/content`,
  contentDigest: sha256(id),
  evidenceKind,
});

function pair(
  replayId: string,
  winner: "served" | "baseline" | "tie" | "inconclusive",
  overrides: Partial<Extract<CompoundingReplayRecord, { status: "paired" }>> = {},
): CompoundingReplayRecord {
  return {
    replayId,
    planId: `plan-${replayId}`,
    sessionId: "session-1",
    turnId: `turn-${replayId}`,
    occurredAt: "2026-07-25T01:00:00.000Z",
    scope: "research",
    modelCohort: "fake/fake-1/off",
    servedRevisions: [servedRevision],
    baselineRevisions: [baselineRevision],
    scopeRelated: true,
    correctionExposures: [],
    status: "paired",
    winner,
    railsPassed: true,
    servedOutputEvidence: evidence(`${replayId}-served`, "output"),
    baselineOutputEvidence: evidence(`${replayId}-baseline`, "output"),
    judgmentEvidence: evidence(`${replayId}-judge`, "judgment"),
    servedInputTokens: 120,
    baselineInputTokens: 100,
    injectedContextTokens: 20,
    servedPromptLayerBytes: 800,
    baselinePromptLayerBytes: 600,
    ...overrides,
  };
}

// SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
const query = {
  window: {
    from: "2026-07-01T00:00:00.000Z",
    to: "2026-07-31T23:59:59.999Z",
  },
  scope: "research",
  modelCohort: "fake/fake-1/off",
} as const;

describe("compounding metrics", () => {
  test("a seeded regression lowers paired win rate and exposes honest coverage", () => {
    const before = computeCompoundingMetrics([pair("1", "served"), pair("2", "served")], query);
    const after = computeCompoundingMetrics(
      [
        pair("1", "served"),
        pair("2", "served"),
        pair("3", "baseline"),
        {
          ...pair("4", "tie"),
          status: "excluded",
          exclusionReason: "budget_exhausted",
          exclusionDetail: "No judge budget",
        },
      ],
      query,
    );

    expect(before.servedRevisionWinRate.value).toBe(1);
    expect(after.servedRevisionWinRate).toMatchObject({
      numerator: 2,
      denominator: 3,
      value: 2 / 3,
      scope: "research",
      modelCohort: "fake/fake-1/off",
      window: query.window,
    });
    expect(after.coverage).toEqual({ numerator: 3, denominator: 4, value: 0.75 });
    expect(after.exclusions).toEqual({ budget_exhausted: 1 });
  });

  test("an unrelated injection raises scope leakage", () => {
    const clean = computeCompoundingMetrics([pair("1", "served"), pair("2", "served")], query);
    const leaked = computeCompoundingMetrics(
      [pair("1", "served"), pair("2", "served"), pair("3", "served", { scopeRelated: false })],
      query,
    );

    expect(clean.scopeLeakageRate.value).toBe(0);
    expect(leaked.scopeLeakageRate).toMatchObject({ numerator: 1, denominator: 3, value: 1 / 3 });
  });

  test("reports token and byte tax separately and recurrence per relevant exposure", () => {
    const records = [
      pair("1", "served", {
        correctionExposures: [
          {
            signature: "overexplains-review",
            related: true,
            correctionOccurred: true,
            phase: "pre_activation",
            servedRevisions: [baselineRevision],
          },
        ],
      }),
      pair("2", "served", {
        correctionExposures: [
          {
            signature: "overexplains-review",
            related: true,
            correctionOccurred: false,
            phase: "post_activation",
            servedRevisions: [servedRevision],
          },
          {
            signature: "overexplains-review",
            related: false,
            correctionOccurred: true,
            phase: "post_activation",
            servedRevisions: [servedRevision],
          },
        ],
      }),
    ];

    const result = computeCompoundingMetrics(records, query);

    expect(result.contextTax.injectedContextTokens).toMatchObject({
      numerator: 40,
      denominator: 2,
      value: 20,
      unit: "tokens",
    });
    expect(result.contextTax.promptLayerBytes).toMatchObject({
      numerator: 1600,
      denominator: 2,
      value: 800,
      unit: "bytes",
    });
    expect(result.contextTax.marginalInputTokens.value).toBe(20);
    expect(result.correctionRecurrence[0]).toMatchObject({
      signature: "overexplains-review",
      overall: { numerator: 1, denominator: 2, value: 0.5 },
      preActivation: { numerator: 1, denominator: 1, value: 1 },
      postActivation: { numerator: 0, denominator: 1, value: 0 },
    });
    expect(result.correctionRecurrence[0]?.servedRevisions).toEqual([baselineRevision, servedRevision]);
  });
});
