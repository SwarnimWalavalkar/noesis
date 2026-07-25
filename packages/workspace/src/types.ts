import type {
  ActorRef,
  ArtifactFileRef,
  CompoundingReplayRecord,
  CompoundingReplayRole,
  EvidenceRef,
  EvidenceRevisionRef,
  Experiment,
  DatabaseRowRef,
  FileRevisionRef,
  WorkspaceStore,
  CapabilityRevisionRef,
  DataSensitivity,
  PermissionManifest,
} from "@noesis/domain";
import type { FrozenTurnPlan } from "@noesis/agent-types";

export type Sensitivity = DataSensitivity;
export type SessionStatus = "idle" | "running" | "completed" | "aborted" | "failed";

export interface WorkspacePaths {
  readonly root: string;
  readonly database: string;
  readonly definitions: string;
  readonly candidates: string;
  readonly active: string;
  readonly revisions: string;
  readonly evidence: string;
  readonly artifacts: string;
  readonly staging: string;
}

export interface SessionRecord {
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly title: string;
  readonly status: SessionStatus;
  readonly provider: string;
  readonly model: string;
  readonly runtime: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface MessageRecord {
  readonly messageId: string;
  readonly sessionId: string;
  readonly role: "user" | "assistant" | "system" | "tool";
  readonly content: string;
  readonly sensitivity: Sensitivity;
  readonly createdAt: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ToolCallRecord {
  readonly toolCallId: string;
  readonly sessionId: string;
  readonly messageId?: string;
  readonly toolName: string;
  readonly request: unknown;
  readonly response?: unknown;
  readonly status: "requested" | "running" | "completed" | "failed" | "denied" | "ambiguous";
  readonly sensitivity: Sensitivity;
  readonly createdAt: string;
  readonly completedAt?: string;
}

export interface OutcomeRecord {
  readonly outcomeId: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly status: "accepted" | "corrected" | "failed" | "unknown";
  readonly summary: string;
  readonly sensitivity: Sensitivity;
  readonly createdAt: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ActivationRecord {
  readonly activationId: string;
  readonly revision: number;
  readonly previousActivationId: string | null;
  readonly activeDefinitions: Readonly<Record<string, FileRevisionRef>>;
  readonly activeCapabilityRevisions: Readonly<Record<string, StoredCapabilityRevisionRef>>;
  readonly preflightId?: string;
  readonly createdAt: string;
}

export interface LegacyCapabilityRevisionRef {
  readonly kind: "legacy_capability_revision";
  readonly capabilityId: string;
  readonly capabilityRevisionId: string;
}

export type StoredCapabilityRevisionRef = CapabilityRevisionRef | LegacyCapabilityRevisionRef;

export type ActivationPolicyDecision = "block" | "approval_required" | "eligible_auto_activate";
export type ActivationOperationStatus =
  | "blocked"
  | "staged"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "committed";

export interface ActivationEvidenceBinding {
  readonly experimentId: string;
  readonly candidateRevision: CapabilityRevisionRef;
  readonly manifestRevision: FileRevisionRef;
  readonly preflightId: string;
  readonly planId: string;
  readonly candidateDigest: string;
  readonly manifestDigest: string;
  readonly suiteDigest: string;
  readonly preflightDigest: string;
  readonly reportDigest: string;
  readonly definitionSetDigest: string;
  readonly controlRevisionId: string | null;
}

export interface ActivationMaterializationRecord {
  readonly slotKey: string;
  readonly stageId: string;
  readonly sourceRevision: FileRevisionRef;
  readonly activeRevision: FileRevisionRef;
  readonly published: boolean;
}

export interface ActivationOperationRecord {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly activationId: string;
  readonly binding: ActivationEvidenceBinding;
  readonly bindingDigest: string;
  readonly policySnapshot: Readonly<Record<string, unknown>>;
  readonly policyDigest: string;
  readonly decision: ActivationPolicyDecision;
  readonly status: ActivationOperationStatus;
  readonly expectedActivationRevision: number;
  readonly previousActivationId: string | null;
  readonly approvalId?: string;
  readonly supersededByOperationId?: string;
  readonly materializations: readonly ActivationMaterializationRecord[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly committedAt?: string;
}

export interface ActivationApprovalRecord {
  readonly approvalId: string;
  readonly operationId: string;
  readonly bindingDigest: string;
  readonly policyDigest: string;
  readonly status: "pending" | "approved" | "rejected";
  readonly requestedAt: string;
  readonly decidedAt?: string;
  readonly decisionActor?: string;
}

export interface TurnActivationPinRecord {
  readonly turnKey: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly activationId: string;
  readonly activationRevision: number;
  readonly activeDefinitions: Readonly<Record<string, FileRevisionRef>>;
  readonly activeCapabilityRevisions: Readonly<Record<string, CapabilityRevisionRef>>;
  readonly pinnedAt: string;
}

export interface ObservationMetrics {
  readonly quality: number | null;
  readonly baselineQuality: number | null;
  readonly latencyMs: number | null;
  readonly baselineLatencyMs: number | null;
  readonly cost: number | null;
  readonly baselineCost: number | null;
  readonly failed: boolean;
  readonly protectedRailViolation: boolean;
}

export type ObservationPrecedence = "none" | "correction" | "preference" | "user_veto";

export interface ExperimentObservationRecord {
  readonly observationId: string;
  readonly dedupeKey: string;
  readonly experimentId: string;
  readonly signalId: string;
  readonly outcomeId: string;
  readonly preflightId: string;
  readonly experimentActivationId: string;
  readonly servingActivationId: string;
  readonly activationRevision: number;
  readonly sessionId: string;
  readonly turnId: string;
  readonly capabilityRevision: CapabilityRevisionRef;
  readonly metrics: ObservationMetrics;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly precedence: ObservationPrecedence;
  readonly userDecision?: "keep" | "revise" | "revert";
  readonly hardRegression: boolean;
  readonly createdAt: string;
}

export interface ExperimentResearchRunRecord {
  readonly runId: string;
  readonly experimentId: string;
  readonly strategyId: string;
  readonly inputDigest: string;
  readonly status: "running" | "completed" | "failed";
  readonly proposal?: "keep" | "revise" | "revert";
  readonly citedObservationIds: readonly string[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly attempt: number;
  readonly failureMessage?: string;
  readonly retryable: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ExperimentOutcomeOperationRecord {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly experimentId: string;
  readonly decision: "keep" | "revise" | "revert";
  readonly strategyId: string;
  readonly researchRunId?: string;
  readonly expectedActivationId: string;
  readonly expectedActivationRevision: number;
  readonly restoreSourceActivationId?: string;
  readonly restoredActivationId?: string;
  readonly successorExperimentId?: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly operationDigest: string;
  readonly committedAt: string;
}

export interface SuccessorLineageInputRecord {
  readonly inputId: string;
  readonly predecessorExperimentId: string;
  readonly successorExperimentId: string;
  readonly predecessorActivationId: string;
  readonly predecessorRevision: CapabilityRevisionRef;
  readonly baselineRevision: CapabilityRevisionRef;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly createdAt: string;
}

export interface CommitExperimentOutcomeRequest {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly experimentId: string;
  readonly decision: "keep" | "revise" | "revert";
  readonly strategyId: string;
  readonly researchRunId?: string;
  readonly expectedActivationId: string;
  readonly expectedActivationRevision: number;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly operationDigest: string;
  readonly restore?: {
    readonly sourceActivationId: string;
    readonly currentPermissionManifest: PermissionManifest;
    readonly restoredPermissionManifest: PermissionManifest;
  };
  readonly successor?: {
    readonly experiment: Experiment;
    readonly lineage: Omit<SuccessorLineageInputRecord, "createdAt">;
  };
}

export interface ProtectedFeedbackStore {
  readonly operationForActivation: (activationId: string) => Promise<ActivationOperationRecord | undefined>;
  readonly recordObservation: (
    record: Omit<ExperimentObservationRecord, "createdAt">,
    maximumObservations: number,
  ) => Promise<ExperimentObservationRecord | undefined>;
  readonly getObservation: (observationId: string) => Promise<ExperimentObservationRecord | undefined>;
  readonly listObservations: (
    experimentId: string,
    limit: number,
  ) => Promise<readonly ExperimentObservationRecord[]>;
  readonly putResearchRun: (
    record: Omit<ExperimentResearchRunRecord, "createdAt" | "updatedAt">,
  ) => Promise<ExperimentResearchRunRecord>;
  readonly getResearchRun: (runId: string) => Promise<ExperimentResearchRunRecord | undefined>;
  readonly listResearchRuns: (experimentId: string) => Promise<readonly ExperimentResearchRunRecord[]>;
  readonly getOutcome: (experimentId: string) => Promise<ExperimentOutcomeOperationRecord | undefined>;
  readonly commitOutcome: (
    request: CommitExperimentOutcomeRequest,
  ) => Promise<ExperimentOutcomeOperationRecord>;
  readonly getSuccessorInput: (
    predecessorExperimentId: string,
  ) => Promise<SuccessorLineageInputRecord | undefined>;
}

export interface PrepareActivationOperationRequest {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly activationId: string;
  readonly binding: ActivationEvidenceBinding;
  readonly bindingDigest: string;
  readonly policySnapshot: Readonly<Record<string, unknown>>;
  readonly policyDigest: string;
  readonly decision: ActivationPolicyDecision;
  readonly expectedActivationRevision: number;
  readonly previousActivationId: string | null;
  readonly approvalId?: string;
  readonly stagedDefinitions: readonly {
    readonly slotKey: string;
    readonly stageId: string;
    readonly sourceRevision: FileRevisionRef;
  }[];
}

export interface ProtectedActivationStore {
  readonly prepare: (request: PrepareActivationOperationRequest) => Promise<ActivationOperationRecord>;
  readonly getOperation: (operationId: string) => Promise<ActivationOperationRecord | undefined>;
  readonly listOperations: (limit?: number) => Promise<readonly ActivationOperationRecord[]>;
  readonly getApproval: (approvalId: string) => Promise<ActivationApprovalRecord | undefined>;
  readonly supersede: (request: {
    readonly operationId: string;
    readonly supersededByOperationId: string;
  }) => Promise<ActivationOperationRecord>;
  readonly decideApproval: (request: {
    readonly approvalId: string;
    readonly operationId: string;
    readonly bindingDigest: string;
    readonly decision: "approved" | "rejected";
    readonly actorId: string;
  }) => Promise<ActivationOperationRecord>;
  readonly commit: (request: {
    readonly operationId: string;
    readonly bindingDigest: string;
  }) => Promise<ActivationOperationRecord>;
  readonly current: () => Promise<ActivationRecord | undefined>;
  readonly pinTurn: (request: {
    readonly sessionId: string;
    readonly turnId: string;
  }) => Promise<TurnActivationPinRecord>;
  readonly getTurnPin: (sessionId: string, turnId: string) => Promise<TurnActivationPinRecord | undefined>;
  readonly admitTurnPlan: (plan: FrozenTurnPlan) => Promise<FrozenTurnPlan>;
  readonly getTurnPlan: (sessionId: string, turnId: string) => Promise<FrozenTurnPlan | undefined>;
  readonly bootstrapGenesis: (request: {
    readonly capabilityRevision: CapabilityRevisionRef;
    readonly activeDefinitions: Readonly<Record<string, FileRevisionRef>>;
  }) => Promise<ActivationRecord>;
  readonly recoverCommittedPublications: () => Promise<number>;
}

export interface SearchConfiguration {
  readonly lexicalLimit: number;
  readonly semanticLimit: number;
  readonly rerankLimit: number;
  readonly maxExcerptChars: number;
  readonly includePrivate: boolean;
  readonly updatedAt: string;
}

export interface OperationalRepositories {
  readonly foregroundTurns: {
    readonly get: (turnId: string) => Promise<
      | {
          readonly turnId: string;
          readonly sessionId: string;
          readonly planId: string;
          readonly status: "running" | "completed" | "aborted" | "failed";
          readonly outcomeId?: string;
          readonly admittedAt: string;
          readonly settledAt?: string;
        }
      | undefined
    >;
    readonly settle: (request: {
      readonly turnId: string;
      readonly outcomeId: string;
      readonly status: "completed" | "aborted" | "failed";
      readonly settledAt: string;
    }) => Promise<void>;
  };
  readonly sessions: {
    readonly get: (sessionId: string) => Promise<SessionRecord | undefined>;
    readonly sensitivity: (sessionId: string) => Promise<Sensitivity | undefined>;
    readonly put: (record: SessionRecord) => Promise<DatabaseRowRef>;
    readonly list: () => Promise<readonly SessionRecord[]>;
  };
  readonly messages: {
    readonly get: (messageId: string) => Promise<MessageRecord | undefined>;
    readonly put: (record: MessageRecord) => Promise<DatabaseRowRef>;
    readonly listForSession: (sessionId: string) => Promise<readonly MessageRecord[]>;
  };
  readonly toolCalls: {
    readonly get: (toolCallId: string) => Promise<ToolCallRecord | undefined>;
    readonly put: (record: ToolCallRecord) => Promise<DatabaseRowRef>;
    readonly listForSession: (sessionId: string) => Promise<readonly ToolCallRecord[]>;
  };
  readonly outcomes: {
    readonly get: (outcomeId: string) => Promise<OutcomeRecord | undefined>;
    readonly put: (record: OutcomeRecord) => Promise<void>;
    readonly listForSession: (sessionId: string) => Promise<readonly OutcomeRecord[]>;
  };
  readonly searchConfiguration: {
    readonly get: () => Promise<SearchConfiguration>;
    readonly put: (configuration: SearchConfiguration) => Promise<DatabaseRowRef>;
  };
}

export interface StagedDefinition {
  readonly stageId: string;
  readonly targetArea: "candidate" | "active";
  readonly relativePath: string;
  readonly stagedPath: string;
  readonly contentDigest: string;
  readonly actor: ActorRef;
  readonly reason?: string;
  readonly createdAt: string;
}

export interface StageDefinitionRequest {
  readonly targetArea: "candidate" | "active";
  readonly relativePath: string;
  readonly bytes: Uint8Array;
  readonly actor: ActorRef;
  readonly reason?: string;
}

export type CanonicalSearchSource =
  | {
      readonly kind: "database_row";
      readonly table: "sessions" | "messages" | "tool_calls" | "outcomes";
      readonly rowId: string;
      readonly field: string;
    }
  | {
      readonly kind: "file_revision";
      readonly revisionId: string;
      readonly field: "bytes";
    };

export interface SearchDocument {
  readonly documentId: string;
  readonly source: CanonicalSearchSource;
  readonly sessionId?: string;
  readonly sensitivity: Sensitivity;
  readonly occurredAt: string;
  readonly body: string;
}

export interface SearchCandidate extends SearchDocument {
  readonly lexicalScore?: number;
  readonly semanticScore?: number;
}

export interface SearchIndexPort {
  readonly clear: () => Promise<void>;
  readonly rebuildDocuments: () => Promise<readonly SearchDocument[]>;
  readonly listDocuments: (options?: {
    readonly includePrivate?: boolean;
    readonly includeSecret?: boolean;
  }) => Promise<readonly SearchDocument[]>;
  readonly lexicalCandidates: (request: {
    readonly query: string;
    readonly limit: number;
    readonly sessionId?: string;
    readonly includePrivate: boolean;
  }) => Promise<readonly SearchCandidate[]>;
  readonly putEmbeddings: (
    modelId: string,
    embeddings: ReadonlyMap<string, readonly number[]>,
  ) => Promise<void>;
  readonly semanticCandidates: (request: {
    readonly modelId: string;
    readonly vector: readonly number[];
    readonly limit: number;
    readonly sessionId?: string;
    readonly includePrivate: boolean;
  }) => Promise<readonly SearchCandidate[]>;
  readonly openCanonicalSource: (source: CanonicalSearchSource) => Promise<string | undefined>;
}

export interface IntegrityReport {
  readonly databaseIntegrity: "ok" | string;
  readonly missingFiles: readonly string[];
  readonly orphanFiles: readonly string[];
}

export interface BackupReport {
  readonly backupRoot: string;
  readonly copiedFiles: number;
  readonly missingFiles: readonly string[];
  readonly manifestPath: string;
}

export interface RestoreReport {
  readonly targetRoot: string;
  readonly restoredFiles: number;
  readonly missingFiles: readonly string[];
}

export interface LegacyImportReport {
  readonly sourceId: string;
  readonly alreadyImported: boolean;
  readonly sessions: number;
  readonly messages: number;
  readonly toolCalls: number;
  readonly outcomes: number;
  readonly jobs: number;
  readonly definitions: number;
  readonly artifacts: number;
  readonly warnings: readonly string[];
}

export interface OperationalCutoverReport {
  readonly cutoverName: "workspace-operational-authority";
  readonly cutoverVersion: 1;
  readonly sourceDigest: string;
  readonly alreadyCompleted: boolean;
  readonly legacyImport: LegacyImportReport;
}

export interface CompoundingReplayBudgetRecord {
  readonly budgetId: string;
  readonly maximumCalls: number;
  readonly maximumTokens: number;
  readonly maximumCost: number;
  readonly reservedCalls: number;
  readonly reservedTokens: number;
  readonly reservedCost: number;
  readonly createdAt: string;
}

export interface CompoundingReplayRoleReservation {
  readonly operationId: string;
  readonly replayId: string;
  readonly role: CompoundingReplayRole;
  readonly requestDigest: string;
  readonly maximumTokens: number;
  readonly maximumCost: number;
}

export type CompoundingReplayReservationResult =
  | { readonly status: "reserved" }
  | { readonly status: "denied"; readonly reason: "budget_exhausted" }
  | { readonly status: "unresolved" }
  | {
      readonly status: "completed";
      readonly resultEvidence: EvidenceRevisionRef<"output" | "judgment">;
    }
  | { readonly status: "failed"; readonly failure: string };

/**
 * Protected coordinator persistence for shadow measurement. Generated roles receive neither this
 * interface nor the workspace store.
 */
export interface CompoundingMeasurementStore {
  readonly putBudget: (request: {
    readonly budgetId: string;
    readonly maximumCalls: number;
    readonly maximumTokens: number;
    readonly maximumCost: number;
  }) => Promise<CompoundingReplayBudgetRecord>;
  readonly getBudget: (budgetId: string) => Promise<CompoundingReplayBudgetRecord | undefined>;
  readonly beginReplay: (request: {
    readonly replayId: string;
    readonly planId: string;
    readonly budgetId: string;
  }) => Promise<void>;
  readonly reserveRole: (
    request: CompoundingReplayRoleReservation,
  ) => Promise<CompoundingReplayReservationResult>;
  readonly completeRole: (request: {
    readonly operationId: string;
    readonly resultEvidence: EvidenceRevisionRef<"output" | "judgment">;
    readonly usedTokens: number;
    readonly actualCost: number;
  }) => Promise<void>;
  readonly failRole: (operationId: string, failure: string) => Promise<void>;
  readonly record: (record: CompoundingReplayRecord) => Promise<void>;
  readonly list: () => Promise<readonly CompoundingReplayRecord[]>;
}

export interface NoesisWorkspaceStore extends WorkspaceStore {
  readonly paths: WorkspacePaths;
  readonly operational: OperationalRepositories;
  readonly search: SearchIndexPort;
  readonly recordDirectEdit: (
    workingPath: string,
    actor: ActorRef,
    reason?: string,
  ) => Promise<FileRevisionRef>;
  readonly stageDefinition: (request: StageDefinitionRequest) => Promise<StagedDefinition>;
  readonly registerStagedDefinition: (stageId: string) => Promise<FileRevisionRef>;
  readonly cleanupStagedDefinitions: () => Promise<number>;
  readonly inspectIntegrity: () => Promise<IntegrityReport>;
  readonly backup: (backupRoot: string) => Promise<BackupReport>;
  readonly importLegacyWorkspace: (legacyRoot: string, actor: ActorRef) => Promise<LegacyImportReport>;
  readonly cutoverLegacyOperationalAuthority: (
    legacyRoot: string,
    actor: ActorRef,
  ) => Promise<OperationalCutoverReport>;
  readonly close: () => void;
  readonly unsafeDatabasePathForTesting: string;
  readonly getArtifactMetadata: (artifactId: string) => Promise<ArtifactFileRef | undefined>;
}
