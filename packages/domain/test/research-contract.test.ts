import { describe, expect, test } from "vitest";
import {
  type CapabilityRevision,
  capabilityRevisionRef,
  type DatabaseRowRef,
  type EvidenceKind,
  type EvidenceRevisionRef,
  type Experiment,
  ExperimentSchema,
  type ExperimentTrial,
  ExperimentTrialSchema,
  type FileRevisionRef,
  isExperimentTransitionAllowed,
  type PreflightPlan,
  PreflightPlanSchema,
  type PreflightReport,
  PreflightReportSchema,
  preflightPlanMatchesExperiment,
  preflightReportMatchesPlan,
} from "../src/index.ts";

const fileRevision = (revisionId: string, digestCharacter: string): FileRevisionRef => ({
  kind: "file_revision",
  revisionId,
  workingPath: `definitions/${revisionId}.md`,
  snapshotPath: `revisions/${revisionId}`,
  contentDigest: digestCharacter.repeat(64),
});

const capabilityRevision = (
  capabilityRevisionId: string,
  promptDigest: string,
  toolDigest: string,
): CapabilityRevision => {
  const router = fileRevision(`${capabilityRevisionId}-router`, "c");
  const tool = fileRevision(`${capabilityRevisionId}-tool`, toolDigest);
  return {
    capabilityRevisionId,
    capabilityId: "writing",
    promptModules: [fileRevision(`${capabilityRevisionId}-prompt`, promptDigest)],
    skills: [fileRevision(`${capabilityRevisionId}-skill`, "b")],
    tools: [tool],
    toolset: {
      toolRevisionIds: [tool.revisionId],
      routerRevision: router,
      strategyId: "voice-router",
    },
    activationPolicy: { mode: "automatic_low_risk", scope: "writing" },
    permissionManifest: { effects: ["read"], resourcePatterns: ["workspace:"], credentialRefs: [] },
    evidenceRefs: [],
    sourceEvaluationDefinitions: [fileRevision(`${capabilityRevisionId}-eval`, "d")],
    requestedPermissionDelta: { addedEffects: [], widenedResources: [], addedCredentialRefs: [] },
  };
};

describe("AC-00 research contract", () => {
  test("validates research schemas and binds preflight to the complete revision bundle", () => {
    const evidence = <Kind extends EvidenceKind>(
      name: string,
      evidenceKind: Kind,
    ): EvidenceRevisionRef<Kind> => ({
      ...fileRevision(name, "e"),
      kind: "evidence_revision",
      evidenceKind,
    });
    const baselineDefinition = capabilityRevision("capability-r1", "1", "2");
    const candidateDefinition = capabilityRevision("capability-r2", "3", "4");
    const baselineRevision = capabilityRevisionRef(baselineDefinition);
    const candidateRevision = capabilityRevisionRef(candidateDefinition);
    const changedToolRevision = capabilityRevisionRef({
      ...candidateDefinition,
      tools: [fileRevision("capability-r2-tool", "5")],
    });
    expect(changedToolRevision.bundleDigest).not.toBe(candidateRevision.bundleDigest);

    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const motivatingMessage = {
      kind: "database_row",
      table: "messages",
      rowId: "message-1",
    } as const;
    const sharedCase = evidence("case-1", "input");
    const baselineOutput = evidence("baseline-output-1", "output");
    const candidateOutput = evidence("candidate-output-1", "output");
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const variant = {
      variantId: "fake-runtime",
      axis: "evaluation",
      configurationRefs: [],
    } as const;
    const experiment: Experiment = {
      experimentId: "experiment-1",
      hypothesis: "The candidate preserves the user's voice more reliably",
      scope: "writing",
      evidenceRefs: [motivatingMessage, sharedCase],
      baselineRevision,
      candidateRevisions: [candidateRevision],
      feedbackSignalIds: [],
      status: "hypothesis",
    };
    expect(ExperimentSchema.safeParse(experiment).success).toBe(true);
    expect(isExperimentTransitionAllowed("hypothesis", "authoring")).toBe(true);
    expect(isExperimentTransitionAllowed("authoring", "completed")).toBe(false);
    const plan: PreflightPlan = {
      planId: "plan-1",
      experimentId: experiment.experimentId,
      candidateRevision,
      baselineRevision,
      caseRefs: [sharedCase],
      judgeVariant: variant,
      runtimeVariant: variant,
      budget: { maxCases: 1, maxAttemptsPerArm: 1, maxCost: 1 },
    };
    expect(PreflightPlanSchema.safeParse(plan).success).toBe(true);
    expect(preflightPlanMatchesExperiment(experiment, plan)).toBe(true);
    expect(
      preflightPlanMatchesExperiment(experiment, { ...plan, candidateRevision: changedToolRevision }),
    ).toBe(false);

    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const commonTrial = {
      experimentId: experiment.experimentId,
      comparisonGroupId: "comparison-1",
      inputRefs: [motivatingMessage, sharedCase],
      traceEvidenceRefs: [],
      variant,
      status: "completed",
    } as const;
    const baselineTrial: ExperimentTrial = {
      ...commonTrial,
      trialId: "trial-baseline",
      arm: "baseline",
      capabilityRevision: baselineRevision,
      outputEvidenceRefs: [baselineOutput],
    };
    const candidateTrial: ExperimentTrial = {
      ...commonTrial,
      trialId: "trial-candidate",
      arm: "candidate",
      capabilityRevision: candidateRevision,
      outputEvidenceRefs: [candidateOutput],
    };
    expect(ExperimentTrialSchema.safeParse(baselineTrial).success).toBe(true);
    const trialRowRefs: readonly DatabaseRowRef<"experiment_trials">[] = [
      { kind: "database_row", table: "experiment_trials", rowId: baselineTrial.trialId },
      { kind: "database_row", table: "experiment_trials", rowId: candidateTrial.trialId },
    ];

    const reportEvidence = evidence("report-1", "report");
    const judgmentEvidence = evidence("judgment-1", "judgment");
    const report: PreflightReport = {
      preflightId: "preflight-1",
      experimentId: experiment.experimentId,
      planId: plan.planId,
      candidateRevision,
      baselineRevision,
      trialRowRefs,
      trialEvidence: [baselineOutput, candidateOutput],
      judgmentEvidence: [judgmentEvidence],
      appliedCriteria: [],
      railChecks: [{ rail: "same-authority", passed: true, evidenceRefs: [] }],
      comparison: { winner: "candidate", confidence: 0.9, summary: "Candidate wins the paired trial" },
      decision: "pass",
      reportEvidence,
    };
    expect(PreflightReportSchema.safeParse(report).success).toBe(true);
    expect(
      PreflightReportSchema.safeParse({
        ...report,
        trialRowRefs: [motivatingMessage, trialRowRefs[1]],
      }).success,
    ).toBe(false);
    expect(
      PreflightReportSchema.safeParse({
        ...report,
        trialEvidence: [judgmentEvidence, candidateOutput],
      }).success,
    ).toBe(false);
    expect(preflightReportMatchesPlan(plan, report)).toBe(true);
    expect(preflightReportMatchesPlan(plan, { ...report, candidateRevision: changedToolRevision })).toBe(
      false,
    );
    type MessageRowCannotBeTrial =
      DatabaseRowRef<"messages"> extends DatabaseRowRef<"experiment_trials"> ? false : true;
    type InputEvidenceCannotBeOutput =
      EvidenceRevisionRef<"input"> extends EvidenceRevisionRef<"output"> ? false : true;
    const refsRemainSpecific: readonly [MessageRowCannotBeTrial, InputEvidenceCannotBeOutput] = [true, true];
    expect(refsRemainSpecific).toEqual([true, true]);
    const completedWithoutOutcome = {
      experimentId: experiment.experimentId,
      hypothesis: experiment.hypothesis,
      scope: experiment.scope,
      evidenceRefs: experiment.evidenceRefs,
      baselineRevision,
      candidateRevisions: [candidateRevision],
      feedbackSignalIds: [],
      status: "completed",
    };
    expect(ExperimentSchema.safeParse(completedWithoutOutcome).success).toBe(false);
    expect(ExperimentSchema.safeParse({ ...experiment, outcome: "keep" }).success).toBe(false);
  });
});
