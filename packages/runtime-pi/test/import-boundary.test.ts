import { glob, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

describe("Pi import boundary", () => {
  test("keeps Pi agent and auth types out of the Noesis CLI", async () => {
    const cliPath = fileURLToPath(new URL("../../../apps/noesis/src/cli.ts", import.meta.url));
    const source = await readFile(cliPath, "utf8");

    expect(source).not.toContain("@earendil-works/pi-ai");
    expect(source).not.toContain("@earendil-works/pi-agent-core");
  });

  test("confines Pi model and agent runtime imports to runtime-pi", async () => {
    const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const leaks: string[] = [];
    for await (const path of glob(["apps/**/*.ts", "packages/**/*.ts"], { cwd: repositoryRoot })) {
      if (path.startsWith("packages/runtime-pi/")) continue;
      const source = await readFile(resolve(repositoryRoot, path), "utf8");
      if (
        /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["']@earendil-works\/pi-(?:ai|agent-core)/.test(source)
      ) {
        leaks.push(relative(repositoryRoot, resolve(repositoryRoot, path)));
      }
    }

    expect(leaks).toEqual([]);
  });
});
