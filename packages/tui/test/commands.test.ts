import type { NoesisAgentRuntime } from "@noesis/agent-types";
import { describe, expect, test } from "vitest";
import { isExclusiveSlashCommand, runSlashCommand } from "../src/index.ts";
import { createInMemoryTestRuntime } from "./support/in-memory-runtime.ts";

const agent: NoesisAgentRuntime = {
  name: "slash-command-test",
  async run(request) {
    return {
      text: request.prompt,
      provider: request.provider,
      model: request.model,
      outcome: "completed",
      stopReason: "stop",
    };
  },
  async steer() {},
  async followUp() {},
  async abort() {},
};

describe("Noesis slash commands", () => {
  test("classifies normalized state-mutating commands as exclusive", () => {
    expect(isExclusiveSlashCommand("  /compact \n")).toBe(true);
    expect(isExclusiveSlashCommand("/fork")).toBe(true);
    expect(isExclusiveSlashCommand("\t/model provider/model ")).toBe(true);
    expect(isExclusiveSlashCommand("/runs")).toBe(false);
    expect(isExclusiveSlashCommand("/script reusable-research")).toBe(false);
  });

  test("normalizes surrounding whitespace before matching and parsing arguments", async () => {
    const base = createInMemoryTestRuntime(agent);
    let inspectedName = "";
    const runtime = Object.freeze({
      ...base,
      inspectScript: async (name: string) => {
        inspectedName = name;
        return undefined;
      },
    });
    const published: string[] = [];

    const handled = await runSlashCommand(" \t/script reusable-research \n", {
      runtime,
      trailId: "trail_test",
      publishInspector: (message) => published.push(message),
      dispatch: () => undefined,
      requestRender: () => undefined,
    });

    expect(handled).toBe(true);
    expect(inspectedName).toBe("reusable-research");
    expect(published).toEqual(["Unknown script: reusable-research"]);
  });
});
