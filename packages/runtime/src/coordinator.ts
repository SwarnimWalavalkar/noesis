import {
  canonicalJson,
  sameCapabilityRevisionRef,
  sha256,
  type DurableJobFailure,
  type DurableJobRecord,
  type Experiment,
  type WorkspaceStore,
} from "@noesis/domain";
import { selectSessionRetrievalStrategy } from "@noesis/intelligence";
import {
  AuthorRevisionJobPayloadSchema,
  CompletedNormalTurnSchema,
  DEFAULT_RUNTIME_COORDINATOR_CONFIG,
  PreflightJobPayloadSchema,
  ReflectTurnJobPayloadSchema,
  RuntimeCoordinatorConfigSchema,
  coordinatorJobPayload,
  type CompletedNormalTurn,
  type CoordinatorCandidateResult,
  type CoordinatorJobKind,
  type CoordinatorJobView,
  type CoordinatorPreflightResult,
  type PreflightActivationHandoff,
  type RuntimeCoordinatorConfig,
  type RuntimeCoordinatorResearchPort,
} from "./coordinator-contracts.ts";

export interface RuntimeCoordinatorOptions {
  readonly workspace: Pick<WorkspaceStore, "jobs" | "research">;
  readonly research: RuntimeCoordinatorResearchPort;
  readonly config?: RuntimeCoordinatorConfig;
  readonly workerId?: string;
  readonly now?: () => Date;
}

export interface RuntimeCoordinator {
  readonly observeCompletedTurn: (input: CompletedNormalTurn) => Promise<CoordinatorJobView>;
  readonly runAvailable: () => Promise<void>;
  readonly idle: () => Promise<void>;
  readonly cancel: (jobId: string) => Promise<DurableJobRecord | undefined>;
  readonly retry: (jobId: string, additionalBudget?: number) => Promise<CoordinatorJobView>;
  readonly getJob: (jobId: string) => Promise<CoordinatorJobView | undefined>;
  readonly listJobs: (request?: {
    readonly kind?: CoordinatorJobKind;
    readonly limit?: number;
  }) => Promise<readonly CoordinatorJobView[]>;
  readonly getPreflightActivationHandoff: (
    experimentId: string,
  ) => Promise<PreflightActivationHandoff | undefined>;
  readonly stop: () => Promise<void>;
}

function iso(date: Date): string {
  return date.toISOString();
}

function stableJobId(operationId: string): string {
  return `job_${sha256(operationId).slice(0, 32)}`;
}

function stablePreflightId(experimentId: string, bundleDigest: string): string {
  return `preflight_${sha256(`${experimentId}:${bundleDigest}`).slice(0, 32)}`;
}

function stablePlanId(preflightId: string): string {
  return `plan_${sha256(preflightId).slice(0, 32)}`;
}

function payloadRefsForExperiment(experimentId: string) {
  return Object.freeze([
    Object.freeze({ kind: "database_row" as const, table: "experiments" as const, rowId: experimentId }),
  ]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failureFrom(error: unknown): DurableJobFailure {
  const code =
    error instanceof Error && typeof Reflect.get(error, "coordinatorCode") === "string"
      ? String(Reflect.get(error, "coordinatorCode"))
      : "coordinator_operation_failed";
  const retryable =
    error instanceof Error && typeof Reflect.get(error, "coordinatorRetryable") === "boolean"
      ? Reflect.get(error, "coordinatorRetryable") === true
      : false;
  const ambiguous =
    error instanceof Error && typeof Reflect.get(error, "coordinatorAmbiguous") === "boolean"
      ? Reflect.get(error, "coordinatorAmbiguous") === true
      : false;
  return Object.freeze({ code, message: errorMessage(error), retryable, ambiguous });
}

function retryDelay(config: RuntimeCoordinatorConfig, attempt: number): number {
  const multiplier = 2 ** Math.max(0, attempt - 1);
  return Math.min(config.retry.maxDelayMs, config.retry.baseDelayMs * multiplier);
}

export function createRuntimeCoordinator(options: RuntimeCoordinatorOptions): RuntimeCoordinator {
  const config = RuntimeCoordinatorConfigSchema.parse(options.config ?? DEFAULT_RUNTIME_COORDINATOR_CONFIG);
  if (config.heartbeatMs >= config.leaseMs)
    throw new Error("Runtime coordinator heartbeat must be shorter than its lease");
  const now = options.now ?? (() => new Date());
  const workerId = options.workerId ?? `runtime-coordinator:${process.pid}`;
  const active = new Map<string, AbortController>();
  let draining: Promise<void> | undefined;
  let stopping = false;

  const enqueue = async (input: {
    readonly kind: CoordinatorJobKind;
    readonly payload: unknown;
    readonly payloadRefs: readonly import("@noesis/domain").EvidenceRef[];
    readonly operationId: string;
    readonly estimatedCost: number;
    readonly budget: number;
  }): Promise<CoordinatorJobView> => {
    const job = await options.workspace.jobs.enqueue({
      jobId: stableJobId(input.operationId),
      kind: input.kind,
      payload: input.payload,
      payloadRefs: input.payloadRefs,
      operationId: input.operationId,
      idempotencyKey: input.operationId,
      notBefore: iso(now()),
      maxAttempts: config.retry.maxAttempts,
      estimatedCost: input.estimatedCost,
      budget: input.budget,
    });
    return coordinatorJobPayload(job);
  };

  const enqueueAuthor = async (input: {
    readonly experimentId: string;
    readonly hypothesisDedupeKey: string;
    readonly retrievalStrategyId: import("@noesis/intelligence").RetrievalStrategyId;
    readonly routingStrategyId: string;
    readonly payloadRefs: readonly import("@noesis/domain").EvidenceRef[];
  }): Promise<CoordinatorJobView> => {
    const payload = AuthorRevisionJobPayloadSchema.parse({
      schemaVersion: 1,
      experimentId: input.experimentId,
      hypothesisDedupeKey: input.hypothesisDedupeKey,
      retrievalStrategyId: input.retrievalStrategyId,
      routingStrategyId: input.routingStrategyId,
    });
    return await enqueue({
      kind: "runtime.author_revision",
      payload,
      payloadRefs: input.payloadRefs,
      operationId: `coordinator:author:${input.experimentId}`,
      ...config.jobs.author,
    });
  };

  const enqueuePreflight = async (input: {
    readonly experimentId: string;
    readonly candidate: CoordinatorCandidateResult;
    readonly retrievalStrategyId: import("@noesis/intelligence").RetrievalStrategyId;
    readonly routingStrategyId: string;
  }): Promise<CoordinatorJobView> => {
    const preflightId = stablePreflightId(input.experimentId, input.candidate.candidateRevision.bundleDigest);
    const payload = PreflightJobPayloadSchema.parse({
      schemaVersion: 1,
      experimentId: input.experimentId,
      preflightId,
      planId: stablePlanId(preflightId),
      retrievalStrategyId: input.retrievalStrategyId,
      routingStrategyId: input.routingStrategyId,
    });
    return await enqueue({
      kind: "runtime.preflight",
      payload,
      payloadRefs: Object.freeze([
        ...payloadRefsForExperiment(input.experimentId),
        input.candidate.manifestRevision,
      ]),
      operationId: `coordinator:preflight:${input.experimentId}:${input.candidate.candidateRevision.bundleDigest}`,
      ...config.jobs.preflight,
    });
  };

  const observeCompletedTurn = async (rawInput: CompletedNormalTurn): Promise<CoordinatorJobView> => {
    const input = CompletedNormalTurnSchema.parse(rawInput);
    const selected = selectSessionRetrievalStrategy({
      query: input.turn.correction ?? input.turn.userMessage,
      ...(input.requestedRetrievalStrategy === undefined
        ? {}
        : { requested: input.requestedRetrievalStrategy }),
    });
    const payload = ReflectTurnJobPayloadSchema.parse({
      schemaVersion: 1,
      turn: input.turn,
      baselineRevision: input.baselineRevision,
      capability: input.capability,
      ...(input.activeCapabilities === undefined ? {} : { activeCapabilities: input.activeCapabilities }),
      ...(input.userPreferences === undefined ? {} : { userPreferences: input.userPreferences }),
      retrievalStrategyId: selected.strategy.strategyId,
      retrievalStrategyReason: selected.reason,
      routingStrategyId: input.routingStrategyId,
    });
    const job = await enqueue({
      kind: "runtime.reflect_turn",
      payload,
      payloadRefs: input.turn.evidenceRefs,
      operationId: `coordinator:reflect:${input.turn.sessionId}:${input.turn.turnId}`,
      ...config.jobs.reflect,
    });
    queueMicrotask(() => void runAvailable());
    return job;
  };

  const runReflect = async (
    payload: ReturnType<typeof ReflectTurnJobPayloadSchema.parse>,
    signal: AbortSignal,
  ) => {
    const reflected = await options.research.reflect(payload, signal);
    if (reflected.status === "no_change")
      return Object.freeze({
        status: reflected.status,
        reason: reflected.reason,
        retrievalStrategyId: payload.retrievalStrategyId,
        routingStrategyId: payload.routingStrategyId,
        telemetry: reflected.telemetry,
      });
    await enqueueAuthor({
      experimentId: reflected.experiment.experimentId,
      hypothesisDedupeKey: reflected.hypothesisDedupeKey,
      retrievalStrategyId: payload.retrievalStrategyId,
      routingStrategyId: payload.routingStrategyId,
      payloadRefs: reflected.experiment.evidenceRefs,
    });
    return Object.freeze({
      status: reflected.status,
      experimentId: reflected.experiment.experimentId,
      hypothesisDedupeKey: reflected.hypothesisDedupeKey,
      retrievalStrategyId: payload.retrievalStrategyId,
      routingStrategyId: payload.routingStrategyId,
      telemetry: reflected.telemetry,
    });
  };

  const runAuthor = async (
    payload: ReturnType<typeof AuthorRevisionJobPayloadSchema.parse>,
    signal: AbortSignal,
  ) => {
    let candidate = await options.research.rehydrateCandidate(payload.experimentId);
    if (!candidate) candidate = await options.research.author(payload, signal);
    const experiment = await options.workspace.research.experiments.getExperiment(payload.experimentId);
    if (
      !experiment ||
      experiment.candidateRevisions.length !== 1 ||
      experiment.candidateRevisions[0] === undefined ||
      !sameCapabilityRevisionRef(experiment.candidateRevisions[0], candidate.candidateRevision)
    )
      throw new Error(
        `Authored candidate ${payload.experimentId} is not the authoritative experiment revision`,
      );
    await enqueuePreflight({
      experimentId: payload.experimentId,
      candidate,
      retrievalStrategyId: payload.retrievalStrategyId,
      routingStrategyId: payload.routingStrategyId,
    });
    return Object.freeze({
      status: "candidate_authored",
      experimentId: payload.experimentId,
      candidateRevision: candidate.candidateRevision,
      manifestRevision: candidate.manifestRevision,
      retrievalStrategyId: payload.retrievalStrategyId,
      routingStrategyId: payload.routingStrategyId,
      telemetry: candidate.telemetry,
    });
  };

  const recordedPreflight = async (
    experiment: Experiment,
    candidate: CoordinatorCandidateResult,
  ): Promise<CoordinatorPreflightResult | undefined> => {
    if (!experiment.preflightRef) return undefined;
    const report = await options.workspace.research.preflights.getPreflightReport(
      experiment.preflightRef.rowId,
    );
    if (!report) throw new Error(`Experiment ${experiment.experimentId} references a missing preflight`);
    if (!sameCapabilityRevisionRef(report.candidateRevision, candidate.candidateRevision))
      throw new Error(`Experiment ${experiment.experimentId} preflight candidate identity changed`);
    return Object.freeze({
      experimentId: experiment.experimentId,
      candidateRevision: candidate.candidateRevision,
      reportRef: experiment.preflightRef,
      decision: report.decision,
      telemetry: Object.freeze({ recovered: true }),
    });
  };

  const runPreflight = async (
    payload: ReturnType<typeof PreflightJobPayloadSchema.parse>,
    signal: AbortSignal,
  ) => {
    const candidate = await options.research.rehydrateCandidate(payload.experimentId);
    if (!candidate) throw new Error(`Exact candidate manifest is missing for ${payload.experimentId}`);
    let experiment = await options.workspace.research.experiments.getExperiment(payload.experimentId);
    if (!experiment) throw new Error(`Experiment ${payload.experimentId} is missing`);
    let result = await recordedPreflight(experiment, candidate);
    if (!result) {
      if (experiment.status === "authoring") {
        experiment = Object.freeze({ ...experiment, status: "preflight" as const });
        await options.workspace.research.experiments.putExperiment(experiment);
      }
      if (experiment.status !== "preflight")
        throw new Error(`Experiment ${payload.experimentId} cannot preflight from ${experiment.status}`);
      result = await options.research.preflight(payload, signal);
      if (!sameCapabilityRevisionRef(result.candidateRevision, candidate.candidateRevision))
        throw new Error(`Preflight ${payload.preflightId} returned a different candidate identity`);
      const report = await options.workspace.research.preflights.getPreflightReport(result.reportRef.rowId);
      if (!report || report.decision !== result.decision)
        throw new Error(`Preflight ${payload.preflightId} was not durably recorded`);
      await options.workspace.research.experiments.putExperiment(
        Object.freeze({ ...experiment, preflightRef: result.reportRef }),
      );
    }
    return Object.freeze({
      status: "preflight_recorded",
      experimentId: payload.experimentId,
      candidateRevision: result.candidateRevision,
      reportRef: result.reportRef,
      decision: result.decision,
      retrievalStrategyId: payload.retrievalStrategyId,
      routingStrategyId: payload.routingStrategyId,
      telemetry: result.telemetry,
    });
  };

  const execute = async (job: DurableJobRecord): Promise<void> => {
    const view = coordinatorJobPayload(job);
    const leaseToken = job.leaseToken;
    if (!leaseToken) throw new Error(`Claimed job ${job.jobId} has no lease token`);
    const controller = new AbortController();
    active.set(job.jobId, controller);
    const heartbeat = setInterval(() => {
      const leaseUntil = iso(new Date(now().getTime() + config.leaseMs));
      void options.workspace.jobs
        .renew({ jobId: job.jobId, leaseToken, now: iso(now()), leaseUntil })
        .then((renewed) => {
          if (!renewed) controller.abort("lease_lost");
        })
        .catch(() => controller.abort("lease_renewal_failed"));
    }, config.heartbeatMs);
    try {
      const result =
        view.kind === "runtime.reflect_turn"
          ? await runReflect(ReflectTurnJobPayloadSchema.parse(view.payload), controller.signal)
          : view.kind === "runtime.author_revision"
            ? await runAuthor(AuthorRevisionJobPayloadSchema.parse(view.payload), controller.signal)
            : await runPreflight(PreflightJobPayloadSchema.parse(view.payload), controller.signal);
      await options.workspace.jobs.complete({
        jobId: job.jobId,
        leaseToken,
        now: iso(now()),
        result,
      });
    } catch (error) {
      const current = await options.workspace.jobs.get(job.jobId);
      if (current?.status === "cancelled") return;
      const failure =
        controller.signal.aborted && stopping
          ? Object.freeze({
              code: "worker_stopped",
              message: "Runtime coordinator stopped while the job was running",
              retryable: true,
              ambiguous: false,
            })
          : failureFrom(error);
      const retryAt = iso(new Date(now().getTime() + retryDelay(config, job.attempt)));
      await options.workspace.jobs.fail({
        jobId: job.jobId,
        leaseToken,
        now: iso(now()),
        retryAt,
        failure,
      });
    } finally {
      clearInterval(heartbeat);
      active.delete(job.jobId);
    }
  };

  const drain = async (): Promise<void> => {
    let claimedCount = 0;
    let remainingBudget = config.drainBudget;
    while (!stopping && claimedCount < config.maxJobsPerDrain) {
      const batch: DurableJobRecord[] = [];
      while (
        batch.length < config.maxConcurrency &&
        claimedCount < config.maxJobsPerDrain &&
        remainingBudget >= 0
      ) {
        const claimed = await options.workspace.jobs.claim({
          workerId,
          now: iso(now()),
          leaseUntil: iso(new Date(now().getTime() + config.leaseMs)),
          maximumCost: remainingBudget,
          kinds: CoordinatorJobKindValues,
        });
        if (!claimed) break;
        batch.push(claimed);
        claimedCount += 1;
        remainingBudget -= claimed.estimatedCost;
      }
      if (batch.length === 0) break;
      await Promise.all(batch.map(execute));
    }
  };

  function runAvailable(): Promise<void> {
    if (draining) return draining;
    stopping = false;
    const next = drain().finally(() => {
      if (draining === next) draining = undefined;
    });
    draining = next;
    return next;
  }

  const idle = async (): Promise<void> => {
    await runAvailable();
  };

  const cancel = async (jobId: string): Promise<DurableJobRecord | undefined> => {
    active.get(jobId)?.abort("cancelled");
    return await options.workspace.jobs.cancel(jobId, iso(now()));
  };

  const retry = async (jobId: string, additionalBudget?: number): Promise<CoordinatorJobView> => {
    const job = await options.workspace.jobs.retry({
      jobId,
      now: iso(now()),
      ...(additionalBudget === undefined ? {} : { additionalBudget }),
    });
    queueMicrotask(() => void runAvailable());
    return coordinatorJobPayload(job);
  };

  const getJob = async (jobId: string): Promise<CoordinatorJobView | undefined> => {
    const job = await options.workspace.jobs.get(jobId);
    return job ? coordinatorJobPayload(job) : undefined;
  };

  const listJobs = async (
    request: { readonly kind?: CoordinatorJobKind; readonly limit?: number } = {},
  ): Promise<readonly CoordinatorJobView[]> =>
    (await options.workspace.jobs.list(request)).flatMap((job) => {
      try {
        return [coordinatorJobPayload(job)];
      } catch {
        return [];
      }
    });

  const getPreflightActivationHandoff = async (
    experimentId: string,
  ): Promise<PreflightActivationHandoff | undefined> => {
    const experiment = await options.workspace.research.experiments.getExperiment(experimentId);
    if (!experiment || experiment.status !== "preflight" || !experiment.preflightRef) return undefined;
    const candidate = await options.research.rehydrateCandidate(experimentId);
    if (!candidate) throw new Error(`Exact candidate manifest is missing for ${experimentId}`);
    const report = await options.workspace.research.preflights.getPreflightReport(
      experiment.preflightRef.rowId,
    );
    if (!report || !sameCapabilityRevisionRef(report.candidateRevision, candidate.candidateRevision))
      throw new Error(`Preflight handoff ${experimentId} is not bound to the exact candidate manifest`);
    const preflightExperiment = Object.freeze({ ...experiment, status: "preflight" as const });
    return Object.freeze({
      experiment: preflightExperiment,
      candidateRevision: candidate.candidateRevision,
      manifestRevision: candidate.manifestRevision,
      reportRef: experiment.preflightRef,
      report,
    });
  };

  const stop = async (): Promise<void> => {
    stopping = true;
    for (const controller of active.values()) controller.abort("worker_stopped");
    await draining;
  };

  return Object.freeze({
    observeCompletedTurn,
    runAvailable,
    idle,
    cancel,
    retry,
    getJob,
    listJobs,
    getPreflightActivationHandoff,
    stop,
  });
}

const CoordinatorJobKindValues = Object.freeze([
  "runtime.reflect_turn",
  "runtime.author_revision",
  "runtime.preflight",
] as const satisfies readonly CoordinatorJobKind[]);

export function coordinatorOperationFingerprint(job: CoordinatorJobView): string {
  return sha256(canonicalJson({ operationId: job.job.operationId, kind: job.kind, payload: job.payload }));
}
