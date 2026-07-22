import { describe, expect, test } from "vitest";
import {
  ExperimentSchema,
  ExperimentTrialSchema,
  PreflightReportSchema,
  type EvidenceRevisionRef,
  type ExperimentTrial,
  type FileRevisionRef,
} from "../src/index.ts";

const digest = (value: string): string => value.repeat(64).slice(0, 64);

const revision = (revisionId: string): FileRevisionRef => ({
  kind: "file_revision",
  revisionId,
  workingPath: `definitions/${revisionId}.md`,
  snapshotPath: `revisions/${revisionId}`,
  contentDigest: digest(revisionId.at(-1) ?? "a"),
});

const evidence = (
  revisionId: string,
  evidenceKind: EvidenceRevisionRef["evidenceKind"],
): EvidenceRevisionRef => ({
  kind: "evidence_revision",
  revisionId,
  workingPath: `evidence/${revisionId}.json`,
  snapshotPath: `evidence/revisions/${revisionId}.json`,
  contentDigest: digest(revisionId.at(-1) ?? "b"),
  evidenceKind,
});

describe("AC-00 research contract", () => {
  test("records a comparable fake experiment with DB-row inputs and evidence-file outputs", () => {
    const motivatingMessage = {
      kind: "database_row",
      table: "messages",
      rowId: "message-1",
    } as const;
    const sharedCase = evidence("case-1", "input");
    const baselineOutput = evidence("baseline-output-1", "output");
    const candidateOutput = evidence("candidate-output-1", "output");
    const baselineRevision = revision("capability-r1");
    const candidateRevision = revision("capability-r2");
    const variant = {
      variantId: "fake-runtime",
      axis: "evaluation",
      configurationRefs: [],
    } as const;
    const commonTrial = {
      experimentId: "experiment-1",
      comparisonGroupId: "comparison-1",
      inputRefs: [motivatingMessage, sharedCase],
      traceEvidenceRefs: [],
      variant,
      status: "completed",
    } as const;
    const trials: readonly ExperimentTrial[] = [
      {
        ...commonTrial,
        trialId: "trial-baseline",
        arm: "baseline",
        capabilityRevisionId: baselineRevision.revisionId,
        outputEvidenceRefs: [baselineOutput],
      },
      {
        ...commonTrial,
        trialId: "trial-candidate",
        arm: "candidate",
        capabilityRevisionId: candidateRevision.revisionId,
        outputEvidenceRefs: [candidateOutput],
      },
    ];

    const parsedExperiment = ExperimentSchema.parse({
      experimentId: "experiment-1",
      hypothesis: "The candidate preserves the user's voice more reliably",
      scope: "writing",
      evidenceRefs: [motivatingMessage, sharedCase],
      baselineRevisionId: baselineRevision.revisionId,
      candidateRevisionIds: [candidateRevision.revisionId],
      feedbackSignalIds: [],
      status: "preflight",
    });
    const parsedTrials = trials.map((trial) => ExperimentTrialSchema.parse(trial));
    const report = PreflightReportSchema.parse({
      preflightId: "preflight-1",
      candidateRevision,
      baselineRevision,
      trialRowRefs: parsedTrials.map((trial) => ({
        kind: "database_row",
        table: "experiment_trials",
        rowId: trial.trialId,
      })),
      trialEvidence: [baselineOutput, candidateOutput],
      judgmentEvidence: [evidence("judgment-1", "judgment")],
      appliedCriteria: [],
      railChecks: [{ rail: "same-authority", passed: true, evidenceRefs: [] }],
      comparison: { winner: "candidate", confidence: 0.9, summary: "Candidate wins the paired trial" },
      decision: "pass",
      reportEvidence: evidence("report-1", "report"),
    });

    expect(parsedExperiment.evidenceRefs).toContainEqual(motivatingMessage);
    expect(parsedTrials[0]?.inputRefs).toEqual(parsedTrials[1]?.inputRefs);
    expect(report.trialRowRefs.map((ref) => ref.rowId)).toEqual(["trial-baseline", "trial-candidate"]);
    expect(report.trialEvidence).toEqual([baselineOutput, candidateOutput]);
  });
});
