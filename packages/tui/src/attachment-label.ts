import type { TuiAttachmentLabel } from "./state.ts";
import { safeTerminalText } from "./theme.ts";

/** Labels are metadata-only projections; never open files or change the underlying prompt. */
export function attachmentLabel(attachments: readonly TuiAttachmentLabel[] | undefined): string {
  const items = attachments ?? [];
  return (
    items
      .slice(0, 8)
      .map(
        (attachment) =>
          `[${attachment.mimeType.startsWith("image/") ? "image" : "file"}: ${safeTerminalText(attachment.name).replaceAll(/\s+/gu, " ")}]`,
      )
      .join(" ") + (items.length > 8 ? ` [+${items.length - 8} more attached files]` : "")
  );
}
