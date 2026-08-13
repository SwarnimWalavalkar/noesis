import { canonicalJson, sha256 } from "@noesis/domain";
import type { DatabaseSync } from "node:sqlite";
import { requiredNumber, requiredString } from "./database.ts";

interface McpConnectionCycleDatabase {
  readonly connection: DatabaseSync;
  readonly transaction: <T>(operation: () => T) => T;
}

export interface McpConnectionCycleAllocator {
  readonly claim: (connectionIdentity: string) => Promise<string>;
}

function operationId(connectionIdentity: string, cycle: number): string {
  return `operation_${sha256(canonicalJson({ kind: "mcp_connection", connectionIdentity, cycle }))}`;
}

export function createMcpConnectionCycleAllocator(
  database: McpConnectionCycleDatabase,
  now: () => string,
): McpConnectionCycleAllocator {
  const db = database.connection;
  return Object.freeze({
    claim: async (connectionIdentity: string): Promise<string> =>
      database.transaction(() => {
        const current = db
          .prepare(
            `SELECT connection_identity, cycle, operation_id
             FROM mcp_connection_cycles
             WHERE connection_identity = ?`,
          )
          .get(connectionIdentity);
        if (current === undefined) {
          const firstOperationId = operationId(connectionIdentity, 1);
          db.prepare(
            `INSERT INTO mcp_connection_cycles(connection_identity, cycle, operation_id, updated_at)
             VALUES (?, 1, ?, ?)`,
          ).run(connectionIdentity, firstOperationId, now());
          return firstOperationId;
        }
        const currentOperationId = requiredString(current, "operation_id");
        const authorityOperation = db
          .prepare("SELECT status FROM authority_operations WHERE operation_id = ?")
          .get(currentOperationId);
        const status =
          authorityOperation === undefined ? undefined : requiredString(authorityOperation, "status");
        if (status === undefined || status === "reserved" || status === "unresolved")
          return currentOperationId;
        const nextCycle = requiredNumber(current, "cycle") + 1;
        const nextOperationId = operationId(connectionIdentity, nextCycle);
        db.prepare(
          `UPDATE mcp_connection_cycles
           SET cycle = ?, operation_id = ?, updated_at = ?
           WHERE connection_identity = ? AND operation_id = ?`,
        ).run(nextCycle, nextOperationId, now(), connectionIdentity, currentOperationId);
        return nextOperationId;
      }),
  });
}
