import {
  EvidenceRefSchema,
  FileRevisionRefSchema,
  type EvidenceRef,
  type ExperimentVariantRef,
  type FileRevisionRef,
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

export const AutomaticLearningConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  enabled: z.boolean(),
  notifications: z.enum(["off", "quiet", "detailed"]),
  retrieval: z.strictObject({
    maxResults: z.number().int().min(1).max(20),
    lexicalLimit: z.number().int().min(0).max(100),
    semanticLimit: z.number().int().min(0).max(100),
    maxExcerptChars: z.number().int().min(32).max(4_000),
    recurrenceThreshold: z.number().int().min(1).max(20),
  }),
  roles: z.strictObject({
    reflector: LearningRoleConfigurationSchema,
    revisionAuthor: LearningRoleConfigurationSchema,
    revisionAgent: LearningRoleConfigurationSchema,
  }),
});
export type AutomaticLearningConfig = Readonly<z.infer<typeof AutomaticLearningConfigSchema>>;

export const LearningTurnInputSchema = z.strictObject({
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  scope: z.string().min(1),
  userMessage: z.string().min(1),
  assistantMessage: z.string().optional(),
  correction: z.string().min(1).optional(),
  outcome: z.enum(["accepted", "corrected", "failed", "unknown"]),
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

export const ReflectorOutputSchema = z.discriminatedUnion("decision", [
  z.strictObject({
    decision: z.literal("no_change"),
    reason: z.string().min(1),
  }),
  z.strictObject({
    decision: z.literal("experiment"),
    title: z.string().min(1),
    hypothesis: z.string().min(1),
    scope: z.string().min(1),
    capabilityName: z.string().min(1),
    capabilityIntent: z.string().min(1),
    sourceCases: z
      .array(
        z.strictObject({
          title: z.string().min(1),
          input: z.string().min(1),
          expectedBehavior: z.string().min(1),
        }),
      )
      .min(1)
      .max(12),
  }),
]);
export type ReflectorOutput = Readonly<z.infer<typeof ReflectorOutputSchema>>;

const CandidateFileSchema = z.strictObject({
  path: z.string().min(1),
  content: z.string().min(1),
});

export const RevisionAuthorOutputSchema = z.strictObject({
  promptModules: z.array(CandidateFileSchema).min(1).max(8),
  skills: z.array(CandidateFileSchema).min(1).max(8),
  tools: z.array(CandidateFileSchema).min(1).max(8),
  router: z.strictObject({
    path: z.string().min(1),
    content: z.string().min(1),
    strategyId: z.string().min(1),
  }),
  activationPolicy: z.strictObject({
    mode: z.enum(["automatic_low_risk", "approval_required"]),
    scope: z.string().min(1),
  }),
  dependencyLock: CandidateFileSchema.optional(),
  permissionManifest: z.strictObject({
    effects: z.array(z.string()),
    resourcePatterns: z.array(z.string()),
    credentialRefs: z.array(z.string()),
  }),
  sourceEvaluationDefinitions: z.array(CandidateFileSchema).min(1).max(12),
  requestedPermissionDelta: z.strictObject({
    addedEffects: z.array(z.string()),
    widenedResources: z.array(z.string()),
    addedCredentialRefs: z.array(z.string()),
  }),
});
export type RevisionAuthorOutput = Readonly<z.infer<typeof RevisionAuthorOutputSchema>>;

export interface LearningCitation {
  readonly source:
    | {
        readonly kind: "database_row";
        readonly table: "sessions" | "messages" | "tool_calls" | "outcomes";
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
