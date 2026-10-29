import {
  EvidenceRefSchema,
  type ExperimentVariantRef,
  FileRevisionRefSchema,
  ProjectRefSchema,
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
  // Optional only so durable pre-feature reflection jobs remain decodable after upgrade.
  project: ProjectRefSchema.optional(),
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
