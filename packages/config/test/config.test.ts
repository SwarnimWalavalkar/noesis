import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  initializeNoesisConfig,
  noesisConfigPath,
  readNoesisConfig,
  resolveNoesisConfig,
  updateNoesisConfig,
  updateToolHotbar,
  updateUserControlConfig,
} from "../src/index.ts";

function updateFromSeparateProcess(home: string, patch: Readonly<Record<string, string>>): Promise<void> {
  const moduleUrl = new URL("../src/index.ts", import.meta.url).href;
  const script = `import { updateNoesisConfig } from ${JSON.stringify(moduleUrl)}; await updateNoesisConfig(${JSON.stringify(home)}, ${JSON.stringify(patch)});`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(new Error(`config writer process exited with code ${String(code)} signal ${String(signal)}`));
    });
  });
}

describe("Noesis config", () => {
  test("resolves CLI over environment over config over defaults", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-config-precedence-"));
    await writeFile(
      noesisConfigPath(home),
      JSON.stringify({
        schemaVersion: 1,
        agent: { provider: "file-provider", model: "file-model", thinkingLevel: "low" },
      }),
    );
    const resolved = await resolveNoesisConfig({
      home,
      env: { NOESIS_PROVIDER: "env-provider", NOESIS_MODEL: "env-model" },
      cli: { model: "cli-model", thinkingLevel: "off" },
    });

    expect(resolved.agent).toEqual({
      provider: "env-provider",
      model: "cli-model",
      thinkingLevel: "off",
    });
    expect(resolved.sources).toEqual({
      provider: "environment",
      model: "cli",
      thinkingLevel: "cli",
    });
  });

  test.each(["off", "low"])("preserves the explicit %s thinking level", async (thinkingLevel) => {
    const home = await mkdtemp(join(tmpdir(), "noesis-config-level-"));
    await writeFile(noesisConfigPath(home), JSON.stringify({ schemaVersion: 1, agent: { thinkingLevel } }));
    expect((await resolveNoesisConfig({ home, env: {} })).agent.thinkingLevel).toBe(thinkingLevel);
  });

  test("ignores the removed version-1 runtime selector without rewriting the file", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-config-legacy-v1-"));
    const legacy = '{"schemaVersion":1,"agent":{"runtime":"fake"}}\n';
    await writeFile(noesisConfigPath(home), legacy);

    const resolved = await resolveNoesisConfig({ home, env: {} });

    expect(resolved.agent).toEqual({
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      thinkingLevel: "high",
    });
    expect(resolved.learning).toEqual({ enabled: true, notifications: "quiet", backgroundBudget: 1 });
    expect(resolved.autonomy).toEqual({
      riskLevel: "low",
      approval: "authority_expansion",
      pins: "respect",
      vetoes: "respect",
    });
    expect(resolved.experiments).toEqual({ maxCases: 8, maxAttemptsPerArm: 1, maxCost: 0 });
    expect(resolved.tools.hotbar).toEqual([
      "files.read",
      "files.list",
      "shell.run",
      "workflows.run",
      "history.search_sessions",
    ]);
    expect(await readFile(noesisConfigPath(home), "utf8")).toBe(legacy);
  });

  test("defaults workflow and session search tools without changing explicit persisted choices", async () => {
    const missing = await mkdtemp(join(tmpdir(), "noesis-config-default-hotbar-"));
    const oldPersisted = await mkdtemp(join(tmpdir(), "noesis-config-old-hotbar-"));
    const customPersisted = await mkdtemp(join(tmpdir(), "noesis-config-custom-hotbar-"));
    const explicitlyEmpty = await mkdtemp(join(tmpdir(), "noesis-config-empty-hotbar-"));
    await writeFile(
      noesisConfigPath(oldPersisted),
      JSON.stringify({
        schemaVersion: 1,
        agent: {},
        tools: { hotbar: ["files.read", "files.list", "shell.run"] },
      }),
    );
    await writeFile(
      noesisConfigPath(customPersisted),
      JSON.stringify({
        schemaVersion: 1,
        agent: {},
        tools: { hotbar: ["files.read", "custom.tool"] },
      }),
    );
    await writeFile(
      noesisConfigPath(explicitlyEmpty),
      JSON.stringify({ schemaVersion: 1, agent: {}, tools: { hotbar: [] } }),
    );

    expect((await resolveNoesisConfig({ home: missing, env: {} })).tools.hotbar).toEqual([
      "files.read",
      "files.list",
      "shell.run",
      "workflows.run",
      "history.search_sessions",
    ]);
    expect((await resolveNoesisConfig({ home: oldPersisted, env: {} })).tools.hotbar).toEqual([
      "files.read",
      "files.list",
      "shell.run",
    ]);
    expect((await resolveNoesisConfig({ home: customPersisted, env: {} })).tools.hotbar).toEqual([
      "files.read",
      "custom.tool",
    ]);
    expect((await resolveNoesisConfig({ home: explicitlyEmpty, env: {} })).tools.hotbar).toEqual([]);
  });

  test.each(["off", "low"])("preserves explicit %s autonomy with zero-value defaults", async (riskLevel) => {
    const home = await mkdtemp(join(tmpdir(), "noesis-config-autonomy-"));
    await writeFile(
      noesisConfigPath(home),
      JSON.stringify({
        schemaVersion: 1,
        agent: {},
        learning: { enabled: false, notifications: "off", backgroundBudget: 0 },
        autonomy: { riskLevel, approval: "all_changes", pins: "respect", vetoes: "respect" },
        experiments: { maxCases: 1, maxAttemptsPerArm: 1, maxCost: 0 },
      }),
    );

    const resolved = await resolveNoesisConfig({ home, env: {} });

    expect(resolved.learning).toEqual({ enabled: false, notifications: "off", backgroundBudget: 0 });
    expect(resolved.autonomy.riskLevel).toBe(riskLevel);
    expect(resolved.experiments.maxCost).toBe(0);
  });

  test("rejects unsupported versions and unknown fields with actionable errors", async () => {
    const unsupported = await mkdtemp(join(tmpdir(), "noesis-config-version-"));
    await writeFile(noesisConfigPath(unsupported), JSON.stringify({ schemaVersion: 2, agent: {} }));
    const versionResult = await readNoesisConfig(unsupported);
    expect(versionResult.ok).toBe(false);
    if (!versionResult.ok) expect(versionResult.error.message).toContain("accepts only schemaVersion 1");

    const unknown = await mkdtemp(join(tmpdir(), "noesis-config-unknown-"));
    await writeFile(
      noesisConfigPath(unknown),
      JSON.stringify({ schemaVersion: 1, agent: {}, credentials: { apiKey: "must-not-be-here" } }),
    );
    const unknownResult = await readNoesisConfig(unknown);
    expect(unknownResult.ok).toBe(false);
    if (!unknownResult.ok) expect(unknownResult.error.message).toContain("invalid schema");

    const nestedUnknown = await mkdtemp(join(tmpdir(), "noesis-config-nested-unknown-"));
    await writeFile(
      noesisConfigPath(nestedUnknown),
      JSON.stringify({ schemaVersion: 1, agent: { runtime: "fake", credential: "forbidden" } }),
    );
    const nestedUnknownResult = await readNoesisConfig(nestedUnknown);
    expect(nestedUnknownResult.ok).toBe(false);
    if (!nestedUnknownResult.ok) expect(nestedUnknownResult.error.message).toContain("/agent/credential");
  });

  test("initialization refuses to overwrite and updates only through an explicit operation", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-config-write-"));
    await initializeNoesisConfig(home);
    await expect(initializeNoesisConfig(home)).rejects.toThrow("refusing to overwrite");
    await updateNoesisConfig(home, { provider: "openai-codex", model: "gpt-5.5" });
    const persisted = JSON.parse(await readFile(noesisConfigPath(home), "utf8")) as unknown;
    expect(persisted).toEqual({
      schemaVersion: 1,
      agent: {
        provider: "openai-codex",
        model: "gpt-5.5",
        thinkingLevel: "high",
      },
      learning: { enabled: true, notifications: "quiet", backgroundBudget: 1 },
      autonomy: {
        riskLevel: "low",
        approval: "authority_expansion",
        pins: "respect",
        vetoes: "respect",
      },
      experiments: { maxCases: 8, maxAttemptsPerArm: 1, maxCost: 0 },
      tools: {
        hotbar: ["files.read", "files.list", "shell.run", "workflows.run", "history.search_sessions"],
      },
    });
  });

  test("agent updates preserve declarative learning, autonomy, and experiment preferences", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-config-preserve-controls-"));
    await writeFile(
      noesisConfigPath(home),
      JSON.stringify({
        schemaVersion: 1,
        agent: {},
        learning: { enabled: false, notifications: "off", backgroundBudget: 0 },
        autonomy: { riskLevel: "off" },
        experiments: { maxCases: 2, maxCost: 0 },
      }),
    );

    await updateNoesisConfig(home, { model: "updated-model" });

    expect(JSON.parse(await readFile(noesisConfigPath(home), "utf8"))).toEqual({
      schemaVersion: 1,
      agent: { model: "updated-model" },
      learning: { enabled: false, notifications: "off", backgroundBudget: 0 },
      autonomy: { riskLevel: "off" },
      experiments: { maxCases: 2, maxCost: 0 },
    });
  });

  test("updates user controls atomically while preserving the legacy agent section", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-config-update-controls-"));
    await writeFile(
      noesisConfigPath(home),
      JSON.stringify({ schemaVersion: 1, agent: { model: "keep-model" } }),
    );

    await updateUserControlConfig(home, {
      learning: { enabled: false, notifications: "off", backgroundBudget: 0 },
      autonomy: { riskLevel: "low", approval: "all_changes" },
      experiments: { maxCases: 3, maxAttemptsPerArm: 1, maxCost: 0 },
      tools: { hotbar: ["files.read", "shell.run", "files.write"] },
    });

    expect(await resolveNoesisConfig({ home, env: {} })).toMatchObject({
      schemaVersion: 1,
      agent: { model: "keep-model" },
      learning: { enabled: false, notifications: "off", backgroundBudget: 0 },
      autonomy: { riskLevel: "low", approval: "all_changes" },
      experiments: { maxCases: 3, maxAttemptsPerArm: 1, maxCost: 0 },
      tools: { hotbar: ["files.read", "shell.run", "files.write"] },
    });
  });

  test("updates one project hotbar without replacing another project's pins", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-config-project-hotbars-"));
    await writeFile(
      noesisConfigPath(home),
      JSON.stringify({
        schemaVersion: 1,
        agent: {},
        tools: {
          hotbar: ["files.read", "workflows.run"],
          projectHotbars: {
            project_alpha: ["workflow.1111111111111111.alpha"],
            project_beta: ["workflow.2222222222222222.beta"],
          },
        },
      }),
    );

    await updateToolHotbar(home, {
      projectId: "project_alpha",
      projectToolNamespace: "workflow.1111111111111111.",
      scope: "global",
      action: "add",
      tool: "files.list",
      legacyGlobalProjectTools: [],
      legacyActiveProjectTools: [],
    });
    await updateToolHotbar(home, {
      projectId: "project_alpha",
      projectToolNamespace: "workflow.1111111111111111.",
      scope: "project",
      action: "add",
      tool: "workflow.1111111111111111.second",
      legacyGlobalProjectTools: [],
      legacyActiveProjectTools: [],
    });

    expect((await resolveNoesisConfig({ home, env: {} })).tools).toEqual({
      hotbar: ["files.read", "workflows.run", "files.list"],
      projectHotbars: {
        project_alpha: ["workflow.1111111111111111.alpha", "workflow.1111111111111111.second"],
        project_beta: ["workflow.2222222222222222.beta"],
      },
    });

    await updateToolHotbar(home, {
      projectId: "project_alpha",
      projectToolNamespace: "workflow.1111111111111111.",
      scope: "project",
      action: "remove",
      tool: "workflow.1111111111111111.alpha",
      legacyGlobalProjectTools: [],
      legacyActiveProjectTools: [],
    });
    await updateToolHotbar(home, {
      projectId: "project_alpha",
      projectToolNamespace: "workflow.1111111111111111.",
      scope: "project",
      action: "remove",
      tool: "workflow.1111111111111111.second",
      legacyGlobalProjectTools: [],
      legacyActiveProjectTools: [],
    });
    expect((await resolveNoesisConfig({ home, env: {} })).tools.projectHotbars).toEqual({
      project_beta: ["workflow.2222222222222222.beta"],
    });
  });

  test("persists MCP pins in the active project instead of the global hotbar", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-config-mcp-hotbar-"));
    await initializeNoesisConfig(home);
    await updateToolHotbar(home, {
      projectId: "project_alpha",
      projectToolNamespace: "workflow.1111111111111111.",
      scope: "project",
      action: "add",
      tool: "mcp.github.search_123456789abc",
      legacyGlobalProjectTools: [],
      legacyActiveProjectTools: [],
    });
    const config = await resolveNoesisConfig({ home, env: {} });
    expect(config.tools.hotbar).not.toContain("mcp.github.search_123456789abc");
    expect(config.tools.projectHotbars).toEqual({
      project_alpha: ["mcp.github.search_123456789abc"],
    });
  });

  test("rejects MCP tools in the global hotbar", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-config-global-mcp-hotbar-"));
    await initializeNoesisConfig(home);

    await expect(
      updateToolHotbar(home, {
        projectId: "project_alpha",
        projectToolNamespace: "workflow.1111111111111111.",
        scope: "global",
        action: "add",
        tool: "mcp.github.search_123456789abc",
        legacyGlobalProjectTools: [],
        legacyActiveProjectTools: [],
      }),
    ).rejects.toThrow("MCP tools are project-scoped");

    expect((await resolveNoesisConfig({ home, env: {} })).tools.hotbar).not.toContain(
      "mcp.github.search_123456789abc",
    );
  });

  test("allows removing a legacy MCP tool from the global hotbar", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-config-remove-global-mcp-hotbar-"));
    await writeFile(
      noesisConfigPath(home),
      JSON.stringify({
        schemaVersion: 1,
        agent: {},
        tools: { hotbar: ["files.read", "mcp.github.search_123456789abc"] },
      }),
    );

    await updateToolHotbar(home, {
      projectId: "project_alpha",
      projectToolNamespace: "workflow.1111111111111111.",
      scope: "global",
      action: "remove",
      tool: "mcp.github.search_123456789abc",
      legacyGlobalProjectTools: [],
      legacyActiveProjectTools: [],
    });

    expect((await resolveNoesisConfig({ home, env: {} })).tools.hotbar).not.toContain(
      "mcp.github.search_123456789abc",
    );
  });

  test("serializes concurrent global and same-project hotbar deltas without lost updates", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-config-concurrent-hotbar-"));
    await initializeNoesisConfig(home);
    const base = {
      projectId: "project_concurrent",
      projectToolNamespace: "workflow.3333333333333333.",
      action: "add" as const,
      legacyGlobalProjectTools: [],
      legacyActiveProjectTools: [],
    };

    await Promise.all([
      updateToolHotbar(home, { ...base, scope: "global", tool: "files.write" }),
      updateToolHotbar(home, { ...base, scope: "global", tool: "artifacts.write" }),
      updateToolHotbar(home, {
        ...base,
        scope: "project",
        tool: "workflow.3333333333333333.alpha",
      }),
      updateToolHotbar(home, {
        ...base,
        scope: "project",
        tool: "workflow.3333333333333333.beta",
      }),
    ]);

    const resolved = await resolveNoesisConfig({ home, env: {} });
    expect(resolved.tools.hotbar).toEqual(
      expect.arrayContaining([
        "files.read",
        "files.list",
        "shell.run",
        "workflows.run",
        "history.search_sessions",
        "files.write",
        "artifacts.write",
      ]),
    );
    expect(resolved.tools.projectHotbars["project_concurrent"]).toHaveLength(2);
    expect(resolved.tools.projectHotbars["project_concurrent"]).toEqual(
      expect.arrayContaining(["workflow.3333333333333333.alpha", "workflow.3333333333333333.beta"]),
    );
  });

  test("rejects an effective 16 plus 1 union under the config writer lock", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-config-hotbar-limit-"));
    const legacyTool = "workflow.4444444444444444.legacy";
    const projectTool = "workflow.4444444444444444.project";
    const global = Array.from({ length: 15 }, (_, index) => `global.${String(index)}`);
    await writeFile(
      noesisConfigPath(home),
      JSON.stringify({
        schemaVersion: 1,
        agent: {},
        tools: {
          hotbar: [...global, legacyTool],
          projectHotbars: { project_limit: [projectTool] },
        },
      }),
    );

    await expect(
      updateToolHotbar(home, {
        projectId: "project_limit",
        projectToolNamespace: "workflow.4444444444444444.",
        scope: "global",
        action: "add",
        tool: global[0] ?? "global.0",
        legacyGlobalProjectTools: [legacyTool],
        legacyActiveProjectTools: [legacyTool],
      }),
    ).rejects.toThrow("would contain 17 tools");
  });

  test("rejects a seventeenth global tool and preserves the config", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-config-global-hotbar-limit-"));
    const original = {
      schemaVersion: 1,
      agent: {},
      tools: { hotbar: Array.from({ length: 16 }, (_, index) => `global.${String(index)}`) },
    };
    await writeFile(noesisConfigPath(home), JSON.stringify(original));

    await expect(
      updateToolHotbar(home, {
        projectId: "project_global_limit",
        projectToolNamespace: "workflow.cccccccccccccccc.",
        scope: "global",
        action: "add",
        tool: "global.16",
        legacyGlobalProjectTools: [],
        legacyActiveProjectTools: [],
      }),
    ).rejects.toThrow("global hotbar would contain 17 tools");
    expect(JSON.parse(await readFile(noesisConfigPath(home), "utf8"))).toEqual(original);
  });

  test("a global delta cannot overflow another project's persisted or legacy hotbar", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-config-cross-project-limit-"));
    const global = Array.from({ length: 15 }, (_, index) => `global.${String(index)}`);
    const original = {
      schemaVersion: 1,
      agent: {},
      tools: {
        hotbar: global,
        projectHotbars: { project_alpha: ["workflow.aaaaaaaaaaaaaaaa.alpha"] },
      },
    };
    await writeFile(noesisConfigPath(home), JSON.stringify(original));

    await expect(
      updateToolHotbar(home, {
        projectId: "project_beta",
        projectToolNamespace: "workflow.bbbbbbbbbbbbbbbb.",
        scope: "global",
        action: "add",
        tool: "global.new",
        legacyGlobalProjectTools: [],
        legacyActiveProjectTools: [],
      }),
    ).rejects.toThrow("project project_alpha hotbar would contain 17 tools");
    expect(JSON.parse(await readFile(noesisConfigPath(home), "utf8"))).toEqual(original);

    const legacy = "workflow.aaaaaaaaaaaaaaaa.legacy";
    const withLegacy = {
      ...original,
      tools: {
        ...original.tools,
        hotbar: [...global.slice(0, 14), legacy],
      },
    };
    await writeFile(noesisConfigPath(home), JSON.stringify(withLegacy));
    await expect(
      updateToolHotbar(home, {
        projectId: "project_beta",
        projectToolNamespace: "workflow.bbbbbbbbbbbbbbbb.",
        scope: "global",
        action: "add",
        tool: "global.new",
        legacyGlobalProjectTools: [legacy],
        legacyActiveProjectTools: [],
      }),
    ).rejects.toThrow("project workflow namespace workflow.aaaaaaaaaaaaaaaa. hotbar would contain 17 tools");
    expect(JSON.parse(await readFile(noesisConfigPath(home), "utf8"))).toEqual(withLegacy);
  });

  test("serializes independent writers without losing either patch", async () => {
    for (let pair = 0; pair < 100; pair += 1) {
      const home = await mkdtemp(join(tmpdir(), "noesis-config-writers-"));
      await initializeNoesisConfig(home);
      await Promise.all([
        updateNoesisConfig(home, { provider: `provider-${pair}` }),
        updateNoesisConfig(home, { model: `model-${pair}` }),
      ]);
      const resolved = await resolveNoesisConfig({ home, env: {} });
      expect(resolved.agent.provider).toBe(`provider-${pair}`);
      expect(resolved.agent.model).toBe(`model-${pair}`);
    }
  }, 30_000);

  test("serializes separate writer processes without losing either patch", async () => {
    for (let pair = 0; pair < 20; pair += 1) {
      const home = await mkdtemp(join(tmpdir(), "noesis-config-processes-"));
      await initializeNoesisConfig(home);
      await Promise.all([
        updateFromSeparateProcess(home, { provider: `process-provider-${pair}` }),
        updateFromSeparateProcess(home, { model: `process-model-${pair}` }),
      ]);
      const resolved = await resolveNoesisConfig({ home, env: {} });
      expect(resolved.agent.provider).toBe(`process-provider-${pair}`);
      expect(resolved.agent.model).toBe(`process-model-${pair}`);
    }
  }, 30_000);

  test("reclaims a dead config writer lock before applying the update", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-config-dead-writer-"));
    await initializeNoesisConfig(home);
    await writeFile(
      `${noesisConfigPath(home)}.writer.lock`,
      JSON.stringify({ token: "dead", pid: 99_999_999, createdAt: 0 }),
    );
    await updateNoesisConfig(home, { thinkingLevel: "low" });
    expect((await resolveNoesisConfig({ home, env: {} })).agent.thinkingLevel).toBe("low");
  });
});
