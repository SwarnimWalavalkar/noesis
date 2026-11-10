import { createConditionalObject, type DurableJobRecord } from "@noesis/domain";
import type { TuiLearningActivitySummary } from "@noesis/tui";
import { CapabilityPublicationResultSchema, ProgramPromotionResultSchema } from "@noesis/learning";
import { z } from "zod";

const SessionReviewResultSchema = z.looseObject({
  status: z.literal("reviewed"),
  summary: z.string(),
  results: z.array(z.union([CapabilityPublicationResultSchema, ProgramPromotionResultSchema])),
});

/**
 * A session review usually finishes after its session has gone quiet. Its published change is
 * announced on the first turn, in the session being viewed, that arrived after the review completed.
 */
export function sessionReviewNotices(
  reviews: readonly DurableJobRecord[],
  userTurns: readonly { readonly turnId: string; readonly createdAt: string }[],
): readonly TuiLearningActivitySummary[] {
  return Object.freeze(
    reviews.flatMap((job) => {
      if (job.status !== "completed") return [];
      const result = SessionReviewResultSchema.safeParse(job.result);
      if (!result.success) return [];
      const published = result.data.results.filter(
        (item) =>
          item.status !== "no_change" &&
          item.status !== "stale" &&
          !(item.status === "program_promoted" && item.unchanged),
      );
      const completedAt = job.completedAt ?? job.updatedAt;
      const reactionTurn = userTurns.find((turn) => turn.createdAt > completedAt);
      // A Capability result leads, so a promotion never hides a decision the user must make.
      const first = published.find((item) => "capabilityId" in item) ?? published[0];
      if (!first || !reactionTurn) return [];
      return [
        Object.freeze(
          createConditionalObject({
            jobId: job.jobId,
            stage: "reflection" as const,
            status: first.status,
            // One notice names every change the review made.
            // The review usually covers a session the user has already left.
            summary: `Review of an earlier session · ${[first, ...published.filter((item) => item !== first)]
              .map((item) => ("message" in item ? item.message : result.data.summary))
              .join(" · ")}`,
            updatedAt: job.updatedAt,
            reactionTurnId: reactionTurn.turnId,
          } as const)
            .addOptional("capabilityId" in first ? { capabilityId: first.capabilityId } : undefined)
            .finish(),
        ),
      ];
    }),
  );
}
