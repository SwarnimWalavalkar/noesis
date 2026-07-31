import type { NoesisAgentRuntime } from "@noesis/agent-types";
import { describe, expect, test } from "vitest";
import { isExclusiveSlashCommand, runSlashCommand, steerFeedback } from "../src/index.ts";
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
  async steer() {
    return {
      status: "consumed" as const,
      timelineSequence: 1,
      consumedAt: "2026-07-31T00:00:00.000Z",
    };
  },
  async abort() {},
};

describe("Noesis slash commands", () => {
  test("explains idle and unresolved steering without masking successful delivery", () => {
    const snapshot = { sessionId: "session", phase: "idle" as const, queuePaused: true, pending: [] };
    expect(steerFeedback({ effect: "idle", snapshot }, true)).toContain("No active turn");
    expect(steerFeedback({ effect: "idle", snapshot }, false)).toContain("No queued message");
    expect(steerFeedback({ effect: "unresolved", snapshot }, true)).toContain("will not retry");
    expect(steerFeedback({ effect: "steered", snapshot }, true)).toBeUndefined();
  });

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
