import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noesis/domain";
import { createWorkspaceStore } from "@noesis/workspace";
import { describe, expect, test } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cliPath = join(repositoryRoot, "apps/noesis/src/cli.ts");
const tsxLoader = import.meta.resolve("tsx");

async function runCli(
  args: readonly string[],
  cwd = repositoryRoot,
  environment: Readonly<Record<string, string | undefined>> = {},
): Promise<{ readonly code: number | null; readonly output: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  const child = spawn(process.execPath, ["--import", tsxLoader, cliPath, ...args], {
    cwd,
    env,
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
    { args: ["demo"], message: "Unknown command demo" },
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
      args: ["inspect", "--trust-workspace"],
      message: "--trust-workspace is valid only for the tui or skills command",
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

    const shown = await runCli(["config", "show", "--home", home, "--model", "configured-model"]);
    expect(shown.code).toBe(0);
    expect(shown.output).toContain('"model": "configured-model"');
  });

  test("documents continue ordering and strict non-interactive semantics in help", async () => {
    const result = await runCli(["--help"]);

    expect(result.code).toBe(0);
    expect(result.output).toContain("Defaults to ~/.noesis");
    expect(result.output).toContain("--home PATH overrides NOESIS_HOME");
    expect(result.output).toContain("noesis --continue");
    expect(result.output).toContain("single most recently active session");
    expect(result.output).toContain("full trail ID ascending on ties");
    expect(result.output).toContain("still marked running is not recovered or resumed automatically");
    expect(result.output).toContain("--trust-workspace");
  });

  test("defaults to the current OS user's global Noesis home", async () => {
    const userHome = await mkdtemp(join(tmpdir(), "noesis-cli-user-home-"));
    const workingDirectory = await mkdtemp(join(tmpdir(), "noesis-cli-working-directory-"));

    const initialized = await runCli(["config", "init"], workingDirectory, {
      HOME: userHome,
      NOESIS_HOME: undefined,
      USERPROFILE: userHome,
    });

    expect(initialized.code).toBe(0);
    expect(initialized.output).toContain(`Initialized ${join(userHome, ".noesis", "config.json")}`);
    await expect(readFile(join(userHome, ".noesis", "config.json"), "utf8")).resolves.toContain(
      '"schemaVersion": 1',
    );
    await expect(readFile(join(workingDirectory, ".noesis", "config.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("--home overrides NOESIS_HOME and NOESIS_HOME overrides the global default", async () => {
    const userHome = await mkdtemp(join(tmpdir(), "noesis-cli-precedence-user-"));
    const environmentHome = join(userHome, "from-environment");
    const explicitHome = join(userHome, "from-cli");

    const initializedFromEnvironment = await runCli(["config", "init"], repositoryRoot, {
      HOME: userHome,
      NOESIS_HOME: environmentHome,
    });
    const initializedFromCli = await runCli(["config", "init", "--home", explicitHome], repositoryRoot, {
      HOME: userHome,
      NOESIS_HOME: environmentHome,
    });

    expect(initializedFromEnvironment.code).toBe(0);
    expect(initializedFromEnvironment.output).toContain(
      `Initialized ${join(environmentHome, "config.json")}`,
    );
    expect(initializedFromCli.code).toBe(0);
    expect(initializedFromCli.output).toContain(`Initialized ${join(explicitHome, "config.json")}`);
  });

  test("honors workspace scope for skill updates", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-cli-skills-"));
    const workspace = join(home, "workspace");
    const skillPackage = join(home, "skill-package");
    await mkdir(workspace, { recursive: true });
    await mkdir(join(skillPackage, "skills", "cli-skill"), { recursive: true });
    await writeFile(
      join(skillPackage, "skills", "cli-skill", "SKILL.md"),
      "---\nname: cli-skill\ndescription: CLI scope test.\n---\n\nUse the CLI.",
      "utf8",
    );
    const installed = await runCli(
      ["skills", "install", skillPackage, "--workspace", "--trust-workspace", "--home", home],
      workspace,
    );
    const updated = await runCli(
      ["skills", "update", skillPackage, "--workspace", "--trust-workspace", "--home", home],
      workspace,
    );

    expect(installed, installed.output).toMatchObject({ code: 0 });
    expect(updated, updated.output).toMatchObject({ code: 0 });
    expect(updated.output).toContain(`Updated ${skillPackage}`);
  });

  test("requires workspace trust independently from workspace skill scope", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-cli-skills-untrusted-"));
    const workspace = join(home, "workspace");
    const skillPackage = join(home, "skill-package");
    await mkdir(workspace, { recursive: true });
    await mkdir(join(skillPackage, "skills", "cli-skill"), { recursive: true });
    await writeFile(
      join(skillPackage, "skills", "cli-skill", "SKILL.md"),
      "---\nname: cli-skill\ndescription: CLI trust test.\n---\n\nUse the CLI.",
      "utf8",
    );

    const result = await runCli(
      ["skills", "install", skillPackage, "--workspace", "--home", home],
      workspace,
    );

    expect(result.code).toBe(1);
    expect(result.output).toContain("requires explicit workspace trust");
  });

  test("read-only inspection does not recover interrupted operations", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-cli-read-only-"));
    expect((await runCli(["config", "init", "--home", home])).code).toBe(0);
    const store = await createWorkspaceStore(home, { recoverInterruptedOperations: false });
    await store.operational.sessions.put({
      sessionId: "session-running",
      title: "Running",
      status: "running",
      provider: "controlled",
      model: "controlled",
      runtime: "pi",
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:00:00.000Z",
      metadata: Object.freeze({}),
    });
    const sourceBytes = Buffer.from("return null;");
    const sourceArtifact = await store.artifacts.writeArtifact({
      path: "codemode/execution-running/source.mjs",
      mediaType: "text/javascript",
      bytes: sourceBytes,
      actor: Object.freeze({ actorId: "cli-test", kind: "user" as const }),
      relationshipRefs: Object.freeze([
        {
          kind: "database_row" as const,
          table: "sessions" as const,
          rowId: "session-running",
        },
      ]),
    });
    await store.operational.codeExecutions.put({
      executionId: "execution-running",
      logicalExecutionId: "execution-running",
      sessionId: "session-running",
      catalogId: "catalog",
      catalogDigest: sha256("catalog"),
      sourceDigest: sha256(sourceBytes),
      sourceArtifactId: sourceArtifact.artifactId,
      status: "running",
      callCount: 0,
      startedAt: "2026-07-26T00:00:00.000Z",
    });
    store.close();

    const inspected = await runCli(["inspect", "--home", home]);
    const database = new DatabaseSync(join(home, "database", "noesis.sqlite"), { readOnly: true });
    const row = database
      .prepare("SELECT status FROM codemode_executions WHERE execution_id = ?")
      .get("execution-running");
    database.close();

    expect(inspected.code).toBe(0);
    expect(Reflect.get(row ?? {}, "status")).toBe("running");
  });

  test("continue on an empty configured home fails without creating a trail", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-cli-empty-continue-"));
    const result = await runCli([
      "--continue",
      "--home",
      home,
      "--provider",
      "openrouter",
      "--model",
      "anthropic/claude-sonnet-4.5",
    ]);

    expect(result.code).toBe(1);
    expect(result.output).toContain("No saved sessions");
    expect(result.output).toContain("without --continue");
    await expect(readFile(join(home, "ledger", "events.jsonl"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
