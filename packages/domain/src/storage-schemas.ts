import { z } from "zod";
import type {
  Capability,
  CompoundingReplayRecord,
  EvaluationRecord,
  ExperimentTrial,
  PreflightPlan,
  PreflightReport,
} from "./research.ts";
import { DATABASE_TABLES } from "./research.ts";

const ContentDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const StoredPathSchema = z.string().min(1);

export const DatabaseRowRefSchema = z.strictObject({
  kind: z.literal("database_row"),
  table: z.enum(DATABASE_TABLES),
  rowId: z.string().min(1),
});

export const databaseRowRefSchema = <Table extends (typeof DATABASE_TABLES)[number]>(table: Table) =>
  z.strictObject({
    kind: z.literal("database_row"),
    table: z.literal(table),
    rowId: z.string().min(1),
  });

export const FileRevisionRefSchema = z.strictObject({
  kind: z.literal("file_revision"),
  revisionId: z.string().min(1),
  workingPath: StoredPathSchema,
  snapshotPath: StoredPathSchema,
  contentDigest: ContentDigestSchema,
});

const EvidenceRevisionRefShape = {
  kind: z.literal("evidence_revision"),
  revisionId: z.string().min(1),
  workingPath: StoredPathSchema,
  snapshotPath: StoredPathSchema,
  contentDigest: ContentDigestSchema,
};

export const EvidenceRevisionRefSchema = z.strictObject({
  ...EvidenceRevisionRefShape,
  evidenceKind: z.enum(["input", "output", "tool_trace", "judgment", "report"]),
});

export const evidenceRevisionRefSchema = <
  Kind extends "input" | "output" | "tool_trace" | "judgment" | "report",
>(
  evidenceKind: Kind,
) =>
  z.strictObject({
    ...EvidenceRevisionRefShape,
    evidenceKind: z.literal(evidenceKind),
  });

const InputEvidenceRevisionRefSchema = evidenceRevisionRefSchema("input");
const OutputEvidenceRevisionRefSchema = evidenceRevisionRefSchema("output");
const ToolTraceEvidenceRevisionRefSchema = evidenceRevisionRefSchema("tool_trace");
const JudgmentEvidenceRevisionRefSchema = evidenceRevisionRefSchema("judgment");
const ReportEvidenceRevisionRefSchema = evidenceRevisionRefSchema("report");
const ExperimentTrialRowRefSchema = databaseRowRefSchema("experiment_trials");
const PreflightReportRowRefSchema = databaseRowRefSchema("preflight_reports");

export const ArtifactFileRefSchema = z.strictObject({
  kind: z.literal("artifact_file"),
  artifactId: z.string().min(1),
  path: StoredPathSchema,
  mediaType: z.string().min(1),
});

export const EvidenceRefSchema = z.discriminatedUnion("kind", [
  DatabaseRowRefSchema,
  FileRevisionRefSchema,
  EvidenceRevisionRefSchema,
  ArtifactFileRefSchema,
]);

export const CapabilityRevisionRefSchema = z.strictObject({
  kind: z.literal("capability_revision"),
  capabilityId: z.string().min(1),
  capabilityRevisionId: z.string().min(1),
  bundleDigest: ContentDigestSchema,
});

const CorrectionExposureSchema = z.strictObject({
  signature: z.string().min(1),
  related: z.boolean(),
  correctionOccurred: z.boolean(),
  phase: z.enum(["pre_activation", "post_activation"]),
  servedRevisions: z.array(CapabilityRevisionRefSchema),
});

const CompoundingReplayRecordBaseShape = {
  replayId: z.string().min(1),
  planId: z.string().min(1),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  occurredAt: z.string().min(1),
  scope: z.string().min(1),
  modelCohort: z.string().min(1),
  servedRevisions: z.array(CapabilityRevisionRefSchema),
  baselineRevisions: z.array(CapabilityRevisionRefSchema),
  scopeRelated: z.boolean(),
  correctionExposures: z.array(CorrectionExposureSchema),
};

export const CompoundingReplayRecordSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...CompoundingReplayRecordBaseShape,
    status: z.literal("excluded"),
    exclusionReason: z.enum([
      "unsettled_outcome",
      "aborted_turn",
      "unknown_legacy_baseline",
      "missing_provenance_classification",
      "secret_data",
      "private_data_unauthorized",
      "incomplete_tool_result",
      "identity_mismatch",
      "budget_exhausted",
      "unresolved_reservation",
      "role_failed",
      "unexpected_effect",
    ]),
    exclusionDetail: z.string().min(1),
  }),
  z.strictObject({
    ...CompoundingReplayRecordBaseShape,
    status: z.literal("paired"),
    winner: z.enum(["served", "baseline", "tie", "inconclusive"]),
    railsPassed: z.boolean(),
    servedOutputEvidence: OutputEvidenceRevisionRefSchema,
    baselineOutputEvidence: OutputEvidenceRevisionRefSchema,
    judgmentEvidence: JudgmentEvidenceRevisionRefSchema,
    servedInputTokens: z.number().int().nonnegative(),
    baselineInputTokens: z.number().int().nonnegative(),
    injectedContextTokens: z.number().int().nonnegative(),
    servedPromptLayerBytes: z.number().int().nonnegative(),
    baselinePromptLayerBytes: z.number().int().nonnegative(),
  }),
]) satisfies z.ZodType<CompoundingReplayRecord>;

const PermissionManifestSchema = z.strictObject({
  effects: z.array(z.string()),
  resourcePatterns: z.array(z.string()),
  credentialRefs: z.array(z.string()),
});

const PermissionDeltaSchema = z.strictObject({
  addedEffects: z.array(z.string()),
  widenedResources: z.array(z.string()),
  addedCredentialRefs: z.array(z.string()),
});

const ExperimentVariantRefSchema = z.strictObject({
  variantId: z.string().min(1),
  axis: z.enum(["role", "retrieval", "routing", "evaluation", "tool_runtime", "activation"]),
  configurationRefs: z.array(FileRevisionRefSchema),
});

export const FeedbackSignalSchema = z.strictObject({
  signalId: z.string().min(1),
  kind: z.enum([
    "explicit_correction",
    "preference_expression",
    "recurring_workflow",
    "repeated_failure",
    "surprising_success",
    "friction",
    "capability_gap",
    "cost_or_latency",
    "user_request",
  ]),
  scope: z.string().min(1),
  evidenceRefs: z.array(EvidenceRefSchema),
  strength: z.number().min(0).max(1),
  novelty: z.number().min(0).max(1),
  sensitivity: z.enum(["normal", "private", "secret"]),
  experimentId: z.string().min(1).optional(),
  capabilityRevisionId: z.string().min(1).optional(),
});

export const CapabilitySchema = z.strictObject({
  capabilityId: z.string().min(1),
  name: z.string().min(1),
  scope: z.string().min(1),
  intent: z.string().min(1),
}) satisfies z.ZodType<Capability>;

export const CapabilityRevisionSchema = z.strictObject({
  capabilityRevisionId: z.string().min(1),
  capabilityId: z.string().min(1),
  predecessorRevisionId: z.string().min(1).optional(),
  promptModules: z.array(FileRevisionRefSchema),
  skills: z.array(FileRevisionRefSchema),
  tools: z.array(FileRevisionRefSchema),
  toolset: z.strictObject({
    toolRevisionIds: z.array(z.string().min(1)),
    routerRevision: FileRevisionRefSchema,
    strategyId: z.string().min(1),
  }),
  activationPolicy: z.strictObject({
    mode: z.enum(["automatic_low_risk", "approval_required"]),
    scope: z.string().min(1),
  }),
  dependencyLock: FileRevisionRefSchema.optional(),
  permissionManifest: PermissionManifestSchema,
  evidenceRefs: z.array(EvidenceRefSchema),
  sourceEvaluationDefinitions: z.array(FileRevisionRefSchema),
  requestedPermissionDelta: PermissionDeltaSchema,
});

const ExperimentBaseShape = {
  experimentId: z.string().min(1),
  hypothesis: z.string().min(1),
  scope: z.string().min(1),
  evidenceRefs: z.array(EvidenceRefSchema),
  baselineRevision: CapabilityRevisionRefSchema,
  candidateRevisions: z.array(CapabilityRevisionRefSchema),
  preflightRef: PreflightReportRowRefSchema.optional(),
  activatedRevision: CapabilityRevisionRefSchema.optional(),
  feedbackSignalIds: z.array(z.string().min(1)),
  followUpExperimentId: z.string().min(1).optional(),
};

export const ExperimentSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...ExperimentBaseShape,
    status: z.enum(["hypothesis", "authoring", "preflight", "observing"]),
  }),
  z.strictObject({
    ...ExperimentBaseShape,
    status: z.literal("completed"),
    outcome: z.enum(["keep", "revise", "revert"]),
  }),
]);

export const ExperimentTrialSchema = z.strictObject({
  trialId: z.string().min(1),
  experimentId: z.string().min(1),
  comparisonGroupId: z.string().min(1),
  arm: z.enum(["baseline", "candidate"]),
  capabilityRevision: CapabilityRevisionRefSchema,
  inputRefs: z.array(EvidenceRefSchema).min(1),
  outputEvidenceRefs: z.array(OutputEvidenceRevisionRefSchema).min(1),
  traceEvidenceRefs: z.array(ToolTraceEvidenceRevisionRefSchema),
  variant: ExperimentVariantRefSchema,
  status: z.enum(["planned", "running", "completed", "failed"]),
}) satisfies z.ZodType<ExperimentTrial>;

export const PreflightPlanSchema = z.strictObject({
  planId: z.string().min(1),
  experimentId: z.string().min(1),
  candidateRevision: CapabilityRevisionRefSchema,
  baselineRevision: CapabilityRevisionRefSchema,
  caseRefs: z.array(InputEvidenceRevisionRefSchema).min(1),
  judgeVariant: ExperimentVariantRefSchema,
  runtimeVariant: ExperimentVariantRefSchema,
  budget: z.strictObject({
    maxCases: z.number().int().positive(),
    maxAttemptsPerArm: z.number().int().positive(),
    maxCost: z.number().nonnegative(),
  }),
}) satisfies z.ZodType<PreflightPlan>;

export const PreflightReportSchema = z.strictObject({
  preflightId: z.string().min(1),
  experimentId: z.string().min(1),
  planId: z.string().min(1),
  candidateRevision: CapabilityRevisionRefSchema,
  baselineRevision: CapabilityRevisionRefSchema,
  trialRowRefs: z.array(ExperimentTrialRowRefSchema).min(2),
  trialEvidence: z.array(OutputEvidenceRevisionRefSchema).min(2),
  judgmentEvidence: z.array(JudgmentEvidenceRevisionRefSchema).min(1),
  appliedCriteria: z.array(
    z.strictObject({
      criterionId: z.string().min(1),
      revision: z.number().int().positive(),
      evidenceRefs: z.array(EvidenceRefSchema),
    }),
  ),
  railChecks: z.array(
    z.strictObject({
      rail: z.string().min(1),
      passed: z.boolean(),
      evidenceRefs: z.array(EvidenceRefSchema),
    }),
  ),
  comparison: z.strictObject({
    winner: z.enum(["baseline", "candidate", "tie", "inconclusive"]),
    confidence: z.number().min(0).max(1),
    summary: z.string().min(1),
  }),
  decision: z.enum(["pass", "block", "inconclusive", "approval_required"]),
  reportEvidence: ReportEvidenceRevisionRefSchema,
}) satisfies z.ZodType<PreflightReport>;

export const EvaluationRecordSchema = z.strictObject({
  evaluationId: z.string().min(1),
  experimentId: z.string().min(1),
  preflightId: z.string().min(1),
  candidateRevision: CapabilityRevisionRefSchema,
  trialIds: z.array(z.string().min(1)).min(1),
  evidenceRefs: z.array(z.union([JudgmentEvidenceRevisionRefSchema, ReportEvidenceRevisionRefSchema])),
  status: z.enum(["running", "completed", "failed"]),
}) satisfies z.ZodType<EvaluationRecord>;
