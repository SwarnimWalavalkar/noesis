import { createConditionalObject, type DurableJobRecord } from "@noesis/domain";
import type { TuiLearningActivitySummary } from "@noesis/tui";
import { z } from "zod";

const PublicationSchema = z.looseObject({
  status: z.enum([
    "no_change",
    "activated",
    "revised",
    "pending",
    "paused",
    "restored",
    "binding_changed",
    "stale",
  ]),
  message: z.string().optional(),
  capabilityId: z.string().optional(),
});
const SessionReviewResultSchema = z.looseObject({
  status: z.literal("reviewed"),
  summary: z.string(),
  results: z.array(PublicationSchema),
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
      const published = result.data.results.find(
        (item) => item.status !== "no_change" && item.status !== "stale",
      );
      const completedAt = job.completedAt ?? job.updatedAt;
      const reactionTurn = userTurns.find((turn) => turn.createdAt > completedAt);
      if (!published || !reactionTurn) return [];
      return [
        Object.freeze(
          createConditionalObject({
            jobId: job.jobId,
            stage: "reflection" as const,
            status: published.status,
            summary: `Session review · ${published.message ?? result.data.summary}`,
            updatedAt: job.updatedAt,
            reactionTurnId: reactionTurn.turnId,
          } as const)
            .addOptional(published.capabilityId ? { capabilityId: published.capabilityId } : undefined)
            .finish(),
        ),
      ];
    }),
  );
}
