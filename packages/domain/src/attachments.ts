import { createHash } from "node:crypto";
import { z } from "zod";
import { ArtifactFileRefSchema } from "./storage-schemas.ts";

export const COMPOSER_ATTACHMENT_LIMITS = Object.freeze({
  count: 8,
  perFileBytes: 10 * 1024 * 1024,
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
  data: z
    .string()
    .max(4 * Math.ceil(COMPOSER_ATTACHMENT_LIMITS.perFileBytes / 3))
    .regex(/^[A-Za-z0-9+/]*={0,2}$/u),
});
export type ComposerAttachmentInput = Readonly<z.infer<typeof ComposerAttachmentInputSchema>>;
export const ComposerAttachmentSchema = z.strictObject({
  name: nameSchema,
  mimeType: mimeSchema,
  artifact: ArtifactFileRefSchema,
});
export type ComposerAttachment = Readonly<z.infer<typeof ComposerAttachmentSchema>>;
export const ComposerAttachmentsSchema = z
  .array(ComposerAttachmentSchema)
  .max(COMPOSER_ATTACHMENT_LIMITS.count);
export function validateComposerAttachmentInputs(value: unknown): readonly ComposerAttachmentInput[] {
  const inputs = z.array(ComposerAttachmentInputSchema).max(COMPOSER_ATTACHMENT_LIMITS.count).parse(value);
  let total = 0;
  for (const input of inputs) {
    const bytes = Buffer.from(input.data, "base64");
    if (bytes.toString("base64") !== input.data || bytes.length > COMPOSER_ATTACHMENT_LIMITS.perFileBytes)
      throw new Error("Invalid or oversized attachment base64");
    total += bytes.length;
    if (total > COMPOSER_ATTACHMENT_LIMITS.totalBytes) throw new Error("Attachments exceed total byte limit");
    if (input.mimeType.startsWith("image/")) {
      const valid =
        input.mimeType === "image/png"
          ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : input.mimeType === "image/jpeg"
            ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
            : input.mimeType === "image/gif"
              ? ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))
              : input.mimeType === "image/webp"
                ? bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
                  bytes.subarray(8, 12).toString("ascii") === "WEBP"
                : false;
      if (!valid)
        throw new Error(`Unsupported or invalid image attachment: ${input.name} (${input.mimeType})`);
    }
  }
  if (total > COMPOSER_ATTACHMENT_LIMITS.totalBytes) throw new Error("Attachments exceed total byte limit");
  return inputs;
}

/** Text-only digests retain compatibility with existing durable intents. */
export function composerContentDigest(text: string, attachments: readonly ComposerAttachment[] = []): string {
  return createHash("sha256")
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
