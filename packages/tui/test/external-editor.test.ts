import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  editTextInExternalEditor,
  prepareExternalEditorLaunch,
  resolveExternalEditorCommand,
} from "../src/external-editor.ts";

const temporaryPaths: string[] = [];

async function createEditorCommand(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "noesis-editor-test-"));
  temporaryPaths.push(directory);
  const script = join(directory, "editor.mjs");
  await writeFile(script, `${source}\n`, "utf8");
  return `"${process.execPath}" "${script}"`;
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("external editor", () => {
  test("resolves configured command before VISUAL, EDITOR, and the platform fallback", () => {
    expect(
      resolveExternalEditorCommand(" configured ", {
        VISUAL: "visual",
        EDITOR: "editor",
      }),
    ).toBe("configured");
    expect(resolveExternalEditorCommand(undefined, { VISUAL: "visual", EDITOR: "editor" })).toBe("visual");
    expect(resolveExternalEditorCommand(undefined, { EDITOR: "editor" })).toBe("editor");
    expect(resolveExternalEditorCommand(undefined, {}, "darwin")).toBe("nano");
    expect(resolveExternalEditorCommand(undefined, {}, "win32")).toBe("notepad");
  });

  test("returns edited Markdown and removes its temporary file", async () => {
    const observedPathDirectory = await mkdtemp(join(tmpdir(), "noesis-editor-observed-"));
    temporaryPaths.push(observedPathDirectory);
    const observedPath = join(observedPathDirectory, "path");
    const command = await createEditorCommand(
      `import { writeFile } from "node:fs/promises";
if (process.argv[2] !== "--label") process.exit(8);
if (process.argv[3] !== "two words") process.exit(9);
await writeFile(${JSON.stringify(observedPath)}, process.argv[4], "utf8");
await writeFile(process.argv[4], "edited\\ncontent", "utf8");`,
    );

    const result = await editTextInExternalEditor({
      content: "original",
      configuredCommand: `${command} --label "two words"`,
      environment: {},
    });

    expect(result).toEqual({
      status: "edited",
      command: `${command} --label "two words"`,
      content: "edited\ncontent",
    });
    const temporaryFile = await readFile(observedPath, "utf8");
    await expect(access(temporaryFile)).rejects.toThrow();
  });

  test("leaves the caller's content untouched when the editor exits unsuccessfully", async () => {
    const command = await createEditorCommand(
      `import { writeFile } from "node:fs/promises";
await writeFile(process.argv[2], "discarded", "utf8");
process.exit(7);`,
    );

    const result = await editTextInExternalEditor({
      content: "original",
      configuredCommand: command,
      environment: {},
    });

    expect(result).toEqual({
      status: "unchanged",
      command,
      reason: "editor-exit",
      exitCode: 7,
    });
  });

  test("reports launch failure without throwing", async () => {
    const result = await editTextInExternalEditor({
      content: "original",
      configuredCommand: "/definitely/missing/noesis-editor",
      environment: {},
    });

    expect(result.status).toBe("unchanged");
    if (result.status === "edited") throw new Error("unreachable");
    expect(result.reason).toBe("launch-failed");
    expect(result.error).toContain("ENOENT");
  });

  test("preserves Windows paths while keeping native editors on the direct-spawn path", () => {
    expect(
      prepareExternalEditorLaunch(
        '"C:\\Program Files\\Noesis Editor.exe" --wait',
        "C:\\Temp\\prompt.md",
        {},
        "win32",
      ),
    ).toEqual({
      status: "complete",
      executable: "C:\\Program Files\\Noesis Editor.exe",
      args: ["--wait", "C:\\Temp\\prompt.md"],
    });
  });

  test.each(["cmd", "bat"])("runs Windows .%s editors through the command processor", (extension) => {
    const command = `"C:\\Program Files\\Noesis Editor.${extension}" --wait`;

    expect(
      prepareExternalEditorLaunch(
        command,
        "C:\\Temp\\prompt & notes.md",
        {
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
        },
        "win32",
      ),
    ).toEqual({
      status: "complete",
      executable: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/v:off",
        "/c",
        `"C:\\Program^ Files\\Noesis^ Editor.${extension} ^"--wait^" ^"C:\\Temp\\prompt^ ^&^ notes.md^""`,
      ],
      windowsVerbatimArguments: true,
    });
  });

  test("double-escapes arguments passed through a node_modules command shim", () => {
    expect(
      prepareExternalEditorLaunch(
        "C:\\workspace\\node_modules\\.bin\\editor.cmd --label=%TEMP%",
        "C:\\Temp\\prompt & notes.md",
        { ComSpec: "cmd.exe" },
        "win32",
      ),
    ).toEqual({
      status: "complete",
      executable: "cmd.exe",
      args: [
        "/d",
        "/s",
        "/v:off",
        "/c",
        '"C:\\workspace\\node_modules\\.bin\\editor.cmd ^^^"--label=^^^%TEMP^^^%^^^" ^^^"C:\\Temp\\prompt^^^ ^^^&^^^ notes.md^^^""',
      ],
      windowsVerbatimArguments: true,
    });
  });

  test("caret-escapes percent expansion in ordinary Windows batch launches", () => {
    expect(
      prepareExternalEditorLaunch(
        '"C:\\Editors\\%CD%\\editor.cmd" "%TEMP%"',
        "C:\\Users\\%USERNAME%\\prompt.md",
        { ComSpec: "cmd.exe" },
        "win32",
      ),
    ).toEqual({
      status: "complete",
      executable: "cmd.exe",
      args: [
        "/d",
        "/s",
        "/v:off",
        "/c",
        '"C:\\Editors\\^%CD^%\\editor.cmd ^"^%TEMP^%^" ^"C:\\Users\\^%USERNAME^%\\prompt.md^""',
      ],
      windowsVerbatimArguments: true,
    });
  });
});
