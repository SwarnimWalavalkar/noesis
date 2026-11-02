import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNoesisConfig } from "@noesis/config";
import { JsonValueSchema, learnedCapabilitySkillName, type JsonValue } from "@noesis/domain";
import { createPiAgentRuntime, createPiSkillLibrary, type PiSkillLibrary } from "@noesis/runtime-pi";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import {
  CONTROLLED_PI_MODEL,
  CONTROLLED_PI_PROVIDER,
  controlledToolCallResponse,
  createControlledPiModels,
} from "../../../packages/runtime-pi/test/support/controlled-pi-models.ts";
import { createScriptedAgentRoleRunner } from "../../../packages/runtime-pi/test/support/scripted-role-runner.ts";
import { NOESIS_BUILT_IN_SKILLS } from "../src/noesis-skill.ts";
import {
  type ApplicationRuntime,
  createApplicationRuntimeComposition,
  resolveActiveProject,
} from "../src/runtime-composition.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});
const objectSchema = { type: "object" };
const FOLDER_SCRIPT = JSON.stringify(
  {
    mode: "script",
    name: "check-rollback",
    description: "Check that a migration can roll back.",
    inputSchema: objectSchema,
    outputSchema: objectSchema,
    requiredTools: [],
  },
  null,
  2,
);

const skillLibraryFor = (home: string, workspaceTrusted: boolean) => (root: string) =>
  createPiSkillLibrary({
    cwd: root,
    agentDirectory: join(home, "agent"),
    builtInSkills: NOESIS_BUILT_IN_SKILLS,
    workspaceTrusted,
  });

async function fixture() {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "noesis-capability-folders-acceptance-")));
  roots.push(scratch);
  const home = join(scratch, "home");
  const config = await resolveNoesisConfig({
    home,
    env: Object.freeze({}),
    cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
  });
  let nextSource = "";
  let lastValue: string | undefined;
  let callNumber = 0;
  const toolLists: string[][] = [];
  const controlled = createControlledPiModels({
    respond: ({ context }) => {
      toolLists.push((context.tools ?? []).map((tool) => tool.name).sort());
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
      readonly root: string;
      readonly projectId: string;
      readonly sessionId: string;
      readonly turn: (source: string) => Promise<JsonValue>;
    }) => Promise<Value>,
    skills?: (root: string) => PiSkillLibrary,
  ): Promise<Value> => {
    const root = join(scratch, projectName);
    await mkdir(root, { recursive: true });
    const project = await resolveActiveProject(root);
    const skillLibrary = skills?.(root);
    const runtime = await createApplicationRuntimeComposition({
      config,
      project,
      skills: skillLibrary ?? skillLibraryFor(home, false)(root),
      createAgent: (codeExecution, library) => {
        if (!library) throw new Error("Expected the skill library");
        return createPiAgentRuntime(root, controlled.models, {
          codeExecution,
          skills: library,
          requirePinnedSkillSnapshot: true,
        });
      },
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
        root,
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
  return { home, scratch, within, toolLists };
}
function runResult(value: JsonValue) {
  return z
    .looseObject({
      value: z.looseObject({
        scope: z.string(),
        definitionRevisionId: z.string(),
        value: z.looseObject({}),
      }),
    })
    .parse(value).value;
}
const attempt = (code: string) =>
  `try { return { ok: true, value: await ${code} }; } catch (error) { return { ok: false, error: String(error) }; }`;
const createDecision = (name: string) => ({
  decision: "create",
  proposal: {
    name,
    description: "Check a migration before it ships.",
    applicability: "Reviewing a database migration.",
    summary: "Review migrations.",
    rationale: "The user asked.",
    anticipatedEffect: "Migrations get checked.",
    effects: [{ kind: "instruction", content: "Check the rollback path first." }],
    scope: "global",
    consequence: "ordinary",
    consequenceDescription: "Only guidance changes.",
  },
});

test("a Capability folder's Program is found only after the folder loads, and its revision travels", async () => {
  const { home, within, toolLists } = await fixture();
  const { capabilityId, folder, skillName } = await within("project-a", async ({ turn, runtime }) => {
    const created = z
      .looseObject({ value: z.looseObject({ capabilityId: z.string() }) })
      .parse(
        await turn(
          `return await tools.capabilities.refine(${JSON.stringify(createDecision("Review migrations"))});`,
        ),
      );
    const detail = z
      .looseObject({
        value: z.looseObject({
          capability: z.looseObject({
            folder: z.looseObject({ path: z.string(), files: z.array(z.string()) }),
          }),
        }),
      })
      .parse(
        await turn(
          `return await tools.capabilities.inspect({ view: "detail", capabilityId: ${JSON.stringify(created.value.capabilityId)} });`,
        ),
      );
    expect(detail.value.capability.folder.files).toEqual(["SKILL.md"]);
    const path = detail.value.capability.folder.path;
    expect(path.startsWith(join(home, "definitions/capabilities/"))).toBe(true);
    expect(await readFile(join(path, "SKILL.md"), "utf8")).toContain("metadata:");
    // A direct edit: a Program and a reference appear in the folder.
    await mkdir(join(path, "programs/check-rollback"), { recursive: true });
    await writeFile(join(path, "programs/check-rollback/program.json"), FOLDER_SCRIPT);
    await writeFile(join(path, "programs/check-rollback/index.mjs"), 'return { checked: "v1" };');
    await mkdir(join(path, "references"));
    await writeFile(join(path, "references/checklist.md"), "- Rollback exists\n");
    const skill = learnedCapabilitySkillName(created.value.capabilityId, "Review migrations");

    // Nothing is reachable until the folder loads, even after the next turn records the edit.
    const before = await turn(
      attempt('tools.programs.run({ mode: "script", name: "check-rollback", input: {} })'),
    );
    expect(before).toMatchObject({
      value: { ok: false, error: expect.stringContaining("Unknown script-mode Program") },
    });
    expect(z.array(z.looseObject({})).parse(await runtime.listPrograms?.())).toEqual([]);

    const loaded = await turn(
      [
        `const skill = await tools.skills.load({ name: ${JSON.stringify(skill)} });`,
        'const run = await tools.programs.run({ mode: "script", name: "check-rollback", input: {} });',
        'const file = await tools.capabilities.inspect({ view: "file", capabilityId: ' +
          JSON.stringify(created.value.capabilityId) +
          ', capabilityRevisionId: (await tools.capabilities.inspect({ view: "detail", capabilityId: ' +
          JSON.stringify(created.value.capabilityId) +
          ' })).capability.currentRevision.reference.capabilityRevisionId, path: "references/checklist.md" });',
        "const listed = await tools.programs.list({});",
        "return { content: skill.content, programs: skill.programs, run, file: file.file.content, listed };",
      ].join("\n"),
    );
    expect(loaded).toMatchObject({
      value: {
        content: expect.stringContaining("references/checklist.md"),
        programs: [{ mode: "script", name: "check-rollback" }],
        run: { scope: "folder", value: { checked: "v1" } },
        file: "- Rollback exists\n",
        listed: [{ name: "check-rollback", scope: "folder", skill }],
      },
    });
    return { capabilityId: created.value.capabilityId, folder: path, skillName: skill };
  });

  // Every model request in this journey saw exactly the fixed provider tools.
  for (const tools of toolLists) expect(tools).toEqual(["execute", "file_read", "file_write", "shell"]);

  const firstRevision = await within("project-b", async ({ turn, runtime, projectId, sessionId }) => {
    const ran = runResult(
      await turn(
        `await tools.skills.load({ name: ${JSON.stringify(skillName)} }); return await tools.programs.run({ mode: "script", name: "check-rollback", input: {} });`,
      ),
    );
    expect(ran).toMatchObject({ scope: "folder", value: { checked: "v1" } });
    const executions = await runtime.debug.workspace.operational.codeExecutions.listForSession(sessionId);
    const run = executions.find((execution) => execution.program);
    expect(run?.projectId).toBe(projectId);
    expect(run?.program).toEqual({
      mode: "script",
      folderId: capabilityId,
      name: "check-rollback",
      revision: 1,
      definitionRevisionId: ran.definitionRevisionId,
    });
    return ran.definitionRevisionId;
  });

  // Editing the source makes a new revision. The earlier revision keeps its exact bytes.
  await writeFile(join(folder, "programs/check-rollback/index.mjs"), 'return { checked: "v2" };');
  const secondRevision = await within("project-b", async ({ turn, runtime, sessionId }) => {
    const ran = runResult(
      await turn(
        `await tools.skills.load({ name: ${JSON.stringify(skillName)} }); return await tools.programs.run({ mode: "script", name: "check-rollback", input: {} });`,
      ),
    );
    expect(ran.value).toEqual({ checked: "v2" });
    expect(ran.definitionRevisionId).not.toBe(firstRevision);
    const prior = await runtime.debug.workspace.operational.codeExecutions.listForSession(sessionId);
    expect(prior.find((execution) => execution.program)?.program?.revision).toBe(2);
    return ran.definitionRevisionId;
  });
  expect(secondRevision).not.toBe(firstRevision);

  // Restoring the revision before the folder gained files rewrites the folder and removes the Program.
  await within("project-a", async ({ turn, runtime }) => {
    const revisions = z
      .looseObject({
        value: z.looseObject({
          revisions: z.array(
            z.looseObject({ reference: z.looseObject({ capabilityRevisionId: z.string() }) }),
          ),
        }),
      })
      .parse(
        await turn(
          `return await tools.capabilities.inspect({ view: "revisions", capabilityId: ${JSON.stringify(capabilityId)}, limit: 25 });`,
        ),
      );
    const binding = await runtime.debug.workspace.capabilities.getBinding(capabilityId);
    if (!binding) throw new Error("Expected a binding");
    const lifecycle = await Promise.all(
      revisions.value.revisions.map(
        async (revision) =>
          await runtime.debug.workspace.capabilities.getRevisionById(
            capabilityId,
            revision.reference.capabilityRevisionId,
          ),
      ),
    );
    const firstCreated = lifecycle.find((revision) => !revision?.revision.predecessorRevisionId);
    if (!firstCreated) throw new Error("Expected the first revision");
    await turn(
      `return await tools.capabilities.refine({ decision: "restore", capabilityId: ${JSON.stringify(capabilityId)}, expectedBindingRevision: ${String(binding.revisionNumber)}, capabilityRevisionId: ${JSON.stringify(firstCreated.reference.capabilityRevisionId)}, reason: "Back to the start." });`,
    );
    expect((await readdir(folder)).sort()).toEqual(["SKILL.md"]);
    expect(
      await turn(
        `await tools.skills.load({ name: ${JSON.stringify(skillName)} }); ${attempt(
          'tools.programs.run({ mode: "script", name: "check-rollback", input: {} })',
        )}`,
      ),
    ).toMatchObject({ value: { ok: false } });
    // The exact recorded revision is still inspectable after the restore.
    expect(await runtime.debug.workspace.definitionMetadata.getByRevisionId(firstRevision)).toMatchObject({
      definitionId: "check-rollback",
      revision: 1,
    });
  });
});

test("a folder workflow runs, pauses, and resumes from its pin in a later turn without reloading", async () => {
  const { within } = await fixture();
  await within("project-a", async ({ turn, runtime, sessionId }) => {
    const created = z
      .looseObject({ value: z.looseObject({ capabilityId: z.string() }) })
      .parse(
        await turn(`return await tools.capabilities.refine(${JSON.stringify(createDecision("Flow"))});`),
      );
    const detail = z
      .looseObject({
        value: z.looseObject({ capability: z.looseObject({ folder: z.looseObject({ path: z.string() }) }) }),
      })
      .parse(
        await turn(
          `return await tools.capabilities.inspect({ view: "detail", capabilityId: ${JSON.stringify(created.value.capabilityId)} });`,
        ),
      );
    const path = detail.value.capability.folder.path;
    await mkdir(join(path, "programs/two-steps"), { recursive: true });
    await writeFile(
      join(path, "programs/two-steps/program.json"),
      JSON.stringify({
        mode: "workflow",
        name: "two-steps",
        description: "Fails until corrected.",
        inputSchema: objectSchema,
        outputSchema: objectSchema,
        phases: [
          {
            name: "only",
            description: "Fail on request.",
            source: 'if (input.fail) throw new Error("asked to fail"); return { done: true };',
            inputSchema: objectSchema,
            outputSchema: objectSchema,
            requiredTools: [],
          },
        ],
      }),
    );
    const skill = learnedCapabilitySkillName(created.value.capabilityId, "Flow");
    // The first turn after the edit records it. The workflow pauses on its failing phase.
    await turn(
      `await tools.skills.load({ name: ${JSON.stringify(skill)} }); ${attempt(
        'tools.programs.run({ mode: "workflow", name: "two-steps", input: { fail: true } })',
      )}`,
    );
    const [run] = await runtime.debug.workspace.operational.workflows.listRunsForSession(sessionId);
    if (!run) throw new Error("Expected a workflow run");
    expect(run).toMatchObject({ workflowName: "two-steps", status: "paused" });
    expect(await turn("return await tools.programs.runs({});")).toMatchObject({
      value: [expect.objectContaining({ mode: "workflow", scope: "folder", name: "two-steps" })],
    });
    expect(
      await turn(
        `return await tools.programs.resume({ runId: ${JSON.stringify(run.runId)}, correction: { fail: false } });`,
      ),
    ).toMatchObject({ value: { status: "completed", value: { done: true } } });
  });
});

test("exporting a Capability writes a self-contained folder, with its pinned Program copied in", async () => {
  const { scratch, within } = await fixture();
  await within("project-a", async ({ turn, root }) => {
    await turn(
      `return await tools.programs.save({ mode: "script", name: "shared-check", scope: "global", description: "Check.", source: "return { ok: true };", inputSchema: ${JSON.stringify(objectSchema)}, outputSchema: ${JSON.stringify(objectSchema)}, requiredTools: [] });`,
    );
    const decision = createDecision("Shared check");
    const created = z.looseObject({ value: z.looseObject({ capabilityId: z.string() }) }).parse(
      await turn(
        `return await tools.capabilities.refine(${JSON.stringify({
          ...decision,
          proposal: {
            ...decision.proposal,
            effects: [
              ...decision.proposal.effects,
              { kind: "program", mode: "script", name: "shared-check" },
            ],
          },
        })});`,
      ),
    );
    const exported = await turn(
      `return await tools.capabilities.export({ capabilityId: ${JSON.stringify(created.value.capabilityId)}, destination: "exported/shared-check" });`,
    );
    const destination = join(root, "exported/shared-check");
    expect(exported).toMatchObject({
      value: {
        destination,
        files: ["SKILL.md", "programs/shared-check/program.json", "programs/shared-check/index.mjs"],
      },
    });
    expect(await readFile(join(destination, "programs/shared-check/index.mjs"), "utf8")).toBe(
      "return { ok: true };",
    );
    expect(
      JSON.parse(await readFile(join(destination, "programs/shared-check/program.json"), "utf8")),
    ).toEqual({
      mode: "script",
      name: "shared-check",
      description: "Check.",
      inputSchema: objectSchema,
      outputSchema: objectSchema,
      requiredTools: [],
    });
    // It never overwrites, and the authority boundary keeps it inside what this turn may write.
    expect(
      await turn(
        attempt(
          `tools.capabilities.export({ capabilityId: ${JSON.stringify(created.value.capabilityId)}, destination: "exported/shared-check" })`,
        ),
      ),
    ).toMatchObject({ value: { ok: false, error: expect.stringContaining("not empty") } });
    expect(
      await turn(
        attempt(
          `tools.capabilities.export({ capabilityId: ${JSON.stringify(created.value.capabilityId)}, destination: ${JSON.stringify(join(scratch, "outside"))} })`,
        ),
      ),
    ).toMatchObject({ value: { ok: false } });
    await expect(readdir(join(scratch, "outside"))).rejects.toThrow();
  });
});

test("a standard skill's folder Programs load with the skill, and workspace skills still need trust", async () => {
  const { home, scratch, within } = await fixture();
  const write = async (root: string) => {
    const folder = join(root, ".pi/skills/wk-skill");
    await mkdir(join(folder, "programs/skill-tool"), { recursive: true });
    await writeFile(
      join(folder, "SKILL.md"),
      "---\nname: wk-skill\ndescription: A workspace skill with a Program.\n---\n\nUse the Program.\n",
    );
    await writeFile(
      join(folder, "programs/skill-tool/program.json"),
      JSON.stringify({
        mode: "script",
        name: "skill-tool",
        description: "Say hello.",
        inputSchema: objectSchema,
        outputSchema: objectSchema,
        requiredTools: [],
      }),
    );
    await writeFile(join(folder, "programs/skill-tool/index.mjs"), 'return { from: "skill" };');
  };
  await write(join(scratch, "project-a"));
  await within(
    "project-a",
    async ({ turn }) => {
      expect(await turn('return await tools.skills.load({ name: "wk-skill" });')).toMatchObject({
        value: null,
      });
      expect(
        await turn(
          attempt('tools.programs.run({ mode: "script", name: "skill-tool", skill: "wk-skill", input: {} })'),
        ),
      ).toMatchObject({ value: { ok: false, error: expect.stringContaining("Unknown skill") } });
    },
    skillLibraryFor(home, false),
  );
  await within(
    "project-a",
    async ({ turn, runtime, sessionId }) => {
      expect(
        await turn(attempt('tools.programs.run({ mode: "script", name: "skill-tool", input: {} })')),
      ).toMatchObject({ value: { ok: false } });
      expect(await turn('return await tools.skills.load({ name: "wk-skill" });')).toMatchObject({
        value: { name: "wk-skill", programs: [{ mode: "script", name: "skill-tool" }] },
      });
      const ran = runResult(
        await turn(
          'await tools.skills.load({ name: "wk-skill" }); return await tools.programs.run({ mode: "script", name: "skill-tool", input: {} });',
        ),
      );
      expect(ran).toMatchObject({ scope: "folder", value: { from: "skill" } });
      const executions = await runtime.debug.workspace.operational.codeExecutions.listForSession(sessionId);
      expect(executions.find((execution) => execution.program)?.program?.definitionRevisionId).toBe(
        ran.definitionRevisionId,
      );
    },
    skillLibraryFor(home, true),
  );
});
