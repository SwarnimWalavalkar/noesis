import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  type AgentRuntimeEvent,
  type FrozenRevisionMaterial,
  type FrozenTurnPlan,
  frozenTurnPlanDigest,
} from "@noesis/agent-types";
import { canonicalJson, type FileRevisionRef, type JsonValue, sha256, toJsonValue } from "@noesis/domain";
import type { SessionToolDefinition, SessionToolName } from "@noesis/intelligence";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import {
  createAssistantDeltaAggregator,
  createHotbarToolAliases,
  createPiAgentRuntime,
  createPiExecuteTool,
  createPiHotbarTools,
  createPiSelfTools,
  type FrozenSessionToolResolver,
  frozenPlanMaterialUses,
  isProjectWorkflowToolForProject,
  isProjectWorkflowToolName,
  type PiCodeExecutionAdapter,
  type PiFrozenToolCatalog,
  type PiSelfToolAdapter,
  type PiSkillLibrary,
  PROJECT_WORKFLOW_TOOL_ADAPTER_REVISION,
  type PreparedPiCodeExecution,
  projectWorkflowExecutionCatalogDigest,
  projectWorkflowToolName,
  reconcileHotbarTools,
  resolveFrozenSessionToolDefinitions,
  resolvePiSkillInvocation,
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
  return Object.freeze({
    catalogId,
    catalogDigest: sha256(catalogId),
    tools: Object.freeze([]),
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

describe("agent runtime factories", () => {
  test("reconciles durable hotbar preferences with the current frozen catalog", () => {
    const catalog: PiFrozenToolCatalog = Object.freeze({
      catalogId: "catalog-reconciled-hotbar",
      catalogDigest: sha256("catalog-reconciled-hotbar"),
      tools: Object.freeze([
        Object.freeze({
          name: "files.read",
          label: "Read file",
          description: "Read a file",
          revisionId: "files-read-v1",
          inputSchema: Object.freeze({ type: "object" }),
          outputSchema: Object.freeze({ type: "object" }),
        }),
      ]),
    });

    expect(reconcileHotbarTools(catalog, ["files.read", "removed.tool", "files.read"])).toEqual({
      active: ["files.read"],
      unavailable: ["removed.tool"],
    });
  });

  test("recognizes exact project workflow tool identities", () => {
    const alpha = projectWorkflowToolName("project_alpha", "summarize");
    const beta = projectWorkflowToolName("project_beta", "summarize");

    expect(isProjectWorkflowToolName(alpha)).toBe(true);
    expect(isProjectWorkflowToolForProject("project_alpha", alpha)).toBe(true);
    expect(isProjectWorkflowToolForProject("project_alpha", beta)).toBe(false);
    expect(isProjectWorkflowToolName("workflows.run")).toBe(false);
    expect(isProjectWorkflowToolName("workflow.not-a-digest.summarize")).toBe(false);
  });

  test("assigns injective catalog aliases without shadowing core tools", () => {
    const catalog: PiFrozenToolCatalog = Object.freeze({
      catalogId: "catalog-aliases",
      catalogDigest: sha256("catalog-aliases"),
      tools: Object.freeze(
        ["files.read", "file_read", "history.search_sessions", "search_sessions", "adapt", "execute"].map(
          (name) =>
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

    const aliases = createHotbarToolAliases(catalog);
    const values = [...aliases.values()];

    expect(aliases.get("files.read")).toBe("file_read");
    expect(aliases.get("history.search_sessions")).toBe("search_sessions");
    expect(aliases.get("search_sessions")).not.toBe("search_sessions");
    expect(new Set(values).size).toBe(values.length);
    expect(values).not.toContain("adapt");
    expect(values).not.toContain("execute");
    expect([...createHotbarToolAliases(catalog)]).toEqual([...aliases]);
  });

  test("keeps scalar and array workflow hotbar parameters object-shaped", async () => {
    const scalarName = projectWorkflowToolName("project_hotbar_schema", "scalar");
    const arrayName = projectWorkflowToolName("project_hotbar_schema", "array");
    const catalog: PiFrozenToolCatalog = Object.freeze({
      catalogId: "catalog-workflow-hotbar-schema",
      catalogDigest: sha256("catalog-workflow-hotbar-schema"),
      tools: Object.freeze([
        Object.freeze({
          name: scalarName,
          label: "scalar",
          description: "Run a scalar workflow",
          revisionId: "tool-workflow-scalar-v1",
          inputSchema: Object.freeze({
            type: "object",
            properties: Object.freeze({ input: Object.freeze({ type: "number" }) }),
            required: Object.freeze(["input"]),
            additionalProperties: false,
          }),
          outputSchema: Object.freeze({ type: "number" }),
        }),
        Object.freeze({
          name: arrayName,
          label: "array",
          description: "Run an array workflow",
          revisionId: "tool-workflow-array-v1",
          inputSchema: Object.freeze({
            type: "object",
            properties: Object.freeze({
              input: Object.freeze({ type: "array", items: Object.freeze({ type: "number" }) }),
            }),
            required: Object.freeze(["input"]),
            additionalProperties: false,
          }),
          outputSchema: Object.freeze({ type: "array", items: Object.freeze({ type: "number" }) }),
        }),
      ]),
    });
    const invocations: Array<{ readonly name: string; readonly input: JsonValue }> = [];
    const prepared: PreparedPiCodeExecution = Object.freeze({
      catalog,
      invoke: async (name: string, input: JsonValue) => {
        invocations.push(Object.freeze({ name, input }));
        return input;
      },
      execute: async () => Object.freeze({ executionId: "unused", value: null, calls: 0, durationMs: 0 }),
      close: async () => undefined,
    });
    const tools = createPiHotbarTools({
      prepared,
      turnId: "turn-workflow-hotbar-schema",
      signal: new AbortController().signal,
      emit: () => undefined,
    });
    const scalar = tools.find((tool) => tool.name === "workflow_scalar");
    const array = tools.find((tool) => tool.name === "workflow_array");
    if (!scalar || !array) throw new Error("Expected friendly workflow hotbar aliases");

    await scalar.execute("scalar-call", { input: 7 });
    await array.execute("array-call", { input: [1, 2, 3] });

    expect(invocations).toEqual([
      { name: scalarName, input: { input: 7 } },
      { name: arrayName, input: { input: [1, 2, 3] } },
    ]);
    await expect(scalar.execute("invalid-scalar-call", 7)).rejects.toThrow();
    await expect(array.execute("invalid-array-call", [1, 2, 3])).rejects.toThrow();
  });

  test("validates hotbar input without applying JSON Schema defaults before Broker invocation", async () => {
    const catalog: PiFrozenToolCatalog = Object.freeze({
      catalogId: "catalog-hotbar-raw-input",
      catalogDigest: sha256("catalog-hotbar-raw-input"),
      tools: Object.freeze([
        Object.freeze({
          name: "test.defaults",
          label: "Defaults",
          description: "Exercise schema defaults",
          revisionId: "test-defaults-v1",
          inputSchema: Object.freeze({
            type: "object",
            properties: Object.freeze({
              mode: Object.freeze({ type: "string", default: "mutated" }),
            }),
            additionalProperties: false,
          }),
          outputSchema: Object.freeze({ type: "object" }),
        }),
      ]),
    });
    const inputs: JsonValue[] = [];
    const prepared: PreparedPiCodeExecution = Object.freeze({
      catalog,
      invoke: async (_name: string, input: JsonValue) => {
        inputs.push(input);
        return input;
      },
      execute: async () => Object.freeze({ executionId: "unused", value: null, calls: 0, durationMs: 0 }),
      close: async () => undefined,
    });
    const [tool] = createPiHotbarTools({
      prepared,
      turnId: "turn-hotbar-raw-input",
      signal: new AbortController().signal,
      emit: () => undefined,
    });
    if (!tool) throw new Error("Expected hotbar tool");
    const rawInput = {};

    await tool.execute("call-hotbar-raw-input", rawInput);

    expect(inputs).toEqual([{}]);
    expect(inputs[0]).toBe(rawInput);
  });

  test("pins the saved-workflow adapter revision into workflow execution catalogs", () => {
    const tools = Object.freeze([Object.freeze({ name: "files.read", revisionId: "tool-read-v1" })]);

    expect(projectWorkflowExecutionCatalogDigest(tools)).toBe(
      sha256(
        canonicalJson({
          tools,
          savedWorkflowAdapterRevision: PROJECT_WORKFLOW_TOOL_ADAPTER_REVISION,
        }),
      ),
    );
    expect(projectWorkflowExecutionCatalogDigest(tools)).not.toBe(sha256(canonicalJson(tools)));
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

  test("preserves prior conversation roles instead of promoting history into the system prompt", async () => {
    const controlled = createControlledPiModels({
      respond: ({ systemPrompt, context }) => {
        expect(systemPrompt).toBe("Stable system instruction.");
        expect(context.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
        return "History kept its roles.";
      },
    });
    const runtime = createPiAgentRuntime(process.cwd(), controlled.models);

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
    const controlled = createControlledPiModels({
      respond: ({ lastUserText }) => {
        expect(lastUserText).toBe(prompt);
        return "ordinary prompt";
      },
    });
    const runtime = createPiAgentRuntime(process.cwd(), controlled.models, {
      skills: {
        snapshot: async () => Object.freeze({ skills: Object.freeze([]), diagnostics: Object.freeze([]) }),
        pinSnapshot: async () => Object.freeze({ skills: Object.freeze([]), diagnostics: Object.freeze([]) }),
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

    await expect(execute.execute("cancelled", { source: "return null;" })).rejects.toThrow(
      "cancelled before start",
    );
    expect(executions).toBe(0);

    const active = new AbortController();
    const byteBounded = createPiExecuteTool({
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
      turnId: "turn-byte-bounded",
      signal: active.signal,
      emit: () => undefined,
    });
    await expect(byteBounded.execute("oversized", { source: "😀".repeat(40_000) })).rejects.toThrow(
      "UTF-8 bytes",
    );
    expect(byteBounded.description).toContain("return await noesis.search(query)");
    expect(byteBounded.description).toContain("return await noesis.describe(exactName)");
    expect(byteBounded.description).toContain("do not return that value to you");
    expect(byteBounded.description).toContain("a reusable project-local program would materially help");
    expect(byteBounded.description).toContain("script with scripts.save");
    expect(byteBounded.description).toContain("Do not defer executable project-local work");
    expect(byteBounded.description).toContain("Verify a new script immediately with scripts.run");
    expect(byteBounded.description).toContain("store(key, value)");
    expect(executions).toBe(0);
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

    await firstTurn.execute("stable-parent-call", { source: "return null;" });
    await secondTurn.execute("stable-parent-call", { source: "return null;" });

    expect(logicalExecutionIds).toEqual(["turn-one:stable-parent-call", "turn-two:stable-parent-call"]);
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

    await execute.execute("stable-parent-call", { source: "return null;" });

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
      applyHotbar: async () => undefined,
      adapter: {
        hotbar: async () => Object.freeze([]),
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
    expect(tools.map((tool) => tool.name)).toEqual(["inspect_self", "remember"]);

    await expect(inspect.execute("inspect", {})).rejects.toThrow("result exceeds");
    expect(observedSignal).toBeDefined();

    const toolCall = new AbortController();
    toolCall.abort("cancelled");
    await expect(
      remember.execute("remember", { memory: "m", scope: "turn", anticipatedUse: "later" }, toolCall.signal),
    ).rejects.toThrow("cancelled before execution");
  });

  test("passes the exact frozen tool catalog through inspect_self", async () => {
    const plan = frozenPlan();
    const catalog = Object.freeze({
      catalogId: "catalog-inspection",
      catalogDigest: sha256("catalog-inspection"),
      tools: Object.freeze([
        Object.freeze({
          name: "files.read",
          label: "Read file",
          description: "Read a text file",
          revisionId: "tool-files-read-v1",
          inputSchema: Object.freeze({ type: "object" as const }),
          outputSchema: Object.freeze({ type: "object" as const }),
        }),
      ]),
    });
    let inspectedCatalog: PiFrozenToolCatalog | undefined;
    const tools = createPiSelfTools({
      plan,
      request: {
        trailId: plan.sessionId,
        provider: plan.provider,
        model: plan.model,
        thinkingLevel: plan.thinkingLevel,
        systemPrompt: plan.renderedSystemPrompt,
        prompt: "Inspect tools.",
        activeCapabilities: [],
        frozenTurnPlan: plan,
      },
      signal: new AbortController().signal,
      catalog,
      applyHotbar: async () => undefined,
      adapter: {
        hotbar: async () => Object.freeze([]),
        inspect: async ({ catalog: received }) => {
          inspectedCatalog = received;
          return toJsonValue(received ?? null);
        },
        remember: async () => null,
        adapt: async () => null,
      },
    });
    const inspect = tools.find((tool) => tool.name === "inspect_self");
    if (!inspect) throw new Error("Expected inspect_self tool");

    const result = await inspect.execute("inspect-tools", { section: "tools" });

    expect(inspectedCatalog).toBe(catalog);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(catalog) }]);
    expect(inspect.description).toContain("exact frozen tool names");
  });

  test("keeps adapt focused on immediate toolbox changes and rejects proposal red tape", async () => {
    const plan = frozenPlan();
    const tools = createPiSelfTools({
      plan,
      request: {
        trailId: plan.sessionId,
        provider: plan.provider,
        model: plan.model,
        thinkingLevel: plan.thinkingLevel,
        systemPrompt: plan.renderedSystemPrompt,
        prompt: "Create a reusable tool.",
        activeCapabilities: [],
        frozenTurnPlan: plan,
      },
      signal: new AbortController().signal,
      catalog: emptyCatalog("catalog-adapt-contract"),
      applyHotbar: async () => undefined,
      adapter: {
        hotbar: async () => Object.freeze([]),
        inspect: async () => null,
        remember: async () => null,
        adapt: async () => null,
      },
    });
    const adapt = tools.find((tool) => tool.name === "adapt");
    if (!adapt) throw new Error("Expected adapt tool");

    expect(adapt.description).toContain("scripts.save");
    expect(adapt.description).toContain("workflows.save");
    expect(adapt.description).not.toContain("propose");
    await expect(
      adapt.execute("proposal", {
        action: "propose",
        target: "tool",
        change: "Add a tool",
        scope: "project",
        rationale: "Useful",
      }),
    ).rejects.toThrow();
  });

  test("activates a catalog tool through adapt for the next model step in the same turn", async () => {
    const plan = frozenPlan();
    const catalog: PiFrozenToolCatalog = Object.freeze({
      catalogId: "catalog-hotbar",
      catalogDigest: sha256("catalog-hotbar"),
      tools: Object.freeze([
        Object.freeze({
          name: "files.write",
          label: "Write file",
          description: "Write a UTF-8 file",
          revisionId: "tool-files-write-v1",
          inputSchema: Object.freeze({
            type: "object",
            properties: Object.freeze({
              path: Object.freeze({ type: "string" }),
              content: Object.freeze({ type: "string" }),
            }),
            required: Object.freeze(["path", "content"]),
            additionalProperties: false,
          }),
          outputSchema: Object.freeze({ type: "object" }),
        }),
      ]),
    });
    const invocations: { readonly name: string; readonly input: JsonValue }[] = [];
    const codeExecution: PiCodeExecutionAdapter = Object.freeze({
      prepare: async () => {
        const invoke: NonNullable<PreparedPiCodeExecution["invoke"]> = async (
          name,
          input,
          _signal,
          _identity,
          emitUpdate,
        ) => {
          invocations.push(Object.freeze({ name, input }));
          emitUpdate?.({ message: "Writing note" });
          return Object.freeze({ written: true });
        };
        return Object.freeze({
          catalog,
          invoke,
          execute: async () => {
            return Object.freeze({
              executionId: "unused-execution-hotbar",
              value: null,
              calls: 0,
              durationMs: 1,
            });
          },
          close: async () => undefined,
        });
      },
      shutdown: async () => undefined,
    });
    let step = 0;
    const controlled = createControlledPiModels({
      respond: ({ context }) => {
        step += 1;
        const visible = context.tools?.map((tool) => tool.name) ?? [];
        if (step === 1) {
          expect(visible).toEqual(["inspect_self", "remember", "adapt", "execute"]);
          return fauxAssistantMessage(
            fauxToolCall("adapt", { action: "add_tool", tool: "files.write" }, { id: "adapt-hotbar" }),
            { stopReason: "toolUse" },
          );
        }
        if (step === 2) {
          expect(visible).toContain("file_write");
          return fauxAssistantMessage(
            fauxToolCall("file_write", { path: "notes.txt", content: "hello" }, { id: "write-hotbar" }),
            { stopReason: "toolUse" },
          );
        }
        return "Hotbar write completed.";
      },
    });
    const selfTools: PiSelfToolAdapter = {
      hotbar: async () => Object.freeze([]),
      inspect: async () => null,
      remember: async () => null,
      adapt: async (input) => {
        if (input.action !== "add_tool") throw new Error("Expected add_tool");
        await input.applyHotbar([input.tool]);
        return toJsonValue({ status: "hotbar_updated", hotbar: [input.tool] });
      },
    };
    const runtime = createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution, selfTools });
    const events: AgentRuntimeEvent[] = [];

    const result = await runtime.run(
      {
        trailId: plan.sessionId,
        provider: plan.provider,
        model: plan.model,
        thinkingLevel: plan.thinkingLevel,
        systemPrompt: plan.renderedSystemPrompt,
        prompt: "Write a note.",
        activeCapabilities: [],
        frozenTurnPlan: plan,
      },
      (event) => events.push(event),
    );

    expect(result.text).toContain("Hotbar write completed.");
    expect(result.assistantMessages?.map((message) => message.text)).toEqual(["Hotbar write completed."]);
    expect(invocations).toEqual([{ name: "files.write", input: { path: "notes.txt", content: "hello" } }]);
    expect(events.flatMap((event) => (event.type === "tool-start" ? [event.name] : []))).toEqual([
      "adapt",
      "files.write",
    ]);
    expect(events.flatMap((event) => (event.type === "assistant-message" ? [event.text] : []))).toEqual([
      "Hotbar write completed.",
    ]);
    expect(events).toContainEqual({
      type: "tool-update",
      actionId: "direct:write-hotbar",
      name: "files.write",
      update: { message: "Writing note" },
      recordedByBroker: true,
    });
  });

  test("rechecks the complete request budget after same-turn hotbar activation", async () => {
    const base = frozenPlan();
    const { canonicalDigest: _digest, ...baseUnsigned } = base;
    const unsigned = Object.freeze({ ...baseUnsigned, requestTokenBudget: 12_000 });
    const plan = Object.freeze({ ...unsigned, canonicalDigest: frozenTurnPlanDigest(unsigned) });
    const catalog: PiFrozenToolCatalog = Object.freeze({
      catalogId: "catalog-oversized-hotbar-tool",
      catalogDigest: sha256("catalog-oversized-hotbar-tool"),
      tools: Object.freeze([
        Object.freeze({
          name: "files.large-schema",
          label: "Large schema",
          description: "Schema material ".repeat(4_000),
          revisionId: "files-large-schema-v1",
          inputSchema: Object.freeze({ type: "object" }),
          outputSchema: Object.freeze({ type: "object" }),
        }),
      ]),
    });
    const codeExecution: PiCodeExecutionAdapter = Object.freeze({
      prepare: async () =>
        Object.freeze({
          catalog,
          invoke: async () => null,
          execute: async () =>
            Object.freeze({
              executionId: "unused-oversized-hotbar-tool",
              value: null,
              calls: 0,
              durationMs: 1,
            }),
          close: async () => undefined,
        }),
      shutdown: async () => undefined,
    });
    const controlled = createControlledPiModels({
      respond: () =>
        fauxAssistantMessage(
          fauxToolCall(
            "adapt",
            { action: "add_tool", tool: "files.large-schema" },
            { id: "adapt-large-schema" },
          ),
          { stopReason: "toolUse" },
        ),
    });
    const selfTools: PiSelfToolAdapter = {
      hotbar: async () => Object.freeze([]),
      inspect: async () => null,
      remember: async () => null,
      adapt: async (input) => {
        if (input.action !== "add_tool") throw new Error("Expected add_tool");
        await input.applyHotbar([input.tool]);
        return toJsonValue({ status: "hotbar_updated", hotbar: [input.tool] });
      },
    };
    const runtime = createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution, selfTools });

    await expect(
      runtime.run(
        {
          trailId: plan.sessionId,
          provider: plan.provider,
          model: plan.model,
          thinkingLevel: plan.thinkingLevel,
          systemPrompt: plan.renderedSystemPrompt,
          prompt: "Activate the large schema.",
          activeCapabilities: [],
          frozenTurnPlan: plan,
        },
        () => undefined,
      ),
    ).resolves.toMatchObject({
      outcome: "failed",
      error: expect.stringContaining("complete request exceeds its token budget"),
    });
    expect(controlled.provider.state.callCount).toBe(1);
  });

  test("ignores unavailable persisted hotbar entries without blocking the turn", async () => {
    const plan = frozenPlan();
    const catalog: PiFrozenToolCatalog = Object.freeze({
      catalogId: "catalog-stale-hotbar",
      catalogDigest: sha256("catalog-stale-hotbar"),
      tools: Object.freeze([
        Object.freeze({
          name: "files.read",
          label: "Read file",
          description: "Read a file",
          revisionId: "files-read-v1",
          inputSchema: Object.freeze({ type: "object" }),
          outputSchema: Object.freeze({ type: "object" }),
        }),
      ]),
    });
    const codeExecution: PiCodeExecutionAdapter = Object.freeze({
      prepare: async () =>
        Object.freeze({
          catalog,
          invoke: async () => null,
          execute: async () =>
            Object.freeze({
              executionId: "unused-stale-hotbar",
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
        expect(context.tools?.map((tool) => tool.name)).toEqual([
          "inspect_self",
          "remember",
          "adapt",
          "execute",
          "file_read",
        ]);
        return "Stale preference reconciled.";
      },
    });
    const selfTools: PiSelfToolAdapter = Object.freeze({
      hotbar: async () => Object.freeze(["files.read", "removed.tool"]),
      inspect: async () => null,
      remember: async () => null,
      adapt: async () => null,
    });
    const runtime = createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution, selfTools });

    await expect(
      runtime.run(
        {
          trailId: plan.sessionId,
          provider: plan.provider,
          model: plan.model,
          thinkingLevel: plan.thinkingLevel,
          systemPrompt: plan.renderedSystemPrompt,
          prompt: "Continue despite stale hotbar entries.",
          activeCapabilities: [],
          frozenTurnPlan: plan,
        },
        () => undefined,
      ),
    ).resolves.toMatchObject({ text: "Stale preference reconciled.", outcome: "completed" });
  });

  test("does not charge inactive catalog tools against the request budget", async () => {
    const base = frozenPlan();
    const { canonicalDigest: _digest, ...baseUnsigned } = base;
    const unsigned = Object.freeze({ ...baseUnsigned, requestTokenBudget: 12_000 });
    const plan = Object.freeze({ ...unsigned, canonicalDigest: frozenTurnPlanDigest(unsigned) });
    const catalog: PiFrozenToolCatalog = Object.freeze({
      catalogId: "catalog-many-inactive-tools",
      catalogDigest: sha256("catalog-many-inactive-tools"),
      tools: Object.freeze(
        Array.from({ length: 1_000 }, (_, index) =>
          Object.freeze({
            name: `inactive.tool-${index}`,
            label: `Inactive tool ${index}`,
            description: "A frozen catalog tool that is not active in this turn.",
            revisionId: `inactive-tool-${index}-v1`,
            inputSchema: Object.freeze({ type: "object" }),
            outputSchema: Object.freeze({ type: "object" }),
          }),
        ),
      ),
    });
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
        expect(context.tools?.map((tool) => tool.name)).toEqual([
          "inspect_self",
          "remember",
          "adapt",
          "execute",
        ]);
        return "Only active tools were budgeted.";
      },
    });
    const selfTools: PiSelfToolAdapter = Object.freeze({
      hotbar: async () => Object.freeze([]),
      inspect: async () => null,
      remember: async () => null,
      adapt: async () => null,
    });
    const runtime = createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution, selfTools });

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
        typeof event.update === "object" &&
        event.update !== null &&
        Reflect.get(event.update, "truncated") === true,
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

  test("matches duplicate steering receipts in Pi queue order", async () => {
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
    const secondBeforeItsTurn = await Promise.race([
      second.then(() => "settled" as const),
      new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
    ]);
    expect(secondBeforeItsTurn).toBe("pending");

    releaseSecondResponse.resolve();
    await expect(second).resolves.toEqual({
      status: "consumed",
      timelineSequence: 4,
      consumedAt: "2026-01-01T00:00:00.000Z",
    });
    await expect(running).resolves.toMatchObject({ outcome: "completed" });
    expect(responses).toBe(3);
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
