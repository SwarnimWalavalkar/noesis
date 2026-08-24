import type { DatabaseRow } from "./database.ts";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, link, mkdir, open, readdir, readFile, rename, rm, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { ScriptProgramManifestSchema, WorkflowProgramManifestSchema } from "@noesis/agent-types";
import {
  createConditionalObject,
  type ArtifactImportRequest,
  type ActorRef,
  type ArtifactFileRef,
  ArtifactFileRefSchema,
  type ArtifactWriteRequest,
  canonicalJson,
  type DatabaseRowRef,
  type DatabaseTable,
  type DataSensitivity,
  type DefinitionMetadataCommitRequest,
  type DefinitionMetadataCommitResult,
  type DefinitionMetadataPort,
  type DefinitionMetadataRecord,
  type DefinitionPublicationRequest,
  type DefinitionWriteRequest,
  declaredAuthorityFor,
  type EvaluationRecord,
  EvaluationRecordSchema,
  type EvidenceKind,
  type EvidenceRef,
  EvidenceRefSchema,
  type EvidenceRevisionRef,
  type EvidenceWriteRequest,
  type Experiment,
  ExperimentSchema,
  type ExperimentStatus,
  type ExperimentTrial,
  ExperimentTrialSchema,
  type FeedbackSignal,
  FeedbackSignalSchema,
  type FileRevisionRef,
  FileRevisionRefSchema,
  GrantSchema,
  isExperimentTransitionAllowed,
  type LedgerEvent,
  LedgerEventSchema,
  type PreflightPlan,
  PreflightPlanSchema,
  type PreflightReport,
  PreflightReportSchema,
  preflightReportMatchesPlan,
  sameCapabilityRevisionRef,
  sha256,
  type JsonValue,
  JsonValueSchema,
} from "@noesis/domain";
import { z } from "zod";
import { createProtectedActivationStore } from "./activation-store.ts";
import { createWorkspaceAuthorityBoundary } from "./authority-state.ts";
import { createBackup, inspectWorkspaceIntegrity } from "./backup.ts";
import { createCompoundingMeasurementStore } from "./compounding-measurements.ts";
import { createCapabilityLifecycleStore } from "./capability-lifecycle.ts";
import {
  openWorkspaceDatabase,
  optionalString,
  parseJson,
  requiredNumber,
  requiredString,
  type WorkspaceDatabase,
} from "./database.ts";
import {
  decodeCodeExecution,
  decodeExperiment,
  decodeFeedbackSignal,
  decodeFileRevisionRef,
  decodeMessage,
  decodeModelCall,
  decodeOptional,
  decodeOutcome,
  decodeSearchConfiguration,
  decodeSearchDocument,
  decodeSession,
  decodeStored,
  decodeToolCall,
  decodeUserIntent,
  decodeVector,
  decodeWorkflowPhaseRun,
  decodeWorkflowRun,
  JsonRecordSchema,
  SearchConfigurationSchema,
  SensitivitySchema,
} from "./decoders.ts";
import { createProtectedFeedbackStore } from "./feedback-store.ts";
import { importLegacyWorkspace } from "./importer.ts";
import { createDurableJobStore } from "./jobs.ts";
import { createMcpConnectionCycleAllocator } from "./mcp-connection-cycles.ts";
import {
  initializeWorkspaceDirectories,
  pathInside,
  safeRelativePath,
  workspacePaths,
  workspaceRelative,
} from "./paths.ts";
import { createProtectedWorkspaceRuntime, registerWorkspaceRuntimeInternals } from "./protected-runtime.ts";
import type {
  CanonicalSearchSource,
  ClassifyOutcomeRequest,
  CodeExecutionRecord,
  ContextCheckpointRecord,
  MessageRecord,
  ModelCallRecord,
  NoesisWorkspaceStore,
  OperationalCutoverReport,
  OutcomeRecord,
  SearchCandidate,
  SearchConfiguration,
  SearchDocument,
  SearchSourceScope,
  SessionRecord,
  StageDefinitionRequest,
  StagedDefinition,
  ToolCallRecord,
  UserIntentRecord,
  WorkflowPhaseRunRecord,
  WorkflowRunRecord,
  WorkspacePaths,
} from "./types.ts";
import { createProtectedWorkingAdjustmentStore } from "./working-adjustments.ts";
export interface WorkspaceStoreOptions {
  readonly now?: () => string;
  readonly createId?: (prefix: string) => string;
  readonly recoverInterruptedOperations?: boolean;
  readonly runtimeOwnerId?: string;
  readonly afterRuntimeOwnerAcquiredForTesting?: () => void;
  readonly afterDefinitionCommitForTesting?: () => void;
  readonly beforeActivationCommitForTesting?: () => void;
  readonly duringActivationCommitForTesting?: () => void;
  readonly afterActivationCommitForTesting?: () => void;
  readonly beforeOutcomeCommitForTesting?: () => void;
  readonly duringOutcomeCommitForTesting?: () => void;
  readonly afterOutcomeCommitForTesting?: () => void;
}
const ActorSchema = z.strictObject({
  actorId: z.string().min(1),
  kind: z.enum(["user", "noesis", "external_system", "system"]),
});
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const SearchSourceScopeSchema = z.enum([
  "session_or_outcome",
  "corrected_outcome",
  "completed_experiment",
]) satisfies z.ZodType<SearchSourceScope>;
const ClassifyOutcomeRequestSchema: z.ZodType<ClassifyOutcomeRequest> = z.strictObject({
  outcomeId: z.string().min(1),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  classification: z.enum(["correction", "preference", "other"]),
  reason: z.string().min(1),
});
const OutcomeSemanticObservationSchema = z.strictObject({
  kind: z.enum(["correction", "preference", "other"]),
  reason: z.string().min(1),
});
// BOUNDARY: Operational identities canonicalize arbitrary adapter payloads into durable JSON.
const persistedJsonValue = (value: unknown): JsonValue | undefined => {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? undefined : JsonValueSchema.parse(JSON.parse(encoded));
};
const immutableToolCallIdentity = (
  record: ToolCallRecord,
  sequence: number,
  timelineSequence = record.timelineSequence,
) => ({
  toolCallId: record.toolCallId,
  sessionId: record.sessionId,
  turnId: record.turnId ?? null,
  messageId: record.messageId ?? null,
  parentToolCallId: record.parentToolCallId ?? null,
  toolName: record.toolName,
  request: persistedJsonValue(record.request),
  sequence,
  timelineSequence: timelineSequence ?? null,
  sensitivity: record.sensitivity,
  createdAt: record.createdAt,
});
const persistedToolCall = (
  record: ToolCallRecord,
  sequence: number,
  timelineSequence = record.timelineSequence,
) => ({
  ...immutableToolCallIdentity(record, sequence, timelineSequence),
  executionId: record.executionId ?? null,
  update: persistedJsonValue(record.update),
  response: persistedJsonValue(record.response),
  status: record.status,
  completedAt: record.completedAt ?? null,
});
const LegacyImportReportSchema = z.strictObject({
  sourceId: z.string().min(1),
  alreadyImported: z.boolean(),
  sessions: z.number().int().nonnegative(),
  messages: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  outcomes: z.number().int().nonnegative(),
  jobs: z.number().int().nonnegative(),
  definitions: z.number().int().nonnegative(),
  artifacts: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
});
const databaseRef = <Table extends DatabaseTable>(table: Table, rowId: string): DatabaseRowRef<Table> => ({
  kind: "database_row",
  table,
  rowId,
});
function evidenceReferenceIdentity(reference: EvidenceRef): string {
  switch (reference.kind) {
    case "database_row":
      return `${reference.kind}:${reference.table}:${reference.rowId}`;
    case "file_revision":
    case "evidence_revision":
      return `${reference.kind}:${reference.revisionId}`;
    case "artifact_file":
      return `${reference.kind}:${reference.artifactId}`;
  }
}
function mergeEvidenceReferences(
  existing: readonly EvidenceRef[],
  incoming: readonly EvidenceRef[],
): readonly EvidenceRef[] {
  const merged = new Map<string, EvidenceRef>();
  for (const reference of [...existing, ...incoming]) {
    merged.set(evidenceReferenceIdentity(reference), reference);
  }
  return [...merged.values()];
}
const PRIMARY_KEY_BY_TABLE = {
  sessions: "session_id",
  messages: "message_id",
  tool_calls: "tool_call_id",
  outcomes: "outcome_id",
  jobs: "job_id",
  working_adjustments: "adjustment_id",
  experiments: "experiment_id",
  experiment_trials: "trial_id",
  feedback_signals: "signal_id",
  experiment_observations: "observation_id",
  experiment_research_runs: "run_id",
  experiment_outcomes: "operation_id",
  successor_lineage_inputs: "input_id",
  preflight_plans: "plan_id",
  preflight_reports: "preflight_id",
  evaluations: "evaluation_id",
  activation_pointers: "pointer_id",
  search_configuration: "configuration_id",
  activity_log: "activity_id",
  file_revisions: "revision_id",
  capabilities: "capability_id",
  capability_revisions: "capability_revision_id",
  capability_bindings: "capability_id",
  capability_feedback: "feedback_id",
  capability_gate_requests: "gate_request_id",
} satisfies Readonly<Record<DatabaseTable, string>>;
function permitsTransition(
  transitions: Readonly<Record<string, readonly string[]>>,
  from: string,
  to: string,
): boolean {
  return transitions[from]?.includes(to) ?? false;
}
function assertStoredReference(
  database: DatabaseSync,
  ref: EvidenceRef | DatabaseRowRef | FileRevisionRef,
): void {
  if (ref.kind === "database_row") {
    const key = PRIMARY_KEY_BY_TABLE[ref.table];
    if (database.prepare(`SELECT 1 FROM ${ref.table} WHERE ${key} = ?`).get(ref.rowId) === undefined)
      throw new Error(`Missing database reference ${ref.table}/${ref.rowId}`);
    return;
  }
  if (ref.kind === "artifact_file") {
    const row = database
      .prepare("SELECT path, media_type FROM artifacts WHERE artifact_id = ?")
      .get(ref.artifactId);
    if (
      row === undefined ||
      requiredString(row, "path") !== ref.path ||
      requiredString(row, "media_type") !== ref.mediaType
    )
      throw new Error(`Missing or mismatched artifact reference ${ref.artifactId}`);
    return;
  }
  const row = database
    .prepare(
      "SELECT revision_kind, working_path, snapshot_path, content_digest, evidence_kind FROM file_revisions WHERE revision_id = ?",
    )
    .get(ref.revisionId);
  if (
    row === undefined ||
    requiredString(row, "working_path") !== ref.workingPath ||
    requiredString(row, "snapshot_path") !== ref.snapshotPath ||
    requiredString(row, "content_digest") !== ref.contentDigest
  )
    throw new Error(`Missing or mismatched file revision reference ${ref.revisionId}`);
  if (
    ref.kind === "evidence_revision" &&
    (requiredString(row, "revision_kind") !== "evidence" ||
      requiredString(row, "evidence_kind") !== ref.evidenceKind)
  )
    throw new Error(`Mismatched evidence revision reference ${ref.revisionId}`);
  if (ref.kind === "file_revision" && requiredString(row, "revision_kind") === "evidence")
    throw new Error(`Definition reference ${ref.revisionId} points to evidence`);
}
export async function createWorkspaceStore(
  root: string,
  options: WorkspaceStoreOptions = {},
): Promise<NoesisWorkspaceStore> {
  const paths = workspacePaths(root);
  await initializeWorkspaceDirectories(paths);
  const now = options.now ?? (() => new Date().toISOString());
  const createId = options.createId ?? ((prefix: string) => `${prefix}_${randomUUID()}`);
  const database = await openWorkspaceDatabase(paths, now);
  const db = database.connection;
  const authority = createWorkspaceAuthorityBoundary(database, now);
  const mcpConnectionCycles = createMcpConnectionCycleAllocator(database, now);
  const capabilities = createCapabilityLifecycleStore({
    database,
    now,
    assertStoredReference: (reference) => assertStoredReference(db, reference),
  });
  const runtimeOwnerId = options.recoverInterruptedOperations
    ? (options.runtimeOwnerId ?? createId("runtime_owner"))
    : undefined;
  let runtimeOwnerAcquired = false;
  const releaseRuntimeOwner = (): void => {
    if (!runtimeOwnerId || !runtimeOwnerAcquired) return;
    database.transaction(() => {
      db.prepare("DELETE FROM runtime_owner WHERE singleton = 1 AND owner_id = ? AND pid = ?").run(
        runtimeOwnerId,
        process.pid,
      );
    });
    runtimeOwnerAcquired = false;
  };
  const acquireRuntimeOwner = (): void => {
    if (runtimeOwnerId) {
      database.transaction(() => {
        const current = db.prepare("SELECT owner_id, pid FROM runtime_owner WHERE singleton = 1").get();
        if (current !== undefined) {
          const ownerId = requiredString(current, "owner_id");
          const pid = requiredNumber(current, "pid");
          let live = true;
          try {
            process.kill(pid, 0);
          } catch (error) {
            live = !(error instanceof Error && "code" in error && error["code"] === "ESRCH");
          }
          if (live)
            throw new Error(`Workspace already has a live runtime owner (${ownerId}, pid ${String(pid)})`);
        }
        db.prepare(`INSERT INTO runtime_owner(singleton, owner_id, pid, acquired_at)
           VALUES (1, ?, ?, ?)
           ON CONFLICT(singleton) DO UPDATE SET
             owner_id = excluded.owner_id,
             pid = excluded.pid,
             acquired_at = excluded.acquired_at`).run(runtimeOwnerId, process.pid, now());
      });
      runtimeOwnerAcquired = true;
    }
  };
  // BOUNDARY: Activity callers supply JSON-serializable provenance which is persisted atomically here.
  const recordActivity = (
    actor: ActorRef,
    activityKind: string,
    subjectKind: string,
    subjectId: string,
    references: unknown = [],
  ): DatabaseRowRef<"activity_log"> => {
    ActorSchema.parse(actor);
    const activityId = createId("activity");
    db.prepare(`INSERT INTO activity_log(
        activity_id, actor_id, actor_kind, activity_kind, subject_kind, subject_id, references_json, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      activityId,
      actor.actorId,
      actor.kind,
      activityKind,
      subjectKind,
      subjectId,
      JSON.stringify(references),
      now(),
    );
    return databaseRef("activity_log", activityId);
  };
  const systemActor: ActorRef = { actorId: "workspace-store", kind: "system" };
  const recoverInterruptedRuntimeSessions = (interruptedAt: string): number =>
    database.transaction(() => {
      const runningTurns = db
        .prepare(`SELECT turn_id, session_id
           FROM foreground_turns
           WHERE status = 'running'
           ORDER BY admitted_at, turn_id`)
        .all();
      for (const row of runningTurns) {
        const turnId = requiredString(row, "turn_id");
        const sessionId = requiredString(row, "session_id");
        const runningCalls = db
          .prepare(`SELECT tool_call_id
             FROM tool_calls
             WHERE turn_id = ? AND status IN ('requested', 'running')
             ORDER BY action_sequence, tool_call_id`)
          .all(turnId);
        for (const call of runningCalls) {
          const toolCallId = requiredString(call, "tool_call_id");
          db.prepare(`UPDATE tool_calls
             SET status = 'failed',
                 response_json = '{"error":"Runtime exited before turn settled","reason":"interrupted"}',
                 completed_at = ?
             WHERE tool_call_id = ? AND status IN ('requested', 'running')`).run(interruptedAt, toolCallId);
          recordActivity(systemActor, "tool_call.interrupted", "tool_call", toolCallId, [
            { sessionId, turnId, reason: "interrupted" },
          ]);
        }
        db.prepare(`UPDATE foreground_turns
           SET status = 'aborted', settled_at = ?
           WHERE turn_id = ? AND status = 'running'`).run(interruptedAt, turnId);
        recordActivity(systemActor, "foreground_turn.interrupted", "foreground_turn", turnId, [
          {
            sessionId,
            reason: "interrupted",
            toolCallIds: runningCalls.map((call) => requiredString(call, "tool_call_id")),
          },
        ]);
      }
      const runningSessions = db
        .prepare(`SELECT session_id
           FROM sessions
           WHERE status = 'running'
           ORDER BY created_at, session_id`)
        .all();
      for (const row of runningSessions) {
        const sessionId = requiredString(row, "session_id");
        const interruptedTurnIds = runningTurns
          .filter((turn) => requiredString(turn, "session_id") === sessionId)
          .map((turn) => requiredString(turn, "turn_id"));
        db.prepare(`UPDATE sessions
           SET status = 'aborted', updated_at = ?
           WHERE session_id = ? AND status = 'running'`).run(interruptedAt, sessionId);
        recordActivity(systemActor, "session.interrupted", "session", sessionId, [
          {
            reason: "runtime_owner_recovery",
            interruptedTurnIds,
          },
        ]);
      }
      return runningSessions.length;
    });
  const pathsForDefinition = (
    workingPath: string,
    forcedArea?: "candidate" | "active",
  ): {
    readonly absolute: string;
    readonly stored: string;
  } => {
    let requested = safeRelativePath(workingPath);
    if (requested.startsWith(`definitions${join("", "/")}`))
      requested = requested.slice("definitions/".length);
    if (forcedArea) {
      const areaPrefix = `${forcedArea === "candidate" ? "candidates" : "active"}/`;
      if (requested.startsWith(areaPrefix)) requested = requested.slice(areaPrefix.length);
      requested = join(forcedArea === "candidate" ? "candidates" : "active", requested);
    }
    const first = requested.split(/[\\/]/u)[0];
    const allowed = new Set([
      "config",
      "profile-memory",
      "prompts",
      "skills",
      "capabilities",
      "tools",
      "programs",
      "evals",
      "candidates",
      "active",
    ]);
    if (!first || !allowed.has(first))
      throw new Error(`Definition path must use a canonical definition directory: ${workingPath}`);
    const absolute = pathInside(paths.definitions, requested);
    return { absolute, stored: workspaceRelative(paths, absolute) };
  };
  const persistAtomically = async (path: string, bytes: Uint8Array): Promise<void> => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, path);
      const directory = await open(dirname(path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await unlink(temporary).catch(ignoreMissing);
    }
  };
  const inspectFile = async (
    path: string,
  ): Promise<{ readonly byteLength: number; readonly contentDigest: string }> => {
    const hash = createHash("sha256");
    let byteLength = 0;
    for await (const chunk of createReadStream(path)) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(bytes);
      byteLength += bytes.byteLength;
    }
    return Object.freeze({ byteLength, contentDigest: hash.digest("hex") });
  };
  const persistFileAtomically = async (
    path: string,
    sourcePath: string,
  ): Promise<{ readonly byteLength: number; readonly contentDigest: string }> => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await copyFile(sourcePath, temporary);
      const inspected = await inspectFile(temporary);
      try {
        const existing = await inspectFile(path);
        if (existing.contentDigest !== inspected.contentDigest)
          throw new Error(`Artifact path already contains different bytes: ${path}`);
        return inspected;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      const handle = await open(temporary, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(temporary, path);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        const existing = await inspectFile(path);
        if (existing.contentDigest !== inspected.contentDigest)
          throw new Error(`Artifact path already contains different bytes: ${path}`);
        return existing;
      }
      const directory = await open(dirname(path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      return inspected;
    } finally {
      await unlink(temporary).catch(ignoreMissing);
    }
  };
  const latestRevisionFor = (workingPath: string): FileRevisionRef | undefined => {
    const row = db
      .prepare(`SELECT revision_id, working_path, snapshot_path, content_digest
         FROM file_revisions WHERE working_path = ? ORDER BY recorded_at DESC, revision_id DESC LIMIT 1`)
      .get(workingPath);
    return row === undefined ? undefined : decodeFileRevisionRef(row);
  };
  const insertRevision = (
    request: {
      readonly revisionId: string;
      readonly revisionKind: "definition" | "candidate" | "active" | "evidence";
      readonly workingPath: string;
      readonly snapshotPath: string;
      readonly contentDigest: string;
      readonly actor: ActorRef;
      readonly reason?: string;
      readonly predecessorRevisionId?: string;
      readonly evidenceKind?: EvidenceRevisionRef["evidenceKind"];
      readonly supersedesRevisionId?: string;
      readonly sensitivity: DataSensitivity;
      readonly provenanceRefs: readonly EvidenceRef[];
    },
    stageId?: string,
  ): void => {
    db.prepare(`INSERT INTO file_revisions(
        revision_id, revision_kind, working_path, snapshot_path, content_digest,
        predecessor_revision_id, actor_id, actor_kind, reason, recorded_at,
        evidence_kind, supersedes_revision_id, sensitivity, provenance_refs_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      request.revisionId,
      request.revisionKind,
      request.workingPath,
      request.snapshotPath,
      request.contentDigest,
      request.predecessorRevisionId ?? null,
      request.actor.actorId,
      request.actor.kind,
      request.reason ?? null,
      now(),
      request.evidenceKind ?? null,
      request.supersedesRevisionId ?? null,
      request.sensitivity,
      JSON.stringify(request.provenanceRefs),
    );
    if (stageId)
      db.prepare("UPDATE staged_definitions SET registered_revision_id = ? WHERE stage_id = ?").run(
        request.revisionId,
        stageId,
      );
    recordActivity(
      request.actor,
      request.revisionKind === "evidence" ? "evidence.appended" : "definition.revision_recorded",
      "file_revision",
      request.revisionId,
      request.predecessorRevisionId ? [{ revisionId: request.predecessorRevisionId }] : [],
    );
  };
  const recordDefinitionBytes = async (
    request: DefinitionWriteRequest,
    revisionKind: "definition" | "candidate" | "active",
    forcedArea?: "candidate" | "active",
    writeWorkingFile = true,
    stageId?: string,
  ): Promise<FileRevisionRef> => {
    ActorSchema.parse(request.actor);
    for (const ref of request.provenanceRefs ?? []) assertStoredReference(db, ref);
    const target = pathsForDefinition(request.workingPath, forcedArea);
    const bytes = Uint8Array.from(request.bytes);
    const contentDigest = sha256(bytes);
    const latest = latestRevisionFor(target.stored);
    if (latest?.contentDigest === contentDigest && stageId === undefined) return latest;
    if (writeWorkingFile) await persistAtomically(target.absolute, bytes);
    const revisionId = createId("revision");
    const snapshotAbsolute = join(paths.revisions, revisionId, basename(target.absolute) || "content");
    await persistAtomically(snapshotAbsolute, bytes);
    const snapshotPath = workspaceRelative(paths, snapshotAbsolute);
    const predecessorRevisionId = request.predecessorRevisionId ?? latest?.revisionId;
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    database.transaction(() =>
      insertRevision(
        createConditionalObject({
          revisionId,
          revisionKind,
          workingPath: target.stored,
          snapshotPath,
          contentDigest,
          actor: request.actor,
        } as const)
          .addOptional(!(request.reason === undefined) ? { reason: request.reason } : undefined)
          .addOptional(!(predecessorRevisionId === undefined) ? { predecessorRevisionId } : undefined)
          .add({
            sensitivity: request.sensitivity ?? "normal",
            provenanceRefs: request.provenanceRefs ?? [],
          } as const)
          .finish(),
        stageId,
      ),
    );
    return { kind: "file_revision", revisionId, workingPath: target.stored, snapshotPath, contentDigest };
  };
  const recordDirectEdit = async (
    workingPath: string,
    actor: ActorRef,
    reason?: string,
  ): Promise<FileRevisionRef> => {
    const target = pathsForDefinition(workingPath);
    const bytes = await readFile(target.absolute);
    const previous = db
      .prepare(`SELECT sensitivity, provenance_refs_json FROM file_revisions
         WHERE working_path = ? ORDER BY recorded_at DESC, revision_id DESC LIMIT 1`)
      .get(target.stored);
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    return await recordDefinitionBytes(
      createConditionalObject({
        workingPath: target.stored,
        bytes,
        actor,
      } as const)
        .addOptional(!(reason === undefined) ? { reason } : undefined)
        .add({
          sensitivity:
            previous === undefined
              ? "normal"
              : z.enum(["normal", "private", "secret"]).parse(requiredString(previous, "sensitivity")),
          provenanceRefs:
            previous === undefined
              ? []
              : z.array(EvidenceRefSchema).parse(parseJson(requiredString(previous, "provenance_refs_json"))),
        } as const)
        .finish(),
      target.stored.startsWith("definitions/candidates/")
        ? "candidate"
        : target.stored.startsWith("definitions/active/")
          ? "active"
          : "definition",
      undefined,
      false,
    );
  };
  const appendEvidence = async <Kind extends EvidenceKind>(
    request: EvidenceWriteRequest<Kind>,
  ): Promise<EvidenceRevisionRef<Kind>> => {
    ActorSchema.parse(request.actor);
    for (const ref of request.provenanceRefs ?? []) assertStoredReference(db, ref);
    for (const revisionId of [request.predecessorRevisionId, request.supersedesRevisionId]) {
      if (revisionId === undefined) continue;
      const predecessor = db
        .prepare("SELECT revision_kind FROM file_revisions WHERE revision_id = ?")
        .get(revisionId);
      if (predecessor === undefined || requiredString(predecessor, "revision_kind") !== "evidence")
        throw new Error(`Evidence revision ${revisionId} is missing or is not evidence`);
    }
    const logicalPath = safeRelativePath(request.workingPath);
    const bytes = Uint8Array.from(request.bytes);
    const revisionId = createId("evidence");
    const evidenceAbsolute = join(paths.evidence, logicalPath, revisionId, "content");
    await persistAtomically(evidenceAbsolute, bytes);
    const snapshotPath = workspaceRelative(paths, evidenceAbsolute);
    const workingPath = snapshotPath;
    const contentDigest = sha256(bytes);
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    database.transaction(() =>
      insertRevision(
        createConditionalObject({
          revisionId,
          revisionKind: "evidence",
          workingPath,
          snapshotPath,
          contentDigest,
          actor: request.actor,
        } as const)
          .addOptional(!(request.reason === undefined) ? { reason: request.reason } : undefined)
          .addOptional(
            !(request.predecessorRevisionId === undefined)
              ? {
                  predecessorRevisionId: request.predecessorRevisionId,
                }
              : undefined,
          )
          .add({
            evidenceKind: request.evidenceKind,
          } as const)
          .addOptional(
            !(request.supersedesRevisionId === undefined)
              ? {
                  supersedesRevisionId: request.supersedesRevisionId,
                }
              : undefined,
          )
          .add({
            sensitivity: request.sensitivity ?? "private",
            provenanceRefs: request.provenanceRefs ?? [],
          } as const)
          .finish(),
      ),
    );
    return {
      kind: "evidence_revision",
      revisionId,
      workingPath,
      snapshotPath,
      contentDigest,
      evidenceKind: request.evidenceKind,
    };
  };
  const recordArtifact = (
    request: Pick<ArtifactWriteRequest, "path" | "mediaType" | "actor" | "relationshipRefs">,
    storedPath: string,
    byteLength: number,
    contentDigest: string,
  ): ArtifactFileRef => {
    const existingArtifact = db
      .prepare(`SELECT artifact_id, media_type, content_digest, actor_id, actor_kind,
          relationship_refs_json FROM artifacts WHERE path = ?`)
      .get(storedPath);
    if (existingArtifact !== undefined) {
      if (
        requiredString(existingArtifact, "media_type") !== request.mediaType ||
        requiredString(existingArtifact, "content_digest") !== contentDigest ||
        requiredString(existingArtifact, "actor_id") !== request.actor.actorId ||
        requiredString(existingArtifact, "actor_kind") !== request.actor.kind ||
        requiredString(existingArtifact, "relationship_refs_json") !==
          JSON.stringify(request.relationshipRefs)
      )
        throw new Error(`Artifact path already belongs to different metadata: ${request.path}`);
      return {
        kind: "artifact_file",
        artifactId: requiredString(existingArtifact, "artifact_id"),
        path: storedPath,
        mediaType: request.mediaType,
      };
    }
    const artifactId = createId("artifact");
    database.transaction(() => {
      db.prepare(`INSERT INTO artifacts(
          artifact_id, path, media_type, byte_length, content_digest, actor_id, actor_kind,
          relationship_refs_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        artifactId,
        storedPath,
        request.mediaType,
        byteLength,
        contentDigest,
        request.actor.actorId,
        request.actor.kind,
        JSON.stringify(request.relationshipRefs),
        now(),
      );
      recordActivity(request.actor, "artifact.recorded", "artifact", artifactId, request.relationshipRefs);
    });
    return { kind: "artifact_file", artifactId, path: storedPath, mediaType: request.mediaType };
  };
  const writeArtifact = async (request: ArtifactWriteRequest): Promise<ArtifactFileRef> => {
    ActorSchema.parse(request.actor);
    for (const ref of request.relationshipRefs) assertStoredReference(db, ref);
    const artifactAbsolute = pathInside(paths.artifacts, request.path);
    const storedPath = workspaceRelative(paths, artifactAbsolute);
    const bytes = Uint8Array.from(request.bytes);
    const contentDigest = sha256(bytes);
    try {
      const existing = await readFile(artifactAbsolute);
      if (sha256(existing) !== contentDigest)
        throw new Error(`Artifact path already contains different bytes: ${request.path}`);
    } catch (error) {
      if (!isMissing(error)) throw error;
      await persistAtomically(artifactAbsolute, bytes);
    }
    return recordArtifact(request, storedPath, bytes.length, contentDigest);
  };
  const importArtifact = async (request: ArtifactImportRequest): Promise<ArtifactFileRef> => {
    ActorSchema.parse(request.actor);
    for (const ref of request.relationshipRefs) assertStoredReference(db, ref);
    const artifactAbsolute = pathInside(paths.artifacts, request.path);
    const storedPath = workspaceRelative(paths, artifactAbsolute);
    const inspected = await persistFileAtomically(artifactAbsolute, request.sourcePath);
    return recordArtifact(request, storedPath, inspected.byteLength, inspected.contentDigest);
  };
  const readVerifiedFile = async (storedPath: string, expectedDigest?: string): Promise<Uint8Array> => {
    const bytes = await readFile(pathInside(paths.root, storedPath));
    if (expectedDigest && sha256(bytes) !== expectedDigest)
      throw new Error(`Immutable file digest mismatch: ${storedPath}`);
    return bytes;
  };
  const normalizeActiveWorkingPath = (workingPath: string): string =>
    pathsForDefinition(workingPath, "active").stored;
  const outcomePublicationDirectory = (operationId: string): string =>
    join(paths.staging, "outcome-publications", sha256(operationId));
  const stageActiveRevision = async (
    operationId: string,
    publicationKey: string,
    sourceRevision: FileRevisionRef,
  ): Promise<{
    readonly workingPath: string;
    readonly stagedPath: string;
    readonly contentDigest: string;
  }> => {
    assertStoredReference(db, sourceRevision);
    const bytes = await readVerifiedFile(sourceRevision.snapshotPath, sourceRevision.contentDigest);
    const target = pathsForDefinition(sourceRevision.workingPath, "active");
    const stagedAbsolute = join(outcomePublicationDirectory(operationId), sha256(publicationKey), "content");
    await persistAtomically(stagedAbsolute, bytes);
    return Object.freeze({
      workingPath: target.stored,
      stagedPath: workspaceRelative(paths, stagedAbsolute),
      contentDigest: sourceRevision.contentDigest,
    });
  };
  const publishStagedActiveRevision = async (publication: {
    readonly workingPath: string;
    readonly stagedPath: string;
    readonly contentDigest: string;
    readonly sourceRevision: FileRevisionRef;
  }): Promise<void> => {
    let bytes: Uint8Array;
    try {
      bytes = await readVerifiedFile(publication.stagedPath, publication.contentDigest);
    } catch (error) {
      if (!isMissing(error)) throw error;
      bytes = await readVerifiedFile(
        publication.sourceRevision.snapshotPath,
        publication.sourceRevision.contentDigest,
      );
    }
    await persistAtomically(pathsForDefinition(publication.workingPath, "active").absolute, bytes);
  };
  const deleteActiveDefinition = async (workingPath: string): Promise<void> => {
    await unlink(pathsForDefinition(workingPath, "active").absolute).catch(ignoreMissing);
  };
  const cleanupOutcomePublicationStage = async (operationId: string): Promise<void> => {
    await rm(outcomePublicationDirectory(operationId), { recursive: true, force: true });
  };
  const resolveRevision = async (revisionId: string): Promise<FileRevisionRef | undefined> => {
    const row = db
      .prepare(`SELECT revision_id, working_path, snapshot_path, content_digest
         FROM file_revisions WHERE revision_id = ? AND revision_kind != 'evidence'`)
      .get(revisionId);
    return row === undefined ? undefined : decodeFileRevisionRef(row);
  };
  const stageDefinition = async (request: StageDefinitionRequest): Promise<StagedDefinition> => {
    ActorSchema.parse(request.actor);
    const relativePath = safeRelativePath(request.relativePath);
    const stageId = createId("stage");
    const stagedAbsolute = join(paths.staging, stageId, relativePath);
    const bytes = Uint8Array.from(request.bytes);
    await persistAtomically(stagedAbsolute, bytes);
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    const staged: StagedDefinition = createConditionalObject({
      stageId,
      targetArea: request.targetArea,
      relativePath,
      stagedPath: workspaceRelative(paths, stagedAbsolute),
      contentDigest: sha256(bytes),
      actor: request.actor,
    } as const)
      .addOptional(!(request.reason === undefined) ? { reason: request.reason } : undefined)
      .add({
        createdAt: now(),
      } as const)
      .finish();
    database.transaction(() => {
      db.prepare(`INSERT INTO staged_definitions(
          stage_id, target_area, relative_path, staged_path, content_digest,
          actor_id, actor_kind, reason, created_at, registered_revision_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`).run(
        staged.stageId,
        staged.targetArea,
        staged.relativePath,
        staged.stagedPath,
        staged.contentDigest,
        staged.actor.actorId,
        staged.actor.kind,
        staged.reason ?? null,
        staged.createdAt,
      );
      recordActivity(staged.actor, "definition.staged", "staged_definition", stageId);
    });
    return staged;
  };
  const registerStagedDefinition = async (stageId: string): Promise<FileRevisionRef> => {
    const row = db.prepare("SELECT * FROM staged_definitions WHERE stage_id = ?").get(stageId);
    if (row === undefined) throw new Error(`Unknown staged definition ${stageId}`);
    const registered = optionalString(row, "registered_revision_id");
    if (registered) {
      const existing = await resolveRevision(registered);
      if (!existing)
        throw new Error(`Staged definition ${stageId} references missing revision ${registered}`);
      return existing;
    }
    const targetArea = requiredString(row, "target_area");
    if (targetArea !== "candidate" && targetArea !== "active")
      throw new Error(`Invalid staged target area ${targetArea}`);
    const actor = ActorSchema.parse({
      actorId: requiredString(row, "actor_id"),
      kind: requiredString(row, "actor_kind"),
    });
    const bytes = await readVerifiedFile(
      requiredString(row, "staged_path"),
      requiredString(row, "content_digest"),
    );
    const storedReason = optionalString(row, "reason");
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    return await recordDefinitionBytes(
      createConditionalObject({
        workingPath: requiredString(row, "relative_path"),
        bytes,
        actor,
      } as const)
        .addOptional(!(storedReason === undefined) ? { reason: storedReason } : undefined)
        .finish(),
      targetArea,
      targetArea,
      true,
      stageId,
    );
  };
  const cleanupStagedDefinitions = async (): Promise<number> => {
    const rows = db
      .prepare("SELECT stage_id, staged_path FROM staged_definitions WHERE registered_revision_id IS NULL")
      .all();
    let removed = 0;
    for (const row of rows) {
      await rm(join(paths.staging, requiredString(row, "stage_id")), {
        recursive: true,
        force: true,
      });
      database.transaction(() => {
        db.prepare(
          "DELETE FROM staged_definitions WHERE stage_id = ? AND registered_revision_id IS NULL",
        ).run(requiredString(row, "stage_id"));
      });
      removed += 1;
    }
    return removed;
  };
  const removeUnregisteredSnapshots = async (): Promise<number> => {
    const registered = new Set(
      db
        .prepare("SELECT snapshot_path FROM file_revisions WHERE snapshot_path LIKE 'revisions/%'")
        .all()
        .map((row) => requiredString(row, "snapshot_path").split(/[\\/]/u)[1])
        .filter((value): value is string => value !== undefined),
    );
    let removed = 0;
    for (const entry of await readdir(paths.revisions, { withFileTypes: true })) {
      if (entry.isDirectory() && !registered.has(entry.name)) {
        await rm(join(paths.revisions, entry.name), { recursive: true, force: true });
        removed += 1;
      }
    }
    return removed;
  };
  const research = createResearchRepositories(database, recordActivity, now);
  const operational = createOperationalRepositories(database, recordActivity, readVerifiedFile);
  const jobs = createDurableJobStore(database, recordActivity, (reference) =>
    assertStoredReference(db, reference),
  );
  const protectedWorkingAdjustments = createProtectedWorkingAdjustmentStore({
    database,
    now,
    assertStoredReference: (reference) => assertStoredReference(db, reference),
    recordActivity,
  });
  const compoundingMeasurements = createCompoundingMeasurementStore(database, now);
  const definitionMetadataRepository = createDefinitionMetadataRepository(database, recordActivity, now);
  const definitionMetadata: DefinitionMetadataPort = Object.freeze({
    getCurrent: definitionMetadataRepository.getCurrent,
    listCurrent: definitionMetadataRepository.listCurrent,
    listRevisions: definitionMetadataRepository.listRevisions,
  });
  const cleanupPublication = async (publicationId: string, revisionId: string): Promise<void> => {
    const row = db
      .prepare("SELECT staged_path, snapshot_path FROM definition_publications WHERE publication_id = ?")
      .get(publicationId);
    if (row === undefined) return;
    const removed = database.transaction(() => {
      const current = db
        .prepare("SELECT 1 FROM definition_current_pointers WHERE definition_revision_id = ?")
        .get(revisionId);
      if (current !== undefined) return false;
      db.prepare("DELETE FROM definition_publications WHERE publication_id = ?").run(publicationId);
      db.prepare("DELETE FROM activity_log WHERE subject_kind = 'file_revision' AND subject_id = ?").run(
        revisionId,
      );
      db.prepare("DELETE FROM file_revisions WHERE revision_id = ?").run(revisionId);
      return true;
    });
    if (!removed) return;
    await rm(dirname(pathInside(paths.root, requiredString(row, "staged_path"))), {
      recursive: true,
      force: true,
    });
    await rm(dirname(pathInside(paths.root, requiredString(row, "snapshot_path"))), {
      recursive: true,
      force: true,
    });
  };
  const recoverPendingPublications = async (): Promise<number> => {
    const rows = db
      .prepare(`SELECT publications.* FROM definition_publications AS publications
         JOIN definition_current_pointers AS current
           ON current.namespace = publications.namespace
          AND current.definition_id = publications.definition_id
          AND current.definition_revision_id = publications.revision_id
         WHERE publications.status != 'published'`)
      .all();
    let recovered = 0;
    for (const row of rows) {
      const snapshotPath = requiredString(row, "snapshot_path");
      const digest = requiredString(row, "content_digest");
      const bytes = await readVerifiedFile(snapshotPath, digest);
      await persistAtomically(pathsForDefinition(requiredString(row, "working_path")).absolute, bytes);
      database.transaction(() => {
        db.prepare(
          "UPDATE definition_publications SET status = 'published', published_at = ? WHERE publication_id = ?",
        ).run(now(), requiredString(row, "publication_id"));
      });
      await rm(dirname(pathInside(paths.root, requiredString(row, "staged_path"))), {
        recursive: true,
        force: true,
      });
      recovered += 1;
    }
    return recovered;
  };
  const cleanupAbandonedPublications = async (): Promise<number> => {
    const rows = db
      .prepare(`SELECT publication_id, revision_id FROM definition_publications
         WHERE status IN ('staged', 'rejected')
           AND revision_id NOT IN (SELECT definition_revision_id FROM definition_current_pointers)`)
      .all();
    for (const row of rows)
      await cleanupPublication(requiredString(row, "publication_id"), requiredString(row, "revision_id"));
    return rows.length;
  };
  const publishDefinition = async (
    request: DefinitionPublicationRequest,
  ): Promise<DefinitionMetadataCommitResult> => {
    ActorSchema.parse(request.activity.actor);
    for (const ref of request.provenanceRefs ?? []) assertStoredReference(db, ref);
    const target = pathsForDefinition(request.workingPath);
    const bytes = Uint8Array.from(request.bytes);
    const contentDigest = sha256(bytes);
    const publicationId = createId("publication");
    const revisionId = createId("revision");
    const stagedAbsolute = join(paths.staging, "publications", publicationId, "content");
    const snapshotAbsolute = join(paths.revisions, revisionId, basename(target.absolute) || "content");
    try {
      await persistAtomically(stagedAbsolute, bytes);
      await persistAtomically(snapshotAbsolute, bytes);
    } catch (error) {
      await rm(dirname(stagedAbsolute), { recursive: true, force: true });
      await rm(dirname(snapshotAbsolute), { recursive: true, force: true });
      throw error;
    }
    const stagedPath = workspaceRelative(paths, stagedAbsolute);
    const snapshotPath = workspaceRelative(paths, snapshotAbsolute);
    const definitionRevision: FileRevisionRef = {
      kind: "file_revision",
      revisionId,
      workingPath: target.stored,
      snapshotPath,
      contentDigest,
    };
    try {
      database.transaction(() => {
        db.prepare(`INSERT INTO definition_publications(
          publication_id, namespace, definition_id, revision, revision_id, staged_path,
          working_path, snapshot_path, content_digest, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'staged', ?)`).run(
          publicationId,
          request.namespace,
          request.definitionId,
          request.revision,
          revisionId,
          stagedPath,
          target.stored,
          snapshotPath,
          contentDigest,
          now(),
        );
        // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
        insertRevision(
          createConditionalObject({
            revisionId,
            revisionKind: "definition",
            workingPath: target.stored,
            snapshotPath,
            contentDigest,
            actor: request.activity.actor,
          } as const)
            .addOptional(
              !(request.activity.reason === undefined) ? { reason: request.activity.reason } : undefined,
            )
            .addOptional(
              !(request.expectedCurrentRevisionId === undefined)
                ? {
                    predecessorRevisionId: request.expectedCurrentRevisionId,
                  }
                : undefined,
            )
            .add({
              sensitivity: request.sensitivity ?? "normal",
              provenanceRefs: request.provenanceRefs ?? [],
            } as const)
            .finish(),
        );
      });
    } catch (error) {
      await rm(dirname(stagedAbsolute), { recursive: true, force: true });
      await rm(dirname(snapshotAbsolute), { recursive: true, force: true });
      throw error;
    }
    let committed: DefinitionMetadataCommitResult;
    try {
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      committed = await definitionMetadataRepository.commitRevision(
        createConditionalObject({
          namespace: request.namespace,
          definitionId: request.definitionId,
          revision: request.revision,
          definitionRevision,
        } as const)
          .addOptional(
            !(request.expectedCurrentRevisionId === undefined)
              ? {
                  expectedCurrentRevisionId: request.expectedCurrentRevisionId,
                }
              : undefined,
          )
          .add({
            activity: request.activity,
          } as const)
          .finish(),
      );
    } catch (error) {
      db.prepare("UPDATE definition_publications SET status = 'rejected' WHERE publication_id = ?").run(
        publicationId,
      );
      await cleanupPublication(publicationId, revisionId);
      throw error;
    }
    if (!committed.ok) {
      db.prepare("UPDATE definition_publications SET status = 'rejected' WHERE publication_id = ?").run(
        publicationId,
      );
      await cleanupPublication(publicationId, revisionId);
      return committed;
    }
    db.prepare("UPDATE definition_publications SET status = 'committed' WHERE publication_id = ?").run(
      publicationId,
    );
    options.afterDefinitionCommitForTesting?.();
    await persistAtomically(target.absolute, bytes);
    db.prepare(
      "UPDATE definition_publications SET status = 'published', published_at = ? WHERE publication_id = ?",
    ).run(now(), publicationId);
    await rm(dirname(stagedAbsolute), { recursive: true, force: true });
    return committed;
  };
  const definitionPublications = Object.freeze({
    publish: publishDefinition,
    recoverPending: recoverPendingPublications,
    cleanupAbandoned: cleanupAbandonedPublications,
  });
  await recoverPendingPublications();
  await cleanupAbandonedPublications();
  const search = createSearchIndex(database, paths);
  const readDatabaseRow = async (ref: DatabaseRowRef): Promise<DatabaseRow | undefined> => {
    const row = db
      .prepare(`SELECT * FROM ${ref.table} WHERE ${PRIMARY_KEY_BY_TABLE[ref.table]} = ?`)
      .get(ref.rowId);
    return row;
  };
  const getArtifactMetadata = async (artifactId: string): Promise<ArtifactFileRef | undefined> => {
    const row = db
      .prepare("SELECT artifact_id, path, media_type FROM artifacts WHERE artifact_id = ?")
      .get(artifactId);
    return row === undefined
      ? undefined
      : ArtifactFileRefSchema.parse({
          kind: "artifact_file",
          artifactId: requiredString(row, "artifact_id"),
          path: requiredString(row, "path"),
          mediaType: requiredString(row, "media_type"),
        });
  };
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  const protectedActivations = await createProtectedActivationStore(
    createConditionalObject({
      database,
      now,
    } as const)
      .addOptional(
        !(options.beforeActivationCommitForTesting === undefined)
          ? {
              beforeActivationCommitForTesting: options.beforeActivationCommitForTesting,
            }
          : undefined,
      )
      .addOptional(
        !(options.duringActivationCommitForTesting === undefined)
          ? {
              duringActivationCommitForTesting: options.duringActivationCommitForTesting,
            }
          : undefined,
      )
      .addOptional(
        !(options.afterActivationCommitForTesting === undefined)
          ? {
              afterActivationCommitForTesting: options.afterActivationCommitForTesting,
            }
          : undefined,
      )
      .add({
        recordActivity,
        assertStoredReference: (reference: EvidenceRef) => assertStoredReference(db, reference),
        readVerifiedFile,
        persistAtomically,
        pathsForDefinition,
        resolveRevision,
        recordDefinitionBytes,
      } as const)
      .finish(),
  );
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  const protectedFeedback = await createProtectedFeedbackStore(
    createConditionalObject({
      database,
      now,
    } as const)
      .addOptional(
        !(options.beforeOutcomeCommitForTesting === undefined)
          ? {
              beforeOutcomeCommitForTesting: options.beforeOutcomeCommitForTesting,
            }
          : undefined,
      )
      .addOptional(
        !(options.duringOutcomeCommitForTesting === undefined)
          ? {
              duringOutcomeCommitForTesting: options.duringOutcomeCommitForTesting,
            }
          : undefined,
      )
      .addOptional(
        !(options.afterOutcomeCommitForTesting === undefined)
          ? {
              afterOutcomeCommitForTesting: options.afterOutcomeCommitForTesting,
            }
          : undefined,
      )
      .add({
        recordActivity,
        assertStoredReference: (reference: EvidenceRef) => assertStoredReference(db, reference),
        stageActiveRevision,
        publishStagedActiveRevision,
        deleteActiveDefinition,
        normalizeActiveWorkingPath,
        cleanupOutcomePublicationStage,
      } as const)
      .finish(),
  );
  const cutoverLegacyOperationalAuthority = async (
    legacyRoot: string,
    actor: ActorRef,
  ): Promise<OperationalCutoverReport> => {
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    const cutoverName = "workspace-operational-authority" as const;
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    const cutoverVersion = 1 as const;
    const existing = db
      .prepare(`SELECT source_digest FROM operational_cutovers
         WHERE cutover_name = ? AND cutover_version = ?`)
      .get(cutoverName, cutoverVersion);
    if (existing !== undefined) {
      const sourceId = sha256(resolve(legacyRoot));
      const imported = db.prepare("SELECT report_json FROM import_runs WHERE source_id = ?").get(sourceId);
      const legacyImport =
        imported === undefined
          ? Object.freeze({
              sourceId,
              alreadyImported: true,
              sessions: 0,
              messages: 0,
              toolCalls: 0,
              outcomes: 0,
              jobs: 0,
              definitions: 0,
              artifacts: 0,
              warnings: Object.freeze([
                "Operational cutover marker exists without a retained legacy import report",
              ]),
            })
          : Object.freeze({
              ...LegacyImportReportSchema.parse(JSON.parse(requiredString(imported, "report_json"))),
              alreadyImported: true,
            });
      return Object.freeze({
        cutoverName,
        cutoverVersion,
        sourceDigest: requiredString(existing, "source_digest"),
        alreadyCompleted: true,
        legacyImport,
      });
    }
    let journalBytes: Uint8Array;
    try {
      journalBytes = await readFile(join(legacyRoot, "ledger", "events.jsonl"));
    } catch (error) {
      if (!isMissing(error)) throw error;
      journalBytes = new Uint8Array();
    }
    const journalText = new TextDecoder("utf8", { fatal: true }).decode(journalBytes);
    const legacyEvents: LedgerEvent[] = [];
    for (const [index, line] of journalText.split(/\r?\n/u).entries()) {
      if (!line.trim()) continue;
      try {
        legacyEvents.push(LedgerEventSchema.parse(JSON.parse(line)));
      } catch (error) {
        throw new Error(`Operational cutover rejected malformed legacy journal line ${index + 1}`, {
          cause: error,
        });
      }
    }
    const sourceDigest = sha256(journalBytes);
    await createBackup(paths, db, join(paths.root, "backups", "pre-operational-cutover-v1"), now());
    const legacyImport = await importLegacyWorkspace({
      legacyRoot,
      actor,
      paths,
      database,
      now,
      createId,
      recordDefinitionBytes,
      writeArtifact,
    });
    const malformedWarning = legacyImport.warnings.find((warning) =>
      warning.startsWith("Skipped invalid legacy journal line"),
    );
    if (malformedWarning) throw new Error(`Operational cutover rejected legacy import: ${malformedWarning}`);
    database.transaction(() => {
      for (const event of legacyEvents) {
        if (event.type === "authority.grant_issued") {
          const grant = GrantSchema.parse(event.payload["grant"]);
          db.prepare(`INSERT OR IGNORE INTO authority_grants(
              grant_id, principal, effects_json, resource_prefixes_json, expires_at,
              max_uses, max_cost, issued_at, source_event_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            grant.grantId,
            grant.principal,
            JSON.stringify(grant.effects),
            JSON.stringify(grant.resourcePrefixes),
            grant.expiresAt,
            grant.maxUses,
            grant.maxCost,
            event.occurredAt,
            event.eventId,
          );
          continue;
        }
        if (
          event.type !== "effect.reserved" &&
          event.type !== "effect.completed" &&
          event.type !== "effect.failed" &&
          event.type !== "effect.denied"
        )
          continue;
        const operationId = z.string().min(1).parse(event.payload["operationId"]);
        const idempotencyKey = z.string().min(1).parse(event.payload["idempotencyKey"]);
        const fingerprint = DigestSchema.parse(event.payload["operationFingerprint"]);
        const principal = z.string().min(1).parse(event.payload["principal"]);
        const effect = z.string().min(1).parse(event.payload["effect"]);
        const resource = z.string().min(1).parse(event.payload["resource"]);
        const requestDigest = DigestSchema.parse(event.payload["requestDigest"]);
        const estimatedCost = z.number().nonnegative().parse(event.payload["estimatedCost"]);
        const grantId =
          event.payload["grantId"] === undefined ? null : z.string().min(1).parse(event.payload["grantId"]);
        const status =
          event.type === "effect.completed"
            ? "completed"
            : event.type === "effect.failed"
              ? "failed"
              : event.type === "effect.denied"
                ? "denied"
                : "reserved";
        const resultJson =
          event.type === "effect.completed" ? JSON.stringify(event.payload["result"] ?? null) : null;
        const failure =
          event.type === "effect.failed" || event.type === "effect.denied"
            ? z.string().min(1).parse(event.payload["reason"])
            : null;
        const lineage =
          event.type === "effect.completed" || event.type === "effect.failed"
            ? `legacy_receipt_${sha256(event.eventId).slice(0, 32)}`
            : null;
        const existingOperation = db
          .prepare("SELECT operation_fingerprint, status FROM authority_operations WHERE operation_id = ?")
          .get(operationId);
        if (existingOperation !== undefined) {
          if (requiredString(existingOperation, "operation_fingerprint") !== fingerprint)
            throw new Error(`Legacy authority operation ${operationId} changed identity`);
          if (status === "completed" || status === "failed")
            db.prepare(`UPDATE authority_operations
               SET status = ?, result_json = ?, failure = ?, receipt_lineage_id = ?, updated_at = ?
               WHERE operation_id = ? AND status = 'reserved'`).run(
              status,
              resultJson,
              failure,
              lineage,
              event.occurredAt,
              operationId,
            );
          continue;
        }
        db.prepare(`INSERT INTO authority_operations(
            operation_id, idempotency_key, operation_fingerprint, principal, effect, resource,
            request_digest, estimated_cost, grant_id, status, result_json, failure,
            receipt_lineage_id, source_event_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          operationId,
          idempotencyKey,
          fingerprint,
          principal,
          effect,
          resource,
          requestDigest,
          estimatedCost,
          grantId,
          status,
          resultJson,
          failure,
          lineage,
          event.eventId,
          event.occurredAt,
          event.occurredAt,
        );
      }
      db.prepare(`INSERT INTO operational_cutovers(
          cutover_name, cutover_version, source_digest, completed_at
        ) VALUES (?, ?, ?, ?)`).run(cutoverName, cutoverVersion, sourceDigest, now());
    });
    return Object.freeze({
      cutoverName,
      cutoverVersion,
      sourceDigest,
      alreadyCompleted: false,
      legacyImport,
    });
  };
  const workspace: NoesisWorkspaceStore = Object.freeze({
    paths,
    capabilities,
    reads: Object.freeze({
      readDatabaseRow,
      readWorkingFile: async (workingPath: string) => {
        try {
          return await readFile(pathsForDefinition(workingPath).absolute);
        } catch (error) {
          if (isMissing(error)) return undefined;
          throw error;
        }
      },
      readRevision: async (ref: FileRevisionRef) => {
        FileRevisionRefSchema.parse(ref);
        const registered = await resolveRevision(ref.revisionId);
        if (!registered || JSON.stringify(registered) !== JSON.stringify(ref))
          throw new Error(`File revision reference does not match authoritative metadata: ${ref.revisionId}`);
        return await readVerifiedFile(ref.snapshotPath, ref.contentDigest);
      },
      readEvidence: async (ref: EvidenceRevisionRef) => {
        const row = db
          .prepare(`SELECT snapshot_path, content_digest, evidence_kind FROM file_revisions
             WHERE revision_id = ? AND revision_kind = 'evidence'`)
          .get(ref.revisionId);
        if (
          row === undefined ||
          requiredString(row, "snapshot_path") !== ref.snapshotPath ||
          requiredString(row, "content_digest") !== ref.contentDigest ||
          requiredString(row, "evidence_kind") !== ref.evidenceKind
        )
          throw new Error(`Evidence reference does not match authoritative metadata: ${ref.revisionId}`);
        return await readVerifiedFile(ref.snapshotPath, ref.contentDigest);
      },
      readArtifact: async (ref: ArtifactFileRef) => {
        ArtifactFileRefSchema.parse(ref);
        const row = db
          .prepare("SELECT path, content_digest, media_type FROM artifacts WHERE artifact_id = ?")
          .get(ref.artifactId);
        if (
          row === undefined ||
          requiredString(row, "path") !== ref.path ||
          requiredString(row, "media_type") !== ref.mediaType
        )
          throw new Error(`Artifact reference does not match authoritative metadata: ${ref.artifactId}`);
        return await readVerifiedFile(ref.path, requiredString(row, "content_digest"));
      },
    }),
    definitions: Object.freeze({
      recordWorkingDefinition: async (request: DefinitionWriteRequest) =>
        await recordDefinitionBytes(request, "definition"),
      recordCandidateDefinition: async (request: DefinitionWriteRequest) =>
        await recordDefinitionBytes(request, "candidate", "candidate"),
    }),
    definitionMetadata,
    definitionPublications,
    revisions: Object.freeze({ resolveRevision, removeUnregisteredSnapshots }),
    evidence: Object.freeze({ appendEvidence }),
    artifacts: Object.freeze({ writeArtifact, importArtifact }),
    research,
    jobs,
    workingAdjustments: Object.freeze({
      get: protectedWorkingAdjustments.get,
      getActive: protectedWorkingAdjustments.getActive,
      list: protectedWorkingAdjustments.list,
      listSettledEvidence: protectedWorkingAdjustments.listSettledEvidence,
    }),
    declaredAuthority: declaredAuthorityFor,
    operational,
    search,
    recordDirectEdit,
    stageDefinition,
    registerStagedDefinition,
    cleanupStagedDefinitions,
    inspectIntegrity: async () => await inspectWorkspaceIntegrity(paths, db),
    backup: async (backupRoot: string) => await createBackup(paths, db, backupRoot, now()),
    importLegacyWorkspace: async (legacyRoot: string, actor: ActorRef) =>
      await importLegacyWorkspace({
        legacyRoot,
        actor,
        paths,
        database,
        now,
        createId,
        recordDefinitionBytes,
        writeArtifact,
      }),
    cutoverLegacyOperationalAuthority,
    close: () => {
      releaseRuntimeOwner();
      database.close();
    },
    unsafeDatabasePathForTesting: paths.database,
    getArtifactMetadata,
  });
  try {
    acquireRuntimeOwner();
    options.afterRuntimeOwnerAcquiredForTesting?.();
    if (options.recoverInterruptedOperations) {
      const interruptedAt = now();
      recoverInterruptedRuntimeSessions(interruptedAt);
      await operational.modelCalls.interruptRunning(interruptedAt);
      await operational.codeExecutions.interruptRunning(interruptedAt);
      await operational.workflows.interruptRunning(interruptedAt);
    }
    registerWorkspaceRuntimeInternals(
      workspace,
      Object.freeze({
        authority,
        mcpConnectionCycles,
        protectedRuntime: createProtectedWorkspaceRuntime({
          workspaceRoot: paths.root,
          authority,
          activations: protectedActivations,
          feedback: protectedFeedback,
          measurements: compoundingMeasurements,
          workingAdjustments: protectedWorkingAdjustments,
        }),
      }),
    );
    return workspace;
  } catch (error) {
    try {
      releaseRuntimeOwner();
    } catch {
      // Preserve the initialization failure. Exact-owner cleanup is best effort if SQLite itself failed.
    }
    try {
      database.close();
    } catch {
      // Preserve the initialization failure if closing the partially initialized database also fails.
    }
    throw error;
  }
}
interface DefinitionMetadataRepository extends DefinitionMetadataPort {
  readonly commitRevision: (
    request: DefinitionMetadataCommitRequest,
  ) => Promise<DefinitionMetadataCommitResult>;
}
function createDefinitionMetadataRepository(
  database: WorkspaceDatabase,
  /** BOUNDARY: The workspace activity writer owns serialization of revision provenance. */
  recordActivity: (
    actor: ActorRef,
    activityKind: string,
    subjectKind: string,
    subjectId: string,
    references?: unknown,
  ) => DatabaseRowRef<"activity_log">,
  now: () => string,
): DefinitionMetadataRepository {
  const db = database.connection;
  const decode = (row: DatabaseRow | undefined): DefinitionMetadataRecord => {
    const predecessorRevisionId = optionalString(row, "predecessor_revision_id");
    const definitionRevision = decodeFileRevisionRef(row);
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    return Object.freeze(
      createConditionalObject({
        namespace: requiredString(row, "namespace"),
        definitionId: requiredString(row, "definition_id"),
        revision: requiredNumber(row, "revision"),
        definitionRevision,
        fileRevisionRow: databaseRef("file_revisions", definitionRevision.revisionId),
        activityRow: databaseRef("activity_log", requiredString(row, "activity_id")),
      } as const)
        .addOptional(!(predecessorRevisionId === undefined) ? { predecessorRevisionId } : undefined)
        .finish(),
    );
  };
  const selectMetadata = `SELECT
    metadata.namespace,
    metadata.definition_id,
    metadata.revision,
    metadata.predecessor_revision_id,
    metadata.activity_id,
    revisions.revision_id,
    revisions.working_path,
    revisions.snapshot_path,
    revisions.content_digest
  FROM definition_revision_metadata AS metadata
  JOIN file_revisions AS revisions
    ON revisions.revision_id = metadata.definition_revision_id`;
  const getCurrent = async (
    namespace: string,
    definitionId: string,
  ): Promise<DefinitionMetadataRecord | undefined> => {
    const row = db
      .prepare(`${selectMetadata}
         JOIN definition_current_pointers AS current
           ON current.namespace = metadata.namespace
          AND current.definition_id = metadata.definition_id
          AND current.revision = metadata.revision
          AND current.definition_revision_id = metadata.definition_revision_id
         WHERE metadata.namespace = ? AND metadata.definition_id = ?`)
      .get(namespace, definitionId);
    return row === undefined ? undefined : decode(row);
  };
  const listCurrent = async (namespace: string): Promise<readonly DefinitionMetadataRecord[]> =>
    db
      .prepare(`${selectMetadata}
         JOIN definition_current_pointers AS current
           ON current.namespace = metadata.namespace
          AND current.definition_id = metadata.definition_id
          AND current.revision = metadata.revision
          AND current.definition_revision_id = metadata.definition_revision_id
         WHERE metadata.namespace = ?
         ORDER BY metadata.definition_id`)
      .all(namespace)
      .map(decode);
  const listRevisions = async (
    namespace: string,
    definitionId: string,
  ): Promise<readonly DefinitionMetadataRecord[]> =>
    db
      .prepare(`${selectMetadata}
         WHERE metadata.namespace = ? AND metadata.definition_id = ?
         ORDER BY metadata.revision`)
      .all(namespace, definitionId)
      .map(decode);
  const commitRevision = async (
    request: DefinitionMetadataCommitRequest,
  ): Promise<DefinitionMetadataCommitResult> => {
    if (request.namespace.trim() === "" || request.definitionId.trim() === "") {
      throw new Error("Definition metadata requires a namespace and definition ID");
    }
    if (!Number.isInteger(request.revision) || request.revision <= 0) {
      throw new Error("Definition metadata revision must be a positive integer");
    }
    ActorSchema.parse(request.activity.actor);
    assertStoredReference(db, request.definitionRevision);
    return database.transaction(() => {
      const current = db
        .prepare(`SELECT revision, definition_revision_id
           FROM definition_current_pointers WHERE namespace = ? AND definition_id = ?`)
        .get(request.namespace, request.definitionId);
      const currentRevisionId =
        current === undefined ? undefined : requiredString(current, "definition_revision_id");
      if (currentRevisionId !== undefined) {
        const publication = db
          .prepare("SELECT status FROM definition_publications WHERE revision_id = ?")
          .get(currentRevisionId);
        if (publication !== undefined && requiredString(publication, "status") !== "published") {
          return {
            ok: false,
            error: {
              code: "conflict",
              message: `Current ${request.namespace}/${request.definitionId} revision is still publishing`,
            },
          };
        }
      }
      if (currentRevisionId !== request.expectedCurrentRevisionId) {
        return {
          ok: false,
          error: {
            code: "conflict",
            message: `Current ${request.namespace}/${request.definitionId} revision changed`,
          },
        };
      }
      const expectedRevision = (current === undefined ? 0 : requiredNumber(current, "revision")) + 1;
      if (request.revision !== expectedRevision) {
        return {
          ok: false,
          error: {
            code: "conflict",
            message: `Expected ${request.namespace}/${request.definitionId} revision ${expectedRevision}`,
          },
        };
      }
      const revisionRow = db
        .prepare("SELECT predecessor_revision_id FROM file_revisions WHERE revision_id = ?")
        .get(request.definitionRevision.revisionId);
      if (revisionRow === undefined) throw new Error("Definition revision disappeared during commit");
      const recordedPredecessor = optionalString(revisionRow, "predecessor_revision_id");
      if (recordedPredecessor !== currentRevisionId) {
        return {
          ok: false,
          error: {
            code: "conflict",
            message: `Definition snapshot predecessor does not match the current ${request.namespace}/${request.definitionId} pointer`,
          },
        };
      }
      const activityRow = recordActivity(
        request.activity.actor,
        request.activity.kind,
        request.namespace,
        request.definitionId,
        [
          request.definitionRevision,
          ...(request.activity.reason ? [{ reason: request.activity.reason }] : []),
        ],
      );
      db.prepare(`INSERT INTO definition_revision_metadata(
          namespace, definition_id, revision, definition_revision_id,
          predecessor_revision_id, activity_id
        ) VALUES (?, ?, ?, ?, ?, ?)`).run(
        request.namespace,
        request.definitionId,
        request.revision,
        request.definitionRevision.revisionId,
        currentRevisionId ?? null,
        activityRow.rowId,
      );
      db.prepare(`INSERT INTO definition_current_pointers(
          namespace, definition_id, revision, definition_revision_id, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(namespace, definition_id) DO UPDATE SET
          revision = excluded.revision,
          definition_revision_id = excluded.definition_revision_id,
          updated_at = excluded.updated_at`).run(
        request.namespace,
        request.definitionId,
        request.revision,
        request.definitionRevision.revisionId,
        now(),
      );
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      return {
        ok: true,
        value: Object.freeze(
          createConditionalObject({
            namespace: request.namespace,
            definitionId: request.definitionId,
            revision: request.revision,
            definitionRevision: Object.freeze({ ...request.definitionRevision }),
            fileRevisionRow: databaseRef("file_revisions", request.definitionRevision.revisionId),
            activityRow,
          } as const)
            .addOptional(
              !(currentRevisionId === undefined) ? { predecessorRevisionId: currentRevisionId } : undefined,
            )
            .finish(),
        ),
      };
    });
  };
  return Object.freeze({ getCurrent, listCurrent, listRevisions, commitRevision });
}
function createOperationalRepositories(
  database: WorkspaceDatabase,
  /** BOUNDARY: The workspace activity writer owns serialization of operational provenance. */
  recordActivity: (
    actor: ActorRef,
    activityKind: string,
    subjectKind: string,
    subjectId: string,
    references?: unknown,
  ) => void,
  readRevisionBytes: (storedPath: string, expectedDigest?: string) => Promise<Uint8Array>,
): NoesisWorkspaceStore["operational"] {
  const db = database.connection;
  const systemActor: ActorRef = { actorId: "workspace-store", kind: "system" };
  const checkpointUsageSchema = z.strictObject({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    estimatedCost: z.number().nonnegative(),
  });
  const decodeContextCheckpoint = (row: DatabaseRow | undefined): ContextCheckpointRecord => {
    const checkpointId = requiredString(row, "checkpoint_id");
    if (
      db.prepare("SELECT 1 FROM context_checkpoint_seals WHERE checkpoint_id = ?").get(checkpointId) ===
      undefined
    )
      throw new Error(`Context checkpoint ${checkpointId} is not sealed`);
    const previousCheckpointId = optionalString(row, "previous_checkpoint_id");
    const firstRetainedMessageId = optionalString(row, "first_retained_message_id");
    const sourceRows = db
      .prepare(`SELECT source.ordinal, source.message_id, source.content_digest,
                message.session_id AS message_session_id, message.content AS message_content
         FROM context_checkpoint_sources AS source
         LEFT JOIN messages AS message ON message.message_id = source.message_id
         WHERE source.checkpoint_id = ?
         ORDER BY source.ordinal ASC`)
      .all(checkpointId);
    const sources = sourceRows.map((source) =>
      Object.freeze({
        messageId: requiredString(source, "message_id"),
        contentDigest: requiredString(source, "content_digest"),
      }),
    );
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    const checkpoint = Object.freeze(
      createConditionalObject({
        checkpointId,
        sessionId: requiredString(row, "session_id"),
      } as const)
        .addOptional(!(previousCheckpointId === undefined) ? { previousCheckpointId } : undefined)
        .add({
          summary: requiredString(row, "summary"),
          summaryDigest: requiredString(row, "summary_digest"),
          sourceDigest: requiredString(row, "source_digest"),
          sources: Object.freeze(sources),
        } as const)
        .addOptional(!(firstRetainedMessageId === undefined) ? { firstRetainedMessageId } : undefined)
        .add({
          lastCoveredMessageId: requiredString(row, "last_covered_message_id"),
          tokenBudget: z.number().int().positive().parse(requiredNumber(row, "token_budget")),
          estimatedSummaryTokens: z
            .number()
            .int()
            .positive()
            .parse(requiredNumber(row, "estimated_summary_tokens")),
          sensitivity: SensitivitySchema.parse(requiredString(row, "sensitivity")),
          provider: requiredString(row, "provider"),
          model: requiredString(row, "model"),
          thinkingLevel: z
            .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
            .parse(requiredString(row, "thinking_level")),
          usage: Object.freeze(checkpointUsageSchema.parse(parseJson(requiredString(row, "usage_json")))),
          createdAt: requiredString(row, "created_at"),
        } as const)
        .finish(),
    );
    if (sources.length === 0) throw new Error(`Context checkpoint ${checkpointId} has no source provenance`);
    if (sha256(checkpoint.summary) !== checkpoint.summaryDigest)
      throw new Error(`Context checkpoint ${checkpointId} failed summary digest verification`);
    if (sha256(canonicalJson(checkpoint.sources)) !== checkpoint.sourceDigest)
      throw new Error(`Context checkpoint ${checkpointId} failed source digest verification`);
    if (checkpoint.lastCoveredMessageId !== checkpoint.sources.at(-1)?.messageId)
      throw new Error(`Context checkpoint ${checkpointId} has an invalid covered-message boundary`);
    for (const [ordinal, source] of sourceRows.entries()) {
      const messageId = requiredString(source, "message_id");
      if (requiredNumber(source, "ordinal") !== ordinal)
        throw new Error(`Context checkpoint ${checkpointId} has non-contiguous source provenance`);
      if (
        requiredString(source, "message_session_id") !== checkpoint.sessionId ||
        sha256(requiredString(source, "message_content")) !== requiredString(source, "content_digest")
      )
        throw new Error(`Context checkpoint ${checkpointId} source ${messageId} failed verification`);
    }
    return checkpoint;
  };
  const getContextCheckpoint = async (checkpointId: string): Promise<ContextCheckpointRecord | undefined> => {
    const row = db.prepare("SELECT * FROM context_checkpoints WHERE checkpoint_id = ?").get(checkpointId);
    return row === undefined ? undefined : decodeContextCheckpoint(row);
  };
  const getActiveContextCheckpoint = async (
    sessionId: string,
  ): Promise<ContextCheckpointRecord | undefined> => {
    const row = db
      .prepare(`SELECT checkpoint.*
         FROM session_context_state AS state
         JOIN context_checkpoints AS checkpoint
           ON checkpoint.checkpoint_id = state.active_checkpoint_id
         WHERE state.session_id = ?`)
      .get(sessionId);
    return row === undefined ? undefined : decodeContextCheckpoint(row);
  };
  const activateContextCheckpoint: NoesisWorkspaceStore["operational"]["contextCheckpoints"]["activate"] =
    async ({ checkpoint, expectedActiveCheckpointId, expectedContextMessageIds }) =>
      database.transaction(() => {
        z.string().min(1).parse(checkpoint.checkpointId);
        z.string().min(1).parse(checkpoint.sessionId);
        z.string().min(1).max(32000).parse(checkpoint.summary);
        z.string()
          .regex(/^[a-f0-9]{64}$/u)
          .parse(checkpoint.summaryDigest);
        z.string()
          .regex(/^[a-f0-9]{64}$/u)
          .parse(checkpoint.sourceDigest);
        z.number().int().positive().max(1000000).parse(checkpoint.tokenBudget);
        z.number().int().positive().parse(checkpoint.estimatedSummaryTokens);
        SensitivitySchema.parse(checkpoint.sensitivity);
        checkpointUsageSchema.parse(checkpoint.usage);
        if (checkpoint.sources.length === 0)
          throw new Error("A context checkpoint must cover at least one message");
        const sourceMessageIds = checkpoint.sources.map((source) => source.messageId);
        if (new Set(sourceMessageIds).size !== sourceMessageIds.length)
          throw new Error("A context checkpoint cannot repeat a source message");
        if (checkpoint.lastCoveredMessageId !== checkpoint.sources.at(-1)?.messageId)
          throw new Error("A context checkpoint's last covered message must be its final source");
        if (sha256(checkpoint.summary) !== checkpoint.summaryDigest)
          throw new Error(`Context checkpoint ${checkpoint.checkpointId} failed summary digest verification`);
        if (sha256(canonicalJson(checkpoint.sources)) !== checkpoint.sourceDigest)
          throw new Error(`Context checkpoint ${checkpoint.checkpointId} failed source digest verification`);
        if (checkpoint.previousCheckpointId !== expectedActiveCheckpointId)
          throw new Error("A context checkpoint must extend the expected active checkpoint");
        if (db.prepare("SELECT 1 FROM sessions WHERE session_id = ?").get(checkpoint.sessionId) === undefined)
          throw new Error(`Unknown context checkpoint session ${checkpoint.sessionId}`);
        const activeRow = db
          .prepare("SELECT active_checkpoint_id FROM session_context_state WHERE session_id = ?")
          .get(checkpoint.sessionId);
        const activeCheckpointId =
          activeRow === undefined ? undefined : requiredString(activeRow, "active_checkpoint_id");
        if (activeCheckpointId !== expectedActiveCheckpointId)
          // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
          return Object.freeze(
            createConditionalObject({
              status: "conflict" as const,
            } as const)
              .addOptional(!(activeCheckpointId === undefined) ? { activeCheckpointId } : undefined)
              .finish(),
          );
        if (new Set(expectedContextMessageIds).size !== expectedContextMessageIds.length)
          throw new Error("Expected context cannot repeat a message");
        if (sourceMessageIds.length > expectedContextMessageIds.length)
          throw new Error("Context checkpoint sources exceed the expected context");
        for (const [ordinal, sourceMessageId] of sourceMessageIds.entries()) {
          if (expectedContextMessageIds[ordinal] !== sourceMessageId)
            throw new Error("Context checkpoint sources must be an exact prefix of the expected context");
        }
        const expectedFirstRetainedMessageId = expectedContextMessageIds[sourceMessageIds.length];
        if (checkpoint.firstRetainedMessageId !== expectedFirstRetainedMessageId)
          throw new Error("Context checkpoint retained tail must immediately follow its covered sources");
        const expectedMessages = new Map<string, DatabaseRow>();
        const expectedMessageChunkSize = 500;
        for (let start = 0; start < expectedContextMessageIds.length; start += expectedMessageChunkSize) {
          const chunk = expectedContextMessageIds.slice(start, start + expectedMessageChunkSize);
          const messagePlaceholders = chunk.map(() => "?").join(", ");
          for (const row of db
            .prepare(`SELECT message_id, session_id, content
               FROM messages
               WHERE message_id IN (${messagePlaceholders})`)
            .all(...chunk))
            expectedMessages.set(requiredString(row, "message_id"), row);
        }
        if (
          expectedMessages.size !== expectedContextMessageIds.length ||
          [...expectedMessages.values()].some(
            (message) => requiredString(message, "session_id") !== checkpoint.sessionId,
          )
        )
          throw new Error("Expected context contains a message missing from the checkpoint session");
        const existing = db
          .prepare("SELECT * FROM context_checkpoints WHERE checkpoint_id = ?")
          .get(checkpoint.checkpointId);
        if (existing !== undefined) {
          const decoded = decodeContextCheckpoint(existing);
          if (!isDeepStrictEqual(decoded, checkpoint))
            throw new Error(`Context checkpoint identity collision: ${checkpoint.checkpointId}`);
        } else {
          for (const source of checkpoint.sources) {
            const message = expectedMessages.get(source.messageId);
            if (message === undefined || sha256(requiredString(message, "content")) !== source.contentDigest)
              throw new Error(`Context checkpoint source ${source.messageId} is missing or changed`);
          }
          if (checkpoint.firstRetainedMessageId !== undefined) {
            if (expectedMessages.get(checkpoint.firstRetainedMessageId) === undefined)
              throw new Error(
                `Context checkpoint retained message ${checkpoint.firstRetainedMessageId} is missing`,
              );
          }
          db.prepare(`INSERT INTO context_checkpoints(
              checkpoint_id, session_id, previous_checkpoint_id, summary, summary_digest,
              source_digest, first_retained_message_id, last_covered_message_id, token_budget,
              estimated_summary_tokens, sensitivity, provider, model, thinking_level, usage_json,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            checkpoint.checkpointId,
            checkpoint.sessionId,
            checkpoint.previousCheckpointId ?? null,
            checkpoint.summary,
            checkpoint.summaryDigest,
            checkpoint.sourceDigest,
            checkpoint.firstRetainedMessageId ?? null,
            checkpoint.lastCoveredMessageId,
            checkpoint.tokenBudget,
            checkpoint.estimatedSummaryTokens,
            checkpoint.sensitivity,
            checkpoint.provider,
            checkpoint.model,
            checkpoint.thinkingLevel,
            canonicalJson(checkpoint.usage),
            checkpoint.createdAt,
          );
          const insertSource =
            db.prepare(`INSERT INTO context_checkpoint_sources(checkpoint_id, ordinal, message_id, content_digest)
             VALUES (?, ?, ?, ?)`);
          for (const [ordinal, source] of checkpoint.sources.entries())
            insertSource.run(checkpoint.checkpointId, ordinal, source.messageId, source.contentDigest);
          db.prepare("INSERT INTO context_checkpoint_seals(checkpoint_id, sealed_at) VALUES (?, ?)").run(
            checkpoint.checkpointId,
            checkpoint.createdAt,
          );
        }
        db.prepare(`INSERT INTO session_context_state(session_id, active_checkpoint_id, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             active_checkpoint_id = excluded.active_checkpoint_id,
             updated_at = excluded.updated_at`).run(
          checkpoint.sessionId,
          checkpoint.checkpointId,
          checkpoint.createdAt,
        );
        recordActivity(
          systemActor,
          "context_checkpoint.activated",
          "context_checkpoint",
          checkpoint.checkpointId,
          checkpoint.sources,
        );
        // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
        return Object.freeze({ status: "activated" as const, checkpoint });
      });
  const registerTurnTimelineEntry = (
    turnId: string,
    timelineSequence: number,
    entryKind: "message" | "tool_call",
    entryId: string,
  ): void => {
    z.number().int().nonnegative().parse(timelineSequence);
    const existingByPosition = db
      .prepare(`SELECT entry_kind, entry_id
         FROM turn_timeline_entries
         WHERE turn_id = ? AND timeline_sequence = ?`)
      .get(turnId, timelineSequence);
    if (existingByPosition !== undefined) {
      if (
        requiredString(existingByPosition, "entry_kind") !== entryKind ||
        requiredString(existingByPosition, "entry_id") !== entryId
      )
        throw new Error(`Turn ${turnId} timeline position ${String(timelineSequence)} is already occupied`);
      return;
    }
    const existingByEntry = db
      .prepare(`SELECT turn_id, timeline_sequence
         FROM turn_timeline_entries
         WHERE entry_kind = ? AND entry_id = ?`)
      .get(entryKind, entryId);
    if (existingByEntry !== undefined) {
      if (
        requiredString(existingByEntry, "turn_id") !== turnId ||
        requiredNumber(existingByEntry, "timeline_sequence") !== timelineSequence
      )
        throw new Error(`Timeline entry ${entryKind}:${entryId} already has a different position`);
      return;
    }
    db.prepare(`INSERT INTO turn_timeline_entries(turn_id, timeline_sequence, entry_kind, entry_id)
       VALUES (?, ?, ?, ?)`).run(turnId, timelineSequence, entryKind, entryId);
  };
  const putSession = async (record: SessionRecord): Promise<DatabaseRowRef> => {
    database.transaction(() => {
      db.prepare(`INSERT INTO sessions(
          session_id, parent_session_id, title, status, provider, model, runtime, created_at, updated_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          title = excluded.title, status = excluded.status, provider = excluded.provider,
          model = excluded.model, runtime = excluded.runtime, updated_at = excluded.updated_at,
          metadata_json = excluded.metadata_json`).run(
        record.sessionId,
        record.parentSessionId ?? null,
        record.title,
        record.status,
        record.provider,
        record.model,
        record.runtime,
        record.createdAt,
        record.updatedAt,
        JSON.stringify(record.metadata),
      );
      recordActivity(systemActor, "session.put", "session", record.sessionId);
    });
    return databaseRef("sessions", record.sessionId);
  };
  const putMessage = async (record: MessageRecord): Promise<DatabaseRowRef> => {
    database.transaction(() => {
      const turnId =
        typeof record.metadata["turnId"] === "string" && record.metadata["turnId"].length > 0
          ? record.metadata["turnId"]
          : undefined;
      if (record.timelineSequence !== undefined && turnId === undefined)
        throw new Error(`Message ${record.messageId} has a timeline position without a turn`);
      if (record.timelineSequence !== undefined && turnId !== undefined) {
        const turn = db.prepare("SELECT session_id FROM foreground_turns WHERE turn_id = ?").get(turnId);
        if (turn === undefined || requiredString(turn, "session_id") !== record.sessionId)
          throw new Error(`Message ${record.messageId} turn does not belong to its session`);
      }
      db.prepare(`INSERT INTO messages(message_id, session_id, role, content, sensitivity, created_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        record.messageId,
        record.sessionId,
        record.role,
        record.content,
        record.sensitivity,
        record.createdAt,
        JSON.stringify(record.metadata),
      );
      if (record.timelineSequence !== undefined && turnId !== undefined)
        registerTurnTimelineEntry(turnId, record.timelineSequence, "message", record.messageId);
      recordActivity(systemActor, "message.append", "message", record.messageId);
    });
    return databaseRef("messages", record.messageId);
  };
  const getUserIntent = (intentId: string, sessionId: string): UserIntentRecord | undefined =>
    decodeOptional(
      db
        .prepare("SELECT * FROM user_intents WHERE intent_id = ? AND session_id = ?")
        .get(intentId, sessionId),
      decodeUserIntent,
    );
  const targetTurnStatus = (
    turnId: string | undefined,
    sessionId: string,
  ): "running" | "completed" | "aborted" | "failed" | undefined => {
    if (turnId === undefined) return undefined;
    const target = db
      .prepare("SELECT session_id, status FROM foreground_turns WHERE turn_id = ?")
      .get(turnId);
    if (target === undefined) return undefined;
    if (requiredString(target, "session_id") !== sessionId)
      throw new Error(`Foreground turn ${turnId} does not belong to session ${sessionId}`);
    return z.enum(["running", "completed", "aborted", "failed"]).parse(requiredString(target, "status"));
  };
  const userIntentMessageState = (intent: UserIntentRecord): "missing" | "verified" => {
    if (intent.targetTurnId === undefined) return "missing";
    const messages = db
      .prepare(`SELECT content
         FROM messages
         WHERE session_id = ?
           AND role = 'user'
           AND json_valid(metadata_json)
           AND json_extract(metadata_json, '$.turnId') = ?
           AND json_extract(metadata_json, '$.sourceIntentId') = ?`)
      .all(intent.sessionId, intent.targetTurnId, intent.intentId);
    if (messages.length === 0) return "missing";
    for (const message of messages) {
      if (sha256(requiredString(message, "content")) !== intent.contentDigest)
        throw new Error(`User intent ${intent.intentId} durable message content does not match its digest`);
    }
    return "verified";
  };
  const deliverUserIntent = (
    intent: UserIntentRecord,
    deliveredAt: string,
    activityType: string,
  ): UserIntentRecord | undefined => {
    if (intent.targetTurnId === undefined) return undefined;
    if (userIntentMessageState(intent) !== "verified")
      throw new Error(`User intent ${intent.intentId} has no matching durable user message`);
    const delivered = db
      .prepare(`UPDATE user_intents
         SET status = 'delivered', text = NULL, delivered_at = ?, unresolved_at = NULL, updated_at = ?
         WHERE intent_id = ? AND session_id = ? AND status IN ('dispatching', 'unresolved')
           AND target_turn_id = ?`)
      .run(deliveredAt, deliveredAt, intent.intentId, intent.sessionId, intent.targetTurnId);
    if (Number(delivered.changes) !== 1) return undefined;
    recordActivity(systemActor, activityType, "user_intent", intent.intentId, [
      { targetTurnId: intent.targetTurnId },
    ]);
    return getUserIntent(intent.intentId, intent.sessionId);
  };
  const enqueueUserIntent = async (
    request: Parameters<NoesisWorkspaceStore["operational"]["userIntents"]["enqueue"]>[0],
  ): Promise<UserIntentRecord> =>
    database.transaction(() => {
      const intentId = z.string().min(1).parse(request.intentId);
      const sessionId = z.string().min(1).parse(request.sessionId);
      z.string().trim().min(1).parse(request.text);
      const createdAt = z.string().min(1).parse(request.createdAt);
      const contentDigest = sha256(request.text);
      const existing = getUserIntent(intentId, sessionId);
      if (existing !== undefined) {
        if (
          existing.contentDigest !== contentDigest ||
          existing.queuedBehindTurnId !== request.queuedBehindTurnId ||
          existing.createdAt !== createdAt
        )
          throw new Error(`User intent ${intentId} already exists with a different identity`);
        return existing;
      }
      const colliding = db.prepare("SELECT session_id FROM user_intents WHERE intent_id = ?").get(intentId);
      if (colliding !== undefined)
        throw new Error(`User intent ${intentId} already belongs to another session`);
      if (request.queuedBehindTurnId !== undefined) {
        const queuedBehind = db
          .prepare("SELECT session_id FROM foreground_turns WHERE turn_id = ?")
          .get(request.queuedBehindTurnId);
        if (queuedBehind === undefined || requiredString(queuedBehind, "session_id") !== sessionId)
          throw new Error(`User intent ${intentId} queued-behind turn does not belong to its session`);
      }
      const queueSequence = requiredNumber(
        db
          .prepare(`SELECT COALESCE(MAX(queue_sequence), 0) + 1 AS next_sequence
             FROM user_intents
             WHERE session_id = ?`)
          .get(sessionId),
        "next_sequence",
      );
      db.prepare(`INSERT INTO user_intents(
          intent_id, session_id, text, content_digest, delivery_mode, status, queue_sequence,
          queued_behind_turn_id, target_turn_id, created_at, updated_at,
          promoted_at, delivered_at, unresolved_at, withdrawn_at, attempt_count
        ) VALUES (?, ?, ?, ?, 'turn', 'pending', ?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, 0)`).run(
        intentId,
        sessionId,
        request.text,
        contentDigest,
        queueSequence,
        request.queuedBehindTurnId ?? null,
        createdAt,
        createdAt,
      );
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      recordActivity(systemActor, "user_intent.enqueued", "user_intent", intentId, [
        createConditionalObject({
          sessionId,
          mode: "turn",
        } as const)
          .addOptional(
            request.queuedBehindTurnId ? { queuedBehindTurnId: request.queuedBehindTurnId } : undefined,
          )
          .finish(),
      ]);
      const inserted = getUserIntent(intentId, sessionId);
      if (inserted === undefined) throw new Error(`User intent ${intentId} disappeared after enqueue`);
      return inserted;
    });
  const reroutePendingUserIntents = async (
    request: Parameters<NoesisWorkspaceStore["operational"]["userIntents"]["reroutePending"]>[0],
  ): Promise<readonly UserIntentRecord[]> =>
    database.transaction(() => {
      const sourceSessionId = z.string().min(1).parse(request.sourceSessionId);
      const destinationSessionId = z.string().min(1).parse(request.destinationSessionId);
      if (sourceSessionId === destinationSessionId)
        throw new Error("Pending user intents can only be rerouted into a different session");
      const reroutedAt = z.string().min(1).parse(request.reroutedAt);
      if (db.prepare("SELECT 1 FROM sessions WHERE session_id = ?").get(destinationSessionId) === undefined)
        throw new Error(`Destination session ${destinationSessionId} does not exist`);
      const sourceIds = new Set<string>();
      const destinationIds = new Set<string>();
      const pairs = request.intents.map((item) => {
        const sourceIntentId = z.string().min(1).parse(item.sourceIntentId);
        const destinationIntentId = z.string().min(1).parse(item.destinationIntentId);
        if (sourceIds.has(sourceIntentId)) throw new Error(`Duplicate source intent ${sourceIntentId}`);
        if (destinationIds.has(destinationIntentId))
          throw new Error(`Duplicate destination intent ${destinationIntentId}`);
        sourceIds.add(sourceIntentId);
        destinationIds.add(destinationIntentId);
        const source = getUserIntent(sourceIntentId, sourceSessionId);
        if (source === undefined) throw new Error(`Source user intent ${sourceIntentId} does not exist`);
        return { source, destinationIntentId };
      });
      pairs.sort((left, right) => left.source.queueSequence - right.source.queueSequence);
      let nextSequence = requiredNumber(
        db
          .prepare(`SELECT COALESCE(MAX(queue_sequence), 0) + 1 AS next_sequence
             FROM user_intents
             WHERE session_id = ?`)
          .get(destinationSessionId),
        "next_sequence",
      );
      const rerouted: UserIntentRecord[] = [];
      for (const { source, destinationIntentId } of pairs) {
        const existing = getUserIntent(destinationIntentId, destinationSessionId);
        if (existing !== undefined) {
          if (
            source.status !== "withdrawn" ||
            existing.status !== "pending" ||
            existing.contentDigest !== source.contentDigest ||
            existing.createdAt !== source.createdAt
          )
            throw new Error(
              `Destination user intent ${destinationIntentId} already exists with a different reroute identity`,
            );
          rerouted.push(existing);
          nextSequence = Math.max(nextSequence, existing.queueSequence + 1);
          continue;
        }
        const collision = db
          .prepare("SELECT session_id FROM user_intents WHERE intent_id = ?")
          .get(destinationIntentId);
        if (collision !== undefined)
          throw new Error(
            `Destination user intent ${destinationIntentId} already belongs to another session`,
          );
        if (source.status !== "pending" || source.deliveryMode !== "turn" || source.text === undefined)
          throw new Error(`Source user intent ${source.intentId} is no longer pending`);
        const withdrawn = db
          .prepare(`UPDATE user_intents
             SET status = 'withdrawn', withdrawn_at = ?, updated_at = ?
             WHERE intent_id = ? AND session_id = ? AND status = 'pending' AND delivery_mode = 'turn'`)
          .run(reroutedAt, reroutedAt, source.intentId, sourceSessionId);
        if (Number(withdrawn.changes) !== 1)
          throw new Error(`Source user intent ${source.intentId} changed during reroute`);
        db.prepare(`INSERT INTO user_intents(
            intent_id, session_id, text, content_digest, delivery_mode, status, queue_sequence,
            queued_behind_turn_id, target_turn_id, created_at, updated_at,
            promoted_at, delivered_at, unresolved_at, withdrawn_at, attempt_count
          ) VALUES (?, ?, ?, ?, 'turn', 'pending', ?, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, 0)`).run(
          destinationIntentId,
          destinationSessionId,
          source.text,
          source.contentDigest,
          nextSequence,
          source.createdAt,
          reroutedAt,
        );
        recordActivity(systemActor, "user_intent.rerouted_from", "user_intent", source.intentId, [
          { destinationSessionId, destinationIntentId },
        ]);
        recordActivity(systemActor, "user_intent.rerouted_to", "user_intent", destinationIntentId, [
          { sourceSessionId, sourceIntentId: source.intentId },
        ]);
        const inserted = getUserIntent(destinationIntentId, destinationSessionId);
        if (inserted === undefined)
          throw new Error(`Destination user intent ${destinationIntentId} disappeared after reroute`);
        rerouted.push(inserted);
        nextSequence += 1;
      }
      return Object.freeze(rerouted);
    });
  const enqueueAndPromoteUserIntentToSteer = async (
    request: Parameters<NoesisWorkspaceStore["operational"]["userIntents"]["enqueueAndPromoteToSteer"]>[0],
  ): Promise<UserIntentRecord | undefined> =>
    database.transaction(() => {
      const intentId = z.string().min(1).parse(request.intentId);
      const sessionId = z.string().min(1).parse(request.sessionId);
      z.string().trim().min(1).parse(request.text);
      const text = request.text;
      const targetTurnId = z.string().min(1).parse(request.targetTurnId);
      const createdAt = z.string().min(1).parse(request.createdAt);
      const promotedAt = z.string().min(1).parse(request.promotedAt);
      const contentDigest = sha256(text);
      const existing = getUserIntent(intentId, sessionId);
      if (existing !== undefined) {
        if (
          existing.contentDigest !== contentDigest ||
          existing.queuedBehindTurnId !== targetTurnId ||
          existing.createdAt !== createdAt ||
          existing.deliveryMode !== "steer" ||
          existing.targetTurnId !== targetTurnId ||
          existing.promotedAt !== promotedAt
        )
          throw new Error(`User intent ${intentId} already exists with a different identity`);
        return existing;
      }
      const colliding = db.prepare("SELECT session_id FROM user_intents WHERE intent_id = ?").get(intentId);
      if (colliding !== undefined)
        throw new Error(`User intent ${intentId} already belongs to another session`);
      const target = db
        .prepare("SELECT session_id, status FROM foreground_turns WHERE turn_id = ?")
        .get(targetTurnId);
      if (
        target === undefined ||
        requiredString(target, "session_id") !== sessionId ||
        requiredString(target, "status") !== "running"
      )
        return undefined;
      const queueSequence = requiredNumber(
        db
          .prepare(`SELECT COALESCE(MAX(queue_sequence), 0) + 1 AS next_sequence
             FROM user_intents
             WHERE session_id = ?`)
          .get(sessionId),
        "next_sequence",
      );
      db.prepare(`INSERT INTO user_intents(
          intent_id, session_id, text, content_digest, delivery_mode, status, queue_sequence,
          queued_behind_turn_id, target_turn_id, created_at, updated_at,
          held_at, promoted_at, delivered_at, unresolved_at, withdrawn_at, steer_origin, attempt_count
        ) VALUES (?, ?, ?, ?, 'steer', 'dispatching', ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, 'explicit', 1)`).run(
        intentId,
        sessionId,
        text,
        contentDigest,
        queueSequence,
        targetTurnId,
        targetTurnId,
        createdAt,
        promotedAt,
        promotedAt,
      );
      recordActivity(systemActor, "user_intent.enqueued", "user_intent", intentId, [
        { sessionId, mode: "turn", queuedBehindTurnId: targetTurnId },
      ]);
      recordActivity(systemActor, "user_intent.promoted_to_steer", "user_intent", intentId, [
        { targetTurnId },
      ]);
      const inserted = getUserIntent(intentId, sessionId);
      if (inserted === undefined)
        throw new Error(`User intent ${intentId} disappeared after atomic steer promotion`);
      return inserted;
    });
  const holdExplicitUserIntentSteer = async (
    request: Parameters<NoesisWorkspaceStore["operational"]["userIntents"]["holdExplicitSteer"]>[0],
  ): Promise<UserIntentRecord | undefined> =>
    database.transaction(() => {
      const intentId = z.string().min(1).parse(request.intentId);
      const sessionId = z.string().min(1).parse(request.sessionId);
      z.string().trim().min(1).parse(request.text);
      const text = request.text;
      const targetTurnId = z.string().min(1).parse(request.targetTurnId);
      const createdAt = z.string().min(1).parse(request.createdAt);
      const heldAt = z.string().min(1).parse(request.heldAt);
      const contentDigest = sha256(text);
      const existing = getUserIntent(intentId, sessionId);
      if (existing !== undefined) {
        if (
          existing.contentDigest !== contentDigest ||
          existing.targetTurnId !== targetTurnId ||
          existing.createdAt !== createdAt ||
          existing.heldAt !== heldAt ||
          existing.steerOrigin !== "explicit"
        )
          throw new Error(`User intent ${intentId} already exists with a different identity`);
        return existing;
      }
      const target = db
        .prepare("SELECT session_id, status FROM foreground_turns WHERE turn_id = ?")
        .get(targetTurnId);
      if (
        target === undefined ||
        requiredString(target, "session_id") !== sessionId ||
        requiredString(target, "status") !== "running"
      )
        return undefined;
      const queueSequence = requiredNumber(
        db
          .prepare(`SELECT COALESCE(MAX(queue_sequence), 0) + 1 AS next_sequence
             FROM user_intents WHERE session_id = ?`)
          .get(sessionId),
        "next_sequence",
      );
      db.prepare(`INSERT INTO user_intents(
          intent_id, session_id, text, content_digest, delivery_mode, status, queue_sequence,
          queued_behind_turn_id, target_turn_id, created_at, updated_at,
          held_at, promoted_at, delivered_at, unresolved_at, withdrawn_at, steer_origin, attempt_count
        ) VALUES (?, ?, ?, ?, 'steer', 'held', ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 'explicit', 0)`).run(
        intentId,
        sessionId,
        text,
        contentDigest,
        queueSequence,
        targetTurnId,
        targetTurnId,
        createdAt,
        heldAt,
        heldAt,
      );
      recordActivity(systemActor, "user_intent.held_explicit_steer", "user_intent", intentId, [
        { targetTurnId },
      ]);
      const inserted = getUserIntent(intentId, sessionId);
      if (inserted === undefined) throw new Error(`User intent ${intentId} disappeared after hold`);
      return inserted;
    });
  const holdNewestPendingUserIntentToSteer = async (
    request: Parameters<NoesisWorkspaceStore["operational"]["userIntents"]["holdNewestPendingToSteer"]>[0],
  ): Promise<UserIntentRecord | undefined> =>
    database.transaction(() => {
      const target = db
        .prepare("SELECT session_id, status FROM foreground_turns WHERE turn_id = ?")
        .get(request.targetTurnId);
      if (
        target === undefined ||
        requiredString(target, "session_id") !== request.sessionId ||
        requiredString(target, "status") !== "running"
      )
        return undefined;
      const candidate = db
        .prepare(`SELECT intent_id FROM user_intents
           WHERE session_id = ? AND status = 'pending' AND delivery_mode = 'turn'
           ORDER BY queue_sequence DESC LIMIT 1`)
        .get(request.sessionId);
      if (candidate === undefined) return undefined;
      const intentId = requiredString(candidate, "intent_id");
      const held = db
        .prepare(`UPDATE user_intents
           SET status = 'held', delivery_mode = 'steer', target_turn_id = ?, held_at = ?,
               steer_origin = 'queued', updated_at = ?
           WHERE intent_id = ? AND session_id = ? AND status = 'pending' AND delivery_mode = 'turn'`)
        .run(request.targetTurnId, request.heldAt, request.heldAt, intentId, request.sessionId);
      if (Number(held.changes) !== 1) return undefined;
      recordActivity(systemActor, "user_intent.held_queued_steer", "user_intent", intentId, [
        { targetTurnId: request.targetTurnId },
      ]);
      return getUserIntent(intentId, request.sessionId);
    });
  const activateHeldUserIntentSteer = async (
    request: Parameters<NoesisWorkspaceStore["operational"]["userIntents"]["activateHeldSteer"]>[0],
  ): Promise<UserIntentRecord | undefined> =>
    database.transaction(() => {
      const current = getUserIntent(request.intentId, request.sessionId);
      if (current === undefined) return undefined;
      if (current.status === "dispatching")
        return current.targetTurnId === request.targetTurnId ? current : undefined;
      if (
        current.status !== "held" ||
        current.deliveryMode !== "steer" ||
        current.targetTurnId !== request.targetTurnId
      )
        return undefined;
      const target = db
        .prepare("SELECT session_id, status FROM foreground_turns WHERE turn_id = ?")
        .get(request.targetTurnId);
      if (
        target === undefined ||
        requiredString(target, "session_id") !== request.sessionId ||
        requiredString(target, "status") !== "running"
      )
        return undefined;
      const activated = db
        .prepare(`UPDATE user_intents
           SET status = 'dispatching', promoted_at = ?, updated_at = ?, attempt_count = attempt_count + 1
           WHERE intent_id = ? AND session_id = ? AND status = 'held'
             AND delivery_mode = 'steer' AND target_turn_id = ?`)
        .run(
          request.promotedAt,
          request.promotedAt,
          request.intentId,
          request.sessionId,
          request.targetTurnId,
        );
      if (Number(activated.changes) !== 1) return undefined;
      recordActivity(systemActor, "user_intent.held_steer_activated", "user_intent", request.intentId, [
        { targetTurnId: request.targetTurnId },
      ]);
      return getUserIntent(request.intentId, request.sessionId);
    });
  const releaseHeldUserIntentSteer = async (
    request: Parameters<NoesisWorkspaceStore["operational"]["userIntents"]["releaseHeldSteer"]>[0],
  ): Promise<UserIntentRecord | undefined> =>
    database.transaction(() => {
      const current = getUserIntent(request.intentId, request.sessionId);
      if (
        current === undefined ||
        current.status !== "held" ||
        current.deliveryMode !== "steer" ||
        current.targetTurnId !== request.targetTurnId
      )
        return undefined;
      if (current.steerOrigin === "queued") {
        db.prepare(`UPDATE user_intents
           SET status = 'pending', delivery_mode = 'turn', target_turn_id = NULL,
               held_at = NULL, steer_origin = NULL, updated_at = ?
           WHERE intent_id = ? AND session_id = ? AND status = 'held'`).run(
          request.releasedAt,
          request.intentId,
          request.sessionId,
        );
        recordActivity(systemActor, "user_intent.held_steer_requeued", "user_intent", request.intentId);
      } else {
        db.prepare(`UPDATE user_intents
           SET status = 'withdrawn', delivery_mode = 'turn', target_turn_id = NULL,
               held_at = NULL, steer_origin = NULL, withdrawn_at = ?, updated_at = ?
           WHERE intent_id = ? AND session_id = ? AND status = 'held'`).run(
          request.releasedAt,
          request.releasedAt,
          request.intentId,
          request.sessionId,
        );
        recordActivity(
          systemActor,
          "user_intent.held_explicit_steer_withdrawn",
          "user_intent",
          request.intentId,
        );
      }
      return getUserIntent(request.intentId, request.sessionId);
    });
  const claimOldestPendingUserIntent = async (
    request: Parameters<NoesisWorkspaceStore["operational"]["userIntents"]["claimOldestPending"]>[0],
  ): Promise<UserIntentRecord | undefined> =>
    database.transaction(() => {
      z.string().min(1).parse(request.sessionId);
      z.string().min(1).parse(request.targetTurnId);
      z.string().min(1).parse(request.claimedAt);
      const candidate = db
        .prepare(`SELECT intent_id
           FROM user_intents
           WHERE session_id = ? AND status = 'pending' AND delivery_mode = 'turn'
           ORDER BY queue_sequence
           LIMIT 1`)
        .get(request.sessionId);
      if (candidate === undefined) return undefined;
      const intentId = requiredString(candidate, "intent_id");
      const collidingTarget = db
        .prepare("SELECT session_id FROM foreground_turns WHERE turn_id = ?")
        .get(request.targetTurnId);
      if (collidingTarget !== undefined)
        throw new Error(`Foreground turn ${request.targetTurnId} already exists`);
      const claimed = db
        .prepare(`UPDATE user_intents
           SET status = 'dispatching', target_turn_id = ?, updated_at = ?,
               attempt_count = attempt_count + 1
           WHERE intent_id = ? AND session_id = ?
             AND status = 'pending' AND delivery_mode = 'turn'`)
        .run(request.targetTurnId, request.claimedAt, intentId, request.sessionId);
      if (Number(claimed.changes) !== 1) return undefined;
      recordActivity(systemActor, "user_intent.claimed", "user_intent", intentId, [
        { targetTurnId: request.targetTurnId },
      ]);
      return getUserIntent(intentId, request.sessionId);
    });
  const promoteNewestPendingUserIntent = async (
    request: Parameters<NoesisWorkspaceStore["operational"]["userIntents"]["promoteNewestPendingToSteer"]>[0],
  ): Promise<UserIntentRecord | undefined> =>
    database.transaction(() => {
      const target = db
        .prepare("SELECT session_id, status FROM foreground_turns WHERE turn_id = ?")
        .get(request.targetTurnId);
      if (
        target === undefined ||
        requiredString(target, "session_id") !== request.sessionId ||
        requiredString(target, "status") !== "running"
      )
        return undefined;
      const candidate = db
        .prepare(`SELECT intent_id
           FROM user_intents
           WHERE session_id = ? AND status = 'pending' AND delivery_mode = 'turn'
           ORDER BY queue_sequence DESC
           LIMIT 1`)
        .get(request.sessionId);
      if (candidate === undefined) return undefined;
      const intentId = requiredString(candidate, "intent_id");
      const promoted = db
        .prepare(`UPDATE user_intents
           SET status = 'dispatching', delivery_mode = 'steer', target_turn_id = ?,
               promoted_at = ?, steer_origin = 'queued', updated_at = ?,
               attempt_count = attempt_count + 1
           WHERE intent_id = ? AND session_id = ?
             AND status = 'pending' AND delivery_mode = 'turn'`)
        .run(request.targetTurnId, request.promotedAt, request.promotedAt, intentId, request.sessionId);
      if (Number(promoted.changes) !== 1) return undefined;
      recordActivity(systemActor, "user_intent.promoted_to_steer", "user_intent", intentId, [
        { targetTurnId: request.targetTurnId },
      ]);
      return getUserIntent(intentId, request.sessionId);
    });
  const withdrawUserIntentInTransaction = (
    request: Parameters<NoesisWorkspaceStore["operational"]["userIntents"]["withdraw"]>[0],
  ): UserIntentRecord | undefined => {
    const withdrawn = db
      .prepare(`UPDATE user_intents
           SET status = 'withdrawn', delivery_mode = 'turn', target_turn_id = NULL,
               held_at = NULL, promoted_at = NULL, unresolved_at = NULL, steer_origin = NULL,
               withdrawn_at = ?, updated_at = ?
           WHERE intent_id = ? AND session_id = ? AND status IN ('pending', 'unresolved')`)
      .run(request.withdrawnAt, request.withdrawnAt, request.intentId, request.sessionId);
    if (Number(withdrawn.changes) !== 1) return undefined;
    recordActivity(systemActor, "user_intent.withdrawn", "user_intent", request.intentId);
    return getUserIntent(request.intentId, request.sessionId);
  };
  const withdrawUserIntent = async (
    request: Parameters<NoesisWorkspaceStore["operational"]["userIntents"]["withdraw"]>[0],
  ): Promise<UserIntentRecord | undefined> =>
    database.transaction(() => withdrawUserIntentInTransaction(request));
  const withdrawUnconsumedSteerDispatch = async (
    request: Parameters<
      NoesisWorkspaceStore["operational"]["userIntents"]["withdrawUnconsumedSteerDispatch"]
    >[0],
  ): Promise<UserIntentRecord | undefined> =>
    database.transaction(() => {
      z.string().min(1).parse(request.sessionId);
      z.string().min(1).parse(request.intentId);
      z.string().min(1).parse(request.targetTurnId);
      z.string().min(1).parse(request.withdrawnAt);
      const current = getUserIntent(request.intentId, request.sessionId);
      if (current === undefined) return undefined;
      if (current.status === "withdrawn")
        return current.queuedBehindTurnId === request.targetTurnId ? current : undefined;
      if (
        current.status !== "dispatching" ||
        current.deliveryMode !== "steer" ||
        current.targetTurnId !== request.targetTurnId
      )
        return undefined;
      const withdrawn = db
        .prepare(`UPDATE user_intents
           SET status = 'withdrawn', delivery_mode = 'turn', target_turn_id = NULL,
               held_at = NULL, promoted_at = NULL, unresolved_at = NULL, steer_origin = NULL,
               withdrawn_at = ?, updated_at = ?
           WHERE intent_id = ? AND session_id = ?
             AND status = 'dispatching' AND delivery_mode = 'steer' AND target_turn_id = ?`)
        .run(
          request.withdrawnAt,
          request.withdrawnAt,
          request.intentId,
          request.sessionId,
          request.targetTurnId,
        );
      if (Number(withdrawn.changes) !== 1) return undefined;
      recordActivity(systemActor, "user_intent.withdrawn_unconsumed_steer", "user_intent", request.intentId, [
        { targetTurnId: request.targetTurnId },
      ]);
      return getUserIntent(request.intentId, request.sessionId);
    });
  const markUserIntentDelivered = async (
    request: Parameters<NoesisWorkspaceStore["operational"]["userIntents"]["markDelivered"]>[0],
  ): Promise<UserIntentRecord | undefined> =>
    database.transaction(() => {
      const current = getUserIntent(request.intentId, request.sessionId);
      if (current === undefined) return undefined;
      if (current.status === "delivered")
        return current.targetTurnId === request.targetTurnId && userIntentMessageState(current) === "verified"
          ? current
          : undefined;
      if (
        (current.status !== "dispatching" && current.status !== "unresolved") ||
        current.targetTurnId !== request.targetTurnId
      )
        return undefined;
      if (current.deliveryMode === "steer")
        throw new Error("Steer delivery must be committed with recordSteerDelivery");
      if (targetTurnStatus(request.targetTurnId, request.sessionId) !== "completed") return undefined;
      return deliverUserIntent(current, request.deliveredAt, "user_intent.delivered");
    });
  const recordSteerDelivery = async (
    request: Parameters<NoesisWorkspaceStore["operational"]["userIntents"]["recordSteerDelivery"]>[0],
  ): Promise<UserIntentRecord | undefined> =>
    database.transaction(() => {
      const current = getUserIntent(request.intentId, request.sessionId);
      if (current === undefined || current.targetTurnId !== request.targetTurnId) return undefined;
      if (sha256(request.text) !== current.contentDigest)
        throw new Error(`Steer delivery text for intent ${request.intentId} does not match its digest`);
      if (
        current.status !== "dispatching" &&
        current.status !== "unresolved" &&
        current.status !== "delivered"
      )
        return undefined;
      if (current.deliveryMode !== "steer") return undefined;
      const messageId = `${request.targetTurnId}:steer:${request.intentId}`;
      if (current.status === "delivered") {
        const existing = decodeOptional(
          db
            .prepare(`SELECT m.*, timeline.timeline_sequence
               FROM messages AS m
               LEFT JOIN turn_timeline_entries AS timeline
                 ON timeline.entry_kind = 'message' AND timeline.entry_id = m.message_id
               WHERE m.message_id = ?`)
            .get(messageId),
          decodeMessage,
        );
        return userIntentMessageState(current) === "verified" &&
          existing?.timelineSequence === request.timelineSequence
          ? current
          : undefined;
      }
      const target = db
        .prepare("SELECT session_id FROM foreground_turns WHERE turn_id = ?")
        .get(request.targetTurnId);
      if (target === undefined || requiredString(target, "session_id") !== request.sessionId)
        throw new Error(`User intent ${request.intentId} target turn does not belong to its session`);
      const metadata = Object.freeze({
        turnId: request.targetTurnId,
        sourceIntentId: request.intentId,
        deliveryMode: "steer",
      });
      const existingMessage = decodeOptional(
        db
          .prepare(`SELECT m.*, timeline.timeline_sequence
             FROM messages AS m
             LEFT JOIN turn_timeline_entries AS timeline
               ON timeline.entry_kind = 'message' AND timeline.entry_id = m.message_id
             WHERE m.message_id = ?`)
          .get(messageId),
        decodeMessage,
      );
      if (existingMessage === undefined) {
        db.prepare(`INSERT INTO messages(message_id, session_id, role, content, sensitivity, created_at, metadata_json)
           VALUES (?, ?, 'user', ?, ?, ?, ?)`).run(
          messageId,
          request.sessionId,
          request.text,
          request.sensitivity,
          request.deliveredAt,
          JSON.stringify(metadata),
        );
        registerTurnTimelineEntry(request.targetTurnId, request.timelineSequence, "message", messageId);
        recordActivity(systemActor, "message.append", "message", messageId);
      } else if (
        existingMessage.sessionId !== request.sessionId ||
        existingMessage.role !== "user" ||
        existingMessage.content !== request.text ||
        existingMessage.sensitivity !== request.sensitivity ||
        existingMessage.createdAt !== request.deliveredAt ||
        existingMessage.timelineSequence !== request.timelineSequence ||
        !isDeepStrictEqual(existingMessage.metadata, metadata)
      ) {
        throw new Error(`Steer delivery message ${messageId} already exists with different content`);
      }
      const refreshed = getUserIntent(request.intentId, request.sessionId);
      if (refreshed === undefined) return undefined;
      if (refreshed.status === "delivered")
        return userIntentMessageState(refreshed) === "verified" ? refreshed : undefined;
      return deliverUserIntent(refreshed, request.deliveredAt, "user_intent.delivered");
    });
  const markUserIntentUnresolved = async (
    request: Parameters<NoesisWorkspaceStore["operational"]["userIntents"]["markUnresolved"]>[0],
  ): Promise<UserIntentRecord | undefined> =>
    database.transaction(() => {
      const current = getUserIntent(request.intentId, request.sessionId);
      if (current === undefined) return undefined;
      if (current.status === "delivered")
        return current.targetTurnId === request.targetTurnId && userIntentMessageState(current) === "verified"
          ? current
          : undefined;
      if (current.status === "unresolved")
        return current.targetTurnId === request.targetTurnId ? current : undefined;
      if (current.status !== "dispatching" || current.targetTurnId !== request.targetTurnId) return undefined;
      if (
        userIntentMessageState(current) === "verified" &&
        targetTurnStatus(current.targetTurnId, current.sessionId) === "completed"
      )
        return deliverUserIntent(
          current,
          request.unresolvedAt,
          "user_intent.delivery_confirmed_while_marking_unresolved",
        );
      const unresolved = db
        .prepare(`UPDATE user_intents
           SET status = 'unresolved', unresolved_at = ?, updated_at = ?
           WHERE intent_id = ? AND session_id = ? AND status = 'dispatching'
             AND target_turn_id = ?`)
        .run(
          request.unresolvedAt,
          request.unresolvedAt,
          request.intentId,
          request.sessionId,
          request.targetTurnId,
        );
      if (Number(unresolved.changes) !== 1) return undefined;
      recordActivity(systemActor, "user_intent.delivery_unresolved", "user_intent", request.intentId, [
        { targetTurnId: request.targetTurnId },
      ]);
      return getUserIntent(request.intentId, request.sessionId);
    });
  const releaseUnconsumedUserIntentDispatch = async (
    request: Parameters<NoesisWorkspaceStore["operational"]["userIntents"]["releaseUnconsumedDispatch"]>[0],
  ): Promise<UserIntentRecord | undefined> =>
    database.transaction(() => {
      const current = getUserIntent(request.intentId, request.sessionId);
      if (current === undefined) return undefined;
      if (
        current.status === "pending" &&
        current.deliveryMode === "turn" &&
        current.targetTurnId === undefined
      )
        return current;
      if (current.status !== "dispatching") return undefined;
      const messageState = userIntentMessageState(current);
      const turnStatus = targetTurnStatus(current.targetTurnId, current.sessionId);
      if (messageState === "verified" && turnStatus === "completed")
        return deliverUserIntent(
          current,
          request.releasedAt,
          "user_intent.delivery_confirmed_during_release",
        );
      const hasCrashVisibleDispatch = messageState === "verified";
      const released = hasCrashVisibleDispatch
        ? db
            .prepare(`UPDATE user_intents
               SET status = 'unresolved', unresolved_at = ?, updated_at = ?
               WHERE intent_id = ? AND session_id = ? AND status = 'dispatching'`)
            .run(request.releasedAt, request.releasedAt, request.intentId, request.sessionId)
        : db
            .prepare(`UPDATE user_intents
               SET status = 'pending', delivery_mode = 'turn', target_turn_id = NULL,
                   held_at = NULL, promoted_at = NULL, steer_origin = NULL, updated_at = ?
               WHERE intent_id = ? AND session_id = ? AND status = 'dispatching'`)
            .run(request.releasedAt, request.intentId, request.sessionId);
      if (Number(released.changes) !== 1) return undefined;
      recordActivity(
        systemActor,
        hasCrashVisibleDispatch ? "user_intent.delivery_unresolved" : "user_intent.dispatch_released",
        "user_intent",
        request.intentId,
      );
      return getUserIntent(request.intentId, request.sessionId);
    });
  const recoverDispatchingUserIntents = async (
    request: Parameters<NoesisWorkspaceStore["operational"]["userIntents"]["recoverDispatching"]>[0],
  ): Promise<{
    readonly released: number;
    readonly delivered: number;
    readonly unresolved: number;
  }> =>
    database.transaction(() => {
      let released = 0;
      let delivered = 0;
      let unresolved = 0;
      const heldRows = db
        .prepare(`SELECT * FROM user_intents
           WHERE session_id = ? AND status = 'held'
           ORDER BY queue_sequence`)
        .all(request.sessionId)
        .map(decodeUserIntent);
      for (const intent of heldRows) {
        if (intent.steerOrigin === "queued") {
          db.prepare(`UPDATE user_intents
             SET status = 'pending', delivery_mode = 'turn', target_turn_id = NULL,
                 held_at = NULL, steer_origin = NULL, updated_at = ?
             WHERE intent_id = ? AND session_id = ? AND status = 'held'`).run(
            request.recoveredAt,
            intent.intentId,
            request.sessionId,
          );
          recordActivity(systemActor, "user_intent.recovered_pending", "user_intent", intent.intentId);
          released += 1;
          continue;
        }
        db.prepare(`UPDATE user_intents
           SET status = 'unresolved', unresolved_at = ?, updated_at = ?
           WHERE intent_id = ? AND session_id = ? AND status = 'held'`).run(
          request.recoveredAt,
          request.recoveredAt,
          intent.intentId,
          request.sessionId,
        );
        recordActivity(systemActor, "user_intent.recovered_unresolved", "user_intent", intent.intentId);
        unresolved += 1;
      }
      const rows = db
        .prepare(`SELECT *
           FROM user_intents
           WHERE session_id = ? AND status = 'dispatching'
           ORDER BY queue_sequence`)
        .all(request.sessionId)
        .map(decodeUserIntent);
      for (const intent of rows) {
        const turnStatus = targetTurnStatus(intent.targetTurnId, request.sessionId);
        const messageState = userIntentMessageState(intent);
        if (messageState === "verified" && turnStatus === "completed") {
          deliverUserIntent(intent, request.recoveredAt, "user_intent.recovered_delivered");
          delivered += 1;
          continue;
        }
        if (intent.deliveryMode === "steer" || messageState === "verified" || turnStatus !== undefined) {
          db.prepare(`UPDATE user_intents
             SET status = 'unresolved', unresolved_at = ?, updated_at = ?
             WHERE intent_id = ? AND session_id = ? AND status = 'dispatching'`).run(
            request.recoveredAt,
            request.recoveredAt,
            intent.intentId,
            request.sessionId,
          );
          recordActivity(systemActor, "user_intent.recovered_unresolved", "user_intent", intent.intentId);
          unresolved += 1;
          continue;
        }
        db.prepare(`UPDATE user_intents
           SET status = 'pending', delivery_mode = 'turn', target_turn_id = NULL,
               held_at = NULL, promoted_at = NULL, steer_origin = NULL, updated_at = ?
           WHERE intent_id = ? AND session_id = ? AND status = 'dispatching'`).run(
          request.recoveredAt,
          intent.intentId,
          request.sessionId,
        );
        recordActivity(systemActor, "user_intent.recovered_pending", "user_intent", intent.intentId);
        released += 1;
      }
      return Object.freeze({ released, delivered, unresolved });
    });
  const putToolCall = async (record: ToolCallRecord): Promise<DatabaseRowRef> => {
    database.transaction(() => {
      const currentRow = db
        .prepare(`SELECT calls.*, timeline.timeline_sequence
           FROM tool_calls AS calls
           LEFT JOIN turn_timeline_entries AS timeline
             ON timeline.entry_kind = 'tool_call' AND timeline.entry_id = calls.tool_call_id
           WHERE calls.tool_call_id = ?`)
        .get(record.toolCallId);
      const current = currentRow === undefined ? undefined : decodeToolCall(currentRow);
      if (record.timelineSequence !== undefined && record.turnId === undefined)
        throw new Error(`Tool call ${record.toolCallId} has a timeline position without a turn`);
      if (record.turnId) {
        const turn = db
          .prepare("SELECT session_id FROM foreground_turns WHERE turn_id = ?")
          .get(record.turnId);
        if (turn === undefined || requiredString(turn, "session_id") !== record.sessionId)
          throw new Error(`Tool call ${record.toolCallId} turn does not belong to its session`);
      }
      if (record.parentToolCallId) {
        const parent = db
          .prepare("SELECT session_id, turn_id FROM tool_calls WHERE tool_call_id = ?")
          .get(record.parentToolCallId);
        if (
          parent === undefined ||
          requiredString(parent, "session_id") !== record.sessionId ||
          optionalString(parent, "turn_id") !== record.turnId
        )
          throw new Error(`Tool call ${record.toolCallId} parent does not share its session and turn`);
      }
      if (record.executionId) {
        const execution = db
          .prepare("SELECT session_id, turn_id FROM codemode_executions WHERE execution_id = ?")
          .get(record.executionId);
        if (
          execution === undefined ||
          requiredString(execution, "session_id") !== record.sessionId ||
          optionalString(execution, "turn_id") !== record.turnId
        )
          throw new Error(`Tool call ${record.toolCallId} execution does not share its session and turn`);
      }
      if (currentRow !== undefined) {
        if (!current) throw new Error(`Tool call ${record.toolCallId} could not be decoded`);
        if (current.sequence === undefined)
          throw new Error(`Tool call ${record.toolCallId} has no durable action sequence`);
        const from = current.status;
        const allowed = {
          requested: ["running", "completed", "failed", "denied", "ambiguous"],
          running: ["completed", "failed", "denied", "ambiguous"],
          completed: [],
          failed: [],
          denied: [],
          ambiguous: [],
        } satisfies Readonly<Record<string, readonly ToolCallRecord["status"][]>>;
        if (from !== record.status && !permitsTransition(allowed, from, record.status))
          throw new Error(`Invalid tool-call transition ${from} -> ${record.status}`);
        if (current.executionId && current.executionId !== record.executionId)
          throw new Error(`Tool call ${record.toolCallId} changed its execution lineage`);
        if (record.sequence !== undefined && record.sequence !== current.sequence)
          throw new Error(`Tool call ${record.toolCallId} changed its action sequence`);
        if (record.timelineSequence !== undefined && record.timelineSequence !== current.timelineSequence)
          throw new Error(`Tool call ${record.toolCallId} changed its turn timeline position`);
        if (
          !isDeepStrictEqual(
            immutableToolCallIdentity(current, current.sequence),
            immutableToolCallIdentity(record, current.sequence, current.timelineSequence),
          )
        )
          throw new Error(`Tool call ${record.toolCallId} changed its immutable identity`);
        if (
          allowed[from]?.length === 0 &&
          !isDeepStrictEqual(
            persistedToolCall(current, current.sequence),
            persistedToolCall(record, current.sequence, current.timelineSequence),
          )
        )
          throw new Error(`Terminal tool call ${record.toolCallId} is immutable`);
      }
      const actionSequence =
        current === undefined
          ? requiredNumber(
              db
                .prepare(`SELECT COALESCE(MAX(action_sequence), 0) + 1 AS next_sequence
                   FROM tool_calls
                   WHERE session_id = ?`)
                .get(record.sessionId),
              "next_sequence",
            )
          : (() => {
              if (current.sequence === undefined)
                throw new Error(`Tool call ${record.toolCallId} has no durable action sequence`);
              return current.sequence;
            })();
      db.prepare(`INSERT INTO tool_calls(
          tool_call_id, session_id, turn_id, message_id, parent_tool_call_id, execution_id,
          tool_name, request_json, update_json, response_json, action_sequence,
          status, sensitivity, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tool_call_id) DO UPDATE SET
          execution_id = excluded.execution_id, update_json = excluded.update_json,
          response_json = excluded.response_json, status = excluded.status,
          completed_at = excluded.completed_at`).run(
        record.toolCallId,
        record.sessionId,
        record.turnId ?? null,
        record.messageId ?? null,
        record.parentToolCallId ?? null,
        record.executionId ?? null,
        record.toolName,
        JSON.stringify(record.request),
        record.update === undefined ? null : JSON.stringify(record.update),
        record.response === undefined ? null : JSON.stringify(record.response),
        actionSequence,
        record.status,
        record.sensitivity,
        record.createdAt,
        record.completedAt ?? null,
      );
      const timelineSequence = record.timelineSequence ?? current?.timelineSequence;
      if (timelineSequence !== undefined && record.turnId !== undefined)
        registerTurnTimelineEntry(record.turnId, timelineSequence, "tool_call", record.toolCallId);
      recordActivity(systemActor, "tool_call.put", "tool_call", record.toolCallId);
    });
    return databaseRef("tool_calls", record.toolCallId);
  };
  const readProgramDefinition = async (program: {
    readonly mode: "script" | "workflow";
    readonly projectId: string;
    readonly name: string;
    readonly revision: number;
    readonly definitionRevisionId: string;
  }): Promise<JsonValue> => {
    const definition = db
      .prepare(`SELECT revision.snapshot_path, revision.content_digest
           FROM definition_revision_metadata AS metadata
           JOIN file_revisions AS revision
             ON revision.revision_id = metadata.definition_revision_id
           WHERE metadata.namespace = ?
             AND metadata.definition_id = ?
             AND metadata.revision = ?
             AND metadata.definition_revision_id = ?`)
      .get(
        `program:${program.projectId}:${program.mode}`,
        program.name,
        program.revision,
        program.definitionRevisionId,
      );
    if (definition === undefined)
      throw new Error("Operational record must reference one exact Program revision");
    return JsonValueSchema.parse(
      JSON.parse(
        new TextDecoder("utf8", { fatal: true }).decode(
          await readRevisionBytes(
            requiredString(definition, "snapshot_path"),
            requiredString(definition, "content_digest"),
          ),
        ),
      ),
    );
  };
  const putCodeExecution = async (record: CodeExecutionRecord): Promise<void> => {
    if (record.program) {
      if (record.projectId !== record.program.projectId)
        throw new Error(`Codemode execution ${record.executionId} Program project does not match its owner`);
      const manifest = ScriptProgramManifestSchema.parse(await readProgramDefinition(record.program));
      if (
        manifest.name !== record.program.name ||
        manifest.revision !== record.program.revision ||
        manifest.sourceRevision.contentDigest !== record.sourceDigest
      )
        throw new Error(
          `Codemode execution ${record.executionId} does not match its exact Program definition`,
        );
      assertStoredReference(db, manifest.sourceRevision);
    }
    database.transaction(() => {
      const currentRow = db
        .prepare("SELECT * FROM codemode_executions WHERE execution_id = ?")
        .get(record.executionId);
      if (currentRow === undefined && !record.sourceArtifactId)
        throw new Error(`Codemode execution ${record.executionId} requires a source artifact`);
      if (record.sourceArtifactId) {
        const sourceArtifact = db
          .prepare("SELECT content_digest FROM artifacts WHERE artifact_id = ?")
          .get(record.sourceArtifactId);
        if (
          sourceArtifact === undefined ||
          requiredString(sourceArtifact, "content_digest") !== record.sourceDigest
        )
          throw new Error(
            `Codemode execution ${record.executionId} source artifact does not match its source digest`,
          );
      }
      if (record.parentExecutionId) {
        const parent = db
          .prepare(`SELECT session_id, turn_id, project_id
             FROM codemode_executions
             WHERE execution_id = ?`)
          .get(record.parentExecutionId);
        if (
          parent === undefined ||
          requiredString(parent, "session_id") !== record.sessionId ||
          optionalString(parent, "turn_id") !== record.turnId ||
          optionalString(parent, "project_id") !== record.projectId
        )
          throw new Error(
            `Codemode execution ${record.executionId} parent does not share its project, session, and turn`,
          );
      }
      if (record.turnId) {
        const turn = db
          .prepare("SELECT session_id FROM foreground_turns WHERE turn_id = ?")
          .get(record.turnId);
        if (turn === undefined || requiredString(turn, "session_id") !== record.sessionId)
          throw new Error(`Codemode execution ${record.executionId} turn does not belong to its session`);
      }
      if (currentRow !== undefined) {
        const current = decodeCodeExecution(currentRow);
        const transitions = {
          running: ["running", "completed", "failed", "cancelled", "interrupted"],
          completed: ["completed"],
          failed: ["failed"],
          cancelled: ["cancelled"],
          interrupted: ["interrupted"],
        } satisfies Readonly<Record<CodeExecutionRecord["status"], readonly CodeExecutionRecord["status"][]>>;
        if (!permitsTransition(transitions, current.status, record.status))
          throw new Error(`Invalid codemode transition ${current.status} -> ${record.status}`);
        const currentIdentity = {
          ...current,
          status: record.status,
          result: record.result,
          error: record.error,
          stdoutArtifactId: record.stdoutArtifactId,
          stderrArtifactId: record.stderrArtifactId,
          callCount: record.callCount,
          completedAt: record.completedAt,
        };
        if (
          !isDeepStrictEqual(JSON.parse(JSON.stringify(currentIdentity)), JSON.parse(JSON.stringify(record)))
        )
          throw new Error(`Codemode execution ${record.executionId} changed its immutable identity`);
        if (record.callCount < current.callCount)
          throw new Error(`Codemode execution ${record.executionId} cannot reduce its call count`);
        if (
          current.status !== "running" &&
          !isDeepStrictEqual(JSON.parse(JSON.stringify(current)), JSON.parse(JSON.stringify(record)))
        )
          throw new Error(`Terminal codemode execution ${record.executionId} is immutable`);
      }
      db.prepare(`INSERT INTO codemode_executions(
          execution_id, logical_execution_id, parent_execution_id, session_id, project_id, turn_id,
          catalog_id, catalog_digest,
          source_digest,
          program_project_id, program_mode, program_name, program_revision, program_definition_revision_id,
          source_artifact_id, stdout_artifact_id, stderr_artifact_id,
          status, result_json, error, call_count, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(execution_id) DO UPDATE SET
          status = excluded.status, result_json = excluded.result_json, error = excluded.error,
          stdout_artifact_id = excluded.stdout_artifact_id,
          stderr_artifact_id = excluded.stderr_artifact_id,
          call_count = excluded.call_count, completed_at = excluded.completed_at`).run(
        record.executionId,
        record.logicalExecutionId,
        record.parentExecutionId ?? null,
        record.sessionId,
        record.projectId ?? null,
        record.turnId ?? null,
        record.catalogId,
        record.catalogDigest,
        record.sourceDigest,
        record.program?.projectId ?? null,
        record.program?.mode ?? null,
        record.program?.name ?? null,
        record.program?.revision ?? null,
        record.program?.definitionRevisionId ?? null,
        record.sourceArtifactId ?? null,
        record.stdoutArtifactId ?? null,
        record.stderrArtifactId ?? null,
        record.status,
        record.result === undefined ? null : JSON.stringify(record.result),
        record.error ?? null,
        record.callCount,
        record.startedAt,
        record.completedAt ?? null,
      );
      recordActivity(
        systemActor,
        `codemode_execution.${record.status}`,
        "codemode_execution",
        record.executionId,
      );
    });
  };
  const putModelCall = async (record: ModelCallRecord): Promise<void> => {
    database.transaction(() => {
      const parent = db
        .prepare("SELECT session_id, turn_id FROM codemode_executions WHERE execution_id = ?")
        .get(record.parentExecutionId);
      if (
        parent === undefined ||
        requiredString(parent, "session_id") !== record.sessionId ||
        optionalString(parent, "turn_id") !== record.turnId
      )
        throw new Error(`Model call ${record.modelCallId} does not belong to its parent execution`);
      for (const artifactId of [
        record.contextArtifactId,
        record.requestArtifactId,
        record.outputArtifactId,
      ]) {
        if (
          artifactId &&
          db.prepare("SELECT 1 FROM artifacts WHERE artifact_id = ?").get(artifactId) === undefined
        )
          throw new Error(`Model call ${record.modelCallId} references unknown artifact ${artifactId}`);
      }
      const currentRow = db
        .prepare("SELECT * FROM model_calls WHERE model_call_id = ?")
        .get(record.modelCallId);
      const current = currentRow === undefined ? undefined : decodeModelCall(currentRow);
      if (current !== undefined) {
        const transitions = {
          running: ["running", "completed", "failed", "cancelled", "interrupted"],
          completed: ["completed"],
          failed: ["failed"],
          cancelled: ["cancelled"],
          interrupted: ["interrupted"],
        } satisfies Readonly<Record<ModelCallRecord["status"], readonly ModelCallRecord["status"][]>>;
        if (!permitsTransition(transitions, current.status, record.status))
          throw new Error(`Invalid model-call transition ${current.status} -> ${record.status}`);
        const currentIdentity = {
          ...current,
          outputArtifactId: record.outputArtifactId,
          status: record.status,
          usage: record.usage,
          latencyMs: record.latencyMs,
          error: record.error,
          completedAt: record.completedAt,
        };
        if (
          !isDeepStrictEqual(JSON.parse(JSON.stringify(currentIdentity)), JSON.parse(JSON.stringify(record)))
        )
          throw new Error(`Model call ${record.modelCallId} changed its immutable identity`);
        if (
          current.status !== "running" &&
          !isDeepStrictEqual(JSON.parse(JSON.stringify(current)), JSON.parse(JSON.stringify(record)))
        )
          throw new Error(`Terminal model call ${record.modelCallId} is immutable`);
      }
      if (current === undefined) {
        db.prepare(`INSERT INTO model_calls(
            model_call_id, parent_execution_id, session_id, turn_id, context_artifact_id,
            request_artifact_id, output_artifact_id, provider, model, thinking_level,
            context_refs_json, status, input_tokens, output_tokens, total_tokens,
            estimated_cost, latency_ms, error, started_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          record.modelCallId,
          record.parentExecutionId,
          record.sessionId,
          record.turnId ?? null,
          record.contextArtifactId ?? null,
          record.requestArtifactId,
          record.outputArtifactId ?? null,
          record.provider,
          record.model,
          record.thinkingLevel,
          JSON.stringify(record.contextRefs),
          record.status,
          record.usage?.inputTokens ?? null,
          record.usage?.outputTokens ?? null,
          record.usage?.totalTokens ?? null,
          record.usage?.estimatedCost ?? null,
          record.latencyMs ?? null,
          record.error ?? null,
          record.startedAt,
          record.completedAt ?? null,
        );
      } else {
        const updated = db
          .prepare(`UPDATE model_calls SET
            output_artifact_id = ?, status = ?, input_tokens = ?, output_tokens = ?,
            total_tokens = ?, estimated_cost = ?, latency_ms = ?, error = ?, completed_at = ?
          WHERE model_call_id = ? AND status = ?`)
          .run(
            record.outputArtifactId ?? null,
            record.status,
            record.usage?.inputTokens ?? null,
            record.usage?.outputTokens ?? null,
            record.usage?.totalTokens ?? null,
            record.usage?.estimatedCost ?? null,
            record.latencyMs ?? null,
            record.error ?? null,
            record.completedAt ?? null,
            record.modelCallId,
            current.status,
          );
        if (Number(updated.changes) !== 1)
          throw new Error(`Model call ${record.modelCallId} changed during persistence`);
      }
      recordActivity(
        systemActor,
        `model_call.${record.status}`,
        "codemode_execution",
        record.parentExecutionId,
      );
    });
  };
  const putWorkflowRun = async (record: WorkflowRunRecord): Promise<void> => {
    if (db.prepare("SELECT 1 FROM workflow_runs WHERE run_id = ?").get(record.runId) === undefined) {
      const manifest = WorkflowProgramManifestSchema.parse(
        await readProgramDefinition({
          mode: "workflow",
          projectId: record.projectId,
          name: record.workflowName,
          revision: record.workflowRevision,
          definitionRevisionId: record.definitionRevisionId,
        }),
      );
      if (manifest.name !== record.workflowName || manifest.revision !== record.workflowRevision)
        throw new Error(`Workflow run ${record.runId} does not match its exact Program definition`);
    }
    database.transaction(() => {
      if (record.turnId) {
        const turn = db
          .prepare("SELECT session_id FROM foreground_turns WHERE turn_id = ?")
          .get(record.turnId);
        if (turn === undefined || requiredString(turn, "session_id") !== record.sessionId)
          throw new Error(`Workflow run ${record.runId} turn does not belong to its session`);
      }
      const currentRow = db.prepare("SELECT * FROM workflow_runs WHERE run_id = ?").get(record.runId);
      if (currentRow !== undefined) {
        const current = decodeWorkflowRun(currentRow);
        const transitions = {
          running: ["running", "paused", "completed", "failed", "cancelled"],
          paused: ["running", "failed", "cancelled"],
          completed: ["completed"],
          failed: ["failed"],
          cancelled: ["cancelled"],
        } satisfies Readonly<Record<WorkflowRunRecord["status"], readonly WorkflowRunRecord["status"][]>>;
        if (!permitsTransition(transitions, current.status, record.status))
          throw new Error(`Invalid workflow-run transition ${current.status} -> ${record.status}`);
        const currentIdentity = {
          ...current,
          status: record.status,
          currentPhase: record.currentPhase,
          output: record.output,
          error: record.error,
          updatedAt: record.updatedAt,
          completedAt: record.completedAt,
        };
        if (
          !isDeepStrictEqual(JSON.parse(JSON.stringify(currentIdentity)), JSON.parse(JSON.stringify(record)))
        )
          throw new Error(`Workflow run ${record.runId} changed its immutable identity`);
        if (record.currentPhase < current.currentPhase)
          throw new Error(`Workflow run ${record.runId} cannot move to an earlier phase`);
        if (
          (current.status === "completed" || current.status === "failed" || current.status === "cancelled") &&
          !isDeepStrictEqual(JSON.parse(JSON.stringify(current)), JSON.parse(JSON.stringify(record)))
        )
          throw new Error(`Terminal workflow run ${record.runId} is immutable`);
      }
      db.prepare(`INSERT INTO workflow_runs(
          run_id, project_id, workflow_name, workflow_revision, definition_revision_id,
          catalog_id, catalog_digest, definition_dependencies_digest,
          permission_digest, provider, model, thinking_level,
          context_artifact_id, context_digest, context_character_length, context_byte_length, session_id,
          turn_id, status, current_phase, input_json, output_json, error,
          created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          status = excluded.status, current_phase = excluded.current_phase,
          output_json = excluded.output_json, error = excluded.error,
          updated_at = excluded.updated_at, completed_at = excluded.completed_at`).run(
        record.runId,
        record.projectId,
        record.workflowName,
        record.workflowRevision,
        record.definitionRevisionId,
        record.catalogId ?? null,
        record.catalogDigest ?? null,
        record.definitionDependenciesDigest ?? null,
        record.permissionDigest ?? null,
        record.provider ?? null,
        record.model ?? null,
        record.thinkingLevel ?? null,
        record.contextPin?.artifactId ?? null,
        record.contextPin?.digest ?? null,
        record.contextPin?.characterLength ?? null,
        record.contextPin?.byteLength ?? null,
        record.sessionId,
        record.turnId ?? null,
        record.status,
        record.currentPhase,
        JSON.stringify(record.input),
        record.output === undefined ? null : JSON.stringify(record.output),
        record.error ?? null,
        record.createdAt,
        record.updatedAt,
        record.completedAt ?? null,
      );
      recordActivity(systemActor, `workflow_run.${record.status}`, "workflow_run", record.runId);
    });
  };
  const putWorkflowPhase = async (record: WorkflowPhaseRunRecord): Promise<void> => {
    database.transaction(() => {
      if (record.status !== "pending" && !record.logicalExecutionId)
        throw new Error(
          `Settled or running workflow phase ${record.runId}/${String(record.phaseIndex)} requires a logical execution`,
        );
      if (record.status === "pending" && record.startedAt !== undefined)
        throw new Error(`Pending workflow phase ${record.runId}/${String(record.phaseIndex)} cannot start`);
      if (record.status === "completed" && record.startedAt === undefined)
        throw new Error(
          `Completed workflow phase ${record.runId}/${String(record.phaseIndex)} requires a start time`,
        );
      if (record.executionId) {
        const lineage = db
          .prepare(`SELECT run.session_id AS run_session_id,
                           run.project_id AS run_project_id,
                           execution.session_id AS execution_session_id,
                           execution.project_id AS execution_project_id
             FROM workflow_runs AS run
             JOIN codemode_executions AS execution ON execution.execution_id = ?
             WHERE run.run_id = ?`)
          .get(record.executionId, record.runId);
        if (
          lineage === undefined ||
          requiredString(lineage, "run_session_id") !== requiredString(lineage, "execution_session_id") ||
          requiredString(lineage, "run_project_id") !== requiredString(lineage, "execution_project_id")
        )
          throw new Error(
            `Workflow phase ${record.runId}/${String(record.phaseIndex)} execution does not belong to its run project and session`,
          );
      }
      const currentRow = db
        .prepare("SELECT * FROM workflow_phase_runs WHERE run_id = ? AND phase_index = ?")
        .get(record.runId, record.phaseIndex);
      if (currentRow !== undefined) {
        const current = decodeWorkflowPhaseRun(currentRow);
        const transitions = {
          pending: ["pending", "running", "cancelled"],
          running: ["running", "completed", "failed", "cancelled"],
          completed: ["completed"],
          failed: ["running", "failed", "cancelled"],
          cancelled: ["cancelled"],
        } satisfies Readonly<
          Record<WorkflowPhaseRunRecord["status"], readonly WorkflowPhaseRunRecord["status"][]>
        >;
        if (!permitsTransition(transitions, current.status, record.status))
          throw new Error(`Invalid workflow-phase transition ${current.status} -> ${record.status}`);
        if (current.phaseName !== record.phaseName)
          throw new Error(`Workflow phase ${record.runId}/${String(record.phaseIndex)} changed its name`);
        if (record.attempt < current.attempt || record.attempt > current.attempt + 1)
          throw new Error(
            `Workflow phase ${record.runId}/${String(record.phaseIndex)} has an invalid attempt`,
          );
        if (
          (current.status === "completed" || current.status === "cancelled") &&
          !isDeepStrictEqual(JSON.parse(JSON.stringify(current)), JSON.parse(JSON.stringify(record)))
        )
          throw new Error(
            `Terminal workflow phase ${record.runId}/${String(record.phaseIndex)} is immutable`,
          );
      }
      db.prepare(`INSERT INTO workflow_phase_runs(
          run_id, phase_index, phase_name, status, attempt, logical_execution_id,
          input_json, output_json,
          execution_id, error, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, phase_index) DO UPDATE SET
          status = excluded.status, attempt = excluded.attempt,
          logical_execution_id = excluded.logical_execution_id,
          input_json = excluded.input_json, output_json = excluded.output_json,
          execution_id = excluded.execution_id, error = excluded.error,
          started_at = excluded.started_at, completed_at = excluded.completed_at`).run(
        record.runId,
        record.phaseIndex,
        record.phaseName,
        record.status,
        record.attempt,
        record.logicalExecutionId ?? null,
        JSON.stringify(record.input),
        record.output === undefined ? null : JSON.stringify(record.output),
        record.executionId ?? null,
        record.error ?? null,
        record.startedAt ?? null,
        record.completedAt ?? null,
      );
      recordActivity(systemActor, `workflow_phase.${record.status}`, "workflow_run", record.runId);
    });
  };
  const putOutcome = async (record: OutcomeRecord): Promise<void> => {
    database.transaction(() => {
      const existingRow = db.prepare("SELECT * FROM outcomes WHERE outcome_id = ?").get(record.outcomeId);
      if (existingRow !== undefined) {
        const existing = decodeOutcome(existingRow);
        const { createdAt: _existingCreatedAt, ...existingIdentity } = existing;
        const { createdAt: _recordCreatedAt, ...recordIdentity } = record;
        if (!isDeepStrictEqual(existingIdentity, recordIdentity))
          throw new Error(`Outcome ${record.outcomeId} already exists with different durable meaning`);
        return;
      }
      db.prepare(`INSERT INTO outcomes(
          outcome_id, session_id, turn_id, status, summary, sensitivity, created_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        record.outcomeId,
        record.sessionId,
        record.turnId ?? null,
        record.status,
        record.summary,
        record.sensitivity,
        record.createdAt,
        JSON.stringify(record.metadata),
      );
      recordActivity(systemActor, "outcome.record", "outcome", record.outcomeId);
    });
  };
  const classifyOutcome = async (value: ClassifyOutcomeRequest): Promise<OutcomeRecord> => {
    const request = ClassifyOutcomeRequestSchema.parse(value);
    return database.transaction(() => {
      const row = db.prepare("SELECT * FROM outcomes WHERE outcome_id = ?").get(request.outcomeId);
      if (row === undefined) throw new Error(`Outcome ${request.outcomeId} does not exist`);
      const outcome = decodeOutcome(row);
      if (outcome.sessionId !== request.sessionId || outcome.turnId !== request.turnId)
        throw new Error(`Outcome ${request.outcomeId} does not belong to the classified turn`);
      const recordedValue = outcome.metadata["semanticObservation"];
      const recorded = OutcomeSemanticObservationSchema.safeParse(recordedValue);
      if (Object.hasOwn(outcome.metadata, "semanticObservation") && !recorded.success)
        throw new Error(`Outcome ${request.outcomeId} has malformed semantic classification metadata`);
      if (recorded.success) {
        if (recorded.data.kind !== request.classification)
          throw new Error(`Outcome ${request.outcomeId} has a conflicting semantic classification`);
        return outcome;
      }
      if (outcome.status !== "unknown")
        throw new Error(`Outcome ${request.outcomeId} cannot be classified from ${outcome.status}`);
      const status = request.classification === "correction" ? "corrected" : "unknown";
      const metadata = Object.freeze({
        ...outcome.metadata,
        semanticObservation: Object.freeze({
          kind: request.classification,
          reason: request.reason,
        }),
      });
      const changed = db
        .prepare(`UPDATE outcomes
           SET status = ?, metadata_json = ?
           WHERE outcome_id = ? AND session_id = ? AND turn_id = ? AND status = 'unknown'`)
        .run(status, JSON.stringify(metadata), request.outcomeId, request.sessionId, request.turnId);
      if (changed.changes !== 1)
        throw new Error(`Outcome ${request.outcomeId} changed before semantic classification`);
      recordActivity(systemActor, "outcome.classified", "outcome", request.outcomeId);
      return decodeOutcome(db.prepare("SELECT * FROM outcomes WHERE outcome_id = ?").get(request.outcomeId));
    });
  };
  const putSearchConfiguration = async (configuration: SearchConfiguration): Promise<DatabaseRowRef> => {
    SearchConfigurationSchema.parse(configuration);
    database.transaction(() => {
      db.prepare(`UPDATE search_configuration SET
          lexical_limit = ?, semantic_limit = ?, rerank_limit = ?, max_excerpt_chars = ?,
          include_private = ?, updated_at = ? WHERE configuration_id = 'default'`).run(
        configuration.lexicalLimit,
        configuration.semanticLimit,
        configuration.rerankLimit,
        configuration.maxExcerptChars,
        configuration.includePrivate ? 1 : 0,
        configuration.updatedAt,
      );
      recordActivity(systemActor, "search.configuration_put", "search_configuration", "default");
    });
    return databaseRef("search_configuration", "default");
  };
  return Object.freeze({
    contextCheckpoints: Object.freeze({
      get: getContextCheckpoint,
      getActive: getActiveContextCheckpoint,
      activate: activateContextCheckpoint,
    }),
    foregroundTurns: Object.freeze({
      get: async (turnId: string) => {
        const row = db.prepare("SELECT * FROM foreground_turns WHERE turn_id = ?").get(turnId);
        if (row === undefined) return undefined;
        const outcomeId = optionalString(row, "outcome_id");
        const settledAt = optionalString(row, "settled_at");
        // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
        return Object.freeze(
          createConditionalObject({
            turnId: requiredString(row, "turn_id"),
            sessionId: requiredString(row, "session_id"),
            planId: requiredString(row, "plan_id"),
            status: z
              .enum(["running", "completed", "aborted", "failed"])
              .parse(requiredString(row, "status")),
          } as const)
            .addOptional(outcomeId ? { outcomeId } : undefined)
            .add({
              admittedAt: requiredString(row, "admitted_at"),
            } as const)
            .addOptional(settledAt ? { settledAt } : undefined)
            .finish(),
        );
      },
      settle: async (
        request: Parameters<NoesisWorkspaceStore["operational"]["foregroundTurns"]["settle"]>[0],
      ) => {
        database.transaction(() => {
          const turn = db
            .prepare("SELECT session_id, status FROM foreground_turns WHERE turn_id = ?")
            .get(request.turnId);
          // Isolated package tests may settle a synthetic plan without admission. Production
          // always has the row because plan admission and the running marker share a transaction.
          if (turn === undefined) return;
          if (requiredString(turn, "status") !== "running")
            throw new Error(`Foreground turn ${request.turnId} is already terminal`);
          const outcome = db
            .prepare("SELECT session_id FROM outcomes WHERE outcome_id = ? AND turn_id = ?")
            .get(request.outcomeId, request.turnId);
          if (
            outcome === undefined ||
            requiredString(outcome, "session_id") !== requiredString(turn, "session_id")
          )
            throw new Error(`Foreground turn ${request.turnId} has no matching durable outcome`);
          db.prepare(`UPDATE foreground_turns
             SET status = ?, outcome_id = ?, settled_at = ?
             WHERE turn_id = ? AND status = 'running'`).run(
            request.status,
            request.outcomeId,
            request.settledAt,
            request.turnId,
          );
          db.prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE session_id = ?").run(
            request.status === "completed" ? "idle" : request.status === "aborted" ? "aborted" : "failed",
            request.settledAt,
            requiredString(turn, "session_id"),
          );
          recordActivity(
            systemActor,
            `foreground_turn.${request.status}`,
            "foreground_turn",
            request.turnId,
            [request.outcomeId],
          );
        });
      },
    }),
    sessions: Object.freeze({
      get: async (sessionId: string) =>
        decodeOptional(
          db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId),
          decodeSession,
        ),
      sensitivity: async (sessionId: string) => sessionSensitivity(db, sessionId),
      put: putSession,
      list: async () =>
        db.prepare("SELECT * FROM sessions ORDER BY created_at, session_id").all().map(decodeSession),
    }),
    messages: Object.freeze({
      get: async (messageId: string) =>
        decodeOptional(
          db
            .prepare(`SELECT m.*, timeline.timeline_sequence
               FROM messages AS m
               LEFT JOIN turn_timeline_entries AS timeline
                 ON timeline.entry_kind = 'message' AND timeline.entry_id = m.message_id
               WHERE m.message_id = ?`)
            .get(messageId),
          decodeMessage,
        ),
      put: putMessage,
      listForSession: async (sessionId: string) =>
        db
          .prepare(`SELECT m.*, timeline.timeline_sequence
             FROM messages AS m
             LEFT JOIN turn_timeline_entries AS timeline
               ON timeline.entry_kind = 'message' AND timeline.entry_id = m.message_id
             WHERE m.session_id = ? ORDER BY m.created_at, m.rowid`)
          .all(sessionId)
          .map(decodeMessage),
    }),
    userIntents: Object.freeze({
      enqueue: enqueueUserIntent,
      reroutePending: reroutePendingUserIntents,
      enqueueAndPromoteToSteer: enqueueAndPromoteUserIntentToSteer,
      holdExplicitSteer: holdExplicitUserIntentSteer,
      holdNewestPendingToSteer: holdNewestPendingUserIntentToSteer,
      activateHeldSteer: activateHeldUserIntentSteer,
      releaseHeldSteer: releaseHeldUserIntentSteer,
      listPending: async (sessionId: string) =>
        db
          .prepare(`SELECT *
             FROM user_intents
             WHERE session_id = ? AND status = 'pending'
             ORDER BY queue_sequence`)
          .all(sessionId)
          .map(decodeUserIntent),
      listHeld: async (sessionId: string) =>
        db
          .prepare(`SELECT *
             FROM user_intents
             WHERE session_id = ? AND status = 'held'
             ORDER BY queue_sequence`)
          .all(sessionId)
          .map(decodeUserIntent),
      listUnresolved: async (sessionId: string) =>
        db
          .prepare(`SELECT *
             FROM user_intents
             WHERE session_id = ? AND status = 'unresolved'
             ORDER BY queue_sequence`)
          .all(sessionId)
          .map(decodeUserIntent),
      claimOldestPending: claimOldestPendingUserIntent,
      promoteNewestPendingToSteer: promoteNewestPendingUserIntent,
      withdraw: withdrawUserIntent,
      withdrawUnconsumedSteerDispatch,
      markDelivered: markUserIntentDelivered,
      recordSteerDelivery,
      markUnresolved: markUserIntentUnresolved,
      releaseUnconsumedDispatch: releaseUnconsumedUserIntentDispatch,
      recoverDispatching: recoverDispatchingUserIntents,
    }),
    toolCalls: Object.freeze({
      get: async (toolCallId: string) =>
        decodeOptional(
          db
            .prepare(`SELECT calls.*, timeline.timeline_sequence
               FROM tool_calls AS calls
               LEFT JOIN turn_timeline_entries AS timeline
                 ON timeline.entry_kind = 'tool_call' AND timeline.entry_id = calls.tool_call_id
               WHERE calls.tool_call_id = ?`)
            .get(toolCallId),
          decodeToolCall,
        ),
      put: putToolCall,
      listForSession: async (sessionId: string) =>
        db
          .prepare(`SELECT calls.*, timeline.timeline_sequence
             FROM tool_calls AS calls
             LEFT JOIN turn_timeline_entries AS timeline
               ON timeline.entry_kind = 'tool_call' AND timeline.entry_id = calls.tool_call_id
             WHERE calls.session_id = ? ORDER BY calls.created_at, calls.tool_call_id`)
          .all(sessionId)
          .map(decodeToolCall),
      listForTurn: async (sessionId: string, turnId: string) =>
        db
          .prepare(`SELECT calls.*, timeline.timeline_sequence
             FROM tool_calls AS calls
             LEFT JOIN turn_timeline_entries AS timeline
               ON timeline.entry_kind = 'tool_call' AND timeline.entry_id = calls.tool_call_id
             WHERE calls.session_id = ? AND calls.turn_id = ?
             ORDER BY calls.action_sequence, calls.tool_call_id`)
          .all(sessionId, turnId)
          .map(decodeToolCall),
      listForExecution: async (executionId: string) =>
        db
          .prepare(`SELECT calls.*, timeline.timeline_sequence
             FROM tool_calls AS calls
             LEFT JOIN turn_timeline_entries AS timeline
               ON timeline.entry_kind = 'tool_call' AND timeline.entry_id = calls.tool_call_id
             WHERE calls.execution_id = ?
                OR json_extract(calls.request_json, '$.executionId') = ?
             ORDER BY calls.created_at, calls.tool_call_id`)
          .all(executionId, executionId)
          .map(decodeToolCall),
      interruptRunningForTurn: async (turnId: string, interruptedAt: string) =>
        database.transaction(() => {
          const running = db
            .prepare(`SELECT tool_call_id
               FROM tool_calls
               WHERE turn_id = ? AND status IN ('requested', 'running')`)
            .all(turnId);
          for (const row of running) {
            const toolCallId = requiredString(row, "tool_call_id");
            db.prepare(`UPDATE tool_calls
               SET status = 'failed',
                   response_json = '{"error":"Turn interrupted","reason":"interrupted"}',
                   completed_at = ?
               WHERE tool_call_id = ? AND status IN ('requested', 'running')`).run(interruptedAt, toolCallId);
            recordActivity(systemActor, "tool_call.interrupted", "tool_call", toolCallId);
          }
          return running.length;
        }),
    }),
    codeExecutions: Object.freeze({
      get: async (executionId: string) =>
        decodeOptional(
          db.prepare("SELECT * FROM codemode_executions WHERE execution_id = ?").get(executionId),
          decodeCodeExecution,
        ),
      put: putCodeExecution,
      listForSession: async (sessionId: string) =>
        db
          .prepare("SELECT * FROM codemode_executions WHERE session_id = ? ORDER BY started_at, execution_id")
          .all(sessionId)
          .map(decodeCodeExecution),
      interruptRunning: async (interruptedAt: string) =>
        database.transaction(() => {
          const running = db
            .prepare("SELECT execution_id FROM codemode_executions WHERE status = 'running'")
            .all();
          for (const row of running) {
            const executionId = requiredString(row, "execution_id");
            db.prepare(`UPDATE codemode_executions
               SET status = 'interrupted', error = 'Process exited before execution settled',
                   completed_at = ?
               WHERE execution_id = ? AND status = 'running'`).run(interruptedAt, executionId);
            recordActivity(systemActor, "codemode_execution.interrupted", "codemode_execution", executionId);
          }
          return running.length;
        }),
    }),
    modelCalls: Object.freeze({
      get: async (modelCallId: string) =>
        decodeOptional(
          db.prepare("SELECT * FROM model_calls WHERE model_call_id = ?").get(modelCallId),
          decodeModelCall,
        ),
      put: putModelCall,
      listForExecution: async (executionId: string) =>
        db
          .prepare(
            "SELECT * FROM model_calls WHERE parent_execution_id = ? ORDER BY started_at, model_call_id",
          )
          .all(executionId)
          .map(decodeModelCall),
      listForSession: async (sessionId: string) =>
        db
          .prepare("SELECT * FROM model_calls WHERE session_id = ? ORDER BY started_at, model_call_id")
          .all(sessionId)
          .map(decodeModelCall),
      interruptRunning: async (interruptedAt: string) =>
        database.transaction(() => {
          const running = db
            .prepare("SELECT model_call_id, parent_execution_id FROM model_calls WHERE status = 'running'")
            .all();
          for (const row of running) {
            const modelCallId = requiredString(row, "model_call_id");
            const parentExecutionId = requiredString(row, "parent_execution_id");
            db.prepare(`UPDATE model_calls
               SET status = 'interrupted', error = 'Process exited before model call outcome was observed', completed_at = ?
               WHERE model_call_id = ? AND status = 'running'`).run(interruptedAt, modelCallId);
            recordActivity(systemActor, "model_call.interrupted", "codemode_execution", parentExecutionId, [
              { modelCallId },
            ]);
          }
          return running.length;
        }),
    }),
    workflows: Object.freeze({
      getRun: async (runId: string) =>
        decodeOptional(
          db.prepare("SELECT * FROM workflow_runs WHERE run_id = ?").get(runId),
          decodeWorkflowRun,
        ),
      putRun: putWorkflowRun,
      claimPausedRun: async (runId: string, sessionId: string, projectId: string, claimedAt: string) =>
        database.transaction(() => {
          const claimed = db
            .prepare(`UPDATE workflow_runs
               SET status = 'running', error = NULL, updated_at = ?, completed_at = NULL
               WHERE run_id = ? AND session_id = ? AND project_id = ?
                 AND status = 'paused'`)
            .run(claimedAt, runId, sessionId, projectId);
          if (Number(claimed.changes) !== 1) return undefined;
          const row = db.prepare("SELECT * FROM workflow_runs WHERE run_id = ?").get(runId);
          if (row === undefined) throw new Error(`Claimed workflow run ${runId} disappeared`);
          recordActivity(systemActor, "workflow_run.claimed", "workflow_run", runId);
          return decodeWorkflowRun(row);
        }),
      listRunsForSession: async (sessionId: string) =>
        db
          .prepare("SELECT * FROM workflow_runs WHERE session_id = ? ORDER BY created_at, run_id")
          .all(sessionId)
          .map(decodeWorkflowRun),
      putPhase: putWorkflowPhase,
      listPhases: async (runId: string) =>
        db
          .prepare("SELECT * FROM workflow_phase_runs WHERE run_id = ? ORDER BY phase_index")
          .all(runId)
          .map(decodeWorkflowPhaseRun),
      interruptRunning: async (interruptedAt: string) =>
        database.transaction(() => {
          const runningPhases = db
            .prepare(`SELECT run_id, phase_index
               FROM workflow_phase_runs
               WHERE status = 'running'`)
            .all();
          for (const row of runningPhases) {
            const runId = requiredString(row, "run_id");
            const phaseIndex = requiredNumber(row, "phase_index");
            db.prepare(`UPDATE workflow_phase_runs
               SET status = 'failed',
                   error = 'Process exited before workflow phase settled',
                   completed_at = ?
               WHERE run_id = ? AND phase_index = ? AND status = 'running'`).run(
              interruptedAt,
              runId,
              phaseIndex,
            );
            recordActivity(systemActor, "workflow_phase.interrupted", "workflow_run", runId, [phaseIndex]);
          }
          const runningRuns = db.prepare("SELECT run_id FROM workflow_runs WHERE status = 'running'").all();
          for (const row of runningRuns) {
            const runId = requiredString(row, "run_id");
            db.prepare(`UPDATE workflow_runs
               SET status = 'paused',
                   error = 'Process exited before workflow settled',
                   updated_at = ?
               WHERE run_id = ? AND status = 'running'`).run(interruptedAt, runId);
            recordActivity(systemActor, "workflow_run.interrupted", "workflow_run", runId);
          }
          return Object.freeze({
            runs: runningRuns.length,
            phases: runningPhases.length,
          });
        }),
    }),
    outcomes: Object.freeze({
      get: async (outcomeId: string) =>
        decodeOptional(
          db.prepare("SELECT * FROM outcomes WHERE outcome_id = ?").get(outcomeId),
          decodeOutcome,
        ),
      put: putOutcome,
      classify: classifyOutcome,
      listForSession: async (sessionId: string) =>
        db
          .prepare("SELECT * FROM outcomes WHERE session_id = ? ORDER BY created_at, outcome_id")
          .all(sessionId)
          .map(decodeOutcome),
    }),
    searchConfiguration: Object.freeze({
      get: async () =>
        decodeSearchConfiguration(
          db.prepare("SELECT * FROM search_configuration WHERE configuration_id = 'default'").get(),
        ),
      put: putSearchConfiguration,
    }),
  });
}
function createResearchRepositories(
  database: WorkspaceDatabase,
  recordActivity: (actor: ActorRef, kind: string, subjectKind: string, subjectId: string) => void,
  now: () => string,
): NoesisWorkspaceStore["research"] {
  const db = database.connection;
  const actor: ActorRef = { actorId: "workspace-store", kind: "system" };
  const immutableInsert = (
    table: "preflight_plans" | "preflight_reports" | "feedback_signals",
    keyColumn: string,
    key: string,
    insert: () => void,
    encoded: string,
  ): void => {
    const existing = db.prepare(`SELECT data_json FROM ${table} WHERE ${keyColumn} = ?`).get(key);
    if (existing !== undefined) {
      if (requiredString(existing, "data_json") !== encoded)
        throw new Error(`Immutable ${table} row ${key} already exists with different data`);
      return;
    }
    insert();
  };
  const insertPreflightReport = (value: PreflightReport): void => {
    const plan = decodeStored(
      db.prepare("SELECT data_json FROM preflight_plans WHERE plan_id = ?").get(value.planId),
      PreflightPlanSchema,
    );
    if (!plan || !preflightReportMatchesPlan(plan, value))
      throw new Error(`Preflight report ${value.preflightId} does not match its plan`);
    for (const trialRef of value.trialRowRefs) {
      if (trialRef.table !== "experiment_trials")
        throw new Error(`Preflight trial reference points to ${trialRef.table}`);
      assertStoredReference(db, trialRef);
      const trial = db
        .prepare("SELECT experiment_id FROM experiment_trials WHERE trial_id = ?")
        .get(trialRef.rowId);
      if (!trial || requiredString(trial, "experiment_id") !== value.experimentId)
        throw new Error(`Preflight trial ${trialRef.rowId} belongs to another experiment`);
    }
    for (const ref of [
      ...value.trialEvidence,
      ...value.judgmentEvidence,
      value.reportEvidence,
      ...value.appliedCriteria.flatMap((criterion) => criterion.evidenceRefs),
      ...value.railChecks.flatMap((rail) => rail.evidenceRefs),
    ])
      assertStoredReference(db, ref);
    const encoded = JSON.stringify(value);
    immutableInsert(
      "preflight_reports",
      "preflight_id",
      value.preflightId,
      () =>
        db
          .prepare(`INSERT INTO preflight_reports(
              preflight_id, experiment_id, plan_id, decision, data_json, created_at,
              approval_required
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(
            value.preflightId,
            value.experimentId,
            value.planId,
            value.decision === "approval_required" ? "inconclusive" : value.decision,
            encoded,
            now(),
            value.decision === "approval_required" ? 1 : 0,
          ),
      encoded,
    );
    recordActivity(actor, "preflight.report_put", "preflight_report", value.preflightId);
  };
  const insertEvaluation = (value: EvaluationRecord): void => {
    for (const ref of value.evidenceRefs) assertStoredReference(db, ref);
    const current = db
      .prepare("SELECT status FROM evaluations WHERE evaluation_id = ?")
      .get(value.evaluationId);
    const encoded = JSON.stringify(value);
    if (current === undefined) {
      db.prepare("INSERT INTO evaluations VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        value.evaluationId,
        value.experimentId,
        value.preflightId,
        value.status,
        encoded,
        now(),
        now(),
      );
    } else {
      const from = requiredString(current, "status");
      if (from !== value.status && !(from === "running" && ["completed", "failed"].includes(value.status)))
        throw new Error(`Invalid evaluation transition ${from} -> ${value.status}`);
      db.prepare(
        "UPDATE evaluations SET status = ?, data_json = ?, updated_at = ? WHERE evaluation_id = ?",
      ).run(value.status, encoded, now(), value.evaluationId);
    }
    recordActivity(actor, "evaluation.put", "evaluation", value.evaluationId);
  };
  return Object.freeze({
    experiments: Object.freeze({
      getExperiment: async (experimentId: string) =>
        decodeExperiment(
          db.prepare("SELECT data_json FROM experiments WHERE experiment_id = ?").get(experimentId),
        ),
      listExperiments: async (
        request: Parameters<NoesisWorkspaceStore["research"]["experiments"]["listExperiments"]>[0],
      ) => {
        if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 1000)
          throw new Error("Experiment list limit must be an integer between 1 and 1000");
        const clauses: string[] = [];
        const values: Array<string | number> = [];
        if (request.status !== undefined) {
          clauses.push("status = ?");
          values.push(request.status);
        }
        if (request.sourceAdjustmentIds !== undefined) {
          const adjustmentIds = z.array(z.string().min(1)).max(1000).parse(request.sourceAdjustmentIds);
          if (adjustmentIds.length === 0) clauses.push("0");
          else {
            clauses.push(
              `json_extract(data_json, '$.sourceAdjustmentId') IN (${adjustmentIds.map(() => "?").join(", ")})`,
            );
            values.push(...adjustmentIds);
          }
        }
        const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
        const rows = db
          .prepare(`SELECT data_json FROM experiments${where} ORDER BY experiment_id LIMIT ?`)
          .all(...values, request.limit);
        return rows.map((row) => {
          const experiment = decodeExperiment(row);
          if (!experiment) throw new Error("Experiment row is missing canonical data");
          return experiment;
        });
      },
      putExperiment: async (experiment: Experiment) => {
        const requested = ExperimentSchema.parse(experiment);
        database.transaction(() => {
          const current = db
            .prepare("SELECT status, data_json FROM experiments WHERE experiment_id = ?")
            .get(requested.experimentId);
          const stored = decodeExperiment(current);
          if (stored !== undefined && stored.sourceAdjustmentId !== requested.sourceAdjustmentId)
            throw new Error(
              `Experiment ${requested.experimentId} cannot change its source working adjustment`,
            );
          const value = ExperimentSchema.parse({
            ...requested,
            evidenceRefs: mergeEvidenceReferences(stored?.evidenceRefs ?? [], requested.evidenceRefs),
            feedbackSignalIds: [
              ...new Set([...(stored?.feedbackSignalIds ?? []), ...requested.feedbackSignalIds]),
            ],
          });
          const encoded = JSON.stringify(value);
          if (
            value.sourceAdjustmentId !== undefined &&
            db
              .prepare("SELECT 1 FROM working_adjustments WHERE adjustment_id = ?")
              .get(value.sourceAdjustmentId) === undefined
          )
            throw new Error(
              `Experiment ${value.experimentId} references unknown source working adjustment ${value.sourceAdjustmentId}`,
            );
          for (const ref of value.evidenceRefs) assertStoredReference(db, ref);
          if (value.preflightRef) assertStoredReference(db, value.preflightRef);
          if (current === undefined) {
            db.prepare("INSERT INTO experiments VALUES (?, ?, ?, ?, ?)").run(
              value.experimentId,
              value.status,
              encoded,
              now(),
              now(),
            );
          } else {
            // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
            const from = requiredString(current, "status") as ExperimentStatus;
            if (from === "completed" && requiredString(current, "data_json") !== encoded)
              throw new Error(`Completed experiment ${value.experimentId} is immutable`);
            if (from !== value.status && !isExperimentTransitionAllowed(from, value.status))
              throw new Error(`Invalid experiment transition ${from} -> ${value.status}`);
            db.prepare(
              "UPDATE experiments SET status = ?, data_json = ?, updated_at = ? WHERE experiment_id = ?",
            ).run(value.status, encoded, now(), value.experimentId);
          }
          recordActivity(actor, "experiment.put", "experiment", value.experimentId);
        });
        return databaseRef("experiments", requested.experimentId);
      },
    }),
    trials: Object.freeze({
      getTrial: async (trialId: string) =>
        decodeStored(
          db.prepare("SELECT data_json FROM experiment_trials WHERE trial_id = ?").get(trialId),
          ExperimentTrialSchema,
        ),
      listTrials: async (experimentId: string) =>
        db
          .prepare("SELECT data_json FROM experiment_trials WHERE experiment_id = ? ORDER BY trial_id")
          .all(experimentId)
          .map((row) => ExperimentTrialSchema.parse(parseJson(requiredString(row, "data_json")))),
      putTrial: async (trial: ExperimentTrial) => {
        const value = ExperimentTrialSchema.parse(trial);
        const encoded = JSON.stringify(value);
        database.transaction(() => {
          for (const ref of [...value.inputRefs, ...value.outputEvidenceRefs, ...value.traceEvidenceRefs])
            assertStoredReference(db, ref);
          const current = db
            .prepare("SELECT status FROM experiment_trials WHERE trial_id = ?")
            .get(value.trialId);
          if (current === undefined) {
            db.prepare("INSERT INTO experiment_trials VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
              value.trialId,
              value.experimentId,
              value.comparisonGroupId,
              value.arm,
              value.status,
              encoded,
              now(),
              now(),
            );
          } else {
            const from = requiredString(current, "status");
            const allowed = {
              planned: ["running", "failed"],
              running: ["completed", "failed"],
              completed: [],
              failed: [],
            } satisfies Readonly<Record<string, readonly string[]>>;
            if (from !== value.status && !permitsTransition(allowed, from, value.status))
              throw new Error(`Invalid trial transition ${from} -> ${value.status}`);
            db.prepare(
              "UPDATE experiment_trials SET status = ?, data_json = ?, updated_at = ? WHERE trial_id = ?",
            ).run(value.status, encoded, now(), value.trialId);
          }
          recordActivity(actor, "trial.put", "experiment_trial", value.trialId);
        });
        return databaseRef("experiment_trials", value.trialId);
      },
    }),
    preflights: Object.freeze({
      getPreflightPlan: async (planId: string) =>
        decodeStored(
          db.prepare("SELECT data_json FROM preflight_plans WHERE plan_id = ?").get(planId),
          PreflightPlanSchema,
        ),
      putPreflightPlan: async (plan: PreflightPlan) => {
        const value = PreflightPlanSchema.parse(plan);
        const encoded = JSON.stringify(value);
        database.transaction(() => {
          for (const ref of value.caseRefs) assertStoredReference(db, ref);
          immutableInsert(
            "preflight_plans",
            "plan_id",
            value.planId,
            () =>
              db
                .prepare("INSERT INTO preflight_plans VALUES (?, ?, ?, ?)")
                .run(value.planId, value.experimentId, encoded, now()),
            encoded,
          );
          recordActivity(actor, "preflight.plan_put", "preflight_plan", value.planId);
        });
        return databaseRef("preflight_plans", value.planId);
      },
      getPreflightReport: async (preflightId: string) =>
        decodeStored(
          db.prepare("SELECT data_json FROM preflight_reports WHERE preflight_id = ?").get(preflightId),
          PreflightReportSchema,
        ),
      putPreflightReport: async (report: PreflightReport) => {
        const value = PreflightReportSchema.parse(report);
        database.transaction(() => insertPreflightReport(value));
        return databaseRef("preflight_reports", value.preflightId);
      },
      completePreflight: async (input: {
        readonly report: PreflightReport;
        readonly evaluation: EvaluationRecord;
      }) => {
        const report = PreflightReportSchema.parse(input.report);
        const evaluation = EvaluationRecordSchema.parse(input.evaluation);
        if (
          evaluation.experimentId !== report.experimentId ||
          evaluation.preflightId !== report.preflightId ||
          !sameCapabilityRevisionRef(evaluation.candidateRevision, report.candidateRevision)
        )
          throw new Error(`Evaluation ${evaluation.evaluationId} does not match its preflight report`);
        database.transaction(() => {
          insertPreflightReport(report);
          insertEvaluation(evaluation);
        });
        return Object.freeze({
          report: databaseRef("preflight_reports", report.preflightId),
          evaluation: databaseRef("evaluations", evaluation.evaluationId),
        });
      },
    }),
    evaluations: Object.freeze({
      getEvaluation: async (evaluationId: string) =>
        decodeStored(
          db.prepare("SELECT data_json FROM evaluations WHERE evaluation_id = ?").get(evaluationId),
          EvaluationRecordSchema,
        ),
      listEvaluations: async (experimentId: string) =>
        db
          .prepare("SELECT data_json FROM evaluations WHERE experiment_id = ? ORDER BY evaluation_id")
          .all(experimentId)
          .map((row) => EvaluationRecordSchema.parse(parseJson(requiredString(row, "data_json")))),
      putEvaluation: async (evaluation: EvaluationRecord) => {
        const value = EvaluationRecordSchema.parse(evaluation);
        database.transaction(() => insertEvaluation(value));
        return databaseRef("evaluations", value.evaluationId);
      },
    }),
    feedbackSignals: Object.freeze({
      getFeedbackSignal: async (signalId: string) =>
        decodeFeedbackSignal(
          db.prepare("SELECT data_json FROM feedback_signals WHERE signal_id = ?").get(signalId),
        ),
      listFeedbackSignals: async (
        request: Parameters<
          NonNullable<NoesisWorkspaceStore["research"]["feedbackSignals"]["listFeedbackSignals"]>
        >[0],
      ) => {
        if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 1000)
          throw new Error("Feedback signal list limit must be an integer between 1 and 1000");
        const experimentId =
          request.experimentId === undefined ? undefined : z.string().min(1).parse(request.experimentId);
        const rows =
          experimentId !== undefined
            ? db
                .prepare(
                  "SELECT data_json FROM feedback_signals WHERE experiment_id = ? ORDER BY created_at DESC, signal_id LIMIT ?",
                )
                .all(experimentId, request.limit)
            : db
                .prepare("SELECT data_json FROM feedback_signals ORDER BY created_at DESC, signal_id LIMIT ?")
                .all(request.limit);
        return Object.freeze(
          rows.map((row) => {
            const signal = decodeFeedbackSignal(row);
            if (!signal) throw new Error("Feedback signal row is missing canonical data");
            return signal;
          }),
        );
      },
      recordFeedbackSignal: async (signal: FeedbackSignal) => {
        const value = FeedbackSignalSchema.parse(signal);
        const encoded = JSON.stringify(value);
        database.transaction(() => {
          for (const ref of value.evidenceRefs) assertStoredReference(db, ref);
          immutableInsert(
            "feedback_signals",
            "signal_id",
            value.signalId,
            () =>
              db
                .prepare("INSERT INTO feedback_signals VALUES (?, ?, ?, ?, ?, ?)")
                .run(
                  value.signalId,
                  value.experimentId ?? null,
                  value.capabilityRevisionId ?? null,
                  value.sensitivity,
                  encoded,
                  now(),
                ),
            encoded,
          );
          recordActivity(actor, "feedback.record", "feedback_signal", value.signalId);
        });
        return databaseRef("feedback_signals", value.signalId);
      },
    }),
  });
}
function createSearchIndex(
  database: WorkspaceDatabase,
  paths: WorkspacePaths,
): NoesisWorkspaceStore["search"] {
  const db = database.connection;
  const sourceRows = async (): Promise<readonly SearchDocument[]> => {
    type ProvenanceResolution = {
      readonly sensitivity: SearchDocument["sensitivity"];
      readonly sessionIds: readonly string[];
    };
    const failClosed: ProvenanceResolution = Object.freeze({ sensitivity: "secret", sessionIds: [] });
    const resolutionMemo = new Map<string, ProvenanceResolution>();
    const resolving = new Set<string>();
    let remainingResolutionNodes = 10000;
    const maxSensitivity = (
      left: SearchDocument["sensitivity"],
      right: SearchDocument["sensitivity"],
    ): SearchDocument["sensitivity"] => {
      if (left === "secret" || right === "secret") return "secret";
      if (left === "private" || right === "private") return "private";
      return "normal";
    };
    const mergeResolutions = (
      base: SearchDocument["sensitivity"],
      resolutions: readonly ProvenanceResolution[],
    ): ProvenanceResolution => {
      let sensitivity = base;
      const sessionIds = new Set<string>();
      for (const resolution of resolutions) {
        sensitivity = maxSensitivity(sensitivity, resolution.sensitivity);
        for (const sessionId of resolution.sessionIds) sessionIds.add(sessionId);
      }
      return Object.freeze({ sensitivity, sessionIds: [...sessionIds].sort() });
    };
    const parseRefs = (raw: unknown): readonly EvidenceRef[] | undefined => {
      const parsed = z.array(EvidenceRefSchema).safeParse(raw);
      return parsed.success ? parsed.data : undefined;
    };
    const resolveRefs = (refs: readonly EvidenceRef[]): ProvenanceResolution =>
      mergeResolutions(
        "normal",
        refs.map((ref) => resolveRef(ref)),
      );
    const resolveFileRevision = (revisionId: string): ProvenanceResolution => {
      const row = db
        .prepare("SELECT sensitivity, provenance_refs_json FROM file_revisions WHERE revision_id = ?")
        .get(revisionId);
      if (row === undefined) return failClosed;
      const sensitivity = SensitivitySchema.safeParse(optionalString(row, "sensitivity") ?? "private");
      const refs = parseRefs(parseJson(requiredString(row, "provenance_refs_json")));
      if (!sensitivity.success || !refs) return failClosed;
      return mergeResolutions(sensitivity.data, [resolveRefs(refs)]);
    };
    const resolveDatabaseRow = (ref: DatabaseRowRef): ProvenanceResolution => {
      if (ref.table === "sessions") {
        const row = db.prepare("SELECT session_id FROM sessions WHERE session_id = ?").get(ref.rowId);
        if (row === undefined) return failClosed;
        return Object.freeze({
          sensitivity: sessionSensitivity(db, ref.rowId) ?? "private",
          sessionIds: [ref.rowId],
        });
      }
      if (ref.table === "messages" || ref.table === "tool_calls" || ref.table === "outcomes") {
        const row = db
          .prepare(
            `SELECT session_id, sensitivity FROM ${ref.table} WHERE ${PRIMARY_KEY_BY_TABLE[ref.table]} = ?`,
          )
          .get(ref.rowId);
        if (row === undefined) return failClosed;
        const sensitivity = SensitivitySchema.safeParse(requiredString(row, "sensitivity"));
        return sensitivity.success
          ? Object.freeze({ sensitivity: sensitivity.data, sessionIds: [requiredString(row, "session_id")] })
          : failClosed;
      }
      if (ref.table === "file_revisions") return resolveFileRevision(ref.rowId);
      if (ref.table === "feedback_signals") {
        const row = db
          .prepare("SELECT sensitivity, data_json FROM feedback_signals WHERE signal_id = ?")
          .get(ref.rowId);
        if (row === undefined) return failClosed;
        const sensitivity = SensitivitySchema.safeParse(requiredString(row, "sensitivity"));
        const feedback = FeedbackSignalSchema.safeParse(parseJson(requiredString(row, "data_json")));
        if (!sensitivity.success || !feedback.success) return failClosed;
        return mergeResolutions(sensitivity.data, [resolveRefs(feedback.data.evidenceRefs)]);
      }
      if (ref.table === "experiments") {
        const row = db.prepare("SELECT data_json FROM experiments WHERE experiment_id = ?").get(ref.rowId);
        if (row === undefined) return failClosed;
        const experiment = ExperimentSchema.safeParse(parseJson(requiredString(row, "data_json")));
        return experiment.success ? resolveRefs(experiment.data.evidenceRefs) : failClosed;
      }
      return failClosed;
    };
    const resolveArtifact = (artifactId: string): ProvenanceResolution => {
      const row = db
        .prepare("SELECT relationship_refs_json FROM artifacts WHERE artifact_id = ?")
        .get(artifactId);
      if (row === undefined) return failClosed;
      const refs = parseRefs(parseJson(requiredString(row, "relationship_refs_json")));
      return refs ? mergeResolutions("private", [resolveRefs(refs)]) : failClosed;
    };
    function resolveRef(ref: EvidenceRef): ProvenanceResolution {
      const key = evidenceReferenceIdentity(ref);
      const memoized = resolutionMemo.get(key);
      if (memoized) return memoized;
      if (remainingResolutionNodes <= 0 || resolving.has(key)) return failClosed;
      remainingResolutionNodes -= 1;
      resolving.add(key);
      let resolution: ProvenanceResolution;
      try {
        if (ref.kind === "file_revision" || ref.kind === "evidence_revision")
          resolution = resolveFileRevision(ref.revisionId);
        else if (ref.kind === "artifact_file") resolution = resolveArtifact(ref.artifactId);
        else resolution = resolveDatabaseRow(ref);
      } catch {
        resolution = failClosed;
      }
      resolving.delete(key);
      resolutionMemo.set(key, resolution);
      return resolution;
    }
    // BOUNDARY: Historical SQLite JSON may predate current evidence-reference schemas.
    const resolveProvenance = (
      baseSensitivity: SearchDocument["sensitivity"],
      rawRefs: unknown,
    ): ProvenanceResolution => {
      const refs = parseRefs(rawRefs);
      return refs ? mergeResolutions(baseSensitivity, [resolveRefs(refs)]) : failClosed;
    };
    const singleSessionId = (resolution: ProvenanceResolution): string | undefined =>
      resolution.sessionIds.length === 1 ? resolution.sessionIds[0] : undefined;
    const documents: SearchDocument[] = [];
    const add = (
      source: CanonicalSearchSource,
      body: string,
      occurredAt: string,
      sensitivity: SearchDocument["sensitivity"],
      sessionId?: string,
    ): void => {
      if (body.length === 0) return;
      const documentId = createHash("sha256").update(JSON.stringify(source)).digest("hex");
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      documents.push(
        createConditionalObject({
          documentId,
          source,
        } as const)
          .addOptional(!(sessionId === undefined) ? { sessionId } : undefined)
          .add({
            sensitivity,
            occurredAt,
            body,
          } as const)
          .finish(),
      );
    };
    for (const row of db.prepare("SELECT * FROM sessions").all())
      add(
        { kind: "database_row", table: "sessions", rowId: requiredString(row, "session_id"), field: "title" },
        requiredString(row, "title"),
        requiredString(row, "updated_at"),
        sessionSensitivity(db, requiredString(row, "session_id")) ?? "private",
        requiredString(row, "session_id"),
      );
    for (const row of db.prepare("SELECT * FROM messages").all())
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      add(
        {
          kind: "database_row",
          table: "messages",
          rowId: requiredString(row, "message_id"),
          field: "content",
        },
        requiredString(row, "content"),
        requiredString(row, "created_at"),
        requiredString(row, "sensitivity") as SearchDocument["sensitivity"],
        requiredString(row, "session_id"),
      );
    for (const row of db
      .prepare(`SELECT * FROM tool_calls
           WHERE status IN ('completed', 'failed', 'denied', 'ambiguous')
             AND tool_name NOT GLOB 'history.*'`)
      .all()) {
      const body = [
        requiredString(row, "tool_name"),
        requiredString(row, "request_json"),
        optionalString(row, "response_json") ?? "",
      ].join("\n");
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      add(
        {
          kind: "database_row",
          table: "tool_calls",
          rowId: requiredString(row, "tool_call_id"),
          field: "trace",
        },
        body,
        requiredString(row, "created_at"),
        requiredString(row, "sensitivity") as SearchDocument["sensitivity"],
        requiredString(row, "session_id"),
      );
    }
    for (const row of db.prepare("SELECT * FROM outcomes").all())
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      add(
        {
          kind: "database_row",
          table: "outcomes",
          rowId: requiredString(row, "outcome_id"),
          field: "summary",
        },
        requiredString(row, "summary"),
        requiredString(row, "created_at"),
        requiredString(row, "sensitivity") as SearchDocument["sensitivity"],
        requiredString(row, "session_id"),
      );
    for (const row of db.prepare("SELECT * FROM experiments WHERE status = 'completed'").all()) {
      const body = requiredString(row, "data_json");
      const experiment = ExperimentSchema.safeParse(parseJson(body));
      const resolution = experiment.success
        ? resolveProvenance("normal", experiment.data.evidenceRefs)
        : failClosed;
      add(
        {
          kind: "database_row",
          table: "experiments",
          rowId: requiredString(row, "experiment_id"),
          field: "data_json",
        },
        body,
        requiredString(row, "updated_at"),
        resolution.sensitivity,
        singleSessionId(resolution),
      );
    }
    for (const row of db.prepare("SELECT * FROM file_revisions").all()) {
      const snapshotPath = requiredString(row, "snapshot_path");
      let body: string;
      try {
        const bytes = await readFile(pathInside(paths.root, snapshotPath));
        if (bytes.includes(0)) continue;
        body = bytes.toString("utf8");
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      const rowSensitivity = SensitivitySchema.safeParse(requiredString(row, "sensitivity"));
      const resolution = rowSensitivity.success
        ? resolveProvenance(rowSensitivity.data, parseJson(requiredString(row, "provenance_refs_json")))
        : failClosed;
      add(
        { kind: "file_revision", revisionId: requiredString(row, "revision_id"), field: "bytes" },
        body,
        requiredString(row, "recorded_at"),
        resolution.sensitivity,
        singleSessionId(resolution),
      );
    }
    return documents.sort((left, right) => left.documentId.localeCompare(right.documentId));
  };
  const insertDocuments = (documents: readonly SearchDocument[]): void => {
    const insertDocument = db.prepare(`INSERT INTO search_documents(
        document_id, source_kind, source_table, source_id, source_field, session_id,
        sensitivity, occurred_at, body, citation_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertFts = db.prepare("INSERT INTO search_fts(document_id, body) VALUES (?, ?)");
    for (const document of documents) {
      insertDocument.run(
        document.documentId,
        document.source.kind,
        document.source.kind === "database_row" ? document.source.table : null,
        document.source.kind === "database_row" ? document.source.rowId : document.source.revisionId,
        document.source.field,
        document.sessionId ?? null,
        document.sensitivity,
        document.occurredAt,
        document.body,
        JSON.stringify(document.source),
      );
      insertFts.run(document.documentId, document.body);
    }
  };
  const listDocuments = async (
    options: {
      readonly includePrivate?: boolean;
      readonly includeSecret?: boolean;
    } = {},
  ) => {
    const rows = db
      .prepare(`SELECT * FROM search_documents
         WHERE (sensitivity = 'normal' OR (? = 1 AND sensitivity = 'private') OR (? = 1 AND sensitivity = 'secret'))
         ORDER BY document_id`)
      .all(options.includePrivate ? 1 : 0, options.includeSecret ? 1 : 0);
    return rows.map(decodeSearchDocument);
  };
  const sourceScopeParameters = (
    value: SearchSourceScope | undefined,
  ): readonly [number, number, number, number] => {
    const scope = value === undefined ? undefined : SearchSourceScopeSchema.parse(value);
    return [
      scope === undefined ? 1 : 0,
      scope === "session_or_outcome" ? 1 : 0,
      scope === "corrected_outcome" ? 1 : 0,
      scope === "completed_experiment" ? 1 : 0,
    ];
  };
  const sourceScopeSql = `(
    ? = 1
    OR (? = 1 AND source_kind = 'database_row' AND source_table IN ('sessions', 'outcomes'))
    OR (? = 1 AND source_kind = 'database_row' AND source_table = 'outcomes'
      AND EXISTS (
        SELECT 1 FROM outcomes
        WHERE outcomes.outcome_id = search_documents.source_id
          AND outcomes.status = 'corrected'
      ))
    OR (? = 1 AND source_kind = 'database_row' AND source_table = 'experiments'
      AND EXISTS (
        SELECT 1 FROM experiments
        WHERE experiments.experiment_id = search_documents.source_id
          AND experiments.status = 'completed'
      ))
  )`;
  return Object.freeze({
    clear: async () => {
      database.transaction(() => {
        db.exec("DELETE FROM search_embeddings; DELETE FROM search_fts; DELETE FROM search_documents;");
      });
    },
    rebuildDocuments: async () => {
      const documents = await sourceRows();
      database.transaction(() => {
        db.exec("DELETE FROM search_embeddings; DELETE FROM search_fts; DELETE FROM search_documents;");
        insertDocuments(documents);
      });
      return documents;
    },
    listDocuments,
    lexicalCandidates: async (
      request: Parameters<NoesisWorkspaceStore["search"]["lexicalCandidates"]>[0],
    ) => {
      const query = ftsQuery(request.query);
      if (query.length === 0 || request.limit <= 0) return [];
      const exactSessionId = request.sessionScope?.kind === "exact" ? request.sessionScope.sessionId : null;
      const previousSessionId =
        request.sessionScope?.kind === "previous" ? request.sessionScope.currentSessionId : null;
      const sourceScope = sourceScopeParameters(request.sourceScope);
      const rows = db
        .prepare(`SELECT search_documents.*, bm25(search_fts) AS rank
           FROM search_fts JOIN search_documents USING(document_id)
           WHERE search_fts MATCH ?
             AND sensitivity != 'secret'
             AND (sensitivity = 'normal' OR ? = 1)
             AND (? IS NULL OR session_id = ?)
             AND (? IS NULL OR (session_id IS NOT NULL AND session_id != ?))
             AND ${sourceScopeSql}
           ORDER BY rank, search_documents.document_id LIMIT ?`)
        .all(
          query,
          request.includePrivate ? 1 : 0,
          exactSessionId,
          exactSessionId,
          previousSessionId,
          previousSessionId,
          ...sourceScope,
          Math.max(0, request.limit),
        );
      return rows.map((row) => ({
        ...decodeSearchDocument(row),
        lexicalScore: 1 / (1 + Math.max(0, requiredNumber(row, "rank"))),
      }));
    },
    putEmbeddings: async (modelId: string, embeddings: ReadonlyMap<string, readonly number[]>) => {
      database.transaction(() => {
        const statement =
          db.prepare(`INSERT INTO search_embeddings(document_id, model_id, dimensions, vector_json)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(document_id, model_id) DO UPDATE SET
             dimensions = excluded.dimensions, vector_json = excluded.vector_json`);
        for (const [documentId, vector] of embeddings) {
          if (vector.length === 0 || vector.some((value) => !Number.isFinite(value)))
            throw new Error(`Invalid embedding for ${documentId}`);
          statement.run(documentId, modelId, vector.length, JSON.stringify(vector));
        }
      });
    },
    semanticCandidates: async (
      request: Parameters<NoesisWorkspaceStore["search"]["semanticCandidates"]>[0],
    ) => {
      if (request.limit <= 0) return [];
      const exactSessionId = request.sessionScope?.kind === "exact" ? request.sessionScope.sessionId : null;
      const previousSessionId =
        request.sessionScope?.kind === "previous" ? request.sessionScope.currentSessionId : null;
      const sourceScope = sourceScopeParameters(request.sourceScope);
      const rows = db
        .prepare(`SELECT search_documents.*, search_embeddings.vector_json
           FROM search_embeddings JOIN search_documents USING(document_id)
           WHERE model_id = ? AND sensitivity != 'secret'
             AND (sensitivity = 'normal' OR ? = 1)
             AND (? IS NULL OR session_id = ?)
             AND (? IS NULL OR (session_id IS NOT NULL AND session_id != ?))
             AND ${sourceScopeSql}`)
        .all(
          request.modelId,
          request.includePrivate ? 1 : 0,
          exactSessionId,
          exactSessionId,
          previousSessionId,
          previousSessionId,
          ...sourceScope,
        );
      return rows
        .map((row): SearchCandidate => ({
          ...decodeSearchDocument(row),
          semanticScore: cosineSimilarity(request.vector, decodeVector(requiredString(row, "vector_json"))),
        }))
        .sort(
          (left, right) =>
            (right.semanticScore ?? 0) - (left.semanticScore ?? 0) ||
            left.documentId.localeCompare(right.documentId),
        )
        .slice(0, request.limit);
    },
    openCanonicalSource: async (source: CanonicalSearchSource) =>
      await openCanonicalSource(db, paths, source),
  });
}
function sessionSensitivity(db: DatabaseSync, sessionId: string): SearchDocument["sensitivity"] | undefined {
  const session = db.prepare("SELECT metadata_json FROM sessions WHERE session_id = ?").get(sessionId);
  if (!session) return undefined;
  const metadata = JsonRecordSchema.parse(parseJson(requiredString(session, "metadata_json")));
  const explicit = SensitivitySchema.safeParse(metadata["sensitivity"]);
  const sensitivities = [
    ...(explicit.success ? [explicit.data] : []),
    ...db
      .prepare(`SELECT sensitivity FROM messages WHERE session_id = ?
         UNION ALL SELECT sensitivity FROM tool_calls WHERE session_id = ?
         UNION ALL SELECT sensitivity FROM outcomes WHERE session_id = ?`)
      .all(sessionId, sessionId, sessionId)
      .map((row) => SensitivitySchema.parse(requiredString(row, "sensitivity"))),
  ];
  if (sensitivities.includes("secret")) return "secret";
  if (sensitivities.includes("private")) return "private";
  if (sensitivities.includes("normal")) return "normal";
  return "private";
}
async function openCanonicalSource(
  db: DatabaseSync,
  paths: WorkspacePaths,
  source: CanonicalSearchSource,
): Promise<string | undefined> {
  if (source.kind === "file_revision") {
    const row = db
      .prepare("SELECT snapshot_path, content_digest FROM file_revisions WHERE revision_id = ?")
      .get(source.revisionId);
    if (row === undefined) return undefined;
    const bytes = await readFile(pathInside(paths.root, requiredString(row, "snapshot_path")));
    if (sha256(bytes) !== requiredString(row, "content_digest"))
      throw new Error(`File revision ${source.revisionId} failed digest verification`);
    return bytes.toString("utf8");
  }
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  const mapping = {
    sessions: { key: "session_id", title: "title" },
    messages: { key: "message_id", content: "content" },
    tool_calls: {
      key: "tool_call_id",
      trace: "tool_name || '\n' || request_json || '\n' || COALESCE(response_json, '')",
    },
    outcomes: { key: "outcome_id", summary: "summary" },
    experiments: { key: "experiment_id", data_json: "data_json" },
  } as const;
  const table = mapping[source.table];
  if (!(source.field in table) || source.field === "key") return undefined;
  const expression = Object.entries(table).find(([field]) => field === source.field)?.[1];
  if (expression === undefined) return undefined;
  const row = db
    .prepare(`SELECT ${expression} AS body FROM ${source.table} WHERE ${table.key} = ?`)
    .get(source.rowId);
  return row === undefined ? undefined : requiredString(row, "body");
}
function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || left.length === 0) return -1;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (const [index, leftValue] of left.entries()) {
    const rightValue = right[index];
    if (rightValue === undefined) return -1;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}
function ftsQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(" OR ");
}
function isMissing(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}
function isAlreadyExists(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "EEXIST";
}
function ignoreMissing(cause: unknown): void {
  if (!isMissing(cause)) throw cause;
}
