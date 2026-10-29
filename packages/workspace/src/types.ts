import type { ComposerAttachment } from "@noesis/domain";
import type {
  AgentAddress,
  AgentMessageKind,
  AgentMessageStatus,
  AgentThinkingLevel,
  AgentUsage,
  FrozenSubAgentPlan,
  FrozenTurnPlan,
  SubAgentStatus,
  SubAgentTaskStatus,
} from "@noesis/agent-types";
import type {
  ActorRef,
  ArtifactFileRef,
  DatabaseRowRef,
  DataSensitivity,
  FileRevisionRef,
  JsonObject,
  JsonValue,
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
  readonly metadata: JsonObject;
}

export type SessionDeletionResult = "purged" | "retained-for-audit" | "missing";

export interface MessageRecord {
  readonly messageId: string;
  readonly sessionId: string;
  readonly role: "user" | "assistant" | "system" | "tool";
  readonly content: string;
  readonly sensitivity: Sensitivity;
  readonly createdAt: string;
  readonly metadata: JsonObject;
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
  /** Legacy checkpoints recursively summarize prior checkpoints; note deltas describe only their own sources. */
  readonly summaryKind: "legacy_snapshot" | "note_delta";
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
  readonly attachments?: readonly ComposerAttachment[];
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
  readonly projectId?: string;
  readonly turnId?: string;
  readonly catalogId: string;
  readonly catalogDigest: string;
  readonly sourceDigest: string;
  readonly program?: {
    readonly mode: "script";
    readonly projectId: string;
    readonly name: string;
    readonly revision: number;
    readonly definitionRevisionId: string;
  };
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
  readonly projectId: string;
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
  readonly contextPin?: {
    readonly artifactId: string;
    readonly digest: string;
    readonly characterLength: number;
    readonly byteLength: number;
  };
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

export type ModelCallContextRef =
  | string
  | {
      readonly __noesisContext: {
        readonly documentId: string;
        readonly start: number;
        /** UTF-16 offset greater than or equal to start. */
        readonly end: number;
      };
    };

export interface ModelCallRecord {
  readonly modelCallId: string;
  readonly parentExecutionId: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly contextArtifactId?: string;
  readonly requestArtifactId: string;
  readonly outputArtifactId?: string;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  readonly contextRefs: readonly ModelCallContextRef[];
  readonly status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly estimatedCost: number;
  };
  readonly latencyMs?: number;
  readonly error?: string;
  readonly startedAt: string;
  readonly completedAt?: string;
}

export interface SubAgentRecord {
  readonly agentId: string;
  readonly childSessionId: string;
  readonly projectId: string;
  readonly originSessionId: string;
  readonly originTurnId: string;
  readonly originExecutionId: string;
  readonly parentAgentId?: string;
  readonly name?: string;
  readonly status: SubAgentStatus;
  readonly frozenPlan: FrozenSubAgentPlan;
  readonly frozenPlanArtifactId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt?: string;
}

export interface SubAgentTaskRecord {
  readonly taskId: string;
  readonly agentId: string;
  readonly triggerMessageId: string;
  readonly status: SubAgentTaskStatus;
  readonly resultArtifactId?: string;
  readonly resultPreview?: string;
  readonly error?: string;
  readonly usage?: AgentUsage;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export interface AgentMailboxMessageRecord {
  readonly messageId: string;
  readonly projectId: string;
  readonly sender: AgentAddress;
  readonly recipient: AgentAddress;
  readonly kind: AgentMessageKind;
  readonly content: string;
  readonly sensitivity: Sensitivity;
  readonly status: AgentMessageStatus;
  readonly sequence: number;
  readonly taskId?: string;
  readonly createdAt: string;
  readonly claimedAt?: string;
  readonly deliveredAt?: string;
  readonly failedAt?: string;
  readonly failure?: string;
}

export interface SubAgentTimelineRecord {
  readonly taskId: string;
  readonly sequence: number;
  readonly kind: "message" | "reasoning" | "tool_call" | "model_call" | "mailbox";
  readonly entryId: string;
  readonly createdAt: string;
}

export interface SubAgentModelCallRecord {
  readonly modelCallId: string;
  readonly taskId: string;
  readonly round: number;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: AgentThinkingLevel;
  readonly requestArtifactId: string;
  readonly outputArtifactId?: string;
  readonly status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  readonly usage?: AgentUsage;
  readonly latencyMs?: number;
  readonly error?: string;
  readonly startedAt: string;
  readonly completedAt?: string;
}

interface WorkflowPhaseRunBase {
  readonly runId: string;
  readonly phaseIndex: number;
  readonly phaseName: string;
  readonly attempt: number;
  readonly input: JsonValue;
  readonly output?: JsonValue;
  readonly executionId?: string;
  readonly error?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}
export type WorkflowPhaseRunRecord =
  | (WorkflowPhaseRunBase & {
      readonly status: "pending";
      readonly logicalExecutionId?: never;
    })
  | (WorkflowPhaseRunBase & {
      readonly status: "running" | "completed" | "failed" | "cancelled";
      readonly logicalExecutionId: string;
    });

export interface OutcomeRecord {
  readonly outcomeId: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly status: "accepted" | "corrected" | "failed" | "unknown";
  readonly summary: string;
  readonly sensitivity: Sensitivity;
  readonly createdAt: string;
  readonly metadata: JsonObject;
}

const capabilityBindingAdmissionConflicts = new WeakSet<Error>();

export function capabilityBindingAdmissionConflictError(): Error {
  const error = new Error("Capability binding changed before frozen turn admission (CAS conflict)");
  capabilityBindingAdmissionConflicts.add(error);
  return error;
}

export function isCapabilityBindingAdmissionConflictError(cause: unknown): cause is Error {
  return cause instanceof Error && capabilityBindingAdmissionConflicts.has(cause);
}

export interface ProtectedTurnPlanStore {
  /** Admits a frozen turn plan once; re-admitting the same plan for the same turn returns it. */
  readonly admit: (plan: FrozenTurnPlan) => Promise<FrozenTurnPlan>;
  readonly get: (sessionId: string, turnId: string) => Promise<FrozenTurnPlan | undefined>;
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
    /** Immutable ancestry ordered from the oldest retained checkpoint to the requested checkpoint. */
    readonly lineage: (checkpointId: string) => Promise<readonly ContextCheckpointRecord[]>;
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
    /** Removes a session from user-visible history; referenced evidence is retained as a tombstone. */
    readonly delete: (sessionId: string, deletedAt: string) => Promise<SessionDeletionResult>;
    /** Deletes or tombstones the session only when it contains no conversation or recoverable intent. */
    readonly deleteIfEmpty: (sessionId: string, deletedAt: string) => Promise<boolean>;
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
      readonly attachments?: readonly ComposerAttachment[];
      readonly queuedBehindTurnId?: string;
      readonly createdAt: string;
    }) => Promise<UserIntentRecord>;
    /**
     * Atomically withdraws pending source intents and recreates them in destination FIFO order.
     * The source rows remain immutable provenance for the session-changing command handoff.
     */
    readonly reroutePending: (request: {
      readonly sourceSessionId: string;
      readonly destinationSessionId: string;
      readonly intents: readonly {
        readonly sourceIntentId: string;
        readonly destinationIntentId: string;
      }[];
      readonly reroutedAt: string;
    }) => Promise<readonly UserIntentRecord[]>;
    /**
     * Atomically creates a turn intent and promotes it into a steer bound to a
     * running foreground turn. Returns undefined without inserting when the
     * target turn cannot be bound.
     */
    readonly enqueueAndPromoteToSteer: (request: {
      readonly intentId: string;
      readonly sessionId: string;
      readonly text: string;
      readonly attachments?: readonly ComposerAttachment[];
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
      readonly attachments?: readonly ComposerAttachment[];
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
    readonly listDispatching: (sessionId: string) => Promise<readonly UserIntentRecord[]>;
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
      readonly attachments?: readonly ComposerAttachment[];
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
  readonly modelCalls: {
    readonly get: (modelCallId: string) => Promise<ModelCallRecord | undefined>;
    readonly put: (record: ModelCallRecord) => Promise<void>;
    readonly listForExecution: (executionId: string) => Promise<readonly ModelCallRecord[]>;
    readonly listForSession: (sessionId: string) => Promise<readonly ModelCallRecord[]>;
    readonly interruptRunning: (interruptedAt: string) => Promise<number>;
  };
  readonly subAgents: {
    readonly admit: (request: {
      readonly agent: SubAgentRecord;
      readonly task: SubAgentTaskRecord;
      readonly message: AgentMailboxMessageRecord;
      readonly childSession: SessionRecord;
    }) => Promise<void>;
    readonly get: (agentId: string) => Promise<SubAgentRecord | undefined>;
    readonly listForProject: (projectId: string) => Promise<readonly SubAgentRecord[]>;
    readonly put: (record: SubAgentRecord) => Promise<void>;
    readonly getTask: (taskId: string) => Promise<SubAgentTaskRecord | undefined>;
    readonly listTasks: (agentId: string) => Promise<readonly SubAgentTaskRecord[]>;
    readonly putTask: (record: SubAgentTaskRecord) => Promise<void>;
    readonly claimTask: (taskId: string, startedAt: string) => Promise<SubAgentTaskRecord | undefined>;
    readonly appendMessage: (
      record: Omit<AgentMailboxMessageRecord, "sequence">,
    ) => Promise<AgentMailboxMessageRecord>;
    readonly admitMessageTask: (request: {
      readonly message: Omit<AgentMailboxMessageRecord, "sequence">;
      readonly task: SubAgentTaskRecord;
    }) => Promise<AgentMailboxMessageRecord>;
    /**
     * Start a follow-up task for a subagent message whose addressed task settled before consuming
     * it. The message keeps its original task, triggers the new task, and returns to `accepted`.
     */
    readonly admitMissedMessageTask: (request: {
      readonly messageId: string;
      readonly task: SubAgentTaskRecord;
    }) => Promise<AgentMailboxMessageRecord>;
    readonly getMessage: (messageId: string) => Promise<AgentMailboxMessageRecord | undefined>;
    readonly listMessages: (agentId: string) => Promise<readonly AgentMailboxMessageRecord[]>;
    readonly listAcceptedMessagesForRecipient: (
      recipient: AgentAddress,
    ) => Promise<readonly AgentMailboxMessageRecord[]>;
    readonly putMessage: (record: AgentMailboxMessageRecord) => Promise<void>;
    /**
     * Atomically record claimed foreground mailbox messages as one reminder consumed by a running
     * foreground turn: the session message, its timeline position, and every mailbox delivery.
     */
    readonly recordForegroundReminder: (request: {
      readonly sessionId: string;
      readonly turnId: string;
      readonly messageIds: readonly string[];
      readonly content: string;
      readonly timelineSequence: number;
      readonly deliveredAt: string;
    }) => Promise<MessageRecord>;
    readonly appendTimeline: (record: SubAgentTimelineRecord) => Promise<void>;
    readonly listTimeline: (taskId: string) => Promise<readonly SubAgentTimelineRecord[]>;
    readonly putModelCall: (record: SubAgentModelCallRecord) => Promise<void>;
    readonly listModelCalls: (taskId: string) => Promise<readonly SubAgentModelCallRecord[]>;
    readonly recoverInterrupted: (interruptedAt: string) => Promise<number>;
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
    readonly listForSession: (sessionId: string) => Promise<readonly OutcomeRecord[]>;
  };
  readonly searchConfiguration: {
    readonly get: () => Promise<SearchConfiguration>;
    readonly put: (configuration: SearchConfiguration) => Promise<DatabaseRowRef>;
  };
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

export type SearchSessionScope =
  | { readonly kind: "exact"; readonly sessionId: string }
  | { readonly kind: "previous"; readonly currentSessionId: string };

export type SearchSourceScope = "session_or_outcome";

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

export interface NoesisWorkspaceStore extends WorkspaceStore {
  readonly paths: WorkspacePaths;
  readonly operational: OperationalRepositories;
  readonly capabilities: CapabilityLifecycleStore;
  readonly search: SearchIndexPort;
  readonly recordDirectEdit: (
    workingPath: string,
    actor: ActorRef,
    reason?: string,
  ) => Promise<FileRevisionRef>;
  readonly inspectIntegrity: () => Promise<IntegrityReport>;
  readonly backup: (backupRoot: string) => Promise<BackupReport>;
  readonly close: () => void;
  readonly unsafeDatabasePathForTesting: string;
  readonly getArtifactMetadata: (artifactId: string) => Promise<ArtifactFileRef | undefined>;
}

export interface CapabilityLifecyclePageCursor {
  readonly createdAt: string;
  readonly id: string;
}

export interface CapabilityLifecyclePage<Value> {
  readonly items: readonly Value[];
  readonly nextCursor?: CapabilityLifecyclePageCursor;
}

export interface CapabilityLifecycleCounts {
  readonly revisions: number;
  readonly feedback: number;
  readonly gates: number;
}

export interface CapabilityLifecycleStore {
  /** Replaces the name, description, and applicability, e.g. when a restore selects an older file. */
  readonly updateDefinition: (definition: import("@noesis/domain").CapabilityDefinition) => Promise<void>;
  /** Records judged outcomes. A revision keeps only its first judgment for each turn. */
  readonly recordOutcomes: (
    outcomes: readonly import("@noesis/domain").CapabilityOutcome[],
  ) => Promise<readonly import("@noesis/domain").CapabilityOutcome[]>;
  /** Helped, hurt, and unclear counts for each requested revision. */
  readonly trackRecords: (
    capabilityRevisionIds: readonly string[],
  ) => Promise<ReadonlyMap<string, import("@noesis/domain").CapabilityTrackRecord>>;
  /**
   * Judged outcome counts for one Capability across all its revisions, optionally since a time,
   * and when its first judged outcome happened.
   */
  readonly outcomeCounts: (
    capabilityId: string,
    since?: string,
  ) => Promise<{
    readonly helped: number;
    readonly hurt: number;
    readonly unclear: number;
    readonly firstAt?: string;
  }>;
  /** The newest judged outcomes for one Capability, across its revisions. */
  readonly listOutcomes: (
    capabilityId: string,
    limit: number,
  ) => Promise<readonly import("@noesis/domain").CapabilityOutcome[]>;
  readonly create: (request: {
    readonly definition: import("@noesis/domain").CapabilityDefinition;
    readonly revision: import("@noesis/domain").CapabilityLifecycleRevision;
    readonly binding: Omit<import("@noesis/domain").CapabilityBinding, "revisionNumber" | "updatedAt">;
    readonly gate?: import("@noesis/domain").CapabilityGateRequest;
  }) => Promise<import("@noesis/domain").CapabilityBinding>;
  readonly getDefinition: (
    capabilityId: string,
  ) => Promise<import("@noesis/domain").CapabilityDefinition | undefined>;
  readonly listDefinitions: () => Promise<readonly import("@noesis/domain").CapabilityDefinition[]>;
  readonly getDefinitions: (
    capabilityIds: readonly string[],
  ) => Promise<readonly import("@noesis/domain").CapabilityDefinition[]>;
  readonly getRevision: (
    reference: import("@noesis/domain").CapabilityRevisionRef,
  ) => Promise<import("@noesis/domain").CapabilityLifecycleRevision | undefined>;
  readonly getRevisionById: (
    capabilityId: string,
    capabilityRevisionId: string,
  ) => Promise<import("@noesis/domain").CapabilityLifecycleRevision | undefined>;
  readonly listRevisions: (
    capabilityId: string,
    request?: { readonly limit: number },
  ) => Promise<readonly import("@noesis/domain").CapabilityLifecycleRevision[]>;
  readonly listRevisionPage: (request: {
    readonly capabilityId: string;
    readonly after?: CapabilityLifecyclePageCursor;
    readonly limit: number;
  }) => Promise<CapabilityLifecyclePage<import("@noesis/domain").CapabilityLifecycleRevision>>;
  readonly addRevision: (
    revision: import("@noesis/domain").CapabilityLifecycleRevision,
  ) => Promise<import("@noesis/domain").CapabilityLifecycleRevision>;
  readonly getBinding: (
    capabilityId: string,
  ) => Promise<import("@noesis/domain").CapabilityBinding | undefined>;
  readonly getBindings: (
    capabilityIds: readonly string[],
  ) => Promise<readonly import("@noesis/domain").CapabilityBinding[]>;
  readonly listBindings: (request?: {
    readonly project: import("@noesis/domain").ProjectRef;
    readonly sessionId: string;
    readonly limit: number;
  }) => Promise<readonly import("@noesis/domain").CapabilityBinding[]>;
  readonly listEligibleBindings: (request: {
    readonly project: import("@noesis/domain").ProjectRef;
    readonly sessionId: string;
  }) => Promise<readonly import("@noesis/domain").CapabilityBinding[]>;
  readonly updateBinding: (request: {
    readonly capabilityId: string;
    readonly expectedRevisionNumber: number;
    readonly revision?: import("@noesis/domain").CapabilityRevisionRef;
    readonly scope?: import("@noesis/domain").CapabilityScope;
    readonly activationMode?: import("@noesis/domain").CapabilityActivationMode;
    readonly state?: import("@noesis/domain").CapabilityBindingState;
  }) => Promise<
    | { readonly status: "updated"; readonly binding: import("@noesis/domain").CapabilityBinding }
    | { readonly status: "stale"; readonly binding: import("@noesis/domain").CapabilityBinding }
  >;
  readonly updateBindingWithFeedback: (request: {
    readonly capabilityId: string;
    readonly expectedRevisionNumber: number;
    readonly revision?: import("@noesis/domain").CapabilityRevisionRef;
    readonly scope?: import("@noesis/domain").CapabilityScope;
    readonly activationMode?: import("@noesis/domain").CapabilityActivationMode;
    readonly state?: import("@noesis/domain").CapabilityBindingState;
    readonly feedback: import("@noesis/domain").CapabilityFeedback;
  }) => Promise<
    | { readonly status: "updated"; readonly binding: import("@noesis/domain").CapabilityBinding }
    | { readonly status: "stale"; readonly binding: import("@noesis/domain").CapabilityBinding }
  >;
  readonly addFeedback: (
    feedback: import("@noesis/domain").CapabilityFeedback,
  ) => Promise<import("@noesis/domain").CapabilityFeedback>;
  readonly listFeedback: (
    capabilityId: string,
    request?: { readonly limit: number },
  ) => Promise<readonly import("@noesis/domain").CapabilityFeedback[]>;
  readonly listFeedbackPage: (request: {
    readonly capabilityId: string;
    readonly after?: CapabilityLifecyclePageCursor;
    readonly limit: number;
  }) => Promise<CapabilityLifecyclePage<import("@noesis/domain").CapabilityFeedback>>;
  readonly stageGatedRevision: (request: {
    readonly revision: import("@noesis/domain").CapabilityLifecycleRevision;
    readonly feedback?: import("@noesis/domain").CapabilityFeedback;
    readonly gate: import("@noesis/domain").CapabilityGateRequest;
    readonly supersedeGateRequestId?: string;
  }) => Promise<
    | {
        readonly status: "staged";
        readonly gate: import("@noesis/domain").CapabilityGateRequest;
      }
    | {
        readonly status: "stale";
        readonly binding: import("@noesis/domain").CapabilityBinding;
      }
  >;
  readonly applyRevision: (request: {
    readonly revision: import("@noesis/domain").CapabilityLifecycleRevision;
    /** Replaces the name, description, and applicability in the same transaction as the binding. */
    readonly definition?: import("@noesis/domain").CapabilityDefinition;
    readonly feedback: import("@noesis/domain").CapabilityFeedback;
    readonly expectedBindingRevision: number;
    readonly scope: import("@noesis/domain").CapabilityScope;
    readonly activationMode: import("@noesis/domain").CapabilityActivationMode;
  }) => Promise<
    | { readonly status: "updated"; readonly binding: import("@noesis/domain").CapabilityBinding }
    | { readonly status: "stale"; readonly binding: import("@noesis/domain").CapabilityBinding }
  >;
  readonly createGate: (
    request: import("@noesis/domain").CapabilityGateRequest,
  ) => Promise<import("@noesis/domain").CapabilityGateRequest>;
  readonly getGate: (
    gateRequestId: string,
  ) => Promise<import("@noesis/domain").CapabilityGateRequest | undefined>;
  readonly listPendingGates: (request?: {
    readonly project: import("@noesis/domain").ProjectRef;
    readonly sessionId: string;
    readonly limit: number;
  }) => Promise<readonly import("@noesis/domain").CapabilityGateRequest[]>;
  readonly listGates: (
    capabilityId: string,
  ) => Promise<readonly import("@noesis/domain").CapabilityGateRequest[]>;
  readonly listGatePage: (request: {
    readonly capabilityId: string;
    readonly after?: CapabilityLifecyclePageCursor;
    readonly limit: number;
  }) => Promise<CapabilityLifecyclePage<import("@noesis/domain").CapabilityGateRequest>>;
  readonly countLifecycle: (capabilityId: string) => Promise<CapabilityLifecycleCounts>;
  readonly decideGate: (request: {
    readonly gateRequestId: string;
    readonly decision: "approve" | "deny";
  }) => Promise<
    | {
        readonly status: "updated";
        readonly gate: import("@noesis/domain").CapabilityGateRequest;
        readonly binding: import("@noesis/domain").CapabilityBinding;
      }
    | {
        readonly status: "stale";
        readonly gate: import("@noesis/domain").CapabilityGateRequest;
        readonly binding: import("@noesis/domain").CapabilityBinding;
      }
  >;
  readonly settleGate: (request: {
    readonly gateRequestId: string;
    readonly status: "denied" | "superseded";
    readonly instruction?: string;
  }) => Promise<import("@noesis/domain").CapabilityGateRequest>;
}
