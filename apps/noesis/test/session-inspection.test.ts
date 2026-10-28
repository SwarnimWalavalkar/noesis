import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeNoesisConfig, resolveNoesisConfig } from "@noesis/config";
import { createPiAgentRoleRunner, createPiAgentRuntime } from "@noesis/runtime-pi";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
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

test("Pi codemode inspects the running session route, context, compaction, and permissions", async () => {
  const home = await mkdtemp(join(tmpdir(), "noesis-session-inspection-"));
  roots.push(home);
  await initializeNoesisConfig(home, {
    schemaVersion: 1,
    agent: { provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL, thinkingLevel: "high" },
    context: { tokenBudget: 50_000, autoCompact: false },
  });
  const largeInput = "user-history-".repeat(5_000);
  const controlled = createControlledPiModels({
    respond: (input) => {
      if (input.systemPrompt.includes("role: session_compactor"))
        return JSON.stringify({ notes: [{ kind: "fact", text: "Continuity marker." }] });
      if (input.systemPrompt.startsWith("Noesis protected role:"))
        return '{"observation":{"kind":"other","reason":"No learning."},"decision":"no_change","reason":"No change."}';
      if (input.lastUserText === largeInput) return "assistant-history-".repeat(6_000);
      if (!input.context.messages.some((message) => message.role === "toolResult"))
        return controlledToolCallResponse(
          "execute",
          { source: "return await tools.session.inspect({});" },
          "inspect-session",
        );
      return "Inspected.";
    },
  });
  const runtime = await createApplicationRuntimeComposition({
    config: await resolveNoesisConfig({ home, env: {} }),
    resolveModelContext: () => ({ contextWindow: 200_000, maxOutputTokens: 1_000 }),
    createAgent: (_, codeExecution) => createPiAgentRuntime(home, controlled.models, { codeExecution }),
    createRoleRunner: (configurations) => createPiAgentRoleRunner(home, controlled.models, configurations),
  });
  try {
    // Turns run at the session's own reasoning level without the caller passing it again.
    const trail = await runtime.startTrail({ title: "Inspect me", thinkingLevel: "off" });
    await runtime.debug.runTurn(trail.trailId, largeInput);
    await runtime.compact(trail.trailId);
    const turn = await runtime.debug.runTurn(
      trail.trailId,
      "Which model are you on and how full is your context?",
    );
    expect(turn.output).toBe("Inspected.");

    const calls = await runtime.debug.workspace.operational.toolCalls.listForSession(trail.trailId);
    const inspected = calls.find((call) => call.toolName === "session.inspect");
    expect(inspected?.status).toBe("completed");
    expect(inspected?.response).toMatchObject({
      output: {
        session: { sessionId: trail.trailId, title: "Inspect me", completedTurns: 1 },
        route: {
          provider: CONTROLLED_PI_PROVIDER,
          model: CONTROLLED_PI_MODEL,
          thinkingLevel: "off",
          default: { thinkingLevel: "high" },
          differsFromDefault: ["thinkingLevel"],
        },
        context: {
          source: "request",
          contextWindow: 200_000,
          autoCompact: false,
          historyBudget: turn.frozenTurnPlan?.contextTokenBudget,
        },
        compaction: {
          checkpoints: 1,
          notesInContext: 1,
          omittedNotes: 0,
          history: [{ kind: "note_delta", provider: CONTROLLED_PI_PROVIDER }],
        },
        permissions: { resourcePatterns: expect.arrayContaining(["session:*"]) },
      },
    });
    const { output } = z
      .object({
        output: z.object({
          context: z.object({ usedTokens: z.number(), components: z.array(z.object({ label: z.string() })) }),
          compaction: z.object({ history: z.array(z.object({ messagesCovered: z.number() })) }),
        }),
      })
      .parse(inspected?.response);
    expect(output.context.usedTokens).toBeGreaterThan(0);
    expect(output.context.components.map((component) => component.label)).toContain("Tools");
    expect(output.compaction.history[0]?.messagesCovered).toBeGreaterThan(0);
  } finally {
    await runtime.shutdown();
  }
}, 30000);

test("Pi codemode changes the session's reasoning level and title, effective from the next turn", async () => {
  const home = await mkdtemp(join(tmpdir(), "noesis-session-update-"));
  roots.push(home);
  await initializeNoesisConfig(home, {
    schemaVersion: 1,
    agent: { provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL, thinkingLevel: "high" },
  });
  const source = `
    let unsupported = null;
    try {
      await tools.session.update({ thinkingLevel: "low" });
    } catch (error) {
      unsupported = String(error?.message ?? error);
    }
    const updated = await tools.session.update({ thinkingLevel: "off", title: "Session control" });
    const inspected = await tools.session.inspect({});
    return { unsupported, updated, route: inspected.route, title: inspected.session.title };
  `;
  const controlled = createControlledPiModels({
    respond: (input) => {
      if (input.systemPrompt.startsWith("Noesis protected role:"))
        return '{"observation":{"kind":"other","reason":"No learning."},"decision":"no_change","reason":"No change."}';
      if (input.lastUserText.includes("Again")) return "Done.";
      if (!input.context.messages.some((message) => message.role === "toolResult"))
        return controlledToolCallResponse("execute", { source }, "update-session");
      return "Updated.";
    },
  });
  const runtime = await createApplicationRuntimeComposition({
    config: await resolveNoesisConfig({ home, env: {} }),
    listModelRoutes: () => [
      {
        provider: CONTROLLED_PI_PROVIDER,
        providerName: "Controlled",
        model: CONTROLLED_PI_MODEL,
        name: CONTROLLED_PI_MODEL,
        thinkingLevels: ["off", "high"],
        default: true,
        allowsCustomModelIds: false,
      },
    ],
    createAgent: (_, codeExecution) => createPiAgentRuntime(home, controlled.models, { codeExecution }),
    createRoleRunner: (configurations) => createPiAgentRoleRunner(home, controlled.models, configurations),
  });
  try {
    const trail = await runtime.startTrail({ title: "controlled/model" });
    const first = await runtime.debug.runTurn(trail.trailId, "Use off reasoning and name this session.");
    expect(first.frozenTurnPlan?.thinkingLevel).toBe("high");
    const calls = await runtime.debug.workspace.operational.toolCalls.listForSession(trail.trailId);
    const program = calls.find((call) => call.toolName === "execute");
    expect(JSON.stringify(program?.response)).toContain("does not support reasoning level low");
    expect(
      calls.find((call) => call.toolName === "session.update" && call.status === "completed")?.response,
    ).toEqual({
      output: {
        sessionId: trail.trailId,
        previous: { title: "controlled/model", thinkingLevel: "high" },
        current: { title: "Session control", thinkingLevel: "off" },
        appliesWhen:
          "The reasoning level applies from the next turn; this turn keeps high. The title applies now.",
      },
    });
    expect(calls.find((call) => call.toolName === "session.inspect")?.response).toMatchObject({
      output: {
        session: { title: "Session control" },
        route: { thinkingLevel: "high", nextTurnThinkingLevel: "off" },
      },
    });
    // Settlement keeps the changes made during the turn.
    expect(runtime.getTrail(trail.trailId)).toMatchObject({ title: "Session control", thinkingLevel: "off" });
    expect((await runtime.debug.workspace.operational.sessions.get(trail.trailId))?.title).toBe(
      "Session control",
    );
    const second = await runtime.debug.runTurn(trail.trailId, "Again.");
    expect(second.frozenTurnPlan?.thinkingLevel).toBe("off");
  } finally {
    await runtime.shutdown();
  }
}, 30000);
