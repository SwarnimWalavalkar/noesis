import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noesisConfigPath, resolveNoesisConfig } from "@noesis/config";
import { createPiAgentRoleRunner, createPiAgentRuntime } from "@noesis/runtime-pi";
import type { TuiModelRoute, TuiProviderAuthenticationRequest, TuiProviderAuthStatus } from "@noesis/tui";
import { afterEach, expect, test } from "vitest";
import { createApplicationRuntimeComposition } from "../src/runtime-composition.ts";
import {
  CONTROLLED_PI_MODEL,
  CONTROLLED_PI_PROVIDER,
  controlledToolCallResponse,
  createControlledPiModels,
} from "../../../packages/runtime-pi/test/support/controlled-pi-models.ts";
import { researchLoopControlledResponse } from "./support/research-loop-controlled-response.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const route = (provider: string, model: string, thinkingLevels: TuiModelRoute["thinkingLevels"]) =>
  Object.freeze({
    provider,
    providerName: provider === CONTROLLED_PI_PROVIDER ? "Controlled" : "Other Provider",
    model,
    name: model,
    thinkingLevels,
    default: true,
    allowsCustomModelIds: false,
  });

test("Pi codemode inspects and updates configuration and signs in through the elicitation bridge", async () => {
  const home = await mkdtemp(join(tmpdir(), "noesis-agent-configuration-"));
  roots.push(home);
  const signedIn = new Set<string>([CONTROLLED_PI_PROVIDER]);
  const signInRequests: TuiProviderAuthenticationRequest[] = [];
  const source = `
    const before = await tools.config.inspect({});
    const providers = await tools.providers.list({});
    let misnamed = null;
    try {
      await tools.config.update({ agent: { thinking: "high" } });
    } catch (error) {
      misnamed = String(error?.message ?? error);
    }
    let rejected = null;
    try {
      await tools.config.update({ agents: { provider: "other-provider", model: "missing-model" } });
    } catch (error) {
      rejected = String(error?.message ?? error);
    }
    const updated = await tools.config.update({
      agents: { provider: "other-provider", model: "other-model", thinkingLevel: "low" },
      context: { tokenBudget: 64000 },
    });
    const authenticated = await tools.providers.authenticate({ provider: "other-provider" });
    return { before, providers, misnamed, rejected, updated, authenticated };
  `;
  const controlled = createControlledPiModels({
    respond: (input) => {
      if (input.systemPrompt.includes("role:")) return researchLoopControlledResponse(input);
      if (input.lastUserText.includes("Confirm")) return "Confirmed.";
      if (!input.context.messages.some((message) => message.role === "toolResult"))
        return controlledToolCallResponse("execute", { source }, "configure-noesis");
      return "Configuration updated.";
    },
  });
  const config = await resolveNoesisConfig({
    home,
    env: {},
    cli: { provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL },
  });
  const status = async (provider: string): Promise<TuiProviderAuthStatus> => ({
    provider,
    configured: signedIn.has(provider),
    source: signedIn.has(provider) ? "stored-api-key" : "none",
  });
  const runtime = await createApplicationRuntimeComposition({
    config,
    listModelRoutes: () => [
      route(CONTROLLED_PI_PROVIDER, CONTROLLED_PI_MODEL, ["off", "high"]),
      route("other-provider", "other-model", ["low", "high"]),
    ],
    providerAuthStatus: status,
    authenticateProvider: async (provider) => await status(provider),
    interactions: {
      authenticateProvider: async (request) => {
        signInRequests.push(request);
        signedIn.add(request.providerId);
        return { action: "accept" };
      },
    },
    createAgent: (_, codeExecution) => createPiAgentRuntime(home, controlled.models, { codeExecution }),
    createRoleRunner: (configurations) => createPiAgentRoleRunner(home, controlled.models, configurations),
  });
  try {
    const trail = await runtime.startTrail({ title: "Configure Noesis" });
    const first = await runtime.debug.runTurn(
      trail.trailId,
      "Route subagents to other-model with low reasoning and lower the context budget.",
    );
    const calls = await runtime.debug.workspace.operational.toolCalls.listForSession(trail.trailId);
    expect(
      calls
        .filter((call) => call.toolName.startsWith("config.") || call.toolName.startsWith("providers."))
        .map((call) => [call.toolName, call.status]),
    ).toEqual([
      ["config.inspect", "completed"],
      ["providers.list", "completed"],
      ["config.update", "failed"],
      ["config.update", "completed"],
      ["providers.authenticate", "completed"],
    ]);
    expect(calls.find((call) => call.toolName === "config.inspect")?.response).toMatchObject({
      output: {
        home,
        stored: null,
        effective: {
          agent: { provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL },
          agents: { provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL },
        },
        sources: {
          agent: { provider: "cli", model: "cli", thinkingLevel: "default" },
          agents: { provider: "foreground", model: "foreground", thinkingLevel: "foreground" },
        },
      },
    });
    expect(calls.find((call) => call.toolName === "providers.list")?.response).toEqual({
      output: {
        providers: [
          {
            provider: CONTROLLED_PI_PROVIDER,
            name: "Controlled",
            authentication: {
              provider: CONTROLLED_PI_PROVIDER,
              configured: true,
              source: "stored-api-key",
              expired: null,
            },
            models: 1,
            defaultModel: CONTROLLED_PI_MODEL,
          },
          {
            provider: "other-provider",
            name: "Other Provider",
            authentication: { provider: "other-provider", configured: false, source: "none", expired: null },
            models: 1,
            defaultModel: "other-model",
          },
        ],
      },
    });
    const program = JSON.stringify(calls.find((call) => call.toolName === "execute")?.response);
    expect(program).toContain("Unrecognized key");
    expect(program).toContain(
      "Expected input: { agent?: { provider?: string | null; model?: string | null; thinkingLevel?:",
    );
    expect(JSON.stringify(calls.find((call) => call.status === "failed")?.response)).toContain(
      "missing-model is not offered by other-provider",
    );
    const updates = calls.filter((call) => call.toolName === "config.update" && call.status === "completed");
    expect(updates[0]?.response).toMatchObject({
      output: {
        overridden: [],
        effective: { context: { tokenBudget: 64000 } },
        providers: [{ provider: "other-provider", authentication: { configured: false } }],
      },
    });
    expect(calls.find((call) => call.toolName === "providers.authenticate")?.response).toMatchObject({
      output: { provider: "other-provider", authentication: { configured: true } },
    });
    expect(signInRequests).toEqual([
      expect.objectContaining({ providerId: "other-provider", providerName: "Other Provider" }),
    ]);
    expect(JSON.parse(await readFile(noesisConfigPath(home), "utf8"))).toEqual({
      schemaVersion: 1,
      agent: {},
      agents: { provider: "other-provider", model: "other-model", thinkingLevel: "low" },
      context: { tokenBudget: 64000 },
    });

    const second = await runtime.debug.runTurn(trail.trailId, "Confirm the new settings.");
    expect(first.frozenTurnPlan?.subAgentDefaults).toMatchObject({
      provider: CONTROLLED_PI_PROVIDER,
      model: CONTROLLED_PI_MODEL,
    });
    expect(second.frozenTurnPlan?.subAgentDefaults).toMatchObject({
      provider: "other-provider",
      model: "other-model",
      thinkingLevel: "low",
    });
    expect(second.frozenTurnPlan?.requestTokenBudget).toBeLessThan(
      first.frozenTurnPlan?.requestTokenBudget ?? 0,
    );
  } finally {
    await runtime.shutdown();
  }
}, 30000);
