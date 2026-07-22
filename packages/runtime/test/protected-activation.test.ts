import { describe, expect, test } from "vitest";
import { activationIsBoundToPreflight, type ActivationWriteRequest } from "../src/protected-activation.ts";

describe("protected activation contract", () => {
  test("rejects activation when any coupled revision byte changes after preflight", () => {
    const candidateRevision = {
      kind: "capability_revision",
      capabilityId: "writing",
      capabilityRevisionId: "writing-r2",
      bundleDigest: "a".repeat(64),
    } as const;
    const request: ActivationWriteRequest = {
      activationId: "activation-1",
      expectedRevision: 1,
      capabilityRevision: candidateRevision,
      activeDefinitions: {},
      previousActivationId: null,
      preflight: {
        preflightId: "preflight-1",
        planId: "plan-1",
        candidateRevision,
        reportEvidence: {
          kind: "evidence_revision",
          revisionId: "report-1",
          workingPath: "evidence/report-1.json",
          snapshotPath: "evidence/revisions/report-1.json",
          contentDigest: "b".repeat(64),
          evidenceKind: "report",
        },
      },
    };

    expect(activationIsBoundToPreflight(request)).toBe(true);
    expect(
      activationIsBoundToPreflight({
        ...request,
        capabilityRevision: { ...candidateRevision, bundleDigest: "c".repeat(64) },
      }),
    ).toBe(false);
  });
});
