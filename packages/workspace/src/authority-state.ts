import type { DatabaseRow } from "./database.ts";
import { canonicalJson, GrantSchema, toJsonValue, type Grant, type JsonValue } from "@noesis/domain";
import {
  createDurableAuthorityBoundary,
  type AuthorityBoundary,
  type DurableAuthorityOperation,
  type DurableAuthorityReservation,
  type DurableAuthorityStatePort,
} from "@noesis/policy";
import type { DatabaseSync } from "node:sqlite";
import { parseJson, requiredNumber, requiredString } from "./database.ts";

interface AuthorityDatabase {
  readonly connection: DatabaseSync;
  readonly transaction: <T>(operation: () => T) => T;
}

const decodeGrant = (row: DatabaseRow | undefined): Grant =>
  GrantSchema.parse({
    schemaVersion: 1,
    grantId: requiredString(row, "grant_id"),
    principal: requiredString(row, "principal"),
    effects: parseJson(requiredString(row, "effects_json")),
    resourcePrefixes: parseJson(requiredString(row, "resource_prefixes_json")),
    expiresAt: requiredString(row, "expires_at"),
    maxUses: requiredNumber(row, "max_uses"),
    maxCost: requiredNumber(row, "max_cost"),
  });

const permitted = (grant: Grant, operation: DurableAuthorityOperation, at: string): boolean =>
  grant.principal === operation.identity.principal &&
  grant.expiresAt > at &&
  grant.effects.includes(operation.identity.effect) &&
  grant.resourcePrefixes.some((prefix) => operation.identity.resource.startsWith(prefix));

const replayReservation = (
  row: DatabaseRow | undefined,
  operation: DurableAuthorityOperation,
): Exclude<DurableAuthorityReservation, { readonly status: "reserved" }> => {
  if (requiredString(row, "operation_fingerprint") !== operation.fingerprint)
    return Object.freeze({
      status: "collision",
      reason: `Idempotency key ${operation.identity.idempotencyKey} is bound to another request`,
    });
  const status = requiredString(row, "status");
  if (status === "completed")
    return Object.freeze({
      status: "completed",
      result: toJsonValue(parseJson(requiredString(row, "result_json"))),
    });
  if (status === "failed")
    return Object.freeze({
      status: "failed",
      reason: requiredString(row, "failure"),
    });
  if (status === "denied")
    return Object.freeze({
      status: "denied",
      reason: requiredString(row, "failure"),
    });
  return Object.freeze({
    status: "unresolved",
    reason: `Operation ${operation.identity.operationId} has no unambiguous durable outcome`,
  });
};

/**
 * The workspace exposes the composed authority boundary, not this raw state port. This keeps grant
 * installation, reservation, and receipt-lineage writes behind one closure-owned control plane.
 */
export function createWorkspaceAuthorityBoundary(
  database: AuthorityDatabase,
  now: () => string,
): AuthorityBoundary {
  const db = database.connection;
  const insertGrant = (grant: Grant, issuedAt: string): void => {
    const existing = db.prepare("SELECT * FROM authority_grants WHERE grant_id = ?").get(grant.grantId);
    if (existing !== undefined) {
      if (canonicalJson(decodeGrant(existing)) !== canonicalJson(grant))
        throw new Error(`Authority grant ${grant.grantId} already exists with different terms`);
      return;
    }
    db.prepare(
      `INSERT INTO authority_grants(
        grant_id, principal, effects_json, resource_prefixes_json, expires_at,
        max_uses, max_cost, issued_at, source_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      grant.grantId,
      grant.principal,
      JSON.stringify(grant.effects),
      JSON.stringify(grant.resourcePrefixes),
      grant.expiresAt,
      grant.maxUses,
      grant.maxCost,
      issuedAt,
    );
  };
  const reserveOperation = async (
    operation: DurableAuthorityOperation,
    grantId: string | undefined,
    freshGrant?: Grant,
  ): Promise<DurableAuthorityReservation> =>
    database.transaction(() => {
      const existing = db
        .prepare("SELECT * FROM authority_operations WHERE idempotency_key = ?")
        .get(operation.identity.idempotencyKey);
      if (existing !== undefined) return replayReservation(existing, operation);

      const at = now();
      const grantRow =
        freshGrant === undefined && grantId !== undefined
          ? db.prepare("SELECT * FROM authority_grants WHERE grant_id = ?").get(grantId)
          : undefined;
      const grant = freshGrant ?? (grantRow === undefined ? undefined : decodeGrant(grantRow));
      let denial: string | undefined;
      if (grant === undefined) denial = "A live, process-owned grant is required";
      else if (!permitted(grant, operation, at))
        denial = "Grant does not authorize this principal, effect, resource, or time";
      else {
        const usage = db
          .prepare(
            `SELECT COUNT(*) AS uses, COALESCE(SUM(estimated_cost), 0) AS cost
             FROM authority_operations
             WHERE grant_id = ? AND status != 'denied'`,
          )
          .get(grant.grantId);
        const uses = requiredNumber(usage, "uses");
        const cost = requiredNumber(usage, "cost");
        if (uses + 1 > grant.maxUses || cost + operation.estimatedCost > grant.maxCost)
          denial = "Grant use or cost budget exhausted";
      }

      if (freshGrant !== undefined && denial === undefined) insertGrant(freshGrant, at);
      const status = denial === undefined ? "reserved" : "denied";
      db.prepare(
        `INSERT INTO authority_operations(
          operation_id, idempotency_key, operation_fingerprint, principal, effect, resource,
          request_digest, estimated_cost, grant_id, status, result_json, failure,
          receipt_lineage_id, source_event_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?)`,
      ).run(
        operation.identity.operationId,
        operation.identity.idempotencyKey,
        operation.fingerprint,
        operation.identity.principal,
        operation.identity.effect,
        operation.identity.resource,
        operation.identity.requestDigest,
        operation.estimatedCost,
        denial === undefined ? (grant?.grantId ?? null) : null,
        status,
        denial ?? null,
        at,
        at,
      );
      return denial === undefined
        ? Object.freeze({ status: "reserved", grantId: grant?.grantId ?? "" })
        : Object.freeze({ status: "denied", reason: denial });
    });

  const state: DurableAuthorityStatePort = Object.freeze({
    issueGrant: async (grant: Grant) => {
      const parsed = GrantSchema.parse(grant);
      database.transaction(() => {
        insertGrant(parsed, now());
      });
    },
    getGrant: async (grantId: string) => {
      const row = db.prepare("SELECT * FROM authority_grants WHERE grant_id = ?").get(grantId);
      return row === undefined ? undefined : decodeGrant(row);
    },
    findSchedulerGrant: async (jobId: string) => {
      const at = now();
      const rows = db
        .prepare(
          `SELECT * FROM authority_grants
           WHERE principal = 'scheduler' AND expires_at > ?
           ORDER BY issued_at DESC, grant_id DESC`,
        )
        .all(at);
      return rows
        .map(decodeGrant)
        .find(
          (grant) =>
            grant.effects.includes("execute") &&
            grant.resourcePrefixes.some((prefix) => `job:${jobId}:runtime`.startsWith(prefix)),
        );
    },
    reserve: async (
      operation: DurableAuthorityOperation,
      grantId: string | undefined,
    ): Promise<DurableAuthorityReservation> => await reserveOperation(operation, grantId),
    reserveWithGrant: async (operation: DurableAuthorityOperation, grant: Grant) => {
      const parsed = GrantSchema.parse(grant);
      return await reserveOperation(operation, undefined, parsed);
    },
    complete: async (request: {
      readonly operation: DurableAuthorityOperation;
      readonly grantId: string;
      readonly result: JsonValue;
      readonly receiptLineageId: string;
    }) => {
      database.transaction(() => {
        const result = db
          .prepare(
            `UPDATE authority_operations
             SET status = 'completed', result_json = ?, failure = NULL,
                 receipt_lineage_id = ?, updated_at = ?
             WHERE operation_id = ? AND operation_fingerprint = ? AND grant_id = ?
               AND status = 'reserved'`,
          )
          .run(
            JSON.stringify(request.result),
            request.receiptLineageId,
            now(),
            request.operation.identity.operationId,
            request.operation.fingerprint,
            request.grantId,
          );
        if (Number(result.changes) !== 1)
          throw new Error(
            `Authority operation ${request.operation.identity.operationId} was not durably reserved`,
          );
      });
    },
    fail: async (request: {
      readonly operation: DurableAuthorityOperation;
      readonly grantId: string;
      readonly reason: string;
      readonly receiptLineageId: string;
    }) => {
      database.transaction(() => {
        const result = db
          .prepare(
            `UPDATE authority_operations
             SET status = 'failed', result_json = NULL, failure = ?,
                 receipt_lineage_id = ?, updated_at = ?
             WHERE operation_id = ? AND operation_fingerprint = ? AND grant_id = ?
               AND status = 'reserved'`,
          )
          .run(
            request.reason,
            request.receiptLineageId,
            now(),
            request.operation.identity.operationId,
            request.operation.fingerprint,
            request.grantId,
          );
        if (Number(result.changes) !== 1)
          throw new Error(
            `Authority operation ${request.operation.identity.operationId} was not durably reserved`,
          );
      });
    },
    abandon: async (request: {
      readonly operation: DurableAuthorityOperation;
      readonly grantId: string;
      readonly discardGrant: boolean;
    }) => {
      database.transaction(() => {
        const result = db
          .prepare(
            `DELETE FROM authority_operations
             WHERE operation_id = ? AND operation_fingerprint = ? AND grant_id = ?
               AND status = 'reserved'`,
          )
          .run(request.operation.identity.operationId, request.operation.fingerprint, request.grantId);
        if (Number(result.changes) !== 1)
          throw new Error(
            `Authority operation ${request.operation.identity.operationId} was not releasably reserved`,
          );
        if (request.discardGrant)
          db.prepare(
            `DELETE FROM authority_grants
             WHERE grant_id = ?
               AND NOT EXISTS (
                 SELECT 1 FROM authority_operations WHERE grant_id = authority_grants.grant_id
               )`,
          ).run(request.grantId);
      });
    },
  });

  return createDurableAuthorityBoundary(state);
}
