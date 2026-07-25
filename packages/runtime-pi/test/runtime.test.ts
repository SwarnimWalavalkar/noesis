import { frozenTurnPlanDigest, type FrozenTurnPlan, type FrozenRevisionMaterial } from "@noesis/agent-types";
import { sha256, type FileRevisionRef } from "@noesis/domain";
import type { SessionToolDefinition, SessionToolName } from "@noesis/intelligence";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  createAssistantDeltaAggregator,
  createPiAgentRuntime,
  frozenPlanMaterialUses,
} from "../src/index.ts";
import {
  CONTROLLED_PI_MODEL,
  CONTROLLED_PI_PROVIDER,
  createControlledPiModels,
} from "./support/controlled-pi-models.ts";

const sessionToolNames = [
  "search_sessions",
  "open_session_evidence",
  "find_corrections",
  "find_similar_tasks",
  "prior_experiment_outcomes",
] as const satisfies readonly SessionToolName[];

function material(revisionId: string, workingPath: string, content: string): FrozenRevisionMaterial {
  const revision: FileRevisionRef = Object.freeze({
    kind: "file_revision",
    revisionId,
    workingPath,
    snapshotPath: `.noesis/revisions/${revisionId}`,
    contentDigest: sha256(content),
  });
  return Object.freeze({ revision, content });
}

function frozenPlan(): FrozenTurnPlan {
  const prompt = material("prompt-v1", "prompts/grounded.md", "Use exact session evidence.");
  const skill = material("skill-v1", "skills/grounded.md", "Search before answering.");
  const router = material(
    "router-v1",
    "capabilities/grounded-router.json",
    JSON.stringify({ strategyId: "session-search.fts-only.v1" }),
  );
  const unsigned: Omit<FrozenTurnPlan, "canonicalDigest"> = Object.freeze({
    schemaVersion: 1,
    planId: "plan-runtime-tools",
    sessionId: "trail-runtime-tools",
    turnId: "turn-runtime-tools",
    activationId: "activation-runtime-tools",
    activationRevision: 1,
    selectedCapabilities: Object.freeze([
      Object.freeze({
        capabilityId: "grounded",
        name: "Grounded",
        scope: "general",
        selectionReason: "controlled runtime test",
        revision: Object.freeze({
          kind: "capability_revision",
          capabilityId: "grounded",
          capabilityRevisionId: "grounded-v1",
          bundleDigest: sha256("grounded-v1"),
        }),
        baseline: Object.freeze({ kind: "genesis" as const }),
        promptModules: Object.freeze([prompt]),
        skills: Object.freeze([skill]),
        tools: Object.freeze([]),
        router,
        permissionManifest: Object.freeze({
          effects: Object.freeze([]),
          resourcePatterns: Object.freeze([]),
          credentialRefs: Object.freeze([]),
        }),
      }),
    ]),
    renderedSystemPrompt: `Noesis protected kernel.\n\n${prompt.content}`,
    provider: CONTROLLED_PI_PROVIDER,
    model: CONTROLLED_PI_MODEL,
    thinkingLevel: "off",
    permissionSnapshot: Object.freeze({
      effects: Object.freeze([]),
      resourcePatterns: Object.freeze([]),
      credentialRefs: Object.freeze([]),
    }),
    retrievalCitations: Object.freeze([]),
    routing: Object.freeze({
      strategyId: "session-search.fts-only.v1",
      reason: "Exact frozen router selected session search",
    }),
    createdAt: "2026-07-25T00:00:00.000Z",
  });
  return Object.freeze({ ...unsigned, canonicalDigest: frozenTurnPlanDigest(unsigned) });
}

function definitions(marker: string): readonly SessionToolDefinition[] {
  return sessionToolNames.map((name) =>
    Object.freeze({
      name,
      label: name,
      description: `Frozen runtime test ${name}`,
      inputSchema: z.strictObject({ query: z.string().min(1) }),
      execute: async () =>
        Object.freeze({
          ok: true as const,
          value: Object.freeze({ fragments: Object.freeze([{ content: marker }]) }),
        }),
    }),
  );
}

describe("agent runtime factories", () => {
  test("aggregates authoritative Pi text deltas across tool-loop assistant messages", () => {
    const deltas = createAssistantDeltaAggregator();
    deltas.beginMessage();
    expect(deltas.push("I will inspect ")).toBe("I will inspect ");
    expect(deltas.push("the snapshot.")).toBe("the snapshot.");
    deltas.beginMessage(); // tool-call-only assistant message: no text delta
    deltas.beginMessage();
    expect(deltas.push("Grounded answer.")).toBe("\n\nGrounded answer.");
    expect(deltas.text()).toBe("I will inspect the snapshot.\n\nGrounded answer.");
  });

  test("fails before model execution when frozen non-prompt material has no exact resolver", async () => {
    const controlled = createControlledPiModels();
    const plan = frozenPlan();
    const runtime = createPiAgentRuntime(process.cwd(), controlled.models);

    await expect(
      runtime.run(
        {
          trailId: plan.sessionId,
          provider: plan.provider,
          model: plan.model,
          thinkingLevel: plan.thinkingLevel,
          systemPrompt: plan.renderedSystemPrompt,
          prompt: "Use session evidence.",
          activeCapabilities: [{ name: "Grounded", version: 1 }],
          frozenTurnPlan: plan,
        },
        () => undefined,
      ),
    ).rejects.toThrow("without a turn-scoped session-tool resolver");
    expect(controlled.provider.state.callCount).toBe(0);
  });

  test("serves behavior through session tools resolved from exact frozen material", async () => {
    const marker = "immutable-session-result-v1";
    const controlled = createControlledPiModels({
      respond: ({ context }) => {
        if (!context.messages.some((message) => message.role === "toolResult"))
          return fauxAssistantMessage(
            fauxToolCall("search_sessions", { query: "immutable evidence" }, { id: "call-search" }),
            { stopReason: "toolUse" },
          );
        const toolContext = JSON.stringify(context.messages);
        return fauxAssistantMessage(
          toolContext.includes(marker) ? `Grounded in ${marker}` : "Session tool result missing",
        );
      },
    });
    const plan = frozenPlan();
    const runtime = createPiAgentRuntime(process.cwd(), controlled.models, {
      sessionTools: {
        resolve: async (received) =>
          Object.freeze({
            planId: received.planId,
            canonicalDigest: received.canonicalDigest,
            consumedMaterials: frozenPlanMaterialUses(received),
            definitions: definitions(marker),
          }),
      },
    });

    const result = await runtime.run(
      {
        trailId: plan.sessionId,
        provider: plan.provider,
        model: plan.model,
        thinkingLevel: plan.thinkingLevel,
        systemPrompt: plan.renderedSystemPrompt,
        prompt: "Use session evidence.",
        activeCapabilities: [{ name: "Grounded", version: 1 }],
        frozenTurnPlan: plan,
      },
      () => undefined,
    );

    expect(result).toMatchObject({ outcome: "completed", text: `Grounded in ${marker}` });
    expect(controlled.provider.state.callCount).toBe(2);
  });

  test("rejects sabotaged immutable bytes and incomplete tool registration before prompting", async () => {
    const controlled = createControlledPiModels();
    const plan = frozenPlan();
    const [selection] = plan.selectedCapabilities;
    if (!selection) throw new Error("Expected frozen capability");
    const sabotagedUnsigned = Object.freeze({
      ...plan,
      selectedCapabilities: Object.freeze([
        Object.freeze({
          ...selection,
          router: Object.freeze({ ...selection.router, content: '{"strategyId":"sabotaged"}' }),
        }),
      ]),
      canonicalDigest: undefined,
    });
    const { canonicalDigest: _ignored, ...unsigned } = sabotagedUnsigned;
    const sabotaged = Object.freeze({
      ...unsigned,
      canonicalDigest: frozenTurnPlanDigest(unsigned),
    }) as FrozenTurnPlan;
    const runtime = createPiAgentRuntime(process.cwd(), controlled.models, {
      sessionTools: {
        resolve: async (received) =>
          Object.freeze({
            planId: received.planId,
            canonicalDigest: received.canonicalDigest,
            consumedMaterials: frozenPlanMaterialUses(received).slice(1),
            definitions: definitions("must-not-run"),
          }),
      },
    });
    const request = {
      trailId: plan.sessionId,
      provider: plan.provider,
      model: plan.model,
      thinkingLevel: plan.thinkingLevel,
      systemPrompt: plan.renderedSystemPrompt,
      prompt: "Use session evidence.",
      activeCapabilities: [{ name: "Grounded", version: 1 }],
      frozenTurnPlan: sabotaged,
    };

    await expect(runtime.run(request, () => undefined)).rejects.toThrow("failed content digest verification");
    expect(controlled.provider.state.callCount).toBe(0);

    await expect(runtime.run({ ...request, frozenTurnPlan: plan }, () => undefined)).rejects.toThrow(
      "left frozen material unsupported",
    );
    expect(controlled.provider.state.callCount).toBe(0);
  });
});
