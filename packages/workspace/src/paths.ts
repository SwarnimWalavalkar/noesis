import { mkdir } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { WorkspacePaths } from "./types.ts";

export function workspacePaths(root: string): WorkspacePaths {
  const absolute = resolve(root);
  return Object.freeze({
    root: absolute,
    database: join(absolute, "database", "noesis.sqlite"),
    definitions: join(absolute, "definitions"),
    candidates: join(absolute, "definitions", "candidates"),
    active: join(absolute, "definitions", "active"),
    revisions: join(absolute, "revisions"),
    evidence: join(absolute, "evidence"),
    artifacts: join(absolute, "artifacts"),
    staging: join(absolute, ".staging"),
  });
}

export async function initializeWorkspaceDirectories(paths: WorkspacePaths): Promise<void> {
  await Promise.all(
    [
      paths.root,
      join(paths.root, "database"),
      paths.definitions,
      join(paths.definitions, "config"),
      join(paths.definitions, "profile-memory"),
      join(paths.definitions, "prompts"),
      join(paths.definitions, "skills"),
      join(paths.definitions, "capabilities"),
      join(paths.definitions, "tools"),
      join(paths.definitions, "evals"),
      paths.candidates,
      paths.active,
      paths.revisions,
      paths.evidence,
      paths.artifacts,
      paths.staging,
    ].map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
  );
}

export function safeRelativePath(value: string): string {
  if (value.length === 0 || isAbsolute(value))
    throw new Error(`Expected a non-empty relative path: ${value}`);
  const cleaned = normalize(value);
  if (cleaned === ".." || cleaned.startsWith(`..${sep}`))
    throw new Error(`Path escapes the workspace: ${value}`);
  return cleaned;
}

export function pathInside(root: string, relativePath: string): string {
  const target = resolve(root, safeRelativePath(relativePath));
  const fromRoot = relative(resolve(root), target);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot))
    throw new Error(`Path escapes the workspace: ${relativePath}`);
  return target;
}

export function workspaceRelative(paths: WorkspacePaths, absolutePath: string): string {
  const result = relative(paths.root, absolutePath);
  if (result === ".." || result.startsWith(`..${sep}`) || isAbsolute(result))
    throw new Error(`Path is outside the workspace: ${absolutePath}`);
  return result;
}
