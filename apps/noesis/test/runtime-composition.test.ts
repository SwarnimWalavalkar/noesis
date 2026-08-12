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
  canonicalJson,
  EvidenceRevisionRefSchema,
  eventChecksum,
  type FileRevisionRef,
  type LedgerEvent,
  type ProjectRef,
  sha256,
} from "@noesis/domain";
import { createMcpHostManager, type LoadedMcpConfig, type McpOAuthCredentialStore } from "@noesis/mcp";
import {
  createHotbarToolAliases,
  createPiAgentRoleRunner,
  createPiAgentRuntime,
  createPiSkillLibrary,
  createRestrictedRoleContextPolicy,
  createStructuredInferencePort,
  type FrozenSessionToolResolver,
  type PiFrozenToolCatalog,
  type PiWorkflowSummary,
  projectWorkflowToolName,
  type RoleBackendRequest,
} from "@noesis/runtime-pi";
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
import { researchLoopControlledResponse } from "./support/research-loop-controlled-response.ts";
import {
  type ApplicationRuntimeCompositionOptions,
  createApplicationRuntimeComposition,
  createModelHistoryRerankPort,
  resolveProjectHotbarSelection,
  waitForReflectionBarrier,
} from "../src/runtime-composition.ts";

const roots: string[] = [];

function scriptedHistoryRerankResponse(request: RoleBackendRequest): { readonly text: string } {
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
      maxCharactersPerMessage: 12_000,
      maxTotalCharacters: 48_000,
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

test("project workflow pins compose only with their own project's global hotbar", () => {
  const alphaTool = projectWorkflowToolName("project_alpha", "alpha");
  const alphaSecondTool = projectWorkflowToolName("project_alpha", "second");
  const betaTool = projectWorkflowToolName("project_beta", "beta");
  const tools = Object.freeze({
    hotbar: Object.freeze(["files.read", "workflows.run", alphaTool, betaTool]),
    projectHotbars: Object.freeze({
      project_alpha: Object.freeze([alphaSecondTool, betaTool]),
      project_beta: Object.freeze([betaTool]),
    }),
  });

  expect(resolveProjectHotbarSelection(tools, "project_alpha")).toEqual({
    global: ["files.read", "workflows.run"],
    project: [alphaSecondTool, alphaTool],
    effective: ["files.read", "workflows.run", alphaSecondTool, alphaTool],
  });
  expect(resolveProjectHotbarSelection(tools, "project_beta")).toEqual({
    global: ["files.read", "workflows.run"],
    project: [betaTool],
    effective: ["files.read", "workflows.run", betaTool],
  });
});

test("MCP pins are effective only in the project that owns them", () => {
  const tools = Object.freeze({
    hotbar: Object.freeze(["files.read", "mcp.github.search_123456789abc"]),
    projectHotbars: Object.freeze({
      project_beta: Object.freeze(["mcp.linear.list_abcdef123456"]),
    }),
  });
  expect(resolveProjectHotbarSelection(tools, "project_alpha")).toEqual({
    global: ["files.read"],
    project: [],
    effective: ["files.read"],
  });
  expect(resolveProjectHotbarSelection(tools, "project_beta")).toEqual({
    global: ["files.read"],
    project: ["mcp.linear.list_abcdef123456"],
    effective: ["files.read", "mcp.linear.list_abcdef123456"],
  });
});

test("active project hotbar load rejects an effective global and project union above 16", () => {
  const projectId = "project_overflow";
  const projectTool = projectWorkflowToolName(projectId, "project-tool");
  const legacyTool = projectWorkflowToolName(projectId, "legacy-tool");
  const globalTools = Array.from({ length: 16 }, (_, index) => `global.${String(index)}`);

  expect(() =>
    resolveProjectHotbarSelection(
      {
        hotbar: globalTools,
        projectHotbars: { [projectId]: [projectTool] },
      },
      projectId,
    ),
  ).toThrow("contains 17 tools");
  expect(() =>
    resolveProjectHotbarSelection(
      {
        hotbar: [...globalTools.slice(0, 15), legacyTool],
        projectHotbars: { [projectId]: [projectTool] },
      },
      projectId,
    ),
  ).toThrow("contains 17 tools");
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

  test("saved definitions are immediate, project-local, and freeze first-class workflow tools", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-project-definitions-"));
    const firstProjectRoot = join(home, "host-project-one");
    const secondProjectRoot = join(home, "host-project-two");
    await Promise.all([
      mkdir(firstProjectRoot, { recursive: true }),
      mkdir(secondProjectRoot, { recursive: true }),
    ]);
    roots.push(home);
    const resolved = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const config = Object.freeze({
      ...resolved,
      learning: Object.freeze({ ...resolved.learning, enabled: false }),
    });
    const firstProject: ProjectRef = Object.freeze({
      projectId: "project_one",
      root: firstProjectRoot,
    });
    const secondProject: ProjectRef = Object.freeze({
      projectId: "project_two",
      root: secondProjectRoot,
    });
    const firstWorkflowTool = (name: string): string => projectWorkflowToolName(firstProject.projectId, name);
    const secondWorkflowTool = (name: string): string =>
      projectWorkflowToolName(secondProject.projectId, name);
    const genericLibraryToolNames = new Set([
      "scripts.list",
      "scripts.describe",
      "scripts.run",
      "workflows.list",
      "workflows.describe",
      "workflows.run",
    ]);
    const genericRevisionSnapshots: Array<Readonly<Record<string, string>>> = [];
    const workflowToolSnapshots: Array<PiFrozenToolCatalog["tools"]> = [];
    let frozenWorkflowSummaries: readonly PiWorkflowSummary[] | undefined;
    let firstClassCatalog: PiFrozenToolCatalog | undefined;
    let savedAndRunValue: unknown;
    let firstClassRevisionOneValue: unknown;
    let firstClassRevisionTwoValue: unknown;
    let secondProjectCatalog: PiFrozenToolCatalog | undefined;
    let secondProjectDirectValue: unknown;
    let foreignWorkflowRunId: string | undefined;
    const foreignLegacyWorkflowRunId = "workflow-run-legacy-project-one";
    let secondProjectSharedSessionValue: unknown;
    let turn = 0;
    const noOp = async (): Promise<void> => undefined;
    const createAgent: ApplicationRuntimeCompositionOptions["createAgent"] = (_sessionTools, codeExecution) =>
      Object.freeze({
        name: "project-definition-agent",
        run: async (request: AgentRuntimeRequest) => {
          const plan = request.frozenTurnPlan;
          if (!plan) throw new Error("Expected a frozen turn plan");
          const signal = new AbortController().signal;
          if (turn === 0)
            await expect(
              codeExecution.prepare(Object.freeze({ ...plan, project: secondProject }), signal, {
                skills: Object.freeze([]),
              }),
            ).rejects.toThrow("does not belong to project");
          if (turn === 1) {
            const { canonicalDigest: priorDigest, ...planBody } = plan;
            void priorDigest;
            const restrictedBody: Omit<FrozenTurnPlan, "canonicalDigest"> = Object.freeze({
              ...planBody,
              permissionSnapshot: Object.freeze({
                effects: Object.freeze(["execute"]),
                resourcePatterns: Object.freeze(["workflow:project-increment:run"]),
                credentialRefs: Object.freeze([]),
              }),
            });
            const restricted = await codeExecution.prepare(
              Object.freeze({
                ...restrictedBody,
                canonicalDigest: frozenTurnPlanDigest(restrictedBody),
              }),
              signal,
              { skills: Object.freeze([]) },
            );
            try {
              if (!restricted.invoke) throw new Error("Expected direct Broker invocation support");
              await expect(
                restricted.invoke(firstWorkflowTool("project-increment"), { value: 1 }, signal, {
                  executionId: `direct:${plan.turnId}`,
                  logicalExecutionId: `${plan.turnId}:resource-scope-check`,
                  callId: `${plan.turnId}:direct:resource-scope-check`,
                }),
              ).rejects.toThrow("workflow:project_one:project-increment:run");
            } finally {
              await restricted.close();
            }
          }
          const prepared = await codeExecution.prepare(plan, signal, { skills: Object.freeze([]) });
          genericRevisionSnapshots.push(
            Object.freeze(
              Object.fromEntries(
                prepared.catalog.tools
                  .filter((tool) => genericLibraryToolNames.has(tool.name))
                  .map((tool) => [tool.name, tool.revisionId]),
              ),
            ),
          );
          workflowToolSnapshots.push(
            Object.freeze(prepared.catalog.tools.filter((tool) => tool.name.startsWith("workflow."))),
          );
          if (turn === 1) {
            firstClassCatalog = prepared.catalog;
            frozenWorkflowSummaries = prepared.workflowSummaries;
          }
          if (turn === 4) secondProjectCatalog = prepared.catalog;
          try {
            const source =
              turn === 0
                ? [
                    "const script = await tools.scripts.save({",
                    '  name: "project-double",',
                    '  description: "Double one numeric input.",',
                    '  source: "return { value: input.value * 2 };",',
                    '  inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },',
                    '  outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },',
                    "  requiredTools: []",
                    "});",
                    "const saved = await tools.workflows.save({",
                    '  name: "project-increment",',
                    '  description: "Increment one numeric input.",',
                    '  inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },',
                    '  outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },',
                    "  phases: [{",
                    '    name: "increment",',
                    '    description: "Increment the value.",',
                    '    source: "return { value: input.value + 1 };",',
                    '    inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },',
                    '    outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },',
                    "    requiredTools: []",
                    "  }]",
                    "});",
                    "const collisionSafe = await tools.workflows.save({",
                    '  name: "execute",',
                    '  description: "A workflow whose name cannot collide with the core execute tool.",',
                    '  inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },',
                    '  outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },',
                    "  phases: [{",
                    '    name: "identity",',
                    '    description: "Return the input value.",',
                    '    source: "return input;",',
                    '    inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },',
                    '    outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },',
                    "    requiredTools: []",
                    "  }]",
                    "});",
                    "await tools.workflows.save({",
                    '  name: "scalar-increment",',
                    '  description: "Increment a scalar number.",',
                    '  inputSchema: { type: "number" },',
                    '  outputSchema: { type: "number" },',
                    '  phases: [{ name: "increment", description: "Increment the number.", source: "return input + 1;", inputSchema: { type: "number" }, outputSchema: { type: "number" }, requiredTools: [] }]',
                    "});",
                    "await tools.workflows.save({",
                    '  name: "reverse-values",',
                    '  description: "Reverse an array of numbers.",',
                    '  inputSchema: { type: "array", items: { type: "number" } },',
                    '  outputSchema: { type: "array", items: { type: "number" } },',
                    '  phases: [{ name: "reverse", description: "Reverse the values.", source: "return [...input].reverse();", inputSchema: { type: "array", items: { type: "number" } }, outputSchema: { type: "array", items: { type: "number" } }, requiredTools: [] }]',
                    "});",
                    "await tools.workflows.save({",
                    '  name: "referenced-object",',
                    '  description: "Increment an object resolved through a composed reference.",',
                    '  inputSchema: { $defs: { payload: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false } }, allOf: [{ $ref: "#/$defs/payload" }] },',
                    '  outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },',
                    '  phases: [{ name: "increment", description: "Increment the referenced object.", source: "return { value: input.value + 1 };", inputSchema: { $defs: { payload: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false } }, allOf: [{ $ref: "#/$defs/payload" }] }, outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false }, requiredTools: [] }]',
                    "});",
                    "await tools.workflows.save({",
                    '  name: "ambiguous-value",',
                    '  description: "Preserve a schema that does not constrain inputs to objects.",',
                    '  inputSchema: { properties: { value: { type: "number" } } },',
                    "  outputSchema: {},",
                    '  phases: [{ name: "identity", description: "Return the input.", source: "return input;", inputSchema: { properties: { value: { type: "number" } } }, outputSchema: {}, requiredTools: [] }]',
                    "});",
                    "const listed = await tools.workflows.list({});",
                    "const described = await tools.workflows.describe({ name: saved.manifest.name });",
                    "const run = await tools.workflows.run({ name: saved.manifest.name, input: { value: 41 } });",
                    "return { script, saved, collisionSafe, listed, described, run };",
                  ].join("\n")
                : turn === 1
                  ? [
                      `const direct = await noesis.invoke(${JSON.stringify(firstWorkflowTool("project-increment"))}, { value: 41 });`,
                      `const scalar = await noesis.invoke(${JSON.stringify(firstWorkflowTool("scalar-increment"))}, { input: 41 });`,
                      `const array = await noesis.invoke(${JSON.stringify(firstWorkflowTool("reverse-values"))}, { input: [1, 2, 3] });`,
                      `const referencedDirect = await noesis.invoke(${JSON.stringify(firstWorkflowTool("referenced-object"))}, { value: 41 });`,
                      'const referencedGeneric = await tools.workflows.run({ name: "referenced-object", input: { value: 41 } });',
                      `const ambiguous = await noesis.invoke(${JSON.stringify(firstWorkflowTool("ambiguous-value"))}, { input: 41 });`,
                      "const updated = await tools.workflows.save({",
                      '  name: "project-increment",',
                      '  description: "Increment one numeric input by two.",',
                      '  inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },',
                      '  outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },',
                      "  phases: [{",
                      '    name: "increment",',
                      '    description: "Increment the value by two.",',
                      '    source: "return { value: input.value + 2 };",',
                      '    inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },',
                      '    outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },',
                      "    requiredTools: []",
                      "  }]",
                      "});",
                      "return { direct, scalar, array, referencedDirect, referencedGeneric, ambiguous, updated };",
                    ].join("\n")
                  : turn === 2
                    ? `return await noesis.invoke(${JSON.stringify(firstWorkflowTool("project-increment"))}, { value: 41 });`
                    : turn === 3
                      ? [
                          "const visibleBeforeSave = await tools.workflows.runs({});",
                          `let foreignResumeError; try { await tools.workflows.resume({ runId: ${JSON.stringify(foreignWorkflowRunId)} }); } catch (error) { foreignResumeError = String(error?.message ?? error); }`,
                          `let legacyResumeError; try { await tools.workflows.resume({ runId: ${JSON.stringify(foreignLegacyWorkflowRunId)} }); } catch (error) { legacyResumeError = String(error?.message ?? error); }`,
                          "const saved = await tools.workflows.save({",
                          '  name: "project-increment",',
                          '  description: "Increment the second project input by ten.",',
                          '  inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },',
                          '  outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },',
                          '  phases: [{ name: "increment", description: "Increment by ten.", source: "return { value: input.value + 10 };", inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false }, outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false }, requiredTools: [] }]',
                          "});",
                          "return { visibleBeforeSave, foreignResumeError, legacyResumeError, saved };",
                        ].join("\n")
                      : turn === 4
                        ? `return await noesis.invoke(${JSON.stringify(secondWorkflowTool("project-increment"))}, { value: 32 });`
                        : "return null;";
            const result = await prepared.execute(source, undefined, signal, () => undefined);
            if (turn === 0) savedAndRunValue = result.value;
            else if (turn === 1) firstClassRevisionOneValue = result.value;
            else if (turn === 2) firstClassRevisionTwoValue = result.value;
            else if (turn === 3) secondProjectSharedSessionValue = result.value;
            else if (turn === 4) secondProjectDirectValue = result.value;
          } finally {
            turn += 1;
            await prepared.close();
          }
          const text = "Project definition operation completed.";
          return Object.freeze({
            outcome: "completed" as const,
            stopReason: "stop" as const,
            text,
            assistantMessages: Object.freeze([
              Object.freeze({ text, timelineSequence: 1, createdAt: new Date().toISOString() }),
            ]),
            provider: request.provider,
            model: request.model,
          });
        },
        steer: async () =>
          Object.freeze({
            status: "consumed" as const,
            timelineSequence: 1,
            consumedAt: new Date().toISOString(),
          }),
        abort: noOp,
      });
    const createRoleRunner: ApplicationRuntimeCompositionOptions["createRoleRunner"] = (configurations) =>
      createScriptedAgentRoleRunner({
        variants: configurations,
        respond: () => ({
          text: '{"observation":{"kind":"other","reason":"Controlled fixture."},"decision":"no_change","reason":"disabled"}',
        }),
      });
    const first = await createApplicationRuntimeComposition({
      config,
      project: firstProject,
      createAgent,
      createRoleRunner,
    });
    const trail = await first.startTrail({ title: "Project-local definitions" });

    await first.debug.runTurn(trail.trailId, "Save and run project-local definitions.");
    const firstProjectScripts = await first.listScripts?.();
    const firstProjectWorkflows = await first.listWorkflows?.();
    await first.debug.runTurn(trail.trailId, "List the project-local definitions again.");
    await first.debug.runTurn(trail.trailId, "Run the revised first-class workflow tool.");

    expect(savedAndRunValue).toMatchObject({
      saved: { manifest: { name: "project-increment", revision: 1 } },
      described: { manifest: { name: "project-increment", revision: 1 } },
      run: { workflowRevision: 1, status: "completed", value: { value: 42 } },
    });
    expect(firstProjectScripts).toMatchObject([
      {
        name: "project-double",
        revision: 1,
        workingPath: "definitions/scripts/projects/project_one/project-double/index.mjs",
      },
    ]);
    expect(firstProjectWorkflows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "project-increment",
          revision: 1,
          workingPath: "definitions/workflows/projects/project_one/project-increment/workflow.json",
        }),
      ]),
    );
    expect(genericRevisionSnapshots).toHaveLength(3);
    expect(genericRevisionSnapshots[1]).toEqual(genericRevisionSnapshots[0]);
    expect(genericRevisionSnapshots[2]).toEqual(genericRevisionSnapshots[1]);
    expect(Object.keys(genericRevisionSnapshots[0] ?? {})).toHaveLength(genericLibraryToolNames.size);
    expect(workflowToolSnapshots[0]).toEqual([]);
    expect(workflowToolSnapshots[1]?.map((tool) => tool.name)).toEqual([
      firstWorkflowTool("ambiguous-value"),
      firstWorkflowTool("execute"),
      firstWorkflowTool("project-increment"),
      firstWorkflowTool("referenced-object"),
      firstWorkflowTool("reverse-values"),
      firstWorkflowTool("scalar-increment"),
    ]);
    const revisionOneTool = workflowToolSnapshots[1]?.find(
      (tool) => tool.name === firstWorkflowTool("project-increment"),
    );
    const revisionTwoTool = workflowToolSnapshots[2]?.find(
      (tool) => tool.name === firstWorkflowTool("project-increment"),
    );
    expect(revisionOneTool).toMatchObject({
      label: "project-increment",
      description: "Increment one numeric input.",
      inputSchema: {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
        additionalProperties: false,
      },
    });
    expect(revisionTwoTool).toMatchObject({
      description: "Increment one numeric input by two.",
    });
    expect(revisionTwoTool?.revisionId).not.toBe(revisionOneTool?.revisionId);
    expect(firstClassRevisionOneValue).toMatchObject({
      direct: { value: 42 },
      scalar: 42,
      array: [3, 2, 1],
      referencedDirect: { value: 42 },
      referencedGeneric: { value: { value: 42 } },
      ambiguous: 41,
      updated: { manifest: { revision: 2 } },
    });
    expect(firstClassRevisionTwoValue).toEqual({ value: 43 });
    expect(
      workflowToolSnapshots[1]?.find((tool) => tool.name === firstWorkflowTool("scalar-increment")),
    ).toMatchObject({
      inputSchema: {
        type: "object",
        properties: { input: { type: "number" } },
        required: ["input"],
        additionalProperties: false,
      },
      outputSchema: { type: "number" },
    });
    expect(
      workflowToolSnapshots[1]?.find((tool) => tool.name === firstWorkflowTool("reverse-values")),
    ).toMatchObject({
      inputSchema: {
        type: "object",
        properties: { input: { type: "array", items: { type: "number" } } },
        required: ["input"],
        additionalProperties: false,
      },
      outputSchema: { type: "array", items: { type: "number" } },
    });
    expect(
      workflowToolSnapshots[1]?.find((tool) => tool.name === firstWorkflowTool("referenced-object")),
    ).toMatchObject({
      inputSchema: {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
        additionalProperties: false,
      },
    });
    expect(
      workflowToolSnapshots[1]?.find((tool) => tool.name === firstWorkflowTool("ambiguous-value")),
    ).toMatchObject({
      inputSchema: {
        type: "object",
        properties: { input: {} },
        required: ["input"],
        additionalProperties: false,
      },
    });
    expect(frozenWorkflowSummaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "project-increment",
          toolName: firstWorkflowTool("project-increment"),
        }),
      ]),
    );
    if (!firstClassCatalog) throw new Error("Expected the frozen first-class workflow catalog");
    const aliases = createHotbarToolAliases(firstClassCatalog);
    expect(aliases.get(firstWorkflowTool("execute"))).toBe("workflow_execute");
    expect(aliases.get(firstWorkflowTool("execute"))).not.toBe("execute");
    expect(aliases.get(firstWorkflowTool("project-increment"))).toBe("workflow_project-increment");
    expect(new Set(aliases.values()).size).toBe(aliases.size);
    const savedReceipts = z
      .strictObject({
        saved: z
          .strictObject({
            definitionRevision: z.strictObject({ revisionId: z.string() }).passthrough(),
          })
          .passthrough(),
      })
      .passthrough()
      .parse(savedAndRunValue);
    const updatedReceipts = z
      .strictObject({
        updated: z
          .strictObject({
            definitionRevision: z.strictObject({ revisionId: z.string() }).passthrough(),
          })
          .passthrough(),
      })
      .passthrough()
      .parse(firstClassRevisionOneValue);
    const projectWorkflowRuns = (
      await first.debug.workspace.operational.workflows.listRunsForSession(trail.trailId)
    ).filter((run) => run.workflowName === "project-increment");
    expect(projectWorkflowRuns.map((run) => run.definitionRevisionId)).toEqual([
      savedReceipts.saved.definitionRevision.revisionId,
      savedReceipts.saved.definitionRevision.revisionId,
      updatedReceipts.updated.definitionRevision.revisionId,
    ]);
    expect(new Set(projectWorkflowRuns.map((run) => run.catalogDigest)).size).toBe(1);
    expect(projectWorkflowRuns.every((run) => run.catalogId === `catalog_${run.catalogDigest}`)).toBe(true);
    expect(projectWorkflowRuns.every((run) => run.projectId === firstProject.projectId)).toBe(true);
    foreignWorkflowRunId = projectWorkflowRuns[0]?.runId;
    if (!foreignWorkflowRunId) throw new Error("Expected a first-project workflow run");
    const legacySource = projectWorkflowRuns[0];
    if (!legacySource) throw new Error("Expected a source workflow run for legacy compatibility");
    if (legacySource.output === undefined || !legacySource.completedAt)
      throw new Error("Expected a completed source workflow run for legacy compatibility");
    const legacyDatabase = new DatabaseSync(first.debug.workspace.unsafeDatabasePathForTesting);
    legacyDatabase.exec("PRAGMA busy_timeout = 5000");
    legacyDatabase
      .prepare(
        `INSERT INTO workflow_runs(
          run_id, project_id, workflow_name, workflow_revision, definition_revision_id,
          session_id, status, current_phase, input_json, output_json,
          created_at, updated_at, completed_at
        ) VALUES (?, NULL, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        foreignLegacyWorkflowRunId,
        legacySource.workflowName,
        legacySource.workflowRevision,
        legacySource.definitionRevisionId,
        legacySource.sessionId,
        legacySource.currentPhase,
        JSON.stringify(legacySource.input),
        JSON.stringify(legacySource.output),
        legacySource.createdAt,
        legacySource.updatedAt,
        legacySource.completedAt,
      );
    legacyDatabase.close();
    await first.shutdown();

    const second = await createApplicationRuntimeComposition({
      config,
      project: secondProject,
      createAgent,
      createRoleRunner,
    });
    expect(await second.listScripts?.()).toEqual([]);
    expect(await second.listWorkflows?.()).toEqual([]);
    await second.debug.runTurn(trail.trailId, "Save the same workflow name in this project.");
    expect(workflowToolSnapshots[3]).toEqual([]);
    await second.debug.runTurn(trail.trailId, "Run this project's workflow tool.");
    expect(workflowToolSnapshots[4]?.map((tool) => tool.name)).toEqual([
      secondWorkflowTool("project-increment"),
    ]);
    expect(
      workflowToolSnapshots[4]?.some((tool) => tool.name === firstWorkflowTool("project-increment")),
    ).toBe(false);
    expect(secondProjectDirectValue).toEqual({ value: 42 });
    expect(secondProjectSharedSessionValue).toMatchObject({
      visibleBeforeSave: [],
      foreignResumeError: expect.stringContaining("belongs to another project"),
      legacyResumeError: expect.stringContaining("is not available in project"),
    });
    expect(await second.inspectExecution?.(trail.trailId, foreignWorkflowRunId)).toBeUndefined();
    expect(await second.inspectExecution?.(trail.trailId, foreignLegacyWorkflowRunId)).toBeUndefined();
    expect(
      (await second.listExecutions?.(trail.trailId))
        ?.filter((execution) => execution.kind === "workflow")
        .map((execution) => execution.label),
    ).toEqual(["project-increment · r1"]);
    if (!secondProjectCatalog) throw new Error("Expected the second project workflow catalog");
    expect(createHotbarToolAliases(secondProjectCatalog).get(secondWorkflowTool("project-increment"))).toBe(
      "workflow_project-increment",
    );
    await second.shutdown();
  });

  test("project saves continue revision lineage from legacy definitions", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-legacy-definition-revisions-"));
    const projectRoot = join(home, "host-project");
    await mkdir(projectRoot, { recursive: true });
    roots.push(home);
    const project: ProjectRef = Object.freeze({ projectId: "project_legacy_seed", root: projectRoot });
    const actor = Object.freeze({ actorId: "legacy-definition-fixture", kind: "system" as const });
    const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
    const objectSchema = Object.freeze({
      type: "object",
      properties: Object.freeze({ value: Object.freeze({ type: "number" }) }),
      required: Object.freeze(["value"]),
      additionalProperties: false,
    });
    const createdFrom = Object.freeze({
      sessionId: "legacy-session",
      turnId: "legacy-turn",
      planId: "legacy-plan",
    });
    const seed = await createWorkspaceStore(home);
    const sourceRevision = await seed.definitions.recordWorkingDefinition({
      workingPath: "scripts/legacy-double/index.mjs",
      bytes: bytes("return { value: input.value * 2 };"),
      actor,
    });
    const legacyScript = Object.freeze({
      kind: "noesis_script",
      name: "legacy-double",
      description: "A legacy saved script.",
      revision: 5,
      sourceRevision,
      inputSchema: objectSchema,
      outputSchema: objectSchema,
      requiredTools: Object.freeze([]),
      createdFrom,
    });
    let scriptDefinitionRevision: FileRevisionRef | undefined;
    for (let revision = 1; revision <= legacyScript.revision; revision += 1) {
      const publication = await seed.definitionPublications.publish({
        namespace: "script",
        definitionId: legacyScript.name,
        revision,
        workingPath: "scripts/legacy-double/script.json",
        bytes: bytes(`${canonicalJson({ ...legacyScript, revision })}\n`),
        ...(scriptDefinitionRevision
          ? { expectedCurrentRevisionId: scriptDefinitionRevision.revisionId }
          : {}),
        provenanceRefs: Object.freeze([sourceRevision]),
        activity: Object.freeze({ kind: "script.legacy_seeded", actor }),
      });
      if (!publication.ok) throw new Error(publication.error.message);
      scriptDefinitionRevision = publication.value.definitionRevision;
    }
    if (!scriptDefinitionRevision) throw new Error("Expected a seeded legacy script revision");
    const legacyWorkflow = Object.freeze({
      kind: "noesis_workflow",
      name: "legacy-increment",
      description: "A legacy saved workflow.",
      revision: 7,
      inputSchema: objectSchema,
      outputSchema: objectSchema,
      phases: Object.freeze([
        Object.freeze({
          name: "increment",
          description: "Increment the value.",
          source: "return { value: input.value + 1 };",
          inputSchema: objectSchema,
          outputSchema: objectSchema,
          requiredTools: Object.freeze([]),
        }),
      ]),
      createdFrom,
    });
    let workflowDefinitionRevision: FileRevisionRef | undefined;
    for (let revision = 1; revision <= legacyWorkflow.revision; revision += 1) {
      const publication = await seed.definitionPublications.publish({
        namespace: "workflow",
        definitionId: legacyWorkflow.name,
        revision,
        workingPath: "workflows/legacy-increment/workflow.json",
        bytes: bytes(`${canonicalJson({ ...legacyWorkflow, revision })}\n`),
        ...(workflowDefinitionRevision
          ? { expectedCurrentRevisionId: workflowDefinitionRevision.revisionId }
          : {}),
        provenanceRefs: Object.freeze([scriptDefinitionRevision]),
        activity: Object.freeze({ kind: "workflow.legacy_seeded", actor }),
      });
      if (!publication.ok) throw new Error(publication.error.message);
      workflowDefinitionRevision = publication.value.definitionRevision;
    }
    if (!workflowDefinitionRevision) throw new Error("Expected a seeded legacy workflow revision");
    const seedPartialProjectPrefix = async (
      namespace: "script" | "workflow",
      workingPath: string,
    ): Promise<void> => {
      const legacyRevisions = await seed.definitionMetadata.listRevisions(
        namespace,
        namespace === "script" ? legacyScript.name : legacyWorkflow.name,
      );
      let current: FileRevisionRef | undefined;
      for (const legacy of legacyRevisions.slice(0, 2)) {
        const publication = await seed.definitionPublications.publish({
          namespace: `${namespace}:${project.projectId}`,
          definitionId: namespace === "script" ? legacyScript.name : legacyWorkflow.name,
          revision: legacy.revision,
          workingPath,
          bytes: await seed.reads.readRevision(legacy.definitionRevision),
          ...(current ? { expectedCurrentRevisionId: current.revisionId } : {}),
          provenanceRefs: Object.freeze([legacy.definitionRevision]),
          activity: Object.freeze({ kind: `${namespace}.legacy_definition_seeded`, actor }),
        });
        if (!publication.ok) throw new Error(publication.error.message);
        current = publication.value.definitionRevision;
      }
    };
    await seedPartialProjectPrefix(
      "script",
      `scripts/projects/${project.projectId}/legacy-double/script.json`,
    );
    await seedPartialProjectPrefix(
      "workflow",
      `workflows/projects/${project.projectId}/legacy-increment/workflow.json`,
    );
    seed.close();

    const resolved = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const config = Object.freeze({
      ...resolved,
      learning: Object.freeze({ ...resolved.learning, enabled: false }),
    });
    let saved: unknown;
    const noOp = async (): Promise<void> => undefined;
    const runtime = await createApplicationRuntimeComposition({
      config,
      project,
      createAgent: (_sessionTools, codeExecution) =>
        Object.freeze({
          name: "legacy-definition-save-agent",
          run: async (request: AgentRuntimeRequest) => {
            const plan = request.frozenTurnPlan;
            if (!plan) throw new Error("Expected a frozen turn plan");
            const signal = new AbortController().signal;
            const prepared = await codeExecution.prepare(plan, signal, { skills: Object.freeze([]) });
            try {
              saved = (
                await prepared.execute(
                  [
                    "const scripts = await Promise.all([3, 4].map(async (multiplier) => await tools.scripts.save({",
                    '  name: "legacy-double", description: "A project-local script revision.",',
                    "  source: `return { value: input.value * ${multiplier} };`,",
                    '  inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },',
                    '  outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },',
                    "  requiredTools: []",
                    "})));",
                    "const workflows = await Promise.all([2, 3].map(async (increment) => await tools.workflows.save({",
                    '  name: "legacy-increment", description: "A project-local workflow revision.",',
                    '  inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },',
                    '  outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },',
                    '  phases: [{ name: "increment", description: "Increment the value.", source: `return { value: input.value + ${increment} };`, inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false }, outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false }, requiredTools: [] }]',
                    "})));",
                    "return { scripts, workflows };",
                  ].join("\n"),
                  undefined,
                  signal,
                  () => undefined,
                )
              ).value;
            } finally {
              await prepared.close();
            }
            return Object.freeze({
              outcome: "completed" as const,
              stopReason: "stop" as const,
              text: "Legacy definitions continued in project scope.",
              provider: request.provider,
              model: request.model,
            });
          },
          steer: async () =>
            Object.freeze({
              status: "consumed" as const,
              timelineSequence: 1,
              consumedAt: new Date().toISOString(),
            }),
          abort: noOp,
        }),
      createRoleRunner: (configurations) =>
        createScriptedAgentRoleRunner({
          variants: configurations,
          respond: () => ({
            text: '{"observation":{"kind":"other","reason":"Controlled fixture."},"decision":"no_change","reason":"disabled"}',
          }),
        }),
    });
    const trail = await runtime.startTrail({ title: "Continue legacy definition revisions" });
    const parseSavedRevisions = (value: unknown) =>
      z
        .strictObject({
          scripts: z.array(z.strictObject({ revision: z.number() }).passthrough()),
          workflows: z.array(
            z
              .strictObject({ manifest: z.strictObject({ revision: z.number() }).passthrough() })
              .passthrough(),
          ),
        })
        .parse(value);

    await runtime.debug.runTurn(trail.trailId, "Save project-local successors.");

    const savedRevisions = parseSavedRevisions(saved);
    expect(savedRevisions.scripts.map((script) => script.revision).sort()).toEqual([6, 7]);
    expect(savedRevisions.workflows.map(({ manifest }) => manifest.revision).sort()).toEqual([8, 9]);
    expect(
      await runtime.debug.workspace.definitionMetadata.getCurrent(
        `script:${project.projectId}`,
        "legacy-double",
      ),
    ).toMatchObject({ revision: 7 });
    expect(
      await runtime.debug.workspace.definitionMetadata.getCurrent(
        `workflow:${project.projectId}`,
        "legacy-increment",
      ),
    ).toMatchObject({ revision: 9 });
    expect(
      await runtime.debug.workspace.definitionMetadata.getCurrent("script", "legacy-double"),
    ).toMatchObject({ revision: 5 });
    expect(
      await runtime.debug.workspace.definitionMetadata.getCurrent("workflow", "legacy-increment"),
    ).toMatchObject({ revision: 7 });
    const laterLegacyScript = await runtime.debug.workspace.definitionPublications.publish({
      namespace: "script",
      definitionId: legacyScript.name,
      revision: 6,
      workingPath: "scripts/legacy-double/script.json",
      bytes: bytes(
        `${canonicalJson({ ...legacyScript, description: "A later legacy script revision.", revision: 6 })}\n`,
      ),
      expectedCurrentRevisionId: scriptDefinitionRevision.revisionId,
      provenanceRefs: Object.freeze([scriptDefinitionRevision]),
      activity: Object.freeze({ kind: "script.later_legacy_revision", actor }),
    });
    if (!laterLegacyScript.ok) throw new Error(laterLegacyScript.error.message);
    const laterLegacyWorkflow = await runtime.debug.workspace.definitionPublications.publish({
      namespace: "workflow",
      definitionId: legacyWorkflow.name,
      revision: 8,
      workingPath: "workflows/legacy-increment/workflow.json",
      bytes: bytes(
        `${canonicalJson({ ...legacyWorkflow, description: "A later legacy workflow revision.", revision: 8 })}\n`,
      ),
      expectedCurrentRevisionId: workflowDefinitionRevision.revisionId,
      provenanceRefs: Object.freeze([workflowDefinitionRevision]),
      activity: Object.freeze({ kind: "workflow.later_legacy_revision", actor }),
    });
    if (!laterLegacyWorkflow.ok) throw new Error(laterLegacyWorkflow.error.message);

    await runtime.debug.runTurn(
      trail.trailId,
      "Save more project-local successors after the legacy fallback changes.",
    );

    const laterSavedRevisions = parseSavedRevisions(saved);
    expect(laterSavedRevisions.scripts.map((script) => script.revision).sort()).toEqual([8, 9]);
    expect(laterSavedRevisions.workflows.map(({ manifest }) => manifest.revision).sort()).toEqual([10, 11]);
    expect(
      await runtime.debug.workspace.definitionMetadata.getCurrent(
        `script:${project.projectId}`,
        "legacy-double",
      ),
    ).toMatchObject({ revision: 9 });
    expect(
      await runtime.debug.workspace.definitionMetadata.getCurrent(
        `workflow:${project.projectId}`,
        "legacy-increment",
      ),
    ).toMatchObject({ revision: 11 });
    expect(
      await runtime.debug.workspace.definitionMetadata.getCurrent("script", "legacy-double"),
    ).toMatchObject({ revision: 6 });
    expect(
      await runtime.debug.workspace.definitionMetadata.getCurrent("workflow", "legacy-increment"),
    ).toMatchObject({ revision: 8 });
    await runtime.shutdown();
  }, 30_000);

  test("workflow resume fails closed when any visible saved definition changes", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-workflow-required-tool-pin-"));
    const projectRoot = join(home, "host-project");
    await mkdir(projectRoot, { recursive: true });
    roots.push(home);
    const resolved = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const config = Object.freeze({
      ...resolved,
      learning: Object.freeze({ ...resolved.learning, enabled: false }),
    });
    const requiredProject = Object.freeze({ projectId: "project_required_pin", root: projectRoot });
    const dependencyToolName = projectWorkflowToolName(requiredProject.projectId, "dependency");
    const dependencySource = `return await noesis.invoke(${JSON.stringify(dependencyToolName)}, input);`;
    let resumeValue: unknown;
    const noOp = async (): Promise<void> => undefined;
    const runtime = await createApplicationRuntimeComposition({
      config,
      project: requiredProject,
      createAgent: (_sessionTools, codeExecution) =>
        Object.freeze({
          name: "required-workflow-pin-agent",
          run: async (request: AgentRuntimeRequest) => {
            const plan = request.frozenTurnPlan;
            if (!plan) throw new Error("Expected a frozen turn plan");
            const signal = new AbortController().signal;
            const executePrepared = async (source: string) => {
              const prepared = await codeExecution.prepare(plan, signal, { skills: Object.freeze([]) });
              try {
                return (await prepared.execute(source, undefined, signal, () => undefined)).value;
              } finally {
                await prepared.close();
              }
            };
            const dependency = (increment: number) =>
              [
                "return await tools.workflows.save({",
                '  name: "dependency", description: "A pinned dependency.",',
                '  inputSchema: { type: "object", properties: { value: { type: "number" }, allow: { type: "boolean" } }, required: ["value", "allow"], additionalProperties: false },',
                '  outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },',
                `  phases: [{ name: "apply", description: "Apply dependency.", source: "return { value: input.value + ${String(increment)} };", inputSchema: { type: "object", properties: { value: { type: "number" }, allow: { type: "boolean" } }, required: ["value", "allow"], additionalProperties: false }, outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false }, requiredTools: [] }]`,
                "});",
              ].join("\n");
            await executePrepared(dependency(1));
            await executePrepared(
              [
                "await tools.workflows.save({",
                '  name: "dependent", description: "Pause before invoking a pinned dependency.",',
                '  inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },',
                '  outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },',
                `  phases: [{ name: "delegate", description: "Delegate.", source: ${JSON.stringify(dependencySource)}, inputSchema: { type: "object", properties: { value: { type: "number" }, allow: { type: "boolean" } }, required: ["value", "allow"], additionalProperties: false }, outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false }, requiredTools: [${JSON.stringify(dependencyToolName)}] }]`,
                "});",
                'try { await tools.workflows.run({ name: "dependent", input: { value: 1 } }); } catch {}',
                "return null;",
              ].join("\n"),
            );
            await executePrepared(dependency(2));
            resumeValue = await executePrepared(
              [
                "const run = (await tools.workflows.runs({})).find((candidate) => candidate.workflowName === 'dependent');",
                "try { return await tools.workflows.resume({ runId: run.runId, correction: { value: 1, allow: true } }); }",
                "catch (error) { return { error: String(error?.message ?? error) }; }",
              ].join("\n"),
            );
            const text = "Required workflow pin checked.";
            return Object.freeze({
              outcome: "completed" as const,
              stopReason: "stop" as const,
              text,
              assistantMessages: Object.freeze([
                Object.freeze({ text, timelineSequence: 1, createdAt: new Date().toISOString() }),
              ]),
              provider: request.provider,
              model: request.model,
            });
          },
          steer: async () =>
            Object.freeze({
              status: "consumed" as const,
              timelineSequence: 1,
              consumedAt: new Date().toISOString(),
            }),
          abort: noOp,
        }),
      createRoleRunner: (configurations) =>
        createScriptedAgentRoleRunner({
          variants: configurations,
          respond: () => ({
            text: '{"observation":{"kind":"other","reason":"Controlled fixture."},"decision":"no_change","reason":"disabled"}',
          }),
        }),
    });
    const trail = await runtime.startTrail({ title: "Required saved workflow pin" });

    await runtime.debug.runTurn(trail.trailId, "Check the required saved workflow pin.");

    expect(resumeValue).toMatchObject({ error: expect.stringContaining("changed saved definitions") });
    expect(
      await runtime.debug.workspace.operational.workflows.listRunsForSession(trail.trailId),
    ).toMatchObject([{ workflowName: "dependent", status: "paused" }]);
    await runtime.shutdown();
  });

  test("rehydrates an exactly replayed script save before same-scope resume runs it", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-script-save-replay-"));
    roots.push(home);
    const markerPath = join(home, "script-save-crashed-once");
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    let replayValue: unknown;
    const noOp = async (): Promise<void> => undefined;
    const runtime = await createApplicationRuntimeComposition({
      config: Object.freeze({
        ...config,
        learning: Object.freeze({ ...config.learning, enabled: false }),
      }),
      createAgent: (_sessionTools, codeExecution) =>
        Object.freeze({
          name: "script-save-replay-agent",
          run: async (request: AgentRuntimeRequest) => {
            const plan = request.frozenTurnPlan;
            if (!plan) throw new Error("Expected a frozen turn plan");
            const signal = new AbortController().signal;
            // Prepare both physical attempts before the first save. The resumed attempt therefore
            // has the original frozen script view and must learn the saved revision from replay.
            const [firstAttempt, resumedAttempt] = await Promise.all([
              codeExecution.prepare(plan, signal, { skills: Object.freeze([]) }),
              codeExecution.prepare(plan, signal, { skills: Object.freeze([]) }),
            ]);
            const source = [
              'const fs = await import("node:fs");',
              "const saved = await tools.scripts.save({",
              '  name: "replayed-double",',
              '  description: "Double one numeric input after a resumed save.",',
              '  source: "return { doubled: input.value * 2 };",',
              '  inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },',
              '  outputSchema: { type: "object", properties: { doubled: { type: "number" } }, required: ["doubled"], additionalProperties: false },',
              "  requiredTools: []",
              "});",
              `if (!fs.existsSync(${JSON.stringify(markerPath)})) {`,
              `  fs.writeFileSync(${JSON.stringify(markerPath)}, "saved-before-crash");`,
              "  process.exit(17);",
              "}",
              "const verification = await tools.scripts.run({ name: saved.name, input: { value: 21 } });",
              "return { savedRevision: saved.revision, verification };",
            ].join("\n");
            const identity = Object.freeze({ logicalExecutionId: "script-save-resume-stable" });
            let crashed = false;
            try {
              await firstAttempt.execute(source, undefined, signal, () => undefined, identity);
            } catch {
              crashed = true;
            } finally {
              await firstAttempt.close();
            }
            if (!crashed) throw new Error("Expected the first physical execution to crash after save");
            try {
              replayValue = (
                await resumedAttempt.execute(source, undefined, signal, () => undefined, identity)
              ).value;
            } finally {
              await resumedAttempt.close();
            }
            const text = "Replayed script revision 1 and verified 42.";
            return Object.freeze({
              outcome: "completed" as const,
              stopReason: "stop" as const,
              text,
              assistantMessages: Object.freeze([
                Object.freeze({ text, timelineSequence: 1, createdAt: new Date().toISOString() }),
              ]),
              provider: request.provider,
              model: request.model,
            });
          },
          steer: async () =>
            Object.freeze({
              status: "consumed" as const,
              timelineSequence: 1,
              consumedAt: new Date().toISOString(),
            }),
          abort: noOp,
        }),
      createRoleRunner: (configurations) =>
        createScriptedAgentRoleRunner({
          variants: configurations,
          respond: () => ({
            text: '{"observation":{"kind":"other","reason":"Controlled replay fixture."},"decision":"no_change","reason":"disabled in replay test"}',
          }),
        }),
    });
    const trail = await runtime.startTrail({ title: "Script save replay" });

    const result = await runtime.debug.runTurn(trail.trailId, "Save and verify a reusable script.");

    expect(result.output).toBe("Replayed script revision 1 and verified 42.");
    expect(replayValue).toMatchObject({
      savedRevision: 1,
      verification: { scriptRevision: 1, value: { doubled: 42 } },
    });
    expect(await runtime.listScripts?.()).toMatchObject([{ name: "replayed-double", revision: 1 }]);
    const executions = await runtime.debug.workspace.operational.codeExecutions.listForSession(trail.trailId);
    const physicalAttempts = executions.filter(
      (execution) => execution.logicalExecutionId === "script-save-resume-stable",
    );
    expect(physicalAttempts).toHaveLength(2);
    expect(physicalAttempts.map((execution) => execution.status).sort()).toEqual(["completed", "failed"]);
    expect(
      (await runtime.debug.workspace.operational.toolCalls.listForSession(trail.trailId)).filter(
        (call) => call.toolName === "scripts.save",
      ),
    ).toHaveLength(1);
    await runtime.shutdown();
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
      createAgent: (_sessionTools, codeExecution, selfTools) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution, selfTools }),
      createRoleRunner: (configurations) =>
        createPiAgentRoleRunner(process.cwd(), controlled.models, configurations),
    });
    const trail = await first.startTrail({ title: "SQLite-authoritative session" });
    await first.shutdown();

    await mkdir(join(home, "ledger"), { recursive: true });
    await writeFile(join(home, "ledger", "events.jsonl"), "{ definitely not valid JSONL\n");

    const reopened = await createApplicationRuntimeComposition({
      config,
      createAgent: (_sessionTools, codeExecution, selfTools) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution, selfTools }),
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
      createAgent: (_sessionTools, codeExecution, selfTools) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution, selfTools }),
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

  test("retains an aborted partial pair for inspection but excludes it after restart and resume", async () => {
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
    const resumedAgent: NoesisAgentRuntime = Object.freeze({
      name: abortedAgent.name,
      run: async (request: AgentRuntimeRequest) => {
        requests.push(request);
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
    expect(requests[0]?.systemPrompt).not.toContain("input attached to an aborted answer");
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
      createAgent: (_sessionTools, codeExecution, selfTools) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution, selfTools }),
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
      createAgent: (_sessionTools, codeExecution, selfTools) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution, selfTools }),
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
    const actionAgent: NoesisAgentRuntime = Object.freeze({
      name: runtimeIdentity,
      run: async (request: AgentRuntimeRequest, emit: (event: AgentRuntimeEvent) => void) => {
        const firstBoundary = Object.freeze({
          text: "Starting.",
          timelineSequence: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
        });
        emit({ type: "assistant-message", ...firstBoundary });
        for (const [index, name] of ["inspect_self", "remember", "adapt", "execute"].entries()) {
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
          name: "remember",
          input: { fixture: "unmatched" },
          timelineSequence: 6,
        });
        const finalBoundary = Object.freeze({
          text: "All actions completed.",
          timelineSequence: 7,
          createdAt: "2026-01-01T00:00:00.000Z",
        });
        emit({ type: "assistant-message", ...finalBoundary });
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
    await first.debug.runTurn(trail.trailId, "Use your full self tool surface");
    expect(first.getTrail(trail.trailId).turns).toEqual([
      {
        input: "Use your full self tool surface",
        output: "Starting.\n\nAll actions completed.",
      },
    ]);
    expect(first.listTrailSummaries().find((summary) => summary.trailId === trail.trailId)).toMatchObject({
      turnCount: 1,
      messageCount: 3,
    });
    const beforeRestart = await first.getTranscript(trail.trailId);
    expect(beforeRestart.flatMap((entry) => (entry.kind === "action" ? [entry.name] : []))).toEqual([
      "inspect_self",
      "remember",
      "adapt",
      "execute",
      "remember",
    ]);
    expect(beforeRestart.flatMap((entry) => (entry.kind === "action" ? [entry.actionId] : []))).toEqual([
      expect.stringMatching(/:action-1$/u),
      expect.stringMatching(/:action-2$/u),
      expect.stringMatching(/:action-3$/u),
      expect.stringMatching(/:action-4$/u),
      expect.stringMatching(/:action-unmatched$/u),
    ]);
    expect(beforeRestart.map((entry) => (entry.kind === "message" ? entry.text : entry.name))).toEqual([
      "Use your full self tool surface",
      "Starting.",
      "inspect_self",
      "remember",
      "adapt",
      "execute",
      "remember",
      "All actions completed.",
    ]);
    expect(
      beforeRestart.find((entry) => entry.kind === "action" && entry.actionId.endsWith("unmatched")),
    ).toMatchObject({
      kind: "action",
      name: "remember",
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
        input: "Use your full self tool surface",
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
      "Run this as its own turn",
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
    const runtime = await createApplicationRuntimeComposition({
      config,
      agent: Object.freeze({
        name: runtimeIdentity,
        run: async (request: AgentRuntimeRequest, emit: (event: AgentRuntimeEvent) => void) => {
          requests.push(request);
          emit({ type: "status", status: "started" });
          if (request.prompt === "aborted input")
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
    await runtime.debug.runTurn(trail.trailId, "aborted input");
    await runtime.interact(trail.trailId, { type: "submit", text: "active input" });
    await activeStarted;
    await runtime.interact(trail.trailId, { type: "steer", text: "delivered steering" });
    releaseActive?.();
    await waitUntil(() => runtime.getTrail(trail.trailId).turns.length === 2);
    await runtime.debug.runTurn(trail.trailId, "inspect history");

    const inspectionRequest = requests.at(-1);
    const history = inspectionRequest?.history ?? [];
    expect(history.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: "user", content: "accepted input" },
      { role: "assistant", content: "reply:accepted input" },
      { role: "user", content: "active input" },
      { role: "user", content: "delivered steering" },
      { role: "assistant", content: "reply:active input" },
    ]);
    expect(history.map((message) => message.content)).not.toContain("aborted input");
    expect(history.map((message) => message.content)).not.toContain("aborted partial output");
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

    const oversized = "x".repeat(12_001);
    await runtime.debug.runTurn(trail.trailId, oversized);
    await runtime.debug.runTurn(trail.trailId, "inspect bounded history");
    const boundedRequest = requests.at(-1);
    expect(boundedRequest?.history?.some((message) => message.content.includes(oversized))).toBe(false);
    expect(
      boundedRequest?.frozenTurnPlan?.conversationHistory?.some((entry) => entry.content.includes(oversized)),
    ).toBe(false);
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
    const immediateHistory = immediateRequest?.history ?? [];
    expect(immediateHistory.map((message) => message.content)).toEqual(expectedInheritedText);
    expect(immediateRequest?.systemPrompt).not.toContain("accepted source input");
    expect(immediateHistory.map((message) => message.content)).not.toContain("failed source input");
    expect(immediateHistory.map((message) => message.content)).not.toContain("aborted source input");
    expect(immediateHistory.map((message) => message.content)).not.toContain("source-only future input");
    const inheritedMessageIds = inheritedMessages.map((message) => message.messageId);
    await first.shutdown();

    const reopenedRequests: AgentRuntimeRequest[] = [];
    const reopened = await createApplicationRuntimeComposition({
      config,
      agent: Object.freeze({
        name: runtimeIdentity,
        run: async (request: AgentRuntimeRequest) => {
          reopenedRequests.push(request);
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
    const restartedHistory = reopenedRequests.at(-1)?.history ?? [];
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
    const actionAgent: NoesisAgentRuntime = Object.freeze({
      name: runtimeIdentity,
      run: async (request: AgentRuntimeRequest, emit: (event: AgentRuntimeEvent) => void) => {
        emit({
          type: "tool-start",
          actionId: "duplicate",
          name: "remember",
          input: { value: 1 },
          timelineSequence: 1,
        });
        emit({
          type: "tool-start",
          actionId: "duplicate",
          name: "remember",
          input: { value: 2 },
          timelineSequence: 2,
        });
        emit({
          type: "tool-start",
          actionId: "later",
          name: "adapt",
          input: { value: 3 },
          timelineSequence: 3,
        });
        emit({
          type: "tool-end",
          actionId: "later",
          name: "adapt",
          isError: false,
          result: { status: "completed" },
        });
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
        expect.objectContaining({ kind: "action", name: "adapt", status: "completed" }),
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
      createAgent: (sessionTools, codeExecution, selfTools, skillLibrary) => {
        frozenSessionTools = sessionTools;
        const capturingCodeExecution = Object.freeze({
          ...codeExecution,
          prepare: async (...arguments_: Parameters<typeof codeExecution.prepare>) => {
            const prepared = await codeExecution.prepare(...arguments_);
            preparedCatalogs.push(prepared.catalog);
            return prepared;
          },
        });
        const pi = createPiAgentRuntime(process.cwd(), controlled.models, {
          codeExecution: capturingCodeExecution,
          selfTools,
          requirePinnedSkillSnapshot: true,
          ...(skillLibrary ? { skills: skillLibrary } : {}),
        });
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
      "Before asking the user to repeat relevant prior work, search previous sessions when it could help.",
    );
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
    expect(config.schemaVersion).toBe(1);
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
    expect(await runtime.debug.workspace.definitionMetadata.listCurrent("runtime_role")).toHaveLength(9);
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
    const runtime = await createApplicationRuntimeComposition({
      config,
      skills,
      createAgent: (_sessionTools, codeExecution, selfTools, skillLibrary) =>
        createPiAgentRuntime(process.cwd(), controlled.models, {
          codeExecution,
          selfTools,
          ...(skillLibrary ? { skills: skillLibrary } : {}),
          requirePinnedSkillSnapshot: true,
        }),
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
    const runtime = await createApplicationRuntimeComposition({
      config,
      skills: observedSkills,
      createAgent: (_sessionTools, codeExecution, selfTools, skillLibrary) =>
        createPiAgentRuntime(process.cwd(), controlled.models, {
          codeExecution,
          selfTools,
          ...(skillLibrary ? { skills: skillLibrary } : {}),
          requirePinnedSkillSnapshot: true,
        }),
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
    const runtime = await createApplicationRuntimeComposition({
      config,
      skills,
      createAgent: (_sessionTools, codeExecution, selfTools, skillLibrary) =>
        createPiAgentRuntime(process.cwd(), controlled.models, {
          codeExecution,
          selfTools,
          ...(skillLibrary ? { skills: skillLibrary } : {}),
          requirePinnedSkillSnapshot: true,
        }),
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
    const reopened = await createApplicationRuntimeComposition({
      config,
      skills: reopenedSkills,
      createAgent: (_sessionTools, codeExecution, selfTools, skillLibrary) =>
        createPiAgentRuntime(process.cwd(), controlled.models, {
          codeExecution,
          selfTools,
          ...(skillLibrary ? { skills: skillLibrary } : {}),
          requirePinnedSkillSnapshot: true,
        }),
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

  test("carries one reflected project adjustment across sessions without leaking it to another project", async () => {
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
    const strategy = "Verify the observable project state before reporting completion.";
    const controlled = createControlledPiModels({
      respond: (input) => {
        const { systemPrompt, lastUserText } = input;
        if (systemPrompt.includes("role: history_reranker")) return researchLoopControlledResponse(input);
        if (!systemPrompt.includes("role: reflector")) return `Controlled completion for: ${lastUserText}`;
        reflectorContexts.push(lastUserText);
        reflectorRuns += 1;
        if (reflectorRuns === 1)
          return JSON.stringify({
            observation: {
              kind: "other",
              reason: "The completed project turn supports a temporary project strategy.",
            },
            decision: "apply_working_adjustment",
            expectedActiveAdjustmentId: null,
            rationale: "This project benefits from checking observable state before completion claims.",
            strategy,
            successSignal: "A later settled project turn reports only verified completion state.",
            evidenceCitationIndexes: [0],
          });
        return JSON.stringify({
          observation: { kind: "other", reason: "No further project strategy change is needed." },
          decision: "no_change",
          reason: "Keep the current project strategy unchanged.",
        });
      },
    });
    const compose = async (activeProject: ProjectRef) =>
      await createApplicationRuntimeComposition({
        config,
        project: activeProject,
        createAgent: (_sessionTools, codeExecution, selfTools) =>
          createPiAgentRuntime(activeProject.root, controlled.models, { codeExecution, selfTools }),
        createRoleRunner: (configurations) =>
          createPiAgentRoleRunner(activeProject.root, controlled.models, configurations),
      });

    const first = await compose(project);
    const firstTrail = await first.startTrail({ title: "Project P source" });
    const source = await first.debug.runTurn(firstTrail.trailId, "Finish the first project task.");
    await first.controlPlane.idle();
    if (!source.frozenTurnPlan) throw new Error("Expected the source turn to retain its frozen plan");
    const active = await first.debug.workspace.workingAdjustments.getActive(project.projectId);
    expect(active).toMatchObject({
      scope: project,
      strategy,
      createdFromTurnId: source.frozenTurnPlan.turnId,
    });
    if (!active) throw new Error("Expected the source reflection to apply a project adjustment");
    await first.shutdown();

    const resumed = await compose(project);
    const resumedTrail = await resumed.startTrail({ title: "Project P resumed" });
    const served = await resumed.debug.runTurn(resumedTrail.trailId, "Continue in a new session.");
    expect(served.frozenTurnPlan).toMatchObject({
      project,
      workingAdjustmentId: active.adjustmentId,
    });
    expect(served.frozenTurnPlan?.renderedSystemPrompt).toContain(strategy);
    const next = await resumed.debug.runTurn(resumedTrail.trailId, "Check the prior result and continue.");
    expect(next.frozenTurnPlan?.workingAdjustmentId).toBe(active.adjustmentId);
    await resumed.controlPlane.idle();
    expect(reflectorContexts.at(-1)).toContain(active.adjustmentId);
    expect(reflectorContexts.at(-1)).toContain(served.frozenTurnPlan?.turnId);
    await resumed.shutdown();

    const isolated = await compose(otherProject);
    const isolatedTrail = await isolated.startTrail({ title: "Project Q" });
    const isolatedTurn = await isolated.debug.runTurn(isolatedTrail.trailId, "Work in another project.");
    expect(isolatedTurn.frozenTurnPlan).toMatchObject({ project: otherProject });
    expect(isolatedTurn.frozenTurnPlan?.workingAdjustmentId).toBeUndefined();
    expect(isolatedTurn.frozenTurnPlan?.renderedSystemPrompt).not.toContain(strategy);
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
          observation: {
            kind: "correction",
            reason: "The user corrects how this research brief should be written.",
          },
          decision: "no_change",
          reason: "The single correction is useful evidence but not yet a durable adaptation.",
        });
      },
    });
    const runtime = await createApplicationRuntimeComposition({
      config,
      createAgent: (_sessionTools, codeExecution, selfTools) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution, selfTools }),
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
    expect(outcomes[0]).toMatchObject({ status: "corrected" });
    await runtime.shutdown();
  });

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
              "search_sessions",
              { query: "malformed reranking sentinel", maxResults: 2 },
              "malformed-history-search",
            );
          return "The failed history tool call remained contained in the foreground turn.";
        }
        return researchLoopControlledResponse(input);
      },
    });
    const runtime = await createApplicationRuntimeComposition({
      config,
      createAgent: (_sessionTools, codeExecution, selfTools) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution, selfTools }),
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
      createAgent: (_sessionTools, codeExecution, selfTools) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution, selfTools }),
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
                observation: {
                  kind: "other",
                  reason: "The fixture is exercising bounded shutdown rather than user feedback.",
                },
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
      const outcome = await Promise.race([
        shutdown.then(() => "settled" as const),
        new Promise<"timed-out">((resolve) => {
          timeout = setTimeout(() => resolve("timed-out"), 1_000);
        }),
      ]);
      expect(outcome).toBe("settled");
      const jobs = await runtime.debug.workspace.jobs.list({ limit: 10 });
      expect(jobs).toMatchObject([
        {
          kind: "runtime.reflect_turn",
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
      createAgent: (_sessionTools, codeExecution, selfTools) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution, selfTools }),
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
                observation: {
                  kind: "other",
                  reason: "The fixture is exercising shutdown cancellation rather than user feedback.",
                },
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
      const cancellation = await Promise.race([
        reflectionAborted.then(() => "aborted" as const),
        new Promise<"timed-out">((resolve) => {
          const timeout = setTimeout(() => resolve("timed-out"), 1_000);
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
