import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  type AgentRuntimeEvent,
  type FrozenRevisionMaterial,
  type FrozenTurnPlan,
  frozenTurnPlanDigest,
} from "@noesis/agent-types";
import { type FileRevisionRef, sha256 } from "@noesis/domain";
import type { SessionToolDefinition, SessionToolName } from "@noesis/intelligence";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import {
  createAssistantDeltaAggregator,
  createPiAgentRuntime,
  createPiExecuteTool,
  createPiSelfTools,
  type FrozenSessionToolResolver,
  frozenPlanMaterialUses,
  type PreparedPiCodeExecution,
  type PiCodeExecutionAdapter,
  type PiSkillLibrary,
  resolveFrozenSessionToolDefinitions,
  toAgentActionPayload,
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

function controlledCodeExecution(
  resolver: FrozenSessionToolResolver,
  marker: string,
): PiCodeExecutionAdapter {
  const prepare: PiCodeExecutionAdapter["prepare"] = async (plan, signal) => {
    await resolveFrozenSessionToolDefinitions(plan, resolver, signal);
    return Object.freeze({
      catalogId: "catalog-controlled",
      catalogDigest: sha256("catalog-controlled"),
      execute: async () =>
        Object.freeze({
          executionId: "execution-controlled",
          value: Object.freeze({ marker }),
          calls: 1,
          durationMs: 1,
        }),
      close: async () => undefined,
    });
  };
  return Object.freeze({
    prepare,
    shutdown: async () => undefined,
  });
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

  test("rejects already-cancelled and oversized execute requests before preparation", async () => {
    let executions = 0;
    const turn = new AbortController();
    turn.abort("cancelled");
    const execute = createPiExecuteTool({
      prepared: {
        catalogId: "catalog",
        catalogDigest: sha256("catalog"),
        execute: async () => {
          executions += 1;
          return {
            executionId: "must-not-run",
            value: null,
            calls: 0,
            durationMs: 0,
          };
        },
        close: async () => undefined,
      },
      signal: turn.signal,
      emit: () => undefined,
    });

    await expect(execute.execute("cancelled", { source: "return null;" })).rejects.toThrow(
      "cancelled before start",
    );
    expect(executions).toBe(0);

    const active = new AbortController();
    const byteBounded = createPiExecuteTool({
      prepared: {
        catalogId: "catalog",
        catalogDigest: sha256("catalog"),
        execute: async () => {
          executions += 1;
          return {
            executionId: "must-not-run",
            value: null,
            calls: 0,
            durationMs: 0,
          };
        },
        close: async () => undefined,
      },
      signal: active.signal,
      emit: () => undefined,
    });
    await expect(byteBounded.execute("oversized", { source: "😀".repeat(40_000) })).rejects.toThrow(
      "UTF-8 bytes",
    );
    expect(byteBounded.description).toContain("noesis.invoke");
    expect(byteBounded.description).toContain("emit(value)");
    expect(byteBounded.description).toContain("store(key, value)");
    expect(executions).toBe(0);
  });

  test("bounds arbitrary action payloads without leaking runtime-specific values", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const shared = Object.freeze({ value: "shared" });
    const payload = toAgentActionPayload({
      cyclic,
      first: shared,
      second: shared,
      missing: undefined,
      failure: new Error("controlled"),
    });
    const serialized = JSON.stringify(payload);
    const bounded = JSON.stringify(toAgentActionPayload({ large: "x".repeat(500_000) }));

    expect(new TextEncoder().encode(bounded).byteLength).toBeLessThanOrEqual(256 * 1024);
    expect(bounded).toContain("truncated");
    expect(serialized).toContain("controlled");
    expect(serialized).toContain("[circular]");
    expect(payload).toMatchObject({
      first: { value: "shared" },
      second: { value: "shared" },
    });
  });

  test("propagates cancellation and bounds direct self-tool results", async () => {
    const plan = frozenPlan();
    const turn = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const tools = createPiSelfTools({
      plan,
      request: {
        trailId: plan.sessionId,
        provider: plan.provider,
        model: plan.model,
        thinkingLevel: plan.thinkingLevel,
        systemPrompt: plan.renderedSystemPrompt,
        prompt: "Inspect.",
        activeCapabilities: [],
        frozenTurnPlan: plan,
      },
      signal: turn.signal,
      adapter: {
        inspect: async ({ signal }) => {
          observedSignal = signal;
          return "x".repeat(70_000);
        },
        remember: async ({ signal }) => {
          observedSignal = signal;
          return null;
        },
        adapt: async () => null,
      },
    });
    const inspect = tools.find((tool) => tool.name === "inspect_self");
    const remember = tools.find((tool) => tool.name === "remember");
    if (!inspect || !remember) throw new Error("Expected direct self tools");

    await expect(inspect.execute("inspect", {})).rejects.toThrow("result exceeds");
    expect(observedSignal).toBeDefined();

    const toolCall = new AbortController();
    toolCall.abort("cancelled");
    await expect(
      remember.execute("remember", { memory: "m", scope: "turn", anticipatedUse: "later" }, toolCall.signal),
    ).rejects.toThrow("cancelled before execution");
  });

  test("checks authentication before loading skills or preparing codemode", async () => {
    const controlled = createControlledPiModels();
    const plan = frozenPlan();
    const auth = vi.spyOn(controlled.models, "getAuth").mockResolvedValue(undefined);
    let snapshots = 0;
    let preparations = 0;
    const emptySnapshot = Object.freeze({
      skills: Object.freeze([]),
      diagnostics: Object.freeze([]),
    });
    const skills: PiSkillLibrary = {
      snapshot: async () => {
        snapshots += 1;
        return emptySnapshot;
      },
      pinSnapshot: async () => emptySnapshot,
      claimPinnedSnapshot: () => undefined,
      discardPinnedSnapshot: () => undefined,
      install: async () => undefined,
      remove: async () => false,
      update: async () => undefined,
      configured: () => Object.freeze([]),
    };
    const runtime = createPiAgentRuntime(process.cwd(), controlled.models, {
      skills,
      codeExecution: {
        prepare: async () => {
          preparations += 1;
          throw new Error("must not prepare");
        },
        shutdown: async () => undefined,
      },
    });

    await expect(
      runtime.run(
        {
          trailId: plan.sessionId,
          provider: plan.provider,
          model: plan.model,
          thinkingLevel: plan.thinkingLevel,
          systemPrompt: plan.renderedSystemPrompt,
          prompt: "Do not start.",
          activeCapabilities: [],
          frozenTurnPlan: plan,
        },
        () => undefined,
      ),
    ).rejects.toThrow("credentials are missing");
    expect({ snapshots, preparations }).toEqual({ snapshots: 0, preparations: 0 });
    auth.mockRestore();
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
    ).rejects.toThrow("without a codemode execution adapter");
    expect(controlled.provider.state.callCount).toBe(0);
  });

  test("serves behavior through session tools resolved from exact frozen material", async () => {
    const marker = "immutable-session-result-v1";
    const controlled = createControlledPiModels({
      respond: ({ context }) => {
        if (!context.messages.some((message) => message.role === "toolResult"))
          return fauxAssistantMessage(
            fauxToolCall("execute", { source: "return { grounded: true };" }, { id: "call-execute" }),
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
      codeExecution: controlledCodeExecution(
        {
          resolve: async (received) =>
            Object.freeze({
              planId: received.planId,
              canonicalDigest: received.canonicalDigest,
              consumedMaterials: frozenPlanMaterialUses(received),
              definitions: definitions(marker),
            }),
        },
        marker,
      ),
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

  test("does not let prepared codemode cleanup override a completed turn", async () => {
    const controlled = createControlledPiModels({
      respond: () => fauxAssistantMessage("Completed before cleanup."),
    });
    const plan = frozenPlan();
    let closes = 0;
    const runtime = createPiAgentRuntime(process.cwd(), controlled.models, {
      codeExecution: {
        prepare: async () =>
          Object.freeze({
            catalogId: "catalog-close-failure",
            catalogDigest: sha256("catalog-close-failure"),
            execute: async () =>
              Object.freeze({
                executionId: "unused-execution",
                value: null,
                calls: 0,
                durationMs: 0,
              }),
            close: async () => {
              closes += 1;
              throw new Error("cleanup failed after completion");
            },
          }),
        shutdown: async () => undefined,
      },
    });

    await expect(
      runtime.run(
        {
          trailId: plan.sessionId,
          provider: plan.provider,
          model: plan.model,
          thinkingLevel: plan.thinkingLevel,
          systemPrompt: plan.renderedSystemPrompt,
          prompt: "Complete.",
          activeCapabilities: [],
          frozenTurnPlan: plan,
        },
        () => undefined,
      ),
    ).resolves.toMatchObject({ outcome: "completed", text: "Completed before cleanup." });
    expect(closes).toBe(1);
  });

  test("emits stable top-level and nested action lifecycles with bounded payloads", async () => {
    const controlled = createControlledPiModels({
      respond: ({ context }) => {
        if (!context.messages.some((message) => message.role === "toolResult"))
          return fauxAssistantMessage(
            fauxToolCall(
              "execute",
              { source: "return await tools.shell.run({ command: 'pwd' });" },
              { id: "call-execute-visible" },
            ),
            { stopReason: "toolUse" },
          );
        return fauxAssistantMessage("Done.");
      },
    });
    const plan = frozenPlan();
    const codeExecution: PiCodeExecutionAdapter = Object.freeze({
      prepare: async () => {
        const execute: PreparedPiCodeExecution["execute"] = async (_source, _timeoutMs, _signal, emit) => {
          emit({ type: "progress", value: { message: "Starting shell" } });
          emit({
            type: "tool-start",
            name: "shell.run",
            callIndex: 0,
            input: { command: "pwd" },
          });
          emit({
            type: "tool-end",
            name: "shell.run",
            callIndex: 0,
            ok: true,
            result: { stdout: "/workspace" },
          });
          return Object.freeze({
            executionId: "execution-actions",
            value: { cwd: "/workspace" },
            calls: 1,
            durationMs: 2,
          });
        };
        return Object.freeze({
          catalogId: "catalog-actions",
          catalogDigest: sha256("catalog-actions"),
          execute,
          close: async () => undefined,
        });
      },
      shutdown: async () => undefined,
    });
    const events: AgentRuntimeEvent[] = [];
    const runtime = createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution });

    const result = await runtime.run(
      {
        trailId: plan.sessionId,
        provider: plan.provider,
        model: plan.model,
        thinkingLevel: plan.thinkingLevel,
        systemPrompt: plan.renderedSystemPrompt,
        prompt: "Show the working directory.",
        activeCapabilities: [],
        frozenTurnPlan: plan,
      },
      (event) => events.push(event),
    );

    expect(result).toMatchObject({ outcome: "completed", text: "Done." });
    expect(events).toContainEqual({
      type: "tool-start",
      actionId: "call-execute-visible",
      name: "execute",
      input: { source: "return await tools.shell.run({ command: 'pwd' });" },
    });
    expect(events).toContainEqual({
      type: "tool-start",
      actionId: "call-execute-visible:call:0",
      parentActionId: "call-execute-visible",
      name: "shell.run",
      input: { command: "pwd" },
    });
    expect(events).toContainEqual({
      type: "tool-end",
      actionId: "call-execute-visible:call:0",
      parentActionId: "call-execute-visible",
      name: "shell.run",
      isError: false,
      result: { stdout: "/workspace" },
    });
    expect(
      events.some(
        (event) =>
          event.type === "tool-update" &&
          event.actionId === "call-execute-visible" &&
          JSON.stringify(event.update).includes('"kind":"activity"') &&
          JSON.stringify(event.update).includes("Starting shell"),
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "tool-end" &&
          event.actionId === "call-execute-visible" &&
          !event.parentActionId &&
          !event.isError,
      ),
    ).toBe(true);
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
      codeExecution: controlledCodeExecution(
        {
          resolve: async (received) =>
            Object.freeze({
              planId: received.planId,
              canonicalDigest: received.canonicalDigest,
              consumedMaterials: frozenPlanMaterialUses(received).slice(1),
              definitions: definitions("must-not-run"),
            }),
        },
        "must-not-run",
      ),
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
