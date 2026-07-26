import { TUI, type Terminal } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import {
  createNoesisCommandAutocompleteProvider,
  createSafeEditor,
  NOESIS_SLASH_COMMANDS,
} from "../src/index.ts";

const inertTerminal: Terminal = {
  columns: 120,
  rows: 35,
  kittyProtocolActive: false,
  start() {},
  stop() {},
  async drainInput() {},
  write() {},
  moveBy() {},
  hideCursor() {},
  showCursor() {},
  clearLine() {},
  clearFromCursor() {},
  clearScreen() {},
  setTitle() {},
  setProgress() {},
};

const suggestionsFor = async (text: string) =>
  createNoesisCommandAutocompleteProvider().getSuggestions([text], 0, text.length, {
    signal: new AbortController().signal,
  });

describe("Noesis slash command autocomplete", () => {
  test("offers every command implemented by the TUI", async () => {
    const suggestions = await suggestionsFor("/");

    expect(suggestions?.items.map((item) => item.value)).toEqual(
      NOESIS_SLASH_COMMANDS.map((command) => command.name),
    );
  });

  test("fuzzy-filters commands and includes argument hints in descriptions", async () => {
    const workflow = await suggestionsFor("/wf");
    const model = await suggestionsFor("/mod");

    expect(workflow?.items.map((item) => item.value)).toContain("workflows");
    expect(model?.items).toContainEqual(
      expect.objectContaining({
        value: "model",
        description: expect.stringContaining("<provider>/<model>"),
      }),
    );
  });

  test("completes the known provider prefix while leaving the model ID editable", async () => {
    const suggestions = await suggestionsFor("/model openr");

    expect(suggestions).toEqual(
      expect.objectContaining({
        prefix: "openr",
        items: [
          expect.objectContaining({
            value: "openrouter/",
          }),
        ],
      }),
    );
  });

  test("does not turn Tab outside slash commands into file completion", () => {
    const provider = createNoesisCommandAutocompleteProvider();

    expect(provider.shouldTriggerFileCompletion?.(["ordinary prompt"], 0, 15)).toBe(false);
    expect(provider.shouldTriggerFileCompletion?.(["/model "], 0, 7)).toBe(true);
  });

  test("wires Pi's live suggestions and completion through the safe editor", async () => {
    const editor = createSafeEditor(new TUI(inertTerminal));
    editor.handleInput?.("/cont");

    await vi.waitFor(() => expect(editor.render(80).join("\n")).toContain("context"));
    editor.handleInput?.("\t");

    expect(editor.getText()).toBe("/context ");
  });

  test("preserves native Backspace while suggestions are open", async () => {
    const editor = createSafeEditor(new TUI(inertTerminal));
    editor.handleInput?.("/help");
    await vi.waitFor(() => expect(editor.render(80).join("\n")).toContain("help"));

    editor.handleInput?.("\u007f");

    expect(editor.getText()).toBe("/hel");
  });
});
