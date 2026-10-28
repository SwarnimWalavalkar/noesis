import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  initializeNoesisConfig,
  noesisConfigPath,
  readNoesisConfig,
  reloadNoesisConfig,
  resolveNoesisConfig,
  updateNoesisConfig,
} from "../src/index.ts";

function updateFromSeparateProcess(
  home: string,
  patch: Readonly<Record<string, Readonly<Record<string, string>>>>,
): Promise<void> {
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

  test("subagent defaults inherit the resolved foreground route and allow explicit overrides", async () => {
    const inheritedHome = await mkdtemp(join(tmpdir(), "noesis-config-agents-inherited-"));
    const configuredHome = await mkdtemp(join(tmpdir(), "noesis-config-agents-explicit-"));
    await writeFile(
      noesisConfigPath(configuredHome),
      JSON.stringify({
        schemaVersion: 1,
        agent: { provider: "foreground-provider", model: "foreground-model", thinkingLevel: "high" },
        agents: { model: "subagent-model", thinkingLevel: "low" },
      }),
    );

    const inherited = await resolveNoesisConfig({
      home: inheritedHome,
      env: { NOESIS_PROVIDER: "env-provider", NOESIS_MODEL: "env-model" },
    });
    const configured = await resolveNoesisConfig({ home: configuredHome, env: {} });

    expect(inherited.agents).toEqual(inherited.agent);
    expect(inherited.agentsSources).toEqual({
      provider: "foreground",
      model: "foreground",
      thinkingLevel: "foreground",
    });
    expect(configured.agents).toEqual({
      provider: "foreground-provider",
      model: "subagent-model",
      thinkingLevel: "low",
    });
    expect(configured.agentsSources).toEqual({
      provider: "foreground",
      model: "configured",
      thinkingLevel: "configured",
    });
  });

  test.each(["off", "low"])("preserves the explicit %s thinking level", async (thinkingLevel) => {
    const home = await mkdtemp(join(tmpdir(), "noesis-config-level-"));
    await writeFile(noesisConfigPath(home), JSON.stringify({ schemaVersion: 1, agent: { thinkingLevel } }));
    expect((await resolveNoesisConfig({ home, env: {} })).agent.thinkingLevel).toBe(thinkingLevel);
  });

  test("uses a 160k context budget by default and accepts an explicit token budget", async () => {
    const defaultsHome = await mkdtemp(join(tmpdir(), "noesis-config-context-default-"));
    const configuredHome = await mkdtemp(join(tmpdir(), "noesis-config-context-explicit-"));
    await writeFile(
      noesisConfigPath(configuredHome),
      JSON.stringify({ schemaVersion: 1, agent: {}, context: { tokenBudget: 96_000 } }),
    );

    expect((await resolveNoesisConfig({ home: defaultsHome, env: {} })).context).toEqual({
      tokenBudget: 160_000,
      autoCompact: true,
    });
    expect((await resolveNoesisConfig({ home: configuredHome, env: {} })).context).toEqual({
      tokenBudget: 96_000,
      autoCompact: true,
    });
  });

  test("persists automatic compaction independently of the token budget", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-config-auto-compact-"));
    await initializeNoesisConfig(home);
    await updateNoesisConfig(home, { context: { autoCompact: false } });
    await updateNoesisConfig(home, { context: { tokenBudget: 96_000 } });
    expect((await resolveNoesisConfig({ home, env: {} })).context).toEqual({
      tokenBudget: 96_000,
      autoCompact: false,
    });
    await updateNoesisConfig(home, { context: { autoCompact: true } });
    expect((await resolveNoesisConfig({ home, env: {} })).context.autoCompact).toBe(true);
  });

  test.each(["false", 0, null])("rejects a non-boolean autoCompact value %j", async (autoCompact) => {
    const home = await mkdtemp(join(tmpdir(), "noesis-config-invalid-auto-compact-"));
    await writeFile(
      noesisConfigPath(home),
      JSON.stringify({ schemaVersion: 1, agent: {}, context: { autoCompact } }),
    );
    await expect(resolveNoesisConfig({ home, env: {} })).rejects.toThrow("/context/autoCompact");
  });

  test("loads files with retired sections and drops them on the next write", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-config-retired-"));
    await writeFile(
      noesisConfigPath(home),
      JSON.stringify({
        schemaVersion: 1,
        agent: { model: "keep-model" },
        learning: { enabled: false, notifications: "off", backgroundBudget: 0 },
        autonomy: { riskLevel: "off" },
        experiments: { maxCases: 2, maxCost: 0 },
      }),
    );

    expect((await resolveNoesisConfig({ home, env: {} })).agent.model).toBe("keep-model");
    await updateNoesisConfig(home, { context: { tokenBudget: 64_000 } });

    expect(JSON.parse(await readFile(noesisConfigPath(home), "utf8"))).toEqual({
      schemaVersion: 1,
      agent: { model: "keep-model" },
      context: { tokenBudget: 64_000 },
    });
  });

  test("clears fields with null so defaults and foreground inheritance apply", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-config-clear-"));
    await writeFile(
      noesisConfigPath(home),
      JSON.stringify({
        schemaVersion: 1,
        agent: { model: "file-model", thinkingLevel: "low" },
        agents: { model: "subagent-model" },
        context: { tokenBudget: 64_000 },
      }),
    );

    await updateNoesisConfig(home, {
      agent: { thinkingLevel: null },
      agents: { model: null, thinkingLevel: "minimal" },
      context: { tokenBudget: null },
    });
    const resolved = await resolveNoesisConfig({ home, env: {} });

    expect(JSON.parse(await readFile(noesisConfigPath(home), "utf8"))).toEqual({
      schemaVersion: 1,
      agent: { model: "file-model" },
      agents: { thinkingLevel: "minimal" },
    });
    expect(resolved.agent.thinkingLevel).toBe("high");
    expect(resolved.agents.model).toBe("file-model");
    expect(resolved.agentsSources.model).toBe("foreground");
    expect(resolved.context.tokenBudget).toBe(160_000);
  });

  test("rejects empty or invalid updates without writing", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-config-invalid-update-"));
    await initializeNoesisConfig(home);
    const before = await readFile(noesisConfigPath(home), "utf8");

    await expect(updateNoesisConfig(home, {})).rejects.toThrow("requires at least one");
    await expect(updateNoesisConfig(home, { agent: { thinkingLevel: "extreme" } })).rejects.toThrow(
      "/agent/thinkingLevel",
    );
    await expect(updateNoesisConfig(home, { context: { tokenBudget: -1 } })).rejects.toThrow(
      "/context/tokenBudget",
    );
    await expect(updateNoesisConfig(home, { learning: { enabled: false } })).rejects.toThrow(
      "invalid config update",
    );
    expect(await readFile(noesisConfigPath(home), "utf8")).toBe(before);
  });

  test("reloading keeps command-line and environment overrides", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-config-reload-"));
    await initializeNoesisConfig(home);
    const started = await resolveNoesisConfig({
      home,
      env: { NOESIS_PROVIDER: "env-provider" },
      cli: { model: "cli-model" },
    });

    await updateNoesisConfig(home, {
      agent: { provider: "file-provider", model: "file-model", thinkingLevel: "low" },
    });
    const reloaded = await reloadNoesisConfig(started);

    expect(reloaded.agent).toEqual({ provider: "env-provider", model: "cli-model", thinkingLevel: "low" });
    expect(reloaded.sources).toEqual({ provider: "environment", model: "cli", thinkingLevel: "config" });
  });

  test("rejects unsupported versions and unknown fields with actionable errors", async () => {
    const unsupported = await mkdtemp(join(tmpdir(), "noesis-config-version-"));
    await writeFile(noesisConfigPath(unsupported), JSON.stringify({ schemaVersion: 2, agent: {} }));
    const versionResult = await readNoesisConfig(unsupported);
    expect(versionResult.ok).toBe(false);
    if (!versionResult.ok) {
      expect(versionResult.error.message).toContain("accepts only schemaVersion 1");
      expect(versionResult.error.message).toContain("rerun onboarding to regenerate it");
    }

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
    if (!nestedUnknownResult.ok)
      expect(nestedUnknownResult.error.message).toMatch(/\/agent\/(runtime|credential)/u);
  });

  test("initialization refuses to overwrite and updates only through an explicit operation", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-config-write-"));
    await initializeNoesisConfig(home);
    await expect(initializeNoesisConfig(home)).rejects.toThrow("refusing to overwrite");
    await updateNoesisConfig(home, { agent: { provider: "openai-codex", model: "gpt-5.5" } });
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const persisted = JSON.parse(await readFile(noesisConfigPath(home), "utf8")) as unknown;
    expect(persisted).toEqual({
      schemaVersion: 1,
      agent: {
        provider: "openai-codex",
        model: "gpt-5.5",
        thinkingLevel: "high",
      },
      context: { tokenBudget: 160_000, autoCompact: true },
    });
  });

  test("serializes independent writers without losing either patch", async () => {
    for (let pair = 0; pair < 100; pair += 1) {
      const home = await mkdtemp(join(tmpdir(), "noesis-config-writers-"));
      await initializeNoesisConfig(home);
      await Promise.all([
        updateNoesisConfig(home, { agent: { provider: `provider-${pair}` } }),
        updateNoesisConfig(home, { agent: { model: `model-${pair}` } }),
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
        updateFromSeparateProcess(home, { agent: { provider: `process-provider-${pair}` } }),
        updateFromSeparateProcess(home, { agent: { model: `process-model-${pair}` } }),
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
    await updateNoesisConfig(home, { agent: { thinkingLevel: "low" } });
    expect((await resolveNoesisConfig({ home, env: {} })).agent.thinkingLevel).toBe("low");
  });
});
