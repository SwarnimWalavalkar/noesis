import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNoesisConfig } from "@noesis/config";
import { createPiAgentRuntime } from "@noesis/runtime-pi";
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
  test("Pi sees one execute tool and nested file calls use the recorded broker path", async () => {
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
          respond: () => ({ text: '{"decision":"no_change","reason":"disabled in acceptance"}' }),
        }),
    });
    const trail = await runtime.startTrail({ title: "Codemode acceptance" });

    const result = await runtime.debug.runTurn(trail.trailId, "Inspect the repository package.");

    expect(result.output).toBe("Repository inspected through codemode.");
    expect(observedToolNames).toEqual(["adapt", "execute", "inspect_self", "remember"]);
    expect(
      (await runtime.debug.workspace.operational.toolCalls.listForSession(trail.trailId)).find(
        (call) => call.toolName === "files.read",
      ),
    ).toMatchObject({
      toolName: "files.read",
      status: "completed",
    });
    const executions = await runtime.debug.workspace.operational.codeExecutions.listForSession(trail.trailId);
    const execution = executions[0];
    if (!execution) throw new Error("Expected a recorded codemode execution");
    const transcriptActions = (await runtime.getTranscript(trail.trailId)).filter(
      (entry) => entry.kind === "action",
    );
    expect(transcriptActions.map((action) => action.name)).toEqual(["execute", "files.read"]);
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
    await runtime.shutdown();
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
          respond: () => ({ text: '{"decision":"no_change","reason":"disabled in acceptance"}' }),
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
          stdout: `${physicalOutsideCwd}\n`,
        },
      },
    });
    await runtime.shutdown();
  });

  test("a controlled Pi turn saves and reruns an exact reusable script revision", async () => {
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
            ? "Script saved."
            : lastUserText.includes("direct edit")
              ? "Script returned 63."
              : "Script returned 42.";
        if (lastUserText.includes("Save"))
          return controlledToolCallResponse(
            "execute",
            {
              source: [
                "return await tools.scripts.save({",
                '  name: "double-value",',
                '  description: "Double one numeric input.",',
                '  source: "return { doubled: input.value * 2 };",',
                '  inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },',
                '  outputSchema: { type: "object", properties: { doubled: { type: "number" } }, required: ["doubled"], additionalProperties: false },',
                "  requiredTools: []",
                "});",
              ].join("\n"),
            },
            "call-save-script",
          );
        return controlledToolCallResponse(
          "execute",
          {
            source: 'return await tools.scripts.run({ name: "double-value", input: { value: 21 } });',
          },
          "call-run-script",
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
          respond: () => ({ text: '{"decision":"no_change","reason":"disabled in acceptance"}' }),
        }),
    });
    const trail = await runtime.startTrail({ title: "Script acceptance" });

    const saved = await runtime.debug.runTurn(trail.trailId, "Save a reusable doubling script.");
    const scripts = await runtime.listScripts?.();
    const run = await runtime.debug.runTurn(trail.trailId, "Run the double-value script for 21.");
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
    await writeFile(
      join(home, "definitions", "scripts", "double-value", "index.mjs"),
      "return { doubled: input.value * 3 };",
      "utf8",
    );
    const editedScripts = await runtime.listScripts?.();
    const rerun = await runtime.debug.runTurn(
      trail.trailId,
      "Run the double-value script after the direct edit.",
    );
    const executionsAfterEdit = await runtime.debug.workspace.operational.codeExecutions.listForSession(
      trail.trailId,
    );

    expect(saved.output).toBe("Script saved.");
    expect(scripts).toMatchObject([
      {
        name: "double-value",
        revision: 1,
        requiredTools: [],
      },
    ]);
    expect(run.output).toBe("Script returned 42.");
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
      "scripts.run",
    ]);
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
                "return await tools.workflows.save({",
                '  name: "increment-and-double",',
                '  description: "Increment a number and then double it.",',
                '  inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },',
                '  outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },',
                "  phases: [",
                '    { name: "increment", description: "Increment the value.", source: "return { value: input.value + 1 };", inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false }, outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false }, requiredTools: [] },',
                '    { name: "double", description: "Double the corrected value.", source: "return { value: input.value * 2 };", inputSchema: { type: "object", properties: { value: { type: "number" }, allow: { type: "boolean" } }, required: ["value", "allow"], additionalProperties: false }, outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false }, requiredTools: [] }',
                "  ]",
                "});",
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
          respond: () => ({ text: '{"decision":"no_change","reason":"disabled in acceptance"}' }),
        }),
    });
    const trail = await runtime.startTrail({ title: "Workflow acceptance" });

    const saved = await runtime.debug.runTurn(trail.trailId, "Save a two-phase arithmetic workflow.");
    const workflows = await runtime.listWorkflows?.();
    const paused = await runtime.debug.runTurn(trail.trailId, "Run increment-and-double for 20.");
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
    expect(paused.output).toBe("Workflow paused for a correction.");
    expect(pausedRuns).toMatchObject([{ status: "paused", currentPhase: 1 }]);
    expect(pausedRuns[0]).toMatchObject({
      catalogId: expect.stringMatching(/^catalog_[a-f0-9]{64}$/u),
      catalogDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
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
