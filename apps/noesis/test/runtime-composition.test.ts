import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type AgentRuntimeEvent,
  type AgentRuntimeRequest,
  type FrozenTurnPlan,
  frozenTurnPlanDigest,
  type NoesisAgentRuntime,
} from "@noesis/agent-types";
import { resolveNoesisConfig } from "@noesis/config";
import {
  createConditionalObject,
  EvidenceRevisionRefSchema,
  eventChecksum,
  type FileRevisionRef,
  type JsonValue,
  type LedgerEvent,
  type ProjectRef,
  sha256,
} from "@noesis/domain";
import { createMcpHostManager, type LoadedMcpConfig, type McpOAuthCredentialStore } from "@noesis/mcp";
import {
  createPiAgentRoleRunner,
  createPiAgentRuntime,
  createPiSkillLibrary,
  createRestrictedRoleContextPolicy,
  createStructuredInferencePort,
  type FrozenSessionToolResolver,
  type PiFrozenToolCatalog,
  type RoleBackendRequest,
} from "@noesis/runtime-pi";
import { createTuiMcpInteractionBridge } from "@noesis/tui";
import { createWorkspaceStore } from "@noesis/workspace";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";
import {
  CONTROLLED_PI_MODEL,
  CONTROLLED_PI_PROVIDER,
  controlledToolCallResponse,
  createControlledPiModels,
} from "../../../packages/runtime-pi/test/support/controlled-pi-models.ts";
import { createScriptedAgentRoleRunner } from "../../../packages/runtime-pi/test/support/scripted-role-runner.ts";
import { createWorkspaceRuntimeInternals } from "../../../packages/workspace/src/protected-runtime.ts";
import { createApplicationMcpIntegration } from "../src/mcp-integration.ts";
import {
  type ApplicationRuntimeCompositionOptions,
  createApplicationRuntimeComposition,
  createModelHistoryRerankPort,
  waitForReflectionBarrier,
} from "../src/runtime-composition.ts";
import { researchLoopControlledResponse } from "./support/research-loop-controlled-response.ts";
const roots: string[] = [];
function frozenHistoryForRequest(request: AgentRuntimeRequest): NonNullable<AgentRuntimeRequest["history"]> {
  if (!request.frozenTurnPlan) return Object.freeze([...(request.history ?? [])]);
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  return Object.freeze([
    ...(request.frozenTurnPlan.contextCheckpoint
      ? [
          Object.freeze({
            role: "assistant" as const,
            content: request.frozenTurnPlan.contextCheckpoint.summary,
            createdAt: request.frozenTurnPlan.contextCheckpoint.createdAt,
          }),
        ]
      : []),
    ...(request.frozenTurnPlan.conversationHistory ?? []).map(({ role, content, createdAt }) =>
      Object.freeze({ role, content, createdAt }),
    ),
  ]);
}
function scriptedHistoryRerankResponse(request: RoleBackendRequest): {
  readonly text: string;
} {
  const response = researchLoopControlledResponse({
    systemPrompt: request.systemPrompt,
    lastUserText: request.prompt,
    context: { messages: [] },
  });
  if (typeof response !== "string") throw new Error("Controlled history reranker must return text");
  return Object.freeze({ text: response });
}
test("model history reranking can select a candidate beyond the first fifty", async () => {
  const promptRevision: FileRevisionRef = Object.freeze({
    kind: "file_revision",
    revisionId: "history-reranker-prompt-revision",
    workingPath: "prompts/history-reranker.md",
    snapshotPath: "snapshots/history-reranker.md",
    contentDigest: sha256("history-reranker-prompt"),
  });
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  const configuration = Object.freeze({
    role: "history_reranker" as const,
    variant: Object.freeze({
      variantId: "history-reranker-boundary-v1",
      axis: "role" as const,
      configurationRefs: Object.freeze([promptRevision]),
    }),
    provider: "controlled",
    model: "controlled",
    reasoning: "off" as const,
    systemPrompt: "Noesis protected role: history_reranker.",
    contextPolicy: createRestrictedRoleContextPolicy("history_reranker", {
      maxMessages: 12,
      maxCharactersPerMessage: 12000,
      maxTotalCharacters: 48000,
    }),
  });
  const runner = createScriptedAgentRoleRunner({
    variants: [configuration],
    respond: scriptedHistoryRerankResponse,
  });
  const reranker = createModelHistoryRerankPort({
    inference: createStructuredInferencePort({ runner }),
    configuration,
  });
  const candidates = Array.from({ length: 100 }, (_, index) =>
    Object.freeze({
      documentId: `document-${String(index).padStart(3, "0")}`,
      excerpt: `Bounded candidate ${String(index)}. ${'"\\\n'.repeat(240)}`,
      combinedScore: 100 - index,
    }),
  );
  const result = await reranker.rerank({
    query: "Select the final candidate",
    candidates,
    maxResults: 1,
  });
  expect(result).toEqual([
    {
      documentId: "document-099",
      reason: "Controlled reverse rank 1 for document-099.",
    },
  ]);
});
test("a reflection barrier read failure cannot fail an already-settled turn", async () => {
  await expect(
    waitForReflectionBarrier(
      {
        waitForTerminal: async () => {
          throw new Error("reflection read model unavailable");
        },
      },
      "job-reflection-settled",
    ),
  ).resolves.toBeUndefined();
});
const recoveryTurnPlan = (sessionId: string, turnId: string): FrozenTurnPlan => {
  const body: Omit<FrozenTurnPlan, "canonicalDigest"> = {
    schemaVersion: 1,
    planId: `plan-${turnId}`,
    sessionId,
    turnId,
    activationId: "activation_genesis",
    activationRevision: 1,
    selectedCapabilities: [],
    renderedSystemPrompt: "Noesis recovery fixture",
    provider: CONTROLLED_PI_PROVIDER,
    model: CONTROLLED_PI_MODEL,
    thinkingLevel: "off",
    permissionSnapshot: { effects: [], resourcePatterns: [], credentialRefs: [] },
    retrievalCitations: [],
    routing: { strategyId: "baseline", reason: "Recovery fixture" },
    createdAt: "2026-07-26T00:00:00.000Z",
  };
  return Object.freeze({ ...body, canonicalDigest: frozenTurnPlanDigest(body) });
};
async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for runtime interaction");
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});
async function writeLegacyCompletedTurn(
  home: string,
  runtimeIdentity: string,
): Promise<{
  readonly trailId: string;
  readonly input: string;
  readonly output: string;
}> {
  const trailId = "trail-legacy-import";
  const input = "Preserve this legitimate history";
  const output = "Imported legacy completion";
  const unsignedStart: Omit<LedgerEvent, "checksum"> = {
    schemaVersion: 1,
    eventId: "event-legacy-start",
    sequence: 1,
    occurredAt: "2026-01-01T00:00:00.000Z",
    principal: "foreground",
    type: "trail.started",
    trailId,
    payload: {
      title: "Legacy import",
      provider: CONTROLLED_PI_PROVIDER,
      model: CONTROLLED_PI_MODEL,
      runtime: runtimeIdentity,
    },
    previousChecksum: null,
  };
  const start: LedgerEvent = { ...unsignedStart, checksum: eventChecksum(unsignedStart) };
  const unsignedTurn: Omit<LedgerEvent, "checksum"> = {
    schemaVersion: 1,
    eventId: "event-legacy-turn",
    sequence: 2,
    occurredAt: "2026-01-01T00:01:00.000Z",
    principal: "foreground",
    type: "turn.completed",
    trailId,
    payload: { input, output },
    previousChecksum: start.checksum,
  };
  const turn: LedgerEvent = { ...unsignedTurn, checksum: eventChecksum(unsignedTurn) };
  await mkdir(join(home, "ledger"), { recursive: true });
  await writeFile(
    join(home, "ledger", "events.jsonl"),
    `${[start, turn].map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
  return Object.freeze({ trailId, input, output });
}
describe("apps/noesis production control-plane composition", () => {
  test("compacts durable history into a frozen checkpoint while preserving the complete transcript", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-context-compaction-"));
    roots.push(home);
    const resolved = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const config = Object.freeze({
      ...resolved,
      context: Object.freeze({ tokenBudget: 50000 }),
      learning: Object.freeze({ ...resolved.learning, enabled: false }),
    });
    const histories: NonNullable<AgentRuntimeRequest["history"]>[] = [];
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const agent: NoesisAgentRuntime = Object.freeze({
      name: "controlled-compaction-agent",
      run: async (request: AgentRuntimeRequest, emit: (event: AgentRuntimeEvent) => void) => {
        const history = frozenHistoryForRequest(request);
        histories.push(history);
        emit({ type: "status", status: "started" });
        const text = request.prompt.includes("short manual")
          ? "short answer"
          : history.length === 0
            ? "assistant-history-".repeat(6000)
            : "continued from checkpoint";
        const createdAt = new Date().toISOString();
        emit({
          type: "assistant-message",
          text,
          timelineSequence: 1,
          createdAt,
        });
        emit({ type: "status", status: "completed" });
        // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
        return Object.freeze({
          outcome: "completed" as const,
          stopReason: "stop" as const,
          text,
          assistantMessages: Object.freeze([Object.freeze({ text, timelineSequence: 1, createdAt })]),
          provider: request.provider,
          model: request.model,
        });
      },
      steer: async () => Object.freeze({ status: "not-consumed" as const, reason: "not-running" as const }),
      abort: async () => undefined,
    });
    const runtime = await createApplicationRuntimeComposition({
      config,
      agent,
      resolveModelContext: () => Object.freeze({ contextWindow: 60000, maxOutputTokens: 1000 }),
      createRoleRunner: (configurations) =>
        createScriptedAgentRoleRunner({
          variants: configurations,
          respond: (request) =>
            request.systemPrompt.includes("role: session_compactor")
              ? Object.freeze({
                  text: JSON.stringify({
                    goal: "Continue the established session task.",
                    constraints: [],
                    completedWork: ["The first turn completed."],
                    currentState: "Ready for the next request.",
                    decisions: [],
                    blockers: [],
                    nextSteps: [],
                    criticalReferences: [],
                  }),
                  usage: Object.freeze({
                    inputTokens: 400,
                    outputTokens: 80,
                    totalTokens: 480,
                    estimatedCost: 0,
                  }),
                })
              : Object.freeze({
                  text: '{"observation":{"kind":"other","reason":"No learning."},"decision":"no_change","reason":"No change."}',
                }),
        }),
    });
    const shortTrail = await runtime.startTrail({ title: "Manual compaction below threshold" });
    await runtime.debug.runTurn(shortTrail.trailId, "short manual context");
    await runtime.compact(shortTrail.trailId);
    await expect(
      runtime.debug.workspace.operational.contextCheckpoints.getActive(shortTrail.trailId),
    ).resolves.toMatchObject({ sources: expect.arrayContaining([expect.objectContaining({})]) });
    const trail = await runtime.startTrail({ title: "Context compaction" });
    const firstInput = "user-history-".repeat(5000);
    await runtime.debug.runTurn(trail.trailId, firstInput);
    await runtime.compact(trail.trailId);
    const checkpoint = await runtime.debug.workspace.operational.contextCheckpoints.getActive(trail.trailId);
    expect(checkpoint).toMatchObject({
      provider: CONTROLLED_PI_PROVIDER,
      model: CONTROLLED_PI_MODEL,
    });
    expect(checkpoint).not.toHaveProperty("previousCheckpointId");
    expect(checkpoint?.sources).toHaveLength(2);
    const transcript = await runtime.getTranscript(trail.trailId);
    expect(transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "message", role: "user", text: firstInput }),
        expect.objectContaining({
          kind: "message",
          role: "assistant",
          text: "assistant-history-".repeat(6000),
        }),
      ]),
    );
    const second = await runtime.debug.runTurn(trail.trailId, "Continue after compaction.");
    const secondHistory = histories.at(-1);
    expect(second.frozenTurnPlan).toMatchObject({
      contextCheckpoint: { checkpointId: checkpoint?.checkpointId },
      contextTokenBudget: expect.any(Number),
      conversationHistory: [],
    });
    expect(second.frozenTurnPlan?.contextTokenBudget).toBeLessThanOrEqual(checkpoint?.tokenBudget ?? 0);
    expect(secondHistory).toEqual([
      expect.objectContaining({ role: "assistant", content: expect.stringContaining("CONTEXT CHECKPOINT") }),
    ]);
    const automaticTrail = await runtime.startTrail({ title: "Automatic context compaction" });
    await runtime.debug.runTurn(automaticTrail.trailId, firstInput);
    const automaticTurn = await runtime.debug.runTurn(
      automaticTrail.trailId,
      "Continue after automatic compaction.",
    );
    const automaticHistory = histories.at(-1);
    expect(automaticTurn.frozenTurnPlan?.contextCheckpoint?.checkpointId).toBe(
      (await runtime.debug.workspace.operational.contextCheckpoints.getActive(automaticTrail.trailId))
        ?.checkpointId,
    );
    expect(automaticHistory).toEqual([
      expect.objectContaining({ role: "assistant", content: expect.stringContaining("CONTEXT CHECKPOINT") }),
    ]);
    await runtime.shutdown();
  });
  test("rejects sensitive compaction before inference", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-sensitive-compaction-"));
    roots.push(home);
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    let compactorRuns = 0;
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const runtime = await createApplicationRuntimeComposition({
      config: Object.freeze({
        ...config,
        learning: Object.freeze({ ...config.learning, enabled: false }),
      }),
      agent: Object.freeze({
        name: "sensitive-compaction-agent",
        run: async () => {
          throw new Error("Foreground agent should not run");
        },
        steer: async () => Object.freeze({ status: "not-consumed" as const, reason: "not-running" as const }),
        abort: async () => undefined,
      }),
      createRoleRunner: (configurations) =>
        createScriptedAgentRoleRunner({
          variants: configurations,
          respond: (request) => {
            if (request.systemPrompt.includes("role: session_compactor")) compactorRuns += 1;
            return scriptedHistoryRerankResponse(request);
          },
        }),
    });
    const trail = await runtime.startTrail({ title: "Sensitive context" });
    const inherited = Object.freeze({
      replayEligible: true,
      historyKind: "turn",
      historyTurnKey: "sensitive-turn",
      inheritedFromSessionId: "source-session",
    });
    await runtime.debug.workspace.operational.messages.put({
      messageId: "sensitive-user",
      sessionId: trail.trailId,
      role: "user",
      content: "Private source material",
      sensitivity: "private",
      createdAt: "2026-08-13T00:00:00.000Z",
      metadata: Object.freeze({ ...inherited, historySequence: 0, inheritedFromMessageId: "source-user" }),
    });
    await runtime.debug.workspace.operational.messages.put({
      messageId: "sensitive-assistant",
      sessionId: trail.trailId,
      role: "assistant",
      content: "Private answer",
      sensitivity: "private",
      createdAt: "2026-08-13T00:00:01.000Z",
      metadata: Object.freeze({
        ...inherited,
        historySequence: 1,
        inheritedFromMessageId: "source-assistant",
      }),
    });
    await expect(runtime.compact(trail.trailId)).rejects.toThrow("cannot send private");
    expect(compactorRuns).toBe(0);
    await expect(
      runtime.debug.workspace.operational.contextCheckpoints.getActive(trail.trailId),
    ).resolves.toBeUndefined();
    await runtime.shutdown();
  });
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  test("shutdown cancels and settles compaction before closing the workspace", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-compaction-shutdown-"));
    roots.push(home);
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    let notifyCompactorStarted: (() => void) | undefined;
    const compactorStarted = new Promise<void>((resolve) => {
      notifyCompactorStarted = resolve;
    });
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const runtime = await createApplicationRuntimeComposition({
      config: Object.freeze({
        ...config,
        learning: Object.freeze({ ...config.learning, enabled: false }),
      }),
      agent: Object.freeze({
        name: "shutdown-compaction-agent",
        run: async () => {
          throw new Error("Foreground agent should not run");
        },
        steer: async () => Object.freeze({ status: "not-consumed" as const, reason: "not-running" as const }),
        abort: async () => undefined,
      }),
      createRoleRunner: (configurations) =>
        createScriptedAgentRoleRunner({
          variants: configurations,
          respond: (request) => {
            if (request.systemPrompt.includes("role: session_compactor")) {
              notifyCompactorStarted?.();
              return Object.freeze({
                text: JSON.stringify({
                  goal: "Preserve context.",
                  constraints: [],
                  completedWork: [],
                  currentState: "Compacting.",
                  decisions: [],
                  blockers: [],
                  nextSteps: [],
                  criticalReferences: [],
                }),
                latencyMs: 5000,
              });
            }
            return scriptedHistoryRerankResponse(request);
          },
        }),
    });
    const trail = await runtime.startTrail({ title: "Shutdown compaction" });
    const inherited = Object.freeze({
      replayEligible: true,
      historyKind: "turn",
      historyTurnKey: "shutdown-turn",
      inheritedFromSessionId: "source-session",
    });
    for (const [index, role] of (["user", "assistant"] as const).entries())
      await runtime.debug.workspace.operational.messages.put({
        messageId: `shutdown-${role}`,
        sessionId: trail.trailId,
        role,
        content: `${role} context`,
        sensitivity: "normal",
        createdAt: `2026-08-13T00:00:0${String(index)}.000Z`,
        metadata: Object.freeze({
          ...inherited,
          historySequence: index,
          inheritedFromMessageId: `source-${role}`,
        }),
      });
    const compacting = runtime.compact(trail.trailId);
    void compacting.catch(() => undefined);
    await compactorStarted;
    await runtime.shutdown();
    await expect(compacting).rejects.toThrow();
    const reopened = await createWorkspaceStore(home);
    await expect(reopened.operational.contextCheckpoints.getActive(trail.trailId)).resolves.toBeUndefined();
    reopened.close();
  });
  test("shuts down composed resources when MCP startup rejects", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-mcp-start-failure-"));
    roots.push(home);
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const loadedMcpConfig: LoadedMcpConfig = Object.freeze({
      global: Object.freeze({ servers: Object.freeze({}) }),
      project: Object.freeze({ servers: Object.freeze({}) }),
      servers: new Map(),
      installed: Object.freeze([]),
    });
    const credentials: McpOAuthCredentialStore = Object.freeze({
      read: async () => undefined,
      write: async () => undefined,
      update: async () => undefined,
      delete: async () => undefined,
      deleteIf: async () => undefined,
    });
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const host = createMcpHostManager({
      home,
      projectDirectory: home,
      config: loadedMcpConfig,
      credentials,
      handlers: Object.freeze({
        sample: async () => {
          throw new Error("sampling is not expected");
        },
        elicit: async () => ({ action: "decline" as const }),
        onOAuthRedirect: () => undefined,
      }),
    });
    let closes = 0;
    const mcp: NonNullable<ApplicationRuntimeCompositionOptions["mcp"]> = Object.freeze({
      host,
      start: async () => {
        throw new Error("controlled MCP startup failure");
      },
      close: async () => {
        closes += 1;
        await host.close();
      },
      listMcpServers: async () => Object.freeze([]),
      inspectMcpServer: async () => undefined,
      mutateMcp: async () => Object.freeze({ message: "unused" }),
      setSamplingAuthorizer: () => undefined,
      setLifecycleAuthorizer: () => undefined,
    });
    const controlled = createControlledPiModels();
    await expect(
      createApplicationRuntimeComposition({
        config,
        mcp,
        agent: createPiAgentRuntime(home, controlled.models),
        createRoleRunner: (configurations) =>
          createPiAgentRoleRunner(home, controlled.models, configurations),
      }),
    ).rejects.toThrow("controlled MCP startup failure");
    expect(closes).toBe(1);
  });
  test("persists and replays a large MCP result without host projection", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-mcp-large-result-"));
    const projectRoot = join(home, "project");
    const executionMarker = join(home, "large-result-calls");
    roots.push(home);
    await mkdir(projectRoot, { recursive: true });
    const fixture = join(import.meta.dirname, "../../../packages/mcp/test/fixtures/server.mjs");
    await writeFile(
      join(home, "mcp.json"),
      JSON.stringify({
        servers: {
          controlled: {
            type: "local",
            command: process.execPath,
            args: [fixture, "--large-result-bytes=307200", `--large-result-marker=${executionMarker}`],
          },
        },
      }),
    );
    const resolved = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const config = Object.freeze({
      ...resolved,
      learning: Object.freeze({ ...resolved.learning, enabled: false }),
    });
    const project: ProjectRef = Object.freeze({ projectId: "project_mcp_large", root: projectRoot });
    const returned: JsonValue[] = [];
    const controlled = createControlledPiModels();
    const compose = async () => {
      const mcp = createApplicationMcpIntegration({
        home,
        projectDirectory: projectRoot,
        sampling: Object.freeze({
          sample: async () => {
            throw new Error("Sampling is not expected");
          },
        }),
        interactions: createTuiMcpInteractionBridge(),
        openUrl: async () => undefined,
        workspaceTrusted: true,
      });
      // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
      return await createApplicationRuntimeComposition({
        config,
        project,
        mcp,
        createAgent: (_sessionTools, codeExecution) =>
          Object.freeze({
            name: "mcp-large-result-agent",
            run: async (request: AgentRuntimeRequest, emit: (event: AgentRuntimeEvent) => void) => {
              const plan = request.frozenTurnPlan;
              if (!plan) throw new Error("Expected a frozen plan");
              emit({ type: "status", status: "started" });
              const controller = new AbortController();
              const prepared = await codeExecution.prepare(plan, controller.signal);
              try {
                const tool = prepared.catalog.tools.find((entry) =>
                  entry.name.startsWith("mcp.controlled.large-result"),
                );
                if (!tool || !prepared.invoke) throw new Error("Expected the controlled large MCP tool");
                returned.push(
                  await prepared.invoke(tool.name, {}, controller.signal, {
                    executionId: `direct:${plan.turnId}`,
                    logicalExecutionId: "mcp-large-result-restart",
                    callId: "mcp-large-result-restart-call",
                  }),
                );
                emit({ type: "status", status: "completed" });
                // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
                return Object.freeze({
                  outcome: "completed" as const,
                  stopReason: "stop" as const,
                  text: "MCP large result returned.",
                  provider: request.provider,
                  model: request.model,
                });
              } finally {
                await prepared.close();
              }
            },
            steer: async () =>
              Object.freeze({ status: "not-consumed" as const, reason: "not-running" as const }),
            abort: async () => undefined,
          }),
        createRoleRunner: (configurations) =>
          createPiAgentRoleRunner(projectRoot, controlled.models, configurations),
      });
    };
    const invokeOnce = async (title: string): Promise<void> => {
      const runtime = await compose();
      try {
        const trail = await runtime.startTrail({ title });
        await runtime.debug.runTurn(trail.trailId, "Call the large MCP tool.");
      } finally {
        await runtime.shutdown();
      }
    };
    await invokeOnce("Large MCP result before restart");
    expect(returned).toHaveLength(1);
    const returnedResult = z
      .strictObject({
        content: z.array(z.strictObject({ type: z.string(), text: z.string() })),
        isError: z.boolean().optional(),
      })
      .passthrough()
      .parse(returned[0]);
    expect(returnedResult.content[0]?.text).toHaveLength(307200);
    expect(await readFile(executionMarker, "utf8")).toBe("called\n");
    const workspace = await createWorkspaceStore(home);
    try {
      const database = new DatabaseSync(workspace.unsafeDatabasePathForTesting);
      try {
        const toolOperation = z
          .strictObject({
            operation_id: z.string(),
            idempotency_key: z.string(),
            effect: z.enum(["read", "write", "execute", "network", "promote", "schedule"]),
            resource: z.string(),
            request_digest: z.string(),
            estimated_cost: z.number(),
            result_json: z.string(),
          })
          .parse(
            database
              .prepare(`SELECT operation_id, idempotency_key, effect, resource, request_digest,
                        estimated_cost, result_json
                 FROM authority_operations
                 WHERE resource LIKE 'mcp:%:tool:large-result'`)
              .get(),
          );
        const resultJson = toolOperation.result_json;
        expect(Buffer.byteLength(resultJson, "utf8")).toBeGreaterThan(307200);
        const durableResult = z
          .strictObject({
            content: z.array(z.strictObject({ type: z.string(), text: z.string() })),
            isError: z.boolean().optional(),
          })
          .passthrough()
          .parse(JSON.parse(resultJson));
        expect(durableResult.content[0]?.text).toHaveLength(307200);
        let replayExecutions = 0;
        const replay = await createWorkspaceRuntimeInternals(workspace).authority.runForeground(
          {
            operationId: toolOperation.operation_id,
            effect: toolOperation.effect,
            resource: toolOperation.resource,
            estimatedCost: toolOperation.estimated_cost,
            idempotencyKey: toolOperation.idempotency_key,
            requestDigest: toolOperation.request_digest,
            execute: async () => {
              replayExecutions += 1;
              return null;
            },
          },
          {
            effects: [toolOperation.effect],
            resourcePatterns: [toolOperation.resource],
            credentialRefs: [],
          },
        );
        expect(replay).toEqual({ ok: true, value: durableResult, replayed: true });
        expect(replayExecutions).toBe(0);
        expect(
          database
            .prepare(`SELECT COUNT(*) AS count FROM authority_operations
             WHERE idempotency_key LIKE 'mcp-artifact:%' AND status = 'completed'`)
            .get(),
        ).toMatchObject({ count: 0 });
        expect(
          database
            .prepare(
              "SELECT COUNT(*) AS count FROM artifacts WHERE path NOT LIKE 'artifacts/context-documents/%'",
            )
            .get(),
        ).toMatchObject({ count: 0 });
      } finally {
        database.close();
      }
    } finally {
      workspace.close();
    }
  });
  test("starts from marked SQLite authority without parsing corrupted abandoned JSONL", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-marked-corrupt-legacy-"));
    roots.push(home);
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const controlled = createControlledPiModels();
    const first = await createApplicationRuntimeComposition({
      config,
      createAgent: (_sessionTools, codeExecution) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution }),
      createRoleRunner: (configurations) =>
        createPiAgentRoleRunner(process.cwd(), controlled.models, configurations),
    });
    const trail = await first.startTrail({ title: "SQLite-authoritative session" });
    await first.shutdown();
    await mkdir(join(home, "ledger"), { recursive: true });
    await writeFile(join(home, "ledger", "events.jsonl"), "{ definitely not valid JSONL\n");
    const reopened = await createApplicationRuntimeComposition({
      config,
      createAgent: (_sessionTools, codeExecution) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution }),
      createRoleRunner: (configurations) =>
        createPiAgentRoleRunner(process.cwd(), controlled.models, configurations),
    });
    expect(reopened.getTrail(trail.trailId)).toMatchObject({
      trailId: trail.trailId,
      title: "SQLite-authoritative session",
    });
    await reopened.shutdown();
  });
  test("imports completed pre-marker legacy turns once and retains them for resume", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-pre-marker-import-"));
    roots.push(home);
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const controlled = createControlledPiModels();
    const runtimeIdentity = createPiAgentRuntime(process.cwd(), controlled.models).name;
    const legacy = await writeLegacyCompletedTurn(home, runtimeIdentity);
    const runtime = await createApplicationRuntimeComposition({
      config,
      createAgent: (_sessionTools, codeExecution) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution }),
      createRoleRunner: (configurations) =>
        createPiAgentRoleRunner(process.cwd(), controlled.models, configurations),
    });
    expect(runtime.getTrail(legacy.trailId).turns).toEqual([
      {
        input: legacy.input,
        output: legacy.output,
      },
    ]);
    await runtime.shutdown();
  });
  test("retains an aborted partial pair in the visible transcript and future frozen context", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-aborted-replay-"));
    roots.push(home);
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const controlled = createControlledPiModels();
    const noOp = async (): Promise<void> => undefined;
    const runtimeIdentity = createPiAgentRuntime(process.cwd(), controlled.models).name;
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const abortedAgent: NoesisAgentRuntime = Object.freeze({
      name: runtimeIdentity,
      run: async (request: AgentRuntimeRequest) =>
        Object.freeze({
          outcome: "aborted" as const,
          stopReason: "aborted" as const,
          text: "partial answer that must not resume",
          provider: request.provider,
          model: request.model,
        }),
      steer: async () =>
        Object.freeze({
          status: "consumed" as const,
          timelineSequence: 1,
          consumedAt: "2026-01-01T00:00:00.000Z",
        }),
      abort: noOp,
    });
    const first = await createApplicationRuntimeComposition({
      config,
      agent: abortedAgent,
      createRoleRunner: (configurations) =>
        createPiAgentRoleRunner(process.cwd(), controlled.models, configurations),
    });
    const trail = await first.startTrail({ title: "Aborted partial replay" });
    const aborted = await first.debug.runTurn(trail.trailId, "input attached to an aborted answer");
    expect(aborted).toMatchObject({
      outcome: "aborted",
      output: "partial answer that must not resume",
    });
    expect(await first.debug.workspace.operational.messages.listForSession(trail.trailId)).toMatchObject([
      { role: "user", content: "input attached to an aborted answer" },
      { role: "assistant", content: "partial answer that must not resume" },
    ]);
    expect(await first.debug.workspace.operational.outcomes.listForSession(trail.trailId)).toMatchObject([
      {
        status: "failed",
        metadata: { aborted: true, replayEligible: false },
      },
    ]);
    await first.shutdown();
    const requests: AgentRuntimeRequest[] = [];
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const resumedAgent: NoesisAgentRuntime = Object.freeze({
      name: abortedAgent.name,
      run: async (request: AgentRuntimeRequest) => {
        requests.push(request);
        // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
        return Object.freeze({
          outcome: "completed" as const,
          stopReason: "stop" as const,
          text: "clean resumed completion",
          provider: request.provider,
          model: request.model,
        });
      },
      steer: async () =>
        Object.freeze({
          status: "consumed" as const,
          timelineSequence: 1,
          consumedAt: "2026-01-01T00:00:00.000Z",
        }),
      abort: noOp,
    });
    const reopened = await createApplicationRuntimeComposition({
      config,
      agent: resumedAgent,
      createRoleRunner: (configurations) =>
        createPiAgentRoleRunner(process.cwd(), controlled.models, configurations),
    });
    expect(reopened.getTrail(trail.trailId).turns).toEqual([]);
    await reopened.resumeTrail(trail.trailId);
    await reopened.debug.runTurn(trail.trailId, "continue with clean context");
    expect(requests[0]?.systemPrompt).not.toContain("partial answer that must not resume");
    expect(requests[0]?.frozenTurnPlan?.conversationHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: "input attached to an aborted answer",
          turnStatus: "aborted",
        }),
        expect.objectContaining({
          role: "assistant",
          content: "partial answer that must not resume",
          turnStatus: "aborted",
        }),
      ]),
    );
    expect(await reopened.debug.workspace.operational.messages.listForSession(trail.trailId)).toHaveLength(4);
    await reopened.shutdown();
  });
  test("recovers a process-killed foreground turn before hydration and keeps its action inspectable", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-foreground-recovery-"));
    roots.push(home);
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const controlled = createControlledPiModels();
    const runtimeIdentity = createPiAgentRuntime(process.cwd(), controlled.models).name;
    const seed = await createWorkspaceStore(home, {
      now: () => "2026-07-26T00:00:00.000Z",
    });
    await seed.operational.sessions.put({
      sessionId: "session-process-killed",
      title: "Process-killed turn",
      status: "running",
      provider: CONTROLLED_PI_PROVIDER,
      model: CONTROLLED_PI_MODEL,
      runtime: runtimeIdentity,
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:00:00.000Z",
      metadata: Object.freeze({}),
    });
    const protectedRuntime = createWorkspaceRuntimeInternals(seed).protectedRuntime;
    await protectedRuntime.activations.bootstrapGenesis({
      capabilityRevision: {
        kind: "capability_revision",
        capabilityId: "general-collaboration",
        capabilityRevisionId: "general-collaboration-genesis-v1",
        bundleDigest: "a".repeat(64),
      },
      activeDefinitions: Object.freeze({}),
    });
    await protectedRuntime.activations.admitTurnPlan(
      recoveryTurnPlan("session-process-killed", "turn-process-killed"),
    );
    await seed.operational.messages.put({
      messageId: "turn-process-killed:user",
      sessionId: "session-process-killed",
      role: "user",
      content: "Inspect this interrupted work",
      sensitivity: "normal",
      createdAt: "2026-07-26T00:00:01.000Z",
      metadata: Object.freeze({ turnId: "turn-process-killed" }),
    });
    await seed.operational.toolCalls.put({
      toolCallId: "action-process-killed",
      sessionId: "session-process-killed",
      turnId: "turn-process-killed",
      toolName: "shell.run",
      request: Object.freeze({ command: "long-running-command" }),
      status: "running",
      sensitivity: "normal",
      createdAt: "2026-07-26T00:00:02.000Z",
    });
    seed.close();
    const runtime = await createApplicationRuntimeComposition({
      config,
      createAgent: (_sessionTools, codeExecution) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution }),
      createRoleRunner: (configurations) =>
        createPiAgentRoleRunner(process.cwd(), controlled.models, configurations),
    });
    expect(runtime.getTrail("session-process-killed")).toMatchObject({ status: "aborted", turns: [] });
    expect(await runtime.getTranscript("session-process-killed")).toMatchObject([
      { kind: "message", role: "user", text: "Inspect this interrupted work" },
      {
        kind: "action",
        actionId: "action-process-killed",
        status: "interrupted",
        output: { error: "Runtime exited before turn settled", reason: "interrupted" },
      },
    ]);
    await expect(runtime.resumeTrail("session-process-killed")).resolves.toMatchObject({
      status: "idle",
      turns: [],
    });
    expect(
      (await runtime.debug.workspace.operational.messages.listForSession("session-process-killed")).filter(
        (message) => message.role === "assistant",
      ),
    ).toEqual([]);
    await runtime.shutdown();
  });
  test("hydrates and resumes running sessions left before admission or after turn settlement", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-session-window-recovery-"));
    roots.push(home);
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const controlled = createControlledPiModels();
    const runtimeIdentity = createPiAgentRuntime(process.cwd(), controlled.models).name;
    const seed = await createWorkspaceStore(home, {
      now: () => "2026-07-26T00:00:00.000Z",
    });
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const runningSession = (sessionId: string) =>
      Object.freeze({
        sessionId,
        title: sessionId,
        status: "running" as const,
        provider: CONTROLLED_PI_PROVIDER,
        model: CONTROLLED_PI_MODEL,
        runtime: runtimeIdentity,
        createdAt: "2026-07-26T00:00:00.000Z",
        updatedAt: "2026-07-26T00:00:00.000Z",
        metadata: Object.freeze({}),
      });
    await seed.operational.sessions.put(runningSession("session-before-admission"));
    await seed.operational.sessions.put(runningSession("session-after-settlement"));
    const protectedRuntime = createWorkspaceRuntimeInternals(seed).protectedRuntime;
    await protectedRuntime.activations.bootstrapGenesis({
      capabilityRevision: {
        kind: "capability_revision",
        capabilityId: "general-collaboration",
        capabilityRevisionId: "general-collaboration-genesis-v1",
        bundleDigest: "a".repeat(64),
      },
      activeDefinitions: Object.freeze({}),
    });
    await protectedRuntime.activations.admitTurnPlan(
      recoveryTurnPlan("session-after-settlement", "turn-before-idle-persist"),
    );
    await seed.operational.messages.put({
      messageId: "turn-before-idle-persist:user",
      sessionId: "session-after-settlement",
      role: "user",
      content: "A completed request",
      sensitivity: "normal",
      createdAt: "2026-07-26T00:00:01.000Z",
      metadata: Object.freeze({ turnId: "turn-before-idle-persist" }),
    });
    await seed.operational.messages.put({
      messageId: "turn-before-idle-persist:assistant",
      sessionId: "session-after-settlement",
      role: "assistant",
      content: "A completed response",
      sensitivity: "normal",
      createdAt: "2026-07-26T00:00:02.000Z",
      metadata: Object.freeze({ turnId: "turn-before-idle-persist" }),
    });
    await seed.operational.outcomes.put({
      outcomeId: "turn-before-idle-persist:outcome",
      sessionId: "session-after-settlement",
      turnId: "turn-before-idle-persist",
      status: "accepted",
      summary: "A completed response",
      sensitivity: "normal",
      createdAt: "2026-07-26T00:00:03.000Z",
      metadata: Object.freeze({ replayEligible: true, aborted: false }),
    });
    await seed.operational.foregroundTurns.settle({
      turnId: "turn-before-idle-persist",
      outcomeId: "turn-before-idle-persist:outcome",
      status: "completed",
      settledAt: "2026-07-26T00:00:03.000Z",
    });
    // Recreate the process-exit window after durable turn settlement but before the runtime's
    // final trail-state write restored the session to idle.
    await seed.operational.sessions.put(runningSession("session-after-settlement"));
    seed.close();
    const runtime = await createApplicationRuntimeComposition({
      config,
      createAgent: (_sessionTools, codeExecution) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution }),
      createRoleRunner: (configurations) =>
        createPiAgentRoleRunner(process.cwd(), controlled.models, configurations),
    });
    expect(runtime.getTrail("session-before-admission")).toMatchObject({ status: "aborted", turns: [] });
    expect(runtime.getTrail("session-after-settlement")).toMatchObject({
      status: "aborted",
      turns: [{ input: "A completed request", output: "A completed response" }],
    });
    await expect(runtime.resumeTrail("session-before-admission")).resolves.toMatchObject({
      status: "idle",
      turns: [],
    });
    await expect(runtime.resumeTrail("session-after-settlement")).resolves.toMatchObject({
      status: "idle",
      turns: [{ input: "A completed request", output: "A completed response" }],
    });
    expect(
      await runtime.debug.workspace.operational.outcomes.listForSession("session-before-admission"),
    ).toEqual([]);
    await runtime.shutdown();
  });
  test("persists every top-level model action and exposes the same transcript after restart", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-durable-actions-"));
    roots.push(home);
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const controlled = createControlledPiModels();
    const runtimeIdentity = createPiAgentRuntime(process.cwd(), controlled.models).name;
    const noOp = async (): Promise<void> => undefined;
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const actionAgent: NoesisAgentRuntime = Object.freeze({
      name: runtimeIdentity,
      run: async (request: AgentRuntimeRequest, emit: (event: AgentRuntimeEvent) => void) => {
        const firstBoundary = Object.freeze({
          text: "Starting.",
          timelineSequence: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
        });
        emit({ type: "assistant-message", ...firstBoundary });
        for (const [index, name] of ["file_read", "file_write", "execute"].entries()) {
          const actionId = `action-${String(index + 1)}`;
          emit({
            type: "tool-start",
            actionId,
            name,
            input: { fixture: name },
            timelineSequence: index + 2,
          });
          emit({
            type: "tool-end",
            actionId,
            name,
            isError: false,
            result: { status: "completed", fixture: name },
          });
        }
        emit({
          type: "tool-start",
          actionId: "action-unmatched",
          name: "shell",
          input: { fixture: "unmatched" },
          timelineSequence: 5,
        });
        const finalBoundary = Object.freeze({
          text: "All actions completed.",
          timelineSequence: 6,
          createdAt: "2026-01-01T00:00:00.000Z",
        });
        emit({ type: "assistant-message", ...finalBoundary });
        // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
        return Object.freeze({
          outcome: "completed" as const,
          stopReason: "stop" as const,
          text: "Starting.\n\nAll actions completed.",
          assistantMessages: Object.freeze([firstBoundary, finalBoundary]),
          provider: request.provider,
          model: request.model,
        });
      },
      steer: async () =>
        Object.freeze({
          status: "consumed" as const,
          timelineSequence: 1,
          consumedAt: "2026-01-01T00:00:00.000Z",
        }),
      abort: noOp,
    });
    const first = await createApplicationRuntimeComposition({
      config,
      agent: actionAgent,
      createRoleRunner: (configurations) =>
        createPiAgentRoleRunner(process.cwd(), controlled.models, configurations),
    });
    const trail = await first.startTrail({ title: "Durable actions" });
    await first.debug.runTurn(trail.trailId, "Use the direct tool surface");
    expect(first.getTrail(trail.trailId).turns).toEqual([
      {
        input: "Use the direct tool surface",
        output: "Starting.\n\nAll actions completed.",
      },
    ]);
    expect(first.listTrailSummaries().find((summary) => summary.trailId === trail.trailId)).toMatchObject({
      turnCount: 1,
      messageCount: 3,
    });
    const beforeRestart = await first.getTranscript(trail.trailId);
    expect(beforeRestart.flatMap((entry) => (entry.kind === "action" ? [entry.name] : []))).toEqual([
      "file_read",
      "file_write",
      "execute",
      "shell",
    ]);
    expect(beforeRestart.flatMap((entry) => (entry.kind === "action" ? [entry.actionId] : []))).toEqual([
      expect.stringMatching(/:action-1$/u),
      expect.stringMatching(/:action-2$/u),
      expect.stringMatching(/:action-3$/u),
      expect.stringMatching(/:action-unmatched$/u),
    ]);
    expect(beforeRestart.map((entry) => (entry.kind === "message" ? entry.text : entry.name))).toEqual([
      "Use the direct tool surface",
      "Starting.",
      "file_read",
      "file_write",
      "execute",
      "shell",
      "All actions completed.",
    ]);
    expect(
      beforeRestart.find((entry) => entry.kind === "action" && entry.actionId.endsWith("unmatched")),
    ).toMatchObject({
      kind: "action",
      name: "shell",
      status: "interrupted",
    });
    await first.shutdown();
    const reopened = await createApplicationRuntimeComposition({
      config,
      agent: actionAgent,
      createRoleRunner: (configurations) =>
        createPiAgentRoleRunner(process.cwd(), controlled.models, configurations),
    });
    expect(reopened.getTrail(trail.trailId).turns).toEqual([
      {
        input: "Use the direct tool surface",
        output: "Starting.\n\nAll actions completed.",
      },
    ]);
    expect(reopened.listTrailSummaries().find((summary) => summary.trailId === trail.trailId)).toMatchObject({
      turnCount: 1,
      messageCount: 3,
    });
    expect(await reopened.getTranscript(trail.trailId)).toEqual(beforeRestart);
    await reopened.shutdown();
  });
  test("runs queued turns through the durable interaction controller and records successful steering", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-interaction-controller-"));
    roots.push(home);
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const controlled = createControlledPiModels();
    const runtimeIdentity = createPiAgentRuntime(process.cwd(), controlled.models).name;
    let finishTurn: ((outcome: "completed" | "aborted") => void) | undefined;
    const turnFinished = new Promise<"completed" | "aborted">((resolve) => {
      finishTurn = resolve;
    });
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const steered: string[] = [];
    const interactionAgent: NoesisAgentRuntime = Object.freeze({
      name: runtimeIdentity,
      run: async (request: AgentRuntimeRequest, emit: (event: AgentRuntimeEvent) => void) => {
        emit({ type: "status", status: "started" });
        markStarted?.();
        const outcome = await turnFinished;
        // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
        return outcome === "aborted"
          ? Object.freeze({
              outcome: "aborted" as const,
              stopReason: "aborted" as const,
              text: "partial",
              provider: request.provider,
              model: request.model,
            })
          : Object.freeze({
              outcome: "completed" as const,
              stopReason: "stop" as const,
              text: "completed",
              provider: request.provider,
              model: request.model,
            });
      },
      steer: async (_trailId: string, text: string) => {
        steered.push(text);
        // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
        return Object.freeze({
          status: "consumed" as const,
          timelineSequence: 1,
          consumedAt: "2026-01-01T00:00:00.000Z",
        });
      },
      abort: async () => {
        finishTurn?.("aborted");
      },
    });
    const runtime = await createApplicationRuntimeComposition({
      config,
      agent: interactionAgent,
      createRoleRunner: (configurations) =>
        createPiAgentRoleRunner(process.cwd(), controlled.models, configurations),
    });
    const trail = await runtime.startTrail({ title: "Durable interaction" });
    const queued = await runtime.interact(trail.trailId, {
      type: "submit",
      text: "Run this as its own turn",
    });
    expect(queued.effect).toBe("queued");
    await started;
    const steeredResult = await runtime.interact(trail.trailId, {
      type: "steer",
      text: "Focus on the durable evidence",
    });
    expect(steeredResult.effect).toBe("steered");
    expect(steered).toEqual(["Focus on the durable evidence"]);
    const messages = await runtime.debug.workspace.operational.messages.listForSession(trail.trailId);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: "Run this as its own turn",
          metadata: expect.objectContaining({ sourceIntentId: queued.intentId }),
        }),
        expect.objectContaining({
          role: "user",
          content: "Focus on the durable evidence",
          metadata: expect.objectContaining({
            sourceIntentId: steeredResult.intentId,
            deliveryMode: "steer",
          }),
        }),
      ]),
    );
    await runtime.interact(trail.trailId, {
      type: "submit",
      text: "Preserve this queued turn",
    });
    const activeTurnId = (await runtime.inspectInteraction(trail.trailId)).active?.turnId;
    if (!activeTurnId) throw new Error("Expected an active turn before interrupt");
    await runtime.interact(trail.trailId, { type: "interrupt", turnId: activeTurnId });
    await waitUntil(async () => (await runtime.inspectInteraction(trail.trailId)).phase === "idle");
    expect((await runtime.inspectInteraction(trail.trailId)).pending.map((item) => item.text)).toEqual([
      "Preserve this queued turn",
    ]);
    await runtime.shutdown();
  });
  test("settles an interacted completion into the authoritative trail context and turns", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-interacted-settlement-"));
    roots.push(home);
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const controlled = createControlledPiModels();
    const runtimeIdentity = createPiAgentRuntime(process.cwd(), controlled.models).name;
    const noOp = async (): Promise<void> => undefined;
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const runtime = await createApplicationRuntimeComposition({
      config,
      agent: Object.freeze({
        name: runtimeIdentity,
        run: async (request: AgentRuntimeRequest) =>
          Object.freeze({
            outcome: "completed" as const,
            stopReason: "stop" as const,
            text: "durably completed",
            provider: request.provider,
            model: request.model,
          }),
        steer: async () =>
          Object.freeze({
            status: "consumed" as const,
            timelineSequence: 1,
            consumedAt: "2026-01-01T00:00:00.000Z",
          }),
        abort: noOp,
      }),
      createRoleRunner: (configurations) =>
        createPiAgentRoleRunner(process.cwd(), controlled.models, configurations),
    });
    const trail = await runtime.startTrail({ title: "Interacted settlement" });
    await runtime.interact(trail.trailId, {
      type: "submit",
      text: "Complete through the interaction controller",
    });
    await waitUntil(() => runtime.getTrail(trail.trailId).turns.length === 1);
    expect(runtime.getTrail(trail.trailId)).toMatchObject({
      status: "idle",
      contextSnapshotId: expect.any(String),
      context: {
        snapshotId: expect.any(String),
        usedTokens: expect.any(Number),
      },
      turns: [
        {
          input: "Complete through the interaction controller",
          output: "durably completed",
        },
      ],
    });
    await runtime.shutdown();
  });
  test("builds future model context from completed turns and delivered steers in durable order", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-authoritative-model-history-"));
    roots.push(home);
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const controlled = createControlledPiModels();
    const runtimeIdentity = createPiAgentRuntime(process.cwd(), controlled.models).name;
    let releaseActive: (() => void) | undefined;
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    let markActiveStarted: (() => void) | undefined;
    const activeStarted = new Promise<void>((resolve) => {
      markActiveStarted = resolve;
    });
    const requests: AgentRuntimeRequest[] = [];
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const runtime = await createApplicationRuntimeComposition({
      config,
      agent: Object.freeze({
        name: runtimeIdentity,
        run: async (request: AgentRuntimeRequest, emit: (event: AgentRuntimeEvent) => void) => {
          requests.push(request);
          emit({ type: "status", status: "started" });
          if (request.prompt === "failed input") throw new Error("controlled turn failure");
          if (request.prompt === "aborted input")
            // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
            return Object.freeze({
              outcome: "aborted" as const,
              stopReason: "aborted" as const,
              text: "aborted partial output",
              provider: request.provider,
              model: request.model,
            });
          if (request.prompt === "active input") {
            markActiveStarted?.();
            await activeGate;
          }
          // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
          return Object.freeze({
            outcome: "completed" as const,
            stopReason: "stop" as const,
            text: `reply:${request.prompt}`,
            provider: request.provider,
            model: request.model,
          });
        },
        steer: async () =>
          Object.freeze({
            status: "consumed" as const,
            timelineSequence: 1,
            consumedAt: "2026-01-01T00:00:00.000Z",
          }),
        abort: async () => undefined,
      }),
      createRoleRunner: (configurations) =>
        createPiAgentRoleRunner(process.cwd(), controlled.models, configurations),
    });
    const trail = await runtime.startTrail({ title: "Authoritative model history" });
    await runtime.debug.runTurn(trail.trailId, "accepted input");
    await expect(runtime.debug.runTurn(trail.trailId, "failed input")).rejects.toThrow(
      "controlled turn failure",
    );
    await runtime.debug.runTurn(trail.trailId, "aborted input");
    await runtime.interact(trail.trailId, { type: "submit", text: "active input" });
    await activeStarted;
    await runtime.interact(trail.trailId, { type: "steer", text: "delivered steering" });
    releaseActive?.();
    await waitUntil(() => runtime.getTrail(trail.trailId).turns.length === 2);
    await runtime.debug.runTurn(trail.trailId, "inspect history");
    const inspectionRequest = requests.at(-1);
    const history = inspectionRequest ? frozenHistoryForRequest(inspectionRequest) : [];
    expect(history.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: "user", content: "accepted input" },
      { role: "assistant", content: "reply:accepted input" },
      { role: "user", content: "failed input" },
      { role: "user", content: "aborted input" },
      { role: "assistant", content: "aborted partial output" },
      { role: "user", content: "active input" },
      { role: "user", content: "delivered steering" },
      { role: "assistant", content: "reply:active input" },
    ]);
    expect(inspectionRequest?.frozenTurnPlan?.conversationHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: "accepted input", turnStatus: "completed" }),
        expect.objectContaining({ content: "reply:accepted input", turnStatus: "completed" }),
        expect.objectContaining({ content: "failed input", turnStatus: "failed" }),
        expect.objectContaining({ content: "aborted input", turnStatus: "aborted" }),
        expect.objectContaining({ content: "aborted partial output", turnStatus: "aborted" }),
        expect.objectContaining({ content: "active input", turnStatus: "completed" }),
        expect.objectContaining({ content: "reply:active input", turnStatus: "completed" }),
      ]),
    );
    expect(inspectionRequest?.systemPrompt).not.toContain("accepted input");
    expect(history).toEqual(
      inspectionRequest?.frozenTurnPlan?.conversationHistory?.map(({ role, content, createdAt }) => ({
        role,
        content,
        createdAt,
      })),
    );
    for (const entry of inspectionRequest?.frozenTurnPlan?.conversationHistory ?? []) {
      expect(entry.contentDigest).toBe(sha256(entry.content));
      expect(entry.messageRef).toEqual({
        kind: "database_row",
        table: "messages",
        rowId: entry.messageId,
      });
      expect(await runtime.debug.workspace.operational.messages.get(entry.messageId)).toMatchObject({
        role: entry.role,
        content: entry.content,
        createdAt: entry.createdAt,
      });
    }
    const oversized = "x".repeat(12001);
    await runtime.debug.runTurn(trail.trailId, oversized);
    await runtime.debug.runTurn(trail.trailId, "inspect bounded history");
    const boundedRequest = requests.at(-1);
    expect(
      boundedRequest
        ? frozenHistoryForRequest(boundedRequest).some((message) => message.content.includes(oversized))
        : false,
    ).toBe(true);
    expect(
      boundedRequest?.frozenTurnPlan?.conversationHistory?.some((entry) => entry.content.includes(oversized)),
    ).toBe(true);
    await runtime.shutdown();
  });
  test("forks authoritative replay history with steer provenance across immediate use and restart", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-fork-history-"));
    roots.push(home);
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const controlled = createControlledPiModels();
    const runtimeIdentity = createPiAgentRuntime(process.cwd(), controlled.models).name;
    let releaseActive: (() => void) | undefined;
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    let markActiveStarted: (() => void) | undefined;
    const activeStarted = new Promise<void>((resolve) => {
      markActiveStarted = resolve;
    });
    const firstRequests: AgentRuntimeRequest[] = [];
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const first = await createApplicationRuntimeComposition({
      config,
      agent: Object.freeze({
        name: runtimeIdentity,
        run: async (request: AgentRuntimeRequest, emit: (event: AgentRuntimeEvent) => void) => {
          firstRequests.push(request);
          emit({ type: "status", status: "started" });
          if (request.prompt === "accepted source input") {
            const firstBoundary = Object.freeze({
              text: "A",
              timelineSequence: 1,
              createdAt: "2026-01-01T00:00:00.000Z",
            });
            const secondBoundary = Object.freeze({
              text: "B",
              timelineSequence: 2,
              createdAt: "2026-01-01T00:00:00.000Z",
            });
            emit({ type: "assistant-message", ...firstBoundary });
            emit({ type: "assistant-message", ...secondBoundary });
            // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
            return Object.freeze({
              outcome: "completed" as const,
              stopReason: "stop" as const,
              text: "A\n\nB",
              assistantMessages: Object.freeze([firstBoundary, secondBoundary]),
              provider: request.provider,
              model: request.model,
            });
          }
          if (request.prompt === "failed source input") throw new Error("source turn failed");
          if (request.prompt === "aborted source input")
            // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
            return Object.freeze({
              outcome: "aborted" as const,
              stopReason: "aborted" as const,
              text: "aborted source output",
              provider: request.provider,
              model: request.model,
            });
          if (request.prompt === "active source input") {
            markActiveStarted?.();
            await activeGate;
          }
          // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
          return Object.freeze({
            outcome: "completed" as const,
            stopReason: "stop" as const,
            text: `reply:${request.prompt}`,
            provider: request.provider,
            model: request.model,
          });
        },
        steer: async () =>
          Object.freeze({
            status: "consumed" as const,
            timelineSequence: 1,
            consumedAt: "2026-01-01T00:00:00.000Z",
          }),
        abort: async () => undefined,
      }),
      createRoleRunner: (configurations) =>
        createPiAgentRoleRunner(process.cwd(), controlled.models, configurations),
    });
    const source = await first.startTrail({ title: "Fork source" });
    await first.debug.runTurn(source.trailId, "accepted source input");
    await expect(first.debug.runTurn(source.trailId, "failed source input")).rejects.toThrow(
      "source turn failed",
    );
    await first.debug.runTurn(source.trailId, "aborted source input");
    await first.interact(source.trailId, { type: "submit", text: "active source input" });
    await activeStarted;
    await first.interact(source.trailId, { type: "steer", text: "delivered source steer" });
    releaseActive?.();
    await waitUntil(() => first.getTrail(source.trailId).turns.length === 2);
    const fork = await first.forkTrail(source.trailId, "Authoritative fork");
    const expectedInheritedText = [
      "accepted source input",
      "A",
      "B",
      "active source input",
      "delivered source steer",
      "reply:active source input",
    ];
    const inheritedMessages = (
      await first.debug.workspace.operational.messages.listForSession(fork.trailId)
    ).toSorted(
      (left, right) => Number(left.metadata["historySequence"]) - Number(right.metadata["historySequence"]),
    );
    expect(inheritedMessages.map((message) => message.content)).toEqual(expectedInheritedText);
    expect(inheritedMessages.map((message) => message.metadata["historyKind"])).toEqual([
      "turn",
      "turn",
      "turn",
      "turn",
      "steer",
      "turn",
    ]);
    expect(inheritedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          messageId: expect.stringMatching(new RegExp(`^${fork.trailId}:inherited:`)),
          metadata: expect.objectContaining({
            replayEligible: true,
            inheritedFromSessionId: source.trailId,
            inheritedFromMessageId: expect.any(String),
          }),
        }),
      ]),
    );
    expect(inheritedMessages.map((message) => message.metadata["historySequence"])).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    expect(
      (await first.getTranscript(fork.trailId)).flatMap((entry) =>
        entry.kind === "message" ? [entry.text] : [],
      ),
    ).toEqual(expectedInheritedText);
    expect(first.getTrail(fork.trailId).turns).toEqual([
      { input: "accepted source input", output: "A\n\nB" },
      { input: "active source input", output: "reply:active source input" },
    ]);
    expect(first.listTrailSummaries().find((summary) => summary.trailId === fork.trailId)).toMatchObject({
      turnCount: 2,
      messageCount: 6,
    });
    await first.debug.runTurn(source.trailId, "source-only future input");
    await first.debug.runTurn(fork.trailId, "immediate fork input");
    const immediateRequest = firstRequests.find((request) => request.prompt === "immediate fork input");
    const immediateHistory = immediateRequest ? frozenHistoryForRequest(immediateRequest) : [];
    expect(immediateHistory.map((message) => message.content)).toEqual(expectedInheritedText);
    expect(immediateRequest?.systemPrompt).not.toContain("accepted source input");
    expect(immediateHistory.map((message) => message.content)).not.toContain("failed source input");
    expect(immediateHistory.map((message) => message.content)).not.toContain("aborted source input");
    expect(immediateHistory.map((message) => message.content)).not.toContain("source-only future input");
    const inheritedMessageIds = inheritedMessages.map((message) => message.messageId);
    await first.shutdown();
    const reopenedRequests: AgentRuntimeRequest[] = [];
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const reopened = await createApplicationRuntimeComposition({
      config,
      agent: Object.freeze({
        name: runtimeIdentity,
        run: async (request: AgentRuntimeRequest) => {
          reopenedRequests.push(request);
          // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
          return Object.freeze({
            outcome: "completed" as const,
            stopReason: "stop" as const,
            text: `reopened:${request.prompt}`,
            provider: request.provider,
            model: request.model,
          });
        },
        steer: async () =>
          Object.freeze({
            status: "consumed" as const,
            timelineSequence: 1,
            consumedAt: "2026-01-01T00:00:00.000Z",
          }),
        abort: async () => undefined,
      }),
      createRoleRunner: (configurations) =>
        createPiAgentRoleRunner(process.cwd(), controlled.models, configurations),
    });
    expect(reopened.getTrail(fork.trailId).turns).toEqual([
      { input: "accepted source input", output: "A\n\nB" },
      { input: "active source input", output: "reply:active source input" },
      { input: "immediate fork input", output: "reply:immediate fork input" },
    ]);
    expect(reopened.listTrailSummaries().find((summary) => summary.trailId === fork.trailId)).toMatchObject({
      turnCount: 3,
      messageCount: 8,
    });
    expect(
      (await reopened.debug.workspace.operational.messages.listForSession(fork.trailId))
        .filter((message) => message.metadata["replayEligible"] === true)
        .toSorted(
          (left, right) =>
            Number(left.metadata["historySequence"]) - Number(right.metadata["historySequence"]),
        )
        .map((message) => message.messageId),
    ).toEqual(inheritedMessageIds);
    await reopened.resumeTrail(fork.trailId);
    await reopened.debug.runTurn(fork.trailId, "restarted fork input");
    const restartedRequest = reopenedRequests.at(-1);
    const restartedHistory = restartedRequest ? frozenHistoryForRequest(restartedRequest) : [];
    expect(restartedHistory.map((message) => message.content)).toContain("delivered source steer");
    expect(restartedHistory.map((message) => message.content)).toContain("immediate fork input");
    expect(restartedHistory.map((message) => message.content)).toContain("reply:immediate fork input");
    expect(restartedHistory.map((message) => message.content)).not.toContain("failed source input");
    expect(restartedHistory.map((message) => message.content)).not.toContain("aborted source input");
    expect(restartedHistory.map((message) => message.content)).not.toContain("source-only future input");
    await reopened.shutdown();
  });
  test("continues persisting later action events after an earlier write fails", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-action-persistence-drain-"));
    roots.push(home);
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const controlled = createControlledPiModels();
    const runtimeIdentity = createPiAgentRuntime(process.cwd(), controlled.models).name;
    const noOp = async (): Promise<void> => undefined;
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const actionAgent: NoesisAgentRuntime = Object.freeze({
      name: runtimeIdentity,
      run: async (request: AgentRuntimeRequest, emit: (event: AgentRuntimeEvent) => void) => {
        emit({
          type: "tool-start",
          actionId: "duplicate",
          name: "file_read",
          input: { value: 1 },
          timelineSequence: 1,
        });
        emit({
          type: "tool-start",
          actionId: "duplicate",
          name: "file_read",
          input: { value: 2 },
          timelineSequence: 2,
        });
        emit({
          type: "tool-start",
          actionId: "later",
          name: "programs.list",
          input: { value: 3 },
          timelineSequence: 3,
        });
        emit({
          type: "tool-end",
          actionId: "later",
          name: "programs.list",
          isError: false,
          result: { status: "completed" },
        });
        // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
        return Object.freeze({
          outcome: "completed" as const,
          stopReason: "stop" as const,
          text: "The durable queue should report its failure.",
          provider: request.provider,
          model: request.model,
        });
      },
      steer: async () =>
        Object.freeze({
          status: "consumed" as const,
          timelineSequence: 1,
          consumedAt: "2026-01-01T00:00:00.000Z",
        }),
      abort: noOp,
    });
    const runtime = await createApplicationRuntimeComposition({
      config,
      agent: actionAgent,
      createRoleRunner: (configurations) =>
        createPiAgentRoleRunner(process.cwd(), controlled.models, configurations),
    });
    const trail = await runtime.startTrail({ title: "Action persistence drain" });
    await expect(runtime.debug.runTurn(trail.trailId, "Exercise the persistence queue")).rejects.toThrow(
      "changed its turn timeline position",
    );
    expect(await runtime.getTranscript(trail.trailId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "action", name: "programs.list", status: "completed" }),
      ]),
    );
    await runtime.shutdown();
  });
  test("a real app turn pins admission and records exact durable operational work", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-control-plane-"));
    roots.push(home);
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const controlled = createControlledPiModels();
    const runtimeIdentity = createPiAgentRuntime(process.cwd(), controlled.models).name;
    const skills = createPiSkillLibrary({
      cwd: home,
      agentDirectory: join(home, "agent"),
    });
    const requests: AgentRuntimeRequest[] = [];
    const seenConfigurations: unknown[] = [];
    const preparedCatalogs: PiFrozenToolCatalog[] = [];
    let frozenSessionTools: FrozenSessionToolResolver | undefined;
    const runtime = await createApplicationRuntimeComposition({
      config,
      skills,
      createAgent: (sessionTools, codeExecution, skillLibrary) => {
        frozenSessionTools = sessionTools;
        const capturingCodeExecution = Object.freeze({
          ...codeExecution,
          prepare: async (...arguments_: Parameters<typeof codeExecution.prepare>) => {
            const prepared = await codeExecution.prepare(...arguments_);
            preparedCatalogs.push(prepared.catalog);
            return prepared;
          },
        });
        // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
        const pi = createPiAgentRuntime(
          process.cwd(),
          controlled.models,
          createConditionalObject({
            codeExecution: capturingCodeExecution,
            requirePinnedSkillSnapshot: true,
          } as const)
            .addOptional(skillLibrary ? { skills: skillLibrary } : undefined)
            .finish(),
        );
        const capturingAgent: NoesisAgentRuntime = Object.freeze({
          ...pi,
          run: async (request: AgentRuntimeRequest, emit: (event: AgentRuntimeEvent) => void) => {
            requests.push(request);
            return await pi.run(request, emit);
          },
        });
        return capturingAgent;
      },
      createRoleRunner: (configurations) => {
        seenConfigurations.push(...configurations);
        return createPiAgentRoleRunner(process.cwd(), controlled.models, configurations);
      },
    });
    const trail = await runtime.startTrail({ title: "Composition acceptance" });
    const result = await runtime.debug.runTurn(trail.trailId, "Record this ordinary turn");
    expect(result.outcome).toBe("completed");
    expect(requests[0]?.systemPrompt).toContain(
      "search this installation's previous sessions through `execute` when it could help.",
    );
    expect(requests[0]?.systemPrompt).toContain("For multi-call work, use one coherent `execute` program");
    expect(requests[0]?.systemPrompt).toContain("use `agents.run` when a bounded independent agent can help");
    expect(requests[0]?.systemPrompt).toContain("Treat explicit truncation as incomplete evidence");
    expect(requests[0]?.systemPrompt).toContain(
      "use one coherent follow-up instead of a series of direct calls",
    );
    expect(requests[0]?.systemPrompt).toContain("Do not split related work across wrapper executions");
    expect(requests[0]?.systemPrompt).toContain("Save reusable behavior as a Program.");
    const sessionCatalogTools = [
      "history.search_sessions",
      "history.open_session_evidence",
      "history.find_corrections",
      "history.find_similar_tasks",
      "history.prior_experiment_outcomes",
    ];
    expect(preparedCatalogs[0]?.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(sessionCatalogTools),
    );
    if (!frozenSessionTools) throw new Error("Expected the application session-tool resolver");
    const emptyCapabilityResolution = await frozenSessionTools.resolve(
      recoveryTurnPlan("trail-empty-capabilities", "turn-empty-capabilities"),
      new AbortController().signal,
    );
    expect(emptyCapabilityResolution.consumedMaterials).toEqual([]);
    expect(emptyCapabilityResolution.definitions.map((definition) => definition.name)).toEqual(
      sessionCatalogTools.map((name) => name.slice("history.".length)),
    );
    expect(config.schemaVersion).toBe(2);
    expect(await runtime.debug.workspace.operational.sessions.get(trail.trailId)).toMatchObject({
      sessionId: trail.trailId,
      runtime: runtimeIdentity,
    });
    const messages = await runtime.debug.workspace.operational.messages.listForSession(trail.trailId);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    const outcomes = await runtime.debug.workspace.operational.outcomes.listForSession(trail.trailId);
    expect(outcomes).toMatchObject([{ status: "unknown", summary: result.output }]);
    const turnId = String(messages[0]?.metadata["turnId"]);
    expect(await runtime.debug.workspace.operational.foregroundTurns.get(turnId)).toMatchObject({
      sessionId: trail.trailId,
      status: "completed",
      outcomeId: `${turnId}:outcome`,
    });
    const pin = await runtime.debug.adaptations.activations.getTurnPin(trail.trailId, turnId);
    const storedPlan = await runtime.debug.adaptations.activations.getTurnPlan(trail.trailId, turnId);
    const deliveredPlan = requests[0]?.frozenTurnPlan;
    expect(pin).toMatchObject({
      activationId: "activation_genesis",
      activeCapabilityRevisions: {
        "general-collaboration": { capabilityRevisionId: "general-collaboration-genesis-v1" },
      },
    });
    expect(deliveredPlan).toEqual(storedPlan);
    expect(result.frozenTurnPlan).toEqual(storedPlan);
    expect(requests[0]?.systemPrompt).toBe(storedPlan?.renderedSystemPrompt);
    expect(storedPlan?.permissionSnapshot.resourcePatterns).toContain("file-read:*");
    expect(storedPlan?.permissionSnapshot.resourcePatterns).not.toContain("file:*");
    expect(storedPlan).toMatchObject({
      schemaVersion: 1,
      sessionId: trail.trailId,
      turnId,
      selectedCapabilities: [
        {
          capabilityId: "general-collaboration",
          baseline: { kind: "genesis" },
          promptModules: [
            {
              content: expect.stringContaining("thinking-and-creation partner"),
            },
          ],
          tools: [],
        },
      ],
    });
    expect(await runtime.debug.workspace.definitionMetadata.listCurrent("runtime_role")).toHaveLength(4);
    expect(JSON.stringify(seenConfigurations)).not.toMatch(
      /protectedActivations|protectedFeedback|authorityBoundary|restorationHandle/iu,
    );
    expect("promoteCandidate" in runtime).toBe(false);
    await runtime.shutdown();
    const reopened = await createWorkspaceStore(home);
    const reopenedProtected = createWorkspaceRuntimeInternals(reopened).protectedRuntime;
    expect(await reopened.operational.messages.listForSession(trail.trailId)).toHaveLength(2);
    expect(await reopened.operational.outcomes.listForSession(trail.trailId)).toHaveLength(1);
    expect(await reopenedProtected.activations.getTurnPin(trail.trailId, turnId)).toBeDefined();
    expect(await reopenedProtected.activations.getTurnPlan(trail.trailId, turnId)).toEqual(storedPlan);
    reopened.close();
  });
  test("an ordinary production turn degrades around one persistently unreadable skill", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-partial-skill-load-"));
    roots.push(home);
    const skillPackage = join(home, "skill-package");
    const validPath = join(skillPackage, "skills", "valid-work", "SKILL.md");
    const brokenPath = join(skillPackage, "skills", "broken-work", "SKILL.md");
    const validContent =
      "---\nname: valid-work\ndescription: Valid work.\n---\n\nUse the valid workflow instructions.";
    const brokenContent =
      "---\nname: broken-work\ndescription: Broken work.\n---\n\nThese bytes cannot be loaded.";
    await mkdir(join(skillPackage, "skills", "valid-work"), { recursive: true });
    await mkdir(join(skillPackage, "skills", "broken-work"), { recursive: true });
    await writeFile(validPath, validContent, "utf8");
    await writeFile(brokenPath, brokenContent, "utf8");
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const controlled = createControlledPiModels();
    const skills = createPiSkillLibrary({
      cwd: home,
      agentDirectory: join(home, "agent"),
      workspaceTrusted: true,
      readSkillFile: async (path) => {
        if (path === brokenPath) throw new Error("persistent skill read failure");
        return await readFile(path, "utf8");
      },
    });
    await skills.install(skillPackage, "workspace");
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const runtime = await createApplicationRuntimeComposition({
      config,
      skills,
      createAgent: (_sessionTools, codeExecution, skillLibrary) =>
        createPiAgentRuntime(
          process.cwd(),
          controlled.models,
          createConditionalObject({
            codeExecution,
          } as const)
            .addOptional(skillLibrary ? { skills: skillLibrary } : undefined)
            .add({
              requirePinnedSkillSnapshot: true,
            } as const)
            .finish(),
        ),
      createRoleRunner: (configurations) =>
        createPiAgentRoleRunner(process.cwd(), controlled.models, configurations),
    });
    const trail = await runtime.startTrail({ title: "Partial skill degradation" });
    await expect(runtime.debug.runTurn(trail.trailId, "Answer this ordinary prompt.")).resolves.toMatchObject(
      { outcome: "completed" },
    );
    const snapshot = await skills.snapshot();
    expect(snapshot.skills.find((skill) => skill.name === "valid-work")).toMatchObject({
      name: "valid-work",
      content: validContent,
    });
    expect(snapshot.skills.some((skill) => skill.name === "broken-work")).toBe(false);
    expect(snapshot.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "error",
          path: brokenPath,
          message: expect.stringContaining("persistent skill read failure"),
        }),
      ]),
    );
    await runtime.shutdown();
  });
  test("a stalled background skill listing cannot poison the first ordinary turn", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-background-skill-stall-"));
    roots.push(home);
    const skillPackage = join(home, "skill-package");
    const skillPath = join(skillPackage, "skills", "stalled-work", "SKILL.md");
    const skillContent =
      "---\nname: stalled-work\ndescription: Stalled background skill.\n---\n\nEventually available.";
    await mkdir(join(skillPackage, "skills", "stalled-work"), { recursive: true });
    await writeFile(skillPath, skillContent, "utf8");
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const controlled = createControlledPiModels();
    let signalReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    let releaseRead: (() => void) | undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const skills = createPiSkillLibrary({
      cwd: home,
      agentDirectory: join(home, "agent"),
      workspaceTrusted: true,
      readSkillFile: async (path) => {
        signalReadStarted?.();
        await readGate;
        return path === skillPath ? skillContent : "";
      },
    });
    await skills.install(skillPackage, "workspace");
    let admittedSnapshot: Awaited<ReturnType<typeof skills.pinSnapshot>> | undefined;
    const observedSkills = Object.freeze({
      ...skills,
      pinSnapshot: async (...args: Parameters<typeof skills.pinSnapshot>) => {
        admittedSnapshot = await skills.pinSnapshot(...args);
        return admittedSnapshot;
      },
    });
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const runtime = await createApplicationRuntimeComposition({
      config,
      skills: observedSkills,
      createAgent: (_sessionTools, codeExecution, skillLibrary) =>
        createPiAgentRuntime(
          process.cwd(),
          controlled.models,
          createConditionalObject({
            codeExecution,
          } as const)
            .addOptional(skillLibrary ? { skills: skillLibrary } : undefined)
            .add({
              requirePinnedSkillSnapshot: true,
            } as const)
            .finish(),
        ),
      createRoleRunner: (configurations) =>
        createPiAgentRoleRunner(process.cwd(), controlled.models, configurations),
    });
    let backgroundListing: ReturnType<NonNullable<typeof runtime.listSkills>> | undefined;
    try {
      const trail = await runtime.startTrail({ title: "Stalled skill discovery" });
      if (!runtime.listSkills) throw new Error("Expected production skill listing support");
      backgroundListing = runtime.listSkills();
      await readStarted;
      await expect(runtime.debug.runTurn(trail.trailId, "Answer this normal prompt.")).resolves.toMatchObject(
        {
          outcome: "completed",
        },
      );
      expect(admittedSnapshot?.skills).toEqual([]);
      expect(admittedSnapshot?.diagnostics).toEqual([
        expect.objectContaining({
          type: "warning",
          message: expect.stringContaining("omits skills that have not finished loading"),
        }),
      ]);
      releaseRead?.();
      await expect(backgroundListing).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "stalled-work", contentDigest: expect.any(String) }),
        ]),
      );
    } finally {
      releaseRead?.();
      await backgroundListing?.catch(() => undefined);
      await runtime.shutdown();
    }
  });
  test("an explicitly invoked skill remains inspectable from admitted bytes after its source is removed", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-skill-evidence-"));
    roots.push(home);
    const skillPackage = join(home, "skill-package");
    const skillPath = join(skillPackage, "skills", "trace-work", "SKILL.md");
    const skillContent = [
      "---",
      "name: trace-work",
      "description: Preserve the exact instructions used for traced work.",
      "---",
      "",
      "Inspect the evidence, cite the durable trace, and report the result.",
    ].join("\n");
    await mkdir(join(skillPackage, "skills", "trace-work"), { recursive: true });
    await writeFile(skillPath, skillContent, "utf8");
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const controlled = createControlledPiModels();
    const skills = createPiSkillLibrary({
      cwd: home,
      agentDirectory: join(home, "agent"),
      workspaceTrusted: true,
    });
    await skills.install(skillPackage, "workspace");
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const runtime = await createApplicationRuntimeComposition({
      config,
      skills,
      createAgent: (_sessionTools, codeExecution, skillLibrary) =>
        createPiAgentRuntime(
          process.cwd(),
          controlled.models,
          createConditionalObject({
            codeExecution,
          } as const)
            .addOptional(skillLibrary ? { skills: skillLibrary } : undefined)
            .add({
              requirePinnedSkillSnapshot: true,
            } as const)
            .finish(),
        ),
      createRoleRunner: (configurations) =>
        createPiAgentRoleRunner(process.cwd(), controlled.models, configurations),
    });
    const trail = await runtime.startTrail({ title: "Durable skill evidence" });
    await runtime.debug.runTurn(trail.trailId, "/trace-work inspect this session");
    const initialTranscript = await runtime.getTranscript(trail.trailId);
    const initialLoad = initialTranscript.find(
      (entry) => entry.kind === "action" && entry.name === "skills.load",
    );
    expect(initialLoad).toMatchObject({
      kind: "action",
      status: "completed",
      output: {
        name: "trace-work",
        content: skillContent,
        invocation: "explicit",
      },
    });
    if (!initialLoad || initialLoad.kind !== "action" || !initialLoad.output)
      throw new Error("Expected a durable skills.load action");
    const revision = z.object({ revision: EvidenceRevisionRefSchema }).parse(initialLoad.output).revision;
    expect(new TextDecoder().decode(await runtime.debug.workspace.reads.readEvidence(revision))).toBe(
      skillContent,
    );
    await runtime.shutdown();
    await rm(skillPath);
    const reopenedSkills = createPiSkillLibrary({
      cwd: home,
      agentDirectory: join(home, "agent"),
      workspaceTrusted: true,
    });
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const reopened = await createApplicationRuntimeComposition({
      config,
      skills: reopenedSkills,
      createAgent: (_sessionTools, codeExecution, skillLibrary) =>
        createPiAgentRuntime(
          process.cwd(),
          controlled.models,
          createConditionalObject({
            codeExecution,
          } as const)
            .addOptional(skillLibrary ? { skills: skillLibrary } : undefined)
            .add({
              requirePinnedSkillSnapshot: true,
            } as const)
            .finish(),
        ),
      createRoleRunner: (configurations) =>
        createPiAgentRoleRunner(process.cwd(), controlled.models, configurations),
    });
    const resumedLoad = (await reopened.getTranscript(trail.trailId)).find(
      (entry) => entry.kind === "action" && entry.name === "skills.load",
    );
    expect(resumedLoad).toMatchObject({
      kind: "action",
      status: "completed",
      output: {
        name: "trace-work",
        content: skillContent,
        revision,
      },
    });
    expect(new TextDecoder().decode(await reopened.debug.workspace.reads.readEvidence(revision))).toBe(
      skillContent,
    );
    await reopened.shutdown();
  });
  test("carries one reflected global Capability across sessions and projects", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-project-adjustment-"));
    roots.push(home);
    const projectRoot = join(home, "project-p");
    const otherProjectRoot = join(home, "project-q");
    await Promise.all([
      mkdir(projectRoot, { recursive: true }),
      mkdir(otherProjectRoot, { recursive: true }),
    ]);
    const project = Object.freeze({ projectId: "project-p", root: projectRoot });
    const otherProject = Object.freeze({ projectId: "project-q", root: otherProjectRoot });
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const reflectorContexts: string[] = [];
    let reflectorRuns = 0;
    let createdCapabilityId: string | undefined;
    const strategy = "Verify the observable project state before reporting completion.";
    const controlled = createControlledPiModels({
      respond: (input) => {
        const { systemPrompt, lastUserText } = input;
        if (systemPrompt.includes("role: history_reranker")) return researchLoopControlledResponse(input);
        if (systemPrompt.includes("role: capability_router"))
          return JSON.stringify({
            selections: createdCapabilityId
              ? [{ capabilityId: createdCapabilityId, reason: "The verification Capability is relevant." }]
              : [],
            reason: createdCapabilityId ? "Selected the relevant Capability." : "No Capability exists yet.",
            learningAttribution: createdCapabilityId
              ? { capabilityId: createdCapabilityId, reason: "Primary behavior under observation." }
              : null,
          });
        if (!systemPrompt.includes("role: reflector")) return `Controlled completion for: ${lastUserText}`;
        reflectorContexts.push(lastUserText);
        reflectorRuns += 1;
        if (reflectorRuns === 1)
          return JSON.stringify({
            decision: "create",
            proposal: {
              name: "Verified completion claims",
              description: "Verify observable state before reporting completion.",
              applicability: "Work that reports a concrete completion state.",
              summary: "Completion claims now require observable verification.",
              rationale: "The settled turn established a reusable verification preference.",
              anticipatedEffect: "Future completion reports are evidence grounded.",
              effects: [{ kind: "instruction", content: strategy }],
              scope: "global",
              activationMode: "relevant",
              consequence: "ordinary",
              consequenceDescription: "Only model instructions change.",
              evidenceCitationIndexes: [0],
            },
          });
        return JSON.stringify({
          decision: "no_change",
          reason: "Keep the current Capability unchanged.",
        });
      },
    });
    const compose = async (activeProject: ProjectRef) =>
      await createApplicationRuntimeComposition({
        config,
        project: activeProject,
        createAgent: (_sessionTools, codeExecution) =>
          createPiAgentRuntime(activeProject.root, controlled.models, { codeExecution }),
        createRoleRunner: (configurations) =>
          createPiAgentRoleRunner(activeProject.root, controlled.models, configurations),
      });
    const first = await compose(project);
    const firstTrail = await first.startTrail({ title: "Project P source" });
    const source = await first.debug.runTurn(firstTrail.trailId, "Finish the first project task.");
    await first.controlPlane.idle();
    if (!source.frozenTurnPlan) throw new Error("Expected the source turn to retain its frozen plan");
    const [definition] = await first.debug.workspace.capabilities.listDefinitions();
    if (!definition)
      throw new Error(
        `Expected the source reflection to create a Capability: ${JSON.stringify(await first.debug.workspace.jobs.list({ limit: 10 }))}`,
      );
    expect(definition.kind).toBeUndefined();
    createdCapabilityId = definition.capabilityId;
    const active = await first.debug.workspace.capabilities.getBinding(definition.capabilityId);
    expect(active).toMatchObject({
      scope: { kind: "global" },
      activationMode: "relevant",
      state: "active",
    });
    if (!active) throw new Error("Expected the source reflection to activate a Capability");
    await first.shutdown();
    const resumed = await compose(project);
    const resumedTrail = await resumed.startTrail({ title: "Project P resumed" });
    const served = await resumed.debug.runTurn(resumedTrail.trailId, "Continue in a new session.");
    expect(served.frozenTurnPlan).toMatchObject({ project });
    expect(
      served.frozenTurnPlan?.selectedCapabilities.some(
        (selection) => selection.capabilityId === definition.capabilityId,
      ),
    ).toBe(true);
    expect(served.frozenTurnPlan?.renderedSystemPrompt).toContain(strategy);
    const next = await resumed.debug.runTurn(resumedTrail.trailId, "Check the prior result and continue.");
    expect(
      next.frozenTurnPlan?.selectedCapabilities.some(
        (selection) => selection.capabilityId === definition.capabilityId,
      ),
    ).toBe(true);
    await resumed.controlPlane.idle();
    expect(reflectorContexts.at(-1)).toContain(definition.capabilityId);
    expect(reflectorContexts.at(-1)).toContain(next.frozenTurnPlan?.turnId);
    await resumed.shutdown();
    const isolated = await compose(otherProject);
    const isolatedTrail = await isolated.startTrail({ title: "Project Q" });
    const isolatedTurn = await isolated.debug.runTurn(isolatedTrail.trailId, "Work in another project.");
    expect(isolatedTurn.frozenTurnPlan).toMatchObject({ project: otherProject });
    expect(
      isolatedTurn.frozenTurnPlan?.selectedCapabilities.some(
        (selection) => selection.capabilityId === definition.capabilityId,
      ),
    ).toBe(true);
    expect(isolatedTurn.frozenTurnPlan?.renderedSystemPrompt).toContain(strategy);
    await isolated.shutdown();
  });
  test("a first-turn correction on a fresh home reflects against the immutable genesis baseline", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-genesis-correction-"));
    roots.push(home);
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    let reflectorRuns = 0;
    const controlled = createControlledPiModels({
      respond: (input) => {
        const { systemPrompt, lastUserText } = input;
        if (systemPrompt.includes("role: history_reranker")) return researchLoopControlledResponse(input);
        if (!systemPrompt.includes("role: reflector")) return `Controlled completion for: ${lastUserText}`;
        reflectorRuns += 1;
        return JSON.stringify({
          decision: "no_change",
          reason: "The single correction is useful evidence but not yet a durable adaptation.",
        });
      },
    });
    const runtime = await createApplicationRuntimeComposition({
      config,
      createAgent: (_sessionTools, codeExecution) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution }),
      createRoleRunner: (configurations) =>
        createPiAgentRoleRunner(process.cwd(), controlled.models, configurations),
    });
    const trail = await runtime.startTrail({ title: "First correction" });
    const result = await runtime.debug.runTurn(trail.trailId, "Actually, keep this research brief concise.");
    expect(result.frozenTurnPlan?.selectedCapabilities).toMatchObject([
      {
        capabilityId: "general-collaboration",
        baseline: { kind: "genesis" },
      },
    ]);
    await runtime.controlPlane.idle();
    expect(reflectorRuns).toBe(1);
    const outcomes = await runtime.debug.workspace.operational.outcomes.listForSession(trail.trailId);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ status: "unknown" });
    await runtime.shutdown();
  });
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  test("propagates an interrupted history tool signal into the protected model reranker", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-history-rerank-cancellation-"));
    roots.push(home);
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    let activeController: AbortController | undefined;
    let markRerankerStarted: (() => void) | undefined;
    const rerankerStarted = new Promise<void>((resolve) => {
      markRerankerStarted = resolve;
    });
    let markRerankerAborted: (() => void) | undefined;
    const rerankerAborted = new Promise<void>((resolve) => {
      markRerankerAborted = resolve;
    });
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const runtime = await createApplicationRuntimeComposition({
      config,
      createAgent: (_sessionTools, codeExecution) =>
        Object.freeze({
          name: "history-rerank-cancellation-agent",
          run: async (request: AgentRuntimeRequest, emit: (event: AgentRuntimeEvent) => void) => {
            const plan = request.frozenTurnPlan;
            if (!plan) throw new Error("Expected a frozen turn plan for history cancellation");
            const controller = new AbortController();
            activeController = controller;
            emit({ type: "status", status: "started" });
            const prepared = await codeExecution.prepare(plan, controller.signal);
            try {
              if (!prepared.invoke) throw new Error("Expected a direct Broker invocation path");
              await prepared.invoke(
                "history.search_sessions",
                Object.freeze({ query: "cancellation boundary sentinel", maxResults: 2 }),
                controller.signal,
                Object.freeze({
                  executionId: `direct:${plan.turnId}`,
                  logicalExecutionId: `${plan.turnId}:history-cancellation`,
                  callId: `${plan.turnId}:direct:history-cancellation`,
                }),
              );
              emit({ type: "status", status: "completed" });
              // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
              return Object.freeze({
                outcome: "completed" as const,
                stopReason: "stop" as const,
                text: "unexpected history completion",
                provider: request.provider,
                model: request.model,
              });
            } catch (error) {
              if (!controller.signal.aborted) throw error;
              emit({ type: "status", status: "aborted" });
              // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
              return Object.freeze({
                outcome: "aborted" as const,
                stopReason: "aborted" as const,
                text: "",
                provider: request.provider,
                model: request.model,
              });
            } finally {
              activeController = undefined;
              await prepared.close();
            }
          },
          steer: async () =>
            Object.freeze({ status: "not-consumed" as const, reason: "not-running" as const }),
          abort: async () => activeController?.abort(new Error("Interrupted history search")),
        }),
      createRoleRunner: (configurations) =>
        createScriptedAgentRoleRunner({
          variants: configurations,
          respond: async (request) => {
            if (request.systemPrompt.includes("role: history_reranker")) {
              markRerankerStarted?.();
              await new Promise<void>((resolve) => {
                const onAbort = () => {
                  markRerankerAborted?.();
                  resolve();
                };
                if (request.signal.aborted) onAbort();
                else request.signal.addEventListener("abort", onAbort, { once: true });
              });
            }
            return scriptedHistoryRerankResponse(request);
          },
        }),
    });
    for (const suffix of ["alpha", "beta"] as const) {
      const sessionId = `prior-${suffix}`;
      await runtime.debug.workspace.operational.sessions.put({
        sessionId,
        title: `Prior ${suffix}`,
        status: "completed",
        provider: "controlled",
        model: "controlled",
        runtime: "controlled",
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:01.000Z",
        metadata: {},
      });
      await runtime.debug.workspace.operational.messages.put({
        messageId: `message-${suffix}`,
        sessionId,
        role: "user",
        content: `Cancellation boundary sentinel from ${suffix}.`,
        sensitivity: "normal",
        createdAt: "2026-08-10T00:00:00.000Z",
        metadata: {},
      });
    }
    const trail = await runtime.startTrail({ title: "History rerank cancellation" });
    await runtime.interact(trail.trailId, {
      type: "submit",
      text: "Search the cancellation boundary sentinel.",
    });
    await rerankerStarted;
    const activeTurnId = (await runtime.inspectInteraction(trail.trailId)).active?.turnId;
    if (!activeTurnId) throw new Error("Expected an active history-search turn");
    await runtime.interact(trail.trailId, { type: "interrupt", turnId: activeTurnId });
    await expect(rerankerAborted).resolves.toBeUndefined();
    await waitUntil(async () => (await runtime.inspectInteraction(trail.trailId)).phase === "idle");
    await runtime.shutdown();
  });
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  test("contains a malformed protected reranking as a failed Broker tool call", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-history-rerank-malformed-"));
    roots.push(home);
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const controlled = createControlledPiModels({
      respond: (input) => {
        if (!input.systemPrompt.includes("role:")) {
          if (!input.context.messages.some((message) => message.role === "toolResult"))
            return controlledToolCallResponse(
              "execute",
              {
                source:
                  'return await tools.history.search_sessions({ query: "malformed reranking sentinel", maxResults: 2 });',
              },
              "malformed-history-search",
            );
          return "The failed history tool call remained contained in the foreground turn.";
        }
        return researchLoopControlledResponse(input);
      },
    });
    const runtime = await createApplicationRuntimeComposition({
      config,
      createAgent: (_sessionTools, codeExecution) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution }),
      createRoleRunner: (configurations) =>
        createScriptedAgentRoleRunner({
          variants: configurations,
          respond: async (request) =>
            request.systemPrompt.includes("role: history_reranker")
              ? Object.freeze({ text: JSON.stringify({ ranking: [] }) })
              : scriptedHistoryRerankResponse(request),
        }),
    });
    for (const suffix of ["alpha", "beta"] as const) {
      const sessionId = `malformed-prior-${suffix}`;
      await runtime.debug.workspace.operational.sessions.put({
        sessionId,
        title: `Malformed prior ${suffix}`,
        status: "completed",
        provider: "controlled",
        model: "controlled",
        runtime: "controlled",
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:01.000Z",
        metadata: {},
      });
      await runtime.debug.workspace.operational.messages.put({
        messageId: `malformed-message-${suffix}`,
        sessionId,
        role: "user",
        content: `Malformed reranking sentinel from ${suffix}.`,
        sensitivity: "normal",
        createdAt: "2026-08-10T00:00:00.000Z",
        metadata: {},
      });
    }
    const trail = await runtime.startTrail({ title: "Malformed history reranking" });
    const result = await runtime.debug.runTurn(trail.trailId, "Recall malformed reranking evidence.");
    expect(result).toMatchObject({
      outcome: "completed",
      output: "The failed history tool call remained contained in the foreground turn.",
    });
    const failedSearch = (
      await runtime.debug.workspace.operational.toolCalls.listForSession(trail.trailId)
    ).find((toolCall) => toolCall.toolName === "history.search_sessions");
    expect(failedSearch).toMatchObject({
      status: "failed",
      response: {
        error: expect.stringMatching(/backend_failure|malformed/iu),
      },
    });
    await runtime.shutdown();
  });
  test("bounds shutdown when ambient reflection ignores abort and leaves recovery to its durable lease", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-bounded-shutdown-"));
    roots.push(home);
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const controlled = createControlledPiModels();
    let markReflectionStarted: (() => void) | undefined;
    const reflectionStarted = new Promise<void>((resolve) => {
      markReflectionStarted = resolve;
    });
    let releaseReflection: (() => void) | undefined;
    const blockedReflection = new Promise<void>((resolve) => {
      releaseReflection = resolve;
    });
    const runtime = await createApplicationRuntimeComposition({
      config,
      createAgent: (_sessionTools, codeExecution) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution }),
      createRoleRunner: (configurations) =>
        createScriptedAgentRoleRunner({
          variants: configurations,
          respond: async (request) => {
            if (request.systemPrompt.includes("role: history_reranker"))
              return scriptedHistoryRerankResponse(request);
            if (!request.systemPrompt.includes("role: reflector"))
              throw new Error("Only reflection should run in the bounded-shutdown fixture");
            markReflectionStarted?.();
            await blockedReflection;
            return Object.freeze({
              text: JSON.stringify({
                decision: "no_change",
                reason: "The fixture releases only after bounded shutdown returns.",
              }),
            });
          },
        }),
    });
    const trail = await runtime.startTrail({ title: "Bounded ambient shutdown" });
    await runtime.debug.runTurn(trail.trailId, "Actually, keep this research brief concise.");
    await reflectionStarted;
    let timeout: NodeJS.Timeout | undefined;
    try {
      const shutdown = runtime.shutdown();
      expect(runtime.shutdown()).toBe(shutdown);
      // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
      const outcome = await Promise.race([
        shutdown.then(() => "settled" as const),
        new Promise<"timed-out">((resolve) => {
          timeout = setTimeout(() => resolve("timed-out"), 1000);
        }),
      ]);
      expect(outcome).toBe("settled");
      const jobs = await runtime.debug.workspace.jobs.list({ limit: 10 });
      expect(jobs).toMatchObject([
        {
          kind: "runtime.reflect_capability",
          status: "running",
          leaseToken: expect.any(String),
          leaseUntil: expect.any(String),
        },
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      releaseReflection?.();
      await runtime.controlPlane.stop();
    }
  });
  test("propagates shutdown cancellation through learning into an active ambient role run", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-cooperative-reflection-shutdown-"));
    roots.push(home);
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const controlled = createControlledPiModels();
    let markReflectionStarted: (() => void) | undefined;
    const reflectionStarted = new Promise<void>((resolve) => {
      markReflectionStarted = resolve;
    });
    let markReflectionAborted: (() => void) | undefined;
    const reflectionAborted = new Promise<void>((resolve) => {
      markReflectionAborted = resolve;
    });
    let releaseReflection: (() => void) | undefined;
    const release = new Promise<void>((resolve) => {
      releaseReflection = resolve;
    });
    const runtime = await createApplicationRuntimeComposition({
      config,
      createAgent: (_sessionTools, codeExecution) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution }),
      createRoleRunner: (configurations) =>
        createScriptedAgentRoleRunner({
          variants: configurations,
          respond: async (request) => {
            if (request.systemPrompt.includes("role: history_reranker"))
              return scriptedHistoryRerankResponse(request);
            if (!request.systemPrompt.includes("role: reflector"))
              throw new Error("Only reflection should run in the cooperative-shutdown fixture");
            markReflectionStarted?.();
            await Promise.race([
              release,
              new Promise<void>((resolve) => {
                const onAbort = () => {
                  markReflectionAborted?.();
                  resolve();
                };
                if (request.signal.aborted) onAbort();
                else request.signal.addEventListener("abort", onAbort, { once: true });
              }),
            ]);
            return Object.freeze({
              text: JSON.stringify({
                decision: "no_change",
                reason: "The role run settled after receiving shutdown cancellation.",
              }),
            });
          },
        }),
    });
    try {
      const trail = await runtime.startTrail({ title: "Cooperative ambient shutdown" });
      await runtime.debug.runTurn(trail.trailId, "Actually, keep this research brief concise.");
      await reflectionStarted;
      await runtime.shutdown();
      // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
      const cancellation = await Promise.race([
        reflectionAborted.then(() => "aborted" as const),
        new Promise<"timed-out">((resolve) => {
          const timeout = setTimeout(() => resolve("timed-out"), 1000);
          timeout.unref();
        }),
      ]);
      expect(cancellation).toBe("aborted");
    } finally {
      releaseReflection?.();
      await runtime.controlPlane.stop();
    }
  });
});
