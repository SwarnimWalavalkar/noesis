import type { FrozenTurnPlan } from "@noesis/agent-types";
import type {
  ActorRef,
  ArtifactFileRef,
  CapabilityRevisionRef,
  CompoundingReplayRecord,
  CompoundingReplayRole,
  DatabaseRowRef,
  DataSensitivity,
  EvidenceRef,
  EvidenceRevisionRef,
  Experiment,
  FileRevisionRef,
  JsonValue,
  PermissionManifest,
  WorkingAdjustment,
  WorkingAdjustmentReadPort,
  WorkspaceStore,
} from "@noesis/domain";

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
  /** One adapter-authored, SQLite-validated position in this turn's mixed interaction timeline. */
  readonly timelineSequence?: number;
}

export interface ContextCheckpointSource {
  readonly messageId: string;
  readonly contentDigest: string;
}

export interface ContextCheckpointRecord {
  readonly checkpointId: string;
  readonly sessionId: string;
  readonly previousCheckpointId?: string;
  readonly summary: string;
  readonly summaryDigest: string;
  readonly sourceDigest: string;
  readonly sources: readonly ContextCheckpointSource[];
  readonly firstRetainedMessageId?: string;
  readonly lastCoveredMessageId: string;
  readonly tokenBudget: number;
  readonly estimatedSummaryTokens: number;
  readonly sensitivity: Sensitivity;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly estimatedCost: number;
  };
  readonly createdAt: string;
}

export type ContextCheckpointActivationResult =
  | { readonly status: "activated"; readonly checkpoint: ContextCheckpointRecord }
  | { readonly status: "conflict"; readonly activeCheckpointId?: string };

export type UserIntentMode = "turn" | "steer";
export type UserIntentStatus = "pending" | "held" | "dispatching" | "unresolved" | "delivered" | "withdrawn";
export type UserIntentSteerOrigin = "explicit" | "queued";

export interface UserIntentRecord {
  readonly intentId: string;
  readonly sessionId: string;
  /** Cleared after delivery; the durable message becomes the sole authority for delivered text. */
  readonly text?: string;
  readonly contentDigest: string;
  readonly deliveryMode: UserIntentMode;
  readonly status: UserIntentStatus;
  readonly queueSequence: number;
  readonly queuedBehindTurnId?: string;
  readonly targetTurnId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly heldAt?: string;
  readonly promotedAt?: string;
  readonly deliveredAt?: string;
  readonly unresolvedAt?: string;
  readonly withdrawnAt?: string;
  readonly steerOrigin?: UserIntentSteerOrigin;
  readonly attemptCount: number;
}

export interface ToolCallRecord {
  readonly toolCallId: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly messageId?: string;
  readonly parentToolCallId?: string;
  readonly executionId?: string;
  readonly toolName: string;
  readonly request: unknown;
  readonly update?: unknown;
  readonly response?: unknown;
  /** Assigned by WorkspaceStore on first persistence and immutable thereafter. */
  readonly sequence?: number;
  /** Adapter-authored position shared with messages in this turn's durable timeline. */
  readonly timelineSequence?: number;
  readonly status: "requested" | "running" | "completed" | "failed" | "denied" | "ambiguous";
  readonly sensitivity: Sensitivity;
  readonly createdAt: string;
  readonly completedAt?: string;
}

export interface CodeExecutionRecord {
  readonly executionId: string;
  readonly logicalExecutionId: string;
  readonly parentExecutionId?: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly catalogId: string;
  readonly catalogDigest: string;
  readonly sourceDigest: string;
  readonly sourceArtifactId?: string;
  readonly stdoutArtifactId?: string;
  readonly stderrArtifactId?: string;
  readonly status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  readonly result?: JsonValue;
  readonly error?: string;
  readonly callCount: number;
  readonly startedAt: string;
  readonly completedAt?: string;
}

export interface WorkflowRunRecord {
  readonly runId: string;
  /** Absent only for runs created before project ownership was persisted. */
  readonly projectId?: string;
  readonly workflowName: string;
  readonly workflowRevision: number;
  readonly definitionRevisionId: string;
  readonly catalogId?: string;
  readonly catalogDigest?: string;
  readonly definitionDependenciesDigest?: string;
  readonly permissionDigest?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  readonly sessionId: string;
  readonly turnId?: string;
  readonly status: "running" | "paused" | "completed" | "failed" | "cancelled";
  readonly currentPhase: number;
  readonly input: JsonValue;
  readonly output?: JsonValue;
  readonly error?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
}

export interface WorkflowPhaseRunRecord {
  readonly runId: string;
  readonly phaseIndex: number;
  readonly phaseName: string;
  readonly status: "pending" | "running" | "completed" | "failed" | "cancelled";
  readonly attempt: number;
  readonly logicalExecutionId?: string;
  readonly input: JsonValue;
  readonly output?: JsonValue;
  readonly executionId?: string;
  readonly error?: string;
  readonly startedAt?: string;
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

export interface ClassifyOutcomeRequest {
  readonly outcomeId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly classification: "correction" | "preference" | "other";
  readonly reason: string;
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
  readonly sourceAdjustmentId?: string | undefined;
}

export type WorkingAdjustmentApplyResult =
  | {
      readonly status: "applied";
      readonly adjustment: WorkingAdjustment;
      readonly replacedAdjustmentId: string | null;
    }
  | {
      readonly status: "stale";
      readonly adjustmentId: string;
      readonly currentActiveAdjustmentId: string | null;
    };

export type WorkingAdjustmentUnapplyResult =
  | {
      readonly status: "unapplied";
      readonly adjustmentId: string;
    }
  | {
      readonly status: "stale";
      readonly adjustmentId: string;
      readonly currentActiveAdjustmentId: string | null;
    };

export interface ProtectedWorkingAdjustmentStore extends WorkingAdjustmentReadPort {
  readonly apply: (request: {
    readonly adjustment: WorkingAdjustment;
    readonly expectedActiveAdjustmentId: string | null;
    readonly signal?: AbortSignal;
  }) => Promise<WorkingAdjustmentApplyResult>;
  readonly unapply: (request: {
    readonly projectId: string;
    readonly expectedActiveAdjustmentId: string;
    readonly signal?: AbortSignal;
  }) => Promise<WorkingAdjustmentUnapplyResult>;
}

const workingAdjustmentAdmissionConflicts = new WeakSet<Error>();

export function workingAdjustmentAdmissionConflictError(): Error {
  const error = new Error("Working adjustment changed before frozen turn admission (CAS conflict)");
  workingAdjustmentAdmissionConflicts.add(error);
  return error;
}

export function isWorkingAdjustmentAdmissionConflictError(error: unknown): error is Error {
  return error instanceof Error && workingAdjustmentAdmissionConflicts.has(error);
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

export interface ClassifyExperimentObservationsRequest {
  readonly outcomeId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly classification: "correction" | "preference" | "other";
}

export interface ExperimentObservationClassificationResult {
  readonly status: "updated" | "unchanged" | "already_bound";
  readonly observations: readonly ExperimentObservationRecord[];
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
  readonly classifyObservations: (
    request: ClassifyExperimentObservationsRequest,
  ) => Promise<ExperimentObservationClassificationResult>;
  readonly getObservationClassification: (
    request: ClassifyExperimentObservationsRequest,
  ) => Promise<ExperimentObservationClassificationResult | undefined>;
  readonly getObservation: (observationId: string) => Promise<ExperimentObservationRecord | undefined>;
  readonly listObservationsForOutcome: (outcomeId: string) => Promise<readonly ExperimentObservationRecord[]>;
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
  readonly contextCheckpoints: {
    readonly get: (checkpointId: string) => Promise<ContextCheckpointRecord | undefined>;
    readonly getActive: (sessionId: string) => Promise<ContextCheckpointRecord | undefined>;
    readonly activate: (request: {
      readonly checkpoint: ContextCheckpointRecord;
      readonly expectedActiveCheckpointId?: string;
      /** Exact replay-eligible context used to choose the covered prefix and retained suffix. */
      readonly expectedContextMessageIds: readonly string[];
    }) => Promise<ContextCheckpointActivationResult>;
  };
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
  readonly userIntents: {
    readonly enqueue: (request: {
      readonly intentId: string;
      readonly sessionId: string;
      readonly text: string;
      readonly queuedBehindTurnId?: string;
      readonly createdAt: string;
    }) => Promise<UserIntentRecord>;
    /**
     * Atomically creates a turn intent and promotes it into a steer bound to a
     * running foreground turn. Returns undefined without inserting when the
     * target turn cannot be bound.
     */
    readonly enqueueAndPromoteToSteer: (request: {
      readonly intentId: string;
      readonly sessionId: string;
      readonly text: string;
      readonly targetTurnId: string;
      readonly createdAt: string;
      readonly promotedAt: string;
    }) => Promise<UserIntentRecord | undefined>;
    /**
     * Durably records an explicit steer until the live adapter reports readiness.
     * Returns undefined without inserting when the target turn cannot be bound.
     */
    readonly holdExplicitSteer: (request: {
      readonly intentId: string;
      readonly sessionId: string;
      readonly text: string;
      readonly targetTurnId: string;
      readonly createdAt: string;
      readonly heldAt: string;
    }) => Promise<UserIntentRecord | undefined>;
    /** Moves the newest queued turn into durable held-steer state. */
    readonly holdNewestPendingToSteer: (request: {
      readonly sessionId: string;
      readonly targetTurnId: string;
      readonly heldAt: string;
    }) => Promise<UserIntentRecord | undefined>;
    /** Promotes a held steer to dispatching once the adapter can accept it. */
    readonly activateHeldSteer: (request: {
      readonly sessionId: string;
      readonly intentId: string;
      readonly targetTurnId: string;
      readonly promotedAt: string;
    }) => Promise<UserIntentRecord | undefined>;
    /** Releases a held steer without losing whether it was explicit or queued. */
    readonly releaseHeldSteer: (request: {
      readonly sessionId: string;
      readonly intentId: string;
      readonly targetTurnId: string;
      readonly releasedAt: string;
    }) => Promise<UserIntentRecord | undefined>;
    readonly listPending: (sessionId: string) => Promise<readonly UserIntentRecord[]>;
    readonly listHeld: (sessionId: string) => Promise<readonly UserIntentRecord[]>;
    readonly listUnresolved: (sessionId: string) => Promise<readonly UserIntentRecord[]>;
    readonly claimOldestPending: (request: {
      readonly sessionId: string;
      readonly targetTurnId: string;
      readonly claimedAt: string;
    }) => Promise<UserIntentRecord | undefined>;
    readonly promoteNewestPendingToSteer: (request: {
      readonly sessionId: string;
      readonly targetTurnId: string;
      readonly promotedAt: string;
    }) => Promise<UserIntentRecord | undefined>;
    readonly withdraw: (request: {
      readonly sessionId: string;
      readonly intentId: string;
      readonly withdrawnAt: string;
    }) => Promise<UserIntentRecord | undefined>;
    /**
     * Withdraws an explicit steer only when the caller has positive evidence
     * that it was not consumed. The steer never passes through pending state.
     */
    readonly withdrawUnconsumedSteerDispatch: (request: {
      readonly sessionId: string;
      readonly intentId: string;
      readonly targetTurnId: string;
      readonly withdrawnAt: string;
    }) => Promise<UserIntentRecord | undefined>;
    readonly markDelivered: (request: {
      readonly sessionId: string;
      readonly intentId: string;
      readonly targetTurnId: string;
      readonly deliveredAt: string;
    }) => Promise<UserIntentRecord | undefined>;
    readonly recordSteerDelivery: (request: {
      readonly sessionId: string;
      readonly intentId: string;
      readonly targetTurnId: string;
      readonly text: string;
      readonly sensitivity: Sensitivity;
      readonly timelineSequence: number;
      readonly deliveredAt: string;
    }) => Promise<UserIntentRecord | undefined>;
    readonly markUnresolved: (request: {
      readonly sessionId: string;
      readonly intentId: string;
      readonly targetTurnId: string;
      readonly unresolvedAt: string;
    }) => Promise<UserIntentRecord | undefined>;
    /** Release only when the caller has positive evidence that no delivery occurred. */
    readonly releaseUnconsumedDispatch: (request: {
      readonly sessionId: string;
      readonly intentId: string;
      readonly releasedAt: string;
    }) => Promise<UserIntentRecord | undefined>;
    readonly recoverDispatching: (request: {
      readonly sessionId: string;
      readonly recoveredAt: string;
    }) => Promise<{
      readonly released: number;
      readonly delivered: number;
      readonly unresolved: number;
    }>;
  };
  readonly toolCalls: {
    readonly get: (toolCallId: string) => Promise<ToolCallRecord | undefined>;
    readonly put: (record: ToolCallRecord) => Promise<DatabaseRowRef>;
    readonly listForSession: (sessionId: string) => Promise<readonly ToolCallRecord[]>;
    readonly listForTurn: (sessionId: string, turnId: string) => Promise<readonly ToolCallRecord[]>;
    readonly listForExecution: (executionId: string) => Promise<readonly ToolCallRecord[]>;
    readonly interruptRunningForTurn: (turnId: string, interruptedAt: string) => Promise<number>;
  };
  readonly codeExecutions: {
    readonly get: (executionId: string) => Promise<CodeExecutionRecord | undefined>;
    readonly put: (record: CodeExecutionRecord) => Promise<void>;
    readonly listForSession: (sessionId: string) => Promise<readonly CodeExecutionRecord[]>;
    readonly interruptRunning: (interruptedAt: string) => Promise<number>;
  };
  readonly workflows: {
    readonly getRun: (runId: string) => Promise<WorkflowRunRecord | undefined>;
    readonly putRun: (record: WorkflowRunRecord) => Promise<void>;
    readonly claimPausedRun: (
      runId: string,
      sessionId: string,
      projectId: string,
      claimedAt: string,
    ) => Promise<WorkflowRunRecord | undefined>;
    readonly listRunsForSession: (sessionId: string) => Promise<readonly WorkflowRunRecord[]>;
    readonly putPhase: (record: WorkflowPhaseRunRecord) => Promise<void>;
    readonly listPhases: (runId: string) => Promise<readonly WorkflowPhaseRunRecord[]>;
    readonly interruptRunning: (interruptedAt: string) => Promise<{
      readonly runs: number;
      readonly phases: number;
    }>;
  };
  readonly outcomes: {
    readonly get: (outcomeId: string) => Promise<OutcomeRecord | undefined>;
    readonly put: (record: OutcomeRecord) => Promise<void>;
    /** Record the model's semantic observation once; only a correction advances unknown -> corrected. */
    readonly classify: (request: ClassifyOutcomeRequest) => Promise<OutcomeRecord>;
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
      readonly table: "sessions" | "messages" | "tool_calls" | "outcomes" | "experiments";
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

export type SearchSessionScope =
  | { readonly kind: "exact"; readonly sessionId: string }
  | { readonly kind: "previous"; readonly currentSessionId: string };

export type SearchSourceScope = "session_or_outcome" | "corrected_outcome" | "completed_experiment";

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
    readonly sessionScope?: SearchSessionScope;
    readonly sourceScope?: SearchSourceScope;
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
    readonly sessionScope?: SearchSessionScope;
    readonly sourceScope?: SearchSourceScope;
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
