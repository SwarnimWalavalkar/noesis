import {
  canonicalJson,
  CompoundingReplayRecordSchema,
  EvidenceRevisionRefSchema,
  type CompoundingReplayRecord,
  type EvidenceRevisionRef,
} from "@noesis/domain";
import { z } from "zod";
import {
  optionalString,
  parseJson,
  requiredNumber,
  requiredString,
  type WorkspaceDatabase,
} from "./database.ts";
import type {
  CompoundingMeasurementStore,
  CompoundingReplayBudgetRecord,
  CompoundingReplayReservationResult,
  CompoundingReplayRoleReservation,
} from "./types.ts";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const RoleSchema = z.enum(["served_arm", "baseline_arm", "judge"]);

function decodeBudget(row: unknown): CompoundingReplayBudgetRecord {
  return Object.freeze({
    budgetId: requiredString(row, "budget_id"),
    maximumCalls: requiredNumber(row, "maximum_calls"),
    maximumTokens: requiredNumber(row, "maximum_tokens"),
    maximumCost: requiredNumber(row, "maximum_cost"),
    reservedCalls: requiredNumber(row, "reserved_calls"),
    reservedTokens: requiredNumber(row, "reserved_tokens"),
    reservedCost: requiredNumber(row, "reserved_cost"),
    createdAt: requiredString(row, "created_at"),
  });
}

function validateMaximums(input: {
  readonly maximumCalls?: number;
  readonly maximumTokens: number;
  readonly maximumCost: number;
}): void {
  if (
    (input.maximumCalls !== undefined && (!Number.isInteger(input.maximumCalls) || input.maximumCalls < 0)) ||
    !Number.isInteger(input.maximumTokens) ||
    input.maximumTokens < 0 ||
    !Number.isFinite(input.maximumCost) ||
    input.maximumCost < 0
  )
    throw new Error("Replay budget limits must be finite non-negative values");
}

function decodeResultEvidence(value: string): EvidenceRevisionRef<"output" | "judgment"> {
  const ref = EvidenceRevisionRefSchema.parse(parseJson(value));
  if (ref.evidenceKind !== "output" && ref.evidenceKind !== "judgment")
    throw new Error(`Replay role result cannot use ${ref.evidenceKind} evidence`);
  return Object.freeze({ ...ref, evidenceKind: ref.evidenceKind });
}

function assertEvidenceExists(
  database: WorkspaceDatabase,
  ref: EvidenceRevisionRef<"output" | "judgment">,
): void {
  const row = database.connection
    .prepare(
      `SELECT working_path, snapshot_path, content_digest, evidence_kind
       FROM file_revisions WHERE revision_id = ? AND revision_kind = 'evidence'`,
    )
    .get(ref.revisionId);
  if (
    row === undefined ||
    requiredString(row, "working_path") !== ref.workingPath ||
    requiredString(row, "snapshot_path") !== ref.snapshotPath ||
    requiredString(row, "content_digest") !== ref.contentDigest ||
    requiredString(row, "evidence_kind") !== ref.evidenceKind
  )
    throw new Error(`Missing or mismatched replay evidence ${ref.revisionId}`);
}

function reservationFromExisting(
  row: unknown,
  request: CompoundingReplayRoleReservation,
): CompoundingReplayReservationResult {
  if (
    requiredString(row, "replay_id") !== request.replayId ||
    RoleSchema.parse(requiredString(row, "role")) !== request.role ||
    requiredString(row, "request_digest") !== request.requestDigest ||
    requiredNumber(row, "maximum_tokens") !== request.maximumTokens ||
    requiredNumber(row, "maximum_cost") !== request.maximumCost
  )
    throw new Error(`Replay operation identity collision: ${request.operationId}`);
  const status = requiredString(row, "status");
  if (status === "reserved") return Object.freeze({ status: "unresolved" as const });
  if (status === "denied")
    return Object.freeze({ status: "denied" as const, reason: "budget_exhausted" as const });
  if (status === "failed")
    return Object.freeze({
      status: "failed" as const,
      failure: optionalString(row, "failure") ?? "Replay role failed",
    });
  if (status !== "completed") throw new Error(`Unknown replay operation status ${status}`);
  const encoded = optionalString(row, "result_evidence_json");
  if (!encoded) throw new Error(`Completed replay operation ${request.operationId} has no evidence`);
  return Object.freeze({
    status: "completed" as const,
    resultEvidence: decodeResultEvidence(encoded),
  });
}

export function createCompoundingMeasurementStore(
  database: WorkspaceDatabase,
  now: () => string,
): CompoundingMeasurementStore {
  const db = database.connection;

  const getBudget = async (budgetId: string): Promise<CompoundingReplayBudgetRecord | undefined> => {
    const row = db.prepare("SELECT * FROM compounding_replay_budgets WHERE budget_id = ?").get(budgetId);
    return row === undefined ? undefined : decodeBudget(row);
  };

  const putBudget: CompoundingMeasurementStore["putBudget"] = async (request) => {
    validateMaximums(request);
    const existing = await getBudget(request.budgetId);
    if (existing) {
      if (
        existing.maximumCalls !== request.maximumCalls ||
        existing.maximumTokens !== request.maximumTokens ||
        existing.maximumCost !== request.maximumCost
      )
        throw new Error(`Replay budget identity collision: ${request.budgetId}`);
      return existing;
    }
    db.prepare(
      `INSERT INTO compounding_replay_budgets(
        budget_id, maximum_calls, maximum_tokens, maximum_cost, created_at
      ) VALUES (?, ?, ?, ?, ?)`,
    ).run(request.budgetId, request.maximumCalls, request.maximumTokens, request.maximumCost, now());
    const created = await getBudget(request.budgetId);
    if (!created) throw new Error(`Replay budget ${request.budgetId} was not created`);
    return created;
  };

  const beginReplay: CompoundingMeasurementStore["beginReplay"] = async (request) => {
    const existing = db
      .prepare("SELECT plan_id, budget_id FROM compounding_replay_runs WHERE replay_id = ?")
      .get(request.replayId);
    if (existing) {
      if (
        requiredString(existing, "plan_id") !== request.planId ||
        requiredString(existing, "budget_id") !== request.budgetId
      )
        throw new Error(`Replay identity collision: ${request.replayId}`);
      return;
    }
    db.prepare(
      `INSERT INTO compounding_replay_runs(
        replay_id, plan_id, budget_id, status, created_at
      ) VALUES (?, ?, ?, 'running', ?)`,
    ).run(request.replayId, request.planId, request.budgetId, now());
  };

  const reserveRole: CompoundingMeasurementStore["reserveRole"] = async (request) => {
    RoleSchema.parse(request.role);
    DigestSchema.parse(request.requestDigest);
    validateMaximums(request);
    const existing = db
      .prepare("SELECT * FROM compounding_replay_operations WHERE operation_id = ?")
      .get(request.operationId);
    if (existing) return reservationFromExisting(existing, request);
    const occupiedRole = db
      .prepare("SELECT operation_id FROM compounding_replay_operations WHERE replay_id = ? AND role = ?")
      .get(request.replayId, request.role);
    if (occupiedRole)
      throw new Error(
        `Replay role identity collision: ${request.replayId}/${request.role} already uses ${requiredString(occupiedRole, "operation_id")}`,
      );

    return database.transaction(() => {
      const budgetIdRow = db
        .prepare("SELECT budget_id FROM compounding_replay_runs WHERE replay_id = ?")
        .get(request.replayId);
      if (!budgetIdRow) throw new Error(`Unknown replay ${request.replayId}`);
      const budgetId = requiredString(budgetIdRow, "budget_id");
      const reservedAt = now();
      const updated = db
        .prepare(
          `UPDATE compounding_replay_budgets
           SET reserved_calls = reserved_calls + 1,
               reserved_tokens = reserved_tokens + ?,
               reserved_cost = reserved_cost + ?
           WHERE budget_id = ?
             AND reserved_calls + 1 <= maximum_calls
             AND reserved_tokens + ? <= maximum_tokens
             AND reserved_cost + ? <= maximum_cost`,
        )
        .run(
          request.maximumTokens,
          request.maximumCost,
          budgetId,
          request.maximumTokens,
          request.maximumCost,
        );
      const status = updated.changes === 1 ? "reserved" : "denied";
      db.prepare(
        `INSERT INTO compounding_replay_operations(
          operation_id, replay_id, role, request_digest, maximum_tokens,
          maximum_cost, status, reserved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        request.operationId,
        request.replayId,
        request.role,
        request.requestDigest,
        request.maximumTokens,
        request.maximumCost,
        status,
        reservedAt,
      );
      return status === "reserved"
        ? Object.freeze({ status: "reserved" as const })
        : Object.freeze({ status: "denied" as const, reason: "budget_exhausted" as const });
    });
  };

  const completeRole: CompoundingMeasurementStore["completeRole"] = async (request) => {
    if (
      !Number.isInteger(request.usedTokens) ||
      request.usedTokens < 0 ||
      !Number.isFinite(request.actualCost) ||
      request.actualCost < 0
    )
      throw new Error("Replay role usage must be finite and non-negative");
    const row = db
      .prepare("SELECT * FROM compounding_replay_operations WHERE operation_id = ?")
      .get(request.operationId);
    if (!row) throw new Error(`Unknown replay operation ${request.operationId}`);
    const role = RoleSchema.parse(requiredString(row, "role"));
    if (
      (role === "judge" && request.resultEvidence.evidenceKind !== "judgment") ||
      (role !== "judge" && request.resultEvidence.evidenceKind !== "output")
    )
      throw new Error(`Replay role ${role} received the wrong evidence kind`);
    assertEvidenceExists(database, request.resultEvidence);
    const status = requiredString(row, "status");
    if (status === "completed") {
      const existing = optionalString(row, "result_evidence_json");
      if (
        existing !== canonicalJson(request.resultEvidence) ||
        requiredNumber(row, "used_tokens") !== request.usedTokens ||
        requiredNumber(row, "actual_cost") !== request.actualCost
      )
        throw new Error(`Replay completion identity collision: ${request.operationId}`);
      return;
    }
    if (status !== "reserved")
      throw new Error(`Replay operation ${request.operationId} is ${status}, not reserved`);
    const exceedsReservation =
      request.usedTokens > requiredNumber(row, "maximum_tokens") ||
      request.actualCost > requiredNumber(row, "maximum_cost");
    if (exceedsReservation) {
      db.prepare(
        `UPDATE compounding_replay_operations
         SET status = 'failed', failure = ?, completed_at = ? WHERE operation_id = ?`,
      ).run("Role usage exceeded its durable reservation", now(), request.operationId);
      throw new Error(`Replay operation ${request.operationId} exceeded its durable reservation`);
    }
    db.prepare(
      `UPDATE compounding_replay_operations
       SET status = 'completed', result_evidence_json = ?, used_tokens = ?,
           actual_cost = ?, completed_at = ?
       WHERE operation_id = ? AND status = 'reserved'`,
    ).run(
      canonicalJson(request.resultEvidence),
      request.usedTokens,
      request.actualCost,
      now(),
      request.operationId,
    );
  };

  const failRole: CompoundingMeasurementStore["failRole"] = async (operationId, failure) => {
    if (failure.length === 0) throw new Error("Replay role failure must explain the failure");
    const row = db
      .prepare("SELECT status, failure FROM compounding_replay_operations WHERE operation_id = ?")
      .get(operationId);
    if (!row) throw new Error(`Unknown replay operation ${operationId}`);
    const status = requiredString(row, "status");
    if (status === "failed") {
      if (optionalString(row, "failure") !== failure)
        throw new Error(`Replay failure identity collision: ${operationId}`);
      return;
    }
    if (status !== "reserved") throw new Error(`Replay operation ${operationId} is ${status}`);
    db.prepare(
      `UPDATE compounding_replay_operations
       SET status = 'failed', failure = ?, completed_at = ? WHERE operation_id = ?`,
    ).run(failure, now(), operationId);
  };

  const record: CompoundingMeasurementStore["record"] = async (value) => {
    const record = CompoundingReplayRecordSchema.parse(value);
    const encoded = canonicalJson(record);
    const row = db
      .prepare("SELECT plan_id, status, record_json FROM compounding_replay_runs WHERE replay_id = ?")
      .get(record.replayId);
    if (!row) throw new Error(`Unknown replay ${record.replayId}`);
    if (requiredString(row, "plan_id") !== record.planId)
      throw new Error(`Replay ${record.replayId} does not cite its admitted plan`);
    const status = requiredString(row, "status");
    if (status !== "running") {
      if (status !== record.status || optionalString(row, "record_json") !== encoded)
        throw new Error(`Replay result identity collision: ${record.replayId}`);
      return;
    }
    db.prepare(
      `UPDATE compounding_replay_runs
       SET status = ?, record_json = ?, completed_at = ?
       WHERE replay_id = ? AND status = 'running'`,
    ).run(record.status, encoded, now(), record.replayId);
  };

  const list = async (): Promise<readonly CompoundingReplayRecord[]> =>
    Object.freeze(
      db
        .prepare(
          `SELECT record_json FROM compounding_replay_runs
           WHERE status != 'running' ORDER BY completed_at, replay_id`,
        )
        .all()
        .map((row) => CompoundingReplayRecordSchema.parse(parseJson(requiredString(row, "record_json")))),
    );

  return Object.freeze({
    putBudget,
    getBudget,
    beginReplay,
    reserveRole,
    completeRole,
    failRole,
    record,
    list,
  });
}
