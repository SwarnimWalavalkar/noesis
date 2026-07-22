import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import type { WorkspacePaths } from "./types.ts";

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
      const version = Reflect.get(row, "version");
      if (typeof version === "number") applied.add(version);
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

export function parseJson(value: unknown): unknown {
  if (typeof value !== "string") throw new Error("Expected stored JSON text");
  return JSON.parse(value);
}

export function requiredString(row: unknown, field: string): string {
  if (row === null || typeof row !== "object") throw new Error(`Expected a row containing ${field}`);
  const value = Reflect.get(row, field);
  if (typeof value !== "string") throw new Error(`Expected text column ${field}`);
  return value;
}

export function optionalString(row: unknown, field: string): string | undefined {
  if (row === null || typeof row !== "object") throw new Error(`Expected a row containing ${field}`);
  const value = Reflect.get(row, field);
  if (value === null) return undefined;
  if (typeof value !== "string") throw new Error(`Expected nullable text column ${field}`);
  return value;
}

export function requiredNumber(row: unknown, field: string): number {
  if (row === null || typeof row !== "object") throw new Error(`Expected a row containing ${field}`);
  const value = Reflect.get(row, field);
  if (typeof value !== "number") throw new Error(`Expected numeric column ${field}`);
  return value;
}
