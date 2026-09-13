import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiSkillLibrary, resolvePiSkillInvocation } from "@noesis/runtime-pi";
import { afterEach, describe, expect, test } from "vitest";
import {
  EXECUTE_BUILT_IN_SKILL,
  NOESIS_BUILT_IN_SKILL,
  NOESIS_BUILT_IN_SKILLS,
  prepareNoesisBuiltInSkills,
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
      builtInSkills: await prepareNoesisBuiltInSkills(root),
    });

    const snapshot = await library.snapshot();
    const noesis = snapshot.skills.find((skill) => skill.name === "noesis");
    const execute = snapshot.skills.find((skill) => skill.name === "execute");
    expect(noesis).toMatchObject({
      filePath: join(root, "skills/builtin/noesis/SKILL.md"),
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
      filePath: join(root, "skills/builtin/execute/SKILL.md"),
      name: "execute",
      description: EXECUTE_BUILT_IN_SKILL.description,
      content: expect.stringContaining("noesis.search(query)"),
    });
    expect(execute?.content).toContain(
      "agents.spawn({ name?, systemPrompt?, prompt, tools?, thinkingLevel? })",
    );
    expect(execute?.content).toContain("agents.wait({ taskId, timeoutMs? })");
    expect(execute?.content).toContain("make admission a short boundary");
    expect(execute?.content).toContain("every requested conclusion has direct evidence");
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

  test("backs up edits when bundled contents change and preserves reconciled edits on restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-built-in-upgrade-"));
    roots.push(root);
    const source = join(root, "bundled.md");
    const home = join(root, "custom-home");
    const bundled = [{ ...NOESIS_BUILT_IN_SKILL, filePath: source }];
    const local = join(home, "skills/builtin/noesis/SKILL.md");
    await writeFile(source, "first default");
    await prepareNoesisBuiltInSkills(home, bundled);
    expect(await readFile(local, "utf8")).toBe("first default");

    await writeFile(source, "second default");
    await prepareNoesisBuiltInSkills(home, bundled);
    expect(await readFile(local, "utf8")).toBe("second default");

    await writeFile(local, "my custom instructions");
    await prepareNoesisBuiltInSkills(home, bundled);
    expect(await readFile(local, "utf8")).toBe("my custom instructions");
    await writeFile(source, "third default");
    const skills = await prepareNoesisBuiltInSkills(home, bundled);
    const library = createPiSkillLibrary({
      cwd: root,
      agentDirectory: join(home, "agent"),
      builtInSkills: skills,
    });
    expect((await library.snapshot()).skills.find((skill) => skill.name === "noesis")?.content).toBe(
      "third default",
    );
    const backups = join(home, "skills/builtin/noesis/backups");
    const saved = await readdir(backups);
    expect(saved).toHaveLength(1);
    expect(await readFile(join(backups, saved[0] ?? "missing"), "utf8")).toBe("my custom instructions");
    await writeFile(local, "reconciled instructions");
    await prepareNoesisBuiltInSkills(home, bundled);
    expect(await readFile(local, "utf8")).toBe("reconciled instructions");
    expect(await readdir(backups)).toEqual(saved);
    await writeFile(source, "fourth default");
    await prepareNoesisBuiltInSkills(home, bundled);
    expect(await readFile(local, "utf8")).toBe("fourth default");
    const allBackups = await readdir(backups);
    expect(allBackups).toHaveLength(2);
    expect(await Promise.all(allBackups.map((name) => readFile(join(backups, name), "utf8")))).toEqual(
      expect.arrayContaining(["my custom instructions", "reconciled instructions"]),
    );

    await rm(local);
    await prepareNoesisBuiltInSkills(home, bundled);
    expect(await readFile(local, "utf8")).toBe("fourth default");
  });

  test("concurrent first starts load complete built-in bodies", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-built-in-concurrent-"));
    roots.push(root);
    const expected = await Promise.all(
      NOESIS_BUILT_IN_SKILLS.map((skill) => readFile(skill.filePath, "utf8")),
    );
    const results = await Promise.all(
      Array.from({ length: 8 }, async () => {
        const skills = await prepareNoesisBuiltInSkills(root);
        return await Promise.all(skills.map((skill) => readFile(skill.filePath, "utf8")));
      }),
    );
    for (const bodies of results) expect(bodies).toEqual(expected);
    expect(await readdir(join(root, "skills/builtin/noesis"))).toEqual(
      expect.arrayContaining(["SKILL.md", ".bundled-digest"]),
    );
    expect(await readdir(join(root, "skills/builtin/noesis"))).toHaveLength(2);
  });

  test("leaves the local body and installed baseline intact when backup fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-built-in-backup-failure-"));
    roots.push(root);
    const source = join(root, "bundled.md");
    const bundled = [{ ...NOESIS_BUILT_IN_SKILL, filePath: source }];
    await writeFile(source, "original default");
    await prepareNoesisBuiltInSkills(root, bundled);
    const directory = join(root, "skills/builtin/noesis");
    const baseline = await readFile(join(directory, ".bundled-digest"), "utf8");
    await writeFile(join(directory, "SKILL.md"), "user edits");
    await writeFile(join(directory, "backups"), "obstruction");
    await writeFile(source, "new default");
    await expect(prepareNoesisBuiltInSkills(root, bundled)).rejects.toThrow();
    expect(await readFile(join(directory, "SKILL.md"), "utf8")).toBe("user edits");
    expect(await readFile(join(directory, ".bundled-digest"), "utf8")).toBe(baseline);
  });

  test("backs up preexisting files without a known baseline and isolates configured homes", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-built-in-existing-"));
    roots.push(root);
    const directory = join(root, "skills/builtin/noesis");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), "existing user skill");
    await prepareNoesisBuiltInSkills(root);
    expect(await readFile(join(directory, "SKILL.md"), "utf8")).toBe(
      await readFile(NOESIS_BUILT_IN_SKILL.filePath, "utf8"),
    );
    const saved = await readdir(join(directory, "backups"));
    expect(saved).toHaveLength(1);
    expect(await readFile(join(directory, "backups", saved[0] ?? "missing"), "utf8")).toBe(
      "existing user skill",
    );
    const otherHome = join(root, "other-home");
    const otherSkills = await prepareNoesisBuiltInSkills(otherHome);
    expect(otherSkills.every((skill) => skill.filePath.startsWith(otherHome))).toBe(true);
    expect(await readFile(join(otherHome, "skills/builtin/noesis/SKILL.md"), "utf8")).toBe(
      await readFile(NOESIS_BUILT_IN_SKILL.filePath, "utf8"),
    );
    expect(NOESIS_BUILT_IN_SKILLS.map((skill) => skill.name)).toEqual(["execute", "noesis"]);
  });
});
