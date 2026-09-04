import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repositoryRoot = new URL("../", import.meta.url);

async function run(file, args, options = {}) {
  return await execute(file, args, {
    cwd: repositoryRoot,
    env: { ...process.env, NOESIS_DISABLE_BROWSER_OPEN: "1" },
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "noesis-package-smoke-"));
try {
  const packDirectory = join(temporaryRoot, "pack");
  const npmCache = join(temporaryRoot, "npm-cache");
  const installRoot = join(temporaryRoot, "install");
  const home = join(temporaryRoot, "home");
  const project = join(temporaryRoot, "project");
  await Promise.all([mkdir(packDirectory, { recursive: true }), mkdir(project, { recursive: true })]);
  const packed = await run("npm", [
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    packDirectory,
    "--cache",
    npmCache,
  ]);
  const [report] = JSON.parse(packed.stdout);
  requireCondition(report?.name === "noesisai", "Packed artifact must be named noesisai");
  requireCondition(report.version === "0.0.1", "Packed artifact must be version 0.0.1");
  const packedPaths = new Set(report.files.map((file) => file.path));
  for (const required of [
    "README.md",
    "dist/cli.js",
    "dist/apps/noesis/skills/execute/SKILL.md",
    "dist/apps/noesis/skills/noesis/SKILL.md",
    "dist/packages/codemode/src/runner.mjs",
    "dist/packages/workspace/migrations/001_operational.sql",
    "dist/packages/workspace/migrations/048_process_scoped_subagents.sql",
  ]) {
    requireCondition(packedPaths.has(required), `Packed artifact is missing ${required}`);
  }
  const forbidden = [...packedPaths].find(
    (path) =>
      path.includes("/.noesis/") ||
      path.includes("/.env") ||
      path.includes("/test/") ||
      path.startsWith("plans/") ||
      path.endsWith(".ts"),
  );
  requireCondition(forbidden === undefined, `Packed artifact contains forbidden path ${forbidden}`);
  const archive = join(packDirectory, report.filename);
  await run("npm", [
    "install",
    "--prefix",
    installRoot,
    "--cache",
    npmCache,
    "--no-audit",
    "--no-fund",
    archive,
  ]);
  const binary = join(
    installRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "noesis.cmd" : "noesis",
  );
  const help = await run(binary, ["help"], { cwd: project });
  requireCondition(help.stdout.startsWith("Noesis\n\nUsage:"), "Installed noesis help output is invalid");
  requireCondition(!help.stderr.includes("ExperimentalWarning"), "Installed noesis leaks SQLite warnings");
  await run(binary, ["config", "init", "--home", home], { cwd: project });
  const skills = await run(binary, ["skills", "list", "--home", home], { cwd: project });
  const skillNames = JSON.parse(skills.stdout).skills.map((skill) => skill.name);
  requireCondition(skillNames.includes("execute"), "Installed package cannot load the execute skill");
  requireCondition(skillNames.includes("noesis"), "Installed package cannot load the noesis skill");
  const inspection = await run(binary, ["inspect", "--home", home], { cwd: project });
  requireCondition(
    Array.isArray(JSON.parse(inspection.stdout).trails),
    "Installed package cannot open its store",
  );

  const packageRoot = join(installRoot, "node_modules", "noesisai");
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  requireCondition(
    !JSON.stringify(manifest).includes("workspace:"),
    "Installed manifest contains workspace dependencies",
  );
  const codeModeModule = await import(
    pathToFileURL(join(packageRoot, "dist/packages/codemode/src/index.js")).href
  );
  const broker = Object.freeze({
    catalogId: "package-smoke",
    catalogDigest: "package-smoke",
    list: () => Object.freeze([]),
    search: () => Object.freeze([]),
    describe: () => undefined,
    invoke: async () => Object.freeze({ ok: false, code: "not_found", message: "No smoke tools" }),
  });
  const codeMode = codeModeModule.createCodeModeRuntime({ cwd: project, broker });
  try {
    const result = await codeMode.execute({
      source: "return { installedWorker: 6 * 7 };",
      sessionId: "package-smoke",
    });
    requireCondition(result.value.installedWorker === 42, "Installed Code Mode worker did not execute");
  } finally {
    await codeMode.shutdown();
  }

  console.log(`Package smoke passed for ${report.name}@${report.version} (${String(report.size)} bytes)`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
