import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { resolveNoesisConfig } from "@noesis/config";
import { createPiAgentRuntime, createPiAgentRoleRunner, createPiSkillLibrary } from "@noesis/runtime-pi";
import { createApplicationRuntimeComposition } from "../src/runtime-composition.ts";
import {
  CONTROLLED_PI_MODEL,
  CONTROLLED_PI_PROVIDER,
  createControlledPiModels,
} from "../../../packages/runtime-pi/test/support/controlled-pi-models.ts";

test("inspects startup context and the actual Pi request without invoking a model for inspection", async () => {
  const home = await mkdtemp(join(tmpdir(), "noesis-context-inspection-"));
  let requests = 0;
  let providerSystem = "";
  let providerTools = "";
  let inputCacheCleared = false;
  let inspectDuringRequest: (() => Promise<void>) | undefined;
  const controlled = createControlledPiModels({
    respond: async (prompt) => {
      if (prompt.systemPrompt.startsWith("Noesis protected role:"))
        return '{"observation":{"kind":"other","reason":"No learning."},"decision":"no_change","reason":"No change."}';
      requests += 1;
      providerSystem = prompt.systemPrompt;
      providerTools = JSON.stringify(prompt.context.tools ?? []);
      await inspectDuringRequest?.();
      return "Hello from the controlled provider.";
    },
  });
  const config = await resolveNoesisConfig({
    home,
    env: {},
    cli: { provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL },
  });
  const fixtureSkill = join(home, "inspection-fixture.md");
  await writeFile(
    fixtureSkill,
    "---\nname: inspection-fixture\ndescription: Inspect controlled context.\n---\nUse exact evidence.",
    "utf8",
  );
  const skills = createPiSkillLibrary({
    cwd: home,
    agentDirectory: join(home, "agent"),
    workspaceTrusted: true,
    builtInSkills: [
      { name: "inspection-fixture", description: "Inspect controlled context.", filePath: fixtureSkill },
    ],
  });
  const runtime = await createApplicationRuntimeComposition({
    config: { ...config, learning: { ...config.learning, enabled: false } },
    skills,
    resolveModelContext: () => ({ contextWindow: 200000, maxOutputTokens: 1000 }),
    createAgent: (_tools, codeExecution) =>
      createPiAgentRuntime(home, controlled.models, { codeExecution, skills }),
    createRoleRunner: (configurations) => createPiAgentRoleRunner(home, controlled.models, configurations),
  });
  try {
    const inspectContext = runtime.inspectContext;
    if (!inspectContext) throw new Error("Production context inspector is missing");
    const trail = await runtime.startTrail({ title: "Context inspection" });
    const preview = await inspectContext(trail.trailId);
    expect(preview.source).toBe("preview");
    expect(preview.cache).toBeUndefined();
    expect(preview.components[0]?.tokens).toBeGreaterThan(0);
    expect(preview.components.find((part) => part.label === "Skill catalog")?.tokens).toBeGreaterThan(0);
    expect(preview.components.find((part) => part.label === "Skill catalog")?.content).toContain(
      "inspection-fixture",
    );
    const previewTools = preview.components.find((part) => part.label === "Tools");
    expect(previewTools?.tokens).toBeGreaterThan(0);
    expect(previewTools?.tokens).toBeLessThan(4096);
    expect(preview.components.some((part) => part.label.includes("allowance"))).toBe(false);
    expect(requests).toBe(0);
    await runtime.debug.runTurn(trail.trailId, "Say hello.");
    const beforeInspect = requests;
    const captured = await inspectContext(trail.trailId);
    expect(requests).toBe(beforeInspect);
    expect(captured.source).toBe("request");
    expect(captured.cache?.inputTokens).toBeGreaterThan(0);
    expect(captured.cache?.writeTokens).toBeGreaterThan(0);
    expect(captured.cache?.readTokens).toBe(0);
    expect(captured.inputBudget).toBe(160000);
    expect(captured.contextWindow).toBe(200000);
    expect(captured.components.find((part) => part.label === "Tools")?.content).toContain("file_read");
    expect(captured.components.find((part) => part.label === "Tools")).toEqual(previewTools);
    expect(previewTools?.content).toBe(providerTools);
    expect(
      captured.components.find((part) => part.label === "User messages & context notes")?.content,
    ).toContain("Say hello.");
    expect(providerSystem).toContain(captured.components[0]?.content);
    expect(providerSystem).toContain(captured.components[1]?.content.slice(0, 16000));
    inspectDuringRequest = async () => {
      inputCacheCleared = (await inspectContext(trail.trailId)).cache === undefined;
    };
    await runtime.debug.runTurn(trail.trailId, "Say hello again.");
    expect(inputCacheCleared).toBe(true);
    expect((await inspectContext(trail.trailId)).cache?.inputTokens).toBeGreaterThan(0);
    const second = await runtime.startTrail({ title: "Another session" });
    expect((await inspectContext(second.trailId)).source).toBe("preview");
  } finally {
    await runtime.shutdown();
    await rm(home, { recursive: true, force: true });
  }
});
