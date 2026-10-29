import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeNoesisConfig, resolveNoesisConfig } from "@noesis/config";
import { createPiAgentRoleRunner, createPiAgentRuntime } from "@noesis/runtime-pi";
import { afterEach, expect, test, vi } from "vitest";
import { createApplicationRuntimeComposition } from "../src/runtime-composition.ts";
import {
  CONTROLLED_PI_MODEL,
  CONTROLLED_PI_PROVIDER,
  controlledToolCallResponse,
  createControlledPiModels,
} from "../../../packages/runtime-pi/test/support/controlled-pi-models.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const NO_LEARNING =
  '{"observation":{"kind":"other","reason":"No learning."},"decision":"no_change","reason":"No change."}';

const titledHome = async (titles: { readonly enabled?: boolean; readonly thinkingLevel?: "low" }) => {
  const home = await mkdtemp(join(tmpdir(), "noesis-session-titles-"));
  roots.push(home);
  await initializeNoesisConfig(home, {
    schemaVersion: 1,
    agent: { provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL, thinkingLevel: "high" },
    titles: { provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL, ...titles },
  });
  return home;
};

test("names a new session from its first message with the configured title model", async () => {
  const home = await titledHome({ thinkingLevel: "low" });
  const titled: string[] = [];
  const controlled = createControlledPiModels({
    respond: (input) => {
      if (input.systemPrompt.includes("role: session_titler")) {
        titled.push(input.lastUserText);
        return '{"title":"Plan the garden beds"}';
      }
      if (input.systemPrompt.startsWith("Noesis protected role:")) return NO_LEARNING;
      return "Here is a layout.";
    },
  });
  const titlerRoutes: unknown[] = [];
  const runtime = await createApplicationRuntimeComposition({
    config: await resolveNoesisConfig({ home, env: {} }),
    createAgent: (codeExecution) => createPiAgentRuntime(home, controlled.models, { codeExecution }),
    createRoleRunner: (configurations) => {
      for (const configuration of configurations)
        if (configuration.role === "session_titler")
          titlerRoutes.push({
            provider: configuration.provider,
            model: configuration.model,
            reasoning: configuration.reasoning,
          });
      return createPiAgentRoleRunner(home, controlled.models, configurations);
    },
  });
  try {
    const trail = await runtime.startTrail({ title: "Noesis session" });
    await runtime.debug.runTurn(trail.trailId, "Help me plan raised garden beds for tomatoes.");
    await vi.waitFor(() => expect(runtime.getTrail(trail.trailId).title).toBe("Plan the garden beds"));
    expect(titlerRoutes.at(-1)).toEqual({
      provider: CONTROLLED_PI_PROVIDER,
      model: CONTROLLED_PI_MODEL,
      reasoning: "low",
    });
    expect(titled.some((text) => text.includes("Help me plan raised garden beds for tomatoes."))).toBe(true);
    expect(runtime.listTrailSummaries().find((summary) => summary.trailId === trail.trailId)).toMatchObject({
      title: "Plan the garden beds",
      titled: true,
    });
    expect((await runtime.debug.workspace.operational.sessions.get(trail.trailId))?.title).toBe(
      "Plan the garden beds",
    );

    // Only the first message names the session.
    const calls = titled.length;
    await runtime.debug.runTurn(trail.trailId, "Now add a watering schedule.");
    expect(titled).toHaveLength(calls);
  } finally {
    await runtime.shutdown();
  }
}, 30000);

test("keeps a title set during the first turn instead of the generated one", async () => {
  const home = await titledHome({});
  let releaseTitler: () => void = () => undefined;
  const titlerGate = new Promise<void>((resolve) => {
    releaseTitler = resolve;
  });
  let titlerAnswered = false;
  const controlled = createControlledPiModels({
    respond: async (input) => {
      if (input.systemPrompt.includes("role: session_titler")) {
        await titlerGate;
        titlerAnswered = true;
        return '{"title":"Generated title"}';
      }
      if (input.systemPrompt.startsWith("Noesis protected role:")) return NO_LEARNING;
      if (!input.context.messages.some((message) => message.role === "toolResult"))
        return controlledToolCallResponse(
          "execute",
          { source: 'return await tools.session.update({ title: "Chosen title" });' },
          "rename",
        );
      return "Renamed.";
    },
  });
  const runtime = await createApplicationRuntimeComposition({
    config: await resolveNoesisConfig({ home, env: {} }),
    createAgent: (codeExecution) => createPiAgentRuntime(home, controlled.models, { codeExecution }),
    createRoleRunner: (configurations) => createPiAgentRoleRunner(home, controlled.models, configurations),
  });
  try {
    const trail = await runtime.startTrail({ title: "Noesis session" });
    await runtime.debug.runTurn(trail.trailId, "Call this session Chosen title.");
    expect(runtime.getTrail(trail.trailId).title).toBe("Chosen title");
    releaseTitler();
    await vi.waitFor(() => expect(titlerAnswered).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(runtime.getTrail(trail.trailId)).toMatchObject({ title: "Chosen title", titled: true });
  } finally {
    await runtime.shutdown();
  }
}, 30000);

test("does not call a title model when titles are disabled", async () => {
  const home = await titledHome({ enabled: false });
  let titlerCalls = 0;
  const controlled = createControlledPiModels({
    respond: (input) => {
      if (input.systemPrompt.includes("role: session_titler")) titlerCalls += 1;
      if (input.systemPrompt.startsWith("Noesis protected role:")) return NO_LEARNING;
      return "Done.";
    },
  });
  const runtime = await createApplicationRuntimeComposition({
    config: await resolveNoesisConfig({ home, env: {} }),
    createAgent: (codeExecution) => createPiAgentRuntime(home, controlled.models, { codeExecution }),
    createRoleRunner: (configurations) => createPiAgentRoleRunner(home, controlled.models, configurations),
  });
  try {
    const trail = await runtime.startTrail({ title: "Noesis session" });
    await runtime.debug.runTurn(trail.trailId, "Hello.");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(titlerCalls).toBe(0);
    expect(runtime.getTrail(trail.trailId)).toMatchObject({ title: "Noesis session" });
    expect(runtime.getTrail(trail.trailId).titled).toBeUndefined();
  } finally {
    await runtime.shutdown();
  }
}, 30000);
