import { describe, expect, test } from "vitest";
import { settledTurnPresentation, workingAdjustmentNoticeForTurn } from "../src/learning-presentation.ts";
import type { TuiLearningActivitySummary } from "../src/runtime-port.ts";

function activity(
  status: TuiLearningActivitySummary["status"],
  turnId = "turn-1",
): TuiLearningActivitySummary {
  return Object.freeze({
    jobId: `job-${status}`,
    stage: "reflection",
    status,
    summary: `${status} summary`,
    updatedAt: "2026-08-01T00:00:00.000Z",
    turnId,
  });
}

describe("working-adjustment notice presentation", () => {
  test.each([
    ["adjusted", "adjusted · adjusted summary"],
    ["replaced", "adjusted · replaced summary"],
    ["unapplied", "unapplied · unapplied summary"],
    ["stale", "unchanged · stale summary"],
  ] as const)("presents %s outcomes", (status, expected) => {
    expect(workingAdjustmentNoticeForTurn([activity(status)], "turn-1")).toBe(expected);
  });

  test("ignores unrelated turns and quiet learning outcomes", () => {
    expect(
      workingAdjustmentNoticeForTurn([activity("adjusted", "other-turn"), activity("no_change")], "turn-1"),
    ).toBeUndefined();
  });

  test("includes the applied strategy and marks a running reflection for one late refresh", async () => {
    const adjusted = Object.freeze({
      ...activity("adjusted"),
      workingAdjustment: Object.freeze({
        adjustmentId: "adjustment-1",
        projectId: "project-1",
        status: "active" as const,
        strategy: "Verify observable state before claiming completion.",
        successSignal: "Completion claims cite observed state.",
        servedEvidence: Object.freeze([]),
      }),
    });
    expect(workingAdjustmentNoticeForTurn([adjusted], "turn-1")).toContain(
      "strategy · Verify observable state before claiming completion.",
    );

    const presentation = await settledTurnPresentation(
      {
        getTranscript: async () => Object.freeze([]),
        getTrail: async () =>
          Object.freeze({
            trailId: "trail-1",
            title: "Trail 1",
            paneId: "pane-1",
            runtime: "test",
            provider: "test",
            model: "test",
            status: "idle" as const,
            turns: Object.freeze([]),
            capabilityVersions: Object.freeze({}),
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
          }),
        listLearningActivity: async () => Object.freeze([activity("running")]),
      },
      {
        trailId: "trail-1",
        turnId: "turn-1",
        outcome: "completed",
        contextUsage: undefined,
      },
    );
    expect(presentation.pendingReflectionJobId).toBe("job-running");
    expect(presentation.actions).toContainEqual({
      type: "system-message",
      text: "learning · reviewing...",
    });
  });

  test("surfaces learning read failures through the settled-turn failure path", async () => {
    const failure = new Error("learning read failed");
    await expect(
      settledTurnPresentation(
        {
          getTranscript: async () => Object.freeze([]),
          getTrail: async () =>
            Object.freeze({
              trailId: "trail-1",
              title: "Trail 1",
              paneId: "pane-1",
              runtime: "test",
              provider: "test",
              model: "test",
              status: "idle" as const,
              turns: Object.freeze([]),
              capabilityVersions: Object.freeze({}),
              createdAt: "2026-08-01T00:00:00.000Z",
              updatedAt: "2026-08-01T00:00:00.000Z",
            }),
          listLearningActivity: async () => await Promise.reject(failure),
        },
        {
          trailId: "trail-1",
          turnId: "turn-1",
          outcome: "completed",
          contextUsage: undefined,
        },
      ),
    ).rejects.toBe(failure);
  });
});
