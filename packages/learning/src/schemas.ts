import {
  canonicalJson,
  type EvidenceRef,
  EvidenceRefSchema,
  type ExperimentVariantRef,
  type FileRevisionRef,
  FileRevisionRefSchema,
  ProjectRefSchema,
  WORKING_ADJUSTMENT_LIMITS,
} from "@noesis/domain";
import { z } from "zod";

const ReasoningLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const ExperimentVariantRefSchema: z.ZodType<ExperimentVariantRef> = z.strictObject({
  variantId: z.string().min(1),
  axis: z.literal("role"),
  configurationRefs: z.array(FileRevisionRefSchema),
});

export const LearningRoleConfigurationSchema = z.strictObject({
  variant: ExperimentVariantRefSchema,
  promptRevision: FileRevisionRefSchema,
  model: z.string().min(1),
  reasoning: ReasoningLevelSchema,
});
export type LearningRoleConfiguration = Readonly<z.infer<typeof LearningRoleConfigurationSchema>>;

const SERVED_WORKING_ADJUSTMENT_SUMMARY_CHARS = 512;
const SERVED_WORKING_ADJUSTMENT_TOTAL_SUMMARY_CHARS = 2_048;
const SERVED_WORKING_ADJUSTMENT_OUTCOMES = 8;

const BoundedWorkingAdjustmentEvidenceRefsSchema = z
  .array(EvidenceRefSchema)
  .min(1)
  .transform((references) =>
    Object.freeze(
      [
        ...new Map(
          references.map((reference) => [canonicalJson(reference), Object.freeze({ ...reference })]),
        ).values(),
      ].slice(0, WORKING_ADJUSTMENT_LIMITS.evidenceRefs),
    ),
  );

export const WorkingAdjustmentOutcomeEvidenceSchema = z.strictObject({
  adjustmentId: z.string().min(1),
  planId: z.string().min(1),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  outcomeId: z.string().min(1),
  outcome: z.enum(["accepted", "corrected", "failed", "unknown"]),
  summary: z.string().transform((summary) => summary.slice(0, SERVED_WORKING_ADJUSTMENT_SUMMARY_CHARS)),
  settledAt: z.string().datetime(),
  evidenceRefs: BoundedWorkingAdjustmentEvidenceRefsSchema,
});
export type WorkingAdjustmentOutcomeEvidence = Readonly<
  z.infer<typeof WorkingAdjustmentOutcomeEvidenceSchema>
>;

/**
 * Runtime facts about how a turn ended. `failed_before_output` means the turn failed before the
 * model produced any message or tool call, e.g. a provider rejected the request.
 */
export const TurnEndCauseSchema = z.enum([
  "completed",
  "user_aborted",
  "failed_before_output",
  "failed_after_output",
]);
export type TurnEndCause = z.infer<typeof TurnEndCauseSchema>;

export const LearningTurnInputSchema = z.strictObject({
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  outcomeId: z.string().min(1).optional(),
  // Optional only so durable pre-feature reflection jobs remain decodable after upgrade. New
  // foreground settlement always supplies both fields; adjustment decisions require them.
  project: ProjectRefSchema.optional(),
  expectedActiveAdjustmentId: z.string().min(1).nullable().optional(),
  servedWorkingAdjustmentOutcomes: z
    .array(WorkingAdjustmentOutcomeEvidenceSchema)
    .max(SERVED_WORKING_ADJUSTMENT_OUTCOMES)
    .default([])
    .transform((outcomes) => {
      let remainingSummaryChars = SERVED_WORKING_ADJUSTMENT_TOTAL_SUMMARY_CHARS;
      let remainingEvidenceRefs = WORKING_ADJUSTMENT_LIMITS.evidenceRefs;
      const seenEvidence = new Set<string>();
      return Object.freeze(
        outcomes.flatMap((outcome) => {
          const summary = outcome.summary.slice(0, remainingSummaryChars);
          remainingSummaryChars -= summary.length;
          const evidenceRefs = outcome.evidenceRefs.filter((reference) => {
            const key = canonicalJson(reference);
            if (seenEvidence.has(key) || remainingEvidenceRefs <= 0) return false;
            seenEvidence.add(key);
            remainingEvidenceRefs -= 1;
            return true;
          });
          if (evidenceRefs.length === 0) return [];
          return [
            Object.freeze({
              ...outcome,
              summary,
              evidenceRefs: Object.freeze(evidenceRefs),
            }),
          ];
        }),
      );
    }),
  scope: z.string().min(1),
  userMessage: z.string().min(1),
  assistantMessage: z.string().optional(),
  correction: z.string().min(1).optional(),
  outcome: z.enum(["accepted", "corrected", "failed", "unknown"]),
  /**
   * How the turn ended, recorded by settlement as a runtime fact. Optional so jobs queued before
   * this field existed still decode.
   */
  cause: TurnEndCauseSchema.optional(),
  occurredAt: z.string().datetime(),
  evidenceRefs: z.array(EvidenceRefSchema).min(1),
  sensitivity: z.enum(["normal", "private", "secret"]).default("normal"),
  telemetry: z
    .strictObject({
      retryCount: z.number().int().nonnegative().default(0),
      toolFailureCount: z.number().int().nonnegative().default(0),
      aborted: z.boolean().default(false),
      latencyMs: z.number().nonnegative().optional(),
      expectedLatencyMs: z.number().positive().optional(),
    })
    .default({ retryCount: 0, toolFailureCount: 0, aborted: false }),
});
export type LearningTurnInput = Readonly<z.infer<typeof LearningTurnInputSchema>>;

export const SemanticTurnObservationSchema = z.strictObject({
  kind: z
    .enum(["correction", "preference", "other"])
    .describe(
      "Whether the current user turn semantically corrects prior behavior, expresses a reusable preference, or is neither",
    ),
  reason: z
    .string()
    .min(1)
    .max(WORKING_ADJUSTMENT_LIMITS.observationChars)
    .describe("Brief evidence-grounded reason for the classification"),
});
export type SemanticTurnObservation = Readonly<z.infer<typeof SemanticTurnObservationSchema>>;

export interface LearningCitation {
  readonly source:
    | {
        readonly kind: "database_row";
        readonly table: "sessions" | "messages" | "tool_calls" | "outcomes" | "experiments";
        readonly rowId: string;
        readonly field: string;
      }
    | {
        readonly kind: "file_revision";
        readonly revisionId: string;
        readonly field: "bytes";
      };
  readonly occurredAt: string;
  readonly excerpt: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly contentDigest: string;
}

export interface LearningSourceCase {
  readonly caseId: string;
  readonly title: string;
  readonly scope: string;
  readonly input: string;
  readonly expectedBehavior: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly citations: readonly LearningCitation[];
}

export interface RoleResearchMetadata {
  readonly promptRevision: FileRevisionRef;
  readonly model: string;
  readonly reasoning: LearningRoleConfiguration["reasoning"];
}
