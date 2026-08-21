import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { type JsonValue, JsonValueSchema } from "@noesis/domain";
import { z } from "zod";
import type { WorkspacePaths } from "./types.ts";

export type DatabaseRow = Readonly<Record<string, SQLOutputValue>>;

export interface WorkspaceDatabase {
  readonly connection: DatabaseSync;
  readonly transaction: <T>(operation: () => T) => T;
  readonly close: () => void;
}

export async function openWorkspaceDatabase(
  paths: WorkspacePaths,
  now: () => string,
): Promise<WorkspaceDatabase> {
  const connection = new DatabaseSync(paths.database);
  connection.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
  await applyMigrations(connection, now);

  const transaction = <T>(operation: () => T): T => {
    connection.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      connection.exec("COMMIT");
      return result;
    } catch (error) {
      connection.exec("ROLLBACK");
      throw error;
    }
  };

  return Object.freeze({
    connection,
    transaction,
    close: () => connection.close(),
  });
}

async function applyMigrations(connection: DatabaseSync, now: () => string): Promise<void> {
  const migrationDirectory = new URL("../migrations/", import.meta.url);
  const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
  const existingTable = connection
    .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  const applied = new Set<number>();
  if (existingTable !== undefined) {
    for (const row of connection.prepare("SELECT version FROM schema_migrations").all()) {
      const version = z.number().int().safeParse(row["version"]);
      if (version.success) applied.add(version.data);
    }
  }

  for (const file of files) {
    const match = /^(\d+)_/.exec(file);
    if (!match?.[1]) throw new Error(`Invalid workspace migration filename: ${file}`);
    const version = Number(match[1]);
    if (applied.has(version)) continue;
    const sql = await readFile(new URL(file, migrationDirectory), "utf8");
    connection.exec("BEGIN IMMEDIATE");
    try {
      connection.exec(sql);
      connection
        .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
        .run(version, file, now());
      connection.exec("COMMIT");
    } catch (error) {
      connection.exec("ROLLBACK");
      throw new Error(`Workspace migration ${file} failed`, {
        cause: error,
      });
    }
  }
}

export function parseJson(value: SQLOutputValue): JsonValue {
  const text = z.string().parse(value);
  return JsonValueSchema.parse(JSON.parse(text));
}

export function requiredString(row: DatabaseRow | undefined, field: string): string {
  if (row === undefined) throw new Error(`Expected a row containing ${field}`);
  return z.string().parse(row[field]);
}

export function optionalString(row: DatabaseRow | undefined, field: string): string | undefined {
  if (row === undefined) throw new Error(`Expected a row containing ${field}`);
  return z
    .string()
    .nullable()
    .transform((value) => value ?? undefined)
    .parse(row[field]);
}

export function requiredNumber(row: DatabaseRow | undefined, field: string): number {
  if (row === undefined) throw new Error(`Expected a row containing ${field}`);
  return z.number().parse(row[field]);
}
