import {
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type Models,
} from "@earendil-works/pi-ai";
import { AgentHarness, TODO_CONTEXT, type AgentHarnessToolInvocation } from "@earendil-works/pi-agent-core";
import {
  type AgentRuntimeEvent,
  type AgentUsage,
  type FrozenRevisionMaterial,
  type FrozenSubAgentPlan,
  type FrozenTurnPlan,
  frozenSubAgentPlanDigest,
  frozenTurnPlanDigest,
} from "@noesis/agent-types";
import { type FileRevisionRef, isJsonObject, type JsonValue, sha256 } from "@noesis/domain";
import type { SessionToolDefinition, SessionToolName } from "@noesis/intelligence";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import {
  createAssistantDeltaAggregator,
  createBrokerToolAliases,
  createPiAgentRuntime,
  createPiRoleModelBackend,
  createPiExecuteTool,
  createPiSubAgentTaskRunner,
  type FrozenSessionToolResolver,
  frozenPlanMaterialUses,
  type PiCodeExecutionAdapter,
  type PiFrozenToolCatalog,
  type PiSkillLibrary,
  type PreparedPiCodeExecution,
  resolveFrozenSessionToolDefinitions,
  resolvePiSkillInvocation,
  toAgentActionPayload,
} from "../src/index.ts";
import {
  CONTROLLED_PI_MODEL,
  CONTROLLED_PI_PROVIDER,
  createControlledPiModels,
  controlledToolCallResponse,
} from "./support/controlled-pi-models.ts";

// SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
const sessionToolNames = [
  "search_sessions",
  "open_session_evidence",
  "find_corrections",
  "find_similar_tasks",
  "prior_experiment_outcomes",
] as const satisfies readonly SessionToolName[];
const TEST_TOOL_INVOCATION: AgentHarnessToolInvocation = Object.freeze({
  invocationId: "test-invocation",
  operationId: "test-operation",
  turnId: "test-turn",
  getMemo: async () => undefined,
  setMemo: async () => undefined,
});

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

function frozenPlan(
  conversationHistory: NonNullable<FrozenTurnPlan["conversationHistory"]> = Object.freeze([]),
): FrozenTurnPlan {
  const prompt = material("prompt-v1", "prompts/grounded.md", "Use exact session evidence.");
  const skill = material("skill-v1", "skills/grounded.md", "Search before answering.");
  const router = material(
    "router-v1",
    "capabilities/grounded-router.json",
    JSON.stringify({ strategyId: "session-search.fts-only.v1" }),
  );
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
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
        description: "Use exact session evidence.",
        applicability: "When prior session evidence is needed.",
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
    conversationHistory,
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
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
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

function emptyCatalog(catalogId: string) {
  return catalogWithTools(catalogId, []);
}

function catalogWithTools(catalogId: string, names: readonly string[]): PiFrozenToolCatalog {
  const allNames = [...new Set(["files.read", "files.write", "shell.run", ...names])];
  return Object.freeze({
    catalogId,
    catalogDigest: sha256(catalogId),
    tools: Object.freeze(
      allNames.map((name) =>
        Object.freeze({
          name,
          label: name,
          description: name,
          revisionId: `${name}-v1`,
          inputSchema: Object.freeze({ type: "object" }),
          outputSchema: Object.freeze({ type: "object" }),
        }),
      ),
    ),
  });
}

function controlledCodeExecution(
  resolver: FrozenSessionToolResolver,
  marker: string,
): PiCodeExecutionAdapter {
  const prepare: PiCodeExecutionAdapter["prepare"] = async (plan, signal) => {
    await resolveFrozenSessionToolDefinitions(plan, resolver, signal);
    return Object.freeze({
      catalog: emptyCatalog("catalog-controlled"),
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

interface TestSubAgentTaskPlan {
  readonly runId: string;
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly tools: readonly string[];
  readonly thinkingLevel: FrozenSubAgentPlan["thinkingLevel"];
  readonly route: FrozenSubAgentPlan["route"];
  readonly frozenTools: FrozenSubAgentPlan["frozenTools"];
  readonly authority: {
    readonly parentExecutionId: string;
    readonly parentToolCallId: string;
  };
  readonly budget: { readonly requestTokenBudget: number };
}

function createTestSubAgentTaskRunner(cwd: string, models: Models) {
  const runner = createPiSubAgentTaskRunner(cwd, models);
  return Object.freeze({
    run: async (request: {
      readonly plan: TestSubAgentTaskPlan;
      readonly prepared: PreparedPiCodeExecution;
      readonly turnId: string;
      readonly signal: AbortSignal;
      readonly authorizeModelCall: (
        round: number,
        input: JsonValue,
      ) => Promise<{
        readonly complete: (request: {
          readonly output: string;
          readonly usage: import("@noesis/agent-types").AgentUsage;
        }) => Promise<void>;
        readonly fail: (reason: string, usage?: import("@noesis/agent-types").AgentUsage) => Promise<void>;
      }>;
      readonly emit: (event: AgentRuntimeEvent) => void;
    }) => {
      const template = frozenPlan();
      const unsigned: Omit<FrozenSubAgentPlan, "canonicalDigest"> = Object.freeze({
        schemaVersion: 1,
        agentId: request.plan.runId,
        childSessionId: `session-${request.plan.runId}`,
        origin: Object.freeze({
          projectId: "project-runtime-test",
          sessionId: template.sessionId,
          turnId: template.turnId,
          executionId: request.plan.authority.parentExecutionId,
        }),
        route: request.plan.route,
        thinkingLevel: request.plan.thinkingLevel,
        renderedSystemPrompt: request.plan.systemPrompt,
        frozenTools: request.plan.frozenTools,
        executionTemplate: template,
        authority: Object.freeze({ permissionSnapshot: template.permissionSnapshot }),
        requestTokenBudget: request.plan.budget.requestTokenBudget,
        createdAt: "2026-07-25T00:00:00.000Z",
      });
      const plan: FrozenSubAgentPlan = Object.freeze({
        ...unsigned,
        canonicalDigest: frozenSubAgentPlanDigest(unsigned),
      });
      const abort = (): void => {
        void runner.abort(request.turnId);
      };
      request.signal.addEventListener("abort", abort, { once: true });
      try {
        return await runner.run({
          plan,
          taskId: request.turnId,
          prompt: request.plan.prompt,
          history: Object.freeze([]),
          prepared: request.prepared,
          startingTimelineSequence: 0,
          authorizeModelCall: async ({ round, request: input }) =>
            await request.authorizeModelCall(round, input),
          emit: request.emit,
        });
      } finally {
        request.signal.removeEventListener("abort", abort);
      }
    },
    steer: runner.steer,
    abort: runner.abort,
  });
}

describe("agent runtime factories", () => {
  const reviewPlan: TestSubAgentTaskPlan = {
    runId: "review-regression",
    systemPrompt: "Use the supplied tools.",
    prompt: "Inspect this exact current request.",
    tools: [],
    thinkingLevel: "off",
    route: { provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL },
    frozenTools: [],
    authority: { parentExecutionId: "parent-execution", parentToolCallId: "parent-call" },
    budget: { requestTokenBudget: 2_000 },
  };
  const reviewPrepared: PreparedPiCodeExecution = {
    catalog: emptyCatalog("review-catalog"),
    execute: async () => ({ executionId: "review-execution", value: null, calls: 0, durationMs: 0 }),
    close: async () => undefined,
  };
  const completedLease = async () => ({ complete: async () => undefined, fail: async () => undefined });

  test.each(["harness", "lane"])("cancels subagent startup while %s creation is pending", async (stage) => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controlled = createControlledPiModels();
    const provider = vi.spyOn(controlled.models, "streamSimple");
    const originalCreate = AgentHarness.create.bind(AgentHarness);
    const create = vi.spyOn(AgentHarness, "create").mockImplementationOnce(async (options, context) => {
      const created = await originalCreate(options, context);
      if (stage === "harness") {
        started.resolve();
        await release.promise;
      } else {
        const originalLane = created.harness.lane.bind(created.harness);
        vi.spyOn(created.harness, "lane").mockImplementationOnce(async (name) => {
          started.resolve();
          await release.promise;
          return await originalLane(name, context);
        });
      }
      return created;
    });
    const runner = createTestSubAgentTaskRunner(process.cwd(), controlled.models);
    try {
      const running = runner.run({
        plan: reviewPlan,
        prepared: reviewPrepared,
        turnId: stage,
        signal: new AbortController().signal,
        authorizeModelCall: completedLease,
        emit: () => undefined,
      });
      await started.promise;
      await runner.abort(stage);
      release.resolve();
      await expect(running).rejects.toThrow("Subagent task was cancelled");
      expect(provider).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      create.mockRestore();
    }
  });

  test.each(["budget", "authorization"])(
    "does not invoke a provider after %s rejects the current request",
    async (failure) => {
      const controlled = createControlledPiModels();
      const provider = vi.spyOn(controlled.models, "streamSimple");
      const authorize = vi.fn(async () => {
        throw new Error("admission denied");
      });
      const runner = createTestSubAgentTaskRunner(process.cwd(), controlled.models);
      await expect(
        runner.run({
          plan: failure === "budget" ? { ...reviewPlan, budget: { requestTokenBudget: 1 } } : reviewPlan,
          prepared: reviewPrepared,
          turnId: failure,
          signal: new AbortController().signal,
          authorizeModelCall: authorize,
          emit: () => undefined,
        }),
      ).rejects.toThrow(failure === "budget" ? "token budget" : "admission denied");
      expect(provider).not.toHaveBeenCalled();
      expect(authorize).toHaveBeenCalledTimes(failure === "budget" ? 0 : 1);
    },
  );

  test("keeps a failed settlement available for cleanup and prevents subsequent tools", async () => {
    const controlled = createControlledPiModels({
      respond: () => controlledToolCallResponse("execute", { source: "return 1" }, "settlement-call"),
    });
    const complete = vi.fn(async () => {
      throw new Error("settlement storage failed");
    });
    const fail = vi.fn(async () => undefined);
    const execute = vi.fn(reviewPrepared.execute);
    await expect(
      createTestSubAgentTaskRunner(process.cwd(), controlled.models).run({
        plan: reviewPlan,
        prepared: { ...reviewPrepared, execute },
        turnId: "settlement-failure",
        signal: new AbortController().signal,
        authorizeModelCall: async () => ({ complete, fail }),
        emit: () => undefined,
      }),
    ).rejects.toThrow("settlement storage failed");
    expect(complete).toHaveBeenCalledOnce();
    expect(fail).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  test.each(["foreground", "role", "subagent"])(
    "settles a suspended %s response without hanging cleanup",
    async (kind) => {
      const controlled = createControlledPiModels({
        respond: () => ({
          ...fauxAssistantMessage("", { stopReason: "deferred" }),
          deferred: {
            provider: CONTROLLED_PI_PROVIDER,
            modelId: CONTROLLED_PI_MODEL,
            api: controlled.provider.api,
            id: "deferred-response",
          },
        }),
      });
      vi.spyOn(controlled.models, "cancelDeferred").mockResolvedValue(undefined);
      if (kind === "subagent") {
        await expect(
          createTestSubAgentTaskRunner(process.cwd(), controlled.models).run({
            plan: reviewPlan,
            prepared: reviewPrepared,
            turnId: kind,
            signal: new AbortController().signal,
            authorizeModelCall: completedLease,
            emit: () => undefined,
          }),
        ).rejects.toThrow("suspended");
      } else if (kind === "role") {
        await expect(
          createPiRoleModelBackend(process.cwd(), controlled.models).run({
            runId: kind,
            provider: CONTROLLED_PI_PROVIDER,
            model: CONTROLLED_PI_MODEL,
            reasoning: "off",
            systemPrompt: "Reply",
            prompt: "reply",
            signal: new AbortController().signal,
          }),
        ).rejects.toThrow("suspended");
      } else {
        await expect(
          createPiAgentRuntime(process.cwd(), controlled.models).run(
            {
              trailId: kind,
              provider: CONTROLLED_PI_PROVIDER,
              model: CONTROLLED_PI_MODEL,
              thinkingLevel: "off",
              systemPrompt: "Reply",
              prompt: "reply",
              activeCapabilities: [],
            },
            () => undefined,
          ),
        ).rejects.toThrow("suspended");
      }
    },
  );
  test("cancellation during authentication settles before subagent provider work starts", async () => {
    let providerRequests = 0;
    const controlled = createControlledPiModels({
      respond: () => {
        providerRequests += 1;
        return "This response must not be requested.";
      },
    });
    let authenticationStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      authenticationStarted = resolve;
    });
    const pendingAuthentication = new Promise<Awaited<ReturnType<typeof controlled.models.getAuth>>>(
      () => undefined,
    );
    vi.spyOn(controlled.models, "getAuth").mockImplementation(async () => {
      authenticationStarted();
      return await pendingAuthentication;
    });
    const controller = new AbortController();
    const plan: TestSubAgentTaskPlan = Object.freeze({
      runId: "subagent-pre-aborted",
      systemPrompt: "Exact frozen subagent prompt.",
      prompt: "Do not run.",
      tools: Object.freeze([]),
      thinkingLevel: "off",
      route: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
      frozenTools: Object.freeze([]),
      authority: Object.freeze({
        parentExecutionId: "execution-parent",
        parentToolCallId: "tool-call-parent",
      }),
      budget: Object.freeze({ requestTokenBudget: 2_000 }),
    });
    const prepared: PreparedPiCodeExecution = Object.freeze({
      catalog: emptyCatalog("catalog-subagent-pre-aborted"),
      execute: async () => Object.freeze({ executionId: "unused", value: null, calls: 0, durationMs: 0 }),
      close: async () => undefined,
    });

    const run = createTestSubAgentTaskRunner(process.cwd(), controlled.models).run({
      plan,
      prepared,
      turnId: "turn-subagent-pre-aborted",
      signal: controller.signal,
      authorizeModelCall: async () => {
        throw new Error("A model call must not be authorized while authentication is pending");
      },
      emit: () => undefined,
    });
    await started;
    controller.abort(new Error("cancel during authentication"));

    await expect(run).rejects.toThrow("Subagent task was cancelled");
    expect(providerRequests).toBe(0);
  });

  test("forwards each queued steer once across the startup flush boundary", async () => {
    const authenticationStarted = Promise.withResolvers<void>();
    const releaseAuthentication = Promise.withResolvers<void>();
    const responseStarted = Promise.withResolvers<void>();
    const releaseResponse = Promise.withResolvers<void>();
    let responses = 0;
    const controlled = createControlledPiModels({
      respond: async () => {
        responses += 1;
        if (responses === 1) {
          responseStarted.resolve();
          await releaseResponse.promise;
        }
        return `response ${String(responses)}`;
      },
    });
    const getAuth = controlled.models.getAuth.bind(controlled.models);
    vi.spyOn(controlled.models, "getAuth").mockImplementation(async (model) => {
      authenticationStarted.resolve();
      await releaseAuthentication.promise;
      return await getAuth(model);
    });
    const firstForwarded = Promise.withResolvers<void>();
    const releaseFirstForward = Promise.withResolvers<void>();
    const forwarded: string[] = [];
    const originalCreate = AgentHarness.create.bind(AgentHarness);
    const createSpy = vi.spyOn(AgentHarness, "create").mockImplementation(async (options, context) => {
      const created = await originalCreate(options, context);
      const lane = await created.harness.lane("main", context);
      const originalSteer = lane.steer.bind(lane);
      vi.spyOn(lane, "steer").mockImplementation(async (text, images, steerContext) => {
        const message = typeof text === "string" ? text : "";
        forwarded.push(message);
        const result = await originalSteer(text, images, steerContext);
        if (message === "first queued steer") {
          firstForwarded.resolve();
          await releaseFirstForward.promise;
        }
        return result;
      });
      return created;
    });
    const runner = createTestSubAgentTaskRunner(process.cwd(), controlled.models);
    const turnId = "turn-subagent-steer-flush";
    const plan: TestSubAgentTaskPlan = Object.freeze({
      runId: "subagent-steer-flush",
      systemPrompt: "Follow both steering messages.",
      prompt: "Begin the controlled task.",
      tools: Object.freeze([]),
      thinkingLevel: "off",
      route: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
      frozenTools: Object.freeze([]),
      authority: Object.freeze({
        parentExecutionId: "execution-parent",
        parentToolCallId: "tool-call-parent",
      }),
      budget: Object.freeze({ requestTokenBudget: 2_000 }),
    });
    const prepared: PreparedPiCodeExecution = Object.freeze({
      catalog: emptyCatalog("catalog-subagent-steer-flush"),
      execute: async () => Object.freeze({ executionId: "unused", value: null, calls: 0, durationMs: 0 }),
      close: async () => undefined,
    });

    try {
      const running = runner.run({
        plan,
        prepared,
        turnId,
        signal: new AbortController().signal,
        authorizeModelCall: async () =>
          Object.freeze({
            complete: async () => undefined,
            fail: async () => undefined,
          }),
        emit: () => undefined,
      });
      await authenticationStarted.promise;
      const firstReceipt = runner.steer(turnId, "first queued steer");
      releaseAuthentication.resolve();
      await firstForwarded.promise;
      const secondReceipt = runner.steer(turnId, "second direct steer");
      releaseFirstForward.resolve();
      await responseStarted.promise;
      releaseResponse.resolve();

      await expect(firstReceipt).resolves.toMatchObject({ status: "consumed" });
      await expect(secondReceipt).resolves.toMatchObject({ status: "consumed" });
      await expect(running).resolves.toMatchObject({ text: expect.any(String) });
      expect(forwarded.filter((text) => text === "first queued steer")).toHaveLength(1);
      expect(forwarded.filter((text) => text === "second direct steer")).toHaveLength(1);
    } finally {
      createSpy.mockRestore();
    }
  });

  test("does not impose provider-round or tool-call ceilings on productive subagents", async () => {
    let providerRequests = 0;
    const providerContexts: string[] = [];
    const controlled = createControlledPiModels({
      respond: ({ context }) => {
        providerContexts.push(JSON.stringify(context.messages));
        providerRequests += 1;
        return providerRequests <= 33
          ? controlledToolCallResponse(
              "probe",
              { round: providerRequests },
              `probe-${String(providerRequests)}`,
            )
          : "Completed after thirty-three tool rounds.";
      },
    });
    const catalog = catalogWithTools("catalog-subagent-rounds", ["probe"]);
    const probe = catalog.tools.find((tool) => tool.name === "probe");
    if (!probe) throw new Error("Controlled catalog is missing probe");
    const plan: TestSubAgentTaskPlan = Object.freeze({
      runId: "subagent-many-rounds",
      systemPrompt: "Use the supplied probe until the task is complete.",
      prompt: "Complete the controlled multi-round task.",
      tools: Object.freeze(["probe"]),
      thinkingLevel: "off",
      route: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
      frozenTools: Object.freeze([probe]),
      authority: Object.freeze({
        parentExecutionId: "execution-parent",
        parentToolCallId: "tool-call-parent",
      }),
      budget: Object.freeze({ requestTokenBudget: 2_000 }),
    });
    const prepared: PreparedPiCodeExecution = Object.freeze({
      catalog,
      execute: async () => Object.freeze({ executionId: "unused", value: null, calls: 0, durationMs: 0 }),
      invoke: async () => Object.freeze({ ok: true }),
      close: async () => undefined,
    });

    const authorizedModelCalls: number[] = [];
    const authorizedContexts: string[] = [];
    const settledModelCalls: number[] = [];
    const result = await createTestSubAgentTaskRunner(process.cwd(), controlled.models).run({
      plan,
      prepared,
      turnId: "turn-subagent-many-rounds",
      signal: new AbortController().signal,
      authorizeModelCall: async (modelCall, input) => {
        authorizedContexts.push(JSON.stringify(input));
        authorizedModelCalls.push(modelCall);
        return Object.freeze({
          complete: async () => {
            settledModelCalls.push(modelCall);
          },
          fail: async () => {
            settledModelCalls.push(modelCall);
          },
        });
      },
      emit: () => undefined,
    });

    expect(result.text).toBe("Completed after thirty-three tool rounds.");
    expect(result.modelCalls).toBe(34);
    expect(result.toolCalls).toBe(33);
    expect(providerRequests).toBe(34);
    expect(authorizedModelCalls).toEqual(Array.from({ length: 34 }, (_, index) => index + 1));
    expect(settledModelCalls).toEqual(authorizedModelCalls);
    expect(authorizedContexts).toEqual(providerContexts);
    expect(authorizedContexts[0]).toContain(plan.prompt);
  });

  test.each([
    Object.freeze({
      label: "error",
      response: fauxAssistantMessage("Provider request failed.", {
        stopReason: "error",
        errorMessage: "controlled provider unavailable",
      }),
      expectedReason: "controlled provider unavailable",
      expectedStatus: "failed" as const,
    }),
    Object.freeze({
      label: "aborted",
      response: fauxAssistantMessage("Provider request aborted.", { stopReason: "aborted" }),
      expectedReason: "Subagent task was cancelled",
      expectedStatus: "cancelled" as const,
    }),
  ])("fails the durable model-call lease when the provider round ends as $label", async (fixture) => {
    const controlled = createControlledPiModels({
      respond: () => fixture.response,
    });
    const plan: TestSubAgentTaskPlan = Object.freeze({
      runId: `subagent-provider-${fixture.label}`,
      systemPrompt: "Return the provider outcome.",
      prompt: `Exercise a controlled provider ${fixture.label}.`,
      tools: Object.freeze([]),
      thinkingLevel: "off",
      route: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
      frozenTools: Object.freeze([]),
      authority: Object.freeze({
        parentExecutionId: "execution-parent",
        parentToolCallId: "tool-call-parent",
      }),
      budget: Object.freeze({ requestTokenBudget: 2_000 }),
    });
    const prepared: PreparedPiCodeExecution = Object.freeze({
      catalog: emptyCatalog(`catalog-subagent-provider-${fixture.label}`),
      execute: async () => Object.freeze({ executionId: "unused", value: null, calls: 0, durationMs: 0 }),
      close: async () => undefined,
    });
    const completed: number[] = [];
    const failed: {
      readonly modelCall: number;
      readonly reason: string;
      readonly status: "failed" | "cancelled";
    }[] = [];

    await expect(
      createTestSubAgentTaskRunner(process.cwd(), controlled.models).run({
        plan,
        prepared,
        turnId: `turn-subagent-provider-${fixture.label}`,
        signal: new AbortController().signal,
        authorizeModelCall: async (modelCall) =>
          Object.freeze({
            complete: async () => {
              completed.push(modelCall);
            },
            fail: async (reason: string, _usage?: AgentUsage, status: "failed" | "cancelled" = "failed") => {
              failed.push(Object.freeze({ modelCall, reason, status }));
            },
          }),
        emit: () => undefined,
      }),
    ).rejects.toThrow(fixture.expectedReason);
    expect(completed).toEqual([]);
    expect(failed).toEqual([
      { modelCall: 1, reason: fixture.expectedReason, status: fixture.expectedStatus },
    ]);
  });

  test("assigns injective catalog aliases without shadowing core tools", () => {
    const catalog: PiFrozenToolCatalog = Object.freeze({
      catalogId: "catalog-aliases",
      catalogDigest: sha256("catalog-aliases"),
      tools: Object.freeze(
        ["files.read", "file_read", "history.search_sessions", "search_sessions", "execute"].map((name) =>
          Object.freeze({
            name,
            label: name,
            description: name,
            revisionId: `${name}-v1`,
            inputSchema: Object.freeze({ type: "object" }),
            outputSchema: Object.freeze({ type: "object" }),
          }),
        ),
      ),
    });

    const aliases = createBrokerToolAliases(catalog);
    const values = [...aliases.values()];

    expect(aliases.get("files.read")).toBe("file_read");
    expect(aliases.get("history.search_sessions")).toBe("history_search_sessions");
    expect(aliases.get("search_sessions")).toBe("search_sessions");
    expect(new Set(values).size).toBe(values.length);
    expect(values).not.toContain("execute");
    expect([...createBrokerToolAliases(catalog)]).toEqual([...aliases]);
  });

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

  test("emits visible reasoning separately from assistant conversation text", async () => {
    const controlled = createControlledPiModels({
      respond: () =>
        fauxAssistantMessage([
          fauxThinking("Inspect the evidence before answering."),
          fauxText("The evidence supports the answer."),
        ]),
    });
    const runtime = createPiAgentRuntime(process.cwd(), controlled.models, {
      now: () => "2026-08-25T00:00:00.000Z",
    });
    const events: AgentRuntimeEvent[] = [];

    await expect(
      runtime.run(
        {
          trailId: "trail-reasoning-events",
          provider: CONTROLLED_PI_PROVIDER,
          model: CONTROLLED_PI_MODEL,
          thinkingLevel: "high",
          systemPrompt: "Reason, then answer.",
          prompt: "What does the evidence show?",
          activeCapabilities: [],
        },
        (event) => events.push(event),
      ),
    ).resolves.toMatchObject({ text: "The evidence supports the answer." });

    expect(
      events
        .filter((event) => event.type === "reasoning-delta")
        .map((event) => event.text)
        .join(""),
    ).toBe("Inspect the evidence before answering.");
    expect(events).toContainEqual({
      type: "reasoning-message",
      text: "Inspect the evidence before answering.",
      timelineSequence: 1,
      createdAt: "2026-08-25T00:00:00.000Z",
    });
    expect(events).toContainEqual({
      type: "assistant-message",
      text: "The evidence supports the answer.",
      timelineSequence: 2,
      createdAt: "2026-08-25T00:00:00.000Z",
    });
  });

  test("preserves prior conversation roles instead of promoting history into the system prompt", async () => {
    const controlled = createControlledPiModels({
      respond: ({ systemPrompt, context }) => {
        expect(systemPrompt).toBe("Stable system instruction.");
        expect(context.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
        return "History kept its roles.";
      },
    });
    const runtime = createPiAgentRuntime(process.cwd(), controlled.models);

    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const result = await runtime.run(
      {
        trailId: "history-roles",
        provider: CONTROLLED_PI_PROVIDER,
        model: CONTROLLED_PI_MODEL,
        thinkingLevel: "off",
        systemPrompt: "Stable system instruction.",
        history: Object.freeze([
          Object.freeze({ role: "user" as const, content: "Earlier user message" }),
          Object.freeze({ role: "assistant" as const, content: "Earlier assistant response" }),
          Object.freeze({ role: "assistant" as const, content: "" }),
        ]),
        prompt: "Current request",
        activeCapabilities: Object.freeze([]),
      },
      () => undefined,
    );

    expect(result.text).toBe("History kept its roles.");
  });

  test("serves only frozen conversation history and rejects a divergent runtime copy", async () => {
    const createdAt = "2026-07-25T00:00:00.000Z";
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const conversationHistory = Object.freeze([
      Object.freeze({
        messageId: "history-user",
        messageRef: Object.freeze({
          kind: "database_row" as const,
          table: "messages" as const,
          rowId: "history-user",
        }),
        role: "user" as const,
        content: "Earlier frozen request",
        createdAt,
        contentDigest: sha256("Earlier frozen request"),
      }),
      Object.freeze({
        messageId: "history-assistant",
        messageRef: Object.freeze({
          kind: "database_row" as const,
          table: "messages" as const,
          rowId: "history-assistant",
        }),
        role: "assistant" as const,
        content: "Earlier frozen response",
        createdAt,
        contentDigest: sha256("Earlier frozen response"),
      }),
    ]);
    const plan = frozenPlan(conversationHistory);
    const controlled = createControlledPiModels({
      respond: ({ context }) => {
        expect(context.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
        return "Frozen history served.";
      },
    });
    const runtime = createPiAgentRuntime(process.cwd(), controlled.models, {
      codeExecution: controlledCodeExecution(
        {
          resolve: async (received) =>
            Object.freeze({
              planId: received.planId,
              canonicalDigest: received.canonicalDigest,
              consumedMaterials: frozenPlanMaterialUses(received),
              definitions: definitions("unused"),
            }),
        },
        "unused",
      ),
    });
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const request = {
      trailId: plan.sessionId,
      provider: plan.provider,
      model: plan.model,
      thinkingLevel: plan.thinkingLevel,
      systemPrompt: plan.renderedSystemPrompt,
      prompt: "Current request",
      history: Object.freeze(
        conversationHistory.map(({ role, content, createdAt: timestamp }) =>
          Object.freeze({ role, content, createdAt: timestamp }),
        ),
      ),
      activeCapabilities: Object.freeze([]),
      frozenTurnPlan: plan,
    } as const;

    await expect(runtime.run(request, () => undefined)).resolves.toMatchObject({
      text: "Frozen history served.",
    });
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    await expect(
      runtime.run(
        {
          ...request,
          history: Object.freeze([
            Object.freeze({ role: "user" as const, content: "Unfrozen injected history", createdAt }),
          ]),
        },
        () => undefined,
      ),
    ).rejects.toThrow(`Runtime history does not match frozen turn plan ${plan.planId}`);
  });

  test("labels visible messages from unsuccessful turns as unfinished model context", async () => {
    const createdAt = "2026-07-25T00:00:00.000Z";
    const content = "Finish the repository audit.";
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const plan = frozenPlan(
      Object.freeze([
        Object.freeze({
          messageId: "failed-history-user",
          messageRef: Object.freeze({
            kind: "database_row" as const,
            table: "messages" as const,
            rowId: "failed-history-user",
          }),
          role: "user" as const,
          content,
          createdAt,
          contentDigest: sha256(content),
          turnStatus: "failed" as const,
        }),
      ]),
    );
    const controlled = createControlledPiModels({
      respond: ({ context }) => {
        const prior = context.messages[0];
        expect(prior).toMatchObject({ role: "user" });
        expect(JSON.stringify(prior)).toContain("Previous user message from a turn that failed");
        expect(JSON.stringify(prior)).toContain(content);
        return "The unfinished request remains visible.";
      },
    });
    const runtime = createPiAgentRuntime(process.cwd(), controlled.models, {
      codeExecution: controlledCodeExecution(
        {
          resolve: async (received) =>
            Object.freeze({
              planId: received.planId,
              canonicalDigest: received.canonicalDigest,
              consumedMaterials: frozenPlanMaterialUses(received),
              definitions: definitions("unused"),
            }),
        },
        "unused",
      ),
    });

    await expect(
      runtime.run(
        {
          trailId: plan.sessionId,
          provider: plan.provider,
          model: plan.model,
          thinkingLevel: plan.thinkingLevel,
          systemPrompt: plan.renderedSystemPrompt,
          prompt: "Keep going.",
          activeCapabilities: Object.freeze([]),
          frozenTurnPlan: plan,
        },
        () => undefined,
      ),
    ).resolves.toMatchObject({ text: "The unfinished request remains visible." });
  });

  test("loads an explicitly invoked skill from the pinned snapshot before model inference", async () => {
    const plan = frozenPlan();
    const skillContent = "Ask why repeatedly, then identify the smallest actionable root cause.";
    const skill = Object.freeze({
      name: "five-whys",
      description: "Find the cause beneath a recurring problem",
      content: skillContent,
      filePath: "/skills/five-whys/SKILL.md",
      contentDigest: sha256(skillContent),
      disableModelInvocation: false,
    });
    const pinnedSnapshot = Object.freeze({
      skills: Object.freeze([skill]),
      diagnostics: Object.freeze([]),
    });
    let snapshotReads = 0;
    const skills: PiSkillLibrary = {
      snapshot: async () => {
        snapshotReads += 1;
        return pinnedSnapshot;
      },
      pinSnapshot: async () => pinnedSnapshot,
      claimPinnedSnapshot: (key) => (key === plan.planId ? pinnedSnapshot : undefined),
      discardPinnedSnapshot: () => undefined,
      install: async () => undefined,
      remove: async () => false,
      update: async () => undefined,
      configured: () => Object.freeze([]),
    };
    const events: AgentRuntimeEvent[] = [];
    const controlled = createControlledPiModels({
      respond: ({ lastUserText }) => {
        expect(events).toEqual([
          expect.objectContaining({
            type: "model",
          }),
          {
            type: "tool-start",
            actionId: `skill-load:${plan.turnId}:five-whys`,
            name: "skills.load",
            input: { name: "five-whys" },
            timelineSequence: 1,
          },
          {
            type: "tool-end",
            actionId: `skill-load:${plan.turnId}:five-whys`,
            name: "skills.load",
            isError: false,
            result: {
              name: "five-whys",
              description: skill.description,
              filePath: skill.filePath,
              content: skill.content,
              contentDigest: skill.contentDigest,
              revision: null,
              invocation: "explicit",
            },
          },
          {
            type: "status",
            status: "started",
          },
        ]);
        expect(lastUserText).toContain('<skill name="five-whys" location="/skills/five-whys/SKILL.md">');
        expect(lastUserText).toContain(skillContent);
        expect(lastUserText).toContain("Investigate why the deploy keeps failing.");
        return "The skill instructions were applied.";
      },
    });
    const runtime = createPiAgentRuntime(process.cwd(), controlled.models, {
      skills,
      requirePinnedSkillSnapshot: true,
      codeExecution: controlledCodeExecution(
        {
          resolve: async (received) =>
            Object.freeze({
              planId: received.planId,
              canonicalDigest: received.canonicalDigest,
              consumedMaterials: frozenPlanMaterialUses(received),
              definitions: definitions("unused"),
            }),
        },
        "unused",
      ),
    });

    const result = await runtime.run(
      {
        trailId: plan.sessionId,
        provider: plan.provider,
        model: plan.model,
        thinkingLevel: plan.thinkingLevel,
        systemPrompt: plan.renderedSystemPrompt,
        prompt: "/five-whys Investigate why the deploy keeps failing.",
        activeCapabilities: [],
        frozenTurnPlan: plan,
      },
      (event) => events.push(event),
    );

    expect(result).toMatchObject({ outcome: "completed", text: "The skill instructions were applied." });
    expect(snapshotReads).toBe(0);
  });

  test("serves a Capability skill through Pi progressive disclosure without injecting its body", async () => {
    const base = frozenPlan();
    const capabilitySkill = material(
      "capability-skill-v1",
      "capabilities/evidence-synthesis/skills/evidence-synthesis/SKILL.md",
      "PRIVATE CAPABILITY SKILL BODY: inspect every cited source before synthesis.",
    );
    const selected = base.selectedCapabilities[0];
    if (!selected) throw new Error("Frozen plan fixture has no capability");
    const { canonicalDigest: _baseDigest, ...baseUnsigned } = base;
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const unsigned: Omit<FrozenTurnPlan, "canonicalDigest"> = Object.freeze({
      ...baseUnsigned,
      selectedCapabilities: Object.freeze([
        Object.freeze({
          ...selected,
          effects: Object.freeze([
            Object.freeze({
              kind: "skill" as const,
              name: "evidence-synthesis",
              description: "Inspect cited sources before producing a synthesis.",
              material: capabilitySkill,
            }),
          ]),
          promptModules: Object.freeze([]),
          skills: Object.freeze([]),
        }),
      ]),
      renderedSystemPrompt: "Noesis protected kernel.",
    });
    const plan = Object.freeze({ ...unsigned, canonicalDigest: frozenTurnPlanDigest(unsigned) });
    const controlled = createControlledPiModels({
      respond: ({ systemPrompt }) => {
        expect(systemPrompt).toContain("evidence-synthesis");
        expect(systemPrompt).toContain("Inspect cited sources before producing a synthesis.");
        expect(systemPrompt).toContain("tools.skills.load({ name })");
        expect(systemPrompt).not.toContain(capabilitySkill.revision.workingPath);
        expect(systemPrompt).not.toContain("PRIVATE CAPABILITY SKILL BODY");
        return "Capability skill is discoverable.";
      },
    });
    const runtime = createPiAgentRuntime(process.cwd(), controlled.models, {
      codeExecution: controlledCodeExecution(
        {
          resolve: async (received) =>
            Object.freeze({
              planId: received.planId,
              canonicalDigest: received.canonicalDigest,
              consumedMaterials: frozenPlanMaterialUses(received),
              definitions: definitions("unused"),
            }),
        },
        "unused",
      ),
    });

    await expect(
      runtime.run(
        {
          trailId: plan.sessionId,
          provider: plan.provider,
          model: plan.model,
          thinkingLevel: plan.thinkingLevel,
          systemPrompt: plan.renderedSystemPrompt,
          prompt: "Synthesize the cited sources.",
          activeCapabilities: Object.freeze([]),
          frozenTurnPlan: plan,
        },
        () => undefined,
      ),
    ).resolves.toMatchObject({ text: "Capability skill is discoverable." });
  });

  test("budgets the expanded explicit skill prompt before model inference", async () => {
    const base = frozenPlan();
    const { canonicalDigest: _digest, ...baseUnsigned } = base;
    const unsigned = Object.freeze({ ...baseUnsigned, requestTokenBudget: 1_000 });
    const plan = Object.freeze({ ...unsigned, canonicalDigest: frozenTurnPlanDigest(unsigned) });
    const skillContent = "Apply the complete procedure. ".repeat(400);
    const skill = Object.freeze({
      name: "large-procedure",
      description: "A procedure larger than the admitted request budget",
      content: skillContent,
      filePath: "/skills/large-procedure/SKILL.md",
      contentDigest: sha256(skillContent),
      disableModelInvocation: false,
    });
    const snapshot = Object.freeze({ skills: Object.freeze([skill]), diagnostics: Object.freeze([]) });
    const controlled = createControlledPiModels();
    const runtime = createPiAgentRuntime(process.cwd(), controlled.models, {
      skills: {
        snapshot: async () => snapshot,
        pinSnapshot: async () => snapshot,
        claimPinnedSnapshot: (key) => (key === plan.planId ? snapshot : undefined),
        discardPinnedSnapshot: () => undefined,
        install: async () => undefined,
        remove: async () => false,
        update: async () => undefined,
        configured: () => Object.freeze([]),
      },
      requirePinnedSkillSnapshot: true,
      codeExecution: controlledCodeExecution(
        {
          resolve: async (received) =>
            Object.freeze({
              planId: received.planId,
              canonicalDigest: received.canonicalDigest,
              consumedMaterials: frozenPlanMaterialUses(received),
              definitions: definitions("budgeted-skill"),
            }),
        },
        "budgeted-skill",
      ),
    });

    await expect(
      runtime.run(
        {
          trailId: plan.sessionId,
          provider: plan.provider,
          model: plan.model,
          thinkingLevel: plan.thinkingLevel,
          systemPrompt: plan.renderedSystemPrompt,
          prompt: "/large-procedure follow it",
          activeCapabilities: [],
          frozenTurnPlan: plan,
        },
        () => undefined,
      ),
    ).resolves.toMatchObject({
      outcome: "failed",
      error: expect.stringContaining("complete request exceeds its token budget"),
    });
    expect(controlled.provider.state.callCount).toBe(0);
  });

  test("leaves unknown slash prompts untouched", async () => {
    const prompt = "/not-installed preserve this exact text";
    const content = "Instructions that require progressive loading.";
    const discoveredSkill = Object.freeze({
      name: "progressive-only",
      description: "A skill that needs the execute path",
      content,
      filePath: "/skills/progressive-only/SKILL.md",
      contentDigest: sha256(content),
      disableModelInvocation: false,
    });
    const snapshot = Object.freeze({
      skills: Object.freeze([discoveredSkill]),
      diagnostics: Object.freeze([]),
    });
    const controlled = createControlledPiModels({
      respond: ({ lastUserText, systemPrompt }) => {
        expect(lastUserText).toBe(prompt);
        expect(systemPrompt).not.toContain("tools.skills.load({ name })");
        expect(systemPrompt).not.toContain(discoveredSkill.name);
        return "ordinary prompt";
      },
    });
    const runtime = createPiAgentRuntime(process.cwd(), controlled.models, {
      skills: {
        snapshot: async () => snapshot,
        pinSnapshot: async () => snapshot,
        claimPinnedSnapshot: () => undefined,
        discardPinnedSnapshot: () => undefined,
        install: async () => undefined,
        remove: async () => false,
        update: async () => undefined,
        configured: () => Object.freeze([]),
      },
    });
    const events: AgentRuntimeEvent[] = [];

    await runtime.run(
      {
        trailId: "trail-unknown-skill",
        provider: CONTROLLED_PI_PROVIDER,
        model: CONTROLLED_PI_MODEL,
        thinkingLevel: "off",
        systemPrompt: "Noesis",
        prompt,
        activeCapabilities: [],
      },
      (event) => events.push(event),
    );

    expect(events.some((event) => event.type === "tool-start" && event.name === "skills.load")).toBe(false);
  });

  test("bounds explicit skill action evidence while preserving its immutable revision", () => {
    const content = "x".repeat(300 * 1024);
    const contentDigest = sha256(content);
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const revision = Object.freeze({
      kind: "evidence_revision" as const,
      revisionId: "evidence-large-skill",
      workingPath: "skills/large/SKILL.md",
      snapshotPath: "evidence/revisions/evidence-large-skill",
      contentDigest,
      evidenceKind: "input" as const,
    });
    const resolved = resolvePiSkillInvocation(
      "/large apply this skill",
      Object.freeze([
        Object.freeze({
          name: "large",
          description: "A deliberately large skill",
          content,
          filePath: "/skills/large/SKILL.md",
          contentDigest,
          admittedRevision: revision,
          disableModelInvocation: false,
        }),
      ]),
    );

    expect(resolved?.actionEvidence).toMatchObject({
      authority: {
        name: "large",
        contentDigest,
        revision,
        invocation: "explicit",
      },
      evidence: { truncated: true },
    });
    expect(new TextEncoder().encode(JSON.stringify(resolved?.actionEvidence)).byteLength).toBeLessThanOrEqual(
      256 * 1024,
    );
    expect(resolved?.evidence).toMatchObject({ content, revision });
  });

  test("rejects already-cancelled and oversized execute requests before preparation", async () => {
    let executions = 0;
    const turn = new AbortController();
    turn.abort("cancelled");
    const execute = createPiExecuteTool({
      prepared: {
        catalog: emptyCatalog("catalog"),
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
      turnId: "turn-cancelled",
      signal: turn.signal,
      emit: () => undefined,
    });

    await expect(
      execute.execute(
        "cancelled",
        { source: "return null;" },
        () => undefined,
        undefined,
        TEST_TOOL_INVOCATION,
        TODO_CONTEXT,
      ),
    ).rejects.toThrow("cancelled before start");
    expect(executions).toBe(0);

    const active = new AbortController();
    const byteBounded = createPiExecuteTool({
      prepared: {
        catalog: catalogWithTools("catalog", [
          "files.read",
          "files.list",
          "shell.run",
          "programs.list",
          "programs.run",
          "skills.load",
          "history.search_sessions",
          "history.open_session_evidence",
        ]),
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
      turnId: "turn-byte-bounded",
      signal: active.signal,
      emit: () => undefined,
    });
    await expect(
      byteBounded.execute(
        "oversized",
        { source: "😀".repeat(40_000) },
        () => undefined,
        undefined,
        TEST_TOOL_INVOCATION,
        TODO_CONTEXT,
      ),
    ).rejects.toThrow("UTF-8 bytes");
    expect(byteBounded.description).toContain("Compose related multi-call work in one program");
    expect(byteBounded.description).toContain('tools.skills.load({ name: "execute" })');
    expect(byteBounded.description).not.toContain("noesis.search");
    expect(byteBounded.description).not.toContain("agents.run");
    expect(byteBounded.description).not.toContain("programs.save");
    expect(byteBounded.description).not.toContain("store(key, value)");
    expect(executions).toBe(0);
  });

  test("derives the bounded shell contract and falls back when that schema is oversized", () => {
    const createExecute = (outputSchema: JsonValue) =>
      createPiExecuteTool({
        prepared: {
          catalog: Object.freeze({
            catalogId: "catalog-shell-contract",
            catalogDigest: sha256(JSON.stringify(outputSchema)),
            tools: Object.freeze([
              Object.freeze({
                name: "shell.run",
                label: "Run shell command",
                description: "Run a shell command",
                revisionId: "shell-run-v1",
                inputSchema: Object.freeze({ type: "object" }),
                outputSchema,
              }),
            ]),
          }),
          execute: async () => ({
            executionId: "unused",
            value: null,
            calls: 0,
            durationMs: 0,
          }),
          close: async () => undefined,
        },
        turnId: "turn-shell-contract",
        signal: new AbortController().signal,
        emit: () => undefined,
      });

    const baseline = createExecute({ type: "string" });
    const changed = createExecute({
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 80 }, (_, index) => [
          `unboundedPromptGrowthSentinel${String(index)}`,
          { type: "string" },
        ]),
      ),
      required: Array.from({ length: 80 }, (_, index) => `unboundedPromptGrowthSentinel${String(index)}`),
      additionalProperties: false,
    });
    expect(baseline.description).toContain("Schema-derived shell.run result: string");
    expect(changed.description).not.toBe(baseline.description);
    expect(changed.description).toContain('use noesis.describe("shell.run")');
    expect(changed.description).not.toContain("unboundedPromptGrowthSentinel");
  });

  test("scopes codemode logical execution identity by turn when Pi reuses a tool call ID", async () => {
    const logicalExecutionIds: string[] = [];
    const prepared: PreparedPiCodeExecution = {
      catalog: emptyCatalog("catalog-logical-identity"),
      execute: async (_source, _timeoutMs, _signal, _emit, identity) => {
        if (identity) logicalExecutionIds.push(identity.logicalExecutionId);
        return {
          executionId: "physical-execution",
          value: null,
          calls: 0,
          durationMs: 0,
        };
      },
      close: async () => undefined,
    };
    const firstTurn = createPiExecuteTool({
      prepared,
      turnId: "turn-one",
      signal: new AbortController().signal,
      emit: () => undefined,
    });
    const secondTurn = createPiExecuteTool({
      prepared,
      turnId: "turn-two",
      signal: new AbortController().signal,
      emit: () => undefined,
    });

    await firstTurn.execute(
      "stable-parent-call",
      { source: "return null;" },
      () => undefined,
      undefined,
      TEST_TOOL_INVOCATION,
      TODO_CONTEXT,
    );
    await secondTurn.execute(
      "stable-parent-call",
      { source: "return null;" },
      () => undefined,
      undefined,
      TEST_TOOL_INVOCATION,
      TODO_CONTEXT,
    );

    expect(logicalExecutionIds).toEqual(["turn-one:stable-parent-call", "turn-two:stable-parent-call"]);
  });

  test("accepts an explicit execute timeout longer than ten minutes", async () => {
    let receivedTimeout: number | undefined;
    const execute = createPiExecuteTool({
      prepared: {
        catalog: emptyCatalog("catalog-long-timeout"),
        execute: async (_source, timeoutMs) => {
          receivedTimeout = timeoutMs;
          return {
            executionId: "long-timeout-execution",
            value: null,
            calls: 0,
            durationMs: 0,
          };
        },
        close: async () => undefined,
      },
      turnId: "turn-long-timeout",
      signal: new AbortController().signal,
      emit: () => undefined,
    });

    await execute.execute(
      "long-timeout-call",
      { source: "return null;", timeoutMs: 3_600_000 },
      () => undefined,
      undefined,
      TEST_TOOL_INVOCATION,
      TODO_CONTEXT,
    );

    expect(receivedTimeout).toBe(3_600_000);
  });

  test("keeps a stable logical execution identity for retries within one turn", async () => {
    let logicalExecutionId: string | undefined;
    const execute = createPiExecuteTool({
      prepared: {
        catalog: emptyCatalog("catalog-logical-identity"),
        execute: async (_source, _timeoutMs, _signal, _emit, identity) => {
          logicalExecutionId = identity?.logicalExecutionId;
          return {
            executionId: "physical-execution",
            value: null,
            calls: 0,
            durationMs: 0,
          };
        },
        close: async () => undefined,
      },
      turnId: "turn-stable",
      signal: new AbortController().signal,
      emit: () => undefined,
    });

    await execute.execute(
      "stable-parent-call",
      { source: "return null;" },
      () => undefined,
      undefined,
      TEST_TOOL_INVOCATION,
      TODO_CONTEXT,
    );

    expect(logicalExecutionId).toBe("turn-stable:stable-parent-call");
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

  test("does not charge inactive catalog tools against the request budget", async () => {
    const base = frozenPlan();
    const { canonicalDigest: _digest, ...baseUnsigned } = base;
    const unsigned = Object.freeze({ ...baseUnsigned, requestTokenBudget: 12_000 });
    const plan = Object.freeze({ ...unsigned, canonicalDigest: frozenTurnPlanDigest(unsigned) });
    const catalog = catalogWithTools(
      "catalog-many-inactive-tools",
      Array.from({ length: 1_000 }, (_, index) => `inactive.tool-${index}`),
    );
    const codeExecution: PiCodeExecutionAdapter = Object.freeze({
      prepare: async () =>
        Object.freeze({
          catalog,
          invoke: async () => null,
          execute: async () =>
            Object.freeze({
              executionId: "unused-many-inactive-tools",
              value: null,
              calls: 0,
              durationMs: 1,
            }),
          close: async () => undefined,
        }),
      shutdown: async () => undefined,
    });
    const controlled = createControlledPiModels({
      respond: ({ context }) => {
        expect(context.tools?.map((tool) => tool.name).sort()).toEqual([
          "execute",
          "file_read",
          "file_write",
          "shell",
        ]);
        return "Only active tools were budgeted.";
      },
    });
    const runtime = createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution });

    await expect(
      runtime.run(
        {
          trailId: plan.sessionId,
          provider: plan.provider,
          model: plan.model,
          thinkingLevel: plan.thinkingLevel,
          systemPrompt: plan.renderedSystemPrompt,
          prompt: "Use only the active tools.",
          activeCapabilities: [],
          frozenTurnPlan: plan,
        },
        () => undefined,
      ),
    ).resolves.toMatchObject({ text: "Only active tools were budgeted.", outcome: "completed" });
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
    const runtime = createPiAgentRuntime(process.cwd(), controlled.models, {
      now: () => "2026-01-01T00:00:00.000Z",
    });

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
            catalog: emptyCatalog("catalog-close-failure"),
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
          emit({ type: "started", executionId: "execution-actions" });
          emit({
            type: "progress",
            value: { message: "Starting shell" },
            callId: "tool_call_nested-visible",
            name: "shell.run",
            callIndex: 0,
          });
          emit({
            type: "progress",
            value: { message: "x".repeat(500_000) },
            callId: "tool_call_nested-visible",
            name: "shell.run",
            callIndex: 0,
          });
          emit({
            type: "tool-start",
            callId: "tool_call_nested-visible",
            name: "shell.run",
            callIndex: 0,
            input: { command: "pwd" },
          });
          emit({
            type: "tool-end",
            callId: "tool_call_nested-visible",
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
          catalog: emptyCatalog("catalog-actions"),
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
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool-start",
          actionId: "call-execute-visible",
          name: "execute",
          input: { source: "return await tools.shell.run({ command: 'pwd' });" },
        }),
      ]),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool-start",
          actionId: "tool_call_nested-visible",
          parentActionId: "call-execute-visible",
          name: "shell.run",
          input: { command: "pwd" },
        }),
      ]),
    );
    expect(events).toContainEqual({
      type: "tool-end",
      actionId: "tool_call_nested-visible",
      parentActionId: "call-execute-visible",
      name: "shell.run",
      isError: false,
      result: { stdout: "/workspace" },
    });
    expect(events).toContainEqual({
      type: "tool-update",
      actionId: "tool_call_nested-visible",
      parentActionId: "call-execute-visible",
      name: "shell.run",
      update: { message: "Starting shell" },
    });
    const boundedNestedProgress = events.find(
      (event): event is Extract<AgentRuntimeEvent, { readonly type: "tool-update" }> =>
        event.type === "tool-update" &&
        event.actionId === "tool_call_nested-visible" &&
        isJsonObject(event.update) &&
        event.update["truncated"] === true,
    );
    expect(
      new TextEncoder().encode(JSON.stringify(boundedNestedProgress?.update)).byteLength,
    ).toBeLessThanOrEqual(256 * 1024);
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
      events
        .filter(
          (event): event is Extract<AgentRuntimeEvent, { readonly type: "tool-update" }> =>
            event.type === "tool-update" && event.actionId === "call-execute-visible",
        )
        .at(-1),
    ).toMatchObject({
      update: {
        kind: "activity",
        executionId: "execution-actions",
      },
    });
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

  test("acknowledges steering only when Pi injects the user message into the active loop", async () => {
    const responseStarted = Promise.withResolvers<void>();
    const releaseResponse = Promise.withResolvers<void>();
    let responses = 0;
    const controlled = createControlledPiModels({
      respond: async ({ lastUserText }) => {
        responses += 1;
        if (responses === 1) {
          responseStarted.resolve();
          await releaseResponse.promise;
        }
        return `response ${String(responses)} for ${lastUserText}`;
      },
    });
    const runtime = createPiAgentRuntime(process.cwd(), controlled.models, {
      now: () => "2026-01-01T00:00:00.000Z",
    });
    const events: AgentRuntimeEvent[] = [];
    const running = runtime.run(
      {
        trailId: "trail-steer-consumed",
        provider: CONTROLLED_PI_PROVIDER,
        model: CONTROLLED_PI_MODEL,
        thinkingLevel: "off",
        systemPrompt: "Follow steering messages.",
        prompt: "begin",
        activeCapabilities: [],
      },
      (event) => events.push(event),
    );
    await responseStarted.promise;

    const receipt = runtime.steer("trail-steer-consumed", "change direction");
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const beforeConsumption = await Promise.race([
      receipt.then(() => "settled" as const),
      new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
    ]);
    expect(beforeConsumption).toBe("pending");

    releaseResponse.resolve();
    await expect(receipt).resolves.toEqual({
      status: "consumed",
      timelineSequence: 2,
      consumedAt: "2026-01-01T00:00:00.000Z",
    });
    await expect(running).resolves.toMatchObject({ outcome: "completed" });
    expect(
      events.filter(
        (event): event is Extract<AgentRuntimeEvent, { readonly type: "assistant-message" }> =>
          event.type === "assistant-message",
      ),
    ).toEqual([
      {
        type: "assistant-message",
        text: "response 1 for begin",
        timelineSequence: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        type: "assistant-message",
        text: "response 2 for change direction",
        timelineSequence: 3,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect(responses).toBe(2);
  });

  test("finishes the active tool, skips later proposed tools, and steers before the next model request", async () => {
    const firstToolStarted = Promise.withResolvers<void>();
    const releaseFirstTool = Promise.withResolvers<void>();
    const secondRequestObserved = Promise.withResolvers<void>();
    const invoked: string[] = [];
    let secondRequestContext = "";
    let responses = 0;
    const controlled = createControlledPiModels({
      respond: ({ context, lastUserText }) => {
        responses += 1;
        if (responses === 1)
          return fauxAssistantMessage(
            [
              fauxToolCall("shell", { command: "first" }, { id: "call-active-tool" }),
              fauxToolCall("file_read", { path: "second" }, { id: "call-not-started-tool" }),
            ],
            { stopReason: "toolUse" },
          );
        secondRequestContext = JSON.stringify(context.messages);
        expect(lastUserText).toBe("change direction now");
        secondRequestObserved.resolve();
        return "Adjusted after steering.";
      },
    });
    const plan = frozenPlan();
    const invoke: NonNullable<PreparedPiCodeExecution["invoke"]> = async (name) => {
      invoked.push(name);
      if (name === "shell.run") {
        firstToolStarted.resolve();
        await releaseFirstTool.promise;
      }
      return Object.freeze({ name });
    };
    const codeExecution: PiCodeExecutionAdapter = Object.freeze({
      prepare: async () =>
        Object.freeze({
          catalog: emptyCatalog("catalog-steering-boundary"),
          invoke,
          execute: async () =>
            Object.freeze({
              executionId: "unused-steering-execute",
              value: null,
              calls: 0,
              durationMs: 0,
            }),
          close: async () => undefined,
        }),
      shutdown: async () => undefined,
    });
    const runtime = createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution });
    const events: AgentRuntimeEvent[] = [];
    const running = runtime.run(
      {
        trailId: plan.sessionId,
        provider: plan.provider,
        model: plan.model,
        thinkingLevel: plan.thinkingLevel,
        systemPrompt: plan.renderedSystemPrompt,
        prompt: "Start both operations.",
        activeCapabilities: [],
        frozenTurnPlan: plan,
      },
      (event) => events.push(event),
    );
    await firstToolStarted.promise;

    const receipt = runtime.steer(plan.sessionId, "change direction now");
    releaseFirstTool.resolve();

    await secondRequestObserved.promise;
    await expect(receipt).resolves.toMatchObject({ status: "consumed" });
    await expect(running).resolves.toMatchObject({
      outcome: "completed",
      text: "Adjusted after steering.",
    });
    expect(invoked).toEqual(["shell.run"]);
    expect(secondRequestContext).toContain("Skipped because a newer user steering message is pending.");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool-end",
        actionId: "direct:call-not-started-tool",
        name: "files.read",
        isError: true,
      }),
    );
    expect(responses).toBe(2);
  });

  test("settles queued steering as not consumed when the turn is aborted first", async () => {
    const responseStarted = Promise.withResolvers<void>();
    const releaseResponse = Promise.withResolvers<void>();
    const controlled = createControlledPiModels({
      respond: async () => {
        responseStarted.resolve();
        await releaseResponse.promise;
        return "must not consume the queued steer";
      },
    });
    const runtime = createPiAgentRuntime(process.cwd(), controlled.models, {
      now: () => "2026-01-01T00:00:00.000Z",
    });
    const running = runtime.run(
      {
        trailId: "trail-steer-aborted",
        provider: CONTROLLED_PI_PROVIDER,
        model: CONTROLLED_PI_MODEL,
        thinkingLevel: "off",
        systemPrompt: "Follow steering messages.",
        prompt: "begin",
        activeCapabilities: [],
      },
      () => undefined,
    );
    await responseStarted.promise;

    const receipt = runtime.steer("trail-steer-aborted", "never consumed");
    const aborting = runtime.abort("trail-steer-aborted");
    releaseResponse.resolve();

    await expect(receipt).resolves.toEqual({ status: "not-consumed", reason: "aborted" });
    await expect(running).resolves.toMatchObject({ outcome: "aborted" });
    await expect(aborting).resolves.toBeUndefined();
  });

  test("drains duplicate steering receipts together in Pi queue order", async () => {
    const firstResponseStarted = Promise.withResolvers<void>();
    const releaseFirstResponse = Promise.withResolvers<void>();
    const secondResponseStarted = Promise.withResolvers<void>();
    const releaseSecondResponse = Promise.withResolvers<void>();
    let responses = 0;
    const controlled = createControlledPiModels({
      respond: async () => {
        responses += 1;
        if (responses === 1) {
          firstResponseStarted.resolve();
          await releaseFirstResponse.promise;
        } else if (responses === 2) {
          secondResponseStarted.resolve();
          await releaseSecondResponse.promise;
        }
        return `response ${String(responses)}`;
      },
    });
    const runtime = createPiAgentRuntime(process.cwd(), controlled.models, {
      now: () => "2026-01-01T00:00:00.000Z",
    });
    const running = runtime.run(
      {
        trailId: "trail-duplicate-steers",
        provider: CONTROLLED_PI_PROVIDER,
        model: CONTROLLED_PI_MODEL,
        thinkingLevel: "off",
        systemPrompt: "Follow steering messages.",
        prompt: "same text",
        activeCapabilities: [],
      },
      () => undefined,
    );
    await firstResponseStarted.promise;

    const first = runtime.steer("trail-duplicate-steers", "same text");
    const second = runtime.steer("trail-duplicate-steers", "same text");
    releaseFirstResponse.resolve();

    await secondResponseStarted.promise;
    await expect(first).resolves.toEqual({
      status: "consumed",
      timelineSequence: 2,
      consumedAt: "2026-01-01T00:00:00.000Z",
    });
    await expect(second).resolves.toEqual({
      status: "consumed",
      timelineSequence: 3,
      consumedAt: "2026-01-01T00:00:00.000Z",
    });

    releaseSecondResponse.resolve();
    await expect(running).resolves.toMatchObject({ outcome: "completed" });
    expect(responses).toBe(2);
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
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
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

  test("rejects a complete request that exceeds its frozen budget before model invocation", async () => {
    const controlled = createControlledPiModels();
    const base = frozenPlan();
    const { canonicalDigest: _digest, ...baseUnsigned } = base;
    const unsigned = Object.freeze({ ...baseUnsigned, requestTokenBudget: 8 });
    const plan = Object.freeze({ ...unsigned, canonicalDigest: frozenTurnPlanDigest(unsigned) });
    const runtime = createPiAgentRuntime(process.cwd(), controlled.models, {
      codeExecution: controlledCodeExecution(
        {
          resolve: async (received) =>
            Object.freeze({
              planId: received.planId,
              canonicalDigest: received.canonicalDigest,
              consumedMaterials: frozenPlanMaterialUses(received),
              definitions: definitions("budgeted"),
            }),
        },
        "budgeted",
      ),
    });

    await expect(
      runtime.run(
        {
          trailId: plan.sessionId,
          provider: plan.provider,
          model: plan.model,
          thinkingLevel: plan.thinkingLevel,
          systemPrompt: plan.renderedSystemPrompt,
          prompt: "A current request that cannot fit.",
          activeCapabilities: [{ name: "Grounded", version: 1 }],
          frozenTurnPlan: plan,
        },
        () => undefined,
      ),
    ).resolves.toMatchObject({
      outcome: "failed",
      error: expect.stringContaining("complete request exceeds its token budget"),
    });
    expect(controlled.provider.state.callCount).toBe(0);
  });

  test("rejects token-dense multilingual input before model invocation", async () => {
    const controlled = createControlledPiModels();
    const base = frozenPlan();
    const { canonicalDigest: _digest, ...baseUnsigned } = base;
    const unsigned = Object.freeze({ ...baseUnsigned, requestTokenBudget: 600 });
    const plan = Object.freeze({ ...unsigned, canonicalDigest: frozenTurnPlanDigest(unsigned) });
    const runtime = createPiAgentRuntime(process.cwd(), controlled.models, {
      codeExecution: controlledCodeExecution(
        {
          resolve: async (received) =>
            Object.freeze({
              planId: received.planId,
              canonicalDigest: received.canonicalDigest,
              consumedMaterials: frozenPlanMaterialUses(received),
              definitions: definitions("token-dense"),
            }),
        },
        "token-dense",
      ),
    });

    await expect(
      runtime.run(
        {
          trailId: plan.sessionId,
          provider: plan.provider,
          model: plan.model,
          thinkingLevel: plan.thinkingLevel,
          systemPrompt: plan.renderedSystemPrompt,
          prompt: "界".repeat(1_000),
          activeCapabilities: [{ name: "Grounded", version: 1 }],
          frozenTurnPlan: plan,
        },
        () => undefined,
      ),
    ).resolves.toMatchObject({
      outcome: "failed",
      error: expect.stringContaining("complete request exceeds its token budget"),
    });
    expect(controlled.provider.state.callCount).toBe(0);
  });
});
