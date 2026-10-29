import { createConditionalObject, type DurableJobRecord } from "@noesis/domain";
import type { TuiLearningActivitySummary } from "@noesis/tui";
import { CapabilityPublicationResultSchema } from "@noesis/learning";
import { z } from "zod";

const SessionReviewResultSchema = z.looseObject({
  status: z.literal("reviewed"),
  summary: z.string(),
  results: z.array(CapabilityPublicationResultSchema),
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
        (item) => item.status !== "no_change" && item.status !== "stale",
      );
      const completedAt = job.completedAt ?? job.updatedAt;
      const reactionTurn = userTurns.find((turn) => turn.createdAt > completedAt);
      const first = published[0];
      if (!first || !reactionTurn) return [];
      return [
        Object.freeze(
          createConditionalObject({
            jobId: job.jobId,
            stage: "reflection" as const,
            status: first.status,
            // One notice names every change the review made.
            summary: `Session review · ${published
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
