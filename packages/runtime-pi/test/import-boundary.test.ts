import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

describe("Pi import boundary", () => {
  test("keeps Pi agent and auth types out of the Noesis CLI", async () => {
    const cliPath = fileURLToPath(new URL("../../../apps/noesis/src/cli.ts", import.meta.url));
    const source = await readFile(cliPath, "utf8");

    expect(source).not.toContain("@earendil-works/pi-ai");
    expect(source).not.toContain("@earendil-works/pi-agent-core");
  });
});
