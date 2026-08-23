import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNoesisConfig } from "@noesis/config";
import {
  createAmbiguousSubAgentOutcomeError,
  createPiAgentRuntime,
  createPiSubAgentRunner,
  type PiSubAgentRunRequest,
  projectWorkflowToolName,
} from "@noesis/runtime-pi";
import { afterEach, describe, expect, test } from "vitest";
import {
  CONTROLLED_PI_MODEL,
  CONTROLLED_PI_PROVIDER,
  controlledToolCallResponse,
  createControlledPiModels,
} from "../../../packages/runtime-pi/test/support/controlled-pi-models.ts";
import { createScriptedAgentRoleRunner } from "../../../packages/runtime-pi/test/support/scripted-role-runner.ts";
import { createApplicationRuntimeComposition } from "../src/runtime-composition.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("production codemode journey", () => {
  test("codemode queries the frozen pre-turn context through the canonical Broker path", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-subagent-query-acceptance-"));
    roots.push(home);
    const resolved = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: "stale-default-provider", model: "stale-default-model" }),
    });
    const config = Object.freeze({
      ...resolved,
      learning: Object.freeze({ ...resolved.learning, enabled: false }),
    });
    const nestedRequests: PiSubAgentRunRequest[] = [];
    const controlled = createControlledPiModels({
      respond: ({ context, lastUserText }) => {
        if (context.systemPrompt?.includes("bounded subagent")) return "cobalt";
        if (lastUserText.includes("Seed")) return "The durable seed is cobalt.";
        if (context.messages.at(-1)?.role === "toolResult") return "The nested analysis is complete.";
        if (lastUserText.includes("Oversized"))
          return controlledToolCallResponse(
            "execute",
            {
              source: 'return await agents.run({ prompt: "x".repeat(2_000_000) });',
            },
            "call-query-oversized",
          );
        if (lastUserText.includes("Ambiguous"))
          return controlledToolCallResponse(
            "execute",
            {
              source: 'return await agents.run({ prompt: "Trigger ambiguous timeout." });',
            },
            "call-query-ambiguous",
          );
        if (lastUserText.includes("Repeated"))
          return controlledToolCallResponse(
            "execute",
            {
              source: [
                "const full = context.slice(0);",
                "return await agents.run({ prompt: Array.from({ length: 33 }, () => full) });",
              ].join("\n"),
            },
            "call-query-repeated-context",
          );
        if (lastUserText.includes("Recursive"))
          return controlledToolCallResponse(
            "execute",
            {
              source: 'return await agents.run({ prompt: "Re-enter directly.", tools: ["agents.run"] });',
            },
            "call-query-recursion",
          );
        return controlledToolCallResponse(
          "execute",
          {
            source: [
              "const selected = context.slice(0);",
              'const answer = await agents.run({ prompt: ["Return the durable seed word.", selected] });',
              "return { contextLength: context.length, answer };",
            ].join("\n"),
          },
          "call-query-context",
        );
      },
    });
    const runtime = await createApplicationRuntimeComposition({
      config,
      subAgent: Object.freeze({
        run: async (request: PiSubAgentRunRequest) => {
          nestedRequests.push(request);
          if (request.plan.prompt === "Trigger ambiguous timeout.") {
            request.onTelemetry?.({
              usage: {
                inputTokens: 13,
                outputTokens: 5,
                totalTokens: 18,
                estimatedCost: 0.25,
              },
              modelCalls: 1,
              toolCalls: 0,
            });
            throw createAmbiguousSubAgentOutcomeError();
          }
          return await createPiSubAgentRunner(process.cwd(), controlled.models).run(request);
        },
      }),
      createAgent: (_sessionTools, codeExecution, selfTools) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution, selfTools }),
      createRoleRunner: (configurations) =>
        createScriptedAgentRoleRunner({
          variants: configurations,
          respond: () => ({
            text: '{"observation":{"kind":"other","reason":"Controlled acceptance fixture."},"decision":"no_change","reason":"disabled in acceptance"}',
          }),
        }),
    });
    const trail = await runtime.startTrail({
      title: "Nested model query acceptance",
      provider: CONTROLLED_PI_PROVIDER,
      model: CONTROLLED_PI_MODEL,
    });

    await runtime.debug.runTurn(trail.trailId, "Seed the session with cobalt.");
    const result = await runtime.debug.runTurn(
      trail.trailId,
      "Use codemode to ask a model about the previous session context.",
      { thinkingLevel: "xhigh" },
    );

    expect(result.output).toBe("The nested analysis is complete.");
    expect(nestedRequests).toHaveLength(1);
    const nested = nestedRequests[0];
    if (!nested) throw new Error("Expected one nested model request");
    expect(nested.plan.prompt).toContain("Return the durable seed word.");
    expect(nested.plan.prompt).toContain("Seed the session with cobalt.");
    expect(nested.plan.prompt).toContain("The durable seed is cobalt.");
    expect(nested.plan.prompt).not.toContain("Use codemode to ask a model");
    expect(nested.plan.systemPrompt).toContain("You are a bounded subagent inside Noesis.");
    expect(nested.plan.route).toEqual({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL });
    expect(nested.plan.thinkingLevel).toBe("xhigh");
    expect(result.frozenTurnPlan?.subAgentDefaults).toMatchObject({
      provider: CONTROLLED_PI_PROVIDER,
      model: CONTROLLED_PI_MODEL,
      thinkingLevel: "xhigh",
    });
    const modelCalls = await runtime.debug.workspace.operational.modelCalls.listForSession(trail.trailId);
    expect(modelCalls).toMatchObject([
      {
        status: "completed",
        provider: CONTROLLED_PI_PROVIDER,
        model: CONTROLLED_PI_MODEL,
        usage: expect.objectContaining({ totalTokens: expect.any(Number) }),
        requestArtifactId: expect.any(String),
        outputArtifactId: expect.any(String),
      },
    ]);
    const calls = await runtime.debug.workspace.operational.toolCalls.listForSession(trail.trailId);
    expect(calls.map((call) => call.toolName)).toEqual(["execute", "agents.run"]);
    await runtime.debug.runTurn(trail.trailId, "Oversized nested request.");
    expect(nestedRequests).toHaveLength(1);
    expect(await runtime.debug.workspace.operational.modelCalls.listForSession(trail.trailId)).toHaveLength(
      1,
    );
    await runtime.debug.runTurn(trail.trailId, "Repeated full context nested request.");
    expect(nestedRequests).toHaveLength(1);
    expect(await runtime.debug.workspace.operational.modelCalls.listForSession(trail.trailId)).toHaveLength(
      1,
    );
    await runtime.debug.runTurn(trail.trailId, "Recursive subagent request.");
    expect(nestedRequests).toHaveLength(1);
    expect(await runtime.debug.workspace.operational.modelCalls.listForSession(trail.trailId)).toHaveLength(
      1,
    );
    await runtime.debug.runTurn(trail.trailId, "Ambiguous nested request.");
    expect(await runtime.debug.workspace.operational.modelCalls.listForSession(trail.trailId)).toMatchObject([
      { status: "completed" },
      {
        status: "interrupted",
        error: "Subagent timed out before its provider outcome was observed",
        usage: {
          inputTokens: 13,
          outputTokens: 5,
          totalTokens: 18,
          estimatedCost: 0.25,
        },
      },
    ]);
    await runtime.shutdown();
  });

  test("a tool-using subagent remains visible as one nested durable action tree", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-subagent-tools-acceptance-"));
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
    const controlled = createControlledPiModels({
      respond: ({ context, systemPrompt }) => {
        if (systemPrompt.includes("bounded subagent"))
          return context.messages.at(-1)?.role === "toolResult"
            ? "The package metadata was read by the subagent."
            : controlledToolCallResponse(
                "file_read",
                { path: "package.json", startLine: 1, endLine: 4 },
                "call-subagent-read",
              );
        return context.messages.at(-1)?.role === "toolResult"
          ? "The foreground received the subagent result."
          : controlledToolCallResponse(
              "execute",
              {
                source:
                  'return await agents.run({ systemPrompt: "Inspect one file.", prompt: "Read the package metadata.", tools: ["files.read"], thinkingLevel: "low" });',
              },
              "call-run-subagent",
            );
      },
    });
    const runtime = await createApplicationRuntimeComposition({
      config,
      subAgent: createPiSubAgentRunner(process.cwd(), controlled.models),
      createAgent: (_sessionTools, codeExecution, selfTools) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution, selfTools }),
      createRoleRunner: (configurations) =>
        createScriptedAgentRoleRunner({
          variants: configurations,
          respond: () => ({
            text: '{"observation":{"kind":"other","reason":"Controlled acceptance fixture."},"decision":"no_change","reason":"disabled in acceptance"}',
          }),
        }),
    });
    const trail = await runtime.startTrail({ title: "Tool-using subagent acceptance" });

    const result = await runtime.debug.runTurn(trail.trailId, "Delegate one bounded file read.");

    expect(result.output).toBe("The foreground received the subagent result.");
    const transcriptActions = (await runtime.getTranscript(trail.trailId)).filter(
      (entry) => entry.kind === "action",
    );
    expect(transcriptActions.map((action) => action.name)).toEqual(["execute", "agents.run", "files.read"]);
    const [executeAction, subAgentAction, childAction] = transcriptActions;
    expect(subAgentAction).toMatchObject({ parentActionId: executeAction?.actionId, status: "completed" });
    expect(childAction).toMatchObject({ parentActionId: subAgentAction?.actionId, status: "completed" });
    const modelCalls = await runtime.debug.workspace.operational.modelCalls.listForSession(trail.trailId);
    expect(modelCalls).toMatchObject([
      {
        modelCallId: subAgentAction?.actionId,
        provider: CONTROLLED_PI_PROVIDER,
        model: CONTROLLED_PI_MODEL,
        thinkingLevel: "low",
        status: "completed",
      },
    ]);
    const inspected = subAgentAction
      ? await runtime.inspectExecution?.(trail.trailId, subAgentAction.actionId)
      : undefined;
    expect(inspected).toMatchObject({
      kind: "subagent",
      prompt: "Read the package metadata.",
      systemPrompt: expect.stringContaining("Inspect one file."),
      provider: CONTROLLED_PI_PROVIDER,
      model: CONTROLLED_PI_MODEL,
      thinkingLevel: "low",
      toolNames: ["files.read"],
      callCount: 1,
      status: "completed",
    });
    await runtime.shutdown();
  });

  test("subagents may run safe saved programs but actual descendant delegation fails closed", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-subagent-program-recursion-"));
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
    const nestedRequests: PiSubAgentRunRequest[] = [];
    const controlled = createControlledPiModels({
      respond: ({ context, lastUserText, systemPrompt }) => {
        if (systemPrompt.includes("bounded subagent")) {
          if (context.messages.at(-1)?.role === "toolResult") return "Saved program attempt settled.";
          return controlledToolCallResponse(
            "scripts_run",
            {
              name: lastUserText.includes("safe") ? "safe-subagent-program" : "recursive-subagent-program",
              input: {},
            },
            lastUserText.includes("safe") ? "call-subagent-safe-script" : "call-subagent-recursive-script",
          );
        }
        if (context.messages.at(-1)?.role === "toolResult") return "Foreground delegation settled.";
        if (lastUserText.includes("Save"))
          return controlledToolCallResponse(
            "execute",
            {
              source: [
                "await tools.scripts.save({",
                '  name: "safe-subagent-program", description: "Return a local value.",',
                '  source: "return { safe: true };",',
                '  inputSchema: { type: "object", properties: {}, additionalProperties: false },',
                '  outputSchema: { type: "object", properties: { safe: { type: "boolean" } }, required: ["safe"], additionalProperties: false },',
                "  requiredTools: []",
                "});",
                "await tools.scripts.save({",
                '  name: "recursive-subagent-program", description: "Attempt descendant delegation.",',
                '  source: "return await agents.run({ prompt: \\"Nested recursion.\\" });",',
                '  inputSchema: { type: "object", properties: {}, additionalProperties: false },',
                '  outputSchema: { type: "string" },',
                '  requiredTools: ["agents.run"]',
                "});",
                "return null;",
              ].join("\n"),
            },
            "call-save-subagent-programs",
          );
        return controlledToolCallResponse(
          "execute",
          {
            source: `return await agents.run({ prompt: ${JSON.stringify(
              lastUserText.includes("safe")
                ? "Run the safe saved program."
                : "Run the recursive saved program.",
            )}, tools: ["scripts.run"] });`,
          },
          lastUserText.includes("safe") ? "call-safe-program-subagent" : "call-recursive-program-subagent",
        );
      },
    });
    const runtime = await createApplicationRuntimeComposition({
      config,
      subAgent: Object.freeze({
        run: async (request: PiSubAgentRunRequest) => {
          nestedRequests.push(request);
          return await createPiSubAgentRunner(process.cwd(), controlled.models).run(request);
        },
      }),
      createAgent: (_sessionTools, codeExecution, selfTools) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution, selfTools }),
      createRoleRunner: (configurations) =>
        createScriptedAgentRoleRunner({
          variants: configurations,
          respond: () => ({
            text: '{"observation":{"kind":"other","reason":"Controlled acceptance fixture."},"decision":"no_change","reason":"disabled in acceptance"}',
          }),
        }),
    });
    const trail = await runtime.startTrail({ title: "Saved-program subagent recursion acceptance" });

    await runtime.debug.runTurn(trail.trailId, "Save subagent programs.");
    await expect(
      runtime.debug.runTurn(trail.trailId, "Run the safe program through a subagent."),
    ).resolves.toMatchObject({ output: "Foreground delegation settled." });
    await expect(
      runtime.debug.runTurn(trail.trailId, "Run the recursive program through a subagent."),
    ).resolves.toMatchObject({ output: "Foreground delegation settled." });

    expect(nestedRequests).toHaveLength(2);
    expect(nestedRequests.map((request) => request.plan.tools)).toEqual([["scripts.run"], ["scripts.run"]]);
    expect(await runtime.debug.workspace.operational.modelCalls.listForSession(trail.trailId)).toMatchObject([
      { status: "completed" },
      { status: "completed" },
    ]);
    const calls = await runtime.debug.workspace.operational.toolCalls.listForSession(trail.trailId);
    const scriptCalls = calls.filter((call) => call.toolName === "scripts.run");
    expect(scriptCalls).toMatchObject([{ status: "completed" }, { status: "failed" }]);
    const descendantDelegation = calls.find(
      (call) => call.toolName === "agents.run" && call.status === "failed",
    );
    expect(descendantDelegation).toMatchObject({
      parentToolCallId: scriptCalls[1]?.toolCallId,
      response: { error: "Subagents cannot recursively invoke agents.run" },
    });
    await runtime.shutdown();
  });

  test("a direct hotbar read records one Broker action without a codemode execution", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-hotbar-acceptance-"));
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
    const controlled = createControlledPiModels({
      respond: ({ context }) =>
        context.messages.at(-1)?.role === "toolResult"
          ? "Read the package directly."
          : controlledToolCallResponse(
              "file_read",
              { path: "package.json", startLine: 1, endLine: 4 },
              "call-direct-read",
            ),
    });
    const runtime = await createApplicationRuntimeComposition({
      config,
      createAgent: (_sessionTools, codeExecution, selfTools) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution, selfTools }),
      createRoleRunner: (configurations) =>
        createScriptedAgentRoleRunner({
          variants: configurations,
          respond: () => ({
            text: '{"observation":{"kind":"other","reason":"Controlled acceptance fixture."},"decision":"no_change","reason":"disabled in acceptance"}',
          }),
        }),
    });
    const trail = await runtime.startTrail({ title: "Direct hotbar acceptance" });

    const result = await runtime.debug.runTurn(trail.trailId, "Read the package metadata.");

    expect(result.output).toBe("Read the package directly.");
    const calls = await runtime.debug.workspace.operational.toolCalls.listForSession(trail.trailId);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      toolName: "files.read",
      status: "completed",
      timelineSequence: 1,
    });
    expect(
      (await runtime.getTranscript(trail.trailId)).flatMap((entry) =>
        entry.kind === "action" ? [entry.name] : [],
      ),
    ).toEqual(["files.read"]);
    expect(await runtime.debug.workspace.operational.codeExecutions.listForSession(trail.trailId)).toEqual(
      [],
    );
    await runtime.shutdown();
  });

  test("the production read grant admits an explicitly named file outside the project", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-external-read-"));
    const outside = await mkdtemp(join(tmpdir(), "noesis-external-file-"));
    const path = join(outside, "skill.md");
    await writeFile(path, "External skill instructions.\n", "utf8");
    roots.push(home, outside);
    const resolved = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const config = Object.freeze({
      ...resolved,
      learning: Object.freeze({ ...resolved.learning, enabled: false }),
    });
    const controlled = createControlledPiModels({
      respond: ({ context }) =>
        context.messages.at(-1)?.role === "toolResult"
          ? "External file read."
          : controlledToolCallResponse("file_read", { path }, "call-external-file-read"),
    });
    const runtime = await createApplicationRuntimeComposition({
      config,
      createAgent: (_sessionTools, codeExecution, selfTools) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution, selfTools }),
      createRoleRunner: (configurations) =>
        createScriptedAgentRoleRunner({
          variants: configurations,
          respond: () => ({
            text: '{"observation":{"kind":"other","reason":"Controlled acceptance fixture."},"decision":"no_change","reason":"disabled in acceptance"}',
          }),
        }),
    });
    const trail = await runtime.startTrail({ title: "External read acceptance" });

    await expect(runtime.debug.runTurn(trail.trailId, "Read an external skill file.")).resolves.toMatchObject(
      {
        output: "External file read.",
      },
    );
    expect(
      (await runtime.debug.workspace.operational.toolCalls.listForSession(trail.trailId))[0],
    ).toMatchObject({
      toolName: "files.read",
      status: "completed",
      response: { output: { content: "External skill instructions." } },
    });
    await runtime.shutdown();
  });

  test("direct saved-code hotbar calls do not persist synthetic codemode parents", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-direct-saved-code-"));
    roots.push(home);
    const project = Object.freeze({ projectId: "project_direct_saved_code", root: process.cwd() });
    const workflowTool = projectWorkflowToolName(project.projectId, "direct-increment");
    const resolved = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const config = Object.freeze({
      ...resolved,
      learning: Object.freeze({ ...resolved.learning, enabled: false }),
      tools: Object.freeze({
        hotbar: Object.freeze([...resolved.tools.hotbar, "workflows.run", "scripts.run"]),
        projectHotbars: Object.freeze({ [project.projectId]: Object.freeze([workflowTool]) }),
      }),
    });
    const savedProgramSubAgentPrompts: string[] = [];
    let releaseFirstSubAgent = (): void => undefined;
    const firstSubAgentGate = new Promise<void>((resolve) => {
      releaseFirstSubAgent = resolve;
    });
    let markFirstSubAgentStarted = (): void => undefined;
    const firstSubAgentStarted = new Promise<void>((resolve) => {
      markFirstSubAgentStarted = resolve;
    });
    let firstSubAgent = true;
    const controlled = createControlledPiModels({
      respond: ({ context, lastUserText, systemPrompt }) => {
        if (systemPrompt.includes("bounded subagent"))
          return context.messages.at(-1)?.role === "toolResult"
            ? "saved-program-subagent-ok"
            : controlledToolCallResponse(
                "file_read",
                { path: "package.json", startLine: 1, endLine: 2 },
                "call-saved-program-read",
              );
        if (context.messages.at(-1)?.role === "toolResult") return `Completed: ${lastUserText}`;
        if (lastUserText.includes("Save"))
          return controlledToolCallResponse(
            "execute",
            {
              source: [
                "await tools.scripts.save({",
                '  name: "direct-double", description: "Double one value.",',
                '  source: "const answer = await agents.run({ prompt: \\"script subagent\\", tools: [\\"files.read\\"] }); return { doubled: input.value * 2, answer };",',
                '  inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },',
                '  outputSchema: { type: "object", properties: { doubled: { type: "number" }, answer: { type: "string" } }, required: ["doubled", "answer"], additionalProperties: false },',
                '  requiredTools: ["agents.run", "files.read"]',
                "});",
                "await tools.workflows.save({",
                '  name: "direct-increment", description: "Increment one value.",',
                '  inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },',
                '  outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },',
                '  phases: [{ name: "increment", description: "Increment.", source: "await agents.run({ prompt: \\"workflow subagent\\", tools: [\\"files.read\\"] }); return { value: input.value + 1 };", inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false }, outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false }, requiredTools: ["agents.run", "files.read"] }]',
                "});",
                "return null;",
              ].join("\n"),
            },
            "call-save-direct-code",
          );
        if (lastUserText.includes("generic workflow"))
          return controlledToolCallResponse(
            "workflows_run",
            { name: "direct-increment", input: { value: 41 } },
            "call-direct-generic-workflow",
          );
        if (lastUserText.includes("saved workflow"))
          return controlledToolCallResponse(
            "workflow_direct-increment",
            { value: 41 },
            "call-direct-saved-workflow",
          );
        return controlledToolCallResponse(
          "scripts_run",
          { name: "direct-double", input: { value: 21 } },
          "call-direct-script",
        );
      },
    });
    const runtime = await createApplicationRuntimeComposition({
      config,
      project,
      subAgent: Object.freeze({
        run: async (request: PiSubAgentRunRequest) => {
          savedProgramSubAgentPrompts.push(request.plan.prompt);
          if (firstSubAgent) {
            firstSubAgent = false;
            markFirstSubAgentStarted();
            await firstSubAgentGate;
          }
          return await createPiSubAgentRunner(process.cwd(), controlled.models).run(request);
        },
      }),
      createAgent: (_sessionTools, codeExecution, selfTools) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution, selfTools }),
      createRoleRunner: (configurations) =>
        createScriptedAgentRoleRunner({
          variants: configurations,
          respond: () => ({
            text: '{"observation":{"kind":"other","reason":"Controlled acceptance fixture."},"decision":"no_change","reason":"disabled in acceptance"}',
          }),
        }),
    });
    const trail = await runtime.startTrail({ title: "Direct saved-code acceptance" });

    await runtime.debug.runTurn(trail.trailId, "Save a script and workflow.");
    const liveEvents: {
      readonly type: string;
      readonly actionId?: string;
      readonly parentActionId?: string;
      readonly name?: string;
    }[] = [];
    const genericWorkflowRun = runtime.debug.runTurn(trail.trailId, "Run the generic workflow hotbar tool.", {
      onEvent: (event) => liveEvents.push(event),
    });
    await firstSubAgentStarted;
    const liveWorkflow = liveEvents.find(
      (event) => event.type === "tool-start" && event.name === "workflows.run",
    );
    const liveSubAgent = liveEvents.find(
      (event) => event.type === "tool-start" && event.name === "agents.run",
    );
    expect(liveSubAgent).toMatchObject({ parentActionId: liveWorkflow?.actionId });
    releaseFirstSubAgent();
    await genericWorkflowRun;
    await runtime.debug.runTurn(trail.trailId, "Run the saved workflow hotbar tool.");
    await runtime.debug.runTurn(trail.trailId, "Run the saved script hotbar tool.");

    const calls = await runtime.debug.workspace.operational.toolCalls.listForSession(trail.trailId);
    expect(
      calls
        .filter((call) => ["workflows.run", workflowTool, "scripts.run"].includes(call.toolName))
        .map((call) => ({ toolName: call.toolName, status: call.status })),
    ).toEqual([
      { toolName: "workflows.run", status: "completed" },
      { toolName: workflowTool, status: "completed" },
      { toolName: "scripts.run", status: "completed" },
    ]);
    expect(
      await runtime.debug.workspace.operational.workflows.listRunsForSession(trail.trailId),
    ).toMatchObject([
      { workflowName: "direct-increment", status: "completed", output: { value: 42 } },
      { workflowName: "direct-increment", status: "completed", output: { value: 42 } },
    ]);
    const executions = await runtime.debug.workspace.operational.codeExecutions.listForSession(trail.trailId);
    expect(executions).toHaveLength(4);
    expect(executions.every((execution) => execution.parentExecutionId === undefined)).toBe(true);
    expect(
      executions.some(
        (execution) =>
          JSON.stringify(execution.result) === '{"doubled":42,"answer":"saved-program-subagent-ok"}',
      ),
    ).toBe(true);
    expect(savedProgramSubAgentPrompts).toEqual([
      "workflow subagent",
      "workflow subagent",
      "script subagent",
    ]);
    expect(await runtime.debug.workspace.operational.modelCalls.listForSession(trail.trailId)).toMatchObject([
      { status: "completed" },
      { status: "completed" },
      { status: "completed" },
    ]);
    const savedProgramCalls = calls.filter((call) =>
      ["workflows.run", workflowTool, "scripts.run", "agents.run", "files.read"].includes(call.toolName),
    );
    const savedProgramSubAgents = savedProgramCalls.filter((call) => call.toolName === "agents.run");
    expect(savedProgramSubAgents).toHaveLength(3);
    for (const subAgentCall of savedProgramSubAgents) {
      expect(subAgentCall.parentToolCallId).toBeDefined();
      expect(
        savedProgramCalls.find(
          (call) => call.toolName === "files.read" && call.parentToolCallId === subAgentCall.toolCallId,
        ),
      ).toBeDefined();
    }
    const directActions = (await runtime.getTranscript(trail.trailId)).filter(
      (entry) =>
        entry.kind === "action" && ["workflows.run", workflowTool, "scripts.run"].includes(entry.name),
    );
    expect(directActions).toHaveLength(3);
    expect(
      directActions.every((action) => action.kind === "action" && action.parentActionId === undefined),
    ).toBe(true);
    const transcriptBeforeRestart = await runtime.getTranscript(trail.trailId);
    await runtime.shutdown();

    const reopened = await createApplicationRuntimeComposition({
      config,
      project,
      subAgent: createPiSubAgentRunner(process.cwd(), controlled.models),
      createAgent: (_sessionTools, codeExecution, selfTools) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution, selfTools }),
      createRoleRunner: (configurations) =>
        createScriptedAgentRoleRunner({
          variants: configurations,
          respond: () => ({
            text: '{"observation":{"kind":"other","reason":"Controlled acceptance fixture."},"decision":"no_change","reason":"disabled in acceptance"}',
          }),
        }),
    });
    expect(await reopened.getTranscript(trail.trailId)).toEqual(transcriptBeforeRestart);
    await reopened.shutdown();
  });

  test("Pi sees the default hotbar and nested execute calls use the recorded broker path", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-codemode-acceptance-"));
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
    let observedToolNames: readonly string[] = [];
    const executionSource = [
      'console.log("source output");',
      'console.error("diagnostic output");',
      'const file = await tools.files.read({ path: "package.json", startLine: 1, endLine: 4 });',
      'return { foundNoesis: file.content.includes("noesis") };',
    ].join("\n");
    const controlled = createControlledPiModels({
      respond: ({ context }) => {
        observedToolNames = Object.freeze((context.tools ?? []).map((tool) => tool.name).sort());
        const toolResult = context.messages.findLast((message) => message.role === "toolResult");
        if (!toolResult)
          return controlledToolCallResponse(
            "execute",
            {
              source: executionSource,
            },
            "call-execute",
          );
        return JSON.stringify(context.messages).includes("foundNoesis")
          ? "Repository inspected through codemode."
          : "Codemode result missing.";
      },
    });
    const runtime = await createApplicationRuntimeComposition({
      config,
      createAgent: (_sessionTools, codeExecution, selfTools) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution, selfTools }),
      createRoleRunner: (configurations) =>
        createScriptedAgentRoleRunner({
          variants: configurations,
          respond: () => ({
            text: '{"observation":{"kind":"other","reason":"Controlled acceptance fixture."},"decision":"no_change","reason":"disabled in acceptance"}',
          }),
        }),
    });
    const trail = await runtime.startTrail({ title: "Codemode acceptance" });

    const result = await runtime.debug.runTurn(trail.trailId, "Inspect the repository package.");

    expect(result.output).toBe("Repository inspected through codemode.");
    expect(observedToolNames).toEqual([
      "adapt",
      "execute",
      "file_read",
      "inspect_self",
      "list_dir",
      "remember",
      "shell",
    ]);
    const storedCalls = await runtime.debug.workspace.operational.toolCalls.listForSession(trail.trailId);
    const nestedCall = storedCalls.find((call) => call.toolName === "files.read");
    expect(nestedCall).toMatchObject({
      toolName: "files.read",
      status: "completed",
      parentToolCallId: expect.stringContaining(":"),
      timelineSequence: 2,
    });
    const executions = await runtime.debug.workspace.operational.codeExecutions.listForSession(trail.trailId);
    const execution = executions[0];
    if (!execution) throw new Error("Expected a recorded codemode execution");
    const transcriptActions = (await runtime.getTranscript(trail.trailId)).filter(
      (entry) => entry.kind === "action",
    );
    expect(transcriptActions.map((action) => action.name)).toEqual(["execute", "files.read"]);
    expect(storedCalls).toHaveLength(2);
    expect(transcriptActions[1]?.actionId).toBe(nestedCall?.toolCallId);
    expect(storedCalls.some((call) => call.toolCallId.includes(":call:"))).toBe(false);
    expect(transcriptActions[1]).toMatchObject({
      parentActionId: transcriptActions[0]?.actionId,
    });
    expect(transcriptActions[1]).not.toHaveProperty("executionId");
    const inspected = await runtime.inspectExecution?.(trail.trailId, execution.executionId);
    expect(execution).toMatchObject({
      sourceArtifactId: expect.any(String),
      stdoutArtifactId: expect.any(String),
      stderrArtifactId: expect.any(String),
    });
    expect(inspected).toMatchObject({
      sourceArtifact: {
        preview: executionSource,
        truncated: false,
      },
      stdoutArtifact: {
        preview: "source output\n",
        truncated: false,
      },
      stderrArtifact: {
        preview: "diagnostic output\n",
        truncated: false,
      },
    });
    const beforeRestart = await runtime.getTranscript(trail.trailId);
    expect(beforeRestart.map((entry) => (entry.kind === "message" ? entry.text : entry.name))).toEqual([
      "Inspect the repository package.",
      "execute",
      "files.read",
      "Repository inspected through codemode.",
    ]);
    await runtime.shutdown();

    const reopened = await createApplicationRuntimeComposition({
      config,
      createAgent: (_sessionTools, codeExecution, selfTools) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution, selfTools }),
      createRoleRunner: (configurations) =>
        createScriptedAgentRoleRunner({
          variants: configurations,
          respond: () => ({
            text: '{"observation":{"kind":"other","reason":"Controlled acceptance fixture."},"decision":"no_change","reason":"disabled in acceptance"}',
          }),
        }),
    });
    expect(await reopened.getTranscript(trail.trailId)).toEqual(beforeRestart);
    await reopened.shutdown();
  });

  test("the production permission snapshot admits shell execution from an arbitrary host directory", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-shell-permission-"));
    const outsideCwd = await mkdtemp(join(tmpdir(), "noesis-shell-outside-cwd-"));
    const physicalOutsideCwd = await realpath(outsideCwd);
    roots.push(home, outsideCwd);
    const resolved = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const config = Object.freeze({
      ...resolved,
      learning: Object.freeze({ ...resolved.learning, enabled: false }),
    });
    const controlled = createControlledPiModels({
      respond: ({ context }) => {
        if (context.messages.at(-1)?.role === "toolResult") return "External directory inspected.";
        return controlledToolCallResponse(
          "execute",
          {
            source: [
              `const result = await tools.shell.run({ command: "pwd", cwd: ${JSON.stringify(outsideCwd)} });`,
              "return result;",
            ].join("\n"),
          },
          "call-shell-outside-cwd",
        );
      },
    });
    const runtime = await createApplicationRuntimeComposition({
      config,
      createAgent: (_sessionTools, codeExecution, selfTools) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution, selfTools }),
      createRoleRunner: (configurations) =>
        createScriptedAgentRoleRunner({
          variants: configurations,
          respond: () => ({
            text: '{"observation":{"kind":"other","reason":"Controlled acceptance fixture."},"decision":"no_change","reason":"disabled in acceptance"}',
          }),
        }),
    });
    const trail = await runtime.startTrail({ title: "Shell permission acceptance" });

    const result = await runtime.debug.runTurn(trail.trailId, "Inspect an external host directory.");

    expect(result.output).toBe("External directory inspected.");
    expect(
      (await runtime.debug.workspace.operational.toolCalls.listForSession(trail.trailId)).find(
        (call) => call.toolName === "shell.run",
      ),
    ).toMatchObject({
      toolName: "shell.run",
      status: "completed",
      response: {
        output: {
          exitCode: 0,
          output: `${physicalOutsideCwd}\n`,
          fullOutputLength: physicalOutsideCwd.length + 1,
          truncated: false,
        },
      },
    });
    await runtime.shutdown();
  });

  test("oversized shell output is recoverable from the configured Noesis workspace", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-shell-output-"));
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
    const outputScript = 'process.stdout.write("line\\n".repeat(30_000) + "tail\\n")';
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(outputScript)}`;
    const controlled = createControlledPiModels({
      respond: ({ context }) => {
        if (context.messages.at(-1)?.role === "toolResult") return "Oversized output recovered.";
        return controlledToolCallResponse(
          "execute",
          {
            source: [
              `const shell = await tools.shell.run({ command: ${JSON.stringify(command)} });`,
              'if (!shell.truncated) throw new Error("Expected oversized output");',
              'if (!shell.fullOutputComplete) throw new Error("Expected complete saved output");',
              "const recovered = await tools.files.read({ path: shell.fullOutputPath, startLine: 30001, endLine: 30001 });",
              "return { shell, recovered };",
            ].join("\n"),
          },
          "call-shell-output-recovery",
        );
      },
    });
    const runtime = await createApplicationRuntimeComposition({
      config,
      createAgent: (_sessionTools, codeExecution, selfTools) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution, selfTools }),
      createRoleRunner: (configurations) =>
        createScriptedAgentRoleRunner({
          variants: configurations,
          respond: () => ({
            text: '{"observation":{"kind":"other","reason":"Controlled acceptance fixture."},"decision":"no_change","reason":"disabled in acceptance"}',
          }),
        }),
    });
    const trail = await runtime.startTrail({ title: "Shell output recovery acceptance" });

    await expect(
      runtime.debug.runTurn(trail.trailId, "Recover oversized shell output."),
    ).resolves.toMatchObject({ output: "Oversized output recovered." });
    const calls = await runtime.debug.workspace.operational.toolCalls.listForSession(trail.trailId);
    expect(calls.find((call) => call.toolName === "shell.run")).toMatchObject({
      status: "completed",
      response: {
        output: {
          truncated: true,
          fullOutputComplete: true,
          fullOutputPath: expect.stringContaining(join(home, "artifacts", "tool-output")),
        },
      },
    });
    expect(calls.find((call) => call.toolName === "files.read")).toMatchObject({
      status: "completed",
      response: { output: { content: "tail", truncated: false } },
    });
    await runtime.shutdown();
  });

  test("a controlled Pi journey saves, verifies, inspects, and reuses an exact script revision", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-script-acceptance-"));
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
    const controlled = createControlledPiModels({
      respond: ({ context, lastUserText }) => {
        const lastMessage = context.messages.at(-1);
        if (lastMessage?.role === "toolResult")
          return lastUserText.includes("Save")
            ? "Script saved, verified with 42, and ready to reuse as double-value."
            : lastUserText.includes("List")
              ? "double-value is saved, typed, inspectable, and ready to reuse."
              : lastUserText.includes("direct edit")
                ? "Script returned 63."
                : "Script returned 44.";
        if (lastUserText.includes("Save"))
          return controlledToolCallResponse(
            "execute",
            {
              source: [
                "const saved = await tools.scripts.save({",
                '  name: "double-value",',
                '  description: "Double one numeric input.",',
                '  source: "return { doubled: input.value * 2 };",',
                '  inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },',
                '  outputSchema: { type: "object", properties: { doubled: { type: "number" } }, required: ["doubled"], additionalProperties: false },',
                "  requiredTools: []",
                "});",
                "const verification = await tools.scripts.run({ name: saved.name, input: { value: 21 } });",
                "return { saved, verification };",
              ].join("\n"),
            },
            "call-save-and-verify-script",
          );
        if (lastUserText.includes("List"))
          return controlledToolCallResponse(
            "execute",
            {
              source: [
                "const scripts = await tools.scripts.list({});",
                'const inspected = await tools.scripts.describe({ name: "double-value" });',
                "return { scripts, inspected };",
              ].join("\n"),
            },
            "call-list-and-inspect-script",
          );
        return controlledToolCallResponse(
          "execute",
          {
            source: `return await tools.scripts.run({ name: "double-value", input: { value: ${lastUserText.includes("direct edit") ? "21" : "22"} } });`,
          },
          lastUserText.includes("direct edit") ? "call-run-edited-script" : "call-reuse-script",
        );
      },
    });
    const runtime = await createApplicationRuntimeComposition({
      config,
      createAgent: (_sessionTools, codeExecution, selfTools) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution, selfTools }),
      createRoleRunner: (configurations) =>
        createScriptedAgentRoleRunner({
          variants: configurations,
          respond: () => ({
            text: '{"observation":{"kind":"other","reason":"Controlled acceptance fixture."},"decision":"no_change","reason":"disabled in acceptance"}',
          }),
        }),
    });
    const trail = await runtime.startTrail({ title: "Script acceptance" });

    const saved = await runtime.debug.runTurn(trail.trailId, "Save a reusable doubling script.");
    const scripts = await runtime.listScripts?.();
    const inspected = await runtime.debug.runTurn(trail.trailId, "List and inspect the saved script.");
    const run = await runtime.debug.runTurn(trail.trailId, "Reuse the double-value script for 22.");
    const executionsBeforeEdit = await runtime.debug.workspace.operational.codeExecutions.listForSession(
      trail.trailId,
    );
    const firstScriptExecution = executionsBeforeEdit.find(
      (execution) =>
        execution.parentExecutionId !== undefined &&
        execution.status === "completed" &&
        execution.result !== undefined,
    );
    expect(firstScriptExecution).toBeDefined();
    if (!firstScriptExecution) throw new Error("Expected a completed nested script execution");
    const scriptWorkingPath = scripts?.[0]?.workingPath;
    if (!scriptWorkingPath) throw new Error("Expected the saved script working path");
    await writeFile(join(home, scriptWorkingPath), "return { doubled: input.value * 3 };", "utf8");
    const editedScripts = await runtime.listScripts?.();
    const rerun = await runtime.debug.runTurn(
      trail.trailId,
      "Run the double-value script after the direct edit.",
    );
    const executionsAfterEdit = await runtime.debug.workspace.operational.codeExecutions.listForSession(
      trail.trailId,
    );

    expect(saved.output).toBe("Script saved, verified with 42, and ready to reuse as double-value.");
    expect(scripts).toMatchObject([
      {
        name: "double-value",
        revision: 1,
        requiredTools: [],
      },
    ]);
    expect(inspected.output).toBe("double-value is saved, typed, inspectable, and ready to reuse.");
    expect(run.output).toBe("Script returned 44.");
    expect(editedScripts).toMatchObject([{ name: "double-value", revision: 2 }]);
    expect(rerun.output).toBe("Script returned 63.");
    expect(
      executionsAfterEdit.find((execution) => execution.executionId === firstScriptExecution.executionId),
    ).toEqual(firstScriptExecution);
    expect(
      executionsAfterEdit.some(
        (execution) =>
          execution.parentExecutionId !== undefined &&
          execution.status === "completed" &&
          JSON.stringify(execution.result) === '{"doubled":63}',
      ),
    ).toBe(true);
    const calls = await runtime.debug.workspace.operational.toolCalls.listForSession(trail.trailId);
    expect(calls.filter((call) => call.toolName !== "execute").map((call) => call.toolName)).toEqual([
      "scripts.save",
      "scripts.run",
      "scripts.list",
      "scripts.describe",
      "scripts.run",
      "scripts.run",
    ]);
    expect(calls.find((call) => call.toolName === "scripts.save")?.response).toMatchObject({
      output: {
        name: "double-value",
        revision: 1,
        requiredTools: [],
        reuse: {
          naturalLanguage: "Run the double-value script with the desired input.",
          run: { tool: "scripts.run", name: "double-value" },
          inspect: { tool: "scripts.describe", name: "double-value" },
          list: { tool: "scripts.list" },
          workingPath: scriptWorkingPath,
        },
      },
    });
    await runtime.shutdown();
  });

  test("a controlled Pi turn saves and runs a durable multi-phase workflow", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-workflow-acceptance-"));
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
    const controlled = createControlledPiModels({
      respond: ({ context, lastUserText }) => {
        if (context.messages.at(-1)?.role === "toolResult")
          return lastUserText.includes("Save")
            ? "Workflow saved."
            : lastUserText.includes("Retry")
              ? "Workflow remained paused."
              : lastUserText.includes("Resume")
                ? "Workflow returned 42."
                : "Workflow paused for a correction.";
        if (lastUserText.includes("Save"))
          return controlledToolCallResponse(
            "execute",
            {
              source: [
                "await tools.workflows.save({",
                '  name: "increment-and-double",',
                '  description: "Increment a number and then double it.",',
                '  inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },',
                '  outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },',
                "  phases: [",
                '    { name: "increment", description: "Increment the value.", source: "return { value: input.value + 1 };", inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false }, outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false }, requiredTools: [] },',
                '    { name: "double", description: "Double the corrected value.", source: "return { value: input.value * 2 };", inputSchema: { type: "object", properties: { value: { type: "number" }, allow: { type: "boolean" } }, required: ["value", "allow"], additionalProperties: false }, outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false }, requiredTools: [] }',
                "  ]",
                "});",
                'return await tools.workflows.run({ name: "increment-and-double", input: { value: 20 } });',
              ].join("\n"),
            },
            "call-save-workflow",
          );
        if (lastUserText.includes("Resume"))
          return controlledToolCallResponse(
            "execute",
            {
              source: [
                "const [run] = await tools.workflows.runs({});",
                "return await tools.workflows.resume({ runId: run.runId, correction: { value: 21, allow: true } });",
              ].join("\n"),
            },
            "call-resume-workflow",
          );
        if (lastUserText.includes("Retry"))
          return controlledToolCallResponse(
            "execute",
            {
              source: [
                "const [run] = await tools.workflows.runs({});",
                "return await tools.workflows.resume({ runId: run.runId });",
              ].join("\n"),
            },
            "call-retry-workflow",
          );
        return controlledToolCallResponse(
          "execute",
          {
            source:
              'return await tools.workflows.run({ name: "increment-and-double", input: { value: 20 } });',
          },
          "call-run-workflow",
        );
      },
    });
    const runtime = await createApplicationRuntimeComposition({
      config,
      createAgent: (_sessionTools, codeExecution, selfTools) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution, selfTools }),
      createRoleRunner: (configurations) =>
        createScriptedAgentRoleRunner({
          variants: configurations,
          respond: () => ({
            text: '{"observation":{"kind":"other","reason":"Controlled acceptance fixture."},"decision":"no_change","reason":"disabled in acceptance"}',
          }),
        }),
    });
    const trail = await runtime.startTrail({ title: "Workflow acceptance" });

    const saved = await runtime.debug.runTurn(trail.trailId, "Save and run a two-phase arithmetic workflow.");
    const workflows = await runtime.listWorkflows?.();
    const pausedRuns = await runtime.debug.workspace.operational.workflows.listRunsForSession(trail.trailId);
    const pausedPhases = pausedRuns[0]
      ? await runtime.debug.workspace.operational.workflows.listPhases(pausedRuns[0].runId)
      : [];
    const firstPhaseExecutionId = pausedPhases[0]?.executionId;
    const failedPhaseLogicalExecutionId = pausedPhases[1]?.logicalExecutionId;
    const retried = await runtime.debug.runTurn(
      trail.trailId,
      "Retry the workflow without changing its input.",
    );
    const phasesAfterRetry = pausedRuns[0]
      ? await runtime.debug.workspace.operational.workflows.listPhases(pausedRuns[0].runId)
      : [];
    const resumed = await runtime.debug.runTurn(
      trail.trailId,
      "Resume the workflow with an approved corrected value.",
    );
    const workflowRuns = await runtime.debug.workspace.operational.workflows.listRunsForSession(
      trail.trailId,
    );
    const phases = workflowRuns[0]
      ? await runtime.debug.workspace.operational.workflows.listPhases(workflowRuns[0].runId)
      : [];

    expect(saved.output).toBe("Workflow saved.");
    expect(workflows).toMatchObject([
      {
        name: "increment-and-double",
        revision: 1,
        phaseNames: ["increment", "double"],
      },
    ]);
    expect(pausedRuns).toMatchObject([{ status: "paused", currentPhase: 1 }]);
    expect(pausedRuns[0]).toMatchObject({
      catalogId: expect.stringMatching(/^catalog_[a-f0-9]{64}$/u),
      catalogDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      definitionDependenciesDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      permissionDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      provider: CONTROLLED_PI_PROVIDER,
      model: CONTROLLED_PI_MODEL,
      thinkingLevel: config.agent.thinkingLevel,
    });
    expect(pausedPhases).toMatchObject([
      { phaseName: "increment", status: "completed", attempt: 1, output: { value: 21 } },
      {
        phaseName: "double",
        status: "failed",
        attempt: 1,
        input: { value: 21 },
      },
    ]);
    expect(retried.output).toBe("Workflow remained paused.");
    expect(phasesAfterRetry[1]).toMatchObject({
      phaseName: "double",
      status: "failed",
      attempt: 1,
      logicalExecutionId: failedPhaseLogicalExecutionId,
      input: { value: 21 },
    });
    expect(resumed.output).toBe("Workflow returned 42.");
    expect(workflowRuns).toMatchObject([
      {
        workflowName: "increment-and-double",
        status: "completed",
        output: { value: 42 },
        currentPhase: 2,
      },
    ]);
    expect(phases).toMatchObject([
      { phaseName: "increment", status: "completed", attempt: 1, output: { value: 21 } },
      {
        phaseName: "double",
        status: "completed",
        attempt: 2,
        input: { value: 21, allow: true },
        output: { value: 42 },
      },
    ]);
    expect(phases[0]?.executionId).toBe(firstPhaseExecutionId);
    expect(phases[1]?.logicalExecutionId).toBe(failedPhaseLogicalExecutionId);
    await runtime.shutdown();
  });
});
