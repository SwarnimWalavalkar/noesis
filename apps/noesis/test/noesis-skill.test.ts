import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiSkillLibrary, resolvePiSkillInvocation } from "@noesis/runtime-pi";
import { afterEach, describe, expect, test } from "vitest";
import {
  EXECUTE_BUILT_IN_SKILL,
  NOESIS_BUILT_IN_SKILL,
  NOESIS_BUILT_IN_SKILLS,
} from "../src/noesis-skill.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("built-in Noesis skill", () => {
  test("loads the shipped body progressively and maps /refine to its canonical identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-built-in-skill-app-"));
    roots.push(root);
    const library = createPiSkillLibrary({
      cwd: root,
      agentDirectory: join(root, "agent"),
      builtInSkills: NOESIS_BUILT_IN_SKILLS,
    });

    const snapshot = await library.snapshot();
    const noesis = snapshot.skills.find((skill) => skill.name === "noesis");
    const execute = snapshot.skills.find((skill) => skill.name === "execute");
    expect(noesis).toMatchObject({
      name: "noesis",
      aliases: ["refine"],
      description: expect.stringContaining("deliberately refine Noesis"),
      content: expect.stringContaining("capabilities.refine"),
    });
    expect(noesis?.description).toBe(NOESIS_BUILT_IN_SKILL.description);
    expect(noesis?.content).toContain("capabilities.inspect");
    expect(noesis?.content).not.toContain("implementation files or tests");
    expect(noesis?.content).not.toContain("noesis.hotbar");
    expect(noesis?.content).not.toContain("inspect_self");
    expect(noesis?.content).not.toContain("`remember`");
    expect(execute).toMatchObject({
      name: "execute",
      description: EXECUTE_BUILT_IN_SKILL.description,
      content: expect.stringContaining("noesis.search(query)"),
    });
    expect(execute?.content).toContain(
      "agents.spawn({ name?, systemPrompt?, prompt, tools?, thinkingLevel? })",
    );
    expect(execute?.content).toContain("agents.wait({ taskId, timeoutMs? })");
    expect(execute?.content).toContain("async JavaScript function body");
    expect(execute?.content).toContain("exact returned `definitionRevisionId`");
    const invocation = resolvePiSkillInvocation("/refine preserve this method", snapshot.skills);
    expect(invocation).toMatchObject({ name: "noesis" });
    expect(invocation?.prompt).toContain("preserve this method");
    expect(invocation?.prompt).toContain("foreground agent authors the complete semantic decision");
    expect(resolvePiSkillInvocation("/execute inspect this session", snapshot.skills)).toMatchObject({
      name: "execute",
    });
  });
});
