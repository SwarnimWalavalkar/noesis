import type { NoesisAgentRuntime } from "@noesis/agent-types";
import { describe, expect, test } from "vitest";
import {
  isExclusiveSlashCommand,
  type NoesisTuiAction,
  runSlashCommand,
  steerFeedback,
} from "../src/index.ts";
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

  test("renders quiet, inspectable ambient learning outcomes from the session read model", async () => {
    const base = createInMemoryTestRuntime(agent);
    const requestedSessions: string[] = [];
    const runtime = Object.freeze({
      ...base,
      listLearningActivity: async (sessionId: string) => {
        requestedSessions.push(sessionId);
        return Object.freeze([
          Object.freeze({
            jobId: "job-reflection-running",
            stage: "reflection" as const,
            status: "running" as const,
            summary: "Running reflection on the completed turn",
            updatedAt: "2026-08-01T00:00:01.000Z",
            turnId: "turn-1",
            capabilityId: "general-collaboration",
          }),
          Object.freeze({
            jobId: "job-reflection-no-change",
            stage: "reflection" as const,
            status: "no_change" as const,
            summary: "The turn already worked well",
            updatedAt: "2026-08-01T00:00:02.000Z",
            turnId: "turn-2",
          }),
          Object.freeze({
            jobId: "job-author-failed",
            stage: "authoring" as const,
            status: "failed" as const,
            summary: "Candidate source could not be validated",
            failure: "Candidate source could not be validated",
            updatedAt: "2026-08-01T00:00:03.000Z",
            experimentId: "experiment-1",
          }),
          Object.freeze({
            jobId: "job-preflight-complete",
            stage: "preflight" as const,
            status: "completed" as const,
            summary: "Preflight decision: pass",
            updatedAt: "2026-08-01T00:00:04.000Z",
            experimentId: "experiment-1",
            capabilityId: "research-brief",
            capabilityRevisionId: "research-brief-v2",
          }),
        ]);
      },
    });
    const published: string[] = [];

    const handled = await runSlashCommand("/learning", {
      runtime,
      trailId: "trail-learning",
      publishInspector: (message) => published.push(message),
      dispatch: () => undefined,
      requestRender: () => undefined,
    });

    expect(handled).toBe(true);
    expect(requestedSessions).toEqual(["trail-learning"]);
    expect(published).toHaveLength(1);
    expect(published[0]).toContain("Learning activity · 4");
    expect(published[0]).toContain("● running · reflection");
    expect(published[0]).toContain("— no change · reflection");
    expect(published[0]).toContain("× failed · authoring");
    expect(published[0]).toContain("✓ completed · preflight");
    expect(published[0]).toContain("experiment experiment-1");
    expect(published[0]).toContain("capability research-brief@research-brief-v2");
    expect(published[0]).toContain("No change is a normal outcome");
    expect(published[0]).not.toContain("approve");
  });

  test("hydrates inherited history when a fork becomes the active trail", async () => {
    const runtime = createInMemoryTestRuntime(agent);
    const parent = await runtime.startTrail({ title: "parent" });
    await runtime.runTurn(parent.trailId, "keep this context");
    const dispatched: NoesisTuiAction[] = [];

    const handled = await runSlashCommand("/fork", {
      runtime,
      trailId: parent.trailId,
      publishInspector: () => undefined,
      dispatch: (action) => dispatched.push(action),
      requestRender: () => undefined,
    });

    expect(handled).toBe(true);
    expect(dispatched).toHaveLength(2);
    expect(dispatched[0]).toMatchObject({ type: "trail-selected" });
    expect(dispatched[1]).toMatchObject({
      type: "transcript-hydrated",
      transcript: [
        expect.objectContaining({ role: "user", text: "keep this context" }),
        expect.objectContaining({ role: "assistant", text: "keep this context" }),
      ],
    });
    if (dispatched[0]?.type !== "trail-selected" || dispatched[1]?.type !== "transcript-hydrated")
      throw new Error("expected a selected and hydrated fork");
    expect(dispatched[1].trailId).toBe(dispatched[0].trail.trailId);
  });
});
