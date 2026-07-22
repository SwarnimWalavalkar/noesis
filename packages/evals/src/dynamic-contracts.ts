import type { AgentRunRequest, AgentTrace } from "@noesis/agent-types";
import type { CriterionRelevanceSnapshot } from "@noesis/config";
import {
  type CapabilityRevision,
  type CapabilityRevisionRef,
  CapabilityRevisionRefSchema,
  CapabilityRevisionSchema,
  type DatabaseRowRef,
  type EvidenceKind,
  type EvidenceRef,
  EvidenceRefSchema,
  type EvidenceRevisionRef,
  type ExperimentTrial,
  type ExperimentVariantRef,
  type FileRevisionRef,
  FileRevisionRefSchema,
  type PreflightDecision,
  type Result,
} from "@noesis/domain";
import { z } from "zod";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export interface EvaluationCriterionSnapshot {
  readonly criterionId: string;
  readonly revision: number;
  readonly scope: string;
  readonly evaluatorInstruction: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly definitionRevision: FileRevisionRef;
}

export const EvaluationCriterionSnapshotSchema = z.strictObject({
  criterionId: z.string().min(1),
  revision: z.number().int().positive(),
  scope: z.string().min(1),
  evaluatorInstruction: z.string().min(1),
  evidenceRefs: z.array(EvidenceRefSchema).min(1),
  definitionRevision: FileRevisionRefSchema,
}) satisfies z.ZodType<EvaluationCriterionSnapshot>;

export interface EvaluationCriterionSet {
  readonly snapshotId: string;
  readonly scope: string;
  readonly candidateRevision: CapabilityRevisionRef;
  readonly criteria: readonly EvaluationCriterionSnapshot[];
  readonly sourceSnapshotDigest: string;
  readonly snapshotDigest: string;
}

export const EvaluationCriterionSetSchema = z.strictObject({
  snapshotId: z.string().min(1),
  scope: z.string().min(1),
  candidateRevision: CapabilityRevisionRefSchema,
  criteria: z.array(EvaluationCriterionSnapshotSchema),
  sourceSnapshotDigest: DigestSchema,
  snapshotDigest: DigestSchema,
}) satisfies z.ZodType<EvaluationCriterionSet>;

export type CriterionSelectionResult = Result<
  EvaluationCriterionSet,
  {
    readonly code: "criterion_selection_failed" | "incomplete_criterion_provenance";
    readonly message: string;
    readonly criterionId?: string;
  }
>;

export interface CriterionSnapshotPort {
  readonly snapshotRelevant: (input: {
    readonly snapshotId: string;
    readonly scope: string;
    readonly candidateRevision: CapabilityRevisionRef;
    readonly selectedCriterionIds?: readonly string[];
  }) => Promise<Result<CriterionRelevanceSnapshot, { readonly code: string; readonly message: string }>>;
}

export interface EvaluationCase {
  readonly caseId: string;
  readonly kind: "source" | "generated_transfer" | "generated_negative" | "protected";
  readonly owner: "candidate_author" | "evaluator";
  readonly instruction: string;
  readonly input: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly definitionRevision?: FileRevisionRef | undefined;
  readonly criterionRefs: readonly {
    readonly criterionId: string;
    readonly revision: number;
  }[];
}

export const EvaluationCaseSchema = z.strictObject({
  caseId: z.string().min(1),
  kind: z.enum(["source", "generated_transfer", "generated_negative", "protected"]),
  owner: z.enum(["candidate_author", "evaluator"]),
  instruction: z.string().min(1),
  input: z.string().min(1),
  evidenceRefs: z.array(EvidenceRefSchema).min(1),
  definitionRevision: FileRevisionRefSchema.optional(),
  criterionRefs: z.array(
    z.strictObject({
      criterionId: z.string().min(1),
      revision: z.number().int().positive(),
    }),
  ),
}) satisfies z.ZodType<EvaluationCase>;

export interface GeneratedCaseOutput {
  readonly cases: readonly {
    readonly caseId: string;
    readonly kind: "generated_transfer" | "generated_negative";
    readonly instruction: string;
    readonly input: string;
    readonly sourceEvidenceRefs: readonly EvidenceRef[];
    readonly criterionRefs: readonly {
      readonly criterionId: string;
      readonly revision: number;
    }[];
  }[];
}

export const GeneratedCaseOutputSchema = z.strictObject({
  cases: z
    .array(
      z.strictObject({
        caseId: z.string().min(1),
        kind: z.enum(["generated_transfer", "generated_negative"]),
        instruction: z.string().min(1),
        input: z.string().min(1),
        sourceEvidenceRefs: z.array(EvidenceRefSchema).min(1),
        criterionRefs: z.array(
          z.strictObject({
            criterionId: z.string().min(1),
            revision: z.number().int().positive(),
          }),
        ),
      }),
    )
    .min(1),
}) satisfies z.ZodType<GeneratedCaseOutput>;

export const SourceAssertionSchema = z.strictObject({
  assertionId: z.string().min(1),
  passed: z.boolean(),
  evidence: z.string().min(1),
});

export interface TrialArtifact {
  readonly content: string;
  readonly valid: boolean;
  readonly invalidArtifacts: readonly string[];
  readonly unexpectedEffects: readonly string[];
  readonly sourceAssertions: readonly {
    readonly assertionId: string;
    readonly passed: boolean;
    readonly evidence: string;
  }[];
  readonly identity: {
    readonly capabilityId: string;
    readonly capabilityRevisionId: string;
    readonly bundleDigest: string;
  };
}

export const TrialArtifactSchema = z.strictObject({
  content: z.string(),
  valid: z.boolean(),
  invalidArtifacts: z.array(z.string().min(1)),
  unexpectedEffects: z.array(z.string().min(1)),
  sourceAssertions: z.array(SourceAssertionSchema),
  identity: z.strictObject({
    capabilityId: z.string().min(1),
    capabilityRevisionId: z.string().min(1),
    bundleDigest: DigestSchema,
  }),
}) satisfies z.ZodType<TrialArtifact>;

export interface BlindJudgment {
  readonly winner: "A" | "B" | "tie" | "inconclusive";
  readonly confidence: number;
  readonly reasons: readonly string[];
  readonly violations: readonly string[];
  readonly appliedCriteria: readonly {
    readonly criterionId: string;
    readonly revision: number;
  }[];
}

export const BlindJudgmentSchema = z.strictObject({
  winner: z.enum(["A", "B", "tie", "inconclusive"]),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string().min(1)).min(1),
  violations: z.array(z.string().min(1)),
  appliedCriteria: z.array(
    z.strictObject({
      criterionId: z.string().min(1),
      revision: z.number().int().positive(),
    }),
  ),
}) satisfies z.ZodType<BlindJudgment>;

export interface RoleInvocationConfiguration {
  readonly promptRevision: FileRevisionRef;
  readonly variant: ExperimentVariantRef & { readonly axis: "role" };
  readonly provider: string;
  readonly model: string;
  readonly reasoning: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export const RoleInvocationConfigurationSchema = z.strictObject({
  promptRevision: FileRevisionRefSchema,
  variant: z.strictObject({
    variantId: z.string().min(1),
    axis: z.literal("role"),
    configurationRefs: z.array(FileRevisionRefSchema).min(1),
  }),
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoning: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
}) satisfies z.ZodType<RoleInvocationConfiguration>;

export interface DynamicEvaluationConfig {
  readonly schemaVersion: 1;
  readonly generator: RoleInvocationConfiguration & { readonly strategyId: string };
  readonly trial: RoleInvocationConfiguration;
  readonly judge: RoleInvocationConfiguration & { readonly strategyId: string };
  readonly aggregation: {
    readonly strategyId: string;
    readonly minimumCandidateWins: number;
    readonly minimumConfidence: number;
  };
  readonly rails: {
    readonly sourceRegressionTolerance: number;
    readonly approvalOnPermissionDelta: boolean;
  };
}

export const DynamicEvaluationConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  generator: RoleInvocationConfigurationSchema.extend({
    strategyId: z.string().min(1),
  }),
  trial: RoleInvocationConfigurationSchema,
  judge: RoleInvocationConfigurationSchema.extend({
    strategyId: z.string().min(1),
  }),
  aggregation: z.strictObject({
    strategyId: z.string().min(1),
    minimumCandidateWins: z.number().int().positive(),
    minimumConfidence: z.number().min(0).max(1),
  }),
  rails: z.strictObject({
    sourceRegressionTolerance: z.number().int().nonnegative(),
    approvalOnPermissionDelta: z.boolean(),
  }),
}) satisfies z.ZodType<DynamicEvaluationConfig>;

export interface DynamicPreflightInput {
  readonly preflightId: string;
  readonly experimentId: string;
  readonly planId: string;
  readonly scope: string;
  readonly behaviorObjective: string;
  readonly baseline: {
    readonly ref: CapabilityRevisionRef;
    readonly revision: CapabilityRevision;
  };
  readonly candidate: {
    readonly ref: CapabilityRevisionRef;
    readonly revision: CapabilityRevision;
  };
  readonly criteria: EvaluationCriterionSet;
  readonly sourceCases: readonly EvaluationCase[];
  readonly protectedCases: readonly EvaluationCase[];
  readonly budget: {
    readonly maxCases: number;
    readonly maxAttemptsPerArm: number;
    readonly maxCost: number;
  };
  readonly config: DynamicEvaluationConfig;
  readonly signal?: AbortSignal;
}

export interface EvaluationRoleRunRequest extends AgentRunRequest {
  readonly capabilityRevisions: readonly CapabilityRevisionRef[];
  readonly signal?: AbortSignal;
}

export interface EvaluationRoleTrace extends AgentTrace {
  readonly telemetry: {
    readonly provider: string;
    readonly model: string;
    readonly reasoning: string;
    readonly attempts: number;
    readonly repairAttempts: number;
    readonly status: "completed" | "aborted" | "failed";
    readonly failure?: {
      readonly code: string;
      readonly message: string;
    };
  };
}

export interface EvaluationStructuredRoleRunner {
  readonly run: <T>(
    request: EvaluationRoleRunRequest,
    outputSchema: z.ZodType<T>,
  ) => Promise<{
    readonly value: T;
    readonly trace: EvaluationRoleTrace;
    readonly capabilityRevisions: readonly CapabilityRevisionRef[];
  }>;
}

export interface EvaluationEvidenceRecorder {
  readonly appendEvidence: <Kind extends EvidenceKind>(input: {
    readonly preflightId: string;
    readonly name: string;
    readonly kind: Kind;
    readonly value: unknown;
    readonly provenanceRefs: readonly EvidenceRef[];
  }) => Promise<EvidenceRevisionRef<Kind>>;
  readonly recordTrial: (trial: ExperimentTrial) => Promise<DatabaseRowRef<"experiment_trials">>;
  readonly recordReport: (report: DynamicPreflightReport) => Promise<DatabaseRowRef<"preflight_reports">>;
}

export interface TrialResult {
  readonly trialId: string;
  readonly comparisonGroupId: string;
  readonly caseId: string;
  readonly arm: "baseline" | "candidate";
  readonly capabilityRevision: CapabilityRevisionRef;
  readonly inputDigest: string;
  readonly artifact: TrialArtifact;
  readonly outputEvidence: EvidenceRevisionRef<"output">;
  readonly traceEvidence: EvidenceRevisionRef<"tool_trace">;
  readonly trialRowRef: DatabaseRowRef<"experiment_trials">;
  readonly roleTrace: EvaluationRoleTrace;
}

export interface CaseComparison {
  readonly caseId: string;
  readonly blindLabels: Readonly<Record<"A" | "B", "baseline" | "candidate">>;
  readonly judgment: BlindJudgment;
  readonly winner: "baseline" | "candidate" | "tie" | "inconclusive";
  readonly judgmentEvidence: EvidenceRevisionRef<"judgment">;
}

export interface AggregatedComparison {
  readonly winner: "baseline" | "candidate" | "tie" | "inconclusive";
  readonly confidence: number;
  readonly summary: string;
  readonly candidateWins: number;
  readonly baselineWins: number;
  readonly ties: number;
}

export interface EvaluationRailResult {
  readonly rail: "capability_identity" | "source_regression" | "artifact_validity" | "unexpected_effects";
  readonly passed: boolean;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly details: readonly string[];
}

export interface DynamicPreflightReport {
  readonly schemaVersion: 1;
  readonly preflightId: string;
  readonly experimentId: string;
  readonly planId: string;
  readonly baselineRevision: CapabilityRevisionRef;
  readonly candidateRevision: CapabilityRevisionRef;
  readonly canonicalCandidateDigest: string;
  readonly suiteDigest: string;
  readonly criterionSnapshot: EvaluationCriterionSet;
  readonly cases: readonly EvaluationCase[];
  readonly caseEvidence: readonly EvidenceRevisionRef<"input">[];
  readonly trials: readonly TrialResult[];
  readonly comparisons: readonly CaseComparison[];
  readonly aggregation: AggregatedComparison;
  readonly railChecks: readonly EvaluationRailResult[];
  readonly config: DynamicEvaluationConfig;
  readonly roleTelemetry: readonly EvaluationRoleTrace[];
  readonly decision: Exclude<PreflightDecision, "inconclusive">;
  readonly reportEvidence: EvidenceRevisionRef<"report">;
}

export type EvaluationFailureCode =
  | "cancelled"
  | "configuration"
  | "identity_mismatch"
  | "malformed_role_output"
  | "recording_failed"
  | "role_failed";

export interface EvaluationFailure {
  readonly code: EvaluationFailureCode;
  readonly message: string;
  readonly stage: "setup" | "case_generation" | "trial" | "judgment" | "recording";
  readonly role?: "case_generator" | "trial" | "judge_critic";
  readonly caseId?: string;
  readonly arm?: "baseline" | "candidate";
  readonly trace?: EvaluationRoleTrace;
}

export type DynamicPreflightResult = Result<DynamicPreflightReport, EvaluationFailure>;

export interface EvaluationGeneratorStrategy {
  readonly strategyId: string;
  readonly renderPrompt: (input: {
    readonly behaviorObjective: string;
    readonly sourceCases: readonly EvaluationCase[];
    readonly criteria: EvaluationCriterionSet;
    readonly maxGeneratedCases: number;
  }) => string;
}

export interface EvaluationJudgeStrategy {
  readonly strategyId: string;
  readonly renderRubric: (input: {
    readonly behaviorObjective: string;
    readonly evaluationCase: EvaluationCase;
    readonly criteria: EvaluationCriterionSet;
  }) => string;
}

export interface EvaluationAggregationStrategy {
  readonly strategyId: string;
  readonly aggregate: (
    comparisons: readonly CaseComparison[],
    config: DynamicEvaluationConfig["aggregation"],
  ) => AggregatedComparison;
}

export interface DynamicEvaluationLaboratoryOptions {
  readonly structuredRoles: EvaluationStructuredRoleRunner;
  readonly recorder: EvaluationEvidenceRecorder;
  readonly generatorStrategies?: readonly EvaluationGeneratorStrategy[];
  readonly judgeStrategies?: readonly EvaluationJudgeStrategy[];
  readonly aggregationStrategies?: readonly EvaluationAggregationStrategy[];
  readonly createRunId?: (prefix: string) => string;
}

export interface DynamicEvaluationLaboratory {
  readonly runPreflight: (input: DynamicPreflightInput) => Promise<DynamicPreflightResult>;
}

export const DynamicPreflightInputBoundarySchema = z.strictObject({
  preflightId: z.string().min(1),
  experimentId: z.string().min(1),
  planId: z.string().min(1),
  scope: z.string().min(1),
  behaviorObjective: z.string().min(1),
  baseline: z.strictObject({ ref: CapabilityRevisionRefSchema, revision: CapabilityRevisionSchema }),
  candidate: z.strictObject({ ref: CapabilityRevisionRefSchema, revision: CapabilityRevisionSchema }),
  criteria: EvaluationCriterionSetSchema,
  sourceCases: z.array(EvaluationCaseSchema).min(1),
  protectedCases: z.array(EvaluationCaseSchema),
  budget: z.strictObject({
    maxCases: z.number().int().positive(),
    maxAttemptsPerArm: z.number().int().positive(),
    maxCost: z.number().nonnegative(),
  }),
  config: DynamicEvaluationConfigSchema,
  signal: z.instanceof(AbortSignal).optional(),
});

export function configurationEvidenceRefs(
  configuration: RoleInvocationConfiguration,
): readonly FileRevisionRef[] {
  const byRevision = new Map<string, FileRevisionRef>();
  byRevision.set(configuration.promptRevision.revisionId, configuration.promptRevision);
  for (const reference of configuration.variant.configurationRefs)
    byRevision.set(reference.revisionId, reference);
  return Object.freeze([...byRevision.values()]);
}

export function allReportEvidenceRefs(
  report: Omit<DynamicPreflightReport, "reportEvidence">,
): readonly EvidenceRef[] {
  return Object.freeze([
    ...report.criterionSnapshot.criteria.flatMap((criterion) => [
      criterion.definitionRevision,
      ...criterion.evidenceRefs,
    ]),
    ...report.cases.flatMap((evaluationCase) => [
      ...(evaluationCase.definitionRevision ? [evaluationCase.definitionRevision] : []),
      ...evaluationCase.evidenceRefs,
    ]),
    ...report.caseEvidence,
    ...report.trials.flatMap((trial) => [trial.outputEvidence, trial.traceEvidence, trial.trialRowRef]),
    ...report.comparisons.map((comparison) => comparison.judgmentEvidence),
    ...configurationEvidenceRefs(report.config.generator),
    ...configurationEvidenceRefs(report.config.trial),
    ...configurationEvidenceRefs(report.config.judge),
  ]);
}
