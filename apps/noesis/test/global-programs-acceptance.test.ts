import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { resolveNoesisConfig } from "@noesis/config";
import { JsonValueSchema, type JsonValue, sha256 } from "@noesis/domain";
import { createPiAgentRuntime, createPiSubAgentTaskRunner } from "@noesis/runtime-pi";
import {
  CONTROLLED_PI_MODEL,
  CONTROLLED_PI_PROVIDER,
  controlledToolCallResponse,
  createControlledPiModels,
} from "../../../packages/runtime-pi/test/support/controlled-pi-models.ts";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { createScriptedAgentRoleRunner } from "../../../packages/runtime-pi/test/support/scripted-role-runner.ts";
import {
  type ApplicationRuntime,
  createApplicationRuntimeComposition,
  resolveActiveProject,
} from "../src/runtime-composition.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

const objectSchema = {
  type: "object",
  properties: { value: { type: "number" } },
  required: ["value"],
  additionalProperties: false,
};
const resultSchema = {
  type: "object",
  properties: { from: { type: "string" } },
  required: ["from"],
  additionalProperties: false,
};
function saveScript(name: string, from: string, extra = ""): string {
  return `await tools.programs.save({ mode: "script", name: ${JSON.stringify(name)}, description: "Say where it came from.", source: ${JSON.stringify(`return { from: ${JSON.stringify(from)} };`)}, inputSchema: ${JSON.stringify(objectSchema)}, outputSchema: ${JSON.stringify(resultSchema)}, requiredTools: []${extra} })`;
}

/** One Noesis home with one directory per project. Every turn runs the source the test hands it. */
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "noesis-global-programs-"));
  roots.push(home);
  const projects = join(home, "..", `${home.split("/").at(-1) ?? "home"}-projects`);
  roots.push(projects);
  const config = await resolveNoesisConfig({
    home,
    env: Object.freeze({}),
    cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
  });
  let nextSource = "";
  let lastValue: unknown;
  let callNumber = 0;
  const controlled = createControlledPiModels({
    respond: ({ context }) => {
      const last = context.messages.at(-1);
      if (last?.role === "toolResult") {
        const content = last.content[0];
        lastValue = content?.type === "text" ? content.text : undefined;
        return "Done.";
      }
      callNumber += 1;
      return controlledToolCallResponse("execute", { source: nextSource }, `call-${String(callNumber)}`);
    },
  });
  const within = async <Value>(
    projectName: string,
    work: (context: {
      readonly runtime: ApplicationRuntime;
      readonly turn: (source: string) => Promise<JsonValue>;
      readonly projectId: string;
      readonly sessionId: string;
    }) => Promise<Value>,
  ): Promise<Value> => {
    const root = join(projects, projectName);
    await mkdir(root, { recursive: true });
    const project = await resolveActiveProject(root);
    const runtime = await createApplicationRuntimeComposition({
      config,
      project,
      createAgent: (codeExecution) => createPiAgentRuntime(root, controlled.models, { codeExecution }),
      createRoleRunner: (configurations) =>
        createScriptedAgentRoleRunner({
          variants: configurations,
          respond: () => ({ text: '{"decision":"no_change","reason":"disabled in acceptance"}' }),
        }),
    });
    const trail = await runtime.startTrail({ title: projectName });
    try {
      return await work({
        runtime,
        projectId: project.projectId,
        sessionId: trail.trailId,
        turn: async (source) => {
          nextSource = source;
          lastValue = undefined;
          await runtime.debug.runTurn(trail.trailId, "Run the supplied code.");
          return JsonValueSchema.parse(JSON.parse(z.string().parse(lastValue)));
        },
      });
    } finally {
      await runtime.shutdown();
    }
  };
  return { home, within };
}
const RunResult = z.looseObject({
  value: z.looseObject({
    scope: z.string(),
    definitionRevisionId: z.string(),
    value: z.unknown().optional(),
  }),
});

test("a global Program saved in one project runs by name in another, and the project's own wins", async () => {
  const { home, within } = await fixture();
  const saved = await within("project-a", async ({ turn }) =>
    z
      .looseObject({
        value: z.looseObject({
          scope: z.string(),
          definitionRevision: z.looseObject({ revisionId: z.string(), workingPath: z.string() }),
        }),
      })
      .parse(await turn(`return ${saveScript("say-origin", "global", ', scope: "global"')};`)),
  );
  expect(saved.value.scope).toBe("global");
  expect(saved.value.definitionRevision.workingPath).toBe(
    "definitions/programs/global/script/say-origin/program.json",
  );
  const globalRevisionId = saved.value.definitionRevision.revisionId;

  await within("project-b", async ({ turn, runtime, projectId, sessionId }) => {
    const byName = RunResult.parse(
      await turn(
        'return await tools.programs.run({ mode: "script", name: "say-origin", input: { value: 1 } });',
      ),
    );
    expect(byName.value).toMatchObject({
      scope: "global",
      definitionRevisionId: globalRevisionId,
      value: { from: "global" },
    });
    const recorded = await runtime.debug.workspace.operational.codeExecutions.listForSession(sessionId);
    const run = recorded.find((execution) => execution.program?.name === "say-origin");
    expect(run?.projectId).toBe(projectId);
    expect(run?.program).toEqual({
      mode: "script",
      name: "say-origin",
      revision: 1,
      definitionRevisionId: globalRevisionId,
    });
    expect(await runtime.listPrograms?.()).toMatchObject([
      {
        name: "say-origin",
        scope: "global",
        workingPath: "definitions/programs/global/script/say-origin/program.json",
      },
    ]);

    await turn(`return ${saveScript("say-origin", "project-b")};`);
    const shadowed = RunResult.parse(
      await turn(
        'return await tools.programs.run({ mode: "script", name: "say-origin", input: { value: 1 } });',
      ),
    );
    expect(shadowed.value).toMatchObject({ scope: "project", value: { from: "project-b" } });
    expect(shadowed.value.definitionRevisionId).not.toBe(globalRevisionId);
    const exact = RunResult.parse(
      await turn(
        `return await tools.programs.run({ mode: "script", name: "say-origin", definitionRevisionId: ${JSON.stringify(globalRevisionId)}, input: { value: 1 } });`,
      ),
    );
    expect(exact.value).toMatchObject({ scope: "global", value: { from: "global" } });
    const scoped = RunResult.parse(
      await turn(
        'return await tools.programs.run({ mode: "script", name: "say-origin", scope: "global", input: { value: 1 } });',
      ),
    );
    expect(scoped.value).toMatchObject({ scope: "global", definitionRevisionId: globalRevisionId });
    // Each run is authorized against the owner of the code that actually ran.
    const database = new DatabaseSync(join(home, "database", "noesis.sqlite"), { readOnly: true });
    try {
      const resources = z
        .array(z.strictObject({ resource: z.string() }))
        .parse(
          database
            .prepare(
              "SELECT resource FROM authority_operations WHERE resource LIKE '%:script:say-origin:run' ORDER BY rowid",
            )
            .all(),
        )
        .map(({ resource }) => resource);
      expect(resources.slice(-3)).toEqual([
        `program:${projectId}:script:say-origin:run`,
        "program:global:script:say-origin:run",
        "program:global:script:say-origin:run",
      ]);
    } finally {
      database.close();
    }
    expect(await turn("return await tools.programs.list({});")).toMatchObject({
      value: [
        { name: "say-origin", scope: "project", shadowed: false },
        { name: "say-origin", scope: "global", shadowed: true },
      ],
    });
    expect(await runtime.listPrograms?.()).toMatchObject([
      { name: "say-origin", scope: "project" },
      { name: "say-origin", scope: "global", shadowed: true },
    ]);
    expect(await runtime.inspectProgram?.("script", "say-origin")).toMatchObject({ scope: "project" });
    const runs = z
      .looseObject({ value: z.array(z.looseObject({ scope: z.string(), definitionRevisionId: z.string() })) })
      .parse(await turn("return await tools.programs.runs({});"));
    expect(runs.value.map((item) => item.scope)).toEqual(["global", "project", "global", "global"]);
  });

  await within("project-c", async ({ runtime }) => {
    expect(await runtime.inspectProgram?.("script", "say-origin")).toMatchObject({ scope: "global" });
  });
});

test("a global workflow runs by name from another project and pins its exact revision", async () => {
  const { within } = await fixture();
  const phase = {
    name: "only",
    description: "Return the origin.",
    source: 'return { from: "global-workflow" };',
    inputSchema: objectSchema,
    outputSchema: resultSchema,
    requiredTools: [],
  };
  const saved = z
    .looseObject({ value: z.looseObject({ definitionRevision: z.looseObject({ revisionId: z.string() }) }) })
    .parse(
      await within("project-a", async ({ turn }) =>
        turn(
          `return await tools.programs.save({ mode: "workflow", scope: "global", name: "shared-flow", description: "One phase.", inputSchema: ${JSON.stringify(objectSchema)}, outputSchema: ${JSON.stringify(resultSchema)}, phases: [${JSON.stringify(phase)}] });`,
        ),
      ),
    );
  await within("project-b", async ({ turn, runtime, projectId, sessionId }) => {
    const ran = RunResult.parse(
      await turn(
        'return await tools.programs.run({ mode: "workflow", name: "shared-flow", input: { value: 1 } });',
      ),
    );
    expect(ran.value).toMatchObject({
      scope: "global",
      definitionRevisionId: saved.value.definitionRevision.revisionId,
      value: { from: "global-workflow" },
    });
    const [run] = await runtime.debug.workspace.operational.workflows.listRunsForSession(sessionId);
    expect(run).toMatchObject({
      projectId,
      workflowName: "shared-flow",
      definitionRevisionId: saved.value.definitionRevision.revisionId,
      status: "completed",
    });
    expect(await turn("return await tools.programs.runs({});")).toMatchObject({
      value: [{ mode: "workflow", scope: "global", name: "shared-flow" }],
    });
  });
});

test("promotion creates a global revision that cites its source and leaves the project Program alone", async () => {
  const { home, within } = await fixture();
  const projectRevision = await within("project-a", async ({ turn, runtime, projectId }) => {
    await turn(`return ${saveScript("promote-me", "project-a")};`);
    const namespace = `program:${projectId}:script`;
    const before = await runtime.debug.workspace.definitionMetadata.listRevisions(namespace, "promote-me");
    const promoted = await turn(
      'return await tools.programs.promote({ mode: "script", name: "promote-me", reason: "Two projects need it." });',
    );
    const source = before[0]?.definitionRevision;
    if (!source) throw new Error("Expected the project revision");
    expect(promoted).toMatchObject({
      value: {
        scope: "global",
        programRevision: 1,
        unchanged: false,
        promotedFrom: {
          projectId,
          revision: 1,
          definitionRevisionId: source.revisionId,
          definitionDigest: source.contentDigest,
        },
      },
    });
    expect(await runtime.debug.workspace.definitionMetadata.listRevisions(namespace, "promote-me")).toEqual(
      before,
    );
    const [global] = await runtime.debug.workspace.definitionMetadata.listRevisions(
      "program:global:script",
      "promote-me",
    );
    if (!global) throw new Error("Expected the global revision");
    expect(
      new TextDecoder().decode(await runtime.debug.workspace.reads.readRevision(global.definitionRevision)),
    ).toContain(source.revisionId);
    expect(await runtime.listPrograms?.()).toMatchObject([
      { name: "promote-me", scope: "project" },
      { name: "promote-me", scope: "global", shadowed: true, promotedFrom: `${projectId} r1` },
    ]);
    // Promoting the same behavior again changes nothing.
    expect(
      await turn(
        'return await tools.programs.promote({ mode: "script", name: "promote-me", reason: "Again." });',
      ),
    ).toMatchObject({ value: { programRevision: 1, unchanged: true } });
    return source.revisionId;
  });
  expect(projectRevision).toEqual(expect.any(String));
  expect(
    await readFile(join(home, "definitions/programs/global/script/promote-me/index.mjs"), "utf8"),
  ).toContain("project-a");

  await within("project-b", async ({ turn }) => {
    expect(
      RunResult.parse(
        await turn(
          'return await tools.programs.run({ mode: "script", name: "promote-me", input: { value: 1 } });',
        ),
      ).value,
    ).toMatchObject({ scope: "global", value: { from: "project-a" } });
    // Another project's different Program cannot silently replace the global one.
    await turn(`return ${saveScript("promote-me", "project-b")};`);
    const refused = await turn(
      'try { await tools.programs.promote({ mode: "script", name: "promote-me", reason: "Mine is better." }); return "promoted"; } catch (error) { return String(error); }',
    );
    expect(refused).toMatchObject({ value: expect.stringContaining("expectedGlobalRevisionId") });
  });
});

test("a global Program with a missing required tool fails closed, and a bad edit does not stop the turn", async () => {
  const { home, within } = await fixture();
  await within("project-a", async ({ turn }) => {
    await turn(`return ${saveScript("needs-tool", "global", ', scope: "global"')};`);
  });
  const manifestPath = join(home, "definitions/programs/global/script/needs-tool/program.json");
  const manifest = z.looseObject({}).parse(JSON.parse(await readFile(manifestPath, "utf8")));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, requiredTools: ["missing.tool"] }), "utf8");
  await within("project-b", async ({ turn, runtime }) => {
    const refused = await turn(
      'try { await tools.programs.run({ mode: "script", name: "needs-tool", input: { value: 1 } }); return "ran"; } catch (error) { return String(error); }',
    );
    expect(refused).toMatchObject({
      value: expect.stringContaining("requires unavailable tool missing.tool"),
    });
    await writeFile(manifestPath, "not json", "utf8");
    expect(await turn('return "still working";')).toMatchObject({ value: "still working" });
    expect(await runtime.listPrograms?.()).toMatchObject([
      { name: "needs-tool", scope: "global", revision: 2, editProblem: expect.any(String) },
    ]);
  });
});

test("a Capability bound to a global Program stays global and works in another project", async () => {
  const { within } = await fixture();
  const capabilityId = await within("project-a", async ({ turn, runtime }) => {
    await turn(`return ${saveScript("shared-tool", "global", ', scope: "global"')};`);
    await turn(`return ${saveScript("local-tool", "project-a")};`);
    const proposal = (name: string, program: string, scope: string) => ({
      name,
      description: "Use the saved Program.",
      applicability: "When the saved Program applies.",
      summary: "Attach the saved Program.",
      rationale: "It is useful here.",
      anticipatedEffect: "The Program is available.",
      effects: [{ kind: "program", mode: "script", name: program }],
      scope,
      activationMode: "always",
      consequence: "ordinary",
      consequenceDescription: "Reversible.",
    });
    const refused = await turn(
      `try { return await tools.capabilities.refine({ decision: "create", proposal: ${JSON.stringify(proposal("Local everywhere", "local-tool", "global"))} }); } catch (error) { return String(error); }`,
    );
    expect(refused).toMatchObject({ value: expect.stringContaining("requires current-project scope") });
    const published = z
      .looseObject({ value: z.looseObject({ status: z.string(), capabilityId: z.string() }) })
      .parse(
        await turn(
          `return await tools.capabilities.refine({ decision: "create", proposal: ${JSON.stringify(proposal("Shared everywhere", "shared-tool", "global"))} });`,
        ),
      );
    expect(published.value.status).toBe("activated");
    const binding = await runtime.debug.workspace.capabilities.getBinding(published.value.capabilityId);
    expect(binding?.scope).toEqual({ kind: "global" });
    return published.value.capabilityId;
  });
  await within("project-b", async ({ turn, runtime, sessionId }) => {
    const toolName = `capability_${sha256(`${capabilityId}:script:shared-tool`).slice(0, 12)}_script_shared-tool`;
    expect(
      await turn(`return await noesis.invoke(${JSON.stringify(toolName)}, { value: 1 });`),
    ).toMatchObject({ value: { from: "global" } });
    const recorded = await runtime.debug.workspace.operational.codeExecutions.listForSession(sessionId);
    expect(recorded.find((execution) => execution.program)?.program).toMatchObject({ name: "shared-tool" });
    expect(recorded.find((execution) => execution.program)?.program?.projectId).toBeUndefined();
  });
});

test("a promoted Program attaches to a global Capability from its source project", async () => {
  const { within } = await fixture();
  const capabilityId = await within("project-a", async ({ turn, runtime }) => {
    await turn(`return ${saveScript("promoted-tool", "project-a")};`);
    await turn(
      'return await tools.programs.promote({ mode: "script", name: "promoted-tool", reason: "Two projects need it." });',
    );
    const proposal = (scope?: string) => ({
      name: "Promoted everywhere",
      description: "Use the promoted Program.",
      applicability: "When the promoted Program applies.",
      summary: "Attach the promoted Program.",
      rationale: "It is useful in every project.",
      anticipatedEffect: "The Program is available.",
      effects: [
        scope
          ? { kind: "program", mode: "script", name: "promoted-tool", scope }
          : { kind: "program", mode: "script", name: "promoted-tool" },
      ],
      scope: "global",
      activationMode: "always",
      consequence: "ordinary",
      consequenceDescription: "Reversible.",
    });
    // Without a scope the project copy wins, which cannot back a global Capability.
    expect(
      await turn(
        `try { return await tools.capabilities.refine({ decision: "create", proposal: ${JSON.stringify(proposal())} }); } catch (error) { return String(error); }`,
      ),
    ).toMatchObject({ value: expect.stringContaining("requires current-project scope") });
    const published = z
      .looseObject({ value: z.looseObject({ status: z.string(), capabilityId: z.string() }) })
      .parse(
        await turn(
          `return await tools.capabilities.refine({ decision: "create", proposal: ${JSON.stringify(proposal("global"))} });`,
        ),
      );
    expect(published.value.status).toBe("activated");
    expect(
      (await runtime.debug.workspace.capabilities.getBinding(published.value.capabilityId))?.scope,
    ).toEqual({
      kind: "global",
    });
    return published.value.capabilityId;
  });
  await within("project-b", async ({ turn }) => {
    const toolName = `capability_${sha256(`${capabilityId}:script:promoted-tool`).slice(0, 12)}_script_promoted-tool`;
    expect(
      await turn(`return await noesis.invoke(${JSON.stringify(toolName)}, { value: 1 });`),
    ).toMatchObject({ value: { from: "project-a" } });
  });
});

test("a subagent may read and run Programs but cannot publish them globally", async () => {
  const home = await mkdtemp(join(tmpdir(), "noesis-global-programs-subagent-"));
  roots.push(home);
  const config = await resolveNoesisConfig({
    home,
    env: Object.freeze({}),
    cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
  });
  const childSource = [
    "const attempts = {};",
    "for (const [key, call] of [",
    `  ["save", async () => ${saveScript("from-child", "child", ', scope: "global"')}],`,
    '  ["promote", () => tools.programs.promote({ mode: "script", name: "from-parent", reason: "Child says so." })],',
    ']) { try { await call(); attempts[key] = "allowed"; } catch (error) { attempts[key] = String(error); } }',
    "return attempts;",
  ].join("\n");
  const controlled = createControlledPiModels({
    respond: ({ context, lastUserText, systemPrompt }) => {
      const last = context.messages.at(-1);
      if (systemPrompt.includes("subagent inside Noesis"))
        return last?.role === "toolResult"
          ? "Child finished."
          : controlledToolCallResponse("execute", { source: childSource }, "call-child");
      if (last?.role === "toolResult") return "Done.";
      return lastUserText.includes("Save")
        ? controlledToolCallResponse(
            "execute",
            { source: `return ${saveScript("from-parent", "parent")};` },
            "call-parent-save",
          )
        : controlledToolCallResponse(
            "execute",
            {
              source:
                'const child = await agents.spawn({ prompt: "Try to publish.", tools: ["programs.save", "programs.promote"] }); return await agents.wait({ taskId: child.taskId });',
            },
            "call-parent-spawn",
          );
    },
  });
  const runtime = await createApplicationRuntimeComposition({
    config,
    subAgentTaskRunner: createPiSubAgentTaskRunner(process.cwd(), controlled.models),
    createAgent: (codeExecution) => createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution }),
    createRoleRunner: (configurations) =>
      createScriptedAgentRoleRunner({
        variants: configurations,
        respond: () => ({ text: '{"decision":"no_change","reason":"disabled in acceptance"}' }),
      }),
  });
  try {
    const trail = await runtime.startTrail({ title: "Subagent global publication" });
    await runtime.debug.runTurn(trail.trailId, "Save the parent's Program.");
    await runtime.debug.runTurn(trail.trailId, "Spawn a child to try publishing.");
    const [agent] = await runtime.listSubAgents();
    if (!agent) throw new Error("Expected the spawned subagent");
    const transcript = JSON.stringify(await runtime.getSubAgentTranscript(agent.agentId));
    expect(transcript).toContain("cannot save a global Program");
    expect(transcript).toContain("cannot promote a Program");
    expect(await runtime.debug.workspace.definitionMetadata.listCurrent("program:global:script")).toEqual([]);
  } finally {
    await runtime.shutdown();
  }
});
