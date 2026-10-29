import type { DurableJobRecord } from "@noesis/domain";
import { expect, test } from "vitest";
import { sessionReviewNotices } from "../src/session-review-notices.ts";

const review = (jobId: string, completedAt: string, results: readonly unknown[]): DurableJobRecord => ({
  jobId,
  kind: "runtime.review_session",
  payload: {},
  payloadRefs: [],
  operationId: jobId,
  idempotencyKey: jobId,
  status: "completed",
  notBefore: "2026-10-29T10:00:00.000Z",
  attempt: 1,
  maxAttempts: 2,
  estimatedCost: 1,
  budgetRemaining: 2,
  result: { status: "reviewed", summary: "Found a repeated need.", results: [...results] },
  createdAt: "2026-10-29T10:00:00.000Z",
  updatedAt: completedAt,
  completedAt,
});

test("announces a session review's published change on the next turn after it completed", () => {
  const turns = [
    { turnId: "turn-before", createdAt: "2026-10-29T10:30:00.000Z" },
    { turnId: "turn-after", createdAt: "2026-10-29T11:30:00.000Z" },
  ];
  expect(
    sessionReviewNotices(
      [
        review("job-published", "2026-10-29T11:00:00.000Z", [
          { status: "no_change", reason: "Nothing here." },
          { status: "activated", capabilityId: "capability-notes", message: "Release notes by area" },
          { status: "paused", capabilityId: "capability-old", message: "Paused overlapping notes" },
        ]),
        review("job-quiet", "2026-10-29T11:00:00.000Z", [{ status: "no_change", reason: "Nothing." }]),
        review("job-later", "2026-10-29T12:00:00.000Z", [{ status: "paused", capabilityId: "capability-x" }]),
      ],
      turns,
    ),
  ).toEqual([
    {
      jobId: "job-published",
      stage: "reflection",
      status: "activated",
      summary: "Review of an earlier session · Release notes by area · Paused overlapping notes",
      updatedAt: "2026-10-29T11:00:00.000Z",
      reactionTurnId: "turn-after",
      capabilityId: "capability-notes",
    },
  ]);
});
