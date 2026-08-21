import {
  createConditionalObject,
  FeedbackSignalSchema,
  canonicalJson,
  sameCapabilityRevisionRef,
  sha256,
  toJsonValue,
  type CapabilityRevision,
  type CapabilityRevisionRef,
  type DatabaseRowRef,
  type DurableJobRecord,
  type EvidenceRef,
  type Experiment,
  type ExperimentOutcome,
  type FeedbackSignal,
  type LearningSignalKind,
} from "@noesis/domain";
import type {
  ClassifyExperimentObservationsRequest,
  CommitExperimentOutcomeRequest,
  ExperimentObservationRecord,
  ExperimentObservationClassificationResult,
  ExperimentOutcomeOperationRecord,
  ExperimentResearchRunRecord,
  NoesisWorkspaceStore,
  ObservationMetrics,
  OutcomeRecord,
} from "@noesis/workspace";
import type { AuthorityBoundary } from "@noesis/policy";
import type { ProtectedWorkspaceRuntime } from "../../workspace/src/protected-runtime.ts";
import { authorizeScheduledJob, runScheduledJob } from "./scheduled-execution.ts";
import { z } from "zod";
const OutcomeStatusSchema = z.enum(["accepted", "corrected", "failed", "unknown"]);
const SignalKindSchema = z.enum([
  "turn_observation",
  "explicit_correction",
  "preference_expression",
  "recurring_workflow",
  "repeated_failure",
  "surprising_success",
  "friction",
  "capability_gap",
  "cost_or_latency",
  "user_request",
]);
const OutcomeDecisionSchema = z.enum(["keep", "revise", "revert"]);
const OutcomeProposalSchema = z.strictObject({
  proposal: OutcomeDecisionSchema,
  citedObservationIds: z.array(z.string().min(1)).min(1),
  summary: z.string().min(1),
});
const OutcomeJudgeJobPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  experimentId: z.string().min(1),
  strategyId: z.string().min(1),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  runId: z.string().min(1),
});
const OUTCOME_JOB_KIND = "runtime.outcome_judge";
const OUTCOME_JOB_LEASE_MS = 30000;
const OUTCOME_JOB_HEARTBEAT_MS = 5000;
const MetricsSchema = z.strictObject({
  quality: z.number().min(0).max(1).nullable().default(null),
  baselineQuality: z.number().min(0).max(1).nullable().default(null),
  latencyMs: z.number().nonnegative().nullable().default(null),
  baselineLatencyMs: z.number().nonnegative().nullable().default(null),
  cost: z.number().nonnegative().nullable().default(null),
  baselineCost: z.number().nonnegative().nullable().default(null),
  failed: z.boolean().default(false),
  protectedRailViolation: z.boolean().default(false),
});
export const ContinuousFeedbackConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  observationWindow: z.number().int().min(1).max(1000),
  minimumEvidence: z.number().int().min(1).max(1000),
  researchStrategyId: z.string().min(1),
  hardRegression: z.strictObject({
    qualityDrop: z.number().min(0).max(1),
    latencyMultiplier: z.number().min(1),
    costMultiplier: z.number().min(1),
    failedOutcome: z.boolean(),
  }),
});
export type ContinuousFeedbackConfig = Readonly<z.infer<typeof ContinuousFeedbackConfigSchema>>;
export const DEFAULT_CONTINUOUS_FEEDBACK_CONFIG: ContinuousFeedbackConfig = Object.freeze({
  schemaVersion: 1,
  observationWindow: 32,
  minimumEvidence: 3,
  researchStrategyId: "bounded-single-judge-v1",
  hardRegression: Object.freeze({
    qualityDrop: 0.35,
    latencyMultiplier: 3,
    costMultiplier: 3,
    failedOutcome: true,
  }),
});
const TurnOutcomeInputSchema = z.strictObject({
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  outcomeId: z.string().min(1).optional(),
  status: OutcomeStatusSchema,
  summary: z.string().min(1),
  sensitivity: z.enum(["normal", "private", "secret"]),
  usedCapabilityIds: z.array(z.string().min(1)).min(1),
  evidenceRefs: z.array(z.unknown()),
  signal: z
    .strictObject({
      kind: SignalKindSchema.optional(),
      scope: z.string().min(1),
      strength: z.number().min(0).max(1),
      novelty: z.number().min(0).max(1),
      explicitPreference: z.boolean().optional(),
      userDecision: OutcomeDecisionSchema.optional(),
    })
    .optional(),
  metrics: MetricsSchema.optional(),
});
export interface TurnOutcomeObservationInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly outcomeId?: string;
  readonly status: OutcomeRecord["status"];
  readonly summary: string;
  readonly sensitivity: OutcomeRecord["sensitivity"];
  readonly usedCapabilityIds: readonly string[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly signal?: {
    readonly kind?: LearningSignalKind;
    readonly scope: string;
    readonly strength: number;
    readonly novelty: number;
    readonly explicitPreference?: boolean;
    readonly userDecision?: ExperimentOutcome;
  };
  readonly metrics?: Partial<ObservationMetrics>;
}
export interface ExperimentOutcomeProposal {
  readonly proposal: ExperimentOutcome;
  readonly citedObservationIds: readonly string[];
  readonly summary: string;
}
export interface ExperimentOutcomeJudge {
  readonly run: (
    input: {
      readonly strategyId: string;
      readonly experiment: {
        readonly experimentId: string;
        readonly hypothesis: string;
        readonly scope: string;
        readonly baselineRevision: CapabilityRevisionRef;
        readonly activatedRevision: CapabilityRevisionRef;
      };
      readonly comparison: ExperimentComparisonReadModel;
    },
    execution?: {
      readonly operationId: string;
      readonly signal: AbortSignal;
    },
  ) => Promise<ExperimentOutcomeProposal>;
  readonly rehydrate?: (operationId: string) => Promise<ExperimentOutcomeProposal | undefined>;
}
export interface FeedbackCapabilityResolver {
  readonly resolve: (reference: CapabilityRevisionRef) => Promise<CapabilityRevision | undefined>;
}
export interface MetricSummary {
  readonly count: number;
  readonly accepted: number;
  readonly corrected: number;
  readonly failed: number;
  readonly averageQuality: number | null;
  readonly averageLatencyMs: number | null;
  readonly averageCost: number | null;
}
export interface ExperimentComparisonReadModel {
  readonly experimentId: string;
  readonly status: Experiment["status"];
  readonly hypothesis: string;
  readonly baselineRevision: CapabilityRevisionRef;
  readonly activatedRevision: CapabilityRevisionRef | null;
  readonly preflight: {
    readonly preflightId: string;
    readonly winner: "baseline" | "candidate" | "tie" | "inconclusive";
    readonly confidence: number;
    readonly summary: string;
    readonly baselineTrials: number;
    readonly baselineFailures: number;
    readonly candidateTrials: number;
    readonly candidateFailures: number;
  } | null;
  readonly observations: readonly ExperimentObservationRecord[];
  readonly liveMetrics: MetricSummary;
  readonly researchRuns: readonly ExperimentResearchRunRecord[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly outcome: ExperimentOutcomeOperationRecord | null;
}
export interface CapabilityHealthReadModel {
  readonly capabilityId: string;
  readonly activeRevision: CapabilityRevisionRef | null;
  readonly activationId: string | null;
  readonly activationRevision: number;
  readonly status: "unavailable" | "healthy" | "observing" | "degraded" | "reverted";
  readonly openExperiments: readonly ExperimentComparisonReadModel[];
  readonly latestOutcome: ExperimentOutcomeOperationRecord | null;
  readonly evidenceRefs: readonly EvidenceRef[];
}
export type ObservationResolution =
  | {
      readonly status: "excluded";
      readonly reason: string;
    }
  | {
      readonly status: "observing";
      readonly experimentId: string;
      readonly observationId: string;
    }
  | {
      readonly status: "research_failed";
      readonly experimentId: string;
      readonly observationId: string;
      readonly run: ExperimentResearchRunRecord;
    }
  | {
      readonly status: "resolved";
      readonly experimentId: string;
      readonly observationId: string;
      readonly outcome: ExperimentOutcomeOperationRecord;
    };
export interface ContinuousFeedbackController {
  readonly observeTurnOutcome: (
    input: TurnOutcomeObservationInput,
  ) => Promise<readonly ObservationResolution[]>;
  readonly classifyTurnObservations: (
    input: ClassifyExperimentObservationsRequest,
  ) => Promise<ExperimentObservationClassificationResult>;
  readonly evaluateExperiment: (
    experimentId: string,
    strategyId?: string,
  ) => Promise<ObservationResolution | undefined>;
  readonly experimentComparison: (experimentId: string) => Promise<ExperimentComparisonReadModel>;
  readonly capabilityHealth: (capabilityId: string) => Promise<CapabilityHealthReadModel>;
  readonly runAvailable: () => Promise<void>;
  readonly cancel: (jobId: string) => Promise<DurableJobRecord | undefined>;
  readonly stop: () => Promise<void>;
}
export interface ContinuousFeedbackControllerOptions {
  readonly workspace: NoesisWorkspaceStore;
  readonly protectedRuntime: ProtectedWorkspaceRuntime;
  readonly authority: AuthorityBoundary;
  readonly capabilities: FeedbackCapabilityResolver;
  readonly judge: ExperimentOutcomeJudge;
  readonly config?: ContinuousFeedbackConfig;
  readonly workerId?: string;
  readonly now?: () => Date;
}
function databaseRef<Table extends DatabaseRowRef["table"]>(
  table: Table,
  rowId: string,
): DatabaseRowRef<Table> {
  return Object.freeze({ kind: "database_row", table, rowId });
}
function signalKind(input: z.infer<typeof TurnOutcomeInputSchema>): LearningSignalKind {
  if (input.signal?.kind) return input.signal.kind;
  if (input.status === "corrected") return "explicit_correction";
  if (input.status === "failed") return "repeated_failure";
  return "turn_observation";
}
function numericAverage(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : present.reduce((sum, value) => sum + value, 0) / present.length;
}
function metricsSummary(observations: readonly ExperimentObservationRecord[]): MetricSummary {
  return Object.freeze({
    count: observations.length,
    accepted: observations.filter((item) => !item.metrics.failed && item.precedence === "none").length,
    corrected: observations.filter((item) => item.precedence === "correction").length,
    failed: observations.filter((item) => item.metrics.failed).length,
    averageQuality: numericAverage(observations.map((item) => item.metrics.quality)),
    averageLatencyMs: numericAverage(observations.map((item) => item.metrics.latencyMs)),
    averageCost: numericAverage(observations.map((item) => item.metrics.cost)),
  });
}
function hardRegression(metrics: ObservationMetrics, config: ContinuousFeedbackConfig): boolean {
  if (metrics.protectedRailViolation || (config.hardRegression.failedOutcome && metrics.failed)) return true;
  if (
    metrics.quality !== null &&
    metrics.baselineQuality !== null &&
    metrics.baselineQuality - metrics.quality >= config.hardRegression.qualityDrop
  )
    return true;
  if (
    metrics.latencyMs !== null &&
    metrics.baselineLatencyMs !== null &&
    metrics.baselineLatencyMs > 0 &&
    metrics.latencyMs / metrics.baselineLatencyMs >= config.hardRegression.latencyMultiplier
  )
    return true;
  return (
    metrics.cost !== null &&
    metrics.baselineCost !== null &&
    metrics.baselineCost > 0 &&
    metrics.cost / metrics.baselineCost >= config.hardRegression.costMultiplier
  );
}
function manifestSubset(restored: CapabilityRevision, current: CapabilityRevision): boolean {
  const contains = (haystack: readonly string[], needles: readonly string[]) =>
    needles.every((value) => haystack.includes(value));
  return (
    contains(current.permissionManifest.effects, restored.permissionManifest.effects) &&
    contains(current.permissionManifest.resourcePatterns, restored.permissionManifest.resourcePatterns) &&
    contains(current.permissionManifest.credentialRefs, restored.permissionManifest.credentialRefs)
  );
}
function evidenceForObservations(
  observations: readonly ExperimentObservationRecord[],
): readonly EvidenceRef[] {
  return Object.freeze(
    observations.flatMap((observation) => [
      databaseRef("experiment_observations", observation.observationId),
      ...observation.evidenceRefs,
    ]),
  );
}
function outcomeResearchInputDigest(comparison: ExperimentComparisonReadModel): string {
  return sha256(
    canonicalJson({
      experimentId: comparison.experimentId,
      status: comparison.status,
      hypothesis: comparison.hypothesis,
      baselineRevision: comparison.baselineRevision,
      activatedRevision: comparison.activatedRevision,
      preflight: comparison.preflight,
      observations: comparison.observations,
      liveMetrics: comparison.liveMetrics,
      evidenceRefs: comparison.evidenceRefs,
    }),
  );
}
export function createContinuousFeedbackController(
  options: ContinuousFeedbackControllerOptions,
): ContinuousFeedbackController {
  const config = ContinuousFeedbackConfigSchema.parse(options.config ?? DEFAULT_CONTINUOUS_FEEDBACK_CONFIG);
  const now = options.now ?? (() => new Date());
  const workerId = options.workerId ?? `runtime-feedback:${process.pid}`;
  const active = new Map<string, AbortController>();
  const heartbeats = new Map<string, NodeJS.Timeout>();
  let draining: Promise<void> | undefined;
  let stopping = false;
  const clearHeartbeat = (jobId: string): void => {
    const heartbeat = heartbeats.get(jobId);
    if (!heartbeat) return;
    clearInterval(heartbeat);
    heartbeats.delete(jobId);
  };
  const isoNow = (): string => now().toISOString();
  const validateProposal = (
    proposed: ExperimentOutcomeProposal,
    observations: readonly ExperimentObservationRecord[],
  ): ExperimentOutcomeProposal => {
    const proposal = OutcomeDecisionSchema.parse(proposed.proposal);
    const available = new Set(observations.map((observation) => observation.observationId));
    const citations = Object.freeze([...new Set(proposed.citedObservationIds)]);
    if (citations.length === 0 || citations.some((id) => !available.has(id)))
      throw new Error("Outcome judge must cite observations from its bounded input");
    const correctionPrecedence = observations.some(
      (observation) => observation.precedence === "correction" || observation.precedence === "preference",
    );
    return Object.freeze({
      proposal: proposal === "keep" && correctionPrecedence ? "revise" : proposal,
      citedObservationIds: citations,
      summary: proposed.summary,
    });
  };
  const experimentComparison = async (experimentId: string): Promise<ExperimentComparisonReadModel> => {
    const experiment = await options.workspace.research.experiments.getExperiment(experimentId);
    if (!experiment) throw new Error(`Experiment ${experimentId} is missing`);
    const observations = await options.protectedRuntime.feedback.listObservations(
      experimentId,
      config.observationWindow,
    );
    const report = experiment.preflightRef
      ? await options.workspace.research.preflights.getPreflightReport(experiment.preflightRef.rowId)
      : undefined;
    const trials = await options.workspace.research.trials.listTrials(experimentId);
    const baselineTrials = trials.filter((trial) => trial.arm === "baseline");
    const candidateTrials = trials.filter((trial) => trial.arm === "candidate");
    const outcome = await options.protectedRuntime.feedback.getOutcome(experimentId);
    const researchRuns = await options.protectedRuntime.feedback.listResearchRuns(experimentId);
    return Object.freeze({
      experimentId,
      status: experiment.status,
      hypothesis: experiment.hypothesis,
      baselineRevision: experiment.baselineRevision,
      activatedRevision: experiment.activatedRevision ?? null,
      preflight: report
        ? Object.freeze({
            preflightId: report.preflightId,
            winner: report.comparison.winner,
            confidence: report.comparison.confidence,
            summary: report.comparison.summary,
            baselineTrials: baselineTrials.length,
            baselineFailures: baselineTrials.filter((trial) => trial.status === "failed").length,
            candidateTrials: candidateTrials.length,
            candidateFailures: candidateTrials.filter((trial) => trial.status === "failed").length,
          })
        : null,
      observations,
      liveMetrics: metricsSummary(observations),
      researchRuns,
      evidenceRefs: Object.freeze([
        ...experiment.evidenceRefs,
        ...(experiment.preflightRef ? [experiment.preflightRef] : []),
        ...evidenceForObservations(observations),
      ]),
      outcome: outcome ?? null,
    });
  };
  const commitDecision = async (input: {
    readonly experiment: Experiment;
    readonly decision: ExperimentOutcome;
    readonly strategyId: string;
    readonly observations: readonly ExperimentObservationRecord[];
    readonly researchRunId?: string;
  }): Promise<ExperimentOutcomeOperationRecord> => {
    const existing = await options.protectedRuntime.feedback.getOutcome(input.experiment.experimentId);
    if (existing) return existing;
    if (input.experiment.status !== "observing" || !input.experiment.activatedRevision)
      throw new Error("Observing experiment has no activated revision identity");
    const activatedRevision = input.experiment.activatedRevision;
    const current = await options.protectedRuntime.activations.current();
    if (!current) throw new Error("No current activation exists for experiment outcome");
    if (
      input.observations.some(
        (observation) => !sameCapabilityRevisionRef(observation.capabilityRevision, activatedRevision),
      )
    )
      throw new Error("Experiment outcome contains evidence from an incompatible capability revision");
    const currentRevision = current.activeCapabilityRevisions[activatedRevision.capabilityId];
    if (
      !currentRevision ||
      currentRevision.kind !== "capability_revision" ||
      !sameCapabilityRevisionRef(currentRevision, activatedRevision)
    )
      throw new Error("Experiment outcome is stale relative to the current activation");
    const operationId = `experiment_outcome_${sha256(`${input.experiment.experimentId}:${input.decision}`).slice(0, 32)}`;
    const evidenceRefs = evidenceForObservations(input.observations);
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    const baseRequest = createConditionalObject({
      operationId,
      idempotencyKey: `resolve:${input.experiment.experimentId}:${input.decision}`,
      experimentId: input.experiment.experimentId,
      decision: input.decision,
      strategyId: input.strategyId,
    } as const)
      .addOptional(input.researchRunId ? { researchRunId: input.researchRunId } : undefined)
      .add({
        expectedActivationId: current.activationId,
        expectedActivationRevision: current.revision,
        evidenceRefs,
      } as const)
      .finish();
    let protectedAction: CommitExperimentOutcomeRequest;
    if (input.decision === "revert") {
      const origin = (await options.protectedRuntime.activations.listOperations(1000)).find(
        (operation) => operation.binding.experimentId === input.experiment.experimentId,
      );
      if (!origin || origin.status !== "committed" || !origin.previousActivationId)
        throw new Error("Revert has no materialized prior AC-09 activation snapshot");
      const [candidate, baseline] = await Promise.all([
        options.capabilities.resolve(input.experiment.activatedRevision),
        options.capabilities.resolve(input.experiment.baselineRevision),
      ]);
      if (!candidate || !baseline || !manifestSubset(baseline, candidate))
        throw new Error("Revert cannot prove that the prior revision preserves or narrows permissions");
      const restore = Object.freeze({
        sourceActivationId: origin.previousActivationId,
        currentPermissionManifest: candidate.permissionManifest,
        restoredPermissionManifest: baseline.permissionManifest,
      });
      const digestInput = {
        ...baseRequest,
        researchRunId: input.researchRunId ?? null,
        restore,
        successor: null,
      };
      protectedAction = Object.freeze({
        ...baseRequest,
        restore,
        operationDigest: sha256(canonicalJson(digestInput)),
      });
    } else if (input.decision === "revise") {
      const successorExperimentId = `experiment_${sha256(`${input.experiment.experimentId}:successor`).slice(0, 32)}`;
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      const successor = Object.freeze({
        experimentId: successorExperimentId,
        hypothesis: `Revise after real-use outcome for ${input.experiment.hypothesis}`,
        scope: input.experiment.scope,
        evidenceRefs,
        baselineRevision: input.experiment.activatedRevision,
        candidateRevisions: Object.freeze([]),
        feedbackSignalIds: Object.freeze(input.observations.map((item) => item.signalId)),
        status: "hypothesis" as const,
      });
      const lineage = Object.freeze({
        inputId: `successor_input_${sha256(input.experiment.experimentId).slice(0, 32)}`,
        predecessorExperimentId: input.experiment.experimentId,
        successorExperimentId,
        predecessorActivationId: current.activationId,
        predecessorRevision: input.experiment.activatedRevision,
        baselineRevision: input.experiment.baselineRevision,
        evidenceRefs,
      });
      const successorInput = Object.freeze({ experiment: successor, lineage });
      const digestInput = {
        ...baseRequest,
        researchRunId: input.researchRunId ?? null,
        restore: null,
        successor: successorInput,
      };
      protectedAction = Object.freeze({
        ...baseRequest,
        successor: successorInput,
        operationDigest: sha256(canonicalJson(digestInput)),
      });
    } else {
      const digestInput = {
        ...baseRequest,
        researchRunId: input.researchRunId ?? null,
        restore: null,
        successor: null,
      };
      protectedAction = Object.freeze({
        ...baseRequest,
        operationDigest: sha256(canonicalJson(digestInput)),
      });
    }
    await options.protectedRuntime.feedback.commitOutcome(protectedAction);
    const committed = await options.protectedRuntime.feedback.getOutcome(input.experiment.experimentId);
    if (committed) return committed;
    throw new Error("Protected experiment outcome completed without a committed operation");
  };
  const executeOutcomeJob = async (job: DurableJobRecord): Promise<void> => {
    const leaseToken = job.leaseToken;
    if (!leaseToken) throw new Error(`Claimed outcome job ${job.jobId} has no lease token`);
    const payload = OutcomeJudgeJobPayloadSchema.parse(job.payload);
    const controller = new AbortController();
    active.set(job.jobId, controller);
    const heartbeat = setInterval(() => {
      void options.workspace.jobs
        .renew({
          jobId: job.jobId,
          leaseToken,
          now: isoNow(),
          leaseUntil: new Date(now().getTime() + OUTCOME_JOB_LEASE_MS).toISOString(),
        })
        .then((renewed) => {
          if (!renewed) controller.abort("lease_lost");
        })
        .catch(() => controller.abort("lease_renewal_failed"));
    }, OUTCOME_JOB_HEARTBEAT_MS);
    heartbeat.unref?.();
    heartbeats.set(job.jobId, heartbeat);
    try {
      const experiment = await options.workspace.research.experiments.getExperiment(payload.experimentId);
      if (!experiment || experiment.status !== "observing" || !experiment.activatedRevision)
        throw new Error(`Outcome job experiment ${payload.experimentId} is no longer observing`);
      const observations = await options.protectedRuntime.feedback.listObservations(
        payload.experimentId,
        config.observationWindow,
      );
      const comparison = await experimentComparison(payload.experimentId);
      if (outcomeResearchInputDigest(comparison) !== payload.inputDigest)
        throw new Error("Outcome job input changed before its leased execution");
      const input = Object.freeze({
        strategyId: payload.strategyId,
        experiment: Object.freeze({
          experimentId: payload.experimentId,
          hypothesis: experiment.hypothesis,
          scope: experiment.scope,
          baselineRevision: experiment.baselineRevision,
          activatedRevision: experiment.activatedRevision,
        }),
        comparison,
      });
      const prior = await options.protectedRuntime.feedback.getResearchRun(payload.runId);
      if (prior?.status === "completed") {
        await options.workspace.jobs.complete({
          jobId: job.jobId,
          leaseToken,
          now: isoNow(),
          result: Object.freeze({ runId: prior.runId, recovered: true }),
        });
        return;
      }
      if (prior?.status !== "running") {
        await options.protectedRuntime.feedback.putResearchRun({
          runId: payload.runId,
          experimentId: payload.experimentId,
          strategyId: payload.strategyId,
          inputDigest: payload.inputDigest,
          status: "running",
          citedObservationIds: Object.freeze([]),
          evidenceRefs: Object.freeze([]),
          attempt: job.attempt,
          retryable: false,
        });
      }
      const scheduled = await runScheduledJob(
        options.authority,
        job,
        sha256(canonicalJson({ operationId: job.operationId, kind: job.kind, payload: job.payload })),
        async () =>
          toJsonValue(
            await options.judge.run(input, {
              operationId: job.operationId,
              signal: controller.signal,
            }),
          ),
        { allowFailedAdvance: false },
      );
      if (!scheduled.ok) {
        const originalMessage =
          scheduled.originalError instanceof Error
            ? scheduled.originalError.message
            : scheduled.originalError === undefined
              ? "Outcome judge attempt is unresolved"
              : String(scheduled.originalError);
        const failure = new Error(originalMessage);
        // Once an external judge attempt starts, a thrown error is not proof that no provider
        // output crossed the boundary. Preserve the exact scheduled identity and fail closed.
        Reflect.set(failure, "outcomeJudgeAmbiguous", true);
        if (scheduled.originalError !== undefined) Reflect.set(failure, "cause", scheduled.originalError);
        throw failure;
      }
      const proposed = OutcomeProposalSchema.parse(scheduled.value);
      if (controller.signal.aborted) throw new Error("Outcome judge lost its durable lease");
      const validated = validateProposal(proposed, observations);
      const run = await options.protectedRuntime.feedback.putResearchRun({
        runId: payload.runId,
        experimentId: payload.experimentId,
        strategyId: payload.strategyId,
        inputDigest: payload.inputDigest,
        status: "completed",
        proposal: validated.proposal,
        citedObservationIds: validated.citedObservationIds,
        evidenceRefs: evidenceForObservations(
          observations.filter((observation) =>
            validated.citedObservationIds.includes(observation.observationId),
          ),
        ),
        attempt: job.attempt,
        retryable: false,
      });
      await options.workspace.jobs.complete({
        jobId: job.jobId,
        leaseToken,
        now: isoNow(),
        result: Object.freeze({ runId: run.runId }),
      });
    } catch (error) {
      const current = await options.workspace.jobs.get(job.jobId);
      const message = error instanceof Error ? error.message : String(error);
      const ambiguous =
        error instanceof Error && "outcomeJudgeAmbiguous" in error && error.outcomeJudgeAmbiguous === true;
      await options.protectedRuntime.feedback.putResearchRun({
        runId: payload.runId,
        experimentId: payload.experimentId,
        strategyId: payload.strategyId,
        inputDigest: payload.inputDigest,
        status: "failed",
        citedObservationIds: Object.freeze([]),
        evidenceRefs: Object.freeze([]),
        attempt: job.attempt,
        failureMessage: current?.status === "cancelled" ? "Outcome judge job was cancelled" : message,
        retryable: false,
      });
      if (current?.status === "cancelled") return;
      await options.workspace.jobs.fail({
        jobId: job.jobId,
        leaseToken,
        now: isoNow(),
        retryAt: isoNow(),
        failure: Object.freeze({
          code: ambiguous ? "outcome_judge_ambiguous" : "outcome_judge_failed",
          message,
          retryable: !ambiguous,
          ambiguous,
        }),
      });
    } finally {
      clearHeartbeat(job.jobId);
      active.delete(job.jobId);
    }
  };
  const drainOutcomeJobs = async (): Promise<void> => {
    let claimed = 0;
    while (!stopping && claimed < 8) {
      const job = await options.workspace.jobs.claim({
        workerId,
        now: isoNow(),
        leaseUntil: new Date(now().getTime() + OUTCOME_JOB_LEASE_MS).toISOString(),
        maximumCost: 8 - claimed,
        kinds: Object.freeze([OUTCOME_JOB_KIND]),
      });
      if (!job) break;
      // A claim can complete after stop() observed no active execution. Preserve the durable,
      // unrenewed lease for restart recovery, but never launch the judge after shutdown begins.
      if (stopping) return;
      claimed += 1;
      await executeOutcomeJob(job);
    }
  };
  function runAvailable(): Promise<void> {
    if (draining) return draining;
    if (stopping) return Promise.resolve();
    const next = drainOutcomeJobs().finally(() => {
      if (draining === next) draining = undefined;
    });
    draining = next;
    return next;
  }
  const evaluateExperiment = async (
    experimentId: string,
    requestedStrategyId = config.researchStrategyId,
  ): Promise<ObservationResolution | undefined> => {
    const existing = await options.protectedRuntime.feedback.getOutcome(experimentId);
    if (existing) {
      const observationRef = existing.evidenceRefs.find(
        (ref): ref is DatabaseRowRef<"experiment_observations"> =>
          ref.kind === "database_row" && ref.table === "experiment_observations",
      );
      return Object.freeze({
        status: "resolved",
        experimentId,
        observationId: observationRef?.rowId ?? "recovered",
        outcome: existing,
      });
    }
    const experiment = await options.workspace.research.experiments.getExperiment(experimentId);
    if (!experiment || experiment.status !== "observing" || !experiment.activatedRevision) return undefined;
    const observations = await options.protectedRuntime.feedback.listObservations(
      experimentId,
      config.observationWindow,
    );
    const latest = observations.at(-1);
    if (!latest) return undefined;
    const explicitUserDecision = [...observations]
      .reverse()
      .find((observation) => observation.userDecision)?.userDecision;
    const deterministicDecision = observations.some((observation) => observation.hardRegression)
      ? "revert"
      : explicitUserDecision;
    if (deterministicDecision) {
      const outcome = await commitDecision({
        experiment,
        decision: deterministicDecision,
        strategyId: "protected-deterministic-rails-v1",
        observations,
      });
      return Object.freeze({
        status: "resolved",
        experimentId,
        observationId: latest.observationId,
        outcome,
      });
    }
    if (observations.length < config.minimumEvidence)
      return Object.freeze({
        status: "observing",
        experimentId,
        observationId: latest.observationId,
      });
    const comparison = await experimentComparison(experimentId);
    const inputDigest = outcomeResearchInputDigest(comparison);
    const runId = `outcome_research_${sha256(`${experimentId}:${requestedStrategyId}:${inputDigest}`).slice(0, 32)}`;
    const operationId = `outcome-judge:${experimentId}:${requestedStrategyId}:${inputDigest}`;
    const jobId = `job_${sha256(operationId).slice(0, 32)}`;
    await authorizeScheduledJob(options.authority, {
      jobId,
      budget: 2,
      expiresAt: new Date(Math.max(now().getTime(), Date.now()) + 24 * 60 * 60 * 1000).toISOString(),
    });
    await options.workspace.jobs.enqueue({
      jobId,
      kind: OUTCOME_JOB_KIND,
      payload: OutcomeJudgeJobPayloadSchema.parse({
        schemaVersion: 1,
        experimentId,
        strategyId: requestedStrategyId,
        inputDigest,
        runId,
      }),
      payloadRefs: comparison.evidenceRefs,
      operationId,
      idempotencyKey: operationId,
      notBefore: isoNow(),
      maxAttempts: 2,
      estimatedCost: 1,
      budget: 2,
    });
    await runAvailable();
    const run = await options.protectedRuntime.feedback.getResearchRun(runId);
    if (!run)
      return Object.freeze({ status: "observing", experimentId, observationId: latest.observationId });
    if (run.status === "failed")
      return Object.freeze({
        status: "research_failed",
        experimentId,
        observationId: latest.observationId,
        run,
      });
    if (run.status !== "completed")
      return Object.freeze({ status: "observing", experimentId, observationId: latest.observationId });
    if (!run.proposal) throw new Error(`Completed research run ${run.runId} has no proposal`);
    const cited = observations.filter((observation) =>
      run?.citedObservationIds.includes(observation.observationId),
    );
    const outcome = await commitDecision({
      experiment,
      decision: run.proposal,
      strategyId: requestedStrategyId,
      observations: cited,
      researchRunId: run.runId,
    });
    return Object.freeze({
      status: "resolved",
      experimentId,
      observationId: latest.observationId,
      outcome,
    });
  };
  const classifyTurnObservations = async (
    input: ClassifyExperimentObservationsRequest,
  ): Promise<ExperimentObservationClassificationResult> =>
    await options.protectedRuntime.feedback.classifyObservations(input);
  const observeTurnOutcome = async (
    rawInput: TurnOutcomeObservationInput,
  ): Promise<readonly ObservationResolution[]> => {
    const input = TurnOutcomeInputSchema.parse(rawInput);
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    const evidenceRefs = z.array(z.unknown()).parse(input.evidenceRefs) as readonly EvidenceRef[];
    const pin = await options.protectedRuntime.activations.getTurnPin(input.sessionId, input.turnId);
    if (!pin) return Object.freeze([{ status: "excluded", reason: "turn has no activation pin" }]);
    const uniqueCapabilityIds = Object.freeze([...new Set(input.usedCapabilityIds)]);
    const pinned = uniqueCapabilityIds.flatMap((capabilityId) => {
      const revision = pin.activeCapabilityRevisions[capabilityId];
      return revision ? [revision] : [];
    });
    if (pinned.length === 0)
      return Object.freeze([{ status: "excluded", reason: "turn used no pinned capability revision" }]);
    const outcomeId =
      input.outcomeId ?? `outcome_${sha256(`${input.sessionId}:${input.turnId}`).slice(0, 32)}`;
    const existingOutcome = await options.workspace.operational.outcomes.get(outcomeId);
    if (existingOutcome) {
      if (
        existingOutcome.sessionId !== input.sessionId ||
        existingOutcome.turnId !== input.turnId ||
        existingOutcome.status !== input.status ||
        existingOutcome.summary !== input.summary
      )
        throw new Error(`Outcome identity ${outcomeId} was reused with different input`);
    } else
      await options.workspace.operational.outcomes.put(
        Object.freeze({
          outcomeId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          status: input.status,
          summary: input.summary,
          sensitivity: input.sensitivity,
          createdAt: new Date().toISOString(),
          metadata: Object.freeze({ source: "continuous_feedback" }),
        }),
      );
    const observing = await options.workspace.research.experiments.listExperiments({
      status: "observing",
      limit: 1000,
    });
    const resolutions: ObservationResolution[] = [];
    for (const revision of pinned) {
      const experiment = observing.find(
        (candidate) =>
          candidate.activatedRevision && sameCapabilityRevisionRef(candidate.activatedRevision, revision),
      );
      if (!experiment?.preflightRef) continue;
      const origin = (await options.protectedRuntime.activations.listOperations(1000)).find(
        (operation) =>
          operation.status === "committed" && operation.binding.experimentId === experiment.experimentId,
      );
      if (!origin) continue;
      const kind = signalKind(input);
      const signalId = `feedback_${sha256(`${experiment.experimentId}:${input.sessionId}:${input.turnId}:${kind}`).slice(0, 32)}`;
      const signal = Object.freeze({
        signalId,
        kind,
        scope: input.signal?.scope ?? experiment.scope,
        evidenceRefs: Object.freeze([...evidenceRefs, databaseRef("outcomes", outcomeId)]),
        strength: input.signal?.strength ?? (input.status === "failed" ? 1 : 0.5),
        novelty: input.signal?.novelty ?? 0.5,
        sensitivity: input.sensitivity,
        experimentId: experiment.experimentId,
        capabilityRevisionId: revision.capabilityRevisionId,
      }) satisfies FeedbackSignal;
      FeedbackSignalSchema.parse(signal);
      await options.workspace.research.feedbackSignals.recordFeedbackSignal(signal);
      const metrics = MetricsSchema.parse(input.metrics ?? { failed: input.status === "failed" });
      const precedence = input.signal?.userDecision
        ? "user_veto"
        : kind === "explicit_correction" || input.status === "corrected"
          ? "correction"
          : input.signal?.explicitPreference || kind === "preference_expression"
            ? "preference"
            : "none";
      const observationId = `observation_${sha256(signalId).slice(0, 32)}`;
      const isHardRegression = hardRegression(metrics, config);
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      const observation = await options.protectedRuntime.feedback.recordObservation(
        Object.freeze(
          createConditionalObject({
            observationId,
            dedupeKey: `observe:${experiment.experimentId}:${input.sessionId}:${input.turnId}:${revision.bundleDigest}`,
            experimentId: experiment.experimentId,
            signalId,
            outcomeId,
            preflightId: experiment.preflightRef.rowId,
            experimentActivationId: origin.activationId,
            servingActivationId: pin.activationId,
            activationRevision: pin.activationRevision,
            sessionId: input.sessionId,
            turnId: input.turnId,
            capabilityRevision: revision,
            metrics,
            evidenceRefs: signal.evidenceRefs,
            precedence,
          } as const)
            .addOptional(input.signal?.userDecision ? { userDecision: input.signal.userDecision } : undefined)
            .add({
              hardRegression: isHardRegression,
            } as const)
            .finish(),
        ),
        config.observationWindow,
      );
      if (!observation) {
        resolutions.push(
          Object.freeze({
            status: "excluded",
            reason: `observation window is full for ${experiment.experimentId}`,
          }),
        );
        continue;
      }
      if (input.status === "unknown" && precedence === "none" && !isHardRegression) {
        resolutions.push(
          Object.freeze({
            status: "observing",
            experimentId: experiment.experimentId,
            observationId,
          }),
        );
        continue;
      }
      const resolution = await evaluateExperiment(experiment.experimentId);
      resolutions.push(
        resolution ??
          Object.freeze({
            status: "observing",
            experimentId: experiment.experimentId,
            observationId,
          }),
      );
    }
    return resolutions.length === 0
      ? Object.freeze([{ status: "excluded", reason: "no used revision has an open experiment" }])
      : Object.freeze(resolutions);
  };
  const capabilityHealth = async (capabilityId: string): Promise<CapabilityHealthReadModel> => {
    const current = await options.protectedRuntime.activations.current();
    const activeStored = current?.activeCapabilityRevisions[capabilityId];
    const activeRevision = activeStored?.kind === "capability_revision" ? activeStored : null;
    const experiments = await options.workspace.research.experiments.listExperiments({ limit: 1000 });
    const related = experiments.filter(
      (experiment) =>
        experiment.baselineRevision.capabilityId === capabilityId ||
        experiment.candidateRevisions.some((revision) => revision.capabilityId === capabilityId) ||
        experiment.activatedRevision?.capabilityId === capabilityId,
    );
    const open = await Promise.all(
      related
        .filter((experiment) => experiment.status === "observing")
        .map(async (experiment) => await experimentComparison(experiment.experimentId)),
    );
    const outcomes = (
      await Promise.all(
        related.map(
          async (experiment) => await options.protectedRuntime.feedback.getOutcome(experiment.experimentId),
        ),
      )
    ).filter((outcome): outcome is ExperimentOutcomeOperationRecord => outcome !== undefined);
    const latestOutcome = outcomes.at(-1) ?? null;
    const degraded = open.some((comparison) =>
      comparison.observations.some((observation) => observation.hardRegression),
    );
    const status =
      !current || !activeRevision
        ? "unavailable"
        : latestOutcome?.decision === "revert"
          ? "reverted"
          : degraded
            ? "degraded"
            : open.length > 0
              ? "observing"
              : "healthy";
    return Object.freeze({
      capabilityId,
      activeRevision,
      activationId: current?.activationId ?? null,
      activationRevision: current?.revision ?? 0,
      status,
      openExperiments: Object.freeze(open),
      latestOutcome,
      evidenceRefs: Object.freeze(open.flatMap((comparison) => comparison.evidenceRefs)),
    });
  };
  const cancel = async (jobId: string): Promise<DurableJobRecord | undefined> => {
    clearHeartbeat(jobId);
    active.get(jobId)?.abort("cancelled");
    return await options.workspace.jobs.cancel(jobId, isoNow());
  };
  const stop = async (): Promise<void> => {
    stopping = true;
    for (const jobId of heartbeats.keys()) clearHeartbeat(jobId);
    for (const controller of active.values()) controller.abort("worker_stopped");
    await draining;
  };
  return Object.freeze({
    observeTurnOutcome,
    classifyTurnObservations,
    evaluateExperiment,
    experimentComparison,
    capabilityHealth,
    runAvailable,
    cancel,
    stop,
  });
}
