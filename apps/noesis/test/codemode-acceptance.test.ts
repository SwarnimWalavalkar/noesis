import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveNoesisConfig } from "@noesis/config";
import {
  createAmbiguousSubAgentOutcomeError,
  createPiAgentRuntime,
  createPiSubAgentRunner,
  type PiSubAgentRunRequest,
} from "@noesis/runtime-pi";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";
import {
  CONTROLLED_PI_MODEL,
  CONTROLLED_PI_PROVIDER,
  controlledToolCallResponse,
  createControlledPiModels,
} from "../../../packages/runtime-pi/test/support/controlled-pi-models.ts";
import { createScriptedAgentRoleRunner } from "../../../packages/runtime-pi/test/support/scripted-role-runner.ts";
import { createApplicationRuntimeComposition, resolveActiveProject } from "../src/runtime-composition.ts";

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
      createAgent: (_sessionTools, codeExecution) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution }),
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
      respond: ({ context, lastUserText, systemPrompt }) => {
        if (systemPrompt.includes("bounded subagent"))
          return context.messages.at(-1)?.role === "toolResult"
            ? lastUserText.includes("malformed")
              ? "The malformed read was rejected by the subagent."
              : "The package metadata was read by the subagent."
            : controlledToolCallResponse(
                "file_read",
                lastUserText.includes("malformed") ? {} : { path: "package.json", startLine: 1, endLine: 4 },
                lastUserText.includes("malformed") ? "call-subagent-invalid-read" : "call-subagent-read",
              );
        return context.messages.at(-1)?.role === "toolResult"
          ? lastUserText.includes("malformed")
            ? "The foreground received the rejected subagent result."
            : "The foreground received the subagent result."
          : controlledToolCallResponse(
              "execute",
              {
                source: lastUserText.includes("malformed")
                  ? 'return await agents.run({ systemPrompt: "Test invalid input.", prompt: "Attempt one malformed file read.", tools: ["files.read"], thinkingLevel: "low" });'
                  : 'return await agents.run({ systemPrompt: "Inspect one file.", prompt: "Read the package metadata.", tools: ["files.read"], thinkingLevel: "low" });',
              },
              lastUserText.includes("malformed") ? "call-run-invalid-subagent" : "call-run-subagent",
            );
      },
    });
    const runtime = await createApplicationRuntimeComposition({
      config,
      subAgent: createPiSubAgentRunner(process.cwd(), controlled.models),
      createAgent: (_sessionTools, codeExecution) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution }),
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
    await expect(
      runtime.debug.runTurn(trail.trailId, "Delegate one malformed file read."),
    ).resolves.toMatchObject({ output: "The foreground received the rejected subagent result." });
    const callsAfterMalformed = await runtime.debug.workspace.operational.toolCalls.listForSession(
      trail.trailId,
    );
    const failedRead = callsAfterMalformed.find(
      (call) => call.toolName === "files.read" && call.status === "failed",
    );
    expect(failedRead).toMatchObject({ parentToolCallId: expect.any(String), request: {} });
    expect(
      callsAfterMalformed.find((call) => call.toolCallId === failedRead?.parentToolCallId),
    ).toMatchObject({ toolName: "agents.run", status: "completed" });
    await runtime.shutdown();

    const otherRoot = await mkdtemp(join(tmpdir(), "noesis-other-subagent-project-"));
    roots.push(otherRoot);
    const otherProject = await resolveActiveProject(otherRoot);
    const otherRuntime = await createApplicationRuntimeComposition({
      config,
      project: otherProject,
      createAgent: (_sessionTools, codeExecution) =>
        createPiAgentRuntime(otherProject.root, controlled.models, { codeExecution }),
      createRoleRunner: (configurations) =>
        createScriptedAgentRoleRunner({
          variants: configurations,
          respond: () => ({
            text: '{"observation":{"kind":"other","reason":"Controlled acceptance fixture."},"decision":"no_change","reason":"disabled in acceptance"}',
          }),
        }),
    });
    if (!subAgentAction) throw new Error("Expected a persisted subagent action");
    await expect(
      otherRuntime.inspectExecution?.(trail.trailId, subAgentAction.actionId),
    ).resolves.toBeUndefined();
    await otherRuntime.shutdown();
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
    const subagentStages = new Map<string, "described" | "ran">();
    const controlled = createControlledPiModels({
      respond: ({ context, lastUserText, systemPrompt }) => {
        if (systemPrompt.includes("bounded subagent")) {
          const name = lastUserText.includes("safe") ? "safe-subagent-program" : "recursive-subagent-program";
          const stage = subagentStages.get(lastUserText);
          if (!stage) {
            subagentStages.set(lastUserText, "described");
            return controlledToolCallResponse(
              "programs_describe",
              { mode: "script", name },
              `call-subagent-describe-${name}`,
            );
          }
          if (stage === "described") {
            const lastMessage = context.messages.at(-1);
            const text =
              lastMessage?.role === "toolResult"
                ? lastMessage.content.find((part) => part.type === "text")?.text
                : undefined;
            if (!text) throw new Error("Expected the described Program result");
            const described = z
              .object({ definitionRevision: z.object({ revisionId: z.string() }) })
              .parse(JSON.parse(text));
            subagentStages.set(lastUserText, "ran");
            return controlledToolCallResponse(
              "programs_run",
              {
                mode: "script",
                name,
                definitionRevisionId: described.definitionRevision.revisionId,
                input: {},
              },
              `call-subagent-run-${name}`,
            );
          }
          return "Saved program attempt settled.";
        }
        if (context.messages.at(-1)?.role === "toolResult") return "Foreground delegation settled.";
        if (lastUserText.includes("Save"))
          return controlledToolCallResponse(
            "execute",
            {
              source: [
                'await tools.programs.save({ mode: "script",',
                '  name: "safe-subagent-program", description: "Return a local value.",',
                '  source: "return { safe: true };",',
                '  inputSchema: { type: "object", properties: {}, additionalProperties: false },',
                '  outputSchema: { type: "object", properties: { safe: { type: "boolean" } }, required: ["safe"], additionalProperties: false },',
                "  requiredTools: []",
                "});",
                'await tools.programs.save({ mode: "script",',
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
            )}, tools: ["programs.describe", "programs.run"] });`,
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
      createAgent: (_sessionTools, codeExecution) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution }),
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
    expect(nestedRequests.map((request) => request.plan.tools)).toEqual([
      ["programs.describe", "programs.run"],
      ["programs.describe", "programs.run"],
    ]);
    expect(await runtime.debug.workspace.operational.modelCalls.listForSession(trail.trailId)).toMatchObject([
      { status: "completed" },
      { status: "completed" },
    ]);
    const calls = await runtime.debug.workspace.operational.toolCalls.listForSession(trail.trailId);
    const programCalls = calls.filter((call) => call.toolName === "programs.run");
    expect(programCalls).toMatchObject([{ status: "completed" }, { status: "failed" }]);
    const programExecutions = await runtime.debug.workspace.operational.codeExecutions.listForSession(
      trail.trailId,
    );
    expect(
      programExecutions.find((execution) => execution.program?.name === "safe-subagent-program"),
    ).toMatchObject({ parentExecutionId: nestedRequests[0]?.plan.authority.parentExecutionId });
    expect(
      programExecutions.find((execution) => execution.program?.name === "recursive-subagent-program"),
    ).toMatchObject({ parentExecutionId: nestedRequests[1]?.plan.authority.parentExecutionId });
    const descendantDelegation = calls.find(
      (call) => call.toolName === "agents.run" && call.status === "failed",
    );
    expect(descendantDelegation).toMatchObject({
      parentToolCallId: programCalls[1]?.toolCallId,
      response: { error: "Subagents cannot recursively invoke agents.run" },
    });
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
      createAgent: (_sessionTools, codeExecution) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution }),
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

  test("persists a malformed direct-tool attempt rejected before Broker invocation", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-invalid-direct-tool-"));
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
          ? "The malformed read was rejected."
          : controlledToolCallResponse("file_read", {}, "call-invalid-file-read"),
    });
    const runtime = await createApplicationRuntimeComposition({
      config,
      createAgent: (_sessionTools, codeExecution) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution }),
      createRoleRunner: (configurations) =>
        createScriptedAgentRoleRunner({
          variants: configurations,
          respond: () => ({
            text: '{"observation":{"kind":"other","reason":"Controlled acceptance fixture."},"decision":"no_change","reason":"disabled in acceptance"}',
          }),
        }),
    });
    const trail = await runtime.startTrail({ title: "Invalid direct tool acceptance" });

    await expect(runtime.debug.runTurn(trail.trailId, "Try an incomplete file read.")).resolves.toMatchObject(
      { output: "The malformed read was rejected." },
    );
    const [attempt] = await runtime.debug.workspace.operational.toolCalls.listForSession(trail.trailId);
    expect(attempt).toMatchObject({ toolName: "files.read", status: "failed", request: {} });
    expect(JSON.stringify(attempt?.response)).toContain("path");
    expect(
      (await runtime.getTranscript(trail.trailId)).filter((entry) => entry.kind === "action"),
    ).toMatchObject([{ name: "files.read", status: "failed", input: {} }]);
    await runtime.shutdown();
  });

  test("Pi sees the fixed direct surface and nested execute calls use the recorded broker path", async () => {
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
      createAgent: (_sessionTools, codeExecution) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution }),
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
    expect(observedToolNames).toEqual(["execute", "file_read", "file_write", "shell"]);
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
      createAgent: (_sessionTools, codeExecution) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution }),
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
      createAgent: (_sessionTools, codeExecution) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution }),
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
      createAgent: (_sessionTools, codeExecution) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution }),
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
    let originalRevisionId: string | undefined;
    const controlled = createControlledPiModels({
      respond: ({ context, lastUserText }) => {
        const lastMessage = context.messages.at(-1);
        if (lastMessage?.role === "toolResult")
          return lastUserText.includes("Save")
            ? "Script saved, verified with 42, and ready to reuse as double-value."
            : lastUserText.includes("List")
              ? "double-value is saved, typed, inspectable, and ready to reuse."
              : lastUserText.includes("original")
                ? "Original script revision returned 42."
                : lastUserText.includes("invalid output")
                  ? "Invalid script output was rejected."
                  : lastUserText.includes("direct edit")
                    ? "Script returned 63."
                    : "Script returned 44.";
        if (lastUserText.includes("Save"))
          return controlledToolCallResponse(
            "execute",
            {
              source: [
                'const saved = await tools.programs.save({ mode: "script",',
                '  name: "double-value",',
                '  description: "Double one numeric input.",',
                '  source: "return { doubled: input.value * 2 };",',
                '  inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },',
                '  outputSchema: { type: "object", properties: { doubled: { type: "number" } }, required: ["doubled"], additionalProperties: false },',
                "  requiredTools: []",
                "});",
                'const verification = await tools.programs.run({ mode: "script", name: saved.manifest.name, definitionRevisionId: saved.definitionRevision.revisionId, input: { value: 21 } });',
                "const runs = await tools.programs.runs({});",
                "return { saved, verification, runs };",
              ].join("\n"),
            },
            "call-save-and-verify-script",
          );
        if (lastUserText.includes("List"))
          return controlledToolCallResponse(
            "execute",
            {
              source: [
                "const scripts = await tools.programs.list({});",
                'const inspected = await tools.programs.describe({ mode: "script", name: "double-value" });',
                "return { scripts, inspected };",
              ].join("\n"),
            },
            "call-list-and-inspect-script",
          );
        if (lastUserText.includes("original"))
          return controlledToolCallResponse(
            "execute",
            {
              source: [
                `const definitionRevisionId = ${JSON.stringify(originalRevisionId)};`,
                'const described = await tools.programs.describe({ mode: "script", name: "double-value", definitionRevisionId });',
                'if (!described) throw new Error("Missing original Program revision");',
                'return await tools.programs.run({ mode: "script", name: "double-value", definitionRevisionId, input: { value: 21 } });',
              ].join("\n"),
            },
            "call-run-original-script-revision",
          );
        if (lastUserText.includes("invalid output"))
          return controlledToolCallResponse(
            "execute",
            {
              source: [
                'const described = await tools.programs.describe({ mode: "script", name: "double-value" });',
                'if (!described) throw new Error("Missing Program");',
                'return await tools.programs.run({ mode: "script", name: "double-value", definitionRevisionId: described.definitionRevision.revisionId, input: { value: 22 } });',
              ].join("\n"),
            },
            "call-run-invalid-script-output",
          );
        return controlledToolCallResponse(
          "execute",
          {
            source: [
              'const described = await tools.programs.describe({ mode: "script", name: "double-value" });',
              'if (!described) throw new Error("Missing Program");',
              `return await tools.programs.run({ mode: "script", name: "double-value", definitionRevisionId: described.definitionRevision.revisionId, input: { value: ${lastUserText.includes("direct edit") ? "21" : "22"} } });`,
            ].join("\n"),
          },
          lastUserText.includes("direct edit") ? "call-run-edited-script" : "call-reuse-script",
        );
      },
    });
    const runtime = await createApplicationRuntimeComposition({
      config,
      createAgent: (_sessionTools, codeExecution) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution }),
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
    const scripts = await runtime.listPrograms?.();
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
    const scriptWorkingPath = scripts?.[0]?.sourceWorkingPath;
    if (!scriptWorkingPath) throw new Error("Expected the saved script working path");
    await writeFile(join(home, scriptWorkingPath), "return { doubled: input.value * 3 };", "utf8");
    const editedScripts = await runtime.listPrograms?.();
    const rerun = await runtime.debug.runTurn(
      trail.trailId,
      "Run the double-value script after the direct edit.",
    );
    const project = await resolveActiveProject(process.cwd());
    originalRevisionId = (
      await runtime.debug.workspace.definitionMetadata.listRevisions(
        `program:${project.projectId}:script`,
        "double-value",
      )
    )[0]?.definitionRevision.revisionId;
    if (!originalRevisionId) throw new Error("Expected the original Program revision");
    const original = await runtime.debug.runTurn(
      trail.trailId,
      "Run the original immutable double-value revision.",
    );
    await writeFile(join(home, scriptWorkingPath), 'return "invalid";', "utf8");
    await runtime.listPrograms?.();
    const invalid = await runtime.debug.runTurn(
      trail.trailId,
      "Run the double-value script with invalid output.",
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
    expect(original.output).toBe("Original script revision returned 42.");
    expect(invalid.output).toBe("Invalid script output was rejected.");
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
    expect(
      executionsAfterEdit.some(
        (execution) =>
          execution.program?.name === "double-value" &&
          execution.program.revision === 3 &&
          execution.status === "failed" &&
          execution.result === undefined,
      ),
    ).toBe(true);
    const calls = await runtime.debug.workspace.operational.toolCalls.listForSession(trail.trailId);
    expect(calls.filter((call) => call.toolName !== "execute").map((call) => call.toolName)).toEqual([
      "programs.save",
      "programs.run",
      "programs.runs",
      "programs.list",
      "programs.describe",
      "programs.describe",
      "programs.run",
      "programs.describe",
      "programs.run",
      "programs.describe",
      "programs.run",
      "programs.describe",
      "programs.run",
    ]);
    expect(calls.find((call) => call.toolName === "programs.save")?.response).toMatchObject({
      output: {
        manifest: {
          mode: "script",
          name: "double-value",
          revision: 1,
          requiredTools: [],
        },
        definitionRevision: { revisionId: expect.any(String) },
        workingPath: scriptWorkingPath,
      },
    });
    expect(calls.find((call) => call.toolName === "programs.runs")?.response).toMatchObject({
      output: [
        {
          mode: "script",
          name: "double-value",
          programRevision: 1,
          definitionRevisionId: expect.any(String),
          status: "completed",
        },
      ],
    });
    const database = new DatabaseSync(join(home, "database", "noesis.sqlite"));
    expect(() =>
      database
        .prepare("UPDATE codemode_executions SET program_name = ? WHERE execution_id = ?")
        .run("rewritten-program", firstScriptExecution.executionId),
    ).toThrow(/program execution identity is immutable/u);
    database.close();
    expect((await runtime.listExecutions?.(trail.trailId))?.map((entry) => entry.executionId)).toContain(
      firstScriptExecution.executionId,
    );
    await runtime.shutdown();

    const otherRoot = await mkdtemp(join(tmpdir(), "noesis-other-project-"));
    roots.push(otherRoot);
    const otherProject = await resolveActiveProject(otherRoot);
    const otherRuntime = await createApplicationRuntimeComposition({
      config,
      project: otherProject,
      createAgent: (_sessionTools, codeExecution) =>
        createPiAgentRuntime(otherProject.root, controlled.models, { codeExecution }),
      createRoleRunner: (configurations) =>
        createScriptedAgentRoleRunner({
          variants: configurations,
          respond: () => ({
            text: '{"observation":{"kind":"other","reason":"Controlled acceptance fixture."},"decision":"no_change","reason":"disabled in acceptance"}',
          }),
        }),
    });
    expect(
      (await otherRuntime.listExecutions?.(trail.trailId))?.map((entry) => entry.executionId),
    ).not.toContain(firstScriptExecution.executionId);
    await expect(
      otherRuntime.inspectExecution?.(trail.trailId, firstScriptExecution.executionId),
    ).resolves.toBeUndefined();
    await otherRuntime.shutdown();
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
            : lastUserText.includes("unchanged")
              ? "Equal correction retried without changing identity."
              : lastUserText.includes("Retry")
                ? "Workflow remained paused."
                : lastUserText.includes("Resume")
                  ? "Workflow returned 41."
                  : "Workflow paused for a correction.";
        if (lastUserText.includes("Save"))
          return controlledToolCallResponse(
            "execute",
            {
              source: [
                'await tools.programs.save({ mode: "workflow",',
                '  name: "increment-and-double",',
                '  description: "Increment, double, and then decrement a number.",',
                '  inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },',
                '  outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },',
                "  phases: [",
                '    { name: "increment", description: "Increment the value.", source: "return { value: input.value + 1 };", inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false }, outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false }, requiredTools: [] },',
                '    { name: "double", description: "Double the corrected value.", source: "await tools.programs.list({}); if (!input.allow) throw new Error(); return { value: input.value * 2 };", inputSchema: { type: "object", properties: { value: { type: "number" }, allow: { type: "boolean" } }, required: ["value"], additionalProperties: false }, outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false }, requiredTools: ["programs.list"] },',
                '    { name: "decrement", description: "Decrement the doubled value.", source: "return { value: input.value - 1 };", inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false }, outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false }, requiredTools: [] }',
                "  ]",
                "});",
                'const saved = await tools.programs.describe({ mode: "workflow", name: "increment-and-double" });',
                'if (!saved) throw new Error("Missing Program");',
                'return await tools.programs.run({ mode: "workflow", name: "increment-and-double", definitionRevisionId: saved.definitionRevision.revisionId, input: { value: 20 } });',
              ].join("\n"),
            },
            "call-save-workflow",
          );
        if (lastUserText.includes("Resume"))
          return controlledToolCallResponse(
            "execute",
            {
              source: [
                "const [run] = await tools.programs.runs({});",
                "return await tools.programs.resume({ runId: run.runId, correction: { value: 21, allow: true } });",
              ].join("\n"),
            },
            "call-resume-workflow",
          );
        if (lastUserText.includes("unchanged"))
          return controlledToolCallResponse(
            "execute",
            {
              source: [
                "const [run] = await tools.programs.runs({});",
                "return await tools.programs.resume({ runId: run.runId, correction: { value: 21 } });",
              ].join("\n"),
            },
            "call-resume-workflow-unchanged",
          );
        if (lastUserText.includes("Retry"))
          return controlledToolCallResponse(
            "execute",
            {
              source: [
                "const [run] = await tools.programs.runs({});",
                "return await tools.programs.resume({ runId: run.runId });",
              ].join("\n"),
            },
            "call-retry-workflow",
          );
        return controlledToolCallResponse(
          "execute",
          {
            source: [
              'const saved = await tools.programs.describe({ mode: "workflow", name: "increment-and-double" });',
              'if (!saved) throw new Error("Missing Program");',
              'return await tools.programs.run({ mode: "workflow", name: "increment-and-double", definitionRevisionId: saved.definitionRevision.revisionId, input: { value: 20 } });',
            ].join("\n"),
          },
          "call-run-workflow",
        );
      },
    });
    const runtime = await createApplicationRuntimeComposition({
      config,
      createAgent: (_sessionTools, codeExecution) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution }),
      createRoleRunner: (configurations) =>
        createScriptedAgentRoleRunner({
          variants: configurations,
          respond: () => ({
            text: '{"observation":{"kind":"other","reason":"Controlled acceptance fixture."},"decision":"no_change","reason":"disabled in acceptance"}',
          }),
        }),
    });
    const trail = await runtime.startTrail({ title: "Workflow acceptance" });

    const saved = await runtime.debug.runTurn(
      trail.trailId,
      "Save and run a three-phase arithmetic workflow.",
    );
    const workflows = await runtime.listPrograms?.();
    const pausedRuns = await runtime.debug.workspace.operational.workflows.listRunsForSession(trail.trailId);
    const pausedPhases = pausedRuns[0]
      ? await runtime.debug.workspace.operational.workflows.listPhases(pausedRuns[0].runId)
      : [];
    const firstPhaseExecutionId = pausedPhases[0]?.executionId;
    const failedPhaseLogicalExecutionId = pausedPhases[1]?.logicalExecutionId;
    const failedPhaseExecutionId = pausedPhases[1]?.executionId;
    const retried = await runtime.debug.runTurn(
      trail.trailId,
      "Retry the workflow without changing its input.",
    );
    const phasesAfterRetry = pausedRuns[0]
      ? await runtime.debug.workspace.operational.workflows.listPhases(pausedRuns[0].runId)
      : [];
    const equalCorrection = await runtime.debug.runTurn(trail.trailId, "Retry with an unchanged correction.");
    const phasesAfterEqualCorrection = pausedRuns[0]
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
        phaseNames: ["increment", "double", "decrement"],
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
    expect(pausedPhases.slice(0, 2)).toMatchObject([
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
      attempt: 2,
      logicalExecutionId: failedPhaseLogicalExecutionId,
      input: { value: 21 },
    });
    expect(equalCorrection.output).toBe("Equal correction retried without changing identity.");
    expect(phasesAfterEqualCorrection[1]).toMatchObject({
      phaseName: "double",
      status: "failed",
      attempt: 3,
      logicalExecutionId: failedPhaseLogicalExecutionId,
      input: { value: 21 },
    });
    expect(resumed.output).toBe("Workflow returned 41.");
    expect(workflowRuns).toMatchObject([
      {
        workflowName: "increment-and-double",
        status: "completed",
        output: { value: 41 },
        currentPhase: 3,
      },
    ]);
    expect(phases).toMatchObject([
      { phaseName: "increment", status: "completed", attempt: 1, output: { value: 21 } },
      {
        phaseName: "double",
        status: "completed",
        attempt: 4,
        input: { value: 21, allow: true },
        output: { value: 42 },
      },
      {
        phaseName: "decrement",
        status: "completed",
        attempt: 1,
        input: { value: 42 },
        output: { value: 41 },
      },
    ]);
    expect(phases[0]?.executionId).toBe(firstPhaseExecutionId);
    expect(phasesAfterRetry[1]?.executionId).not.toBe(failedPhaseExecutionId);
    expect(phases[1]?.logicalExecutionId).not.toBe(failedPhaseLogicalExecutionId);
    if (!firstPhaseExecutionId) throw new Error("Expected a workflow phase CodeExecution");
    const phaseExecution =
      await runtime.debug.workspace.operational.codeExecutions.get(firstPhaseExecutionId);
    if (!phaseExecution?.projectId || !phaseExecution.sourceArtifactId)
      throw new Error("Expected a project-owned workflow phase CodeExecution with source evidence");
    const prelinkExecutionId = "execution-workflow-prelink-crash";
    await runtime.debug.workspace.operational.codeExecutions.put({
      executionId: prelinkExecutionId,
      logicalExecutionId: "logical-workflow-prelink-crash",
      sessionId: trail.trailId,
      projectId: phaseExecution.projectId,
      catalogId: phaseExecution.catalogId,
      catalogDigest: phaseExecution.catalogDigest,
      sourceDigest: phaseExecution.sourceDigest,
      sourceArtifactId: phaseExecution.sourceArtifactId,
      status: "running",
      callCount: 0,
      startedAt: new Date().toISOString(),
    });
    expect((await runtime.listExecutions?.(trail.trailId))?.map((entry) => entry.executionId)).toContain(
      firstPhaseExecutionId,
    );
    await runtime.shutdown();

    const otherRoot = await mkdtemp(join(tmpdir(), "noesis-other-workflow-project-"));
    roots.push(otherRoot);
    const otherProject = await resolveActiveProject(otherRoot);
    const otherRuntime = await createApplicationRuntimeComposition({
      config,
      project: otherProject,
      createAgent: (_sessionTools, codeExecution) =>
        createPiAgentRuntime(otherProject.root, controlled.models, { codeExecution }),
      createRoleRunner: (configurations) =>
        createScriptedAgentRoleRunner({
          variants: configurations,
          respond: () => ({
            text: '{"observation":{"kind":"other","reason":"Controlled acceptance fixture."},"decision":"no_change","reason":"disabled in acceptance"}',
          }),
        }),
    });
    expect(
      (await otherRuntime.listExecutions?.(trail.trailId))?.map((entry) => entry.executionId),
    ).not.toEqual(expect.arrayContaining([firstPhaseExecutionId, prelinkExecutionId]));
    await expect(
      otherRuntime.inspectExecution?.(trail.trailId, firstPhaseExecutionId),
    ).resolves.toBeUndefined();
    await expect(otherRuntime.inspectExecution?.(trail.trailId, prelinkExecutionId)).resolves.toBeUndefined();
    await otherRuntime.shutdown();
  });

  test("workflow resume preserves JSON null across restart", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-workflow-null-resume-"));
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
            ? "Null workflow paused."
            : "Null workflow retried after restart.";
        if (lastUserText.includes("Save"))
          return controlledToolCallResponse(
            "execute",
            {
              source: [
                'await tools.programs.save({ mode: "workflow",',
                '  name: "preserve-null",',
                '  description: "Preserve a JSON null value across workflow retries.",',
                '  inputSchema: { type: "object", additionalProperties: false },',
                '  outputSchema: { type: "null" },',
                "  phases: [",
                '    { name: "produce-null", description: "Produce null.", source: "return null;", inputSchema: { type: "object", additionalProperties: false }, outputSchema: { type: "null" }, requiredTools: [] },',
                '    { name: "pause", description: "Pause while preserving null.", source: "if (input !== null) throw new Error(\\"lost null\\"); throw new Error(\\"pause\\");", inputSchema: { type: "null" }, outputSchema: { type: "null" }, requiredTools: [] }',
                "  ]",
                "});",
                'const saved = await tools.programs.describe({ mode: "workflow", name: "preserve-null" });',
                'if (!saved) throw new Error("Missing Program");',
                'return await tools.programs.run({ mode: "workflow", name: "preserve-null", definitionRevisionId: saved.definitionRevision.revisionId, input: {} });',
              ].join("\n"),
            },
            "call-save-null-workflow",
          );
        return controlledToolCallResponse(
          "execute",
          {
            source: [
              "const runs = await tools.programs.runs({});",
              'const run = runs.find((candidate) => candidate.mode === "workflow" && candidate.name === "preserve-null");',
              'if (!run || run.mode !== "workflow") throw new Error("Missing workflow run");',
              "return await tools.programs.resume({ runId: run.runId });",
            ].join("\n"),
          },
          "call-resume-null-workflow",
        );
      },
    });
    const createRuntime = async () =>
      await createApplicationRuntimeComposition({
        config,
        createAgent: (_sessionTools, codeExecution) =>
          createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution }),
        createRoleRunner: (configurations) =>
          createScriptedAgentRoleRunner({
            variants: configurations,
            respond: () => ({
              text: '{"observation":{"kind":"other","reason":"Controlled acceptance fixture."},"decision":"no_change","reason":"disabled in acceptance"}',
            }),
          }),
      });
    const initial = await createRuntime();
    const trail = await initial.startTrail({ title: "Null workflow acceptance" });
    await initial.debug.runTurn(trail.trailId, "Save and run the null workflow.");
    const [run] = await initial.debug.workspace.operational.workflows.listRunsForSession(trail.trailId);
    if (!run) throw new Error("Expected a paused null workflow run");
    expect(await initial.debug.workspace.operational.workflows.listPhases(run.runId)).toMatchObject([
      { phaseName: "produce-null", status: "completed", output: null },
      { phaseName: "pause", status: "failed", attempt: 1, input: null },
    ]);
    await initial.shutdown();

    const restarted = await createRuntime();
    await restarted.debug.runTurn(trail.trailId, "Resume the null workflow after restart.");
    expect(await restarted.debug.workspace.operational.workflows.listPhases(run.runId)).toMatchObject([
      { phaseName: "produce-null", status: "completed", output: null },
      { phaseName: "pause", status: "failed", attempt: 2, input: null },
    ]);
    await restarted.shutdown();
  });

  test("foreground codemode authors one exact Capability while subagents remain advisory", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-foreground-refinement-acceptance-"));
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
        if (context.systemPrompt?.includes("bounded subagent"))
          return lastMessage?.role === "toolResult"
            ? "The protected runtime kept this subagent advisory."
            : controlledToolCallResponse(
                "capabilities_refine",
                { decision: "no_change", reason: "Advisory probe only." },
                "call-subagent-refine",
              );
        if (lastMessage?.role === "toolResult")
          return lastUserText.includes("twice")
            ? "Only one refinement decision was accepted for the turn."
            : lastUserText.includes("Delegate")
              ? "The subagent could inspect but could not publish."
              : "The review Capability is active for later relevant turns.";
        if (lastUserText.includes("twice"))
          return controlledToolCallResponse(
            "execute",
            {
              source: [
                'const attempt = () => tools.capabilities.refine({ decision: "no_change", reason: "One complete decision." });',
                'return await Promise.all([attempt(), attempt()].map(async (result) => await result.then(() => "accepted", (error) => `rejected: ${error.message}`)));',
              ].join("\n"),
            },
            "call-duplicate-refinement",
          );
        if (lastUserText.includes("Delegate"))
          return controlledToolCallResponse(
            "execute",
            {
              source:
                'return await agents.run({ prompt: "Try to publish a no-change Capability decision.", tools: ["capabilities.refine"] });',
            },
            "call-delegate-refinement",
          );
        return controlledToolCallResponse(
          "execute",
          {
            source: [
              'const advisory = await agents.run({ prompt: "Try to publish a no-change Capability decision.", tools: ["capabilities.refine"] });',
              'const descriptor = await noesis.describe("capabilities.inspect");',
              'if (!JSON.stringify(descriptor.outputSchema).includes("\\\"revisionNumber\\\"")) throw new Error("Capability binding schema is not discoverable");',
              'const before = await tools.capabilities.inspect({ view: "list" });',
              "const publication = await tools.capabilities.refine({",
              '  decision: "create",',
              "  proposal: {",
              '    name: "Evidence-led review",',
              '    description: "Trace exact evidence and consumers before reporting review findings.",',
              '    applicability: "Repository reviews and implementation audits.",',
              '    summary: "Add a durable evidence-led review method.",',
              '    rationale: "The user explicitly asked Noesis to preserve this review method.",',
              '    anticipatedEffect: "Future reviews distinguish verified defects from speculation.",',
              '    effects: [{ kind: "instruction", content: "Ground review findings in exact evidence and trace affected consumers." }],',
              '    consequence: "ordinary",',
              '    consequenceDescription: "This changes only reversible agent guidance."',
              "  }",
              "});",
              'const detail = await tools.capabilities.inspect({ view: "detail", capabilityId: publication.capabilityId });',
              'const revisions = await tools.capabilities.inspect({ view: "revisions", capabilityId: publication.capabilityId, limit: 1 });',
              'const material = await tools.capabilities.inspect({ view: "material", capabilityId: publication.capabilityId, capabilityRevisionId: revisions.revisions[0].reference.capabilityRevisionId, effectIndex: 0, maxCharacters: 16 });',
              "return { advisory, before, publication, detail, revisions, material };",
            ].join("\n"),
          },
          "call-foreground-refinement",
        );
      },
    });
    const roleRequests: string[] = [];
    const runtime = await createApplicationRuntimeComposition({
      config,
      subAgent: createPiSubAgentRunner(process.cwd(), controlled.models),
      createAgent: (_sessionTools, codeExecution) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution }),
      createRoleRunner: (configurations) =>
        createScriptedAgentRoleRunner({
          variants: configurations,
          respond: (request) => {
            roleRequests.push(request.runId);
            return request.runId.startsWith("capability-route-")
              ? {
                  text: '{"selections":[],"reason":"Controlled routing omission.","learningAttribution":null}',
                }
              : {
                  text: '{"decision":"no_change","reason":"The foreground agent already published the deliberate refinement."}',
                };
          },
        }),
    });
    const trail = await runtime.startTrail({ title: "Foreground refinement acceptance" });

    const published = await runtime.debug.runTurn(
      trail.trailId,
      "Deliberately preserve our evidence-led review method as a Capability.",
    );
    expect(published.output).toBe("The review Capability is active for later relevant turns.");
    const publishedTurnId = published.frozenTurnPlan?.turnId;
    if (!publishedTurnId) throw new Error("Expected a frozen foreground turn plan");
    const publicationCalls = await runtime.debug.workspace.operational.toolCalls.listForTurn(
      trail.trailId,
      publishedTurnId,
    );
    expect(publicationCalls.map((call) => call.toolName)).toEqual([
      "execute",
      "agents.run",
      "capabilities.refine",
      "capabilities.inspect",
      "capabilities.refine",
      "capabilities.inspect",
      "capabilities.inspect",
      "capabilities.inspect",
    ]);
    const advisoryCall = publicationCalls.find((call) => call.toolName === "agents.run");
    if (!advisoryCall) throw new Error("Expected the advisory subagent call");
    const inspectionCall = publicationCalls.find((call) => call.toolName === "capabilities.inspect");
    if (!inspectionCall) throw new Error("Expected the foreground Capability inspection");
    expect(
      publicationCalls.filter((call) => call.toolName === "capabilities.inspect").at(-1)?.response,
    ).toMatchObject({
      output: {
        view: "material",
        material: { start: 0, end: 16, truncated: true, nextStart: 16 },
      },
    });
    const [definition] = await runtime.debug.workspace.capabilities.listDefinitions();
    expect(definition).toMatchObject({ name: "Evidence-led review" });
    if (!definition) throw new Error("Expected the foreground-authored Capability");
    const binding = await runtime.debug.workspace.capabilities.getBinding(definition.capabilityId);
    expect(binding).toMatchObject({
      scope: { kind: "global" },
      activationMode: "relevant",
      state: "active",
      revisionNumber: 1,
    });
    if (!binding) throw new Error("Expected the foreground-authored Capability binding");
    const lifecycle = await runtime.debug.workspace.capabilities.getRevision(binding.revision);
    expect(lifecycle).toMatchObject({
      revision: {
        effects: [{ kind: "instruction" }],
        evidenceRefs: [
          { table: "messages", rowId: `${publishedTurnId}:user` },
          { table: "tool_calls", rowId: advisoryCall.toolCallId },
          { table: "tool_calls", rowId: inspectionCall.toolCallId },
        ],
      },
    });
    expect(roleRequests.filter((runId) => runId.startsWith("reflect-capability"))).toHaveLength(1);

    const advisory = await runtime.debug.runTurn(
      trail.trailId,
      "Delegate an advisory refinement attempt to a subagent.",
    );
    expect(advisory.output).toBe("The subagent could inspect but could not publish.");
    const advisoryTurnId = advisory.frozenTurnPlan?.turnId;
    if (!advisoryTurnId) throw new Error("Expected a frozen advisory turn plan");
    const calls = await runtime.debug.workspace.operational.toolCalls.listForTurn(
      trail.trailId,
      advisoryTurnId,
    );
    expect(calls.map((call) => call.toolName)).toContain("capabilities.refine");
    expect(calls.find((call) => call.toolName === "capabilities.refine")).toMatchObject({
      status: "failed",
      response: {
        error: "Subagents may inspect and advise, but cannot publish Capability changes",
      },
    });
    expect(await runtime.debug.workspace.capabilities.listRevisions(definition.capabilityId)).toHaveLength(1);

    const duplicate = await runtime.debug.runTurn(
      trail.trailId,
      "Try to publish a Capability decision twice in this turn.",
    );
    expect(duplicate.output).toBe("Only one refinement decision was accepted for the turn.");
    const duplicateTurnId = duplicate.frozenTurnPlan?.turnId;
    if (!duplicateTurnId) throw new Error("Expected a frozen duplicate-refinement turn plan");
    const duplicateCalls = (
      await runtime.debug.workspace.operational.toolCalls.listForTurn(trail.trailId, duplicateTurnId)
    ).filter((call) => call.toolName === "capabilities.refine");
    expect(duplicateCalls.map((call) => call.status).sort()).toEqual(["completed", "failed"]);
    expect(duplicateCalls.find((call) => call.status === "failed")?.response).toMatchObject({
      error: "Only one foreground Capability decision may be published per turn",
    });
    await runtime.shutdown();
  });
});
