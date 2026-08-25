import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { resolveNoesisConfig } from "@noesis/config";
import { createPiAgentRoleRunner, createPiAgentRuntime } from "@noesis/runtime-pi";
import { createWorkspaceStore } from "@noesis/workspace";
import { afterEach, describe, expect, test } from "vitest";
import {
  CONTROLLED_PI_MODEL,
  CONTROLLED_PI_PROVIDER,
  createControlledPiModels,
} from "../../../packages/runtime-pi/test/support/controlled-pi-models.ts";
import { createApplicationRuntimeComposition } from "../src/runtime-composition.ts";
import { NOESIS_STARTUP_NOTES } from "@noesis/tui";

const startupNotesIn = (text: string): readonly string[] =>
  NOESIS_STARTUP_NOTES.filter((note) => text.includes(note));
const hasStartupNote = (text: string): boolean => startupNotesIn(text).length > 0;

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cliPath = join(repositoryRoot, "apps/noesis/src/cli.ts");
const ptyDriverPath = join(repositoryRoot, "apps/noesis/test/pty_quit.py");
const homes: string[] = [];
const children = new Set<ChildProcess>();

async function createTestRuntime(home: string) {
  const controlled = createControlledPiModels();
  const config = await resolveNoesisConfig({
    home,
    env: Object.freeze({}),
    cli: Object.freeze({
      provider: CONTROLLED_PI_PROVIDER,
      model: CONTROLLED_PI_MODEL,
      thinkingLevel: "off",
    }),
  });
  return await createApplicationRuntimeComposition({
    config,
    createAgent: (_sessionTools, codeExecution) =>
      createPiAgentRuntime(repositoryRoot, controlled.models, {
        codeExecution,
      }),
    createRoleRunner: (configurations) =>
      createPiAgentRoleRunner(repositoryRoot, controlled.models, configurations),
  });
}

type TestRuntime = Awaited<ReturnType<typeof createTestRuntime>>;

async function retainTrail(runtime: TestRuntime, trailId: string, content: string): Promise<void> {
  await runtime.debug.workspace.operational.messages.put({
    messageId: `pty-fixture-${trailId}`,
    sessionId: trailId,
    role: "user",
    content,
    sensitivity: "normal",
    createdAt: "2026-08-25T00:00:00.000Z",
    metadata: Object.freeze({}),
  });
}

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
      | "first-launch-quit-lf"
      | "first-launch-ctrl-c"
      | "first-launch-oauth-quit-lf"
      | "first-launch-oauth-ctrl-c"
      | "picker-cancel"
      | "picker-select-quit"
      | "model-picker-select-quit"
      | "prompt-quit"
      | "completed-turn-quit-lf"
      | "completed-turn-ctrl-c"
      | "backspace-del-quit"
      | "backspace-bs-quit"
      | "backspace-grapheme-quit"
      | "resize-main-quit"
      | "resize-picker-cancel"
      | "mixed-resize-quit"
      | "paste-controls-quit"
      | "fragmented-hostile-paste-quit",
    prepare?: (home: string) => Promise<readonly string[]>,
    size: { readonly columns: number; readonly rows: number } = {
      columns: 100,
      rows: 30,
    },
  ): Promise<{
    readonly home: string;
    readonly output: string;
    readonly result: {
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    };
  }> {
    const home = await mkdtemp(join(tmpdir(), "noesis-tui-process-"));
    homes.push(home);
    const extraArgs = (await prepare?.(home)) ?? [];
    const firstLaunch = action.startsWith("first-launch-");
    const oauthFirstLaunch = action.startsWith("first-launch-oauth-");
    const command = [
      process.execPath,
      "--import",
      "tsx",
      "--import",
      join(repositoryRoot, "apps/noesis/test/mock_openrouter_fetch.mjs"),
      ...(oauthFirstLaunch
        ? ["--import", join(repositoryRoot, "apps/noesis/test/mock_oauth_fetch.mjs")]
        : []),
      cliPath,
      "tui",
      "--home",
      home,
      ...(firstLaunch
        ? []
        : ["--provider", "openrouter", "--model", "anthropic/claude-sonnet-4.5", "--thinking-level", "off"]),
      ...extraArgs,
    ];
    const child = spawn(
      "python3",
      [ptyDriverPath, action, String(size.columns), String(size.rows), ...command],
      {
        cwd: repositoryRoot,
        detached: true,
        env: {
          ...process.env,
          NO_COLOR: "1",
          NOESIS_DISABLE_BROWSER_OPEN: "1",
          ...(firstLaunch ? { OPENROUTER_API_KEY: undefined } : { OPENROUTER_API_KEY: "test-key" }),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    children.add(child);
    let output = "";
    // PTY reads split multi-byte characters across chunks, so decode as a stream rather than
    // per chunk; otherwise glyphs like ● in the status line decode as replacement characters.
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    child.stdout?.on("data", (chunk: Buffer) => {
      output += stdoutDecoder.write(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += stderrDecoder.write(chunk);
    });

    const result = await new Promise<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }>((resolveExit, reject) => {
      const timeout = setTimeout(() => {
        stopProcessGroup(child);
        reject(new Error(`TUI did not exit within 6 seconds. Output:\n${output}`));
      }, 6_000);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timeout);
        output += stdoutDecoder.end();
        output += stderrDecoder.end();
        resolveExit({ code, signal });
      });
    });
    children.delete(child);

    return { home, output, result };
  }

  test("/quit followed by LF exits its real PTY with code 0 without retaining an empty session", async () => {
    const { home, output, result } = await runPtyExit("quit-lf");

    expect(output).toContain("● IDLE");
    expect(result).toEqual({ code: 0, signal: null });
    const reopened = await createTestRuntime(home);
    expect(reopened.listTrails()).toHaveLength(0);
    await reopened.shutdown();
  }, 7_000);

  test("Ctrl+C exits with code 0 after the TUI is ready", async () => {
    const { output, result } = await runPtyExit("ctrl-c");

    expect(output).toContain("● IDLE");
    expect(result).toEqual({ code: 0, signal: null });
  }, 7_000);

  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  test.each([
    ["first-launch-quit-lf", "/quit"],
    ["first-launch-ctrl-c", "Ctrl+C"],
  ] as const)(
    "%s (%s) exits cleanly after interactive first-launch onboarding",
    async (action, _input) => {
      const { output, result } = await runPtyExit(action);

      expect(output).toContain("● IDLE");
      expect(startupNotesIn(output)).toHaveLength(1);
      expect(result).toEqual({ code: 0, signal: null });
    },
    7_000,
  );

  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  test.each([
    ["first-launch-oauth-quit-lf", "/quit"],
    ["first-launch-oauth-ctrl-c", "Ctrl+C"],
  ] as const)(
    "%s (%s) exits cleanly after Codex OAuth first-launch onboarding",
    async (action, _input) => {
      const { output, result } = await runPtyExit(action);

      expect(output).toContain("__NOESIS_OAUTH_CALLBACK_PAGE__");
      expect(output).toContain("<title>Noesis — authorization received</title>");
      expect(output).toContain("AUTHORIZATION RECEIVED");
      expect(output).toContain("Return to Noesis.");
      expect(output).toContain("Cache-Control: no-store");
      expect(output).toContain(
        "Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      );
      expect(output).toContain("Referrer-Policy: no-referrer");
      expect(output).toContain("X-Content-Type-Options: nosniff");
      expect(output).toContain("● IDLE");
      expect(result).toEqual({ code: 0, signal: null });
    },
    7_000,
  );

  test("the resume picker selects the most recent session in a real PTY", async () => {
    const { output, result } = await runPtyExit("picker-select-quit", async (home) => {
      const runtime = await createTestRuntime(home);
      const older = await runtime.startTrail({ title: "older" });
      await runtime.debug.runTurn(older.trailId, "older real PTY history");
      const selected = await runtime.startTrail({ title: "newer" });
      await runtime.debug.runTurn(selected.trailId, "selected real PTY history");
      await runtime.shutdown();
      return ["--resume"];
    });

    expect(output).toContain("resume a session");
    expect(output).toContain("selected real PTY history");
    expect(output).not.toContain("older real PTY history");
    expect(result).toEqual({ code: 0, signal: null });
  }, 7_000);

  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  test.each(["quit-lf", "ctrl-c"] as const)(
    "--continue renders the latest history and %s cleanup exits cleanly",
    async (action) => {
      const { output, result } = await runPtyExit(action, async (home) => {
        const runtime = await createTestRuntime(home);
        const older = await runtime.startTrail({ title: "older continue" });
        await runtime.debug.runTurn(older.trailId, "older continue PTY history");
        const selected = await runtime.startTrail({
          title: "latest continue",
        });
        await runtime.debug.runTurn(selected.trailId, "latest continue PTY history");
        await runtime.shutdown();
        return ["--continue"];
      });

      expect(output).toContain("latest continue PTY history");
      expect(output).not.toContain("older continue PTY history");
      expect(result).toEqual({ code: 0, signal: null });
    },
    7_000,
  );

  test("direct resume restores one exact session and picker cancellation exits cleanly", async () => {
    const direct = await runPtyExit("quit-lf", async (home) => {
      const runtime = await createTestRuntime(home);
      const selected = await runtime.startTrail({ title: "direct" });
      await runtime.debug.runTurn(selected.trailId, "direct real PTY history");
      const other = await runtime.startTrail({ title: "other direct" });
      await runtime.debug.runTurn(other.trailId, "other direct PTY history");
      await runtime.shutdown();
      return ["--resume", selected.trailId];
    });
    expect(direct.output).toContain("direct real PTY history");
    expect(direct.output).not.toContain("other direct PTY history");
    expect(direct.result).toEqual({ code: 0, signal: null });

    const cancelled = await runPtyExit("picker-cancel", async (home) => {
      const runtime = await createTestRuntime(home);
      const trail = await runtime.startTrail({ title: "cancel me" });
      await retainTrail(runtime, trail.trailId, "cancelled picker history");
      await runtime.shutdown();
      return ["--resume"];
    });
    expect(cancelled.output).toContain("resume a session");
    expect(cancelled.result).toEqual({ code: 0, signal: null });
    const reopened = await createTestRuntime(cancelled.home);
    expect(reopened.listTrails()).toMatchObject([{ title: "cancel me", status: "idle" }]);
    await reopened.shutdown();
  }, 12_000);

  test("captures a wide 120x35 fresh shell with the full identity", async () => {
    const { output, result } = await runPtyExit("quit-lf", undefined, {
      columns: 120,
      rows: 35,
    });

    expect(output).toContain("███╗   ██╗ ██████╗");
    expect(hasStartupNote(output)).toBe(true);
    expect(output).toContain("ctx   —");
    expect(result).toEqual({ code: 0, signal: null });
  }, 7_000);

  test("captures real streaming semantics in a normal 90x28 shell", async () => {
    const { output, result } = await runPtyExit("prompt-quit", undefined, {
      columns: 90,
      rows: 28,
    });

    expect(output).toMatch(/[⠉⠃⠆⡄⣀⢠⠰⠘] WORKING/u);
    expect(output).toContain("Controlled Pi completion for: show the polished shell");
    expect(output).toContain("ctx   0%");
    expect(result).toEqual({ code: 0, signal: null });
  }, 7_000);

  test("selects a new model through the interactive picker and preserves cache isolation", async () => {
    const { output, result } = await runPtyExit("model-picker-select-quit", undefined, {
      columns: 90,
      rows: 28,
    });

    expect(output).toContain("SELECT MODEL · OpenRouter");
    expect(output).toContain("New empty session · previous preserved · history not replayed");
    expect(output).toContain("● IDLE");
    expect(result).toEqual({ code: 0, signal: null });
  }, 7_000);

  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  test.each([
    ["completed-turn-quit-lf", "/quit"],
    ["completed-turn-ctrl-c", "Ctrl+C"],
  ] as const)(
    "%s (%s) exits after a completed turn returns to IDLE and launches ambient reflection",
    async (action, _input) => {
      const { home, output, result } = await runPtyExit(action);
      const workspace = await createWorkspaceStore(home);
      const reflectionJobs = await workspace.jobs.list({
        kind: "runtime.reflect_capability",
        limit: 10,
      });
      workspace.close();

      expect(output).toContain("Controlled Pi completion for: No, keep this research brief concise.");
      expect(output).toContain("● IDLE");
      expect(reflectionJobs).toHaveLength(1);
      expect(reflectionJobs[0]?.attempt).toBeGreaterThan(0);
      expect(result).toEqual({ code: 0, signal: null });
    },
    7_000,
  );

  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  test.each([
    ["DEL", "backspace-del-quit", "ab"],
    ["BS", "backspace-bs-quit", "ab"],
    ["DEL grapheme", "backspace-grapheme-quit", "a"],
  ] as const)(
    "submits the value edited by ordinary %s Backspace in a real PTY",
    async (_variant, action, expected) => {
      const { home, output, result } = await runPtyExit(action);
      const reopened = await createTestRuntime(home);
      const trail = reopened.listTrails()[0];
      if (!trail) throw new Error("Expected the edited prompt to create one trail");
      const submitted = reopened.getTrail(trail.trailId).turns[0]?.input ?? "";

      expect(submitted).toBe(expected);
      expect(containsUnsafeTextControl(submitted)).toBe(false);
      expect(output).toContain(`Controlled Pi completion for: ${expected}`);
      expect(result).toEqual({ code: 0, signal: null });
    },
    7_000,
  );

  test("neutralizes bracketed C1 and OSC-like paste before the real PTY runtime sees it", async () => {
    const { home, output, result } = await runPtyExit("paste-controls-quit", undefined, {
      columns: 70,
      rows: 22,
    });
    const reopened = await createTestRuntime(home);
    const trail = reopened.listTrails()[0];
    if (!trail) throw new Error("Expected the pasted prompt to create one trail");
    const submitted = reopened.getTrail(trail.trailId).turns[0]?.input ?? "";

    expect(submitted).toContain("Unicode 界面");
    expect(containsUnsafeTextControl(submitted)).toBe(false);
    expect(containsC1(output)).toBe(false);
    expect(output).toContain("Controlled Pi completion for:");
    expect(result).toEqual({ code: 0, signal: null });
  }, 7_000);

  test("does not submit fragmented hostile paste until a later genuine Enter", async () => {
    const { home, output, result } = await runPtyExit("fragmented-hostile-paste-quit");
    const reopened = await createTestRuntime(home);
    const trail = reopened.listTrails()[0];
    if (!trail) throw new Error("Expected the sanitized prompt to create one trail");
    const turns = reopened.getTrail(trail.trailId).turns;

    expect(output).not.toContain("__NOESIS_PREMATURE_SUBMIT__");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.input).toBe("safe\nBAD [2J  31m ");
    expect(containsUnsafeTextControl(turns[0]?.input ?? "")).toBe(false);
    expect(result).toEqual({ code: 0, signal: null });
  }, 7_000);

  test("captures a resumed narrow 70x22 shell without crowding it with ASCII art", async () => {
    const { output, result } = await runPtyExit(
      "quit-lf",
      async (home) => {
        const runtime = await createTestRuntime(home);
        const selected = await runtime.startTrail({
          title: "narrow resumed",
        });
        await runtime.debug.runTurn(selected.trailId, "narrow history");
        await runtime.shutdown();
        return ["--resume", selected.trailId];
      },
      { columns: 70, rows: 22 },
    );

    expect(hasStartupNote(output)).toBe(true);
    expect(output).toMatch(/NOESIS {2}.+/u);
    expect(output).not.toContain("███╗   ██╗ ██████╗");
    // A 70-column status line has no room for the session field; the resumed content is the
    // evidence that the right session opened.
    expect(output).toContain("narrow history");
    expect(result).toEqual({ code: 0, signal: null });
  }, 7_000);

  test("keeps the picker compact and branded at 70x22", async () => {
    const { output, result } = await runPtyExit(
      "picker-cancel",
      async (home) => {
        const runtime = await createTestRuntime(home);
        const trail = await runtime.startTrail({ title: "picker snapshot" });
        await retainTrail(runtime, trail.trailId, "picker snapshot history");
        await runtime.shutdown();
        return ["--resume"];
      },
      { columns: 70, rows: 22 },
    );

    expect(output).toContain("NOESIS  resume a session");
    expect(output).toContain("↑/↓ navigate · Enter resume · d delete · Esc cancel");
    expect(result).toEqual({ code: 0, signal: null });
  }, 7_000);

  test("protects chat and input in a short 50x9 shell", async () => {
    const { output, result } = await runPtyExit("quit-lf", undefined, {
      columns: 50,
      rows: 9,
    });

    expect(output).not.toContain("███╗   ██╗ ██████╗");
    expect(hasStartupNote(output)).toBe(false);
    expect(output).toContain("● IDLE");
    expect(output).toContain("› message");
    expect(output).toContain("? help · ctrl+o inspect runs");
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
    expect(hasStartupNote(resized)).toBe(false);
    expect(resized).toContain("● IDLE");
    expect(resized).toContain("› message");
    expect(result).toEqual({ code: 0, signal: null });
  }, 7_000);

  test("recomputes picker rows after a live PTY shrink", async () => {
    const { output, result } = await runPtyExit(
      "resize-picker-cancel",
      async (home) => {
        const runtime = await createTestRuntime(home);
        for (let index = 0; index < 12; index += 1) {
          const trail = await runtime.startTrail({
            title: `resize picker ${String(index).padStart(2, "0")}`,
          });
          await retainTrail(runtime, trail.trailId, `resize picker history ${String(index)}`);
        }
        await runtime.shutdown();
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
    expect(output).toMatch(/[⠉⠃⠆⡄⣀⢠⠰⠘] STREAMING/u);
    expect(output).toContain("Controlled Pi completion for:");
    expect(resized).not.toContain("███╗   ██╗");
    // History scrolls into terminal scrollback instead of being replaced by a crop marker.
    expect(screen).not.toContain("earlier conversation");
    // The speaker label was rendered and has since scrolled above the viewport into scrollback,
    // exactly as a long message behaves in any terminal transcript.
    expect(output).toContain("NOESIS");
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
