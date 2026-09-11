import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import path from "node:path";
import type { ComposerAttachment, ComposerFileInput } from "@noesis/domain";
import type { NoesisWorkspaceStore } from "@noesis/workspace";

/** Preflight every selected source before the batch creates any immutable artifacts. */
export async function validateComposerFileSource(input: ComposerFileInput): Promise<void> {
  const source = await open(input.sourcePath, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await source.stat();
    if (
      !info.isFile() ||
      info.size !== input.sourceSize ||
      info.mtimeMs !== input.sourceMtimeMs ||
      info.ctimeMs !== input.sourceCtimeMs ||
      info.ino !== input.sourceIno ||
      info.dev !== input.sourceDev
    )
      throw new Error("Attachment changed since selection; detach and attach it again.");
  } finally {
    await source.close();
  }
}
export async function importComposerFile(
  workspace: NoesisWorkspaceStore,
  sessionId: string,
  input: ComposerFileInput,
  index: number,
  signal?: AbortSignal,
) {
  const identity = createHash("sha256").update(JSON.stringify({ sessionId, index, input })).digest("hex");
  return await workspace.artifacts.importArtifact({
    path: `composer/${identity}/${input.name}`,
    mediaType: input.mimeType,
    sourcePath: input.sourcePath,
    actor: { kind: "user", actorId: sessionId },
    relationshipRefs: [{ kind: "database_row", table: "sessions", rowId: sessionId }],
    expectedSource: {
      byteLength: input.sourceSize,
      mtimeMs: input.sourceMtimeMs,
      ctimeMs: input.sourceCtimeMs,
      ino: input.sourceIno,
      dev: input.sourceDev,
    },
    ...(signal ? { signal } : {}),
  });
}

export function composerManifestPath(refs: readonly ComposerAttachment[]): string {
  const hash = createHash("sha256");
  for (const ref of refs) hash.update(JSON.stringify(ref)).update("\n");
  return `composer/manifests/${hash.digest("hex")}.jsonl`;
}

/** Bounded prompt listings always link to the complete, line-addressable immutable manifest. */
export async function persistComposerManifest(
  workspace: NoesisWorkspaceStore,
  refs: readonly ComposerAttachment[],
): Promise<void> {
  if (refs.length <= 8) return;
  const directory = await mkdtemp(path.join(workspace.paths.staging, "composer-manifest-"));
  const sourcePath = path.join(directory, "manifest.jsonl");
  try {
    const file = await open(sourcePath, "wx", 0o600);
    try {
      for (const ref of refs) await file.write(`${JSON.stringify(ref)}\n`);
    } finally {
      await file.close();
    }
    await workspace.artifacts.importArtifact({
      path: composerManifestPath(refs),
      mediaType: "application/x-ndjson",
      sourcePath,
      actor: { kind: "system", actorId: "composer-manifest" },
      relationshipRefs: [],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
