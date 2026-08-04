import { type Terminal, TUI } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import {
  createNoesisCommandAutocompleteProvider,
  createSafeEditor,
  loadSkillSlashCommands,
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
  test("loads optional skill commands without allowing discovery failure to block startup", async () => {
    const skills = Object.freeze([
      Object.freeze({ name: "five-whys", description: "Find the underlying cause" }),
    ]);

    await expect(loadSkillSlashCommands(async () => skills)).resolves.toBe(skills);
    await expect(
      loadSkillSlashCommands(async () => {
        throw new Error("broken skill package");
      }),
    ).resolves.toEqual([]);
    await expect(loadSkillSlashCommands()).resolves.toEqual([]);
  });

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

  test("suggests queue control and explicit steering commands", async () => {
    const queue = await suggestionsFor("/queue r");
    const steer = await suggestionsFor("/ste");

    expect(queue?.items).toContainEqual(expect.objectContaining({ value: "resume" }));
    expect(steer?.items).toContainEqual(
      expect.objectContaining({
        value: "steer",
        description: expect.stringContaining("[message]"),
      }),
    );
  });

  test("offers quiet ambient learning inspection", async () => {
    const learning = await suggestionsFor("/lear");

    expect(learning?.items).toContainEqual(
      expect.objectContaining({
        value: "learning",
        description: expect.stringContaining("ambient reflection"),
      }),
    );
  });

  test("offers installed skills as direct slash commands without shadowing built-ins", async () => {
    const provider = createNoesisCommandAutocompleteProvider([
      {
        name: "five-whys",
        description: "Find the cause beneath a recurring problem",
      },
      {
        name: "private-review",
        description: "Run a manually selected review",
        disableModelInvocation: true,
      },
      {
        name: "help",
        description: "Must not replace Noesis help",
      },
    ]);
    const suggestions = await provider.getSuggestions(["/five"], 0, 5, {
      signal: new AbortController().signal,
    });
    const privateSuggestions = await provider.getSuggestions(["/private"], 0, 8, {
      signal: new AbortController().signal,
    });
    const allSuggestions = await provider.getSuggestions(["/"], 0, 1, {
      signal: new AbortController().signal,
    });

    expect(suggestions?.items).toContainEqual(
      expect.objectContaining({
        value: "five-whys",
        description: expect.stringContaining("[instructions]"),
      }),
    );
    expect(privateSuggestions?.items).toContainEqual(
      expect.objectContaining({
        value: "private-review",
        description: expect.stringContaining("explicit only"),
      }),
    );
    expect(allSuggestions?.items.filter((item) => item.value === "help")).toHaveLength(1);
    expect(allSuggestions?.items).toContainEqual(
      expect.objectContaining({
        value: "skill:help",
        description: expect.stringContaining("Must not replace Noesis help"),
      }),
    );
  });

  test("deduplicates discovered skill names before applying built-in collision prefixes", async () => {
    const provider = createNoesisCommandAutocompleteProvider([
      { name: "five-whys", description: "First discovered package" },
      { name: "five-whys", description: "Duplicate package" },
      { name: "help", description: "First help skill" },
      { name: "help", description: "Duplicate help skill" },
    ]);
    const suggestions = await provider.getSuggestions(["/"], 0, 1, {
      signal: new AbortController().signal,
    });

    expect(suggestions?.items.filter((item) => item.value === "five-whys")).toHaveLength(1);
    expect(suggestions?.items.filter((item) => item.value === "help")).toHaveLength(1);
    expect(suggestions?.items.filter((item) => item.value === "skill:help")).toHaveLength(1);
    expect(suggestions?.items).toContainEqual(
      expect.objectContaining({
        value: "five-whys",
        description: expect.stringContaining("First discovered package"),
      }),
    );
    expect(suggestions?.items).toContainEqual(
      expect.objectContaining({
        value: "skill:help",
        description: expect.stringContaining("First help skill"),
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
