import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { sha256 } from "@noesis/domain";
import { z } from "zod";
import { requiredString } from "./database.ts";
import { initializeWorkspaceDirectories, pathInside, workspacePaths } from "./paths.ts";
import type { BackupReport, IntegrityReport, RestoreReport, WorkspacePaths } from "./types.ts";

const BackupManifestSchema = z.strictObject({
  format: z.literal("noesis-workspace-backup-v1"),
  createdAt: z.string().min(1),
  files: z.array(
    z.strictObject({
      path: z.string().min(1),
      contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
      byteLength: z.number().int().nonnegative(),
    }),
  ),
  missingFiles: z.array(z.string()),
});

export async function inspectWorkspaceIntegrity(
  paths: WorkspacePaths,
  database: DatabaseSync,
): Promise<IntegrityReport> {
  const integrityRow = database.prepare("PRAGMA integrity_check").get();
  const integrity =
    integrityRow && typeof integrityRow === "object" ? integrityRow["integrity_check"] : undefined;
  const databaseIntegrity = typeof integrity === "string" ? integrity : "unknown integrity result";
  const expected = new Set<string>();
  for (const row of database.prepare("SELECT snapshot_path FROM file_revisions").all())
    expected.add(requiredString(row, "snapshot_path"));
  for (const row of database.prepare("SELECT path FROM artifacts").all())
    expected.add(requiredString(row, "path"));

  const missingFiles: string[] = [];
  for (const storedPath of expected) {
    try {
      await stat(pathInside(paths.root, storedPath));
    } catch (error) {
      if (isMissing(error)) missingFiles.push(storedPath);
      else throw error;
    }
  }

  const managedFiles = [
    ...(await walkFiles(paths.revisions, paths.root)),
    ...(await walkFiles(paths.evidence, paths.root)),
    ...(await walkFiles(paths.artifacts, paths.root)),
  ];
  const orphanFiles = managedFiles.filter((file) => !expected.has(file)).sort();
  return { databaseIntegrity, missingFiles: missingFiles.sort(), orphanFiles };
}

export async function createBackup(
  paths: WorkspacePaths,
  database: DatabaseSync,
  backupRoot: string,
  createdAt: string,
): Promise<BackupReport> {
  const destinationRoot = join(backupRoot, "workspace");
  await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  const candidates = new Set<string>([
    relative(paths.root, paths.database),
    ...(await walkFiles(paths.definitions, paths.root)),
    ...(await walkFiles(paths.revisions, paths.root)),
    ...(await walkFiles(paths.evidence, paths.root)),
    ...(await walkFiles(paths.artifacts, paths.root)),
  ]);
  const expected = database
    .prepare("SELECT snapshot_path AS path FROM file_revisions UNION ALL SELECT path FROM artifacts")
    .all()
    .map((row) => requiredString(row, "path"));
  for (const path of expected) candidates.add(path);

  database.exec("PRAGMA wal_checkpoint(FULL); BEGIN IMMEDIATE;");
  const files: Array<{ readonly path: string; readonly contentDigest: string; readonly byteLength: number }> =
    [];
  const missingFiles: string[] = [];
  try {
    for (const storedPath of [...candidates].sort()) {
      const source = pathInside(paths.root, storedPath);
      try {
        const bytes = await readFile(source);
        const destination = pathInside(destinationRoot, storedPath);
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await copyFile(source, destination);
        files.push({ path: storedPath, contentDigest: sha256(bytes), byteLength: bytes.length });
      } catch (error) {
        if (isMissing(error)) missingFiles.push(storedPath);
        else throw error;
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  const manifest = {
    format: "noesis-workspace-backup-v1" as const,
    createdAt,
    files,
    missingFiles: [...new Set(missingFiles)].sort(),
  };
  const manifestPath = join(backupRoot, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return {
    backupRoot,
    copiedFiles: files.length,
    missingFiles: manifest.missingFiles,
    manifestPath,
  };
}

export async function restoreWorkspaceBackup(backupRoot: string, targetRoot: string): Promise<RestoreReport> {
  const manifest = BackupManifestSchema.parse(
    JSON.parse(await readFile(join(backupRoot, "manifest.json"), "utf8")),
  );
  const targetPaths = workspacePaths(targetRoot);
  try {
    await stat(targetPaths.database);
    throw new Error(`Refusing to restore over an existing workspace database: ${targetPaths.database}`);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  await initializeWorkspaceDirectories(targetPaths);
  const missingFiles = [...manifest.missingFiles];
  let restoredFiles = 0;
  for (const file of manifest.files) {
    const source = pathInside(join(backupRoot, "workspace"), file.path);
    try {
      const bytes = await readFile(source);
      if (bytes.length !== file.byteLength || sha256(bytes) !== file.contentDigest)
        throw new Error(`Backup file failed digest verification: ${file.path}`);
      const destination = pathInside(targetRoot, file.path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(source, destination);
      restoredFiles += 1;
    } catch (error) {
      if (isMissing(error)) missingFiles.push(file.path);
      else throw error;
    }
  }
  return {
    targetRoot,
    restoredFiles,
    missingFiles: [...new Set(missingFiles)].sort(),
  };
}

async function walkFiles(root: string, workspaceRoot: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) files.push(...(await walkFiles(path, workspaceRoot)));
      else if (entry.isFile()) files.push(relative(workspaceRoot, path));
    }
    return files;
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function isMissing(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}
