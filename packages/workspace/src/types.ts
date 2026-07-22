import type {
  ActorRef,
  ArtifactFileRef,
  DatabaseRowRef,
  FileRevisionRef,
  WorkspaceStore,
  CapabilityRevisionRef,
  DataSensitivity,
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

export interface JobRecord {
  readonly jobId: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly status: "scheduled" | "running" | "completed" | "failed" | "cancelled" | "budget_exhausted";
  readonly leaseOwner?: string;
  readonly leaseUntil?: string;
  readonly attempt: number;
  readonly budgetRemaining: number;
  readonly createdAt: string;
  readonly updatedAt: string;
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

export interface ActivationPointerRecord {
  readonly pointerId: string;
  readonly capabilityId: string;
  readonly activationId: string;
  readonly capabilityRevision: StoredCapabilityRevisionRef;
  readonly updatedAt: string;
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
  readonly jobs: {
    readonly get: (jobId: string) => Promise<JobRecord | undefined>;
    readonly put: (record: JobRecord) => Promise<DatabaseRowRef>;
  };
  readonly activations: {
    readonly get: (activationId: string) => Promise<ActivationRecord | undefined>;
    readonly put: (record: ActivationRecord) => Promise<void>;
    readonly getPointer: (capabilityId: string) => Promise<ActivationPointerRecord | undefined>;
    readonly putPointer: (record: ActivationPointerRecord) => Promise<DatabaseRowRef>;
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
  readonly close: () => void;
  readonly unsafeDatabasePathForTesting: string;
  readonly getArtifactMetadata: (artifactId: string) => Promise<ArtifactFileRef | undefined>;
}
