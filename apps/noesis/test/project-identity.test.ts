import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveActiveProject } from "../src/runtime-composition.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("active project identity", () => {
  test("maps a directory and its symlink to one stable host-derived project", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-project-identity-"));
    roots.push(root);
    const projectDirectory = join(root, "project");
    const alias = join(root, "project-alias");
    await mkdir(projectDirectory);
    await symlink(projectDirectory, alias);

    const [direct, linked] = await Promise.all([
      resolveActiveProject(projectDirectory),
      resolveActiveProject(alias),
    ]);

    expect(direct).toEqual(linked);
    expect(direct.root).toBe(await realpath(projectDirectory));
    expect(direct.projectId).toMatch(/^project_[a-f0-9]{32}$/u);
  });
});
