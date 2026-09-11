export {
  imageProjectionTokens,
  attachmentImageDimensions,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS,
} from "./image-dimensions.ts";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ArtifactFileRefSchema } from "./storage-schemas.ts";

/** Working-set bounds for optional inline image projection, never storage admission. */
export const COMPOSER_IMAGE_PROJECTION_LIMITS = Object.freeze({
  perImageBytes: 10 * 1024 * 1024,
  totalBytes: 20 * 1024 * 1024,
});
export const COMPOSER_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
const nameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((name) => name !== "." && name !== "..", "Attachment name must be a filename")
  .refine(
    (name) =>
      [...name].every(
        (character) =>
          character.charCodeAt(0) >= 32 &&
          character.charCodeAt(0) !== 127 &&
          character !== "/" &&
          character !== "\\",
      ),
    "Attachment name must be a plain filename",
  );
const mimeSchema = z
  .string()
  .max(127)
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u);
export const ComposerAttachmentInputSchema = z.strictObject({
  name: nameSchema,
  mimeType: mimeSchema,
  data: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/u),
});
export type ComposerAttachmentInput = Readonly<z.infer<typeof ComposerAttachmentInputSchema>>;
export const ComposerAttachmentSchema = z.strictObject({
  name: nameSchema,
  mimeType: mimeSchema,
  artifact: ArtifactFileRefSchema,
});
export type ComposerAttachment = Readonly<z.infer<typeof ComposerAttachmentSchema>>;
export const ComposerAttachmentsSchema = z.array(ComposerAttachmentSchema);
export const ComposerFileInputSchema = z.strictObject({
  name: nameSchema,
  mimeType: mimeSchema,
  sourcePath: z
    .string()
    .min(1)
    .refine((path) => !path.includes("\0")),
  sourceSize: z.number().int().nonnegative(),
  sourceMtimeMs: z.number().nonnegative(),
  sourceCtimeMs: z.number().nonnegative(),
  sourceIno: z.number().int().nonnegative(),
  sourceDev: z.number().int().nonnegative(),
});
export type ComposerFileInput = Readonly<z.infer<typeof ComposerFileInputSchema>>;
export type ComposerDraftAttachment = ComposerAttachmentInput | ComposerFileInput | ComposerAttachment;
export function validateComposerAttachmentInputs(value: unknown): readonly ComposerAttachmentInput[] {
  const inputs = z.array(ComposerAttachmentInputSchema).parse(value);
  for (const input of inputs) {
    const bytes = Buffer.from(input.data, "base64");
    if (bytes.toString("base64") !== input.data) throw new Error("Invalid attachment base64");
  }
  return inputs;
}

/** Text-only digests retain compatibility with existing durable intents. */
export function composerContentDigest(text: string, attachments: readonly ComposerAttachment[] = []): string {
  const hash = createHash("sha256");
  if (attachments.length) hash.update(Buffer.from([0xff]));
  return hash
    .update(
      attachments.length === 0
        ? text
        : JSON.stringify({
            text,
            attachments: attachments.map((a) => ({
              name: a.name,
              mimeType: a.mimeType,
              artifact: {
                kind: a.artifact.kind,
                artifactId: a.artifact.artifactId,
                path: a.artifact.path,
                mediaType: a.artifact.mediaType,
              },
            })),
          }),
    )
    .digest("hex");
}
