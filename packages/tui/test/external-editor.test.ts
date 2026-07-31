import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { editTextInExternalEditor, resolveExternalEditorCommand } from "../src/external-editor.ts";

const temporaryPaths: string[] = [];

async function createEditorScript(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "noesis-editor-test-"));
  temporaryPaths.push(directory);
  const script = join(directory, "editor.sh");
  await writeFile(script, `#!/bin/sh\n${source}\n`, "utf8");
  await chmod(script, 0o700);
  return script;
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
    const script = await createEditorScript(
      `test "$1" = "--label" || exit 8\ntest "$2" = "two words" || exit 9\nprintf '%s' "$3" > ${JSON.stringify(observedPath)}\nprintf 'edited\\ncontent' > "$3"`,
    );

    const result = await editTextInExternalEditor({
      content: "original",
      configuredCommand: `${script} --label "two words"`,
      environment: {},
    });

    expect(result).toEqual({
      status: "edited",
      command: `${script} --label "two words"`,
      content: "edited\ncontent",
    });
    const temporaryFile = await readFile(observedPath, "utf8");
    await expect(access(temporaryFile)).rejects.toThrow();
  });

  test("leaves the caller's content untouched when the editor exits unsuccessfully", async () => {
    const script = await createEditorScript("printf 'discarded' > \"$1\"\nexit 7");

    const result = await editTextInExternalEditor({
      content: "original",
      configuredCommand: script,
      environment: {},
    });

    expect(result).toEqual({
      status: "unchanged",
      command: script,
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
});
