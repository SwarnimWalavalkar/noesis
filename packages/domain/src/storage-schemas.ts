import { z } from "zod";
import type {
  Capability,
  CompoundingReplayRecord,
  EvaluationRecord,
  ExperimentTrial,
  ProjectRef,
  PreflightPlan,
  PreflightReport,
  WorkingAdjustment,
} from "./research.ts";
import { DATABASE_TABLES, WORKING_ADJUSTMENT_LIMITS } from "./research.ts";

const ContentDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const StoredPathSchema = z.string().min(1);
const WindowsDrivePathPattern = /^[a-z]:/iu;
const WorkspaceContainedStoredPathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.startsWith("\\") &&
      !WindowsDrivePathPattern.test(value) &&
      !value.includes("\0") &&
      !value.split(/[\\/]/u).includes(".."),
    "Stored paths must be relative and remain within the workspace",
  );

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

const EvidenceRevisionRefFields = {
  kind: z.literal("evidence_revision"),
  revisionId: z.string().min(1),
  workingPath: StoredPathSchema,
  snapshotPath: StoredPathSchema,
  contentDigest: ContentDigestSchema,
};

export const EvidenceRevisionRefSchema = z.strictObject({
  ...EvidenceRevisionRefFields,
  evidenceKind: z.enum(["input", "output", "tool_trace", "judgment", "report"]),
});

export const evidenceRevisionRefSchema = <
  Kind extends "input" | "output" | "tool_trace" | "judgment" | "report",
>(
  evidenceKind: Kind,
) =>
  z.strictObject({
    ...EvidenceRevisionRefFields,
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
  path: WorkspaceContainedStoredPathSchema,
  mediaType: z.string().min(1),
});

export const EvidenceRefSchema = z.discriminatedUnion("kind", [
  DatabaseRowRefSchema,
  FileRevisionRefSchema,
  EvidenceRevisionRefSchema,
  ArtifactFileRefSchema,
]);

export const ProjectRefSchema = z.strictObject({
  projectId: z.string().min(1),
  root: z.string().min(1),
}) satisfies z.ZodType<ProjectRef>;

export const WorkingAdjustmentSchema = z.strictObject({
  adjustmentId: z.string().min(1),
  scope: ProjectRefSchema,
  observation: z.string().min(1).max(WORKING_ADJUSTMENT_LIMITS.observationChars),
  strategy: z.string().min(1).max(WORKING_ADJUSTMENT_LIMITS.strategyChars),
  successSignal: z.string().min(1).max(WORKING_ADJUSTMENT_LIMITS.successSignalChars),
  evidenceRefs: z.array(EvidenceRefSchema).min(1).max(WORKING_ADJUSTMENT_LIMITS.evidenceRefs),
  createdFromTurnId: z.string().min(1),
}) satisfies z.ZodType<WorkingAdjustment>;

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

const CompoundingReplayRecordBaseFields = {
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
    ...CompoundingReplayRecordBaseFields,
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
    ...CompoundingReplayRecordBaseFields,
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
    "turn_observation",
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

const CapabilityProgramNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);

export const CapabilityEffectSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("instruction"),
    material: FileRevisionRefSchema,
  }),
  z.strictObject({
    kind: z.literal("skill"),
    name: CapabilityProgramNameSchema,
    description: z.string().min(1).max(2_048),
    material: FileRevisionRefSchema,
  }),
  z.strictObject({
    kind: z.literal("program"),
    program: z.strictObject({
      mode: z.enum(["script", "workflow"]),
      name: CapabilityProgramNameSchema,
      project: ProjectRefSchema,
      definitionRevision: FileRevisionRefSchema,
    }),
  }),
]);

export const CapabilityRevisionSchema = z.strictObject({
  capabilityRevisionId: z.string().min(1),
  capabilityId: z.string().min(1),
  predecessorRevisionId: z.string().min(1).optional(),
  effects: z.array(CapabilityEffectSchema).min(1).max(32).optional(),
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

export const CapabilityKindSchema = z.enum([
  "instruction",
  "skill",
  "tool",
  "workflow",
  "router",
  "model_configuration",
  "harness_configuration",
  "core_update",
  "composite",
]);

export const CapabilityDefinitionSchema = z.strictObject({
  capabilityId: z.string().min(1),
  name: z.string().min(1),
  kind: CapabilityKindSchema.optional(),
  description: z.string().min(1),
  applicability: z.string().min(1),
  createdAt: z.string().datetime(),
});

export const CapabilityLifecycleRevisionSchema = z.strictObject({
  revision: CapabilityRevisionSchema,
  reference: CapabilityRevisionRefSchema,
  summary: z.string().min(1),
  rationale: z.string().min(1),
  anticipatedEffect: z.string().min(1),
  createdAt: z.string().datetime(),
});

export const CapabilityScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("global") }),
  z.strictObject({ kind: z.literal("project"), project: ProjectRefSchema }),
  z.strictObject({ kind: z.literal("session"), sessionId: z.string().min(1) }),
]);

export const CapabilityBindingSchema = z.strictObject({
  capabilityId: z.string().min(1),
  revision: CapabilityRevisionRefSchema,
  scope: CapabilityScopeSchema,
  activationMode: z.enum(["relevant", "always"]),
  state: z.enum(["active", "paused"]),
  revisionNumber: z.number().int().positive(),
  updatedAt: z.string().datetime(),
});

export const CapabilityFeedbackSchema = z
  .strictObject({
    feedbackId: z.string().min(1),
    capabilityId: z.string().min(1),
    revision: CapabilityRevisionRefSchema,
    evidenceRefs: z.array(EvidenceRefSchema).min(1).max(64),
    interpretation: z.string().min(1).max(8_192),
    disposition: z.enum([
      "positive",
      "correction",
      "regression",
      "scope_change",
      "activation_change",
      "restore_request",
    ]),
    createdAt: z.string().datetime(),
  })
  .refine((feedback) => feedback.capabilityId === feedback.revision.capabilityId, {
    message: "Capability feedback and revision identities must match",
    path: ["revision", "capabilityId"],
  });

export const CapabilityGateRequestSchema = z
  .strictObject({
    gateRequestId: z.string().min(1),
    capabilityId: z.string().min(1),
    revision: CapabilityRevisionRefSchema,
    expectedBindingRevision: z.number().int().positive(),
    proposedScope: CapabilityScopeSchema,
    proposedActivationMode: z.enum(["relevant", "always"]),
    consequence: z.string().min(1).max(8_192),
    status: z.enum(["pending", "approved", "denied", "superseded"]),
    instruction: z.string().min(1).max(8_192).optional(),
    createdAt: z.string().datetime(),
    settledAt: z.string().datetime().optional(),
  })
  .refine((gate) => gate.capabilityId === gate.revision.capabilityId, {
    message: "Capability gate and revision identities must match",
    path: ["revision", "capabilityId"],
  });

const ExperimentBaseFields = {
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
  sourceAdjustmentId: z.string().min(1).optional(),
};

export const ExperimentSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...ExperimentBaseFields,
    status: z.enum(["hypothesis", "authoring", "preflight", "observing"]),
  }),
  z.strictObject({
    ...ExperimentBaseFields,
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
