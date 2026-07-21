import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeAgentRuntime } from "@noesis/runtime-pi";
import { createNoesisRuntime } from "@noesis/runtime";
import { afterEach, describe, expect, test } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cliPath = join(repositoryRoot, "apps/noesis/src/cli.ts");
const ptyDriverPath = join(repositoryRoot, "apps/noesis/test/pty_quit.py");
const homes: string[] = [];
const children = new Set<ChildProcess>();

const containsUnsafeTextControl = (text: string): boolean =>
  [...text].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (code < 32 && code !== 9 && code !== 10) || (code >= 127 && code <= 159);
  });

const containsC1 = (text: string): boolean =>
  [...text].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 128 && code <= 159;
  });

function stopProcessGroup(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

afterEach(async () => {
  for (const child of children) stopProcessGroup(child);
  children.clear();
  await Promise.all(homes.splice(0).map(async (home) => await rm(home, { recursive: true, force: true })));
});

describe.skipIf(process.platform === "win32")("Noesis TUI process lifecycle", () => {
  async function runPtyExit(
    action:
      | "quit-lf"
      | "ctrl-c"
      | "picker-cancel"
      | "picker-select-quit"
      | "prompt-quit"
      | "backspace-del-quit"
      | "backspace-bs-quit"
      | "backspace-grapheme-quit"
      | "resize-main-quit"
      | "resize-picker-cancel"
      | "mixed-resize-quit"
      | "paste-controls-quit"
      | "fragmented-hostile-paste-quit",
    prepare?: (home: string) => Promise<readonly string[]>,
    size: { readonly columns: number; readonly rows: number } = { columns: 100, rows: 30 },
  ): Promise<{
    readonly home: string;
    readonly output: string;
    readonly result: { readonly code: number | null; readonly signal: NodeJS.Signals | null };
  }> {
    const home = await mkdtemp(join(tmpdir(), "noesis-tui-process-"));
    homes.push(home);
    const extraArgs = (await prepare?.(home)) ?? [];
    const command = [
      process.execPath,
      "--import",
      "tsx",
      cliPath,
      "tui",
      "--home",
      home,
      "--runtime",
      "fake",
      "--provider",
      "fake",
      "--model",
      "noesis-fake-1",
      ...extraArgs,
    ];
    const child = spawn(
      "python3",
      [ptyDriverPath, action, String(size.columns), String(size.rows), ...command],
      {
        cwd: repositoryRoot,
        detached: true,
        env: { ...process.env, NO_COLOR: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    children.add(child);
    let output = "";
    const collect = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    const result = await new Promise<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }>((resolveExit, reject) => {
      const timeout = setTimeout(() => {
        stopProcessGroup(child);
        reject(new Error(`TUI did not exit within 5 seconds. Output:\n${output}`));
      }, 5_000);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timeout);
        resolveExit({ code, signal });
      });
    });
    children.delete(child);

    return { home, output, result };
  }

  test("/quit followed by LF exits its real PTY with code 0", async () => {
    const { home, output, result } = await runPtyExit("quit-lf");

    expect(output).toContain("● IDLE");
    expect(result).toEqual({ code: 0, signal: null });
    const reopened = await createNoesisRuntime(home, createFakeAgentRuntime());
    expect(reopened.listTrails()).toHaveLength(1);
  }, 7_000);

  test("Ctrl+C exits with code 0 after the TUI is ready", async () => {
    const { output, result } = await runPtyExit("ctrl-c");

    expect(output).toContain("● IDLE");
    expect(result).toEqual({ code: 0, signal: null });
  }, 7_000);

  test("the resume picker selects the most recent session in a real PTY", async () => {
    let selectedTrailId = "";
    const { output, result } = await runPtyExit("picker-select-quit", async (home) => {
      const runtime = await createNoesisRuntime(home, createFakeAgentRuntime());
      const older = await runtime.startTrail({ title: "older" });
      await runtime.runTurn(older.trailId, "older real PTY history");
      const selected = await runtime.startTrail({ title: "newer" });
      await runtime.runTurn(selected.trailId, "selected real PTY history");
      selectedTrailId = selected.trailId;
      return ["--resume"];
    });

    expect(output).toContain("resume a session");
    expect(output).toContain(`session ${selectedTrailId.slice(6, 14)}`);
    expect(output).toContain("selected real PTY history");
    expect(result).toEqual({ code: 0, signal: null });
  }, 7_000);

  test.each([
    "quit-lf",
    "ctrl-c",
  ] as const)("--continue renders the latest history and %s cleanup exits cleanly", async (action) => {
    let selectedTrailId = "";
    const { output, result } = await runPtyExit(action, async (home) => {
      const runtime = await createNoesisRuntime(home, createFakeAgentRuntime());
      const older = await runtime.startTrail({ title: "older continue" });
      await runtime.runTurn(older.trailId, "older continue PTY history");
      const selected = await runtime.startTrail({ title: "latest continue" });
      await runtime.runTurn(selected.trailId, "latest continue PTY history");
      selectedTrailId = selected.trailId;
      return ["--continue"];
    });

    expect(output).toContain(`session ${selectedTrailId.slice(6, 14)}`);
    expect(output).toContain("latest continue PTY history");
    expect(output).not.toContain("older continue PTY history");
    expect(result).toEqual({ code: 0, signal: null });
  }, 7_000);

  test("direct resume restores one exact session and picker cancellation exits cleanly", async () => {
    let selectedTrailId = "";
    const direct = await runPtyExit("quit-lf", async (home) => {
      const runtime = await createNoesisRuntime(home, createFakeAgentRuntime());
      const selected = await runtime.startTrail({ title: "direct" });
      await runtime.runTurn(selected.trailId, "direct real PTY history");
      selectedTrailId = selected.trailId;
      return ["--resume", selected.trailId];
    });
    expect(direct.output).toContain(`session ${selectedTrailId.slice(6, 14)}`);
    expect(direct.output).toContain("direct real PTY history");
    expect(direct.result).toEqual({ code: 0, signal: null });

    const cancelled = await runPtyExit("picker-cancel", async (home) => {
      const runtime = await createNoesisRuntime(home, createFakeAgentRuntime());
      await runtime.startTrail({ title: "cancel me" });
      return ["--resume"];
    });
    expect(cancelled.output).toContain("resume a session");
    expect(cancelled.result).toEqual({ code: 0, signal: null });
    const reopened = await createNoesisRuntime(cancelled.home, createFakeAgentRuntime());
    expect(reopened.ledger.findByType("trail.resumed")).toHaveLength(0);
  }, 12_000);

  test("captures a wide 120x35 fresh shell with the full identity", async () => {
    const { output, result } = await runPtyExit("quit-lf", undefined, { columns: 120, rows: 35 });

    expect(output).toContain("███╗   ██╗ ██████╗");
    expect(output).toContain("think · learn · create · grow");
    expect(output).toContain("ctx   —");
    expect(result).toEqual({ code: 0, signal: null });
  }, 7_000);

  test("captures real streaming semantics in a normal 90x28 shell", async () => {
    const { output, result } = await runPtyExit("prompt-quit", undefined, { columns: 90, rows: 28 });

    expect(output).toContain("● STREAMING");
    expect(output).toContain("Fake completion for: show the polished shell");
    expect(output).toContain("ctx ~");
    expect(result).toEqual({ code: 0, signal: null });
  }, 7_000);

  test.each([
    ["DEL", "backspace-del-quit", "ab"],
    ["BS", "backspace-bs-quit", "ab"],
    ["DEL grapheme", "backspace-grapheme-quit", "a"],
  ] as const)(
    "submits the value edited by ordinary %s Backspace in a real PTY",
    async (_variant, action, expected) => {
      const { home, output, result } = await runPtyExit(action);
      const reopened = await createNoesisRuntime(home, createFakeAgentRuntime());
      const trail = reopened.listTrails()[0];
      if (!trail) throw new Error("Expected the edited prompt to create one trail");
      const submitted = reopened.getTrail(trail.trailId).turns[0]?.input ?? "";

      expect(submitted).toBe(expected);
      expect(containsUnsafeTextControl(submitted)).toBe(false);
      expect(output).toContain(`Fake completion for: ${expected}`);
      expect(result).toEqual({ code: 0, signal: null });
    },
    7_000,
  );

  test("neutralizes bracketed C1 and OSC-like paste before the real PTY runtime sees it", async () => {
    const { home, output, result } = await runPtyExit("paste-controls-quit", undefined, {
      columns: 70,
      rows: 22,
    });
    const reopened = await createNoesisRuntime(home, createFakeAgentRuntime());
    const trail = reopened.listTrails()[0];
    if (!trail) throw new Error("Expected the pasted prompt to create one trail");
    const submitted = reopened.getTrail(trail.trailId).turns[0]?.input ?? "";

    expect(submitted).toContain("Unicode 界面");
    expect(containsUnsafeTextControl(submitted)).toBe(false);
    expect(containsC1(output)).toBe(false);
    expect(output).toContain("Fake completion for:");
    expect(result).toEqual({ code: 0, signal: null });
  }, 7_000);

  test("does not submit fragmented hostile paste until a later genuine Enter", async () => {
    const { home, output, result } = await runPtyExit("fragmented-hostile-paste-quit");
    const reopened = await createNoesisRuntime(home, createFakeAgentRuntime());
    const trail = reopened.listTrails()[0];
    if (!trail) throw new Error("Expected the sanitized prompt to create one trail");
    const turns = reopened.getTrail(trail.trailId).turns;

    expect(output).not.toContain("__NOESIS_PREMATURE_SUBMIT__");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.input).toBe("safe\nBAD [2J  31m");
    expect(containsUnsafeTextControl(turns[0]?.input ?? "")).toBe(false);
    expect(result).toEqual({ code: 0, signal: null });
  }, 7_000);

  test("captures a resumed narrow 70x22 shell without crowding it with ASCII art", async () => {
    let selectedTrailId = "";
    const { output, result } = await runPtyExit(
      "quit-lf",
      async (home) => {
        const runtime = await createNoesisRuntime(home, createFakeAgentRuntime());
        const selected = await runtime.startTrail({ title: "narrow resumed" });
        await runtime.runTurn(selected.trailId, "narrow history");
        selectedTrailId = selected.trailId;
        return ["--resume", selected.trailId];
      },
      { columns: 70, rows: 22 },
    );

    expect(output).toContain("NOESIS  think · learn · create · grow");
    expect(output).not.toContain("███╗   ██╗ ██████╗");
    expect(output).toContain(`session ${selectedTrailId.slice(6, 14)}`);
    expect(output).toContain("narrow history");
    expect(result).toEqual({ code: 0, signal: null });
  }, 7_000);

  test("keeps the picker compact and branded at 70x22", async () => {
    const { output, result } = await runPtyExit(
      "picker-cancel",
      async (home) => {
        const runtime = await createNoesisRuntime(home, createFakeAgentRuntime());
        await runtime.startTrail({ title: "picker snapshot" });
        return ["--resume"];
      },
      { columns: 70, rows: 22 },
    );

    expect(output).toContain("NOESIS  resume a session");
    expect(output).toContain("↑/↓ navigate · Enter resume · Esc cancel");
    expect(result).toEqual({ code: 0, signal: null });
  }, 7_000);

  test("protects chat and input in a short 50x9 shell", async () => {
    const { output, result } = await runPtyExit("quit-lf", undefined, { columns: 50, rows: 9 });

    expect(output).not.toContain("███╗   ██╗ ██████╗");
    expect(output).not.toContain("think · learn · create · grow");
    expect(output).toContain("● IDLE");
    expect(output).toContain("› message");
    expect(output).toContain("? help · /quit exit");
    expect(result).toEqual({ code: 0, signal: null });
  }, 7_000);

  test("reflows the main shell after a live PTY shrink", async () => {
    const { output, result } = await runPtyExit("resize-main-quit", undefined, {
      columns: 120,
      rows: 35,
    });
    const resized = output.split("__NOESIS_RESIZED__").at(-1) ?? "";

    expect(output).toContain("███╗   ██╗ ██████╗");
    expect(resized).not.toContain("███╗   ██╗ ██████╗");
    expect(resized).not.toContain("think · learn · create · grow");
    expect(resized).toContain("● IDLE");
    expect(resized).toContain("› message");
    expect(result).toEqual({ code: 0, signal: null });
  }, 7_000);

  test("recomputes picker rows after a live PTY shrink", async () => {
    const { output, result } = await runPtyExit(
      "resize-picker-cancel",
      async (home) => {
        const runtime = await createNoesisRuntime(home, createFakeAgentRuntime());
        for (let index = 0; index < 12; index += 1)
          await runtime.startTrail({ title: `resize picker ${String(index).padStart(2, "0")}` });
        return ["--resume"];
      },
      { columns: 100, rows: 30 },
    );
    const resized = output.split("__NOESIS_RESIZED__").at(-1) ?? "";

    expect(resized).toContain("resume a session");
    expect(resized).toContain("(1/12)");
    expect(result).toEqual({ code: 0, signal: null });
  }, 7_000);

  test("renders a mixed Markdown and LaTeX transcript, streams, and survives a live shrink", async () => {
    const { output, result } = await runPtyExit("mixed-resize-quit", undefined, { columns: 90, rows: 35 });
    const resized = output.split("__NOESIS_MIXED_RESIZED__").at(-1) ?? "";
    const finalScreen = resized
      .split("__NOESIS_FINAL_SCREEN__")
      .at(-1)
      ?.split("__NOESIS_FINAL_SCREEN_END__")[0]
      ?.trimEnd();
    const screen = finalScreen ?? "";

    expect(output).toContain("```ts");
    expect(output).toContain("$x_i^2$");
    expect(output).toContain("╭─ math");
    expect(output).toContain("● STREAMING");
    expect(output).toContain("Fake completion for:");
    expect(resized).not.toContain("███╗   ██╗");
    expect(screen).toContain("⋯ earlier messages");
    expect(screen).toContain("NOESIS");
    expect(screen).toContain("alpha");
    expect(screen).toContain("MIXED-END");
    expect(screen).toContain("● IDLE");
    expect(screen).toContain("› message");
    expect(screen).toContain("? help");
    expect(screen.indexOf("› message")).toBeLessThan(screen.indexOf("● IDLE"));
    expect(screen.indexOf("● IDLE")).toBeLessThan(screen.indexOf("? help"));
    expect(screen.split("\n").every((line) => [...line].length <= 70)).toBe(true);
    expect(result).toEqual({ code: 0, signal: null });
  }, 10_000);
});
