import { createConditionalObject } from "@noesis/domain";
import type { TUI } from "@earendil-works/pi-tui";
import { editTextInExternalEditor } from "./external-editor.ts";
import type { SafeEditor } from "./safe-editor.ts";

export function createExternalEditorAction(options: {
  readonly editor: SafeEditor;
  readonly tui: TUI;
  readonly isActive: () => boolean;
  readonly configuredCommand: string | undefined;
  readonly notice: (text: string) => void;
}): () => void {
  let active = false;
  return () => {
    if (active) return;
    active = true;
    const { editor, tui } = options;
    editor.disableSubmit = true;
    tui.stop();
    void editTextInExternalEditor(
      createConditionalObject({ content: editor.getText() })
        .addOptional(options.configuredCommand ? { configuredCommand: options.configuredCommand } : undefined)
        .finish(),
    )
      .then((result) => {
        if (!options.isActive()) return;
        if (result.status === "edited") editor.setText(result.content);
        else options.notice(`External editor left the draft unchanged (${result.reason}).`);
      })
      .finally(() => {
        active = false;
        if (!options.isActive()) return;
        editor.disableSubmit = false;
        tui.start();
        tui.setFocus(editor);
        tui.requestRender(true);
      });
  };
}
