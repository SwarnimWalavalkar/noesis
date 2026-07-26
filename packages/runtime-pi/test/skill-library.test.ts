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
      workspaceTrusted: true,
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

  test("one cancelled snapshot caller does not poison a shared load", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-skill-cancellation-"));
    roots.push(root);
    const project = join(root, "project");
    const skillPackage = join(root, "package");
    const skillPath = join(skillPackage, "skills", "shared", "SKILL.md");
    await mkdir(project, { recursive: true });
    await mkdir(join(skillPackage, "skills", "shared"), { recursive: true });
    const content = "---\nname: shared\ndescription: Shared load.\n---\n\nShared instructions.";
    await writeFile(skillPath, content, "utf8");
    let releaseRead: (() => void) | undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const library = createPiSkillLibrary({
      cwd: project,
      agentDirectory: join(root, "agent"),
      workspaceTrusted: true,
      readSkillFile: async (path) => {
        await readGate;
        return path === skillPath ? content : "";
      },
    });
    await library.install(skillPackage, "workspace");
    const controller = new AbortController();

    const cancelled = library.snapshot(controller.signal);
    const surviving = library.snapshot();
    controller.abort();
    releaseRead?.();

    await expect(cancelled).rejects.toThrow("cancelled");
    const survivingSnapshot = await surviving;
    expect(survivingSnapshot.skills.find((skill) => skill.name === "shared")).toMatchObject({
      name: "shared",
      content: expect.stringContaining("Shared instructions"),
    });
  });

  test("pins exact skill bytes for admission and honors update scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-skill-pin-"));
    roots.push(root);
    const project = join(root, "project");
    const skillPackage = join(root, "package");
    const skillPath = join(skillPackage, "skills", "pinned", "SKILL.md");
    await mkdir(project, { recursive: true });
    await mkdir(join(skillPackage, "skills", "pinned"), { recursive: true });
    await writeFile(
      skillPath,
      "---\nname: pinned\ndescription: Pinned skill.\n---\n\nFirst instructions.",
      "utf8",
    );
    const library = createPiSkillLibrary({
      cwd: project,
      agentDirectory: join(root, "agent"),
      workspaceTrusted: true,
    });
    await library.install(skillPackage, "workspace");

    const pinned = await library.pinSnapshot("plan-one");
    await writeFile(
      skillPath,
      "---\nname: pinned\ndescription: Pinned skill.\n---\n\nChanged instructions.",
      "utf8",
    );
    const claimed = library.claimPinnedSnapshot("plan-one");
    const live = await library.snapshot();

    expect(pinned.skills.find((skill) => skill.name === "pinned")?.content).toContain("First instructions");
    expect(claimed).toBe(pinned);
    expect(live.skills.find((skill) => skill.name === "pinned")?.content).toContain("Changed instructions");
    await expect(library.update(skillPackage, "personal")).rejects.toThrow("No matching");
    await expect(library.update(skillPackage, "workspace")).resolves.toBeUndefined();
  });

  test("does not trust repository-selected skill packages by default", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-untrusted-skill-"));
    roots.push(root);
    const project = join(root, "project");
    const skillPackage = join(root, "untrusted-package");
    await mkdir(join(project, ".pi"), { recursive: true });
    await mkdir(join(skillPackage, "skills", "untrusted"), { recursive: true });
    await writeFile(
      join(skillPackage, "skills", "untrusted", "SKILL.md"),
      "---\nname: untrusted\ndescription: Must not load.\n---\n\nUntrusted instructions.",
      "utf8",
    );
    await writeFile(
      join(project, ".pi", "settings.json"),
      JSON.stringify({ packages: [skillPackage] }),
      "utf8",
    );
    const library = createPiSkillLibrary({
      cwd: project,
      agentDirectory: join(root, "agent"),
    });

    await expect(library.install(skillPackage, "workspace")).rejects.toThrow("explicit workspace trust");
    expect((await library.snapshot()).skills.map((skill) => skill.name)).not.toContain("untrusted");
  });
});
