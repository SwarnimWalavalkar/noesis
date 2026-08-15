import type { TrailState } from "@noesis/runtime";
import { describe, expect, test } from "vitest";
import {
  learningAuditFocusId,
  learningDiagnosticNotice,
  reconcileSettledTurnPresentation,
  settledTurnPresentation,
  startLateLearningNoticeRefresh,
  workingAdjustmentNoticeForTurn,
} from "../src/learning-presentation.ts";
import type { TuiLearningActivitySummary } from "../src/runtime-port.ts";
import { initialTuiState, reduceTui } from "../src/state.ts";

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

const settledTrail: TrailState = Object.freeze({
  trailId: "trail-1",
  title: "Trail 1",
  paneId: "pane-1",
  runtime: "test",
  provider: "test",
  model: "test",
  status: "idle" as const,
  turns: Object.freeze([{ input: "hello", output: "hi" }]),
  capabilityVersions: Object.freeze({}),
  context: Object.freeze({
    schemaVersion: 1 as const,
    snapshotId: "context-1",
    createdAt: "2026-08-01T00:00:00.000Z",
    maxTokens: 1_000,
    usedTokens: 10,
    fragments: [],
    capabilityVersions: {},
  }),
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
});

const waitForAsyncPresentation = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

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

  test("names the audit record a later /learning command should open", () => {
    expect(learningAuditFocusId(activity("adjusted"))).toBe("reflection:job-adjusted");
    expect(
      learningAuditFocusId(
        Object.freeze({
          ...activity("adjusted"),
          adjustmentId: "adjustment-1",
        }),
      ),
    ).toBe("working_adjustment:adjustment-1");
    expect(
      learningAuditFocusId(
        Object.freeze({
          ...activity("failed"),
          stage: "authoring" as const,
          experimentId: "experiment-1",
        }),
      ),
    ).toBe("experiment:experiment-1");
  });

  test("includes the applied strategy and tracks a running reflection without a transcript placeholder", async () => {
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
    expect(presentation.actions).not.toContainEqual(
      expect.objectContaining({ type: "system-message", text: expect.stringContaining("reviewing") }),
    );
  });

  test.each([
    "idle",
    "thinking",
  ] as const)("keeps a %s foreground state intact while surfacing an auxiliary learning read failure", async (foregroundState) => {
    const failure = new Error("learning read failed\u001b[31m\nplease retry");
    let state = initialTuiState("test", {
      provider: "test",
      model: "test",
      reasoningLevel: "off",
      colorEnabled: false,
    });
    state = reduceTui(state, { type: "trail-selected", trail: settledTrail });
    if (foregroundState === "thinking") state = reduceTui(state, { type: "prompt-submitted", text: "newer" });
    const reported: unknown[] = [];
    reconcileSettledTurnPresentation(
      {
        getTranscript: async () =>
          Object.freeze([
            Object.freeze({
              kind: "message" as const,
              messageId: "message-1",
              role: "assistant" as const,
              text: "hi",
              createdAt: "2026-08-01T00:00:00.000Z",
            }),
          ]),
        getTrail: async () => settledTrail,
        listLearningActivity: async () => await Promise.reject(failure),
      },
      {
        trailId: "trail-1",
        turnId: "turn-1",
        outcome: "completed",
        contextUsage: undefined,
      },
      {
        isTrailCurrent: () => true,
        canApplySettledState: () => foregroundState === "idle",
        dispatch: (action) => {
          state = reduceTui(state, action);
        },
        requestRender: () => undefined,
        reportDiagnostic: (error) => {
          state = reduceTui(state, { type: "system-message", text: learningDiagnosticNotice(error) });
        },
        reportFailure: (error) => reported.push(error),
      },
    );

    await waitForAsyncPresentation();

    expect(state.execution).toBe(foregroundState);
    expect(state.error).toBeUndefined();
    expect(state.timeline.at(-1)).toMatchObject({
      kind: "message",
      role: "system",
      text: "learning · unavailable · learning read failed [31m please retry",
    });
    expect(reported).toEqual([]);
  });

  test.each([
    Object.create(null),
    Object.freeze({
      [Symbol.toPrimitive]: () => {
        throw new Error("conversion failed");
      },
    }),
  ])("keeps unstringifiable learning failures nonfatal", (failure) => {
    expect(learningDiagnosticNotice(failure)).toBe("learning · unavailable");
  });

  test("reports errors thrown while applying a fulfilled settled presentation", async () => {
    const failure = new Error("dispatch failed");
    const reported: unknown[] = [];
    reconcileSettledTurnPresentation(
      {
        getTranscript: async () => Object.freeze([]),
        getTrail: async () => settledTrail,
        listLearningActivity: async () => Object.freeze([]),
      },
      {
        trailId: "trail-1",
        turnId: "turn-1",
        outcome: "completed",
        contextUsage: undefined,
      },
      {
        isTrailCurrent: () => true,
        canApplySettledState: () => true,
        dispatch: () => {
          throw failure;
        },
        requestRender: () => undefined,
        reportDiagnostic: () => undefined,
        reportFailure: (error) => reported.push(error),
      },
    );

    await waitForAsyncPresentation();

    expect(reported).toEqual([failure]);
  });

  test("reports errors thrown by the late notice fulfillment handler", async () => {
    const failure = new Error("notice failed");
    const reported: unknown[] = [];
    startLateLearningNoticeRefresh(
      {
        waitForLearningActivity: async () => activity("adjusted"),
      },
      {
        trailId: "trail-1",
        jobId: "job-adjusted",
        onNotice: () => {
          throw failure;
        },
        onFailure: (error) => reported.push(error),
        onError: (error) => reported.push(error),
      },
    );

    await waitForAsyncPresentation();

    expect(reported).toEqual([failure]);
  });

  test("surfaces a late learning read rejection through the nonfatal callback", async () => {
    const failure = new Error("late learning unavailable");
    const diagnostics: unknown[] = [];
    const fatal: unknown[] = [];
    startLateLearningNoticeRefresh(
      {
        waitForLearningActivity: async () => await Promise.reject(failure),
      },
      {
        trailId: "trail-1",
        jobId: "job-adjusted",
        onNotice: () => undefined,
        onFailure: (error) => diagnostics.push(error),
        onError: (error) => fatal.push(error),
      },
    );

    await waitForAsyncPresentation();

    expect(diagnostics).toEqual([failure]);
    expect(fatal).toEqual([]);
  });
});
