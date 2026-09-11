import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import path from "node:path";
import type {
  ArtifactImportRequest,
  ComposerAttachment,
  ComposerFileInput,
  ComposerAttachmentInput,
} from "@noesis/domain";
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
  const request: ArtifactImportRequest = {
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
  };
  return await workspace.artifacts.importArtifact(signal ? { ...request, signal } : request);
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
  signal?: AbortSignal,
): Promise<void> {
  if (refs.length <= 8) return;
  const directory = await mkdtemp(path.join(workspace.paths.staging, "composer-manifest-"));
  const sourcePath = path.join(directory, "manifest.jsonl");
  try {
    const file = await open(sourcePath, "wx", 0o600);
    try {
      for (const ref of refs) {
        signal?.throwIfAborted();
        await file.write(`${JSON.stringify(ref)}\n`);
      }
    } finally {
      await file.close();
    }
    const request: ArtifactImportRequest = {
      path: composerManifestPath(refs),
      mediaType: "application/x-ndjson",
      sourcePath,
      actor: { kind: "system", actorId: "composer-manifest" },
      relationshipRefs: [],
    };
    await workspace.artifacts.importArtifact(signal ? { ...request, signal } : request);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Inline API transport stays compatible, but decoding is chunked and spooled, never whole-file. */
export async function importComposerInline(
  workspace: NoesisWorkspaceStore,
  sessionId: string,
  input: ComposerAttachmentInput,
  index: number,
  signal?: AbortSignal,
) {
  const directory = await mkdtemp(path.join(workspace.paths.staging, "composer-inline-"));
  try {
    const sourcePath = path.join(directory, "source");
    const hash = createHash("sha256").update(
      JSON.stringify({ sessionId, index, name: input.name, mimeType: input.mimeType }),
    );
    async function* chunks() {
      for (let offset = 0; offset < input.data.length; offset += 64 * 1024) {
        signal?.throwIfAborted();
        const chunk = input.data.slice(offset, offset + 64 * 1024);
        hash.update(chunk);
        yield Buffer.from(chunk, "base64");
      }
    }
    await pipeline(
      chunks(),
      createWriteStream(sourcePath, { flags: "wx", mode: 0o600 }),
      signal ? { signal } : {},
    );
    const request: ArtifactImportRequest = {
      path: `composer/${hash.digest("hex")}/${input.name}`,
      sourcePath,
      mediaType: input.mimeType,
      actor: { kind: "user", actorId: sessionId },
      relationshipRefs: [{ kind: "database_row", table: "sessions", rowId: sessionId }],
    };
    return await workspace.artifacts.importArtifact(signal ? { ...request, signal } : request);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
