import { describe, expect, test } from "vitest";
import {
  ExperimentSchema,
  ExperimentTrialSchema,
  PreflightPlanSchema,
  PreflightReportSchema,
  capabilityRevisionRef,
  declaredAuthorityFor,
  isExperimentTransitionAllowed,
  preflightPlanMatchesExperiment,
  preflightReportMatchesPlan,
  sha256,
  type CapabilityRevision,
  type ArtifactFileRef,
  type ArtifactWriteRequest,
  type DatabaseRowRef,
  type DatabaseTable,
  type DefinitionMetadataCommitRequest,
  type DefinitionMetadataCommitResult,
  type DefinitionWriteRequest,
  type EvaluationRecord,
  type EvidenceKind,
  type EvidenceRevisionRef,
  type EvidenceWriteRequest,
  type Experiment,
  type ExperimentTrial,
  type FeedbackSignal,
  type FileRevisionRef,
  type PreflightPlan,
  type PreflightReport,
  type ResearchStatePort,
  type WorkspaceStore,
} from "../src/index.ts";

const fileRevision = (revisionId: string, digestCharacter: string): FileRevisionRef => ({
  kind: "file_revision",
  revisionId,
  workingPath: `definitions/${revisionId}.md`,
  snapshotPath: `revisions/${revisionId}`,
  contentDigest: digestCharacter.repeat(64),
});

function createFakeResearchState(): ResearchStatePort {
  const experiments = new Map<string, Experiment>();
  const trials = new Map<string, ExperimentTrial>();
  const plans = new Map<string, PreflightPlan>();
  const reports = new Map<string, PreflightReport>();
  const evaluations = new Map<string, EvaluationRecord>();
  const feedbackSignals = new Map<string, FeedbackSignal>();
  const row = <Table extends DatabaseTable>(table: Table, rowId: string): DatabaseRowRef<Table> => ({
    kind: "database_row",
    table,
    rowId,
  });

  return Object.freeze({
    experiments: Object.freeze({
      getExperiment: async (experimentId: string) => experiments.get(experimentId),
      listExperiments: async (request: Parameters<ResearchStatePort["experiments"]["listExperiments"]>[0]) =>
        [...experiments.values()]
          .filter((experiment) => request.status === undefined || experiment.status === request.status)
          .slice(0, request.limit),
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
      completePreflight: async ({
        report,
        evaluation,
      }: {
        readonly report: PreflightReport;
        readonly evaluation: EvaluationRecord;
      }) => {
        reports.set(report.preflightId, report);
        evaluations.set(evaluation.evaluationId, evaluation);
        return {
          report: row("preflight_reports", report.preflightId),
          evaluation: row("evaluations", evaluation.evaluationId),
        };
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

function createFakeWorkspaceStore(): WorkspaceStore {
  const encoder = new TextEncoder();
  const evidenceBytes = new Map<string, Uint8Array>();
  const workingFiles = new Map<string, Uint8Array>();
  const revisions = new Map<string, FileRevisionRef>();
  const revisionBytes = new Map<string, Uint8Array>();
  let nextRevision = 1;

  const copy = (bytes: Uint8Array): Uint8Array => Uint8Array.from(bytes);
  const recordDefinition = async (request: DefinitionWriteRequest): Promise<FileRevisionRef> => {
    const revisionId = `definition-${nextRevision++}`;
    const bytes = copy(request.bytes);
    const ref: FileRevisionRef = {
      kind: "file_revision",
      revisionId,
      workingPath: request.workingPath,
      snapshotPath: `revisions/${revisionId}`,
      contentDigest: sha256(bytes),
    };
    workingFiles.set(request.workingPath, bytes);
    revisions.set(revisionId, ref);
    revisionBytes.set(revisionId, bytes);
    return ref;
  };

  return Object.freeze({
    reads: Object.freeze({
      readDatabaseRow: async () => undefined,
      readWorkingFile: async (workingPath: string) => workingFiles.get(workingPath),
      readRevision: async (ref: FileRevisionRef) => {
        const bytes = revisionBytes.get(ref.revisionId);
        if (!bytes) throw new Error(`Missing revision: ${ref.revisionId}`);
        return copy(bytes);
      },
      readEvidence: async (ref: EvidenceRevisionRef) => {
        const bytes = evidenceBytes.get(ref.revisionId);
        if (!bytes) throw new Error(`Missing evidence: ${ref.revisionId}`);
        return copy(bytes);
      },
      readArtifact: async () => encoder.encode("fake artifact"),
    }),
    definitions: Object.freeze({
      recordWorkingDefinition: recordDefinition,
      recordCandidateDefinition: recordDefinition,
    }),
    definitionMetadata: Object.freeze({
      getCurrent: async () => undefined,
      listCurrent: async () => [],
      listRevisions: async () => [],
      commitRevision: async (
        request: DefinitionMetadataCommitRequest,
      ): Promise<DefinitionMetadataCommitResult> => ({
        ok: true,
        value: {
          namespace: request.namespace,
          definitionId: request.definitionId,
          revision: request.revision,
          definitionRevision: request.definitionRevision,
          fileRevisionRow: {
            kind: "database_row",
            table: "file_revisions",
            rowId: request.definitionRevision.revisionId,
          },
          activityRow: {
            kind: "database_row",
            table: "activity_log",
            rowId: `activity-${request.definitionRevision.revisionId}`,
          },
        },
      }),
    }),
    definitionPublications: Object.freeze({
      publish: async () => ({ ok: false, error: { code: "conflict", message: "not implemented" } }) as const,
      recoverPending: async () => 0,
      cleanupAbandoned: async () => 0,
    }),
    revisions: Object.freeze({
      resolveRevision: async (revisionId: string) => revisions.get(revisionId),
      removeUnregisteredSnapshots: async () => 0,
    }),
    evidence: Object.freeze({
      appendEvidence: async <Kind extends EvidenceKind>(request: EvidenceWriteRequest<Kind>) => {
        const revisionId = `evidence-${nextRevision++}`;
        const bytes = copy(request.bytes);
        const ref: EvidenceRevisionRef<Kind> = {
          kind: "evidence_revision",
          revisionId,
          workingPath: request.workingPath,
          snapshotPath: `evidence/revisions/${revisionId}`,
          contentDigest: sha256(bytes),
          evidenceKind: request.evidenceKind,
        };
        evidenceBytes.set(revisionId, bytes);
        return ref;
      },
    }),
    artifacts: Object.freeze({
      writeArtifact: async (request: ArtifactWriteRequest): Promise<ArtifactFileRef> => ({
        kind: "artifact_file",
        artifactId: `artifact-${sha256(request.bytes)}`,
        path: request.path,
        mediaType: request.mediaType,
      }),
    }),
    research: createFakeResearchState(),
    jobs: Object.freeze({
      enqueue: async () => {
        throw new Error("unused fake job store");
      },
      recordObservation: async () => undefined,
      get: async () => undefined,
      list: async () => [],
      listPage: async () => Object.freeze({ records: Object.freeze([]), exhausted: true }),
      claim: async () => undefined,
      renew: async () => false,
      complete: async () => false,
      fail: async () => {
        throw new Error("unused fake job store");
      },
      cancel: async () => undefined,
      retry: async () => {
        throw new Error("unused fake job store");
      },
    }),
    declaredAuthority: declaredAuthorityFor,
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
    const store = createFakeWorkspaceStore();
    const research = store.research;
    const encoder = new TextEncoder();
    const appendEvidence = async <Kind extends EvidenceKind>(
      name: string,
      evidenceKind: Kind,
    ): Promise<EvidenceRevisionRef<Kind>> => {
      const bytes = encoder.encode(`${evidenceKind}:${name}`);
      const ref = await store.evidence.appendEvidence({
        workingPath: `evidence/${name}.json`,
        bytes,
        actor: { actorId: "fake-evaluator", kind: "system" },
        evidenceKind,
      });
      expect(await store.reads.readEvidence(ref)).toEqual(bytes);
      return ref;
    };
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
    const sharedCase = await appendEvidence("case-1", "input");
    const baselineOutput = await appendEvidence("baseline-output-1", "output");
    const candidateOutput = await appendEvidence("candidate-output-1", "output");
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
    await research.experiments.putExperiment(experiment);
    await research.experiments.putExperiment({ ...experiment, status: "authoring" });
    await expect(
      research.experiments.putExperiment({ ...experiment, status: "completed", outcome: "keep" }),
    ).rejects.toThrow("Invalid experiment transition");
    await research.experiments.putExperiment({ ...experiment, status: "preflight" });

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
    await research.preflights.putPreflightPlan(plan);

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
      research.trials.putTrial(baselineTrial),
      research.trials.putTrial(candidateTrial),
    ]);

    const reportEvidence = await appendEvidence("report-1", "report");
    const judgmentEvidence = await appendEvidence("judgment-1", "judgment");
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
    const reportRowRef = await research.preflights.putPreflightReport(report);
    type MessageRowCannotBeTrial =
      DatabaseRowRef<"messages"> extends DatabaseRowRef<"experiment_trials"> ? false : true;
    type InputEvidenceCannotBeOutput =
      EvidenceRevisionRef<"input"> extends EvidenceRevisionRef<"output"> ? false : true;
    const refsRemainSpecific: readonly [MessageRowCannotBeTrial, InputEvidenceCannotBeOutput] = [true, true];
    expect(refsRemainSpecific).toEqual([true, true]);
    await research.evaluations.putEvaluation({
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
      preflightRef: reportRowRef,
    };
    await research.experiments.putExperiment(completed);

    expect(await research.experiments.getExperiment(experiment.experimentId)).toEqual(completed);
    expect(await research.trials.listTrials(experiment.experimentId)).toEqual([
      baselineTrial,
      candidateTrial,
    ]);
    expect(await research.preflights.getPreflightPlan(plan.planId)).toEqual(plan);
    expect(await research.preflights.getPreflightReport(report.preflightId)).toEqual(report);
    expect(await research.evaluations.listEvaluations(experiment.experimentId)).toHaveLength(1);
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
