import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  ArtifactFileRefSchema,
  declaredAuthorityFor,
  EvaluationRecordSchema,
  ExperimentSchema,
  ExperimentTrialSchema,
  FeedbackSignalSchema,
  FileRevisionRefSchema,
  isExperimentTransitionAllowed,
  PreflightPlanSchema,
  preflightReportMatchesPlan,
  PreflightReportSchema,
  sha256,
  type ActorRef,
  type ArtifactFileRef,
  type DatabaseRowRef,
  type DatabaseTable,
  type DefinitionMetadataCommitRequest,
  type DefinitionMetadataRecord,
  type DefinitionWriteRequest,
  type EvaluationRecord,
  type EvidenceRevisionRef,
  type EvidenceRef,
  type EvidenceKind,
  type EvidenceWriteRequest,
  type Experiment,
  type ExperimentStatus,
  type ExperimentTrial,
  type FeedbackSignal,
  type FileRevisionRef,
  type PreflightPlan,
  type PreflightReport,
} from "@noesis/domain";
import { z } from "zod";
import { createBackup, inspectWorkspaceIntegrity } from "./backup.ts";
import {
  openWorkspaceDatabase,
  optionalString,
  parseJson,
  requiredNumber,
  requiredString,
  type WorkspaceDatabase,
} from "./database.ts";
import { importLegacyWorkspace } from "./importer.ts";
import {
  initializeWorkspaceDirectories,
  pathInside,
  safeRelativePath,
  workspacePaths,
  workspaceRelative,
} from "./paths.ts";
import type {
  ActivationPointerRecord,
  ActivationRecord,
  CanonicalSearchSource,
  JobRecord,
  MessageRecord,
  NoesisWorkspaceStore,
  OutcomeRecord,
  SearchCandidate,
  SearchConfiguration,
  SearchDocument,
  SessionRecord,
  StageDefinitionRequest,
  StagedDefinition,
  ToolCallRecord,
  WorkspacePaths,
} from "./types.ts";

export interface WorkspaceStoreOptions {
  readonly now?: () => string;
  readonly createId?: (prefix: string) => string;
}

const JsonRecordSchema = z.record(z.string(), z.unknown());
const ActorSchema = z.strictObject({
  actorId: z.string().min(1),
  kind: z.enum(["user", "noesis", "external_system", "system"]),
});
const SearchConfigurationSchema = z.strictObject({
  lexicalLimit: z.number().int().min(1).max(1000),
  semanticLimit: z.number().int().min(0).max(1000),
  rerankLimit: z.number().int().min(0).max(100),
  maxExcerptChars: z.number().int().min(32).max(8000),
  includePrivate: z.boolean(),
  updatedAt: z.string().min(1),
});

const databaseRef = <Table extends DatabaseTable>(table: Table, rowId: string): DatabaseRowRef<Table> => ({
  kind: "database_row",
  table,
  rowId,
});

const PRIMARY_KEY_BY_TABLE: Readonly<Record<DatabaseTable, string>> = {
  sessions: "session_id",
  messages: "message_id",
  tool_calls: "tool_call_id",
  jobs: "job_id",
  experiments: "experiment_id",
  experiment_trials: "trial_id",
  feedback_signals: "signal_id",
  preflight_plans: "plan_id",
  preflight_reports: "preflight_id",
  evaluations: "evaluation_id",
  activation_pointers: "pointer_id",
  search_configuration: "configuration_id",
  activity_log: "activity_id",
  file_revisions: "revision_id",
};

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

  const recordActivity = (
    actor: ActorRef,
    activityKind: string,
    subjectKind: string,
    subjectId: string,
    references: unknown = [],
  ): DatabaseRowRef<"activity_log"> => {
    ActorSchema.parse(actor);
    const activityId = createId("activity");
    db.prepare(
      `INSERT INTO activity_log(
        activity_id, actor_id, actor_kind, activity_kind, subject_kind, subject_id, references_json, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
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

  const pathsForDefinition = (
    workingPath: string,
    forcedArea?: "candidate" | "active",
  ): { readonly absolute: string; readonly stored: string } => {
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

  const latestRevisionFor = (workingPath: string): FileRevisionRef | undefined => {
    const row = db
      .prepare(
        `SELECT revision_id, working_path, snapshot_path, content_digest
         FROM file_revisions WHERE working_path = ? ORDER BY recorded_at DESC, revision_id DESC LIMIT 1`,
      )
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
    },
    stageId?: string,
  ): void => {
    db.prepare(
      `INSERT INTO file_revisions(
        revision_id, revision_kind, working_path, snapshot_path, content_digest,
        predecessor_revision_id, actor_id, actor_kind, reason, recorded_at,
        evidence_kind, supersedes_revision_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
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
    database.transaction(() =>
      insertRevision(
        {
          revisionId,
          revisionKind,
          workingPath: target.stored,
          snapshotPath,
          contentDigest,
          actor: request.actor,
          ...(request.reason === undefined ? {} : { reason: request.reason }),
          ...(predecessorRevisionId === undefined ? {} : { predecessorRevisionId }),
        },
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
    return await recordDefinitionBytes(
      {
        workingPath: target.stored,
        bytes,
        actor,
        ...(reason === undefined ? {} : { reason }),
      },
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
    database.transaction(() =>
      insertRevision({
        revisionId,
        revisionKind: "evidence",
        workingPath,
        snapshotPath,
        contentDigest,
        actor: request.actor,
        ...(request.reason === undefined ? {} : { reason: request.reason }),
        ...(request.predecessorRevisionId === undefined
          ? {}
          : { predecessorRevisionId: request.predecessorRevisionId }),
        evidenceKind: request.evidenceKind,
        ...(request.supersedesRevisionId === undefined
          ? {}
          : { supersedesRevisionId: request.supersedesRevisionId }),
      }),
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

  const writeArtifact = async (request: {
    readonly path: string;
    readonly mediaType: string;
    readonly bytes: Uint8Array;
    readonly actor: ActorRef;
    readonly relationshipRefs: readonly (DatabaseRowRef | FileRevisionRef)[];
  }): Promise<ArtifactFileRef> => {
    ActorSchema.parse(request.actor);
    for (const ref of request.relationshipRefs) assertStoredReference(db, ref);
    const artifactAbsolute = pathInside(paths.artifacts, request.path);
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
    const storedPath = workspaceRelative(paths, artifactAbsolute);
    const artifactId = createId("artifact");
    database.transaction(() => {
      db.prepare(
        `INSERT INTO artifacts(
          artifact_id, path, media_type, byte_length, content_digest, actor_id, actor_kind,
          relationship_refs_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        artifactId,
        storedPath,
        request.mediaType,
        bytes.length,
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

  const readVerifiedFile = async (storedPath: string, expectedDigest?: string): Promise<Uint8Array> => {
    const bytes = await readFile(pathInside(paths.root, storedPath));
    if (expectedDigest && sha256(bytes) !== expectedDigest)
      throw new Error(`Immutable file digest mismatch: ${storedPath}`);
    return bytes;
  };

  const resolveRevision = async (revisionId: string): Promise<FileRevisionRef | undefined> => {
    const row = db
      .prepare(
        `SELECT revision_id, working_path, snapshot_path, content_digest
         FROM file_revisions WHERE revision_id = ? AND revision_kind != 'evidence'`,
      )
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
    const staged: StagedDefinition = {
      stageId,
      targetArea: request.targetArea,
      relativePath,
      stagedPath: workspaceRelative(paths, stagedAbsolute),
      contentDigest: sha256(bytes),
      actor: request.actor,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      createdAt: now(),
    };
    database.transaction(() => {
      db.prepare(
        `INSERT INTO staged_definitions(
          stage_id, target_area, relative_path, staged_path, content_digest,
          actor_id, actor_kind, reason, created_at, registered_revision_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      ).run(
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
    return await recordDefinitionBytes(
      {
        workingPath: requiredString(row, "relative_path"),
        bytes,
        actor,
        ...(storedReason === undefined ? {} : { reason: storedReason }),
      },
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
  const operational = createOperationalRepositories(database, recordActivity);
  const definitionMetadata = createDefinitionMetadataRepository(database, recordActivity, now);
  const search = createSearchIndex(database, paths);

  const readDatabaseRow = async (
    ref: DatabaseRowRef,
  ): Promise<Readonly<Record<string, unknown>> | undefined> => {
    const row = db
      .prepare(`SELECT * FROM ${ref.table} WHERE ${PRIMARY_KEY_BY_TABLE[ref.table]} = ?`)
      .get(ref.rowId);
    return row === undefined ? undefined : JsonRecordSchema.parse(row);
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

  return Object.freeze({
    paths,
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
          .prepare(
            `SELECT snapshot_path, content_digest, evidence_kind FROM file_revisions
             WHERE revision_id = ? AND revision_kind = 'evidence'`,
          )
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
    revisions: Object.freeze({ resolveRevision, removeUnregisteredSnapshots }),
    evidence: Object.freeze({ appendEvidence }),
    artifacts: Object.freeze({ writeArtifact }),
    research,
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
    close: () => database.close(),
    unsafeDatabasePathForTesting: paths.database,
    getArtifactMetadata,
  });
}

function createDefinitionMetadataRepository(
  database: WorkspaceDatabase,
  recordActivity: (
    actor: ActorRef,
    activityKind: string,
    subjectKind: string,
    subjectId: string,
    references?: unknown,
  ) => DatabaseRowRef<"activity_log">,
  now: () => string,
): NoesisWorkspaceStore["definitionMetadata"] {
  const db = database.connection;
  const decode = (row: unknown): DefinitionMetadataRecord => {
    const predecessorRevisionId = optionalString(row, "predecessor_revision_id");
    const definitionRevision = decodeFileRevisionRef(row);
    return Object.freeze({
      namespace: requiredString(row, "namespace"),
      definitionId: requiredString(row, "definition_id"),
      revision: requiredNumber(row, "revision"),
      definitionRevision,
      fileRevisionRow: databaseRef("file_revisions", definitionRevision.revisionId),
      activityRow: databaseRef("activity_log", requiredString(row, "activity_id")),
      ...(predecessorRevisionId === undefined ? {} : { predecessorRevisionId }),
    });
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
      .prepare(
        `${selectMetadata}
         JOIN definition_current_pointers AS current
           ON current.namespace = metadata.namespace
          AND current.definition_id = metadata.definition_id
          AND current.revision = metadata.revision
          AND current.definition_revision_id = metadata.definition_revision_id
         WHERE metadata.namespace = ? AND metadata.definition_id = ?`,
      )
      .get(namespace, definitionId);
    return row === undefined ? undefined : decode(row);
  };

  const listCurrent = async (namespace: string): Promise<readonly DefinitionMetadataRecord[]> =>
    db
      .prepare(
        `${selectMetadata}
         JOIN definition_current_pointers AS current
           ON current.namespace = metadata.namespace
          AND current.definition_id = metadata.definition_id
          AND current.revision = metadata.revision
          AND current.definition_revision_id = metadata.definition_revision_id
         WHERE metadata.namespace = ?
         ORDER BY metadata.definition_id`,
      )
      .all(namespace)
      .map(decode);

  const listRevisions = async (
    namespace: string,
    definitionId: string,
  ): Promise<readonly DefinitionMetadataRecord[]> =>
    db
      .prepare(
        `${selectMetadata}
         WHERE metadata.namespace = ? AND metadata.definition_id = ?
         ORDER BY metadata.revision`,
      )
      .all(namespace, definitionId)
      .map(decode);

  const commitRevision = async (
    request: DefinitionMetadataCommitRequest,
  ): Promise<Awaited<ReturnType<NoesisWorkspaceStore["definitionMetadata"]["commitRevision"]>>> => {
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
        .prepare(
          `SELECT revision, definition_revision_id
           FROM definition_current_pointers WHERE namespace = ? AND definition_id = ?`,
        )
        .get(request.namespace, request.definitionId);
      const currentRevisionId =
        current === undefined ? undefined : requiredString(current, "definition_revision_id");
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
      db.prepare(
        `INSERT INTO definition_revision_metadata(
          namespace, definition_id, revision, definition_revision_id,
          predecessor_revision_id, activity_id
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        request.namespace,
        request.definitionId,
        request.revision,
        request.definitionRevision.revisionId,
        currentRevisionId ?? null,
        activityRow.rowId,
      );
      db.prepare(
        `INSERT INTO definition_current_pointers(
          namespace, definition_id, revision, definition_revision_id, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(namespace, definition_id) DO UPDATE SET
          revision = excluded.revision,
          definition_revision_id = excluded.definition_revision_id,
          updated_at = excluded.updated_at`,
      ).run(
        request.namespace,
        request.definitionId,
        request.revision,
        request.definitionRevision.revisionId,
        now(),
      );
      return {
        ok: true,
        value: Object.freeze({
          namespace: request.namespace,
          definitionId: request.definitionId,
          revision: request.revision,
          definitionRevision: Object.freeze({ ...request.definitionRevision }),
          fileRevisionRow: databaseRef("file_revisions", request.definitionRevision.revisionId),
          activityRow,
          ...(currentRevisionId === undefined ? {} : { predecessorRevisionId: currentRevisionId }),
        }),
      };
    });
  };

  return Object.freeze({ getCurrent, listCurrent, listRevisions, commitRevision });
}

function createOperationalRepositories(
  database: WorkspaceDatabase,
  recordActivity: (
    actor: ActorRef,
    activityKind: string,
    subjectKind: string,
    subjectId: string,
    references?: unknown,
  ) => void,
): NoesisWorkspaceStore["operational"] {
  const db = database.connection;
  const systemActor: ActorRef = { actorId: "workspace-store", kind: "system" };
  const putSession = async (record: SessionRecord): Promise<DatabaseRowRef> => {
    database.transaction(() => {
      db.prepare(
        `INSERT INTO sessions(
          session_id, parent_session_id, title, status, provider, model, runtime, created_at, updated_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          title = excluded.title, status = excluded.status, provider = excluded.provider,
          model = excluded.model, runtime = excluded.runtime, updated_at = excluded.updated_at,
          metadata_json = excluded.metadata_json`,
      ).run(
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
      db.prepare(
        `INSERT INTO messages(message_id, session_id, role, content, sensitivity, created_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.messageId,
        record.sessionId,
        record.role,
        record.content,
        record.sensitivity,
        record.createdAt,
        JSON.stringify(record.metadata),
      );
      recordActivity(systemActor, "message.append", "message", record.messageId);
    });
    return databaseRef("messages", record.messageId);
  };
  const putToolCall = async (record: ToolCallRecord): Promise<DatabaseRowRef> => {
    database.transaction(() => {
      const current = db
        .prepare("SELECT status, response_json FROM tool_calls WHERE tool_call_id = ?")
        .get(record.toolCallId);
      if (current !== undefined) {
        const from = requiredString(current, "status");
        const allowed: Readonly<Record<string, readonly ToolCallRecord["status"][]>> = {
          requested: ["running", "completed", "failed", "denied", "ambiguous"],
          running: ["completed", "failed", "denied", "ambiguous"],
          completed: [],
          failed: [],
          denied: [],
          ambiguous: [],
        };
        if (from !== record.status && !allowed[from]?.includes(record.status))
          throw new Error(`Invalid tool-call transition ${from} -> ${record.status}`);
        const nextResponse = record.response === undefined ? undefined : JSON.stringify(record.response);
        if (
          allowed[from]?.length === 0 &&
          (optionalString(current, "response_json") !== nextResponse || from !== record.status)
        )
          throw new Error(`Terminal tool call ${record.toolCallId} is immutable`);
      }
      db.prepare(
        `INSERT INTO tool_calls(
          tool_call_id, session_id, message_id, tool_name, request_json, response_json,
          status, sensitivity, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tool_call_id) DO UPDATE SET
          response_json = excluded.response_json, status = excluded.status,
          completed_at = excluded.completed_at`,
      ).run(
        record.toolCallId,
        record.sessionId,
        record.messageId ?? null,
        record.toolName,
        JSON.stringify(record.request),
        record.response === undefined ? null : JSON.stringify(record.response),
        record.status,
        record.sensitivity,
        record.createdAt,
        record.completedAt ?? null,
      );
      recordActivity(systemActor, "tool_call.put", "tool_call", record.toolCallId);
    });
    return databaseRef("tool_calls", record.toolCallId);
  };
  const putOutcome = async (record: OutcomeRecord): Promise<void> => {
    database.transaction(() => {
      db.prepare(
        `INSERT INTO outcomes(
          outcome_id, session_id, turn_id, status, summary, sensitivity, created_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
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
  const putJob = async (record: JobRecord): Promise<DatabaseRowRef> => {
    database.transaction(() => {
      const current = db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(record.jobId);
      if (current !== undefined) {
        const from = requiredString(current, "status");
        const allowed: Readonly<Record<string, readonly JobRecord["status"][]>> = {
          scheduled: ["running", "failed", "cancelled", "budget_exhausted"],
          running: ["completed", "failed", "cancelled", "budget_exhausted"],
          completed: [],
          failed: [],
          cancelled: [],
          budget_exhausted: [],
        };
        if (from !== record.status && !allowed[from]?.includes(record.status))
          throw new Error(`Invalid job transition ${from} -> ${record.status}`);
        if (allowed[from]?.length === 0 && JSON.stringify(decodeJob(current)) !== JSON.stringify(record))
          throw new Error(`Terminal job ${record.jobId} is immutable`);
      }
      db.prepare(
        `INSERT INTO jobs(
          job_id, kind, payload_json, status, lease_owner, lease_until, attempt,
          budget_remaining, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET
          payload_json = excluded.payload_json, status = excluded.status,
          lease_owner = excluded.lease_owner, lease_until = excluded.lease_until,
          attempt = excluded.attempt, budget_remaining = excluded.budget_remaining,
          updated_at = excluded.updated_at`,
      ).run(
        record.jobId,
        record.kind,
        JSON.stringify(record.payload),
        record.status,
        record.leaseOwner ?? null,
        record.leaseUntil ?? null,
        record.attempt,
        record.budgetRemaining,
        record.createdAt,
        record.updatedAt,
      );
      recordActivity(systemActor, "job.put", "job", record.jobId);
    });
    return databaseRef("jobs", record.jobId);
  };
  const putActivation = async (record: ActivationRecord): Promise<void> => {
    database.transaction(() => {
      db.prepare(
        `INSERT INTO activations(
          activation_id, revision, previous_activation_id, definitions_json,
          capability_revisions_json, preflight_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.activationId,
        record.revision,
        record.previousActivationId,
        JSON.stringify(record.activeDefinitions),
        JSON.stringify(record.activeCapabilityRevisions),
        record.preflightId ?? null,
        record.createdAt,
      );
      recordActivity(systemActor, "activation.record", "activation", record.activationId);
    });
  };
  const putPointer = async (record: ActivationPointerRecord): Promise<DatabaseRowRef> => {
    database.transaction(() => {
      db.prepare(
        `INSERT INTO activation_pointers(
          pointer_id, capability_id, activation_id, capability_revision_id, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(capability_id) DO UPDATE SET
          pointer_id = excluded.pointer_id, activation_id = excluded.activation_id,
          capability_revision_id = excluded.capability_revision_id, updated_at = excluded.updated_at`,
      ).run(
        record.pointerId,
        record.capabilityId,
        record.activationId,
        record.capabilityRevisionId,
        record.updatedAt,
      );
      recordActivity(systemActor, "activation.pointer_put", "activation_pointer", record.pointerId);
    });
    return databaseRef("activation_pointers", record.pointerId);
  };
  const putSearchConfiguration = async (configuration: SearchConfiguration): Promise<DatabaseRowRef> => {
    SearchConfigurationSchema.parse(configuration);
    database.transaction(() => {
      db.prepare(
        `UPDATE search_configuration SET
          lexical_limit = ?, semantic_limit = ?, rerank_limit = ?, max_excerpt_chars = ?,
          include_private = ?, updated_at = ? WHERE configuration_id = 'default'`,
      ).run(
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
    sessions: Object.freeze({
      get: async (sessionId: string) =>
        decodeOptional(
          db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId),
          decodeSession,
        ),
      put: putSession,
      list: async () =>
        db.prepare("SELECT * FROM sessions ORDER BY created_at, session_id").all().map(decodeSession),
    }),
    messages: Object.freeze({
      get: async (messageId: string) =>
        decodeOptional(
          db.prepare("SELECT * FROM messages WHERE message_id = ?").get(messageId),
          decodeMessage,
        ),
      put: putMessage,
      listForSession: async (sessionId: string) =>
        db
          .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at, message_id")
          .all(sessionId)
          .map(decodeMessage),
    }),
    toolCalls: Object.freeze({
      get: async (toolCallId: string) =>
        decodeOptional(
          db.prepare("SELECT * FROM tool_calls WHERE tool_call_id = ?").get(toolCallId),
          decodeToolCall,
        ),
      put: putToolCall,
      listForSession: async (sessionId: string) =>
        db
          .prepare("SELECT * FROM tool_calls WHERE session_id = ? ORDER BY created_at, tool_call_id")
          .all(sessionId)
          .map(decodeToolCall),
    }),
    outcomes: Object.freeze({
      get: async (outcomeId: string) =>
        decodeOptional(
          db.prepare("SELECT * FROM outcomes WHERE outcome_id = ?").get(outcomeId),
          decodeOutcome,
        ),
      put: putOutcome,
      listForSession: async (sessionId: string) =>
        db
          .prepare("SELECT * FROM outcomes WHERE session_id = ? ORDER BY created_at, outcome_id")
          .all(sessionId)
          .map(decodeOutcome),
    }),
    jobs: Object.freeze({
      get: async (jobId: string) =>
        decodeOptional(db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId), decodeJob),
      put: putJob,
    }),
    activations: Object.freeze({
      get: async (activationId: string) =>
        decodeOptional(
          db.prepare("SELECT * FROM activations WHERE activation_id = ?").get(activationId),
          decodeActivation,
        ),
      put: putActivation,
      getPointer: async (capabilityId: string) =>
        decodeOptional(
          db.prepare("SELECT * FROM activation_pointers WHERE capability_id = ?").get(capabilityId),
          decodeActivationPointer,
        ),
      putPointer,
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
  return Object.freeze({
    experiments: Object.freeze({
      getExperiment: async (experimentId: string) =>
        decodeExperiment(
          db.prepare("SELECT data_json FROM experiments WHERE experiment_id = ?").get(experimentId),
        ),
      putExperiment: async (experiment: Experiment) => {
        const value = ExperimentSchema.parse(experiment);
        const encoded = JSON.stringify(value);
        database.transaction(() => {
          for (const ref of value.evidenceRefs) assertStoredReference(db, ref);
          if (value.preflightRef) assertStoredReference(db, value.preflightRef);
          const current = db
            .prepare("SELECT status, data_json FROM experiments WHERE experiment_id = ?")
            .get(value.experimentId);
          if (current === undefined) {
            db.prepare("INSERT INTO experiments VALUES (?, ?, ?, ?, ?)").run(
              value.experimentId,
              value.status,
              encoded,
              now(),
              now(),
            );
          } else {
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
        return databaseRef("experiments", value.experimentId);
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
            const allowed: Readonly<Record<string, readonly string[]>> = {
              planned: ["running", "failed"],
              running: ["completed", "failed"],
              completed: [],
              failed: [],
            };
            if (from !== value.status && !allowed[from]?.includes(value.status))
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
        const plan = decodeStored(
          db.prepare("SELECT data_json FROM preflight_plans WHERE plan_id = ?").get(value.planId),
          PreflightPlanSchema,
        );
        if (!plan || !preflightReportMatchesPlan(plan, value))
          throw new Error(`Preflight report ${value.preflightId} does not match its plan`);
        const encoded = JSON.stringify(value);
        database.transaction(() => {
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
          immutableInsert(
            "preflight_reports",
            "preflight_id",
            value.preflightId,
            () =>
              db
                .prepare("INSERT INTO preflight_reports VALUES (?, ?, ?, ?, ?, ?)")
                .run(value.preflightId, value.experimentId, value.planId, value.decision, encoded, now()),
            encoded,
          );
          recordActivity(actor, "preflight.report_put", "preflight_report", value.preflightId);
        });
        return databaseRef("preflight_reports", value.preflightId);
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
        const encoded = JSON.stringify(value);
        database.transaction(() => {
          for (const ref of value.evidenceRefs) assertStoredReference(db, ref);
          const current = db
            .prepare("SELECT status FROM evaluations WHERE evaluation_id = ?")
            .get(value.evaluationId);
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
            if (
              from !== value.status &&
              !(from === "running" && ["completed", "failed"].includes(value.status))
            )
              throw new Error(`Invalid evaluation transition ${from} -> ${value.status}`);
            db.prepare(
              "UPDATE evaluations SET status = ?, data_json = ?, updated_at = ? WHERE evaluation_id = ?",
            ).run(value.status, encoded, now(), value.evaluationId);
          }
          recordActivity(actor, "evaluation.put", "evaluation", value.evaluationId);
        });
        return databaseRef("evaluations", value.evaluationId);
      },
    }),
    feedbackSignals: Object.freeze({
      getFeedbackSignal: async (signalId: string) =>
        decodeFeedbackSignal(
          db.prepare("SELECT data_json FROM feedback_signals WHERE signal_id = ?").get(signalId),
        ),
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
      documents.push({
        documentId,
        source,
        ...(sessionId === undefined ? {} : { sessionId }),
        sensitivity,
        occurredAt,
        body,
      });
    };
    for (const row of db.prepare("SELECT * FROM sessions").all())
      add(
        { kind: "database_row", table: "sessions", rowId: requiredString(row, "session_id"), field: "title" },
        requiredString(row, "title"),
        requiredString(row, "updated_at"),
        "normal",
        requiredString(row, "session_id"),
      );
    for (const row of db.prepare("SELECT * FROM messages").all())
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
    for (const row of db.prepare("SELECT * FROM tool_calls").all()) {
      const body = [
        requiredString(row, "tool_name"),
        requiredString(row, "request_json"),
        optionalString(row, "response_json") ?? "",
      ].join("\n");
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
      const workingPath = requiredString(row, "working_path");
      const sensitivity = workingPath.includes("profile-memory")
        ? "private"
        : workingPath.toLowerCase().includes("secret")
          ? "secret"
          : "normal";
      add(
        { kind: "file_revision", revisionId: requiredString(row, "revision_id"), field: "bytes" },
        body,
        requiredString(row, "recorded_at"),
        sensitivity,
      );
    }
    return documents.sort((left, right) => left.documentId.localeCompare(right.documentId));
  };
  const insertDocuments = (documents: readonly SearchDocument[]): void => {
    const insertDocument = db.prepare(
      `INSERT INTO search_documents(
        document_id, source_kind, source_table, source_id, source_field, session_id,
        sensitivity, occurred_at, body, citation_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
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
    options: { readonly includePrivate?: boolean; readonly includeSecret?: boolean } = {},
  ) => {
    const rows = db
      .prepare(
        `SELECT * FROM search_documents
         WHERE (sensitivity = 'normal' OR (? = 1 AND sensitivity = 'private') OR (? = 1 AND sensitivity = 'secret'))
         ORDER BY document_id`,
      )
      .all(options.includePrivate ? 1 : 0, options.includeSecret ? 1 : 0);
    return rows.map(decodeSearchDocument);
  };
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
      const rows = db
        .prepare(
          `SELECT search_documents.*, bm25(search_fts) AS rank
           FROM search_fts JOIN search_documents USING(document_id)
           WHERE search_fts MATCH ?
             AND sensitivity != 'secret'
             AND (sensitivity = 'normal' OR ? = 1)
             AND (? IS NULL OR session_id = ?)
           ORDER BY rank, search_documents.document_id LIMIT ?`,
        )
        .all(
          query,
          request.includePrivate ? 1 : 0,
          request.sessionId ?? null,
          request.sessionId ?? null,
          Math.max(0, request.limit),
        );
      return rows.map((row) => ({
        ...decodeSearchDocument(row),
        lexicalScore: 1 / (1 + Math.max(0, requiredNumber(row, "rank"))),
      }));
    },
    putEmbeddings: async (modelId: string, embeddings: ReadonlyMap<string, readonly number[]>) => {
      database.transaction(() => {
        const statement = db.prepare(
          `INSERT INTO search_embeddings(document_id, model_id, dimensions, vector_json)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(document_id, model_id) DO UPDATE SET
             dimensions = excluded.dimensions, vector_json = excluded.vector_json`,
        );
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
      const rows = db
        .prepare(
          `SELECT search_documents.*, search_embeddings.vector_json
           FROM search_embeddings JOIN search_documents USING(document_id)
           WHERE model_id = ? AND sensitivity != 'secret'
             AND (sensitivity = 'normal' OR ? = 1)
             AND (? IS NULL OR session_id = ?)`,
        )
        .all(
          request.modelId,
          request.includePrivate ? 1 : 0,
          request.sessionId ?? null,
          request.sessionId ?? null,
        );
      return rows
        .map(
          (row): SearchCandidate => ({
            ...decodeSearchDocument(row),
            semanticScore: cosineSimilarity(request.vector, decodeVector(requiredString(row, "vector_json"))),
          }),
        )
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
  const mapping = {
    sessions: { key: "session_id", title: "title" },
    messages: { key: "message_id", content: "content" },
    tool_calls: {
      key: "tool_call_id",
      trace: "tool_name || '\n' || request_json || '\n' || COALESCE(response_json, '')",
    },
    outcomes: { key: "outcome_id", summary: "summary" },
  } as const;
  const table = mapping[source.table];
  if (!(source.field in table) || source.field === "key") return undefined;
  const expression = Reflect.get(table, source.field);
  if (typeof expression !== "string") return undefined;
  const row = db
    .prepare(`SELECT ${expression} AS body FROM ${source.table} WHERE ${table.key} = ?`)
    .get(source.rowId);
  return row === undefined ? undefined : requiredString(row, "body");
}

function decodeFileRevisionRef(row: unknown): FileRevisionRef {
  return FileRevisionRefSchema.parse({
    kind: "file_revision",
    revisionId: requiredString(row, "revision_id"),
    workingPath: requiredString(row, "working_path"),
    snapshotPath: requiredString(row, "snapshot_path"),
    contentDigest: requiredString(row, "content_digest"),
  });
}

function decodeSession(row: unknown): SessionRecord {
  const parentSessionId = optionalString(row, "parent_session_id");
  return {
    sessionId: requiredString(row, "session_id"),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    title: requiredString(row, "title"),
    status: requiredString(row, "status") as SessionRecord["status"],
    provider: requiredString(row, "provider"),
    model: requiredString(row, "model"),
    runtime: requiredString(row, "runtime"),
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at"),
    metadata: JsonRecordSchema.parse(parseJson(requiredString(row, "metadata_json"))),
  };
}

function decodeMessage(row: unknown): MessageRecord {
  return {
    messageId: requiredString(row, "message_id"),
    sessionId: requiredString(row, "session_id"),
    role: requiredString(row, "role") as MessageRecord["role"],
    content: requiredString(row, "content"),
    sensitivity: requiredString(row, "sensitivity") as MessageRecord["sensitivity"],
    createdAt: requiredString(row, "created_at"),
    metadata: JsonRecordSchema.parse(parseJson(requiredString(row, "metadata_json"))),
  };
}

function decodeToolCall(row: unknown): ToolCallRecord {
  const response = optionalString(row, "response_json");
  const messageId = optionalString(row, "message_id");
  const completedAt = optionalString(row, "completed_at");
  return {
    toolCallId: requiredString(row, "tool_call_id"),
    sessionId: requiredString(row, "session_id"),
    ...(messageId === undefined ? {} : { messageId }),
    toolName: requiredString(row, "tool_name"),
    request: parseJson(requiredString(row, "request_json")),
    ...(response === undefined ? {} : { response: parseJson(response) }),
    status: requiredString(row, "status") as ToolCallRecord["status"],
    sensitivity: requiredString(row, "sensitivity") as ToolCallRecord["sensitivity"],
    createdAt: requiredString(row, "created_at"),
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}

function decodeOutcome(row: unknown): OutcomeRecord {
  const turnId = optionalString(row, "turn_id");
  return {
    outcomeId: requiredString(row, "outcome_id"),
    sessionId: requiredString(row, "session_id"),
    ...(turnId === undefined ? {} : { turnId }),
    status: requiredString(row, "status") as OutcomeRecord["status"],
    summary: requiredString(row, "summary"),
    sensitivity: requiredString(row, "sensitivity") as OutcomeRecord["sensitivity"],
    createdAt: requiredString(row, "created_at"),
    metadata: JsonRecordSchema.parse(parseJson(requiredString(row, "metadata_json"))),
  };
}

function decodeJob(row: unknown): JobRecord {
  const leaseOwner = optionalString(row, "lease_owner");
  const leaseUntil = optionalString(row, "lease_until");
  return {
    jobId: requiredString(row, "job_id"),
    kind: requiredString(row, "kind"),
    payload: parseJson(requiredString(row, "payload_json")),
    status: requiredString(row, "status") as JobRecord["status"],
    ...(leaseOwner === undefined ? {} : { leaseOwner }),
    ...(leaseUntil === undefined ? {} : { leaseUntil }),
    attempt: requiredNumber(row, "attempt"),
    budgetRemaining: requiredNumber(row, "budget_remaining"),
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at"),
  };
}

function decodeActivation(row: unknown): ActivationRecord {
  const preflightId = optionalString(row, "preflight_id");
  return {
    activationId: requiredString(row, "activation_id"),
    revision: requiredNumber(row, "revision"),
    previousActivationId: optionalString(row, "previous_activation_id") ?? null,
    activeDefinitions: z
      .record(z.string(), FileRevisionRefSchema)
      .parse(parseJson(requiredString(row, "definitions_json"))),
    activeCapabilityRevisions: z
      .record(z.string(), z.string())
      .parse(parseJson(requiredString(row, "capability_revisions_json"))),
    ...(preflightId === undefined ? {} : { preflightId }),
    createdAt: requiredString(row, "created_at"),
  };
}

function decodeActivationPointer(row: unknown): ActivationPointerRecord {
  return {
    pointerId: requiredString(row, "pointer_id"),
    capabilityId: requiredString(row, "capability_id"),
    activationId: requiredString(row, "activation_id"),
    capabilityRevisionId: requiredString(row, "capability_revision_id"),
    updatedAt: requiredString(row, "updated_at"),
  };
}

function decodeSearchConfiguration(row: unknown): SearchConfiguration {
  return SearchConfigurationSchema.parse({
    lexicalLimit: requiredNumber(row, "lexical_limit"),
    semanticLimit: requiredNumber(row, "semantic_limit"),
    rerankLimit: requiredNumber(row, "rerank_limit"),
    maxExcerptChars: requiredNumber(row, "max_excerpt_chars"),
    includePrivate: requiredNumber(row, "include_private") === 1,
    updatedAt: requiredString(row, "updated_at"),
  });
}

function decodeSearchDocument(row: unknown): SearchDocument {
  const source = z
    .discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("database_row"),
        table: z.enum(["sessions", "messages", "tool_calls", "outcomes"]),
        rowId: z.string(),
        field: z.string(),
      }),
      z.strictObject({
        kind: z.literal("file_revision"),
        revisionId: z.string(),
        field: z.literal("bytes"),
      }),
    ])
    .parse(parseJson(requiredString(row, "citation_json"))) as CanonicalSearchSource;
  const sessionId = optionalString(row, "session_id");
  return {
    documentId: requiredString(row, "document_id"),
    source,
    ...(sessionId === undefined ? {} : { sessionId }),
    sensitivity: requiredString(row, "sensitivity") as SearchDocument["sensitivity"],
    occurredAt: requiredString(row, "occurred_at"),
    body: requiredString(row, "body"),
  };
}

function decodeOptional<T>(row: unknown, decode: (value: unknown) => T): T | undefined {
  return row === undefined ? undefined : decode(row);
}

function decodeStored<T>(row: unknown, schema: z.ZodType<T>): T | undefined {
  return row === undefined ? undefined : schema.parse(parseJson(requiredString(row, "data_json")));
}

function decodeExperiment(row: unknown): Experiment | undefined {
  if (row === undefined) return undefined;
  const parsed = ExperimentSchema.safeParse(parseJson(requiredString(row, "data_json")));
  if (!parsed.success) throw parsed.error;
  // Zod's optional-property inference includes explicit undefined while the domain uses exact optionals.
  return parsed.data as Experiment;
}

function decodeFeedbackSignal(row: unknown): FeedbackSignal | undefined {
  if (row === undefined) return undefined;
  const parsed = FeedbackSignalSchema.safeParse(parseJson(requiredString(row, "data_json")));
  if (!parsed.success) throw parsed.error;
  // Zod's optional-property inference includes explicit undefined while the domain uses exact optionals.
  return parsed.data as FeedbackSignal;
}

function decodeVector(value: string): readonly number[] {
  return z.array(z.number().finite()).min(1).parse(JSON.parse(value));
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

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function ignoreMissing(error: unknown): void {
  if (!isMissing(error)) throw error;
}
