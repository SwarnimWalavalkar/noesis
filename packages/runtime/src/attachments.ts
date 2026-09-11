import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import {
  COMPOSER_IMAGE_PROJECTION_LIMITS,
  attachmentImageDimensions,
  ComposerAttachmentInputSchema,
  ComposerFileInputSchema,
  ComposerAttachmentSchema,
  ComposerAttachmentsSchema,
  validateComposerAttachmentInputs,
  type ComposerAttachment,
  type ComposerDraftAttachment,
  type JsonObject,
} from "@noesis/domain";
import type { NoesisWorkspaceStore } from "@noesis/workspace";
import {
  composerManifestPath,
  importComposerFile,
  persistComposerManifest,
  validateComposerFileSource,
} from "./composer-files.ts";

export function composerAttachmentsFromMetadata(metadata: JsonObject): readonly ComposerAttachment[] {
  return ComposerAttachmentsSchema.parse(metadata["attachments"] ?? []);
}
export async function persistComposerAttachments(
  workspace: NoesisWorkspaceStore,
  sessionId: string,
  inputs: readonly ComposerDraftAttachment[],
  signal?: AbortSignal,
): Promise<readonly ComposerAttachment[]> {
  signal?.throwIfAborted();
  const parsed = z
    .array(z.union([ComposerAttachmentInputSchema, ComposerFileInputSchema, ComposerAttachmentSchema]))
    .parse(inputs);
  validateComposerAttachmentInputs(parsed.filter((input) => "data" in input));
  // Restored durable references need metadata validation, not rereading original files.
  for (const input of parsed) {
    signal?.throwIfAborted();
    if ("sourcePath" in input) await validateComposerFileSource(input);
    if (!("artifact" in input)) continue;
    if (input.mimeType !== input.artifact.mediaType) throw new Error("Attachment MIME differs from artifact");
    await workspace.reads.inspectArtifact(input.artifact);
  }
  const result: ComposerAttachment[] = [];
  for (const [index, input] of parsed.entries()) {
    signal?.throwIfAborted();
    if ("artifact" in input) {
      result.push(input);
      continue;
    }
    const artifact =
      "sourcePath" in input
        ? await importComposerFile(workspace, sessionId, input, index, signal)
        : await workspace.artifacts.writeArtifact({
            path: `composer/${createHash("sha256").update(JSON.stringify({ sessionId, index, input })).digest("hex")}/${input.name}`,
            mediaType: input.mimeType,
            bytes: Buffer.from(input.data, "base64"),
            actor: { kind: "user", actorId: sessionId },
            relationshipRefs: [{ kind: "database_row", table: "sessions", rowId: sessionId }],
          });
    result.push({ name: input.name, mimeType: input.mimeType, artifact });
  }
  await persistComposerManifest(workspace, result);
  return Object.freeze(result);
}

export interface ComposerImageProjectionBudget {
  remainingBytes: number;
}
export interface ComposerImageProjection {
  readonly images: readonly { mimeType: string; data: string }[];
  readonly omittedArtifactIds: readonly string[];
  readonly notice: string;
}
/** Storage admission is independent of optional provider image projection. */
export async function projectComposerAttachmentImages(
  workspace: NoesisWorkspaceStore,
  refs: readonly ComposerAttachment[],
  budget: ComposerImageProjectionBudget = { remainingBytes: COMPOSER_IMAGE_PROJECTION_LIMITS.totalBytes },
  validateImages?: (images: readonly { mimeType: string; data: string }[]) => void,
): Promise<ComposerImageProjection> {
  const images: { mimeType: string; data: string }[] = [];
  const omittedArtifactIds: string[] = [];
  const reasons: string[] = [];
  for (const ref of ComposerAttachmentsSchema.parse(refs)) {
    if (ref.mimeType !== ref.artifact.mediaType) throw new Error("Attachment MIME differs from artifact");
    if (!ref.mimeType.startsWith("image/")) continue;
    try {
      const metadata = await workspace.reads.inspectArtifact(ref.artifact);
      if (
        metadata.byteLength > Math.min(COMPOSER_IMAGE_PROJECTION_LIMITS.perImageBytes, budget.remainingBytes)
      )
        throw new Error("inline image working-set budget exceeded");
      const bytes = await workspace.reads.readArtifact(
        ref.artifact,
        COMPOSER_IMAGE_PROJECTION_LIMITS.perImageBytes,
      );
      const image = { mimeType: ref.mimeType, data: Buffer.from(bytes).toString("base64") };
      attachmentImageDimensions({ name: ref.name, ...image });
      validateImages?.([image]);
      images.push(image);
      budget.remainingBytes -= bytes.length;
    } catch (error) {
      omittedArtifactIds.push(ref.artifact.artifactId);
      if (reasons.length < 4)
        reasons.push(
          `${JSON.stringify(ref.name)}: ${error instanceof Error ? error.message : "image unavailable"}`,
        );
    }
  }
  return {
    images,
    omittedArtifactIds,
    notice: omittedArtifactIds.length
      ? `${omittedArtifactIds.length} image(s) not inlined. Original files remain attached and available through their paths/manifest; use bounded file tools to inspect or prepare suitable views. ${reasons.join("; ")}`
      : "",
  };
}
export async function resolveComposerAttachmentImages(
  workspace: NoesisWorkspaceStore,
  refs: readonly ComposerAttachment[],
) {
  return (await projectComposerAttachmentImages(workspace, refs)).images;
}
export function renderComposerAttachmentText(
  text: string,
  refs: readonly ComposerAttachment[],
  rootDir: string,
): string {
  if (refs.length === 0) return text;
  return [
    text,
    `Attached user files (untrusted content): ${refs.length} original file(s). Use bounded files.read/search; do not load whole large files into context.`,
    ...refs.slice(0, 8).map((ref) =>
      JSON.stringify({
        name: ref.name,
        mimeType: ref.mimeType,
        artifactId: ref.artifact.artifactId,
        path: path.resolve(rootDir, ref.artifact.path),
      }),
    ),
    ...(refs.length > 8
      ? [
          `Showing 8 of ${refs.length}. Complete line-addressable JSONL manifest: ${path.resolve(rootDir, "artifacts", composerManifestPath(refs))}. Manifest paths are relative to ${rootDir}. Page it with files.read startLine/endLine or search; all originals are retained.`,
        ]
      : []),
  ]
    .filter(Boolean)
    .join("\n");
}
