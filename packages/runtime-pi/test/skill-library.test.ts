import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  test("orders snapshot resources independently of the host locale", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-skill-order-"));
    roots.push(root);
    const project = join(root, "project");
    const skillPackage = join(root, "package");
    const definitions = [
      { directory: "lower", name: "zeta" },
      { directory: "accented", name: "äther" },
      { directory: "upper", name: "Alpha" },
      { directory: "punctuation", name: "a-z" },
      { directory: "numeric", name: "a0" },
    ] as const;
    await mkdir(project, { recursive: true });
    for (const definition of definitions) {
      const directory = join(skillPackage, "skills", definition.directory);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "SKILL.md"),
        `---\nname: ${definition.name}\ndescription: Ordering fixture.\n---\n\n${definition.name}`,
        "utf8",
      );
    }
    const library = createPiSkillLibrary({
      cwd: project,
      agentDirectory: join(root, "agent"),
      workspaceTrusted: true,
    });
    await library.install(skillPackage, "workspace");

    const names = (await library.snapshot()).skills
      .filter((skill) => skill.filePath.startsWith(skillPackage))
      .map((skill) => skill.name);

    expect(names).toEqual(["Alpha", "a-z", "a0", "zeta", "äther"]);
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

  test("degrades admission instead of awaiting a stalled background snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-skill-background-stall-"));
    roots.push(root);
    const project = join(root, "project");
    const skillPackage = join(root, "package");
    const skillPath = join(skillPackage, "skills", "eventual", "SKILL.md");
    const content =
      "---\nname: eventual\ndescription: Eventual skill.\n---\n\nLoaded after discovery settles.";
    await mkdir(project, { recursive: true });
    await mkdir(join(skillPackage, "skills", "eventual"), { recursive: true });
    await writeFile(skillPath, content, "utf8");
    let signalReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    let releaseRead: (() => void) | undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let reads = 0;
    const library = createPiSkillLibrary({
      cwd: project,
      agentDirectory: join(root, "agent"),
      workspaceTrusted: true,
      readSkillFile: async (path) => {
        reads += 1;
        signalReadStarted?.();
        await readGate;
        return path === skillPath ? content : "";
      },
    });
    await library.install(skillPackage, "workspace");

    const background = library.snapshot();
    await readStarted;
    const readsBeforeAdmission = reads;
    const admitted = await library.pinSnapshot("ordinary-turn");

    expect(admitted.skills).toEqual([]);
    expect(admitted.diagnostics).toEqual([
      expect.objectContaining({
        type: "warning",
        message: expect.stringContaining("uses no skills"),
      }),
    ]);
    expect(reads).toBe(readsBeforeAdmission);

    releaseRead?.();
    const settled = await background;
    expect(settled.skills).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "eventual", content })]),
    );
    const later = await library.pinSnapshot("later-turn");
    expect(later.skills).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "eventual", content })]),
    );
  });

  test("keeps valid skills when one discovered resource persistently fails to load", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-skill-partial-load-"));
    roots.push(root);
    const project = join(root, "project");
    const skillPackage = join(root, "package");
    const validPath = join(skillPackage, "skills", "valid", "SKILL.md");
    const brokenPath = join(skillPackage, "skills", "broken", "SKILL.md");
    const validContent = "---\nname: valid\ndescription: Valid skill.\n---\n\nUseful instructions.";
    const brokenContent = "---\nname: broken\ndescription: Broken skill.\n---\n\nUnreadable instructions.";
    await mkdir(project, { recursive: true });
    await mkdir(join(skillPackage, "skills", "valid"), { recursive: true });
    await mkdir(join(skillPackage, "skills", "broken"), { recursive: true });
    await writeFile(validPath, validContent, "utf8");
    await writeFile(brokenPath, brokenContent, "utf8");
    const library = createPiSkillLibrary({
      cwd: project,
      agentDirectory: join(root, "agent"),
      workspaceTrusted: true,
      readSkillFile: async (path) => {
        if (path === brokenPath) throw new Error("persistent read failure");
        return await readFile(path, "utf8");
      },
    });
    await library.install(skillPackage, "workspace");

    const snapshot = await library.pinSnapshot("partial-plan");

    expect(snapshot.skills.find((skill) => skill.name === "valid")).toMatchObject({
      name: "valid",
      content: validContent,
    });
    expect(snapshot.skills.some((skill) => skill.name === "broken")).toBe(false);
    expect(snapshot.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "error",
          path: brokenPath,
          message: expect.stringContaining("persistent read failure"),
        }),
      ]),
    );
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

  test("coalesces concurrent admission for one pin key into one immutable snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-skill-pin-concurrency-"));
    roots.push(root);
    const project = join(root, "project");
    const skillPackage = join(root, "package");
    const skillPath = join(skillPackage, "skills", "shared-pin", "SKILL.md");
    await mkdir(project, { recursive: true });
    await mkdir(join(skillPackage, "skills", "shared-pin"), { recursive: true });
    await writeFile(
      skillPath,
      "---\nname: shared-pin\ndescription: Shared pin.\n---\n\nPinned once.",
      "utf8",
    );
    const library = createPiSkillLibrary({
      cwd: project,
      agentDirectory: join(root, "agent"),
      workspaceTrusted: true,
    });
    await library.install(skillPackage, "workspace");
    let releaseAdmission: (() => void) | undefined;
    const admissionBarrier = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    let admissionStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      admissionStarted = resolve;
    });
    let admissions = 0;
    const first = library.pinSnapshot("shared-plan", undefined, async (snapshot) => {
      admissions += 1;
      admissionStarted?.();
      await admissionBarrier;
      return Object.freeze({
        ...snapshot,
        skills: Object.freeze(
          snapshot.skills.map((skill) =>
            Object.freeze({
              ...skill,
              admittedRevision: Object.freeze({
                kind: "evidence_revision" as const,
                revisionId: "evidence-shared-pin",
                workingPath: "evidence/shared-pin",
                snapshotPath: "evidence/shared-pin",
                contentDigest: skill.contentDigest,
                evidenceKind: "input" as const,
              }),
            }),
          ),
        ),
      });
    });
    await started;
    const second = library.pinSnapshot("shared-plan", undefined, async () => {
      admissions += 1;
      throw new Error("Concurrent admission must be coalesced");
    });
    releaseAdmission?.();

    const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);

    expect(admissions).toBe(1);
    expect(firstSnapshot).toBe(secondSnapshot);
    expect(firstSnapshot.skills[0]?.admittedRevision?.revisionId).toBe("evidence-shared-pin");
    expect(secondSnapshot.skills[0]?.admittedRevision).toBe(firstSnapshot.skills[0]?.admittedRevision);
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
