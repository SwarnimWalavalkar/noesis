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

test("a promotion is announced, and a Capability decision in the same review leads the notice", () => {
  const turns = [{ turnId: "turn-after", createdAt: "2026-10-29T11:30:00.000Z" }];
  const promotion = {
    status: "program_promoted",
    mode: "script",
    name: "release-notes",
    definitionRevisionId: "revision-global",
    programRevision: 1,
    unchanged: false,
    message: "Promoted Program release-notes to global: Two projects use it.",
  };
  expect(
    sessionReviewNotices(
      [
        review("job-promoted", "2026-10-29T11:00:00.000Z", [promotion]),
        review("job-mixed", "2026-10-29T11:00:00.000Z", [
          promotion,
          { status: "pending", capabilityId: "capability-notes", message: "Release notes need approval" },
        ]),
      ],
      turns,
    ),
  ).toEqual([
    {
      jobId: "job-promoted",
      stage: "reflection",
      status: "program_promoted",
      summary:
        "Review of an earlier session · Promoted Program release-notes to global: Two projects use it.",
      updatedAt: "2026-10-29T11:00:00.000Z",
      reactionTurnId: "turn-after",
    },
    {
      jobId: "job-mixed",
      stage: "reflection",
      status: "pending",
      summary:
        "Review of an earlier session · Release notes need approval · Promoted Program release-notes to global: Two projects use it.",
      updatedAt: "2026-10-29T11:00:00.000Z",
      reactionTurnId: "turn-after",
      capabilityId: "capability-notes",
    },
  ]);
});
