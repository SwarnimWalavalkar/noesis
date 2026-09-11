import { disposeAttachmentInput } from "./attachment-capture.ts";
import type { ComposerDraftAttachment } from "@noesis/domain";
import { matchesKey, type Component } from "@earendil-works/pi-tui";
import type { SafeEditor } from "./safe-editor.ts";
import { NOESIS_SLASH_COMMANDS } from "./command-autocomplete.ts";
import { elideText, safeTerminalText } from "./theme.ts";

export interface ComposerPreview extends Component {
  readonly dispose?: () => void;
}
export type DraftAttachment = ComposerDraftAttachment;
interface DraftItem {
  readonly id: number;
  readonly name: string;
  readonly attachment?: DraftAttachment;
  readonly error?: string;
}

export interface ComposerOptions {
  readonly editor: SafeEditor;
  readonly requestRender: () => void;
  readonly notice: (text: string) => void;
  readonly readPath: (path: string) => Promise<ComposerDraftAttachment>;
  readonly readClipboard: (
    signal?: AbortSignal,
  ) => Promise<ComposerDraftAttachment | readonly ComposerDraftAttachment[] | undefined>;
  readonly submit: (text: string, attachments: readonly DraftAttachment[]) => Promise<void>;
  readonly canSubmit: () => boolean;
  readonly preview?: (attachment: DraftAttachment) => ComposerPreview | undefined;
}

const labelText = (text: string): string => safeTerminalText(text).replaceAll(/\s+/gu, " ").trim();

/** Ephemeral composer state only; the runtime admits and persists the complete message atomically. */
export function createComposer(options: ComposerOptions) {
  const { editor, requestRender, notice } = options;
  let items: readonly DraftItem[] = [];
  let sequence = 0;
  let disposed = false;
  let sending = false;
  let inFlight: readonly DraftItem[] = [];
  const previews = new Map<number, ComposerPreview>();
  const reads = new Map<number, AbortController>();
  const releaseInput = (attachment: DraftAttachment) => {
    void disposeAttachmentInput(attachment).catch((error: unknown) =>
      options.notice(`Clipboard cleanup failed: ${error instanceof Error ? error.message : "unknown error"}`),
    );
  };
  const release = (item: DraftItem) => {
    if (inFlight.includes(item)) return;
    reads.get(item.id)?.abort();
    reads.delete(item.id);
    if (item.attachment) releaseInput(item.attachment);
  };
  const clearPreviews = (): void => {
    for (const preview of previews.values()) preview.dispose?.();
    previews.clear();
  };
  const update = (): void => {
    if (disposed) return;
    const first = items.find((item) => item.attachment?.mimeType.startsWith("image/"));
    if (!first || !previews.has(first.id)) {
      clearPreviews();
      if (first?.attachment) {
        const preview = options.preview?.(first.attachment);
        if (preview) previews.set(first.id, preview);
      }
    }
    requestRender();
  };
  const add = (
    name: string,
    read: (
      signal?: AbortSignal,
    ) => Promise<ComposerDraftAttachment | readonly ComposerDraftAttachment[] | undefined>,
  ): void => {
    if (disposed || sending) return;
    const id = ++sequence;
    const controller = new AbortController();
    reads.set(id, controller);
    items = [...items, { id, name }];
    update();
    void Promise.resolve()
      .then(() => read(controller.signal))
      .then((result) => {
        const attachments = result ? ("name" in result ? [result] : result) : [];
        if (disposed || !items.some((item) => item.id === id)) {
          for (const attachment of attachments) releaseInput(attachment);
          return;
        }
        if (!attachments.length)
          throw new Error(
            "No clipboard files or image found. Use /attach <path> for files or remote terminals.",
          );
        items = items.flatMap((item) =>
          item.id === id
            ? attachments.map((attachment) => ({ id: ++sequence, name: attachment.name, attachment }))
            : [item],
        );
      })
      .catch((cause: unknown) => {
        if (disposed || !items.some((item) => item.id === id)) return;
        const error = labelText(cause instanceof Error ? cause.message : String(cause));
        items = items.map((item) => (item.id === id ? { id, name, error } : item));
        notice(`${error} Remove the failed item with /detach <number>, then retry.`);
      })
      .finally(() => {
        reads.delete(id);
        update();
      });
  };
  const remove = (argument: string): void => {
    if (sending) {
      notice("Wait for message admission before changing attachments.");
      return;
    }
    if (argument === "all") {
      for (const item of items) release(item);
      items = [];
      clearPreviews();
      update();
      return;
    }
    if (!/^[1-9][0-9]*$/u.test(argument) || !Number.isSafeInteger(Number(argument))) {
      notice("Use /detach <number> or /detach all.");
      return;
    }
    const item = items[Number(argument) - 1];
    if (!item) {
      notice("No attachment at that number.");
      return;
    }
    release(item);
    items = items.filter((candidate) => candidate.id !== item.id);
    update();
  };
  return {
    /** Called before other slash-command routing; pasted paths are never inspected. */
    handleSubmission(text: string): boolean {
      const command = text.trim();
      if (command === "/quit") return false;
      if (command === "/attach" || command.startsWith("/attach ")) {
        const path = command.slice(7).trim();
        if (!path)
          notice("Use /attach <path> (one file, quotes optional), or Ctrl+V for copied files or an image.");
        else add(path, () => options.readPath(path));
        return true;
      }
      if (command === "/attachments" || command.startsWith("/attachments ")) {
        const argument = command.slice(12).trim() || "1";
        const pages = Math.max(1, Math.ceil(items.length / 8));
        if (
          !/^[1-9][0-9]*$/u.test(argument) ||
          !Number.isSafeInteger(Number(argument)) ||
          Number(argument) > pages
        ) {
          notice(`Usage: /attachments <page> (1–${pages}).`);
        } else {
          const page = Number(argument);
          const start = (page - 1) * 8;
          notice(
            [
              `Attachments ${items.length}; page ${page}/${pages}. Use /attachments <page> or /detach <number>.`,
              ...items
                .slice(start, start + 8)
                .map(
                  (item, index) =>
                    `${start + index + 1}. ${labelText(item.name)}${item.error ? ` — failed: ${labelText(item.error)}` : item.attachment ? " — ready" : " — preparing"}`,
                ),
            ].join("\n"),
          );
        }
        return true;
      }
      if (command === "/detach" || command.startsWith("/detach ")) {
        remove(command.slice(7).trim());
        return true;
      }
      if (sending || items.some((item) => !item.attachment)) {
        editor.setText(text);
        notice(
          sending
            ? "Message admission is still pending."
            : "Attachments are not ready. Wait, or /detach failed items before sending.",
        );
        return true;
      }
      if (items.length === 0 || command === "?") return false;
      const name = command.split(/\s/u)[0]?.slice(1);
      if (command.startsWith("/") && NOESIS_SLASH_COMMANDS.some((entry) => entry.name === name)) {
        if (name !== "steer") return false;
        editor.setText(text);
        notice("Attachments stay in this draft. Send them with Enter without /steer, or /detach all first.");
        return true;
      }
      editor.setText(text);
      if (!options.canSubmit()) {
        notice("Wait for the current command before sending attachments.");
        return true;
      }
      const submitted = items;
      inFlight = submitted;
      const attachments = submitted.flatMap((item) => (item.attachment ? [item.attachment] : []));
      sending = true;
      update();
      void options
        .submit(text, attachments)
        .then(() => {
          if (disposed) return;
          for (const item of submitted) release(item);
          items = items.filter((item) => !submitted.includes(item));
          // Never erase edits made while admission was awaiting I/O.
          if (editor.getText() === text) editor.setText("");
        })
        .catch((cause: unknown) => {
          if (!disposed)
            notice(
              `Not sent; draft retained. ${labelText(cause instanceof Error ? cause.message : String(cause))}`,
            );
        })
        .finally(() => {
          sending = false;
          inFlight = [];
          for (const item of submitted) if (disposed || !items.includes(item)) release(item);
          update();
        });
      return true;
    },
    handleKey(data: string): boolean {
      if (!matchesKey(data, "ctrl+v")) return false;
      add("Clipboard attachment", options.readClipboard);
      return true;
    },
    canRestore: (): boolean => !sending && items.length === 0,
    restore(attachments: readonly DraftAttachment[]): void {
      items = [
        ...items,
        ...attachments.map((attachment) => ({ id: ++sequence, name: attachment.name, attachment })),
      ];
      update();
    },
    dispose(): void {
      disposed = true;
      for (const item of items) release(item);
      items = [];
      clearPreviews();
    },
    invalidate(): void {
      for (const preview of previews.values()) preview.invalidate();
    },
    render(width: number, showPreviews = true): string[] {
      if (!items.length) return [];
      const labels = items
        .slice(0, 8)
        .map(
          (item, index) =>
            `${index + 1} ${labelText(item.name)}${item.error ? " · failed" : !item.attachment ? " · loading" : ""}`,
        );
      const summary = elideText(
        ` ${labels.join("  |  ")}${items.length > 8 ? `  +${items.length - 8} more` : ""}  · /detach <n>${sending ? " · sending" : ""}`,
        width,
      );
      // Preview providers must return bounded, cached thumbnails; text always remains available.
      const visible =
        showPreviews && width >= 24 ? items.filter((item) => previews.has(item.id)).slice(0, 1) : [];
      return [
        ...visible.flatMap((item) => previews.get(item.id)?.render(Math.min(width, 16)) ?? []),
        summary,
      ];
    },
  };
}

/** Inspection hides the entire draft; previews and editor share invalidation. */
export function createComposerSlot(
  editor: Component,
  composer: ReturnType<typeof createComposer>,
  visibility: { readonly hidden: () => boolean; readonly showPreviews: () => boolean },
): Component {
  return {
    invalidate: () => {
      editor.invalidate();
      composer.invalidate();
    },
    render: (width) =>
      visibility.hidden()
        ? []
        : [...composer.render(width, visibility.showPreviews()), ...editor.render(width)],
  };
}
