import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noesis/domain";
import type { PiBuiltInSkill } from "@noesis/runtime-pi";

export const NOESIS_BUILT_IN_SKILL: PiBuiltInSkill = Object.freeze({
  name: "noesis",
  aliases: Object.freeze(["refine"]),
  description:
    "Inspect and deliberately refine Noesis's lasting Capabilities, skills, and harness. Use for self-improvement, learned behavior, feedback, scope, activation, or restoration.",
  filePath: fileURLToPath(new URL("../skills/noesis/SKILL.md", import.meta.url)),
  disableModelInvocation: false,
});

export const EXECUTE_BUILT_IN_SKILL: PiBuiltInSkill = Object.freeze({
  name: "execute",
  description:
    "Compose multi-call work through Noesis Code Mode and its injected SDK. Use for tool discovery, session analysis, subagents, MCP access, or authoring and running Programs.",
  filePath: fileURLToPath(new URL("../skills/execute/SKILL.md", import.meta.url)),
  disableModelInvocation: false,
});

export const NOESIS_BUILT_IN_SKILLS = Object.freeze([EXECUTE_BUILT_IN_SKILL, NOESIS_BUILT_IN_SKILL]);

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function replaceFile(path: string, content: string, exclusive = false): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    if (exclusive) await link(temporary, path);
    else await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Install changed bundled defaults, preserving displaced user edits before replacement. */
export async function prepareNoesisBuiltInSkills(
  home: string,
  bundledSkills: readonly PiBuiltInSkill[] = NOESIS_BUILT_IN_SKILLS,
): Promise<readonly PiBuiltInSkill[]> {
  const skills: PiBuiltInSkill[] = [];
  for (const skill of bundledSkills) {
    const directory = join(home, "skills", "builtin", skill.name);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const filePath = join(directory, "SKILL.md");
    const baselinePath = join(directory, ".bundled-digest");
    const bundled = await readFile(skill.filePath, "utf8");
    const bundledDigest = sha256(bundled);
    const current = await readOptional(filePath);
    const baseline = await readOptional(baselinePath);
    if (current === undefined) {
      // Publish complete bytes atomically without replacing a concurrent startup's file.
      try {
        await replaceFile(filePath, bundled, true);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
    } else if (baseline !== bundledDigest && current !== bundled) {
      if (baseline !== sha256(current)) {
        const backups = join(directory, "backups");
        await mkdir(backups, { recursive: true, mode: 0o700 });
        const timestamp = new Date().toISOString().replaceAll(":", "-");
        await writeFile(join(backups, `SKILL.${timestamp}.${randomUUID()}.md.bak`), current, {
          flag: "wx",
          mode: 0o600,
        });
      }
      await replaceFile(filePath, bundled);
    }
    // Record the shipped version only after installation succeeds. Same-version restarts keep edits.
    if ((await readOptional(filePath)) === bundled) {
      await replaceFile(baselinePath, bundledDigest);
    }
    skills.push(Object.freeze({ ...skill, filePath }));
  }
  return Object.freeze(skills);
}
