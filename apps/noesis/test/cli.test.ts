import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cliPath = join(repositoryRoot, "apps/noesis/src/cli.ts");

async function runCli(
  args: readonly string[],
): Promise<{ readonly code: number | null; readonly output: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", cliPath, ...args], {
    cwd: repositoryRoot,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const collect = (chunk: Buffer): void => {
    output += chunk.toString("utf8");
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const code = await new Promise<number | null>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI did not exit within 10 seconds. Output:\n${output}`));
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (exitCode) => {
      clearTimeout(timeout);
      resolveExit(exitCode);
    });
  });
  return { code, output };
}

describe("Noesis CLI grammar", () => {
  test.each([
    {
      args: ["inspect", "--continue"],
      message: "--continue is available only with the tui command",
    },
    {
      args: ["inspect", "unexpected"],
      message: "Unexpected inspect argument unexpected",
    },
    {
      args: ["demo", "unexpected"],
      message: "Unexpected demo argument unexpected",
    },
    {
      args: ["config", "show", "unexpected"],
      message: "Unexpected config argument unexpected",
    },
    {
      args: ["config", "init", "--model", "not-allowed"],
      message: "--model is not valid for config init",
    },
    {
      args: ["auth", "status", "openrouter", "unexpected"],
      message: "Unexpected auth argument unexpected",
    },
    {
      args: ["rebuild", "--resume"],
      message: "--resume is available only with the tui command",
    },
    {
      args: ["--continue", "--resume"],
      message: "--continue and --resume are mutually exclusive",
    },
    {
      args: ["--resume", "trail_exact", "--continue"],
      message: "--continue and --resume are mutually exclusive",
    },
    {
      args: ["--continue", "--continue"],
      message: "--continue may be specified only once",
    },
    {
      args: ["--continue=value"],
      message: "--continue does not accept a value",
    },
    {
      args: ["--continue", "trail_not_a_value"],
      message: "--continue does not accept a value or trailing operand",
    },
    {
      args: ["tui", "--continue", "--home", ".noesis", "trailing"],
      message: "Unexpected tui argument trailing",
    },
    {
      args: ["demo", "--continue"],
      message: "--continue is available only with the tui command",
    },
    {
      args: ["onboard", "unexpected"],
      message: "Unexpected onboard argument unexpected",
    },
    {
      args: ["help", "unexpected"],
      message: "Unexpected help argument unexpected",
    },
  ])("rejects malformed non-TUI arguments: $message", async ({ args, message }) => {
    const result = await runCli(args);
    expect(result.code).toBe(1);
    expect(result.output).toContain(message);
  });

  test("preserves a valid config invocation with options after the subcommand", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-cli-valid-config-"));
    const initialized = await runCli(["config", "init", "--home", home]);
    expect(initialized.code).toBe(0);
    expect(initialized.output).toContain(`Initialized ${join(home, "config.json")}`);

    const shown = await runCli(["config", "show", "--home", home, "--runtime", "fake"]);
    expect(shown.code).toBe(0);
    expect(shown.output).toContain('"runtime": "fake"');
  });

  test("documents continue ordering and strict non-interactive semantics in help", async () => {
    const result = await runCli(["--help"]);

    expect(result.code).toBe(0);
    expect(result.output).toContain("noesis --continue");
    expect(result.output).toContain("single most recently active session");
    expect(result.output).toContain("full trail ID ascending on ties");
    expect(result.output).toContain("still marked running is not recovered or resumed automatically");
  });

  test("continue on an empty configured home fails without creating a trail", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-cli-empty-continue-"));
    const result = await runCli([
      "--continue",
      "--home",
      home,
      "--runtime",
      "fake",
      "--provider",
      "fake",
      "--model",
      "noesis-fake-1",
    ]);

    expect(result.code).toBe(1);
    expect(result.output).toContain("No saved sessions");
    expect(result.output).toContain("without --continue");
    expect(await readFile(join(home, "ledger", "events.jsonl"), "utf8")).toBe("");
  });

  test("runs the fake application through activation, scoped serving, and protected revert", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-cli-fake-loop-"));
    const result = await runCli(["demo", "--home", home]);

    expect(result.code).toBe(0);
    const jsonStart = result.output.indexOf("{");
    expect(jsonStart).toBeGreaterThanOrEqual(0);
    const summary: unknown = JSON.parse(result.output.slice(jsonStart));
    expect(summary).toMatchObject({
      home,
      experiment: {
        scope: "research brief",
      },
      related: {
        servedRevision: {
          kind: "capability_revision",
        },
      },
      unrelated: {
        selectedCapabilityIds: ["general-collaboration"],
      },
      revert: {
        outcomeId: expect.stringMatching(/^experiment_outcome_/u),
        restoredActivationId: expect.stringMatching(/^restoration_/u),
      },
    });
  });
});
