import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  globalMcpConfigPath,
  loadMcpConfig,
  projectMcpConfigPath,
  removeMcpServer,
  setMcpServerEnabled,
  writeMcpServer,
} from "../src/config.ts";

describe("MCP configuration", () => {
  test("normalizes command-array authoring while keeping only environment references", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-mcp-array-"));
    const path = projectMcpConfigPath(root);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        servers: {
          demo: {
            type: "local",
            command: ["node", "server.mjs"],
            environment: { TOKEN: "DEMO_TOKEN" },
          },
        },
      }),
    );
    const loaded = await loadMcpConfig({ home: join(root, "home"), projectDirectory: root });
    expect(loaded.servers.get("demo")?.config).toEqual({
      type: "local",
      command: "node",
      args: ["server.mjs"],
      environment: { TOKEN: "DEMO_TOKEN" },
    });
  });
  test("merges global and project files with project definitions taking precedence", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-mcp-config-"));
    const home = join(root, "home");
    const projectDirectory = join(root, "project");
    await writeMcpServer({
      home,
      projectDirectory,
      scope: "global",
      name: "shared",
      config: { type: "remote", url: "https://global.example/mcp" },
    });
    await writeMcpServer({
      home,
      projectDirectory,
      scope: "project",
      name: "shared",
      config: { type: "local", command: "node", args: ["server.mjs"] },
    });

    const loaded = await loadMcpConfig({ home, projectDirectory });

    expect(loaded.servers.get("shared")).toMatchObject({
      scope: "project",
      sourcePath: projectMcpConfigPath(projectDirectory),
      config: { type: "local", command: "node", args: ["server.mjs"] },
    });
    expect(loaded.installed).toMatchObject([
      { name: "shared", scope: "global", shadowed: true },
      { name: "shared", scope: "project", shadowed: false },
    ]);
    expect(await readFile(globalMcpConfigPath(home), "utf8")).toContain("https://global.example/mcp");
  });

  test("enables and removes one scoped server without touching the other scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-mcp-mutate-"));
    const home = join(root, "home");
    const projectDirectory = join(root, "project");
    await writeMcpServer({
      home,
      projectDirectory,
      scope: "global",
      name: "docs",
      config: { type: "remote", url: "https://docs.example/mcp", enabled: false },
    });
    await writeMcpServer({
      home,
      projectDirectory,
      scope: "project",
      name: "local",
      config: { type: "local", command: "node", args: ["server.mjs"] },
    });

    await setMcpServerEnabled({ home, projectDirectory, scope: "global", name: "docs", enabled: true });
    await removeMcpServer({ home, projectDirectory, scope: "project", name: "local" });

    const loaded = await loadMcpConfig({ home, projectDirectory });
    const docsName = "docs";
    expect(loaded.global.servers[docsName]?.enabled).toBe(true);
    expect(loaded.project.servers).toEqual({});
  });

  test("serializes concurrent mutations to the same configuration file", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-mcp-concurrent-"));
    const home = join(root, "home");
    const projectDirectory = join(root, "project");

    await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        writeMcpServer({
          home,
          projectDirectory,
          scope: "project",
          name: `server_${String(index)}`,
          config: { type: "local", command: "node", args: [`server-${String(index)}.mjs`] },
        }),
      ),
    );

    const loaded = await loadMcpConfig({ home, projectDirectory });
    expect(Object.keys(loaded.project.servers)).toHaveLength(24);
    const firstName = "server_0";
    const lastName = "server_23";
    expect(loaded.project.servers[firstName]).toMatchObject({ args: ["server-0.mjs"] });
    expect(loaded.project.servers[lastName]).toMatchObject({ args: ["server-23.mjs"] });
  });

  test("serializes read-modify-write mutations across processes", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-mcp-process-lock-"));
    const home = join(root, "home");
    const projectDirectory = join(root, "project");
    const configModule = new URL("../src/config.ts", import.meta.url).href;
    const runWriter = async (name: string): Promise<void> => {
      const script = [
        `import { writeMcpServer } from ${JSON.stringify(configModule)};`,
        `await writeMcpServer(${JSON.stringify({
          home,
          projectDirectory,
          scope: "project",
          name,
          config: { type: "local", command: "node", args: [`${name}.mjs`] },
        })});`,
      ].join("\n");
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
        cwd: process.cwd(),
        stdio: ["ignore", "ignore", "pipe"],
      });
      const errors: Buffer[] = [];
      child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`MCP config writer failed: ${Buffer.concat(errors).toString("utf8")}`));
        });
      });
    };

    await Promise.all([runWriter("alpha"), runWriter("beta")]);

    const loaded = await loadMcpConfig({ home, projectDirectory });
    expect(Object.keys(loaded.project.servers).sort()).toEqual(["alpha", "beta"]);
  });

  test("recovers a stale lock left by a dead process", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-mcp-stale-lock-"));
    const home = join(root, "home");
    const projectDirectory = join(root, "project");
    const path = projectMcpConfigPath(projectDirectory);
    const lockPath = `${path}.lock`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      lockPath,
      `${JSON.stringify({
        token: "stale",
        pid: 2_147_483_647,
        hostname: hostname(),
        createdAt: 0,
      })}\n`,
      { mode: 0o600 },
    );
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);

    await writeMcpServer({
      home,
      projectDirectory,
      scope: "project",
      name: "recovered",
      config: { type: "local", command: "node" },
    });

    expect((await loadMcpConfig({ home, projectDirectory })).project.servers).toHaveProperty("recovered");
  });

  test("recovers a stale reaper marker left by a dead process", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-mcp-stale-reaper-"));
    const home = join(root, "home");
    const projectDirectory = join(root, "project");
    const path = projectMcpConfigPath(projectDirectory);
    const reaperPath = `${path}.lock.reap`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(reaperPath, "stale\n", { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    await utimes(reaperPath, old, old);

    await writeMcpServer({
      home,
      projectDirectory,
      scope: "project",
      name: "recovered",
      config: { type: "local", command: "node" },
    });

    expect((await loadMcpConfig({ home, projectDirectory })).project.servers).toHaveProperty("recovered");
  });

  test("does not treat inherited object properties as configured servers", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-mcp-own-property-"));
    const home = join(root, "home");
    const projectDirectory = join(root, "project");

    await writeMcpServer({
      home,
      projectDirectory,
      scope: "global",
      name: "constructor",
      config: { type: "local", command: "node" },
    });
    expect(
      (await loadMcpConfig({ home, projectDirectory })).installed.find(
        (server) => server.name === "constructor",
      )?.shadowed,
    ).toBe(false);

    await expect(
      setMcpServerEnabled({
        home,
        projectDirectory,
        scope: "project",
        name: "constructor",
        enabled: true,
      }),
    ).rejects.toThrow('server "constructor" does not exist');
  });

  test("retries a mutation when an external edit lands before the atomic replace", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-mcp-external-edit-"));
    const home = join(root, "home");
    const projectDirectory = join(root, "project");
    const path = projectMcpConfigPath(projectDirectory);
    await writeMcpServer({
      home,
      projectDirectory,
      scope: "project",
      name: "existing",
      config: { type: "local", command: "node", args: ["existing.mjs"] },
    });

    const externalConfig = `${JSON.stringify(
      {
        servers: {
          existing: { type: "local", command: "node", args: ["existing.mjs"] },
          external: { type: "remote", url: "https://external.example/mcp" },
        },
      },
      null,
      2,
    )}\n`;
    const externalEditor = spawn(
      process.execPath,
      [
        "-e",
        [
          'const fs = require("node:fs");',
          "const [directory, path, content] = process.argv.slice(1);",
          "const deadline = Date.now() + 5000;",
          'process.stdout.write("ready\\n");',
          "while (Date.now() < deadline) {",
          '  if (!fs.readdirSync(directory).some((name) => name.startsWith("mcp.json.") && name.endsWith(".tmp"))) continue;',
          '  fs.writeFileSync(path, content, "utf8");',
          "  process.exit(0);",
          "}",
          "process.exit(2);",
        ].join("\n"),
        dirname(path),
        path,
        externalConfig,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const externalEditorReady = new Promise<void>((resolve, reject) => {
      externalEditor.once("error", reject);
      externalEditor.stdout.once("data", () => resolve());
    });
    const externalEditObserved = new Promise<void>((resolve, reject) => {
      externalEditor.once("error", reject);
      externalEditor.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`external editor exited with code ${String(code)}`));
      });
    });

    await externalEditorReady;
    const mutation = writeMcpServer({
      home,
      projectDirectory,
      scope: "project",
      name: "internal",
      config: { type: "remote", url: "https://internal.example/mcp" },
    });
    await Promise.all([mutation, externalEditObserved]);

    const loaded = await loadMcpConfig({ home, projectDirectory });
    expect(Object.keys(loaded.project.servers).sort()).toEqual(["existing", "external", "internal"]);
  });

  test("reports the source path and schema location for invalid configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-mcp-invalid-"));
    const path = globalMcpConfigPath(root);
    await writeFile(path, JSON.stringify({ servers: { bad: { type: "remote", url: "not a URL" } } }));

    await expect(loadMcpConfig({ home: root, projectDirectory: join(root, "project") })).rejects.toThrow(
      `${path}: invalid MCP configuration at /servers/bad/url`,
    );
  });
});
