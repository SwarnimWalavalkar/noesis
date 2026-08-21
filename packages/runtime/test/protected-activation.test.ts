import type { CapabilityRevision, PreflightReport } from "@noesis/domain";
import { capabilityRevisionRef } from "@noesis/domain";
import { describe, expect, test } from "vitest";
import {
  activationIsBoundToPreflight,
  type ActivationWriteRequest,
  type RecordedPreflightReportReadPort,
} from "../src/protected-activation.ts";

// SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
const fileRevision = (revisionId: string, digestCharacter: string) => ({
  kind: "file_revision" as const,
  revisionId,
  workingPath: `definitions/${revisionId}.md`,
  snapshotPath: `revisions/${revisionId}`,
  contentDigest: digestCharacter.repeat(64),
});

// SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
const evidence = <Kind extends "output" | "judgment" | "report">(revisionId: string, evidenceKind: Kind) => ({
  kind: "evidence_revision" as const,
  revisionId,
  workingPath: `evidence/${revisionId}.json`,
  snapshotPath: `evidence/revisions/${revisionId}.json`,
  contentDigest: "e".repeat(64),
  evidenceKind,
});

const materializedRevision = (): CapabilityRevision => {
  const tool = fileRevision("writing-r2-tool", "c");
  return {
    capabilityRevisionId: "writing-r2",
    capabilityId: "writing",
    promptModules: [fileRevision("writing-r2-prompt", "a")],
    skills: [fileRevision("writing-r2-skill", "b")],
    tools: [tool],
    toolset: {
      toolRevisionIds: [tool.revisionId],
      routerRevision: fileRevision("writing-r2-router", "d"),
      strategyId: "writing-router",
    },
    activationPolicy: { mode: "automatic_low_risk", scope: "writing" },
    permissionManifest: { effects: ["read"], resourcePatterns: ["workspace:"], credentialRefs: [] },
    evidenceRefs: [],
    sourceEvaluationDefinitions: [fileRevision("writing-r2-evaluation", "f")],
    requestedPermissionDelta: { addedEffects: [], widenedResources: [], addedCredentialRefs: [] },
  };
};

const passingReport = (revision: CapabilityRevision): PreflightReport => ({
  preflightId: "preflight-1",
  experimentId: "experiment-1",
  planId: "plan-1",
  candidateRevision: capabilityRevisionRef(revision),
  baselineRevision: {
    kind: "capability_revision",
    capabilityId: "writing",
    capabilityRevisionId: "writing-r1",
    bundleDigest: "1".repeat(64),
  },
  trialRowRefs: [
    { kind: "database_row", table: "experiment_trials", rowId: "trial-baseline" },
    { kind: "database_row", table: "experiment_trials", rowId: "trial-candidate" },
  ],
  trialEvidence: [evidence("baseline-output", "output"), evidence("candidate-output", "output")],
  judgmentEvidence: [evidence("judgment-1", "judgment")],
  appliedCriteria: [],
  railChecks: [],
  comparison: { winner: "candidate", confidence: 0.9, summary: "Candidate passed" },
  decision: "pass",
  reportEvidence: evidence("report-1", "report"),
});

describe("protected activation contract", () => {
  test("binds activation to the materialized bundle and a recorded passing report", async () => {
    const revision = materializedRevision();
    const report = passingReport(revision);
    const reports = new Map<string, unknown>([[report.preflightId, report]]);
    const preflights: RecordedPreflightReportReadPort = {
      readPreflightReport: async (ref) => reports.get(ref.rowId),
    };
    const request: ActivationWriteRequest = {
      activationId: "activation-1",
      expectedRevision: 1,
      materializedRevision: revision,
      previousActivationId: null,
      preflightReportRef: {
        kind: "database_row",
        table: "preflight_reports",
        rowId: report.preflightId,
      },
    };

    await expect(activationIsBoundToPreflight(request, preflights)).resolves.toBe(true);

    const changedDefinitions: CapabilityRevision = {
      ...revision,
      tools: [fileRevision("writing-r2-tool", "9")],
    };
    await expect(
      activationIsBoundToPreflight({ ...request, materializedRevision: changedDefinitions }, preflights),
    ).resolves.toBe(false);
    await expect(
      activationIsBoundToPreflight(
        { ...request, preflightReportRef: { ...request.preflightReportRef, rowId: "other-report" } },
        preflights,
      ),
    ).resolves.toBe(false);
    reports.set(report.preflightId, { ...report, decision: "block" });
    await expect(activationIsBoundToPreflight(request, preflights)).resolves.toBe(false);
    reports.set(report.preflightId, { ...report, decision: "approval_required" });
    await expect(activationIsBoundToPreflight(request, preflights)).resolves.toBe(false);
  });

  test("rejects non-report evidence at the storage boundary", async () => {
    const revision = materializedRevision();
    const report = passingReport(revision);
    const request: ActivationWriteRequest = {
      activationId: "activation-1",
      expectedRevision: 1,
      materializedRevision: revision,
      previousActivationId: null,
      preflightReportRef: {
        kind: "database_row",
        table: "preflight_reports",
        rowId: report.preflightId,
      },
    };

    const reports = new Map<string, unknown>([
      [
        report.preflightId,
        {
          ...report,
          reportEvidence: { ...report.reportEvidence, evidenceKind: "judgment" },
        },
      ],
    ]);
    const preflights: RecordedPreflightReportReadPort = {
      readPreflightReport: async (ref) => reports.get(ref.rowId),
    };

    await expect(activationIsBoundToPreflight(request, preflights)).resolves.toBe(false);
  });
});
