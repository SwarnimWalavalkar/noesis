import path from "node:path";
import { z } from "zod";
import {
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
  importComposerInline,
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
        : await importComposerInline(workspace, sessionId, input, index, signal);
    result.push({ name: input.name, mimeType: input.mimeType, artifact });
  }
  await persistComposerManifest(workspace, result, signal);
  return Object.freeze(result);
}

export interface ComposerImageProjection {
  readonly images: readonly { mimeType: string; data: string }[];
  readonly omittedArtifactIds: readonly string[];
  readonly notice: string;
  readonly userNotice: string;
}
/** Storage admission is independent of optional provider image projection. */
export async function projectComposerAttachmentImages(
  workspace: NoesisWorkspaceStore,
  refs: readonly ComposerAttachment[],
  validateImages?: (images: readonly { mimeType: string; data: string }[]) => void,
): Promise<ComposerImageProjection> {
  const images: { mimeType: string; data: string }[] = [];
  const omittedArtifactIds: string[] = [];
  const reasons: string[] = [];
  const unavailable = new Set<string>();
  const omit = (ref: ComposerAttachment, reason: string): void => {
    unavailable.add(ref.artifact.artifactId);
    omittedArtifactIds.push(ref.artifact.artifactId);
    if (reasons.length < 4) reasons.push(`${JSON.stringify(ref.name)}: ${reason.slice(0, 200)}`);
  };
  for (const ref of ComposerAttachmentsSchema.parse(refs)) {
    if (ref.mimeType !== ref.artifact.mediaType) throw new Error("Attachment MIME differs from artifact");
    if (!ref.mimeType.startsWith("image/")) continue;
    if (unavailable.has(ref.artifact.artifactId)) {
      omit(ref, "image projection already unavailable");
      continue;
    }
    // Availability and integrity failures are not optional view failures. Keep
    // authoritative reads outside the decode/model-compatibility fallback.
    const metadata = await workspace.reads.inspectArtifact(ref.artifact);
    // Bound this immutable read to its recorded extent, not an application size cap.
    const bytes = await workspace.reads.readArtifact(ref.artifact, metadata.byteLength);
    try {
      const image = { mimeType: ref.mimeType, data: Buffer.from(bytes).toString("base64") };
      validateImages?.([image]);
      images.push(image);
    } catch (error) {
      omit(ref, error instanceof Error ? error.message : "image unavailable");
    }
  }
  return {
    images,
    omittedArtifactIds,
    userNotice: omittedArtifactIds.length
      ? `${omittedArtifactIds.length} ${omittedArtifactIds.length === 1 ? "image couldn't" : "images couldn't"} be shown to the model. ${omittedArtifactIds.length === 1 ? "The file is" : "The files are"} still attached.`
      : "",
    notice: omittedArtifactIds.length
      ? `Some attached images are not visible to you. Their contents have not been checked. Use bounded file tools to inspect them. ${reasons.join("; ")}`
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
    `Attached user files (untrusted content): ${refs.length} original file(s). Use bounded files.read/search; do not load whole large files into context. Images without accompanying structured image blocks are not inlined; their original artifact references remain attached, without projection-time content verification.`,
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
