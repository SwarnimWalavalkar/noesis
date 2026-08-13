import { randomUUID } from "node:crypto";
import {
  EvidenceRefSchema,
  JsonValueSchema,
  type ActorRef,
  type DurableJobEnqueueRequest,
  type DurableJobFailure,
  type DurableJobListRequest,
  type DurableJobObservationRequest,
  type DurableJobPage,
  type DurableJobRecord,
  type DurableJobStatus,
  type EvidenceRef,
} from "@noesis/domain";
import { z } from "zod";
import {
  optionalString,
  parseJson,
  requiredNumber,
  requiredString,
  type WorkspaceDatabase,
} from "./database.ts";

const JobStatusSchema = z.enum([
  "scheduled",
  "running",
  "completed",
  "failed",
  "cancelled",
  "budget_exhausted",
]);
const JobFailureSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
  ambiguous: z.boolean(),
});
const JobObservationSchema = z.strictObject({
  sourceSessionId: z.string().min(1),
  parentJobId: z.string().min(1),
  observedAt: z.string().datetime(),
});
const EnqueueSchema = z.strictObject({
  jobId: z.string().min(1),
  kind: z.string().min(1),
  payload: JsonValueSchema,
  payloadRefs: z.array(EvidenceRefSchema),
  operationId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  notBefore: z.string().datetime(),
  maxAttempts: z.number().int().positive(),
  estimatedCost: z.number().nonnegative(),
  budget: z.number().nonnegative(),
  observations: z.array(JobObservationSchema).optional(),
  inheritObservationsFromParentJobId: z.string().min(1).optional(),
});

type RecordActivity = (
  actor: ActorRef,
  activityKind: string,
  subjectKind: string,
  subjectId: string,
  references?: unknown,
) => unknown;

export function createDurableJobStore(
  database: WorkspaceDatabase,
  recordActivity: RecordActivity,
  assertReference: (reference: EvidenceRef) => void,
): import("@noesis/domain").DurableJobStorePort {
  const db = database.connection;
  const actor: ActorRef = Object.freeze({ actorId: "runtime-coordinator", kind: "system" });

  const read = (jobId: string): DurableJobRecord | undefined => {
    const row = db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId);
    return row === undefined ? undefined : decodeDurableJob(row);
  };

  const recordObservation = (jobId: string, observation: DurableJobObservationRequest): void => {
    db.prepare(
      `INSERT OR IGNORE INTO job_lineage(child_job_id, parent_job_id, linked_at)
       VALUES (?, ?, ?)`,
    ).run(jobId, observation.parentJobId, observation.observedAt);
    db.prepare(
      `INSERT OR IGNORE INTO job_observations(
         child_job_id, parent_job_id, source_session_id, observed_at
       ) VALUES (?, ?, ?, ?)`,
    ).run(jobId, observation.parentJobId, observation.sourceSessionId, observation.observedAt);
    db.prepare(
      `WITH RECURSIVE descendants(child_job_id, parent_job_id) AS (
         SELECT child_job_id, parent_job_id FROM job_lineage WHERE parent_job_id = ?
         UNION
         SELECT lineage.child_job_id, lineage.parent_job_id
         FROM job_lineage AS lineage
         JOIN descendants ON lineage.parent_job_id = descendants.child_job_id
       )
       INSERT OR IGNORE INTO job_observations(
         child_job_id, parent_job_id, source_session_id, observed_at
       )
       SELECT child_job_id, parent_job_id, ?, ? FROM descendants`,
    ).run(jobId, observation.sourceSessionId, observation.observedAt);
  };

  const inheritObservations = (jobId: string, parentJobId: string, observedAt: string): void => {
    db.prepare(
      `INSERT OR IGNORE INTO job_lineage(child_job_id, parent_job_id, linked_at)
       VALUES (?, ?, ?)`,
    ).run(jobId, parentJobId, observedAt);
    const sessions = db
      .prepare(
        `SELECT source_session_id
         FROM job_observations
         WHERE child_job_id = ?
         GROUP BY source_session_id
         ORDER BY min(observed_at), source_session_id`,
      )
      .all(parentJobId)
      .map((row) => z.string().min(1).parse(Reflect.get(row, "source_session_id")));
    for (const sourceSessionId of sessions)
      recordObservation(jobId, { sourceSessionId, parentJobId, observedAt });
  };

  const enqueue = async (request: DurableJobEnqueueRequest): Promise<DurableJobRecord> => {
    const value = EnqueueSchema.parse(request);
    for (const reference of value.payloadRefs) assertReference(reference);
    return database.transaction(() => {
      const current = db
        .prepare("SELECT * FROM jobs WHERE operation_id = ? OR idempotency_key = ?")
        .get(value.operationId, value.idempotencyKey);
      if (current !== undefined) {
        const existing = decodeDurableJob(current);
        const sameRequest =
          existing.jobId === value.jobId &&
          existing.kind === value.kind &&
          JSON.stringify(existing.payload) === JSON.stringify(value.payload) &&
          JSON.stringify(existing.payloadRefs) === JSON.stringify(value.payloadRefs) &&
          existing.operationId === value.operationId &&
          existing.idempotencyKey === value.idempotencyKey &&
          existing.maxAttempts === value.maxAttempts &&
          existing.estimatedCost === value.estimatedCost;
        if (!sameRequest)
          throw new Error(`Durable job operation identity collision for ${value.operationId}`);
        for (const observation of value.observations ?? []) recordObservation(existing.jobId, observation);
        if (value.inheritObservationsFromParentJobId)
          inheritObservations(existing.jobId, value.inheritObservationsFromParentJobId, value.notBefore);
        return existing;
      }
      db.prepare(
        `INSERT INTO jobs(
          job_id, kind, payload_json, status, lease_owner, lease_until, attempt,
          budget_remaining, created_at, updated_at, payload_refs_json, operation_id,
          idempotency_key, not_before, lease_token, max_attempts, estimated_cost,
          result_json, last_error_json, completed_at
        ) VALUES (?, ?, ?, 'scheduled', NULL, NULL, 0, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL)`,
      ).run(
        value.jobId,
        value.kind,
        JSON.stringify(value.payload),
        value.budget,
        value.notBefore,
        value.notBefore,
        JSON.stringify(value.payloadRefs),
        value.operationId,
        value.idempotencyKey,
        value.notBefore,
        value.maxAttempts,
        value.estimatedCost,
      );
      recordActivity(actor, "coordinator.job_enqueued", "job", value.jobId, value.payloadRefs);
      for (const observation of value.observations ?? []) recordObservation(value.jobId, observation);
      if (value.inheritObservationsFromParentJobId)
        inheritObservations(value.jobId, value.inheritObservationsFromParentJobId, value.notBefore);
      const created = read(value.jobId);
      if (!created) throw new Error(`Durable job ${value.jobId} disappeared after enqueue`);
      return created;
    });
  };

  const validatedLimit = (request: DurableJobListRequest): number => {
    const limit = request.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000)
      throw new Error("Durable job list limit must be between 1 and 1000");
    return limit;
  };

  const query = (request: DurableJobListRequest, limit: number): readonly DurableJobRecord[] => {
    if (request.status !== undefined && request.statuses !== undefined)
      throw new Error("Durable job list accepts either status or statuses, not both");
    if (request.kind !== undefined && request.kinds !== undefined)
      throw new Error("Durable job list accepts either kind or kinds, not both");
    if (request.status) JobStatusSchema.parse(request.status);
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (request.status) {
      clauses.push("status = ?");
      values.push(request.status);
    }
    if (request.statuses !== undefined) {
      const statuses = z.array(JobStatusSchema).max(6).parse(request.statuses);
      if (statuses.length === 0) clauses.push("0");
      else {
        clauses.push(`status IN (${statuses.map(() => "?").join(", ")})`);
        values.push(...statuses);
      }
    }
    if (request.kind) {
      clauses.push("kind = ?");
      values.push(request.kind);
    }
    if (request.kinds !== undefined) {
      const kinds = z.array(z.string().min(1)).max(32).parse(request.kinds);
      if (kinds.length === 0) clauses.push("0");
      else {
        clauses.push(`kind IN (${kinds.map(() => "?").join(", ")})`);
        values.push(...kinds);
      }
    }
    if (request.payloadSessionId !== undefined) {
      z.string().min(1).parse(request.payloadSessionId);
      clauses.push("json_extract(payload_json, '$.turn.sessionId') = ?");
      values.push(request.payloadSessionId);
    }
    if (request.payloadSourceSessionIds !== undefined) {
      const sessionIds = z.array(z.string().min(1)).max(250).parse(request.payloadSourceSessionIds);
      if (sessionIds.length === 0) clauses.push("0");
      else {
        clauses.push(
          `json_extract(payload_json, '$.sourceSessionId') IN (${sessionIds.map(() => "?").join(", ")})`,
        );
        values.push(...sessionIds);
      }
    }
    if (request.payloadProjectId !== undefined) {
      z.string().min(1).parse(request.payloadProjectId);
      clauses.push("json_extract(payload_json, '$.turn.project.projectId') = ?");
      values.push(request.payloadProjectId);
    }
    if (request.observedSessionId !== undefined) {
      z.string().min(1).parse(request.observedSessionId);
      clauses.push(
        `job_id IN (
           WITH RECURSIVE scoped_jobs(job_id, source_session_id) AS (
             SELECT child_job_id, source_session_id
             FROM job_observations
             WHERE source_session_id = ?
             UNION
             SELECT observations.child_job_id, observations.source_session_id
             FROM job_observations AS observations
             JOIN scoped_jobs
               ON observations.parent_job_id = scoped_jobs.job_id
              AND observations.source_session_id = scoped_jobs.source_session_id
           )
           SELECT job_id FROM scoped_jobs
         )`,
      );
      values.push(request.observedSessionId);
    }
    if (request.payloadExperimentIds !== undefined) {
      const experimentIds = z.array(z.string().min(1)).max(250).parse(request.payloadExperimentIds);
      if (experimentIds.length === 0) clauses.push("0");
      else {
        clauses.push(
          `json_extract(payload_json, '$.experimentId') IN (${experimentIds.map(() => "?").join(", ")})`,
        );
        values.push(...experimentIds);
      }
    }
    if (request.after) {
      z.string().datetime().parse(request.after.createdAt);
      z.string().min(1).parse(request.after.jobId);
      clauses.push("(created_at > ? OR (created_at = ? AND job_id > ?))");
      values.push(request.after.createdAt, request.after.createdAt, request.after.jobId);
    }
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const orderedScanIndex =
      request.statuses !== undefined || request.kinds !== undefined
        ? " INDEXED BY jobs_created_status_kind"
        : "";
    return db
      .prepare(`SELECT * FROM jobs${orderedScanIndex}${where} ORDER BY created_at, job_id LIMIT ?`)
      .all(...values, limit)
      .map(decodeDurableJob);
  };

  const list = async (request: DurableJobListRequest = {}): Promise<readonly DurableJobRecord[]> =>
    query(request, validatedLimit(request));

  const listPage = async (request: DurableJobListRequest = {}): Promise<DurableJobPage> => {
    const limit = validatedLimit(request);
    const lookahead = query(request, limit + 1);
    const records = Object.freeze(lookahead.slice(0, limit));
    const last = records.at(-1);
    return Object.freeze({
      records,
      exhausted: lookahead.length <= limit,
      ...(last
        ? {
            nextCursor: Object.freeze({ createdAt: last.createdAt, jobId: last.jobId }),
          }
        : {}),
    });
  };

  const claim = async (request: {
    readonly workerId: string;
    readonly now: string;
    readonly leaseUntil: string;
    readonly maximumCost: number;
    readonly kinds?: readonly string[];
  }): Promise<DurableJobRecord | undefined> => {
    if (!request.workerId) throw new Error("A durable job claim requires a worker ID");
    z.string().datetime().parse(request.now);
    z.string().datetime().parse(request.leaseUntil);
    if (!Number.isFinite(request.maximumCost) || request.maximumCost < 0)
      throw new Error("A durable job claim requires a non-negative maximum cost");
    const kinds = request.kinds ?? [];
    if (kinds.some((kind) => kind.length === 0)) throw new Error("Durable job kinds must be non-empty");
    return database.transaction(() => {
      const exhaustedError: DurableJobFailure = Object.freeze({
        code: "attempts_exhausted",
        message: "The durable job exhausted its bounded attempt policy",
        retryable: false,
        ambiguous: false,
      });
      db.prepare(
        `UPDATE jobs SET status = 'failed', lease_owner = NULL, lease_token = NULL,
          lease_until = NULL, last_error_json = ?, updated_at = ?, completed_at = ?
         WHERE status IN ('scheduled', 'running') AND attempt >= max_attempts
           AND (status = 'scheduled' OR lease_until <= ?)`,
      ).run(JSON.stringify(exhaustedError), request.now, request.now, request.now);
      db.prepare(
        `UPDATE jobs SET status = 'budget_exhausted', lease_owner = NULL, lease_token = NULL,
          lease_until = NULL, updated_at = ?, completed_at = ?
         WHERE status IN ('scheduled', 'running') AND estimated_cost > budget_remaining
           AND (status = 'scheduled' OR lease_until <= ?)`,
      ).run(request.now, request.now, request.now);
      const kindClause = kinds.length === 0 ? "" : ` AND kind IN (${kinds.map(() => "?").join(", ")})`;
      const row = db
        .prepare(
          `SELECT job_id FROM jobs
           WHERE ((status = 'scheduled' AND not_before <= ?)
             OR (status = 'running' AND lease_until <= ?))
             AND attempt < max_attempts
             AND estimated_cost <= budget_remaining
             AND estimated_cost <= ?${kindClause}
           ORDER BY not_before, created_at, job_id LIMIT 1`,
        )
        .get(request.now, request.now, request.maximumCost, ...kinds);
      if (row === undefined) return undefined;
      const jobId = requiredString(row, "job_id");
      const leaseToken = `lease_${randomUUID()}`;
      const updated = db
        .prepare(
          `UPDATE jobs SET status = 'running', lease_owner = ?, lease_token = ?, lease_until = ?,
            attempt = attempt + 1, budget_remaining = budget_remaining - estimated_cost,
            updated_at = ?, last_error_json = NULL
           WHERE job_id = ? AND ((status = 'scheduled' AND not_before <= ?)
             OR (status = 'running' AND lease_until <= ?))`,
        )
        .run(request.workerId, leaseToken, request.leaseUntil, request.now, jobId, request.now, request.now);
      if (updated.changes !== 1) return undefined;
      recordActivity(actor, "coordinator.job_claimed", "job", jobId);
      const claimed = read(jobId);
      if (!claimed) throw new Error(`Claimed durable job ${jobId} disappeared`);
      return claimed;
    });
  };

  const renew = async (request: {
    readonly jobId: string;
    readonly leaseToken: string;
    readonly now: string;
    readonly leaseUntil: string;
  }): Promise<boolean> =>
    database.transaction(() => {
      const result = db
        .prepare(
          `UPDATE jobs SET lease_until = ?, updated_at = ?
           WHERE job_id = ? AND status = 'running' AND lease_token = ? AND lease_until > ?`,
        )
        .run(request.leaseUntil, request.now, request.jobId, request.leaseToken, request.now);
      return result.changes === 1;
    });

  const complete = async (request: {
    readonly jobId: string;
    readonly leaseToken: string;
    readonly now: string;
    readonly result?: unknown;
  }): Promise<boolean> => {
    const resultValue = request.result === undefined ? undefined : JsonValueSchema.parse(request.result);
    return database.transaction(() => {
      const result = db
        .prepare(
          `UPDATE jobs SET status = 'completed', result_json = ?, lease_owner = NULL,
            lease_token = NULL, lease_until = NULL, updated_at = ?, completed_at = ?
           WHERE job_id = ? AND status = 'running' AND lease_token = ?`,
        )
        .run(
          resultValue === undefined ? null : JSON.stringify(resultValue),
          request.now,
          request.now,
          request.jobId,
          request.leaseToken,
        );
      if (result.changes === 1) recordActivity(actor, "coordinator.job_completed", "job", request.jobId);
      return result.changes === 1;
    });
  };

  const fail = async (request: {
    readonly jobId: string;
    readonly leaseToken: string;
    readonly now: string;
    readonly retryAt: string;
    readonly failure: DurableJobFailure;
  }): Promise<DurableJobRecord> => {
    const failure = JobFailureSchema.parse(request.failure);
    return database.transaction(() => {
      const current = read(request.jobId);
      if (!current) throw new Error(`Unknown durable job ${request.jobId}`);
      if (current.status !== "running" || current.leaseToken !== request.leaseToken)
        throw new Error(`Cannot fail stale durable job lease ${request.jobId}`);
      const canRetry =
        failure.retryable &&
        !failure.ambiguous &&
        current.attempt < current.maxAttempts &&
        current.budgetRemaining >= current.estimatedCost;
      const status: DurableJobStatus = canRetry
        ? "scheduled"
        : failure.retryable && !failure.ambiguous && current.budgetRemaining < current.estimatedCost
          ? "budget_exhausted"
          : "failed";
      db.prepare(
        `UPDATE jobs SET status = ?, not_before = ?, lease_owner = NULL, lease_token = NULL,
          lease_until = NULL, last_error_json = ?, updated_at = ?, completed_at = ?
         WHERE job_id = ? AND status = 'running' AND lease_token = ?`,
      ).run(
        status,
        canRetry ? request.retryAt : current.notBefore,
        JSON.stringify(failure),
        request.now,
        canRetry ? null : request.now,
        request.jobId,
        request.leaseToken,
      );
      recordActivity(
        actor,
        canRetry ? "coordinator.job_retry_scheduled" : "coordinator.job_failed",
        "job",
        request.jobId,
      );
      const failed = read(request.jobId);
      if (!failed) throw new Error(`Failed durable job ${request.jobId} disappeared`);
      return failed;
    });
  };

  const cancel = async (jobId: string, now: string): Promise<DurableJobRecord | undefined> =>
    database.transaction(() => {
      const current = read(jobId);
      if (!current) return undefined;
      if (current.status === "scheduled" || current.status === "running") {
        db.prepare(
          `UPDATE jobs SET status = 'cancelled', lease_owner = NULL, lease_token = NULL,
            lease_until = NULL, updated_at = ?, completed_at = ? WHERE job_id = ?`,
        ).run(now, now, jobId);
        recordActivity(actor, "coordinator.job_cancelled", "job", jobId);
      }
      return read(jobId);
    });

  const retry = async (request: {
    readonly jobId: string;
    readonly now: string;
    readonly additionalBudget?: number;
  }): Promise<DurableJobRecord> => {
    const additionalBudget = request.additionalBudget ?? 0;
    if (!Number.isFinite(additionalBudget) || additionalBudget < 0)
      throw new Error("Additional retry budget must be non-negative");
    return database.transaction(() => {
      const current = read(request.jobId);
      if (!current) throw new Error(`Unknown durable job ${request.jobId}`);
      if (current.status !== "failed" && current.status !== "budget_exhausted")
        throw new Error(`Only failed or budget-exhausted jobs can be retried: ${request.jobId}`);
      const budget = current.budgetRemaining + additionalBudget;
      if (budget < current.estimatedCost)
        throw new Error(`Retry budget is below the estimated cost for ${request.jobId}`);
      db.prepare(
        `UPDATE jobs SET status = 'scheduled', not_before = ?, max_attempts = MAX(max_attempts, attempt + 1),
          budget_remaining = ?, last_error_json = NULL, completed_at = NULL, updated_at = ?
         WHERE job_id = ?`,
      ).run(request.now, budget, request.now, request.jobId);
      recordActivity(actor, "coordinator.job_manual_retry", "job", request.jobId);
      const retried = read(request.jobId);
      if (!retried) throw new Error(`Retried durable job ${request.jobId} disappeared`);
      return retried;
    });
  };

  return Object.freeze({
    enqueue,
    recordObservation: async (jobId: string, observation: DurableJobObservationRequest) => {
      z.string().min(1).parse(jobId);
      const value = JobObservationSchema.parse(observation);
      database.transaction(() => recordObservation(jobId, value));
    },
    inheritObservations: async (jobId: string, parentJobId: string, observedAt: string) => {
      z.string().min(1).parse(jobId);
      z.string().min(1).parse(parentJobId);
      z.string().datetime().parse(observedAt);
      database.transaction(() => inheritObservations(jobId, parentJobId, observedAt));
    },
    get: async (jobId: string) => read(jobId),
    list,
    listPage,
    claim,
    renew,
    complete,
    fail,
    cancel,
    retry,
  });
}

function decodeDurableJob(row: unknown): DurableJobRecord {
  const leaseOwner = optionalString(row, "lease_owner");
  const leaseToken = optionalString(row, "lease_token");
  const leaseUntil = optionalString(row, "lease_until");
  const result = optionalString(row, "result_json");
  const lastError = optionalString(row, "last_error_json");
  const completedAt = optionalString(row, "completed_at");
  return Object.freeze({
    jobId: requiredString(row, "job_id"),
    kind: requiredString(row, "kind"),
    payload: JsonValueSchema.parse(parseJson(requiredString(row, "payload_json"))),
    payloadRefs: Object.freeze(
      z.array(EvidenceRefSchema).parse(parseJson(requiredString(row, "payload_refs_json"))),
    ),
    operationId: requiredString(row, "operation_id"),
    idempotencyKey: requiredString(row, "idempotency_key"),
    status: JobStatusSchema.parse(requiredString(row, "status")),
    notBefore: requiredString(row, "not_before"),
    ...(leaseOwner === undefined ? {} : { leaseOwner }),
    ...(leaseToken === undefined ? {} : { leaseToken }),
    ...(leaseUntil === undefined ? {} : { leaseUntil }),
    attempt: requiredNumber(row, "attempt"),
    maxAttempts: requiredNumber(row, "max_attempts"),
    estimatedCost: requiredNumber(row, "estimated_cost"),
    budgetRemaining: requiredNumber(row, "budget_remaining"),
    ...(result === undefined ? {} : { result: JsonValueSchema.parse(parseJson(result)) }),
    ...(lastError === undefined ? {} : { lastError: JobFailureSchema.parse(parseJson(lastError)) }),
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at"),
    ...(completedAt === undefined ? {} : { completedAt }),
  });
}
