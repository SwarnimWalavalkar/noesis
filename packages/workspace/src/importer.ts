import { readFile, readdir } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createConditionalObject,
  LedgerEventSchema,
  sha256,
  type ActorRef,
  type ArtifactFileRef,
  type DatabaseRowRef,
  type DefinitionWriteRequest,
  type FileRevisionRef,
  type LedgerEvent,
} from "@noesis/domain";
import { z } from "zod";
import type { WorkspaceDatabase } from "./database.ts";
import { optionalString, requiredNumber, requiredString } from "./database.ts";
import type { LegacyImportReport, WorkspacePaths } from "./types.ts";
interface LegacyImporterDependencies {
  readonly legacyRoot: string;
  readonly actor: ActorRef;
  readonly paths: WorkspacePaths;
  readonly database: WorkspaceDatabase;
  readonly now: () => string;
  readonly createId: (prefix: string) => string;
  readonly recordDefinitionBytes: (
    request: DefinitionWriteRequest,
    revisionKind: "definition" | "candidate" | "active",
    forcedArea?: "candidate" | "active",
    writeWorkingFile?: boolean,
    stageId?: string,
  ) => Promise<FileRevisionRef>;
  readonly writeArtifact: (request: {
    readonly path: string;
    readonly mediaType: string;
    readonly bytes: Uint8Array;
    readonly actor: ActorRef;
    readonly relationshipRefs: readonly (DatabaseRowRef | FileRevisionRef)[];
  }) => Promise<ArtifactFileRef>;
}
interface LegacySession {
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly title: string;
  readonly provider: string;
  readonly model: string;
  readonly runtime: string;
  readonly createdAt: string;
  updatedAt: string;
  status: "idle" | "running" | "completed" | "aborted" | "failed";
}
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
export async function importLegacyWorkspace(
  dependencies: LegacyImporterDependencies,
): Promise<LegacyImportReport> {
  const sourceRoot = resolve(dependencies.legacyRoot);
  const sourceId = sha256(sourceRoot);
  const existing = dependencies.database.connection
    .prepare("SELECT report_json FROM import_runs WHERE source_id = ?")
    .get(sourceId);
  if (existing !== undefined) {
    const report = LegacyImportReportSchema.parse(JSON.parse(requiredString(existing, "report_json")));
    return { ...report, alreadyImported: true };
  }
  const warnings: string[] = [];
  const journalPath = join(sourceRoot, "ledger", "events.jsonl");
  const configPath = join(sourceRoot, "config.json");
  const memoryPath = join(sourceRoot, "views", "memory.md");
  const projectionPath = join(sourceRoot, "projections", "noesis.sqlite");
  const journalBytes = await readOptional(journalPath);
  const configBytes = await readOptional(configPath);
  const memoryBytes = await readOptional(memoryPath);
  const projectionBytes = await readOptional(projectionPath);
  const sourceDigest = sha256(
    Buffer.concat([
      journalBytes ?? Buffer.alloc(0),
      configBytes ?? Buffer.alloc(0),
      memoryBytes ?? Buffer.alloc(0),
      projectionBytes ?? Buffer.alloc(0),
    ]),
  );
  const events = parseEvents(journalBytes, warnings);
  const sessions = deriveSessions(events);
  const messages = deriveMessages(events, sessions, warnings);
  const outcomes = deriveOutcomes(events, sessions);
  const toolCalls = deriveToolCalls(events, sessions, warnings);
  const jobs = deriveJobs(events);
  let definitions = 0;
  if (configBytes) {
    await dependencies.recordDefinitionBytes(
      {
        workingPath: "config/noesis.json",
        bytes: configBytes,
        actor: dependencies.actor,
        reason: "legacy import",
      },
      "definition",
    );
    definitions += 1;
  }
  if (memoryBytes) {
    await dependencies.recordDefinitionBytes(
      {
        workingPath: "profile-memory/memory.md",
        bytes: memoryBytes,
        actor: dependencies.actor,
        reason: "legacy import",
        sensitivity: "private",
      },
      "definition",
    );
    definitions += 1;
  }
  const legacyDatabase = openLegacyDatabase(projectionPath);
  try {
    if (legacyDatabase) {
      for (const capability of readLegacyCapabilities(legacyDatabase)) {
        const targetArea = capability.status === "candidate" ? "candidate" : "active";
        await dependencies.recordDefinitionBytes(
          {
            workingPath: join(
              "capabilities",
              `${safeName(capability.capabilityId)}-v${capability.version}.json`,
            ),
            bytes: Buffer.from(`${JSON.stringify(capability, null, 2)}\n`),
            actor: dependencies.actor,
            reason: "legacy SQLite capability import",
          },
          targetArea,
          targetArea,
        );
        definitions += 1;
      }
      for (const job of readLegacyJobs(legacyDatabase)) jobs.set(job.jobId, job);
    }
  } finally {
    legacyDatabase?.close();
  }
  let artifacts = 0;
  const rawPreservation = [
    { source: journalPath, destination: "legacy/ledger/events.jsonl", mediaType: "application/x-ndjson" },
    {
      source: projectionPath,
      destination: "legacy/projections/noesis.sqlite",
      mediaType: "application/vnd.sqlite3",
    },
  ];
  for (const item of rawPreservation) {
    const bytes = await readOptional(item.source);
    if (bytes && !artifactPathExists(dependencies.database.connection, item.destination)) {
      await dependencies.writeArtifact({
        path: item.destination,
        mediaType: item.mediaType,
        bytes,
        actor: dependencies.actor,
        relationshipRefs: [],
      });
      artifacts += 1;
    }
  }
  for (const source of await walkFiles(join(sourceRoot, "artifacts"))) {
    const destination = join("legacy", "artifacts", relative(join(sourceRoot, "artifacts"), source));
    if (artifactPathExists(dependencies.database.connection, destination)) continue;
    await dependencies.writeArtifact({
      path: destination,
      mediaType: "application/octet-stream",
      bytes: await readFile(source),
      actor: dependencies.actor,
      relationshipRefs: [],
    });
    artifacts += 1;
  }
  const importedAt = dependencies.now();
  const report: LegacyImportReport = {
    sourceId,
    alreadyImported: false,
    sessions: sessions.size,
    messages: messages.length,
    toolCalls: toolCalls.length,
    outcomes: outcomes.length,
    jobs: jobs.size,
    definitions,
    artifacts,
    warnings,
  };
  dependencies.database.transaction(() => {
    const db = dependencies.database.connection;
    const insertSession = db.prepare(`INSERT OR IGNORE INTO sessions(
        session_id, parent_session_id, title, status, provider, model, runtime,
        created_at, updated_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const session of sessions.values())
      insertSession.run(
        session.sessionId,
        session.parentSessionId ?? null,
        session.title,
        session.status,
        session.provider,
        session.model,
        session.runtime,
        session.createdAt,
        session.updatedAt,
        JSON.stringify({ importedFrom: "legacy-jsonl" }),
      );
    const insertMessage = db.prepare(`INSERT OR IGNORE INTO messages(
        message_id, session_id, role, content, sensitivity, created_at, metadata_json
      ) VALUES (?, ?, ?, ?, 'normal', ?, ?)`);
    for (const message of messages)
      insertMessage.run(
        message.messageId,
        message.sessionId,
        message.role,
        message.content,
        message.createdAt,
        JSON.stringify({ legacyEventId: message.eventId }),
      );
    const insertOutcome = db.prepare(`INSERT OR IGNORE INTO outcomes(
        outcome_id, session_id, turn_id, status, summary, sensitivity, created_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, 'normal', ?, ?)`);
    for (const outcome of outcomes)
      insertOutcome.run(
        outcome.outcomeId,
        outcome.sessionId,
        outcome.turnId,
        outcome.status,
        outcome.summary,
        outcome.createdAt,
        JSON.stringify({ legacyEventId: outcome.eventId }),
      );
    const insertToolCall = db.prepare(`INSERT OR IGNORE INTO tool_calls(
        tool_call_id, session_id, message_id, tool_name, request_json, response_json,
        action_sequence, status, sensitivity, created_at, completed_at
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 'normal', ?, ?)`);
    const toolCallSequenceBySession = new Map<string, number>();
    for (const toolCall of toolCalls) {
      const sequence = (toolCallSequenceBySession.get(toolCall.sessionId) ?? 0) + 1;
      toolCallSequenceBySession.set(toolCall.sessionId, sequence);
      insertToolCall.run(
        toolCall.toolCallId,
        toolCall.sessionId,
        toolCall.toolName,
        JSON.stringify(toolCall.request),
        toolCall.response === undefined ? null : JSON.stringify(toolCall.response),
        sequence,
        toolCall.status,
        toolCall.createdAt,
        toolCall.completedAt ?? null,
      );
    }
    const insertJob = db.prepare(`INSERT OR IGNORE INTO jobs(
        job_id, kind, payload_json, status, lease_owner, lease_until, attempt,
        budget_remaining, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`);
    for (const job of jobs.values())
      insertJob.run(
        job.jobId,
        job.kind,
        JSON.stringify(job.payload),
        job.status,
        job.leaseUntil ?? null,
        job.attempt,
        job.budgetRemaining,
        job.createdAt,
        job.updatedAt,
      );
    db.prepare(
      "INSERT INTO import_runs(source_id, source_root, source_digest, imported_at, report_json) VALUES (?, ?, ?, ?, ?)",
    ).run(sourceId, sourceRoot, sourceDigest, importedAt, JSON.stringify(report));
    db.prepare(`INSERT INTO activity_log(
        activity_id, actor_id, actor_kind, activity_kind, subject_kind,
        subject_id, references_json, occurred_at
      ) VALUES (?, ?, ?, 'workspace.legacy_imported', 'import_run', ?, '[]', ?)`).run(
      dependencies.createId("activity"),
      dependencies.actor.actorId,
      dependencies.actor.kind,
      sourceId,
      importedAt,
    );
  });
  return report;
}
function parseEvents(bytes: Uint8Array | undefined, warnings: string[]): readonly LedgerEvent[] {
  if (!bytes) {
    warnings.push("Legacy JSONL journal was not found");
    return [];
  }
  const events: LedgerEvent[] = [];
  for (const [index, line] of Buffer.from(bytes).toString("utf8").split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      events.push(LedgerEventSchema.parse(JSON.parse(line)));
    } catch (error) {
      warnings.push(`Skipped invalid legacy journal line ${index + 1}: ${String(error)}`);
    }
  }
  return events;
}
function deriveSessions(events: readonly LedgerEvent[]): Map<string, LegacySession> {
  const sessions = new Map<string, LegacySession>();
  for (const event of events) {
    if (!event.trailId) continue;
    if (event.type === "trail.started" || event.type === "trail.forked") {
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      sessions.set(
        event.trailId,
        createConditionalObject({
          sessionId: event.trailId,
        } as const)
          .addOptional(
            typeof event.payload["parentTrailId"] === "string"
              ? {
                  parentSessionId: event.payload["parentTrailId"],
                }
              : undefined,
          )
          .add({
            title: String(event.payload["title"] ?? "Untitled legacy session"),
            provider: String(event.payload["provider"] ?? ""),
            model: String(event.payload["model"] ?? ""),
            runtime: String(event.payload["runtime"] ?? ""),
            createdAt: event.occurredAt,
            updatedAt: event.occurredAt,
            status: "idle",
          } as const)
          .finish(),
      );
      continue;
    }
    const session = sessions.get(event.trailId);
    if (!session) continue;
    session.updatedAt = event.occurredAt;
    if (event.type === "turn.started") session.status = "running";
    else if (event.type === "trail.aborted") session.status = "aborted";
    else if (event.type === "turn.failed") session.status = "failed";
    else if (event.type === "turn.completed" || event.type === "trail.resumed") session.status = "idle";
  }
  return sessions;
}
function deriveMessages(
  events: readonly LedgerEvent[],
  sessions: ReadonlyMap<string, LegacySession>,
  warnings: string[],
): readonly {
  readonly messageId: string;
  readonly eventId: string;
  readonly sessionId: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly createdAt: string;
}[] {
  const messages = [];
  for (const event of events) {
    if (event.type !== "turn.completed" || !event.trailId || !sessions.has(event.trailId)) continue;
    const input = event.payload["input"];
    const output = event.payload["output"];
    if (typeof input === "string")
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      messages.push({
        messageId: `${event.eventId}:user`,
        eventId: event.eventId,
        sessionId: event.trailId,
        role: "user" as const,
        content: input,
        createdAt: event.occurredAt,
      });
    if (typeof output === "string")
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      messages.push({
        messageId: `${event.eventId}:assistant`,
        eventId: event.eventId,
        sessionId: event.trailId,
        role: "assistant" as const,
        content: output,
        createdAt: event.occurredAt,
      });
    if (typeof input !== "string" && typeof output !== "string")
      warnings.push(`Legacy completed turn ${event.eventId} had no textual input or output`);
  }
  return messages;
}
function deriveOutcomes(events: readonly LedgerEvent[], sessions: ReadonlyMap<string, LegacySession>) {
  return events.flatMap((event) => {
    if (!event.trailId || !sessions.has(event.trailId)) return [];
    if (event.type !== "turn.completed" && event.type !== "turn.failed") return [];
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    return [
      {
        outcomeId: `${event.eventId}:outcome`,
        eventId: event.eventId,
        sessionId: event.trailId,
        turnId: typeof event.payload["turnId"] === "string" ? event.payload["turnId"] : event.eventId,
        status: event.type === "turn.failed" ? ("failed" as const) : ("unknown" as const),
        summary:
          event.type === "turn.failed"
            ? String(event.payload["error"] ?? "Legacy turn failed")
            : String(event.payload["outcome"] ?? "Legacy turn completed"),
        createdAt: event.occurredAt,
      },
    ];
  });
}
function deriveToolCalls(
  events: readonly LedgerEvent[],
  sessions: ReadonlyMap<string, LegacySession>,
  warnings: string[],
) {
  const calls = new Map<
    string,
    {
      toolCallId: string;
      sessionId: string;
      toolName: string;
      request: unknown;
      response?: unknown;
      status: "requested" | "running" | "completed" | "failed" | "denied" | "ambiguous";
      createdAt: string;
      completedAt?: string;
    }
  >();
  for (const event of events) {
    if (!event.type.startsWith("effect.") || !event.trailId || !sessions.has(event.trailId)) continue;
    const identity = String(event.payload["operationId"] ?? event.payload["idempotencyKey"] ?? event.eventId);
    const current = calls.get(identity);
    if (event.type === "effect.requested") {
      calls.set(identity, {
        toolCallId: identity,
        sessionId: event.trailId,
        toolName: String(event.payload["toolName"] ?? event.payload["effect"] ?? "legacy-effect"),
        request: event.payload,
        status: "requested",
        createdAt: event.occurredAt,
      });
    } else if (current) {
      const status =
        event.type === "effect.completed"
          ? "completed"
          : event.type === "effect.failed"
            ? "failed"
            : event.type === "effect.denied"
              ? "denied"
              : "running";
      calls.set(identity, {
        ...current,
        response: event.payload,
        status,
        completedAt: event.occurredAt,
      });
    } else {
      warnings.push(`Skipped unmatched legacy ${event.type} event ${event.eventId}`);
    }
  }
  return [...calls.values()];
}
interface ImportedJob {
  readonly jobId: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly status: "scheduled" | "running" | "completed" | "failed" | "cancelled" | "budget_exhausted";
  readonly leaseUntil?: string;
  readonly attempt: number;
  readonly budgetRemaining: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
function deriveJobs(events: readonly LedgerEvent[]): Map<string, ImportedJob> {
  const jobs = new Map<string, ImportedJob>();
  for (const event of events) {
    if (!event.type.startsWith("job.") || typeof event.payload["jobId"] !== "string") continue;
    const jobId = event.payload["jobId"];
    const current = jobs.get(jobId);
    if (event.type === "job.scheduled") {
      jobs.set(jobId, {
        jobId,
        kind: String(event.payload["kind"] ?? "legacy-job"),
        payload: event.payload,
        status: "scheduled",
        attempt: 0,
        budgetRemaining: Number(event.payload["budget"] ?? 0),
        createdAt: event.occurredAt,
        updatedAt: event.occurredAt,
      });
    } else if (current) {
      const suffix = event.type.slice("job.".length);
      const status = suffix === "lease_acquired" || suffix === "heartbeat" ? "running" : suffix;
      if (["running", "completed", "failed", "budget_exhausted"].includes(status))
        // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
        jobs.set(
          jobId,
          createConditionalObject({
            ...current,
            status: status as ImportedJob["status"],
          } as const)
            .addOptional(
              typeof event.payload["leaseUntil"] === "string"
                ? {
                    leaseUntil: event.payload["leaseUntil"],
                  }
                : undefined,
            )
            .add({
              attempt:
                typeof event.payload["attempt"] === "number" ? event.payload["attempt"] : current.attempt,
              budgetRemaining:
                typeof event.payload["budgetRemaining"] === "number"
                  ? event.payload["budgetRemaining"]
                  : current.budgetRemaining,
              updatedAt: event.occurredAt,
            } as const)
            .finish(),
        );
    }
  }
  return jobs;
}
function openLegacyDatabase(path: string): DatabaseSync | undefined {
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch {
    return undefined;
  }
}
function readLegacyCapabilities(database: DatabaseSync) {
  if (!tableExists(database, "capabilities")) return [];
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return database
    .prepare("SELECT * FROM capabilities ORDER BY capability_id, version")
    .all()
    .map((row) => ({
      capabilityId: requiredString(row, "capability_id"),
      version: requiredNumber(row, "version"),
      name: requiredString(row, "name"),
      status: requiredString(row, "status"),
      manifest: JSON.parse(requiredString(row, "manifest_json")) as unknown,
      score: row["score"],
      updatedAt: requiredString(row, "updated_at"),
    }));
}
function readLegacyJobs(database: DatabaseSync): readonly ImportedJob[] {
  if (!tableExists(database, "jobs")) return [];
  return database
    .prepare("SELECT * FROM jobs ORDER BY job_id")
    .all()
    .map((row) => {
      const leaseUntil = optionalString(row, "lease_until");
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      return createConditionalObject({
        jobId: requiredString(row, "job_id"),
        kind: "legacy-job",
        payload: {
          schedule: requiredString(row, "schedule"),
          grant: JSON.parse(requiredString(row, "grant_json")) as unknown,
        },
        status: normalizeJobStatus(requiredString(row, "status")),
      } as const)
        .addOptional(!(leaseUntil === undefined) ? { leaseUntil } : undefined)
        .add({
          attempt: 0,
          budgetRemaining: requiredNumber(row, "budget_remaining"),
          createdAt: requiredString(row, "updated_at"),
          updatedAt: requiredString(row, "updated_at"),
        } as const)
        .finish();
    });
}
function normalizeJobStatus(value: string): ImportedJob["status"] {
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return ["scheduled", "running", "completed", "failed", "cancelled", "budget_exhausted"].includes(value)
    ? (value as ImportedJob["status"])
    : "failed";
}
function tableExists(database: DatabaseSync, table: string): boolean {
  return (
    database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined
  );
}
function artifactPathExists(database: DatabaseSync, path: string): boolean {
  const normalized = path.split(/[\\/]/u).join("/");
  return (
    database
      .prepare("SELECT 1 FROM artifacts WHERE path = ? OR path = ?")
      .get(path, `artifacts/${normalized}`) !== undefined
  );
}
async function readOptional(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}
async function walkFiles(root: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) files.push(...(await walkFiles(path)));
      else if (entry.isFile()) files.push(path);
    }
    return files;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}
function safeName(value: string): string {
  return basename(value.replaceAll(/[^a-zA-Z0-9._-]/gu, "_")).slice(0, 120) || "capability";
}
