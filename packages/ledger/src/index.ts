import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import {
  assertLedgerEvent,
  createId,
  eventChecksum,
  SCHEMA_VERSION,
  type Clock,
  type EventType,
  type JsonValue,
  type LedgerEvent,
  type Principal,
  systemClock,
} from "@noesis/domain";

export interface LedgerPaths {
  readonly root: string;
  readonly journal: string;
  readonly projection: string;
  readonly artifacts: string;
  readonly views: string;
}

export interface AppendEventInput {
  readonly type: EventType;
  readonly principal: Principal;
  readonly trailId?: string;
  readonly payload?: Readonly<Record<string, JsonValue>>;
}

export interface RecoveryReport {
  readonly events: number;
  readonly truncatedBytes: number;
  readonly lastChecksum: string | null;
}

export interface TrailProjection {
  readonly trailId: string;
  readonly parentTrailId?: string;
  readonly title: string;
  readonly status: string;
  readonly provider: string;
  readonly model: string;
  readonly runtime: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly turnCount: number;
  readonly preview: string;
}

export interface TrailRecency {
  readonly trailId: string;
  readonly updatedAt: string;
}

/** Newest activity first, with a stable trail-ID tie-break. */
export function compareTrailRecency(left: TrailRecency, right: TrailRecency): number {
  return right.updatedAt.localeCompare(left.updatedAt) || left.trailId.localeCompare(right.trailId);
}

/** Maximum number of recent trails exposed to the interactive session picker. */
export const TRAIL_PICKER_LIMIT = 100;

export class LedgerIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerIntegrityError";
  }
}

export class LedgerConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerConflictError";
  }
}

export interface ExperienceLedger {
  readonly paths: LedgerPaths;
  readonly clock: Clock;
  initialize(): Promise<RecoveryReport>;
  recover(): Promise<RecoveryReport>;
  /** Refreshes the in-memory JSONL replay while holding the cooperating writer lock. */
  refresh(): Promise<RecoveryReport>;
  append(input: AppendEventInput, expectedSequence?: number): Promise<LedgerEvent>;
  readAll(): readonly LedgerEvent[];
  eventsForTrail(trailId: string): readonly LedgerEvent[];
  findByType(type: EventType): readonly LedgerEvent[];
  /** Returns at most TRAIL_PICKER_LIMIT trails, newest activity first. */
  listTrailProjections(): readonly TrailProjection[];
  rebuildProjection(): Promise<void>;
}

export function createExperienceLedger(root: string, clock: Clock = systemClock): ExperienceLedger {
  const paths: LedgerPaths = Object.freeze({
    root,
    journal: join(root, "ledger", "events.jsonl"),
    projection: join(root, "projections", "noesis.sqlite"),
    artifacts: join(root, "artifacts", "sha256"),
    views: join(root, "views"),
  });
  let events: LedgerEvent[] = [];
  let trailIds = new Set<string>();
  let writerQueue: Promise<void> = Promise.resolve();

  const initialize = async (): Promise<RecoveryReport> => {
    await Promise.all([
      mkdir(dirname(paths.journal), { recursive: true }),
      mkdir(dirname(paths.projection), { recursive: true }),
      mkdir(paths.artifacts, { recursive: true }),
      mkdir(paths.views, { recursive: true }),
    ]);
    const report = await recover();
    await rebuildProjection();
    return report;
  };

  const recover = async (): Promise<RecoveryReport> => {
    let source = "";
    try {
      source = await readFile(paths.journal, "utf8");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      await writeFile(paths.journal, "", { flag: "wx" }).catch(() => undefined);
    }
    const lines = source.split("\n");
    const hasPartialTail = source.length > 0 && !source.endsWith("\n");
    const parse = (candidateLines: readonly string[]): LedgerEvent[] => {
      const parsed: LedgerEvent[] = [];
      let previous: string | null = null;
      for (const [index, line] of candidateLines.entries()) {
        if (!line.trim()) continue;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch (error) {
          throw new LedgerIntegrityError(`Invalid JSON at journal line ${index + 1}: ${String(error)}`);
        }
        assertLedgerEvent(value);
        if (value.sequence !== parsed.length + 1)
          throw new LedgerIntegrityError(`Sequence gap at ${value.sequence}`);
        if (value.previousChecksum !== previous)
          throw new LedgerIntegrityError(`Broken checksum chain at ${value.sequence}`);
        const { checksum, ...unsigned } = value;
        if (eventChecksum(unsigned) !== checksum)
          throw new LedgerIntegrityError(`Checksum mismatch at ${value.sequence}`);
        parsed.push(value);
        previous = checksum;
      }
      return parsed;
    };
    let parsed: LedgerEvent[];
    let truncatedBytes = 0;
    if (hasPartialTail) {
      const tail = lines.at(-1) ?? "";
      let tailIsComplete = false;
      try {
        JSON.parse(tail);
        tailIsComplete = true;
      } catch (error) {
        if (!isIncompleteJsonTail(tail))
          throw new LedgerIntegrityError(`Malformed complete JSON at journal tail: ${String(error)}`);
      }
      if (tailIsComplete) {
        parsed = parse(lines);
        const handle = await open(paths.journal, "a");
        try {
          await handle.write("\n");
          await handle.sync();
        } finally {
          await handle.close();
        }
      } else {
        const complete = lines.slice(0, -1);
        parsed = parse(complete);
        const valid = complete
          .filter(Boolean)
          .map((line) => `${line}\n`)
          .join("");
        truncatedBytes = Buffer.byteLength(source) - Buffer.byteLength(valid);
        const handle = await open(paths.journal, "r+");
        try {
          await handle.truncate(Buffer.byteLength(valid));
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
    } else {
      parsed = parse(lines);
    }
    events = parsed;
    trailIds = new Set(
      parsed.flatMap((event) =>
        event.trailId && (event.type === "trail.started" || event.type === "trail.forked")
          ? [event.trailId]
          : [],
      ),
    );
    return { events: parsed.length, truncatedBytes, lastChecksum: parsed.at(-1)?.checksum ?? null };
  };

  const append = async (input: AppendEventInput, expectedSequence?: number): Promise<LedgerEvent> => {
    return await withWriter(async () => {
      const release = await acquireProcessLock();
      try {
        await recover();
        if (expectedSequence !== undefined && events.length !== expectedSequence)
          throw new LedgerConflictError(
            `Ledger advanced from expected sequence ${expectedSequence} to ${events.length}`,
          );
        return await appendLocked(input);
      } finally {
        await release();
      }
    });
  };

  const isIncompleteJsonTail = (tail: string): boolean => {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (const character of tail) {
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
      } else if (character === '"') inString = true;
      else if (character === "{" || character === "[") depth += 1;
      else if (character === "}" || character === "]") depth -= 1;
      if (depth < 0) return false;
    }
    return inString || depth > 0;
  };

  const appendLocked = async (input: AppendEventInput): Promise<LedgerEvent> => {
    const last = events.at(-1);
    const unsigned: Omit<LedgerEvent, "checksum"> = {
      schemaVersion: SCHEMA_VERSION,
      eventId: createId("evt"),
      sequence: events.length + 1,
      occurredAt: clock.now().toISOString(),
      principal: input.principal,
      type: input.type,
      ...(input.trailId === undefined ? {} : { trailId: input.trailId }),
      payload: { ...(input.payload ?? {}) },
      previousChecksum: last?.checksum ?? null,
    };
    const event: LedgerEvent = { ...unsigned, checksum: eventChecksum(unsigned) };
    assertLedgerEvent(event);
    const handle = await open(paths.journal, "a");
    try {
      await handle.write(`${JSON.stringify(event)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    events.push(event);
    if (event.trailId && (event.type === "trail.started" || event.type === "trail.forked"))
      trailIds.add(event.trailId);
    project(event);
    return event;
  };

  const withWriter = async <T>(operation: () => Promise<T>): Promise<T> => {
    const prior = writerQueue;
    let release: (() => void) | undefined;
    writerQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await operation();
    } finally {
      release?.();
    }
  };

  const acquireProcessLock = async (): Promise<() => Promise<void>> => {
    const path = `${paths.journal}.writer.lock`;
    const token = createId("writer");
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        const handle = await open(path, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify({ token, pid: process.pid, createdAt: Date.now() }));
          await handle.sync();
        } finally {
          await handle.close();
        }
        return async () => {
          try {
            const current = JSON.parse(await readFile(path, "utf8")) as { token?: unknown };
            if (current.token === token) await unlink(path);
          } catch (error) {
            if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
          }
        };
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
        try {
          const lock = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
          if (typeof lock.pid === "number") {
            try {
              process.kill(lock.pid, 0);
            } catch (probeError) {
              if (probeError instanceof Error && "code" in probeError && probeError.code === "ESRCH") {
                await unlink(path).catch(() => undefined);
                continue;
              }
            }
          }
        } catch {
          // A concurrently created lock can be temporarily unreadable; retry rather than steal it.
        }
        await delay(10);
      }
    }
    throw new LedgerConflictError(`Timed out acquiring journal writer lock ${path}`);
  };

  const refresh = async (): Promise<RecoveryReport> => {
    return await withWriter(async () => {
      const release = await acquireProcessLock();
      try {
        return await recover();
      } finally {
        await release();
      }
    });
  };

  const readAll = (): readonly LedgerEvent[] => events.slice();

  const eventsForTrail = (trailId: string): readonly LedgerEvent[] =>
    events.filter((event) => event.trailId === trailId);

  const findByType = (type: EventType): readonly LedgerEvent[] =>
    events.filter((event) => event.type === type);

  const trailStatusAfter = (event: LedgerEvent, current: string): string => {
    if (event.type === "turn.started") return "running";
    if (event.type === "trail.aborted") return "aborted";
    if (event.type === "turn.failed") return "failed";
    if (
      event.type === "trail.resumed" ||
      event.type === "turn.completed" ||
      event.type === "trail.recovered" ||
      event.type === "trail.compacted"
    )
      return "idle";
    return current;
  };

  const deriveTrailProjections = (): readonly TrailProjection[] => {
    const projections = new Map<string, TrailProjection>();
    for (const event of events) {
      if (!event.trailId || !trailIds.has(event.trailId)) continue;
      if (event.type === "trail.started" || event.type === "trail.forked") {
        projections.set(event.trailId, {
          trailId: event.trailId,
          ...(typeof event.payload["parentTrailId"] === "string"
            ? { parentTrailId: event.payload["parentTrailId"] }
            : {}),
          title: String(event.payload["title"] ?? ""),
          status: "idle",
          provider: String(event.payload["provider"] ?? ""),
          model: String(event.payload["model"] ?? ""),
          runtime: String(event.payload["runtime"] ?? ""),
          createdAt: event.occurredAt,
          updatedAt: event.occurredAt,
          turnCount: 0,
          preview: "",
        });
        continue;
      }
      const current = projections.get(event.trailId);
      if (!current) continue;
      const completed = event.type === "turn.completed";
      projections.set(event.trailId, {
        ...current,
        status: trailStatusAfter(event, current.status),
        updatedAt: event.occurredAt,
        turnCount: current.turnCount + (completed ? 1 : 0),
        preview:
          completed && current.preview.length === 0
            ? String(event.payload["input"] ?? "").slice(0, 240)
            : current.preview,
      });
    }
    return [...projections.values()].sort(compareTrailRecency).slice(0, TRAIL_PICKER_LIMIT);
  };

  const decodeTrailProjection = (value: unknown): TrailProjection | undefined => {
    if (value === null || typeof value !== "object") return undefined;
    const trailId = Reflect.get(value, "trail_id");
    const parentTrailId = Reflect.get(value, "parent_trail_id");
    const title = Reflect.get(value, "title");
    const status = Reflect.get(value, "status");
    const provider = Reflect.get(value, "provider");
    const model = Reflect.get(value, "model");
    const runtime = Reflect.get(value, "runtime");
    const createdAt = Reflect.get(value, "created_at");
    const updatedAt = Reflect.get(value, "updated_at");
    const turnCount = Reflect.get(value, "turn_count");
    const preview = Reflect.get(value, "preview");
    if (
      typeof trailId !== "string" ||
      typeof title !== "string" ||
      typeof status !== "string" ||
      typeof provider !== "string" ||
      typeof model !== "string" ||
      typeof runtime !== "string" ||
      typeof createdAt !== "string" ||
      typeof updatedAt !== "string" ||
      typeof turnCount !== "number" ||
      typeof preview !== "string"
    )
      return undefined;
    return {
      trailId,
      ...(typeof parentTrailId === "string" ? { parentTrailId } : {}),
      title,
      status,
      provider,
      model,
      runtime,
      createdAt,
      updatedAt,
      turnCount,
      preview,
    };
  };

  const listTrailProjections = (): readonly TrailProjection[] => {
    const authoritative = deriveTrailProjections();
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(paths.projection, { readOnly: true });
      const state = database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM events) AS event_count,
             (SELECT checksum FROM events ORDER BY sequence DESC LIMIT 1) AS last_checksum,
             (SELECT COUNT(*) FROM trails) AS trail_count,
             (SELECT COUNT(DISTINCT started.trail_id)
                FROM events AS started
                LEFT JOIN trails ON trails.trail_id = started.trail_id
               WHERE started.event_type IN ('trail.started', 'trail.forked')
                 AND trails.trail_id IS NULL) AS missing_trail_count`,
        )
        .get();
      const eventCount = state && typeof state === "object" ? Reflect.get(state, "event_count") : undefined;
      const lastChecksum =
        state && typeof state === "object" ? Reflect.get(state, "last_checksum") : undefined;
      const projectedTrailCount =
        state && typeof state === "object" ? Reflect.get(state, "trail_count") : undefined;
      const missingTrailCount =
        state && typeof state === "object" ? Reflect.get(state, "missing_trail_count") : undefined;
      if (
        eventCount !== events.length ||
        lastChecksum !== (events.at(-1)?.checksum ?? null) ||
        projectedTrailCount !== trailIds.size ||
        missingTrailCount !== 0
      )
        return authoritative;
      const rows = database
        .prepare(
          `SELECT
             trails.trail_id,
             trails.parent_trail_id,
             trails.title,
             trails.status,
             COALESCE(json_extract(start_event.payload_json, '$.provider'), '') AS provider,
             trails.model,
             trails.runtime,
             start_event.occurred_at AS created_at,
             trails.updated_at,
             (SELECT COUNT(*) FROM events AS completed
               WHERE completed.trail_id = trails.trail_id
                 AND completed.event_type = 'turn.completed') AS turn_count,
             substr(COALESCE((SELECT json_extract(first_turn.payload_json, '$.input')
               FROM events AS first_turn
               WHERE first_turn.trail_id = trails.trail_id
                 AND first_turn.event_type = 'turn.completed'
               ORDER BY first_turn.sequence ASC LIMIT 1), ''), 1, 240) AS preview
           FROM trails
           JOIN events AS start_event
             ON start_event.trail_id = trails.trail_id
            AND start_event.event_type IN ('trail.started', 'trail.forked')
           ORDER BY trails.updated_at DESC,
             trails.trail_id ASC
           LIMIT ?`,
        )
        .all(TRAIL_PICKER_LIMIT);
      const decoded = rows.flatMap((row) => {
        const projection = decodeTrailProjection(row);
        return projection ? [projection] : [];
      });
      return decoded.length === rows.length && JSON.stringify(decoded) === JSON.stringify(authoritative)
        ? decoded
        : authoritative;
    } catch {
      return authoritative;
    } finally {
      database?.close();
    }
  };

  const rebuildProjection = async (): Promise<void> => {
    await mkdir(dirname(paths.projection), { recursive: true });
    const temporary = `${paths.projection}.${createId("rebuild")}.tmp`;
    let database: DatabaseSync | undefined;
    let replaced = false;
    try {
      database = new DatabaseSync(temporary);
      database.exec("PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = ON;");
      const migrationsDir = new URL("../migrations/", import.meta.url);
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
      for (const [index, file] of files.entries()) {
        const version = index + 1;
        database.exec(await readFile(new URL(file, migrationsDir), "utf8"));
        database
          .prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run(version, clock.now().toISOString());
      }
      for (const event of events) projectInto(database, event);
      database.close();
      database = undefined;
      const file = await open(temporary, "r");
      try {
        await file.sync();
      } finally {
        await file.close();
      }
      await Promise.all([
        unlink(`${paths.projection}-wal`).catch(ignoreMissingFile),
        unlink(`${paths.projection}-shm`).catch(ignoreMissingFile),
      ]);
      await rename(temporary, paths.projection);
      replaced = true;
      const directory = await open(dirname(paths.projection), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      try {
        database?.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (!replaced) {
        for (const path of [temporary, `${temporary}-wal`, `${temporary}-shm`]) {
          try {
            await unlink(path);
          } catch (cleanupError) {
            try {
              ignoreMissingFile(cleanupError);
            } catch (unexpectedCleanupError) {
              cleanupErrors.push(unexpectedCleanupError);
            }
          }
        }
      }
      if (cleanupErrors.length > 0)
        throw new AggregateError(
          [error, ...cleanupErrors],
          "Projection rebuild failed and temporary cleanup was incomplete",
          { cause: error },
        );
      throw error;
    }
    await rebuildMemoryMarkdown();
  };

  const ignoreMissingFile = (error: unknown): void => {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  };

  const rebuildMemoryMarkdown = async (): Promise<void> => {
    const records = new Map<string, Readonly<Record<string, JsonValue>>>();
    const superseded = new Set<string>();
    for (const event of events) {
      if (event.type === "memory.recorded") {
        const id = String(event.payload["memoryId"] ?? "");
        records.set(id, event.payload);
        if (typeof event.payload["supersedes"] === "string") superseded.add(event.payload["supersedes"]);
      } else if (event.type === "memory.superseded") {
        superseded.add(String(event.payload["memoryId"] ?? ""));
      }
    }
    const body = [...records.entries()]
      .filter(([id]) => !superseded.has(id))
      .map(([id, memory]) => {
        const evidence = Array.isArray(memory["evidence"])
          ? memory["evidence"]
              .flatMap((item) =>
                item &&
                typeof item === "object" &&
                !Array.isArray(item) &&
                typeof item["eventId"] === "string"
                  ? [`\`${item["eventId"]}\` (${String(item["confidence"] ?? "")})`]
                  : [],
              )
              .join(", ")
          : "";
        return [
          `## ${String(memory["kind"] ?? "memory")}: ${String(memory["content"] ?? "")}`,
          `- id: \`${id}\``,
          `- scope: \`${String(memory["scope"] ?? "")}\``,
          `- evidence: ${evidence}`,
          typeof memory["validUntil"] === "string" ? `- valid until: ${memory["validUntil"]}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n\n");
    await writeFile(join(paths.views, "memory.md"), `# Noesis memory\n\n${body}\n`, "utf8");
  };

  const project = (event: LedgerEvent): void => {
    const database = new DatabaseSync(paths.projection);
    try {
      projectInto(database, event);
    } finally {
      database.close();
    }
  };

  const projectInto = (database: DatabaseSync, event: LedgerEvent): void => {
    const payload = JSON.stringify(event.payload);
    database
      .prepare("INSERT OR IGNORE INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        event.sequence,
        event.eventId,
        event.occurredAt,
        event.principal,
        event.type,
        event.trailId ?? null,
        payload,
        event.checksum,
      );
    database
      .prepare("INSERT INTO event_search(event_id, event_type, trail_id, payload) VALUES (?, ?, ?, ?)")
      .run(event.eventId, event.type, event.trailId ?? "", payload);
    const p = event.payload;
    if (event.type === "trail.started" || event.type === "trail.forked") {
      database
        .prepare("INSERT OR REPLACE INTO trails VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(
          event.trailId ?? "",
          typeof p["parentTrailId"] === "string" ? p["parentTrailId"] : null,
          String(p["title"] ?? ""),
          "idle",
          String(p["model"] ?? ""),
          String(p["runtime"] ?? ""),
          event.occurredAt,
        );
    } else if (event.trailId) {
      const current = database.prepare("SELECT status FROM trails WHERE trail_id = ?").get(event.trailId);
      const currentStatus =
        current !== undefined &&
        typeof current === "object" &&
        typeof Reflect.get(current, "status") === "string"
          ? String(Reflect.get(current, "status"))
          : "idle";
      const status = trailStatusAfter(event, currentStatus);
      database
        .prepare("UPDATE trails SET status = ?, updated_at = ? WHERE trail_id = ?")
        .run(status, event.occurredAt, event.trailId);
    }
    if (event.type === "memory.recorded") {
      database
        .prepare("INSERT OR REPLACE INTO memories VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(
          String(p["memoryId"] ?? ""),
          String(p["kind"] ?? ""),
          String(p["content"] ?? ""),
          JSON.stringify(p["evidence"] ?? []),
          typeof p["supersedes"] === "string" ? p["supersedes"] : null,
          "active",
          event.occurredAt,
        );
    } else if (event.type === "memory.superseded") {
      database
        .prepare("UPDATE memories SET status = 'superseded', updated_at = ? WHERE memory_id = ?")
        .run(event.occurredAt, String(p["memoryId"] ?? ""));
    }
    if (event.type === "capability.candidate_created") {
      database
        .prepare("INSERT OR REPLACE INTO capabilities VALUES (?, ?, ?, 'candidate', ?, NULL, ?)")
        .run(
          String(p["capabilityId"] ?? ""),
          Number(p["version"] ?? 0),
          String(p["name"] ?? ""),
          JSON.stringify(p["manifest"] ?? {}),
          event.occurredAt,
        );
    } else if (
      ["capability.evaluated", "capability.promoted", "capability.rolled_back"].includes(event.type)
    ) {
      const status =
        event.type === "capability.promoted"
          ? "active"
          : event.type === "capability.rolled_back"
            ? "rolled_back"
            : p["passed"]
              ? "candidate"
              : "rejected";
      database
        .prepare(
          "UPDATE capabilities SET status = ?, score = COALESCE(?, score), updated_at = ? WHERE capability_id = ? AND version = ?",
        )
        .run(
          status,
          typeof p["score"] === "number" ? p["score"] : null,
          event.occurredAt,
          String(p["capabilityId"] ?? ""),
          Number(p["version"] ?? 0),
        );
    }
    if (event.type === "job.scheduled") {
      database
        .prepare("INSERT OR REPLACE INTO jobs VALUES (?, 'scheduled', ?, ?, NULL, ?, ?)")
        .run(
          String(p["jobId"] ?? ""),
          String(p["schedule"] ?? ""),
          JSON.stringify(p["grant"] ?? {}),
          Number(p["budget"] ?? 0),
          event.occurredAt,
        );
    } else if (event.type.startsWith("job.") && p["jobId"]) {
      const status =
        event.type === "job.lease_acquired"
          ? "running"
          : event.type === "job.heartbeat"
            ? null
            : event.type.replace("job.", "");
      database
        .prepare(
          "UPDATE jobs SET status = COALESCE(?, status), lease_until = COALESCE(?, lease_until), budget_remaining = COALESCE(?, budget_remaining), updated_at = ? WHERE job_id = ?",
        )
        .run(
          status,
          typeof p["leaseUntil"] === "string" ? p["leaseUntil"] : null,
          typeof p["budgetRemaining"] === "number" ? p["budgetRemaining"] : null,
          event.occurredAt,
          String(p["jobId"]),
        );
    }
  };

  return Object.freeze({
    paths,
    clock,
    initialize,
    recover,
    refresh,
    append,
    readAll,
    eventsForTrail,
    findByType,
    listTrailProjections,
    rebuildProjection,
  });
}

export interface StoredArtifact {
  readonly hash: string;
  readonly path: string;
  readonly mediaType: string;
  readonly bytes: number;
}

export interface DurableArtifactWriter {
  syncDirectory(path: string): Promise<void>;
  persist(temporary: string, path: string, directory: string, bytes: Uint8Array): Promise<void>;
}

export const durableArtifactWriter: DurableArtifactWriter = {
  async syncDirectory(path) {
    const directory = await open(path, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  },
  async persist(temporary, path, directory, bytes) {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    await durableArtifactWriter.syncDirectory(directory);
  },
};

export interface ArtifactStore {
  put(content: string | Uint8Array, mediaType: string, trailId?: string): Promise<StoredArtifact>;
}

export function createArtifactStore(
  ledger: ExperienceLedger,
  writer: DurableArtifactWriter = durableArtifactWriter,
): ArtifactStore {
  const put = async (
    content: string | Uint8Array,
    mediaType: string,
    trailId?: string,
  ): Promise<StoredArtifact> => {
    const bytes = typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const directory = join(ledger.paths.artifacts, hash.slice(0, 2));
    const path = join(directory, hash);
    let prefixCreated = false;
    try {
      await mkdir(directory);
      prefixCreated = true;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    }
    if (prefixCreated) await writer.syncDirectory(ledger.paths.artifacts);
    try {
      await stat(path);
    } catch {
      const temporary = `${path}.${createId("tmp")}`;
      await writer.persist(temporary, path, directory, bytes);
    }
    await ledger.append({
      type: "artifact.stored",
      principal: "foreground",
      ...(trailId ? { trailId } : {}),
      payload: { hash, mediaType, bytes: bytes.length, file: basename(path) },
    });
    return { hash, path, mediaType, bytes: bytes.length };
  };

  return Object.freeze({ put });
}
