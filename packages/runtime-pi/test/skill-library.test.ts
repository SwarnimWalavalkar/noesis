import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createPiSkillLibrary } from "../src/index.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("Pi skill library adapter", () => {
  test("installs and progressively snapshots a standard local Agent Skill without extensions", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-skill-library-"));
    roots.push(root);
    const project = join(root, "project");
    const skillPackage = join(root, "portable-skill-package");
    const skill = join(skillPackage, "skills", "portable-research");
    await mkdir(project, { recursive: true });
    await mkdir(skill, { recursive: true });
    await writeFile(
      join(skill, "SKILL.md"),
      [
        "---",
        "name: portable-research",
        "description: Research a question using primary evidence.",
        "---",
        "",
        "# Portable research",
        "",
        "Collect primary sources before synthesis.",
      ].join("\n"),
      "utf8",
    );
    const library = createPiSkillLibrary({
      cwd: project,
      agentDirectory: join(root, "agent"),
    });

    await library.install(skillPackage, "workspace");
    const snapshot = await library.snapshot();

    const installed = snapshot.skills.find((candidate) => candidate.name === "portable-research");
    expect(installed).toMatchObject({
      name: "portable-research",
      description: "Research a question using primary evidence.",
      filePath: join(skill, "SKILL.md"),
    });
    expect(installed?.content).toContain("Collect primary sources");
    expect(library.configured()).toMatchObject([{ scope: "workspace" }]);
    expect(library.configured()[0]?.source).toContain("portable-skill-package");
  });
});
