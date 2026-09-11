import type { TuiAttachmentLabel } from "./state.ts";
import { safeTerminalText } from "./theme.ts";

/** Labels are metadata-only projections; never open files or change the underlying prompt. */
export function attachmentLabel(attachments: readonly TuiAttachmentLabel[] | undefined): string {
  return (attachments ?? [])
    .map(
      (attachment) =>
        `[${attachment.mimeType.startsWith("image/") ? "image" : "file"}: ${safeTerminalText(attachment.name).replaceAll(/\s+/gu, " ")}]`,
    )
    .join(" ");
}
