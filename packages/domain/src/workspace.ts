import type {
  ActorRef,
  ArtifactFileRef,
  DatabaseRowRef,
  DatabaseTable,
  EvidenceKind,
  EvidenceRef,
  EvidenceRevisionRef,
  EvaluationRecord,
  Experiment,
  ExperimentTrial,
  FeedbackSignal,
  FileRevisionRef,
  PreflightPlan,
  PreflightReport,
} from "./research.ts";

export const PERSISTED_DATA = [
  "session",
  "message",
  "tool_call",
  "job",
  "experiment",
  "experiment_trial",
  "feedback_signal",
  "preflight_plan",
  "preflight_report",
  "evaluation",
  "activation_pointer",
  "definition_current_pointer",
  "search_configuration",
  "activity_provenance",
  "file_revision_metadata",
  "search_index",
  "config_definition",
  "profile_memory_definition",
  "prompt_module_definition",
  "skill_capability_definition",
  "generated_tool_definition",
  "evaluation_definition",
  "recorded_definition_revision",
  "candidate_definition",
  "artifact_content",
  "evaluation_evidence",
  "credential_secret",
] as const;

export type PersistedDatum = (typeof PERSISTED_DATA)[number];

export const PERSISTED_AUTHORITIES = [
  "sqlite_operational",
  "rebuildable_index",
  "editable_workspace_file",
  "byte_snapshot",
  "artifact_file",
  "evidence_revision_file",
  "protected_credential_store",
] as const;

export type PersistedAuthority = (typeof PERSISTED_AUTHORITIES)[number];

export const PERSISTED_AUTHORITY_BY_DATUM = {
  session: "sqlite_operational",
  message: "sqlite_operational",
  tool_call: "sqlite_operational",
  job: "sqlite_operational",
  experiment: "sqlite_operational",
  experiment_trial: "sqlite_operational",
  feedback_signal: "sqlite_operational",
  preflight_plan: "sqlite_operational",
  preflight_report: "sqlite_operational",
  evaluation: "sqlite_operational",
  activation_pointer: "sqlite_operational",
  definition_current_pointer: "sqlite_operational",
  search_configuration: "sqlite_operational",
  activity_provenance: "sqlite_operational",
  file_revision_metadata: "sqlite_operational",
  search_index: "rebuildable_index",
  config_definition: "editable_workspace_file",
  profile_memory_definition: "editable_workspace_file",
  prompt_module_definition: "editable_workspace_file",
  skill_capability_definition: "editable_workspace_file",
  generated_tool_definition: "editable_workspace_file",
  evaluation_definition: "editable_workspace_file",
  recorded_definition_revision: "byte_snapshot",
  candidate_definition: "editable_workspace_file",
  artifact_content: "artifact_file",
  evaluation_evidence: "evidence_revision_file",
  credential_secret: "protected_credential_store",
} as const satisfies Readonly<Record<PersistedDatum, PersistedAuthority>>;

export function declaredAuthorityFor(datum: PersistedDatum): PersistedAuthority {
  return PERSISTED_AUTHORITY_BY_DATUM[datum];
}

export type DataSensitivity = "normal" | "private" | "secret";

export interface DefinitionWriteRequest {
  readonly workingPath: string;
  readonly bytes: Uint8Array;
  readonly actor: ActorRef;
  readonly reason?: string;
  readonly predecessorRevisionId?: string;
  readonly sensitivity?: DataSensitivity;
  readonly provenanceRefs?: readonly EvidenceRef[];
}

export interface EvidenceWriteRequest<Kind extends EvidenceKind = EvidenceKind>
  extends DefinitionWriteRequest {
  readonly evidenceKind: Kind;
  readonly supersedesRevisionId?: string;
}

export interface ArtifactWriteRequest {
  readonly path: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly actor: ActorRef;
  readonly relationshipRefs: readonly (DatabaseRowRef | FileRevisionRef)[];
}

export interface WorkspaceReadPort {
  readonly readDatabaseRow: <Table extends DatabaseTable>(
    ref: DatabaseRowRef<Table>,
  ) => Promise<Readonly<Record<string, unknown>> | undefined>;
  readonly readWorkingFile: (workingPath: string) => Promise<Uint8Array | undefined>;
  readonly readRevision: (ref: FileRevisionRef) => Promise<Uint8Array>;
  readonly readEvidence: <Kind extends EvidenceKind>(ref: EvidenceRevisionRef<Kind>) => Promise<Uint8Array>;
  readonly readArtifact: (ref: ArtifactFileRef) => Promise<Uint8Array>;
}

export interface DefinitionFilePort {
  readonly recordWorkingDefinition: (request: DefinitionWriteRequest) => Promise<FileRevisionRef>;
  readonly recordCandidateDefinition: (request: DefinitionWriteRequest) => Promise<FileRevisionRef>;
}

export interface DefinitionMetadataRecord {
  readonly namespace: string;
  readonly definitionId: string;
  readonly revision: number;
  readonly definitionRevision: FileRevisionRef;
  readonly fileRevisionRow: DatabaseRowRef<"file_revisions">;
  readonly activityRow: DatabaseRowRef<"activity_log">;
  readonly predecessorRevisionId?: string;
}

export interface DefinitionMetadataCommitRequest {
  readonly namespace: string;
  readonly definitionId: string;
  readonly revision: number;
  readonly definitionRevision: FileRevisionRef;
  readonly expectedCurrentRevisionId?: string;
  readonly activity: {
    readonly kind: string;
    readonly actor: ActorRef;
    readonly reason?: string;
  };
}

export type DefinitionMetadataCommitResult =
  | { readonly ok: true; readonly value: DefinitionMetadataRecord }
  | { readonly ok: false; readonly error: { readonly code: "conflict"; readonly message: string } };

/** SQLite owns current pointers and revision metadata; definition bytes remain file-backed. */
export interface DefinitionMetadataPort {
  readonly getCurrent: (
    namespace: string,
    definitionId: string,
  ) => Promise<DefinitionMetadataRecord | undefined>;
  readonly listCurrent: (namespace: string) => Promise<readonly DefinitionMetadataRecord[]>;
  readonly listRevisions: (
    namespace: string,
    definitionId: string,
  ) => Promise<readonly DefinitionMetadataRecord[]>;
}

export interface DefinitionPublicationRequest {
  readonly namespace: string;
  readonly definitionId: string;
  readonly revision: number;
  readonly workingPath: string;
  readonly bytes: Uint8Array;
  readonly expectedCurrentRevisionId?: string;
  readonly sensitivity?: DataSensitivity;
  readonly provenanceRefs?: readonly EvidenceRef[];
  readonly activity: {
    readonly kind: string;
    readonly actor: ActorRef;
    readonly reason?: string;
  };
}

/** Coordinates immutable snapshot registration, pointer CAS, and publication of the winning working bytes. */
export interface DefinitionPublicationPort {
  readonly publish: (request: DefinitionPublicationRequest) => Promise<DefinitionMetadataCommitResult>;
  readonly recoverPending: () => Promise<number>;
  readonly cleanupAbandoned: () => Promise<number>;
}

export interface RevisionSnapshotPort {
  readonly resolveRevision: (revisionId: string) => Promise<FileRevisionRef | undefined>;
  readonly removeUnregisteredSnapshots: () => Promise<number>;
}

export interface EvidenceFilePort {
  readonly appendEvidence: <Kind extends EvidenceKind>(
    request: EvidenceWriteRequest<Kind>,
  ) => Promise<EvidenceRevisionRef<Kind>>;
}

export interface ArtifactFilePort {
  readonly writeArtifact: (request: ArtifactWriteRequest) => Promise<ArtifactFileRef>;
}

export interface ExperimentStorePort {
  readonly getExperiment: (experimentId: string) => Promise<Experiment | undefined>;
  readonly putExperiment: (experiment: Experiment) => Promise<DatabaseRowRef<"experiments">>;
}

export interface ExperimentTrialStorePort {
  readonly getTrial: (trialId: string) => Promise<ExperimentTrial | undefined>;
  readonly listTrials: (experimentId: string) => Promise<readonly ExperimentTrial[]>;
  readonly putTrial: (trial: ExperimentTrial) => Promise<DatabaseRowRef<"experiment_trials">>;
}

export interface PreflightStorePort {
  readonly getPreflightPlan: (planId: string) => Promise<PreflightPlan | undefined>;
  readonly putPreflightPlan: (plan: PreflightPlan) => Promise<DatabaseRowRef<"preflight_plans">>;
  readonly getPreflightReport: (preflightId: string) => Promise<PreflightReport | undefined>;
  readonly putPreflightReport: (report: PreflightReport) => Promise<DatabaseRowRef<"preflight_reports">>;
}

export interface EvaluationStorePort {
  readonly getEvaluation: (evaluationId: string) => Promise<EvaluationRecord | undefined>;
  readonly listEvaluations: (experimentId: string) => Promise<readonly EvaluationRecord[]>;
  readonly putEvaluation: (evaluation: EvaluationRecord) => Promise<DatabaseRowRef<"evaluations">>;
}

export interface FeedbackSignalStorePort {
  readonly getFeedbackSignal: (signalId: string) => Promise<FeedbackSignal | undefined>;
  readonly recordFeedbackSignal: (signal: FeedbackSignal) => Promise<DatabaseRowRef<"feedback_signals">>;
}

export interface ResearchStatePort {
  readonly experiments: ExperimentStorePort;
  readonly trials: ExperimentTrialStorePort;
  readonly preflights: PreflightStorePort;
  readonly evaluations: EvaluationStorePort;
  readonly feedbackSignals: FeedbackSignalStorePort;
}

/**
 * The non-protected persistence surface shared by research packages. Activation and authority mutation
 * deliberately live behind unexported runtime and policy internals.
 */
export interface WorkspaceStore {
  readonly reads: WorkspaceReadPort;
  readonly definitions: DefinitionFilePort;
  readonly definitionMetadata: DefinitionMetadataPort;
  readonly definitionPublications: DefinitionPublicationPort;
  readonly revisions: RevisionSnapshotPort;
  readonly evidence: EvidenceFilePort;
  readonly artifacts: ArtifactFilePort;
  readonly research: ResearchStatePort;
  readonly declaredAuthority: typeof declaredAuthorityFor;
}
