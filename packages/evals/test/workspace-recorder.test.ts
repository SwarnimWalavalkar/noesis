import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sha256,
  type CapabilityRevisionRef,
  type DatabaseRowRef,
  type EvidenceRevisionRef,
  type ExperimentTrial,
  type FileRevisionRef,
} from "@noesis/domain";
import { createWorkspaceStore } from "@noesis/workspace";
import { afterEach, describe, expect, test } from "vitest";
import {
  createWorkspaceEvaluationRecorder,
  type DynamicPreflightReport,
  type EvaluationRoleTrace,
} from "../src/index.ts";

describe("workspace evaluation recorder lifecycle", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
  });

  test("persists the immutable plan before trials and completes report plus evaluation", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-workspace-evaluation-"));
    roots.push(root);
    const workspace = await createWorkspaceStore(root);
    const definition = await workspace.definitions.recordCandidateDefinition({
      workingPath: "evaluation/criterion.json",
      bytes: new TextEncoder().encode("criterion"),
      actor: { actorId: "test", kind: "system" },
    });
    const recorder = createWorkspaceEvaluationRecorder(workspace);
    await workspace.research.experiments.putExperiment({
      experimentId: "experiment-production",
      hypothesis: "Candidate improves citation behavior",
      scope: "research",
      evidenceRefs: [definition],
      baselineRevision: baseline,
      candidateRevisions: [candidate],
      feedbackSignalIds: [],
      status: "preflight",
    });
    const caseEvidence = await recorder.appendEvidence({
      preflightId: "preflight-production",
      name: "case-source",
      kind: "input",
      value: { caseId: "source" },
      provenanceRefs: [definition],
    });
    await recorder.recordPlan({
      planId: "plan-production",
      experimentId: "experiment-production",
      candidateRevision: candidate,
      baselineRevision: baseline,
      caseRefs: [caseEvidence],
      judgeVariant: variant(definition, "judge"),
      runtimeVariant: variant(definition, "trial"),
      budget: { maxCases: 1, maxAttemptsPerArm: 1, maxCost: 0 },
    });
    expect(await workspace.research.preflights.getPreflightPlan("plan-production")).toMatchObject({
      caseRefs: [caseEvidence],
    });

    const baselineOutput = await recorder.appendEvidence({
      preflightId: "preflight-production",
      name: "trial-source-baseline",
      kind: "output",
      value: { content: "baseline" },
      provenanceRefs: [caseEvidence],
    });
    const baselineTrace = await recorder.appendEvidence({
      preflightId: "preflight-production",
      name: "trial-source-baseline-trace",
      kind: "tool_trace",
      value: { traceId: "baseline-trace" },
      provenanceRefs: [caseEvidence, baselineOutput],
    });
    const baselineTrialRowRef = await recorder.recordTrial({
      trialId: "trial-production-baseline",
      experimentId: "experiment-production",
      comparisonGroupId: "comparison-production",
      arm: "baseline",
      capabilityRevision: baseline,
      inputRefs: [caseEvidence],
      outputEvidenceRefs: [baselineOutput],
      traceEvidenceRefs: [baselineTrace],
      variant: variant(definition, "trial"),
      status: "completed",
    });
    const output = await recorder.appendEvidence({
      preflightId: "preflight-production",
      name: "trial-source-candidate",
      kind: "output",
      value: { content: "candidate" },
      provenanceRefs: [caseEvidence],
    });
    const trace = await recorder.appendEvidence({
      preflightId: "preflight-production",
      name: "trial-source-candidate-trace",
      kind: "tool_trace",
      value: { traceId: "trace" },
      provenanceRefs: [caseEvidence, output],
    });
    const trial: ExperimentTrial = {
      trialId: "trial-production",
      experimentId: "experiment-production",
      comparisonGroupId: "comparison-production",
      arm: "candidate",
      capabilityRevision: candidate,
      inputRefs: [caseEvidence],
      outputEvidenceRefs: [output],
      traceEvidenceRefs: [trace],
      variant: variant(definition, "trial"),
      status: "completed",
    };
    const trialRowRef = await recorder.recordTrial(trial);
    const judgment = await recorder.appendEvidence({
      preflightId: "preflight-production",
      name: "judgment-source",
      kind: "judgment",
      value: { winner: "candidate" },
      provenanceRefs: [output],
    });
    const reportEvidence = await recorder.appendEvidence({
      preflightId: "preflight-production",
      name: "report",
      kind: "report",
      value: { decision: "pass" },
      provenanceRefs: [judgment],
    });
    await recorder.recordReport(
      report({
        definition,
        caseEvidence,
        baselineOutput,
        baselineTrace,
        baselineTrialRowRef,
        output,
        trace,
        judgment,
        reportEvidence,
        trialRowRef,
      }),
    );

    expect(await workspace.research.preflights.getPreflightReport("preflight-production")).toMatchObject({
      planId: "plan-production",
      decision: "pass",
    });
    expect(
      await workspace.research.evaluations.getEvaluation("evaluation:preflight-production"),
    ).toMatchObject({
      preflightId: "preflight-production",
      candidateRevision: candidate,
      status: "completed",
    });
    workspace.close();
  });
});

const baseline: CapabilityRevisionRef = {
  kind: "capability_revision",
  capabilityId: "capability",
  capabilityRevisionId: "baseline",
  bundleDigest: sha256("baseline"),
};
const candidate: CapabilityRevisionRef = {
  kind: "capability_revision",
  capabilityId: "capability",
  capabilityRevisionId: "candidate",
  bundleDigest: sha256("candidate"),
};

function variant(definition: FileRevisionRef, name: string) {
  return { variantId: `${name}-v1`, axis: "role" as const, configurationRefs: [definition] };
}

function report(input: {
  readonly definition: FileRevisionRef;
  readonly caseEvidence: EvidenceRevisionRef<"input">;
  readonly baselineOutput: EvidenceRevisionRef<"output">;
  readonly baselineTrace: EvidenceRevisionRef<"tool_trace">;
  readonly baselineTrialRowRef: DatabaseRowRef<"experiment_trials">;
  readonly output: EvidenceRevisionRef<"output">;
  readonly trace: EvidenceRevisionRef<"tool_trace">;
  readonly judgment: EvidenceRevisionRef<"judgment">;
  readonly reportEvidence: EvidenceRevisionRef<"report">;
  readonly trialRowRef: DatabaseRowRef<"experiment_trials">;
}): DynamicPreflightReport {
  const roleTrace: EvaluationRoleTrace = {
    traceId: "trace-production",
    role: "trial",
    variant: variant(input.definition, "trial"),
    startedAt: "2026-07-22T10:00:00.000Z",
    completedAt: "2026-07-22T10:00:01.000Z",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCost: 0 },
    evidenceRefs: [],
    artifactRefs: [],
    telemetry: {
      provider: "fake",
      model: "fake",
      reasoning: "off",
      attempts: 1,
      repairAttempts: 0,
      status: "completed",
    },
  };
  const config = {
    schemaVersion: 1 as const,
    generator: {
      promptRevision: input.definition,
      variant: variant(input.definition, "generator"),
      provider: "fake",
      model: "fake",
      reasoning: "off" as const,
      strategyId: "criterion-transfer-v1",
    },
    trial: {
      promptRevision: input.definition,
      variant: variant(input.definition, "trial"),
      provider: "fake",
      model: "fake",
      reasoning: "off" as const,
    },
    judge: {
      promptRevision: input.definition,
      variant: variant(input.definition, "judge"),
      provider: "fake",
      model: "fake",
      reasoning: "off" as const,
      strategyId: "evidence-critic-v1",
    },
    aggregation: { strategyId: "majority-with-confidence-v1", minimumCandidateWins: 1, minimumConfidence: 0 },
    rails: { sourceRegressionTolerance: 0, approvalOnPermissionDelta: true },
  };
  return {
    schemaVersion: 1,
    preflightId: "preflight-production",
    experimentId: "experiment-production",
    planId: "plan-production",
    baselineRevision: baseline,
    candidateRevision: candidate,
    canonicalCandidateDigest: candidate.bundleDigest,
    suiteDigest: sha256("suite"),
    criterionSnapshot: {
      snapshotId: "criteria-production",
      scope: "research",
      candidateRevision: candidate,
      criteria: [
        {
          criterionId: "criterion",
          revision: 1,
          scope: "research",
          evaluatorInstruction: "Preserve citations",
          evidenceRefs: [input.definition],
          definitionRevision: input.definition,
        },
      ],
      sourceSnapshotDigest: sha256("criteria-source"),
      snapshotDigest: sha256("criteria"),
    },
    cases: [
      {
        caseId: "source",
        kind: "source",
        owner: "candidate_author",
        instruction: "Cite",
        input: "Research",
        evidenceRefs: [input.definition],
        definitionRevision: input.definition,
        criterionRefs: [{ criterionId: "criterion", revision: 1 }],
      },
    ],
    caseEvidence: [input.caseEvidence],
    trials: [
      {
        trialId: "trial-production-baseline",
        comparisonGroupId: "comparison-production",
        caseId: "source",
        arm: "baseline",
        capabilityRevision: baseline,
        inputDigest: sha256("input"),
        artifact: {
          content: "baseline",
          valid: true,
          invalidArtifacts: [],
          unexpectedEffects: [],
          sourceAssertions: [{ assertionId: "source", passed: true, evidence: "baseline" }],
          identity: {
            capabilityId: baseline.capabilityId,
            capabilityRevisionId: baseline.capabilityRevisionId,
            bundleDigest: baseline.bundleDigest,
          },
        },
        outputEvidence: input.baselineOutput,
        traceEvidence: input.baselineTrace,
        trialRowRef: input.baselineTrialRowRef,
        roleTrace,
      },
      {
        trialId: "trial-production",
        comparisonGroupId: "comparison-production",
        caseId: "source",
        arm: "candidate",
        capabilityRevision: candidate,
        inputDigest: sha256("input"),
        artifact: {
          content: "candidate",
          valid: true,
          invalidArtifacts: [],
          unexpectedEffects: [],
          sourceAssertions: [{ assertionId: "source", passed: true, evidence: "cited" }],
          identity: {
            capabilityId: candidate.capabilityId,
            capabilityRevisionId: candidate.capabilityRevisionId,
            bundleDigest: candidate.bundleDigest,
          },
        },
        outputEvidence: input.output,
        traceEvidence: input.trace,
        trialRowRef: input.trialRowRef,
        roleTrace,
      },
    ],
    comparisons: [
      {
        caseId: "source",
        blindLabels: { A: "baseline", B: "candidate" },
        judgment: {
          winner: "B",
          confidence: 1,
          reasons: ["candidate wins"],
          violations: [],
          appliedCriteria: [{ criterionId: "criterion", revision: 1 }],
        },
        winner: "candidate",
        judgmentEvidence: input.judgment,
      },
    ],
    aggregation: {
      winner: "candidate",
      confidence: 1,
      summary: "candidate wins",
      candidateWins: 1,
      baselineWins: 0,
      ties: 0,
    },
    railChecks: [{ rail: "capability_identity", passed: true, evidenceRefs: [input.output], details: [] }],
    config,
    roleTelemetry: [roleTrace],
    decision: "pass",
    reportEvidence: input.reportEvidence,
  };
}
