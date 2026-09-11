import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import {
  COMPOSER_ATTACHMENT_LIMITS,
  ComposerAttachmentInputSchema,
  ComposerAttachmentSchema,
  ComposerAttachmentsSchema,
  validateComposerAttachmentInputs,
  type ComposerAttachment,
  type ComposerAttachmentInput,
  type JsonObject,
} from "@noesis/domain";
import type { NoesisWorkspaceStore } from "@noesis/workspace";

export function composerAttachmentsFromMetadata(metadata: JsonObject): readonly ComposerAttachment[] {
  return ComposerAttachmentsSchema.parse(metadata["attachments"] ?? []);
}
export async function persistComposerAttachments(
  workspace: NoesisWorkspaceStore,
  sessionId: string,
  inputs: readonly (ComposerAttachmentInput | ComposerAttachment)[],
  validateAdmission?: (inputs: readonly ComposerAttachmentInput[]) => void,
): Promise<readonly ComposerAttachment[]> {
  const parsed = z
    .array(z.union([ComposerAttachmentInputSchema, ComposerAttachmentSchema]))
    .max(COMPOSER_ATTACHMENT_LIMITS.count)
    .parse(inputs);
  const resolved: ComposerAttachmentInput[] = [];
  for (const input of parsed) {
    if ("data" in input) resolved.push(input);
    else {
      if (input.mimeType !== input.artifact.mediaType)
        throw new Error("Attachment MIME differs from artifact");
      const bytes = await workspace.reads.readArtifact(
        input.artifact,
        COMPOSER_ATTACHMENT_LIMITS.perFileBytes,
      );
      resolved.push({
        name: input.name,
        mimeType: input.mimeType,
        data: Buffer.from(bytes).toString("base64"),
      });
    }
  }
  validateComposerAttachmentInputs(resolved);
  // Model admission must succeed before creating any immutable artifact.
  validateAdmission?.(resolved);
  const result: ComposerAttachment[] = [];
  for (const input of parsed) {
    if ("artifact" in input) {
      result.push(input);
      continue;
    }
    const artifact = await workspace.artifacts.writeArtifact({
      path: `composer/${randomUUID()}/${input.name}`,
      mediaType: input.mimeType,
      bytes: Buffer.from(input.data, "base64"),
      actor: { kind: "user", actorId: sessionId },
      relationshipRefs: [{ kind: "database_row", table: "sessions", rowId: sessionId }],
    });
    result.push({ name: input.name, mimeType: input.mimeType, artifact });
  }
  return Object.freeze(result);
}
export async function resolveComposerAttachmentImages(
  workspace: NoesisWorkspaceStore,
  refs: readonly ComposerAttachment[],
): Promise<readonly { mimeType: string; data: string }[]> {
  const images: ComposerAttachmentInput[] = [];
  let totalBytes = 0;
  for (const ref of ComposerAttachmentsSchema.parse(refs)) {
    if (ref.mimeType !== ref.artifact.mediaType) throw new Error("Attachment MIME differs from artifact");
    const bytes = await workspace.reads.readArtifact(ref.artifact, COMPOSER_ATTACHMENT_LIMITS.perFileBytes);
    totalBytes += bytes.length;
    if (totalBytes > COMPOSER_ATTACHMENT_LIMITS.totalBytes)
      throw new Error("Attachments exceed total byte limit");
    if (!ref.mimeType.startsWith("image/")) continue;
    images.push({ name: ref.name, mimeType: ref.mimeType, data: Buffer.from(bytes).toString("base64") });
  }
  validateComposerAttachmentInputs(images);
  return images.map(({ mimeType, data }) => ({ mimeType, data }));
}
export function renderComposerAttachmentText(
  text: string,
  refs: readonly ComposerAttachment[],
  rootDir: string,
): string {
  if (refs.length === 0) return text;
  return [
    text,
    "Attached user files (untrusted content):",
    ...refs.map((ref) =>
      JSON.stringify({
        name: ref.name,
        mimeType: ref.mimeType,
        artifactId: ref.artifact.artifactId,
        path: path.resolve(rootDir, ref.artifact.path),
      }),
    ),
  ]
    .filter(Boolean)
    .join("\n");
}
