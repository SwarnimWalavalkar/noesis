import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { resolve } from "import-meta-resolve";

const execute = promisify(execFile);
const repositoryRoot = new URL("../", import.meta.url);
const sourceManifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

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
    "--pack-destination",
    packDirectory,
    "--cache",
    npmCache,
  ]);
  const reportStart = packed.stdout.lastIndexOf("\n[");
  const reportJson = reportStart === -1 ? packed.stdout : packed.stdout.slice(reportStart + 1);
  const [report] = JSON.parse(reportJson);
  requireCondition(report?.name === sourceManifest.name, "Packed artifact name must match package.json");
  requireCondition(
    report.version === sourceManifest.version,
    "Packed artifact version must match package.json",
  );
  const packedPaths = new Set(report.files.map((file) => file.path));
  for (const required of [
    "LICENSE",
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
      path.endsWith(".map") ||
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
  await run(
    "npm",
    ["audit", "--omit=dev", "--audit-level=moderate", "--prefix", installRoot, "--cache", npmCache],
    { cwd: installRoot },
  );
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

  const packageRoot = join(installRoot, "node_modules", ...sourceManifest.name.split("/"));
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
    list: () => Object.freeze([{ name: "smoke.echo" }]),
    search: () => Object.freeze([]),
    describe: () => undefined,
    invoke: async (name, input) =>
      name === "smoke.echo"
        ? Object.freeze({ ok: true, value: input })
        : Object.freeze({ ok: false, code: "not_found", message: "Unknown smoke tool" }),
  });
  const codeMode = codeModeModule.createCodeModeRuntime({ cwd: project, broker });
  try {
    const result = await codeMode.execute({
      source:
        'const noesis = 42; console.log("installed log"); return { installedWorker: noesis, families: Object.keys(tools), echoed: await tools.smoke.echo({ ok: true }) };',
      sessionId: "package-smoke",
    });
    requireCondition(result.value.installedWorker === 42, "Installed Code Mode worker did not execute");
    requireCondition(result.stdout === "installed log\n", "Installed Code Mode lost stdout");
    requireCondition(
      result.value.families.includes("smoke") && result.value.echoed.ok,
      "Installed Code Mode did not project the frozen catalog",
    );
  } finally {
    await codeMode.shutdown();
  }

  // Use the consumer's module graph, including shrinkwrapped nested Pi copies.
  // A referenced timer makes missed cleanup an observable process-exit failure.
  await run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { resolve } from ${JSON.stringify(resolve("import-meta-resolve", pathToFileURL(join(packageRoot, "package.json")).href))};
    const base = ${JSON.stringify(pathToFileURL(join(packageRoot, "package.json")).href)};
    const owners = [...new Set([
      resolve("@earendil-works/pi-ai", base),
      ...["@earendil-works/pi-coding-agent", "@earendil-works/pi-agent-core"].map(owner =>
        resolve("@earendil-works/pi-ai", resolve(owner, base))),
    ])];
    const seen = [];
    const unregister = [];
    for (const owner of owners) {
      const resources = await import(owner);
      const timer = setInterval(() => {}, 1000);
      unregister.push(resources.registerSessionResourceCleanup(id => { clearInterval(timer); seen.push(id); }));
    }
    const { createEphemeralPiSession } = await import(${JSON.stringify(pathToFileURL(join(packageRoot, "dist/packages/runtime-pi/src/session-lifecycle.js")).href)});
    const session = await createEphemeralPiSession();
    await session.close();
    if (seen.length !== owners.length || seen.some(id => id !== session.session.metadata.id + ":main"))
      throw new Error("Installed Pi session cleanup missed a resource owner");
    for (const remove of unregister) remove();
  `,
    ],
    { cwd: project, timeout: 10_000 },
  );

  console.log(`Package smoke passed for ${report.name}@${report.version} (${String(report.size)} bytes)`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
