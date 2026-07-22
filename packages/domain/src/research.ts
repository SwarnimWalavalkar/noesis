export const DATABASE_TABLES = [
  "sessions",
  "messages",
  "tool_calls",
  "jobs",
  "experiments",
  "experiment_trials",
  "feedback_signals",
  "evaluations",
  "activation_pointers",
  "search_configuration",
  "activity_log",
  "file_revisions",
] as const;

export type DatabaseTable = (typeof DATABASE_TABLES)[number];

export interface DatabaseRowRef {
  readonly kind: "database_row";
  readonly table: DatabaseTable;
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

export interface EvidenceRevisionRef {
  readonly kind: "evidence_revision";
  readonly revisionId: string;
  readonly workingPath: string;
  readonly snapshotPath: string;
  readonly contentDigest: string;
  readonly evidenceKind: EvidenceKind;
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
  readonly activeRevisionId: string | null;
}

export interface CapabilityRevision {
  readonly capabilityRevisionId: string;
  readonly capabilityId: string;
  readonly predecessorRevisionId?: string;
  readonly status: "candidate" | "active" | "inactive";
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

export type ExperimentOutcome = "keep" | "revise" | "revert";

export interface Experiment {
  readonly experimentId: string;
  readonly hypothesis: string;
  readonly scope: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly baselineRevisionId: string;
  readonly candidateRevisionIds: readonly string[];
  readonly preflightRef?: EvidenceRevisionRef;
  readonly activatedRevisionId?: string;
  readonly feedbackSignalIds: readonly string[];
  readonly status: "briefed" | "authoring" | "preflight" | "active" | "completed";
  readonly outcome?: ExperimentOutcome;
  readonly followUpExperimentId?: string;
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
  readonly candidateRevision: FileRevisionRef;
  readonly baselineRevision: FileRevisionRef;
  readonly caseRefs: readonly EvidenceRevisionRef[];
  readonly judgeVariant: ExperimentVariantRef;
  readonly runtimeVariant: ExperimentVariantRef;
  readonly budget: EvaluationBudget;
}

export interface ExperimentTrial {
  readonly trialId: string;
  readonly experimentId: string;
  readonly comparisonGroupId: string;
  readonly arm: "baseline" | "candidate";
  readonly capabilityRevisionId: string;
  readonly inputRefs: readonly EvidenceRef[];
  readonly outputEvidenceRefs: readonly EvidenceRevisionRef[];
  readonly traceEvidenceRefs: readonly EvidenceRevisionRef[];
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

export interface PreflightReport {
  readonly preflightId: string;
  readonly candidateRevision: FileRevisionRef;
  readonly baselineRevision: FileRevisionRef;
  readonly trialRowRefs: readonly DatabaseRowRef[];
  readonly trialEvidence: readonly EvidenceRevisionRef[];
  readonly judgmentEvidence: readonly EvidenceRevisionRef[];
  readonly appliedCriteria: readonly AppliedCriterionRef[];
  readonly railChecks: readonly RailCheckResult[];
  readonly comparison: EvaluationComparison;
  readonly decision: "pass" | "block" | "inconclusive";
  readonly reportEvidence: EvidenceRevisionRef;
}
