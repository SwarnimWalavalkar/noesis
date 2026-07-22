import { describe, expect, test } from "vitest";
import {
  ExperimentSchema,
  ExperimentTrialSchema,
  PreflightPlanSchema,
  PreflightReportSchema,
  capabilityRevisionRef,
  isExperimentTransitionAllowed,
  preflightPlanMatchesExperiment,
  preflightReportMatchesPlan,
  type CapabilityRevision,
  type DatabaseRowRef,
  type EvaluationRecord,
  type EvidenceRevisionRef,
  type Experiment,
  type ExperimentTrial,
  type FeedbackSignal,
  type FileRevisionRef,
  type PreflightPlan,
  type PreflightReport,
  type ResearchStatePort,
} from "../src/index.ts";

const fileRevision = (revisionId: string, digestCharacter: string): FileRevisionRef => ({
  kind: "file_revision",
  revisionId,
  workingPath: `definitions/${revisionId}.md`,
  snapshotPath: `revisions/${revisionId}`,
  contentDigest: digestCharacter.repeat(64),
});

const evidence = (
  revisionId: string,
  evidenceKind: EvidenceRevisionRef["evidenceKind"],
): EvidenceRevisionRef => ({
  kind: "evidence_revision",
  revisionId,
  workingPath: `evidence/${revisionId}.json`,
  snapshotPath: `evidence/revisions/${revisionId}.json`,
  contentDigest: "e".repeat(64),
  evidenceKind,
});

function createFakeResearchState(): ResearchStatePort {
  const experiments = new Map<string, Experiment>();
  const trials = new Map<string, ExperimentTrial>();
  const plans = new Map<string, PreflightPlan>();
  const reports = new Map<string, PreflightReport>();
  const evaluations = new Map<string, EvaluationRecord>();
  const feedbackSignals = new Map<string, FeedbackSignal>();
  const row = (table: DatabaseRowRef["table"], rowId: string): DatabaseRowRef => ({
    kind: "database_row",
    table,
    rowId,
  });

  return Object.freeze({
    experiments: Object.freeze({
      getExperiment: async (experimentId: string) => experiments.get(experimentId),
      putExperiment: async (experiment: Experiment) => {
        const existing = experiments.get(experiment.experimentId);
        if (
          existing &&
          existing.status !== experiment.status &&
          !isExperimentTransitionAllowed(existing.status, experiment.status)
        ) {
          throw new Error(`Invalid experiment transition: ${existing.status} -> ${experiment.status}`);
        }
        experiments.set(experiment.experimentId, experiment);
        return row("experiments", experiment.experimentId);
      },
    }),
    trials: Object.freeze({
      getTrial: async (trialId: string) => trials.get(trialId),
      listTrials: async (experimentId: string) =>
        [...trials.values()].filter((trial) => trial.experimentId === experimentId),
      putTrial: async (trial: ExperimentTrial) => {
        trials.set(trial.trialId, trial);
        return row("experiment_trials", trial.trialId);
      },
    }),
    preflights: Object.freeze({
      getPreflightPlan: async (planId: string) => plans.get(planId),
      putPreflightPlan: async (plan: PreflightPlan) => {
        plans.set(plan.planId, plan);
        return row("preflight_plans", plan.planId);
      },
      getPreflightReport: async (preflightId: string) => reports.get(preflightId),
      putPreflightReport: async (report: PreflightReport) => {
        reports.set(report.preflightId, report);
        return row("preflight_reports", report.preflightId);
      },
    }),
    evaluations: Object.freeze({
      getEvaluation: async (evaluationId: string) => evaluations.get(evaluationId),
      listEvaluations: async (experimentId: string) =>
        [...evaluations.values()].filter((evaluation) => evaluation.experimentId === experimentId),
      putEvaluation: async (evaluation: EvaluationRecord) => {
        evaluations.set(evaluation.evaluationId, evaluation);
        return row("evaluations", evaluation.evaluationId);
      },
    }),
    feedbackSignals: Object.freeze({
      getFeedbackSignal: async (signalId: string) => feedbackSignals.get(signalId),
      recordFeedbackSignal: async (signal: FeedbackSignal) => {
        feedbackSignals.set(signal.signalId, signal);
        return row("feedback_signals", signal.signalId);
      },
    }),
  });
}

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
  test("round-trips one canonical experiment and binds preflight to the complete revision bundle", async () => {
    const store = createFakeResearchState();
    const baselineDefinition = capabilityRevision("capability-r1", "1", "2");
    const candidateDefinition = capabilityRevision("capability-r2", "3", "4");
    const baselineRevision = capabilityRevisionRef(baselineDefinition);
    const candidateRevision = capabilityRevisionRef(candidateDefinition);
    const changedToolRevision = capabilityRevisionRef({
      ...candidateDefinition,
      tools: [fileRevision("capability-r2-tool", "5")],
    });
    expect(changedToolRevision.bundleDigest).not.toBe(candidateRevision.bundleDigest);

    const motivatingMessage = {
      kind: "database_row",
      table: "messages",
      rowId: "message-1",
    } as const;
    const sharedCase = evidence("case-1", "input");
    const baselineOutput = evidence("baseline-output-1", "output");
    const candidateOutput = evidence("candidate-output-1", "output");
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
    await store.experiments.putExperiment(experiment);
    await store.experiments.putExperiment({ ...experiment, status: "authoring" });
    await expect(
      store.experiments.putExperiment({ ...experiment, status: "completed", outcome: "keep" }),
    ).rejects.toThrow("Invalid experiment transition");
    await store.experiments.putExperiment({ ...experiment, status: "preflight" });

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
    await store.preflights.putPreflightPlan(plan);

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
    const trialRowRefs = await Promise.all([
      store.trials.putTrial(baselineTrial),
      store.trials.putTrial(candidateTrial),
    ]);

    const reportEvidence = evidence("report-1", "report");
    const report: PreflightReport = {
      preflightId: "preflight-1",
      experimentId: experiment.experimentId,
      planId: plan.planId,
      candidateRevision,
      baselineRevision,
      trialRowRefs,
      trialEvidence: [baselineOutput, candidateOutput],
      judgmentEvidence: [evidence("judgment-1", "judgment")],
      appliedCriteria: [],
      railChecks: [{ rail: "same-authority", passed: true, evidenceRefs: [] }],
      comparison: { winner: "candidate", confidence: 0.9, summary: "Candidate wins the paired trial" },
      decision: "pass",
      reportEvidence,
    };
    expect(PreflightReportSchema.safeParse(report).success).toBe(true);
    expect(preflightReportMatchesPlan(plan, report)).toBe(true);
    expect(preflightReportMatchesPlan(plan, { ...report, candidateRevision: changedToolRevision })).toBe(
      false,
    );
    await store.preflights.putPreflightReport(report);
    await store.evaluations.putEvaluation({
      evaluationId: "evaluation-1",
      experimentId: experiment.experimentId,
      preflightId: report.preflightId,
      candidateRevision,
      trialIds: [baselineTrial.trialId, candidateTrial.trialId],
      evidenceRefs: [reportEvidence],
      status: "completed",
    });

    const completed: Experiment = {
      ...experiment,
      status: "completed",
      outcome: "keep",
      activatedRevision: candidateRevision,
      preflightRef: reportEvidence,
    };
    await store.experiments.putExperiment(completed);

    expect(await store.experiments.getExperiment(experiment.experimentId)).toEqual(completed);
    expect(await store.trials.listTrials(experiment.experimentId)).toEqual([baselineTrial, candidateTrial]);
    expect(await store.preflights.getPreflightPlan(plan.planId)).toEqual(plan);
    expect(await store.preflights.getPreflightReport(report.preflightId)).toEqual(report);
    expect(await store.evaluations.listEvaluations(experiment.experimentId)).toHaveLength(1);
    expect(report.candidateRevision).toEqual(candidateRevision);
    expect(report.candidateRevision).not.toEqual(changedToolRevision);

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
