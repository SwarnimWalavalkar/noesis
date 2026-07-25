import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(packageRoot, "src");
const forbiddenModules = [
  "@noesis/capabilities",
  "@noesis/ledger",
  "@noesis/learning",
  "@noesis/policy",
  "@noesis/workspace",
] as const;
const forbiddenMembers = [
  "artifacts",
  "authority",
  "capabilities",
  "ledger",
  "memory",
  "policy",
  "scheduler",
  "workspace",
] as const;

describe("TUI architecture", () => {
  test("keeps durable and protected internals behind NoesisTuiRuntime", async () => {
    const files = (await readdir(sourceRoot)).filter((name) => name.endsWith(".ts")).sort();
    const violations: string[] = [];
    for (const name of files) {
      const source = await readFile(join(sourceRoot, name), "utf8");
      for (const moduleName of forbiddenModules)
        if (source.includes(`from "${moduleName}"`) || source.includes(`from '${moduleName}'`))
          violations.push(`${name}:import:${moduleName}`);
      for (const member of forbiddenMembers)
        if (new RegExp(`\\.${member}\\b`, "u").test(source)) violations.push(`${name}:member:${member}`);
    }
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
      readonly dependencies?: Readonly<Record<string, string>>;
    };
    for (const moduleName of forbiddenModules)
      if (moduleName in (manifest.dependencies ?? {}))
        violations.push(`package.json:dependency:${moduleName}`);

    expect(violations).toEqual([]);
  });

  test("keeps extracted source modules below the god-file threshold", async () => {
    const files = (await readdir(sourceRoot)).filter((name) => name.endsWith(".ts")).sort();
    const oversized: string[] = [];
    for (const name of files) {
      const lineCount = (await readFile(join(sourceRoot, name), "utf8")).split("\n").length;
      if (lineCount > 800) oversized.push(`${name}:${lineCount}`);
    }
    expect(oversized).toEqual([]);
  });
});
