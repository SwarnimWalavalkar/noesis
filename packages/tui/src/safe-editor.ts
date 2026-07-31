import {
  Editor,
  matchesKey,
  type AutocompleteProvider,
  type Component,
  type Focusable,
  type SelectListTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import { createNoesisCommandAutocompleteProvider } from "./command-autocomplete.ts";
import { ANSI, elideText, styled } from "./theme.ts";

export {
  createNoesisCommandAutocompleteProvider,
  NOESIS_SLASH_COMMANDS,
} from "./command-autocomplete.ts";

export function createSelectTheme(colorEnabled: boolean): SelectListTheme {
  return {
    selectedPrefix: (text) => styled(colorEnabled, `${ANSI.bold}${ANSI.cyan}`, text),
    selectedText: (text) => styled(colorEnabled, ANSI.bold, text),
    description: (text) => styled(colorEnabled, ANSI.dim, text),
    scrollInfo: (text) => styled(colorEnabled, ANSI.dim, text),
    noMatch: (text) => styled(colorEnabled, ANSI.yellow, text),
  };
}

const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";
const SAFE_EDITOR_ESCAPE_AMBIGUITY_MS = 50;
const SAFE_EDITOR_MARKER_AMBIGUITY_MS = 150;
const SAFE_EDITOR_CLOSE_AMBIGUITY_MS = 75;
const SAFE_EDITOR_MAX_BUFFERED_CHARACTERS = 1024 * 1024;

type SafeEditorInputState =
  | { readonly kind: "keyboard"; readonly pending: string }
  | { readonly kind: "paste"; readonly text: string }
  | {
      readonly kind: "paste-close";
      readonly text: string;
      readonly trailing: string;
    };

const markerPrefixSuffixLength = (text: string, marker: string): number => {
  for (let length = Math.min(text.length, marker.length - 1); length > 0; length -= 1) {
    if (marker.startsWith(text.slice(-length))) return length;
  }
  return 0;
};

export function sanitizeEditorText(text: string): string {
  return [...text.replaceAll("\r\n", "\n")]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      if (code === 9 || code === 10) return character;
      if (code === 13) return "\n";
      return code >= 32 && !(code >= 127 && code <= 159) && code !== 0x1b ? character : " ";
    })
    .join("");
}

export interface SafeEditor extends Component, Focusable {
  onSubmit: ((text: string) => void) | undefined;
  disableSubmit: boolean;
  readonly getText: () => string;
  readonly setText: (text: string) => void;
  readonly insertText: (text: string) => void;
  /** True only when raw input cannot be part of a bracketed-paste marker or payload. */
  readonly acceptsUnbracketedCommandInput: () => boolean;
}

export function createSafeEditor(
  tui: TUI,
  colorEnabled = false,
  selectTheme: SelectListTheme = createSelectTheme(colorEnabled),
  height: () => number = () => Number.POSITIVE_INFINITY,
  autocompleteProvider: AutocompleteProvider = createNoesisCommandAutocompleteProvider(),
): SafeEditor {
  const editor = new Editor(
    tui,
    {
      borderColor: (text) => styled(colorEnabled, ANSI.cyan, text),
      selectList: selectTheme,
    },
    { paddingX: 1 },
  );
  editor.setAutocompleteProvider(autocompleteProvider);
  let inputState: SafeEditorInputState = { kind: "keyboard", pending: "" };
  let ambiguityTimer: NodeJS.Timeout | undefined;
  let submit: ((text: string) => void) | undefined;
  let pendingSubmissionText: string | undefined;
  editor.onSubmit = (text) => {
    const submittedText = pendingSubmissionText ?? text;
    pendingSubmissionText = undefined;
    submit?.(sanitizeEditorText(submittedText));
  };

  const clearAmbiguityTimer = (): void => {
    if (ambiguityTimer) clearTimeout(ambiguityTimer);
    ambiguityTimer = undefined;
  };

  const resetBufferedInput = (): void => {
    clearAmbiguityTimer();
    inputState = { kind: "keyboard", pending: "" };
    pendingSubmissionText = undefined;
  };

  const delegateKeyboardInput = (data: string): void => {
    // Outside bracketed paste, preserve terminal key events for pi-tui to interpret. In
    // particular, ordinary Backspace is DEL (0x7f) in most terminals and BS (0x08) in
    // some legacy terminals. Literal C1 characters are not key events and remain blocked;
    // bracketed-paste payloads take the stricter sanitize-before-insert path below.
    const safe = [...data]
      .filter((character) => {
        const code = character.codePointAt(0) ?? 0;
        return !(code >= 128 && code <= 159);
      })
      .join("");
    if (!safe) return;
    if (matchesKey(safe, "enter")) pendingSubmissionText = editor.getExpandedText();
    editor.handleInput(safe);
  };

  const insertSanitizedPaste = (text: string): void => {
    if (!text) return;
    editor.insertTextAtCursor(sanitizeEditorText(text));
    tui.requestRender();
  };

  const boundPasteBuffer = (text: string, retainedSuffix: number): string => {
    if (text.length <= SAFE_EDITOR_MAX_BUFFERED_CHARACTERS) return text;
    let flushLength = Math.max(0, text.length - retainedSuffix);
    // Keep CR with the next chunk so a CRLF split at the size boundary is normalized once.
    if (text[flushLength - 1] === "\r") flushLength -= 1;
    insertSanitizedPaste(text.slice(0, flushLength));
    return text.slice(flushLength);
  };

  const settleAmbiguity = (): void => {
    ambiguityTimer = undefined;
    if (inputState.kind === "keyboard") {
      const pending = inputState.pending;
      inputState = { kind: "keyboard", pending: "" };
      delegateKeyboardInput(pending);
      tui.requestRender();
      return;
    }
    if (inputState.kind === "paste-close") {
      const pasted = `${inputState.text}${inputState.trailing}`;
      inputState = { kind: "keyboard", pending: "" };
      insertSanitizedPaste(pasted);
    }
  };

  const scheduleAmbiguitySettlement = (delay: number): void => {
    clearAmbiguityTimer();
    ambiguityTimer = setTimeout(settleAmbiguity, delay);
    ambiguityTimer.unref();
  };

  const handleInput = (data: string): void => {
    clearAmbiguityTimer();
    if (inputState.kind === "keyboard") {
      const combined = `${inputState.pending}${data}`;
      const start = combined.indexOf(BRACKETED_PASTE_START);
      if (start >= 0) {
        delegateKeyboardInput(combined.slice(0, start));
        inputState = { kind: "paste", text: "" };
        handleInput(combined.slice(start + BRACKETED_PASTE_START.length));
        return;
      }
      const pendingLength = markerPrefixSuffixLength(combined, BRACKETED_PASTE_START);
      const readyLength = combined.length - pendingLength;
      delegateKeyboardInput(combined.slice(0, readyLength));
      const pending = combined.slice(readyLength);
      inputState = { kind: "keyboard", pending };
      if (pendingLength > 0)
        scheduleAmbiguitySettlement(
          pending === "\u001b" ? SAFE_EDITOR_ESCAPE_AMBIGUITY_MS : SAFE_EDITOR_MARKER_AMBIGUITY_MS,
        );
      return;
    }

    if (inputState.kind === "paste") {
      const combined = `${inputState.text}${data}`;
      const end = combined.indexOf(BRACKETED_PASTE_END);
      if (end < 0) {
        inputState = {
          kind: "paste",
          text: boundPasteBuffer(combined, BRACKETED_PASTE_END.length - 1),
        };
        return;
      }
      inputState = {
        kind: "paste-close",
        text: combined.slice(0, end),
        trailing: "",
      };
      handleInput(combined.slice(end + BRACKETED_PASTE_END.length));
      return;
    }

    let text = inputState.text;
    let trailing = `${inputState.trailing}${data}`;
    let nextClose = trailing.indexOf(BRACKETED_PASTE_END);
    while (nextClose >= 0) {
      // A later close proves that the previous candidate and all intervening bytes were
      // attacker-controlled paste data. Reject the marker itself and retain the bytes for
      // sanitize-before-insert processing; never reinterpret them as keyboard commands.
      text = `${text}${trailing.slice(0, nextClose)}`;
      trailing = trailing.slice(nextClose + BRACKETED_PASTE_END.length);
      nextClose = trailing.indexOf(BRACKETED_PASTE_END);
    }
    inputState = {
      kind: "paste-close",
      text: boundPasteBuffer(text, 0),
      trailing: boundPasteBuffer(trailing, BRACKETED_PASTE_END.length - 1),
    };
    scheduleAmbiguitySettlement(SAFE_EDITOR_CLOSE_AMBIGUITY_MS);
  };

  return {
    get focused() {
      return editor.focused;
    },
    set focused(focused: boolean) {
      editor.focused = focused;
    },
    get onSubmit() {
      return submit;
    },
    set onSubmit(next: ((text: string) => void) | undefined) {
      submit = next;
    },
    get disableSubmit() {
      return editor.disableSubmit;
    },
    set disableSubmit(disabled: boolean) {
      editor.disableSubmit = disabled;
    },
    getText: () => editor.getExpandedText(),
    setText: (text) => {
      resetBufferedInput();
      editor.setText(sanitizeEditorText(text));
      tui.requestRender();
    },
    insertText: (text) => {
      resetBufferedInput();
      editor.insertTextAtCursor(sanitizeEditorText(text));
      tui.requestRender();
    },
    acceptsUnbracketedCommandInput: () => inputState.kind === "keyboard" && inputState.pending.length === 0,
    handleInput,
    invalidate: () => editor.invalidate(),
    render: (width) => {
      const safeWidth = Math.max(0, width);
      if (safeWidth < 6 || height() < 4) {
        const lastLogicalLine = editor.getExpandedText().split("\n").at(-1) ?? "";
        return [elideText(lastLogicalLine || " ", safeWidth)];
      }
      return editor.render(safeWidth).map((line) => elideText(line, safeWidth));
    },
  };
}
