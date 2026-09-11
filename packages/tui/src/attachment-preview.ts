import { getCapabilities, Image, type ImageProtocol } from "@earendil-works/pi-tui";
import type { DraftAttachment, ComposerPreview } from "./composer.ts";
import { createAttachmentThumbnail } from "./attachment-thumbnail.ts";

/** Never opt a multiplexer or unknown terminal into graphics, even via a protocol override. */
export function supportsAttachmentGraphics(
  env: Readonly<Record<string, string | undefined>>,
  protocol: ImageProtocol,
  interactive: boolean,
): boolean {
  const term = env["TERM"]?.toLowerCase() ?? "";
  if (
    !interactive ||
    !protocol ||
    term === "dumb" ||
    env["TMUX"] ||
    env["STY"] ||
    term.startsWith("screen") ||
    term.startsWith("tmux")
  )
    return false;
  if (env["PI_IMAGE_PROTOCOL"] === "none" || env["PI_IMAGE_PROTOCOL"] === "0") return false;
  const program = env["TERM_PROGRAM"]?.toLowerCase();
  return protocol === "kitty"
    ? Boolean(
        env["KITTY_WINDOW_ID"] ||
        env["GHOSTTY_RESOURCES_DIR"] ||
        env["WEZTERM_PANE"] ||
        ["kitty", "ghostty", "wezterm", "warpterminal"].includes(program ?? "") ||
        term.includes("kitty") ||
        term.includes("ghostty"),
      )
    : Boolean(env["ITERM_SESSION_ID"] || program === "iterm.app");
}

/** Preparation happens once outside render. The original bytes never enter terminal output. */
export function createAttachmentPreview(
  attachment: DraftAttachment,
  requestRender: () => void,
  interactive: boolean,
  prepare: typeof createAttachmentThumbnail = createAttachmentThumbnail,
): ComposerPreview | undefined {
  if (
    !("data" in attachment) ||
    !attachment.mimeType.startsWith("image/") ||
    !supportsAttachmentGraphics(process.env, getCapabilities().images, interactive)
  )
    return undefined;
  let image: Image | undefined;
  let disposed = false;
  void prepare(attachment)
    .then((thumbnail) => {
      if (disposed) return;
      image = new Image(
        thumbnail.data,
        "image/png",
        { fallbackColor: (text) => text },
        {
          maxWidthCells: 12,
          maxHeightCells: 2,
        },
        { widthPx: thumbnail.width, heightPx: thumbnail.height },
      );
      requestRender();
    })
    .catch(() => undefined); // A failed optional preview never invalidates an otherwise usable file.
  return {
    dispose: () => {
      disposed = true;
      image = undefined;
    },
    invalidate: () => image?.invalidate(),
    render: (width) => image?.render(width) ?? [],
  };
}
