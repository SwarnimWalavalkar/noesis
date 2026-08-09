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
    expect(resolved.tools.hotbar).toEqual(["files.read", "files.list", "shell.run", "workflows.run"]);
    expect(await readFile(noesisConfigPath(home), "utf8")).toBe(legacy);
  });

  test("defaults workflow execution onto the hotbar without changing explicit persisted choices", async () => {
    const missing = await mkdtemp(join(tmpdir(), "noesis-config-default-hotbar-"));
    const oldPersisted = await mkdtemp(join(tmpdir(), "noesis-config-old-hotbar-"));
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
      noesisConfigPath(explicitlyEmpty),
      JSON.stringify({ schemaVersion: 1, agent: {}, tools: { hotbar: [] } }),
    );

    expect((await resolveNoesisConfig({ home: missing, env: {} })).tools.hotbar).toEqual([
      "files.read",
      "files.list",
      "shell.run",
      "workflows.run",
    ]);
    expect((await resolveNoesisConfig({ home: oldPersisted, env: {} })).tools.hotbar).toEqual([
      "files.read",
      "files.list",
      "shell.run",
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
      tools: { hotbar: ["files.read", "files.list", "shell.run", "workflows.run"] },
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
