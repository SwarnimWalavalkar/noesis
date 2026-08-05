export const DATABASE_TABLES = [
  "sessions",
  "messages",
  "tool_calls",
  "outcomes",
  "jobs",
  "experiments",
  "experiment_trials",
  "feedback_signals",
  "experiment_observations",
  "experiment_research_runs",
  "experiment_outcomes",
  "successor_lineage_inputs",
  "preflight_plans",
  "preflight_reports",
  "evaluations",
  "activation_pointers",
  "search_configuration",
  "activity_log",
  "file_revisions",
] as const;

export type DatabaseTable = (typeof DATABASE_TABLES)[number];

export interface DatabaseRowRef<Table extends DatabaseTable = DatabaseTable> {
  readonly kind: "database_row";
  readonly table: Table;
  readonly rowId: string;
}

export interface FileRevisionRef {
  readonly kind: "file_revision";
  readonly revisionId: string;
  readonly workingPath: string;
  readonly snapshotPath: string;
  readonly contentDigest: string;
}

export type EvidenceKind = "input" | "output" | "tool_trace" | "judgment" | "report";

export interface EvidenceRevisionRef<Kind extends EvidenceKind = EvidenceKind> {
  readonly kind: "evidence_revision";
  readonly revisionId: string;
  readonly workingPath: string;
  readonly snapshotPath: string;
  readonly contentDigest: string;
  readonly evidenceKind: Kind;
}

export interface ArtifactFileRef {
  readonly kind: "artifact_file";
  readonly artifactId: string;
  readonly path: string;
  readonly mediaType: string;
}

export type EvidenceRef = DatabaseRowRef | FileRevisionRef | EvidenceRevisionRef | ArtifactFileRef;

export type ActorKind = "user" | "noesis" | "external_system" | "system";

export interface ActorRef {
  readonly actorId: string;
  readonly kind: ActorKind;
}

export interface FileRevision {
  readonly revisionId: string;
  readonly workingPath: string;
  readonly snapshotPath: string;
  readonly contentDigest: string;
  readonly predecessorRevisionId?: string;
  readonly actor: ActorRef;
  readonly reason?: string;
  readonly recordedAt: string;
}

export interface EvidenceRevision extends FileRevision {
  readonly evidenceKind: EvidenceKind;
  readonly supersedesRevisionId?: string;
}

export type LearningSignalKind =
  | "turn_observation"
  | "explicit_correction"
  | "preference_expression"
  | "recurring_workflow"
  | "repeated_failure"
  | "surprising_success"
  | "friction"
  | "capability_gap"
  | "cost_or_latency"
  | "user_request";

export interface FeedbackSignal {
  readonly signalId: string;
  readonly kind: LearningSignalKind;
  readonly scope: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly strength: number;
  readonly novelty: number;
  readonly sensitivity: "normal" | "private" | "secret";
  readonly experimentId?: string;
  readonly capabilityRevisionId?: string;
}

export interface PermissionManifest {
  readonly effects: readonly string[];
  readonly resourcePatterns: readonly string[];
  readonly credentialRefs: readonly string[];
}

export interface PermissionDelta {
  readonly addedEffects: readonly string[];
  readonly widenedResources: readonly string[];
  readonly addedCredentialRefs: readonly string[];
}

export interface ToolsetAndRouter {
  readonly toolRevisionIds: readonly string[];
  readonly routerRevision: FileRevisionRef;
  readonly strategyId: string;
}

export interface ActivationPolicy {
  readonly mode: "automatic_low_risk" | "approval_required";
  readonly scope: string;
}

export interface Capability {
  readonly capabilityId: string;
  readonly name: string;
  readonly scope: string;
  readonly intent: string;
}

export interface CapabilityRevision {
  readonly capabilityRevisionId: string;
  readonly capabilityId: string;
  readonly predecessorRevisionId?: string;
  readonly promptModules: readonly FileRevisionRef[];
  readonly skills: readonly FileRevisionRef[];
  readonly tools: readonly FileRevisionRef[];
  readonly toolset: ToolsetAndRouter;
  readonly activationPolicy: ActivationPolicy;
  readonly dependencyLock?: FileRevisionRef;
  readonly permissionManifest: PermissionManifest;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly sourceEvaluationDefinitions: readonly FileRevisionRef[];
  readonly requestedPermissionDelta: PermissionDelta;
}

/** Immutable identity for the complete coupled prompt, skill, tool, router, policy, and permission bundle. */
export interface CapabilityRevisionRef {
  readonly kind: "capability_revision";
  readonly capabilityId: string;
  readonly capabilityRevisionId: string;
  readonly bundleDigest: string;
}

/** Derived from the SQLite activation pointer; neither immutable definition owns current state. */
export interface CapabilityActivationReadModel {
  readonly capability: Capability;
  readonly activeRevision: CapabilityRevisionRef | null;
  readonly activationPointer: DatabaseRowRef<"activation_pointers"> | null;
}

export function sameCapabilityRevisionRef(
  left: CapabilityRevisionRef,
  right: CapabilityRevisionRef,
): boolean {
  return (
    left.capabilityId === right.capabilityId &&
    left.capabilityRevisionId === right.capabilityRevisionId &&
    left.bundleDigest === right.bundleDigest
  );
}

export type ExperimentOutcome = "keep" | "revise" | "revert";

export type ExperimentStatus = "hypothesis" | "authoring" | "preflight" | "observing" | "completed";

interface ExperimentBase {
  readonly experimentId: string;
  readonly hypothesis: string;
  readonly scope: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly baselineRevision: CapabilityRevisionRef;
  readonly candidateRevisions: readonly CapabilityRevisionRef[];
  readonly preflightRef?: DatabaseRowRef<"preflight_reports">;
  readonly activatedRevision?: CapabilityRevisionRef;
  readonly feedbackSignalIds: readonly string[];
  readonly followUpExperimentId?: string;
}

export interface OpenExperiment extends ExperimentBase {
  readonly status: Exclude<ExperimentStatus, "completed">;
  readonly outcome?: never;
}

export interface CompletedExperiment extends ExperimentBase {
  readonly status: "completed";
  readonly outcome: ExperimentOutcome;
}

export type Experiment = OpenExperiment | CompletedExperiment;

const EXPERIMENT_TRANSITIONS = {
  hypothesis: ["authoring"],
  authoring: ["preflight"],
  preflight: ["observing", "completed"],
  observing: ["completed"],
  completed: [],
} as const satisfies Readonly<Record<ExperimentStatus, readonly ExperimentStatus[]>>;

export function isExperimentTransitionAllowed(from: ExperimentStatus, to: ExperimentStatus): boolean {
  return EXPERIMENT_TRANSITIONS[from].some((candidate) => candidate === to);
}

export interface ExperimentVariantRef {
  readonly variantId: string;
  readonly axis: "role" | "retrieval" | "routing" | "evaluation" | "tool_runtime" | "activation";
  readonly configurationRefs: readonly FileRevisionRef[];
}

export interface EvaluationBudget {
  readonly maxCases: number;
  readonly maxAttemptsPerArm: number;
  readonly maxCost: number;
}

export interface PreflightPlan {
  readonly planId: string;
  readonly experimentId: string;
  readonly candidateRevision: CapabilityRevisionRef;
  readonly baselineRevision: CapabilityRevisionRef;
  readonly caseRefs: readonly EvidenceRevisionRef<"input">[];
  readonly judgeVariant: ExperimentVariantRef;
  readonly runtimeVariant: ExperimentVariantRef;
  readonly budget: EvaluationBudget;
}

export interface ExperimentTrial {
  readonly trialId: string;
  readonly experimentId: string;
  readonly comparisonGroupId: string;
  readonly arm: "baseline" | "candidate";
  readonly capabilityRevision: CapabilityRevisionRef;
  readonly inputRefs: readonly EvidenceRef[];
  readonly outputEvidenceRefs: readonly EvidenceRevisionRef<"output">[];
  readonly traceEvidenceRefs: readonly EvidenceRevisionRef<"tool_trace">[];
  readonly variant: ExperimentVariantRef;
  readonly status: "planned" | "running" | "completed" | "failed";
}

export interface AppliedCriterionRef {
  readonly criterionId: string;
  readonly revision: number;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface RailCheckResult {
  readonly rail: string;
  readonly passed: boolean;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface EvaluationComparison {
  readonly winner: "baseline" | "candidate" | "tie" | "inconclusive";
  readonly confidence: number;
  readonly summary: string;
}

export type PreflightDecision = "pass" | "block" | "inconclusive" | "approval_required";

export interface PreflightReport {
  readonly preflightId: string;
  readonly experimentId: string;
  readonly planId: string;
  readonly candidateRevision: CapabilityRevisionRef;
  readonly baselineRevision: CapabilityRevisionRef;
  readonly trialRowRefs: readonly DatabaseRowRef<"experiment_trials">[];
  readonly trialEvidence: readonly EvidenceRevisionRef<"output">[];
  readonly judgmentEvidence: readonly EvidenceRevisionRef<"judgment">[];
  readonly appliedCriteria: readonly AppliedCriterionRef[];
  readonly railChecks: readonly RailCheckResult[];
  readonly comparison: EvaluationComparison;
  readonly decision: PreflightDecision;
  readonly reportEvidence: EvidenceRevisionRef<"report">;
}

export interface EvaluationRecord {
  readonly evaluationId: string;
  readonly experimentId: string;
  readonly preflightId: string;
  readonly candidateRevision: CapabilityRevisionRef;
  readonly trialIds: readonly string[];
  readonly evidenceRefs: readonly (EvidenceRevisionRef<"judgment"> | EvidenceRevisionRef<"report">)[];
  readonly status: "running" | "completed" | "failed";
}

export type CompoundingReplayRole = "served_arm" | "baseline_arm" | "judge";

export type CompoundingReplayExclusionReason =
  | "unsettled_outcome"
  | "aborted_turn"
  | "unknown_legacy_baseline"
  | "missing_provenance_classification"
  | "secret_data"
  | "private_data_unauthorized"
  | "incomplete_tool_result"
  | "identity_mismatch"
  | "budget_exhausted"
  | "unresolved_reservation"
  | "role_failed"
  | "unexpected_effect";

export interface CorrectionExposure {
  readonly signature: string;
  readonly related: boolean;
  readonly correctionOccurred: boolean;
  readonly phase: "pre_activation" | "post_activation";
  readonly servedRevisions: readonly CapabilityRevisionRef[];
}

export interface CompoundingReplayRecordBase {
  readonly replayId: string;
  readonly planId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly occurredAt: string;
  readonly scope: string;
  readonly modelCohort: string;
  readonly servedRevisions: readonly CapabilityRevisionRef[];
  readonly baselineRevisions: readonly CapabilityRevisionRef[];
  readonly scopeRelated: boolean;
  readonly correctionExposures: readonly CorrectionExposure[];
}

export interface ExcludedCompoundingReplayRecord extends CompoundingReplayRecordBase {
  readonly status: "excluded";
  readonly exclusionReason: CompoundingReplayExclusionReason;
  readonly exclusionDetail: string;
}

export interface PairedCompoundingReplayRecord extends CompoundingReplayRecordBase {
  readonly status: "paired";
  readonly winner: "served" | "baseline" | "tie" | "inconclusive";
  readonly railsPassed: boolean;
  readonly servedOutputEvidence: EvidenceRevisionRef<"output">;
  readonly baselineOutputEvidence: EvidenceRevisionRef<"output">;
  readonly judgmentEvidence: EvidenceRevisionRef<"judgment">;
  readonly servedInputTokens: number;
  readonly baselineInputTokens: number;
  readonly injectedContextTokens: number;
  readonly servedPromptLayerBytes: number;
  readonly baselinePromptLayerBytes: number;
}

/**
 * One settled foreground turn considered by compounding measurement. Exclusions are durable data,
 * not discarded control flow, so every aggregate can expose its actual coverage.
 */
export type CompoundingReplayRecord = ExcludedCompoundingReplayRecord | PairedCompoundingReplayRecord;

export function preflightPlanMatchesExperiment(experiment: Experiment, plan: PreflightPlan): boolean {
  return (
    plan.experimentId === experiment.experimentId &&
    sameCapabilityRevisionRef(plan.baselineRevision, experiment.baselineRevision) &&
    experiment.candidateRevisions.some((revision) =>
      sameCapabilityRevisionRef(plan.candidateRevision, revision),
    )
  );
}

export function preflightReportMatchesPlan(plan: PreflightPlan, report: PreflightReport): boolean {
  return (
    report.experimentId === plan.experimentId &&
    report.planId === plan.planId &&
    sameCapabilityRevisionRef(report.baselineRevision, plan.baselineRevision) &&
    sameCapabilityRevisionRef(report.candidateRevision, plan.candidateRevision)
  );
}
