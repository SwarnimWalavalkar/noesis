import {
  type CapabilityRevisionRef,
  CapabilityRevisionRefSchema,
  CapabilitySchema,
  type DatabaseRowRef,
  type DurableJobRecord,
  type EvidenceRef,
  type Experiment,
  type FileRevisionRef,
  type JsonValue,
  type PreflightDecision,
  type PreflightReport,
} from "@noesis/domain";
import { type RetrievalStrategyId, RetrievalStrategyIdSchema } from "@noesis/intelligence";
import { LearningTurnInputSchema } from "@noesis/learning";
import { z } from "zod";

export const CoordinatorJobKindSchema = z.enum([
  "runtime.reflect_turn",
  "runtime.author_revision",
  "runtime.preflight",
]);
export type CoordinatorJobKind = z.infer<typeof CoordinatorJobKindSchema>;

const UserPreferenceSchema = z.strictObject({
  criterionId: z.string().min(1),
  revision: z.number().int().positive(),
  scope: z.string().min(1),
  evaluatorInstruction: z.string().min(1),
});

export const CompletedNormalTurnSchema = z.strictObject({
  turn: LearningTurnInputSchema,
  baselineRevision: CapabilityRevisionRefSchema,
  capability: CapabilitySchema,
  activeCapabilities: z.array(CapabilitySchema).optional(),
  userPreferences: z.array(UserPreferenceSchema).optional(),
  requestedRetrievalStrategy: z.union([RetrievalStrategyIdSchema, z.literal("automatic")]).optional(),
  routingStrategyId: z.string().min(1),
});
export type CompletedNormalTurn = Readonly<z.infer<typeof CompletedNormalTurnSchema>>;

export const ReflectTurnJobPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  turn: LearningTurnInputSchema,
  baselineRevision: CapabilityRevisionRefSchema,
  capability: CapabilitySchema,
  activeCapabilities: z.array(CapabilitySchema).optional(),
  userPreferences: z.array(UserPreferenceSchema).optional(),
  retrievalStrategyId: RetrievalStrategyIdSchema,
  retrievalStrategyReason: z.string().min(1),
  routingStrategyId: z.string().min(1),
});
export type ReflectTurnJobPayload = Readonly<z.infer<typeof ReflectTurnJobPayloadSchema>>;

export const AuthorRevisionJobPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  experimentId: z.string().min(1),
  hypothesisDedupeKey: z.string().min(1),
  retrievalStrategyId: RetrievalStrategyIdSchema,
  routingStrategyId: z.string().min(1),
});
export type AuthorRevisionJobPayload = Readonly<z.infer<typeof AuthorRevisionJobPayloadSchema>>;

export const PreflightJobPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  experimentId: z.string().min(1),
  preflightId: z.string().min(1),
  planId: z.string().min(1),
  retrievalStrategyId: RetrievalStrategyIdSchema,
  routingStrategyId: z.string().min(1),
});
export type PreflightJobPayload = Readonly<z.infer<typeof PreflightJobPayloadSchema>>;

export const RuntimeCoordinatorConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  maxConcurrency: z.number().int().min(1).max(16),
  maxJobsPerDrain: z.number().int().min(1).max(1_000),
  leaseMs: z
    .number()
    .int()
    .min(100)
    .max(10 * 60_000),
  heartbeatMs: z.number().int().min(25).max(60_000),
  retry: z.strictObject({
    maxAttempts: z.number().int().min(1).max(20),
    baseDelayMs: z
      .number()
      .int()
      .nonnegative()
      .max(60 * 60_000),
    maxDelayMs: z
      .number()
      .int()
      .nonnegative()
      .max(24 * 60 * 60_000),
  }),
  drainBudget: z.number().nonnegative(),
  jobs: z.strictObject({
    reflect: z.strictObject({ estimatedCost: z.number().nonnegative(), budget: z.number().nonnegative() }),
    author: z.strictObject({ estimatedCost: z.number().nonnegative(), budget: z.number().nonnegative() }),
    preflight: z.strictObject({ estimatedCost: z.number().nonnegative(), budget: z.number().nonnegative() }),
  }),
});
export type RuntimeCoordinatorConfig = Readonly<z.infer<typeof RuntimeCoordinatorConfigSchema>>;

export const DEFAULT_RUNTIME_COORDINATOR_CONFIG: RuntimeCoordinatorConfig = Object.freeze({
  schemaVersion: 1,
  maxConcurrency: 2,
  maxJobsPerDrain: 24,
  leaseMs: 30_000,
  heartbeatMs: 5_000,
  retry: Object.freeze({ maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 60_000 }),
  drainBudget: 24,
  jobs: Object.freeze({
    reflect: Object.freeze({ estimatedCost: 1, budget: 3 }),
    author: Object.freeze({ estimatedCost: 2, budget: 6 }),
    preflight: Object.freeze({ estimatedCost: 4, budget: 12 }),
  }),
});

export type CoordinatorResearchTelemetry = Readonly<Record<string, JsonValue>>;

export type CoordinatorReflectionResult =
  | {
      readonly status: "no_change";
      readonly reason: string;
      readonly telemetry: CoordinatorResearchTelemetry;
    }
  | {
      readonly status: "experiment";
      readonly experiment: {
        readonly experimentId: string;
        readonly hypothesis: string;
        readonly scope: string;
        readonly evidenceRefs: readonly EvidenceRef[];
        readonly baselineRevision: CapabilityRevisionRef;
        readonly feedbackSignalIds: readonly string[];
        readonly status: "hypothesis";
      };
      readonly hypothesisDedupeKey: string;
      readonly telemetry: CoordinatorResearchTelemetry;
    }
  | {
      readonly status: "deduped";
      readonly experiment: Experiment;
      readonly hypothesisDedupeKey: string;
      readonly telemetry: CoordinatorResearchTelemetry;
    };

export interface CoordinatorCandidateResult {
  readonly experimentId: string;
  readonly candidateRevision: CapabilityRevisionRef;
  readonly manifestRevision: FileRevisionRef;
  readonly telemetry: CoordinatorResearchTelemetry;
}

export interface CoordinatorPreflightResult {
  readonly experimentId: string;
  readonly candidateRevision: CapabilityRevisionRef;
  readonly reportRef: DatabaseRowRef<"preflight_reports">;
  readonly decision: PreflightDecision;
  readonly telemetry: CoordinatorResearchTelemetry;
}

export interface RuntimeCoordinatorResearchPort {
  readonly reflect: (
    payload: ReflectTurnJobPayload,
    signal: AbortSignal,
  ) => Promise<CoordinatorReflectionResult>;
  readonly author: (
    payload: AuthorRevisionJobPayload,
    signal: AbortSignal,
  ) => Promise<CoordinatorCandidateResult>;
  readonly rehydrateCandidate: (experimentId: string) => Promise<CoordinatorCandidateResult | undefined>;
  readonly preflight: (
    payload: PreflightJobPayload,
    signal: AbortSignal,
  ) => Promise<CoordinatorPreflightResult>;
}

export interface CoordinatorFailureOptions {
  readonly code: string;
  readonly retryable: boolean;
  readonly ambiguous?: boolean;
  readonly cause?: unknown;
}

export function coordinatorOperationError(message: string, options: CoordinatorFailureOptions): Error {
  const error = new Error(message, options.cause === undefined ? undefined : { cause: options.cause });
  Reflect.set(error, "coordinatorCode", options.code);
  Reflect.set(error, "coordinatorRetryable", options.retryable);
  Reflect.set(error, "coordinatorAmbiguous", options.ambiguous ?? false);
  return error;
}

export interface CoordinatorJobView {
  readonly job: DurableJobRecord;
  readonly kind: CoordinatorJobKind;
  readonly payload: ReflectTurnJobPayload | AuthorRevisionJobPayload | PreflightJobPayload;
}

export interface PreflightActivationHandoff {
  readonly experiment: Experiment & { readonly status: "preflight" };
  readonly candidateRevision: CapabilityRevisionRef;
  readonly manifestRevision: FileRevisionRef;
  readonly reportRef: DatabaseRowRef<"preflight_reports">;
  readonly report: PreflightReport;
}

export function coordinatorJobPayload(job: DurableJobRecord): CoordinatorJobView {
  const kind = CoordinatorJobKindSchema.parse(job.kind);
  const payload =
    kind === "runtime.reflect_turn"
      ? ReflectTurnJobPayloadSchema.parse(job.payload)
      : kind === "runtime.author_revision"
        ? AuthorRevisionJobPayloadSchema.parse(job.payload)
        : PreflightJobPayloadSchema.parse(job.payload);
  return Object.freeze({ job, kind, payload });
}

export function retrievalStrategyForTurn(input: CompletedNormalTurn): {
  readonly requested?: RetrievalStrategyId | "automatic";
} {
  return input.requestedRetrievalStrategy === undefined
    ? Object.freeze({})
    : Object.freeze({ requested: input.requestedRetrievalStrategy });
}
