import type {
  ActorRef,
  EvaluationRecord,
  EvidenceKind,
  EvidenceRef,
  PreflightReport,
  WorkspaceStore,
} from "@noesis/domain";
import type { DynamicPreflightReport, EvaluationEvidenceRecorder } from "./dynamic-contracts.ts";

const encoder = new TextEncoder();

function safeName(value: string): string {
  const safe = value.replaceAll(/[^A-Za-z0-9._-]/g, "-");
  if (!safe) throw new Error("Evaluation evidence name is empty after path sanitization");
  return safe;
}

export function toWorkspacePreflightReport(report: DynamicPreflightReport): PreflightReport {
  return Object.freeze({
    preflightId: report.preflightId,
    experimentId: report.experimentId,
    planId: report.planId,
    candidateRevision: report.candidateRevision,
    baselineRevision: report.baselineRevision,
    trialRowRefs: Object.freeze(report.trials.map((trial) => trial.trialRowRef)),
    trialEvidence: Object.freeze(report.trials.map((trial) => trial.outputEvidence)),
    judgmentEvidence: Object.freeze(report.comparisons.map((comparison) => comparison.judgmentEvidence)),
    appliedCriteria: Object.freeze(
      report.criterionSnapshot.criteria.map((criterion) =>
        Object.freeze({
          criterionId: criterion.criterionId,
          revision: criterion.revision,
          evidenceRefs: Object.freeze([criterion.definitionRevision, ...criterion.evidenceRefs]),
        }),
      ),
    ),
    railChecks: Object.freeze(
      report.railChecks.map((rail) =>
        Object.freeze({
          rail: rail.rail,
          passed: rail.passed,
          evidenceRefs: rail.evidenceRefs,
        }),
      ),
    ),
    comparison: Object.freeze({
      winner: report.aggregation.winner,
      confidence: report.aggregation.confidence,
      summary: report.aggregation.summary,
    }),
    decision: report.decision,
    reportEvidence: report.reportEvidence,
  });
}

export function createWorkspaceEvaluationRecorder(
  workspace: Pick<WorkspaceStore, "evidence" | "research">,
  actor: ActorRef = Object.freeze({ actorId: "dynamic-evaluator", kind: "system" }),
): EvaluationEvidenceRecorder {
  const appendEvidence = async <Kind extends EvidenceKind>(input: {
    readonly preflightId: string;
    readonly name: string;
    readonly kind: Kind;
    readonly value: unknown;
    readonly provenanceRefs: readonly EvidenceRef[];
  }) =>
    await workspace.evidence.appendEvidence({
      workingPath: `evaluations/${safeName(input.preflightId)}/${safeName(input.name)}.json`,
      bytes: encoder.encode(`${JSON.stringify(input.value, null, 2)}\n`),
      actor,
      reason: `AC-06 ${input.kind} evidence`,
      sensitivity: "private",
      provenanceRefs: input.provenanceRefs,
      evidenceKind: input.kind,
    });

  const recordTrial: EvaluationEvidenceRecorder["recordTrial"] = async (trial) =>
    await workspace.research.trials.putTrial(trial);

  const recordReport: EvaluationEvidenceRecorder["recordReport"] = async (report) => {
    const row = await workspace.research.preflights.putPreflightReport(toWorkspacePreflightReport(report));
    const evaluation: EvaluationRecord = Object.freeze({
      evaluationId: `evaluation:${report.preflightId}`,
      experimentId: report.experimentId,
      preflightId: report.preflightId,
      candidateRevision: report.candidateRevision,
      trialIds: Object.freeze(report.trials.map((trial) => trial.trialId)),
      evidenceRefs: Object.freeze([
        ...report.comparisons.map((comparison) => comparison.judgmentEvidence),
        report.reportEvidence,
      ]),
      status: "completed",
    });
    await workspace.research.evaluations.putEvaluation(evaluation);
    return row;
  };

  return Object.freeze({ appendEvidence, recordTrial, recordReport });
}
