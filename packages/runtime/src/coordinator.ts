import {
  canonicalJson,
  type DurableJobFailure,
  type DurableJobListCursor,
  type DurableJobRecord,
  durableJobFailureFromError,
  type Experiment,
  sameCapabilityRevisionRef,
  sha256,
  toJsonValue,
  type WorkspaceStore,
} from "@noesis/domain";
import { selectSessionRetrievalStrategy } from "@noesis/intelligence";
import type { AuthorityBoundary } from "@noesis/policy";
import {
  AuthorRevisionJobPayloadSchema,
  type CompletedNormalTurn,
  CompletedNormalTurnSchema,
  type CoordinatorCandidateResult,
  type CoordinatorJobKind,
  type CoordinatorJobView,
  type CoordinatorPreflightResult,
  type CoordinatorWorkingAdjustmentMutationPort,
  coordinatorJobPayload,
  coordinatorOperationError,
  DEFAULT_RUNTIME_COORDINATOR_CONFIG,
  type PreflightActivationHandoff,
  PreflightJobPayloadSchema,
  ReflectTurnJobPayloadSchema,
  type RuntimeCoordinatorConfig,
  RuntimeCoordinatorConfigSchema,
  type RuntimeCoordinatorResearchPort,
} from "./coordinator-contracts.ts";
import { authorizeScheduledJob, runScheduledJob } from "./scheduled-execution.ts";

export interface RuntimeCoordinatorOptions {
  readonly workspace: Pick<WorkspaceStore, "jobs" | "research">;
  readonly workingAdjustments: CoordinatorWorkingAdjustmentMutationPort;
  readonly authority: AuthorityBoundary;
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
  readonly waitForTerminal: (request: {
    readonly jobId: string;
    readonly deadline: Date;
    readonly signal?: AbortSignal;
  }) => Promise<
    | { readonly status: "terminal"; readonly job: CoordinatorJobView }
    | { readonly status: "timeout" | "missing" | "cancelled" }
  >;
  readonly listJobs: (request?: {
    readonly kind?: CoordinatorJobKind;
    readonly limit?: number;
    readonly after?: DurableJobListCursor;
  }) => Promise<readonly CoordinatorJobView[]>;
  readonly listJobPage: (request?: {
    readonly kind?: CoordinatorJobKind;
    readonly limit?: number;
    readonly after?: DurableJobListCursor;
    readonly sessionId?: string;
    readonly experimentIds?: readonly string[];
  }) => Promise<{
    readonly jobs: readonly CoordinatorJobView[];
    readonly exhausted: boolean;
    readonly nextCursor?: DurableJobListCursor;
  }>;
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

function stableWorkingAdjustmentId(parentJobId: string, decision: unknown): string {
  return `adjustment_${sha256(canonicalJson({ parentJobId, decision })).slice(0, 32)}`;
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
  return (
    durableJobFailureFromError(error) ??
    Object.freeze({
      code: "coordinator_operation_failed",
      message: errorMessage(error),
      retryable: false,
      ambiguous: false,
    })
  );
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
  const heartbeats = new Map<string, NodeJS.Timeout>();
  let draining: Promise<void> | undefined;
  let stopping = false;
  const clearHeartbeat = (jobId: string): void => {
    const heartbeat = heartbeats.get(jobId);
    if (!heartbeat) return;
    clearInterval(heartbeat);
    heartbeats.delete(jobId);
  };

  const enqueue = async (input: {
    readonly kind: CoordinatorJobKind;
    readonly payload: unknown;
    readonly payloadRefs: readonly import("@noesis/domain").EvidenceRef[];
    readonly operationId: string;
    readonly estimatedCost: number;
    readonly budget: number;
    readonly observations?: readonly {
      readonly sourceSessionId: string;
      readonly parentJobId: string;
    }[];
    readonly inheritObservationsFromParentJobId?: string;
    readonly matchesExisting?: (view: CoordinatorJobView) => boolean;
  }): Promise<CoordinatorJobView> => {
    const jobId = stableJobId(input.operationId);
    await authorizeScheduledJob(options.authority, {
      jobId,
      budget: input.budget,
      expiresAt: iso(new Date(Math.max(now().getTime(), Date.now()) + 24 * 60 * 60 * 1_000)),
    });
    const observations = input.observations?.map((observation) =>
      Object.freeze({ ...observation, observedAt: iso(now()) }),
    );
    try {
      const job = await options.workspace.jobs.enqueue({
        jobId,
        kind: input.kind,
        payload: input.payload,
        payloadRefs: input.payloadRefs,
        operationId: input.operationId,
        idempotencyKey: input.operationId,
        notBefore: iso(now()),
        maxAttempts: config.retry.maxAttempts,
        estimatedCost: input.estimatedCost,
        budget: input.budget,
        ...(observations ? { observations } : {}),
        ...(input.inheritObservationsFromParentJobId
          ? { inheritObservationsFromParentJobId: input.inheritObservationsFromParentJobId }
          : {}),
      });
      return coordinatorJobPayload(job);
    } catch (error) {
      if (!input.matchesExisting || (!observations && !input.inheritObservationsFromParentJobId)) throw error;
      const existing = await options.workspace.jobs.get(jobId);
      if (!existing) throw error;
      let view: CoordinatorJobView;
      try {
        view = coordinatorJobPayload(existing);
      } catch {
        throw error;
      }
      if (!input.matchesExisting(view)) throw error;
      for (const observation of observations ?? [])
        await options.workspace.jobs.recordObservation(jobId, observation);
      if (input.inheritObservationsFromParentJobId)
        await options.workspace.jobs.inheritObservations(
          jobId,
          input.inheritObservationsFromParentJobId,
          iso(now()),
        );
      return view;
    }
  };

  const enqueueAuthor = async (input: {
    readonly experimentId: string;
    readonly sourceSessionId: string;
    readonly parentJobId: string;
    readonly hypothesisDedupeKey: string;
    readonly retrievalStrategyId: import("@noesis/intelligence").RetrievalStrategyId;
    readonly routingStrategyId: string;
    readonly payloadRefs: readonly import("@noesis/domain").EvidenceRef[];
  }): Promise<CoordinatorJobView> => {
    const payload = AuthorRevisionJobPayloadSchema.parse({
      schemaVersion: 1,
      experimentId: input.experimentId,
      sourceSessionId: input.sourceSessionId,
      parentJobId: input.parentJobId,
      hypothesisDedupeKey: input.hypothesisDedupeKey,
      retrievalStrategyId: input.retrievalStrategyId,
      routingStrategyId: input.routingStrategyId,
    });
    return await enqueue({
      kind: "runtime.author_revision",
      payload,
      payloadRefs: input.payloadRefs,
      operationId: `coordinator:author:${input.experimentId}`,
      observations: Object.freeze([
        Object.freeze({
          sourceSessionId: input.sourceSessionId,
          parentJobId: input.parentJobId,
        }),
      ]),
      matchesExisting: (view) => {
        if (view.kind !== "runtime.author_revision") return false;
        const existing = AuthorRevisionJobPayloadSchema.safeParse(view.payload);
        return (
          existing.success &&
          existing.data.experimentId === input.experimentId &&
          existing.data.hypothesisDedupeKey === input.hypothesisDedupeKey
        );
      },
      ...config.jobs.author,
    });
  };

  const enqueuePreflight = async (input: {
    readonly experimentId: string;
    readonly sourceSessionIds: readonly string[];
    readonly parentJobId: string;
    readonly candidate: CoordinatorCandidateResult;
    readonly retrievalStrategyId: import("@noesis/intelligence").RetrievalStrategyId;
    readonly routingStrategyId: string;
  }): Promise<CoordinatorJobView> => {
    const preflightId = stablePreflightId(input.experimentId, input.candidate.candidateRevision.bundleDigest);
    const payload = PreflightJobPayloadSchema.parse({
      schemaVersion: 1,
      experimentId: input.experimentId,
      ...(input.sourceSessionIds[0] ? { sourceSessionId: input.sourceSessionIds[0] } : {}),
      parentJobId: input.parentJobId,
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
      inheritObservationsFromParentJobId: input.parentJobId,
      matchesExisting: (view) => {
        if (view.kind !== "runtime.preflight") return false;
        const existing = PreflightJobPayloadSchema.safeParse(view.payload);
        return (
          existing.success &&
          existing.data.experimentId === input.experimentId &&
          existing.data.preflightId === preflightId &&
          existing.data.planId === stablePlanId(preflightId)
        );
      },
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
    parentJobId: string,
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
    if (reflected.status === "apply_working_adjustment") {
      const adjustmentId = stableWorkingAdjustmentId(parentJobId, {
        status: reflected.status,
        observation: reflected.observation,
        project: reflected.project,
        expectedActiveAdjustmentId: reflected.expectedActiveAdjustmentId,
        rationale: reflected.rationale,
        strategy: reflected.strategy,
        successSignal: reflected.successSignal,
        evidenceRefs: reflected.evidenceRefs,
        createdFromTurnId: payload.turn.turnId,
      });
      const applied = await options.workingAdjustments.apply({
        adjustment: Object.freeze({
          adjustmentId,
          scope: Object.freeze({ ...reflected.project }),
          observation: reflected.observation.reason,
          strategy: reflected.strategy,
          successSignal: reflected.successSignal,
          evidenceRefs: Object.freeze(
            reflected.evidenceRefs.map((reference) => Object.freeze({ ...reference })),
          ),
          createdFromTurnId: payload.turn.turnId,
        }),
        expectedActiveAdjustmentId: reflected.expectedActiveAdjustmentId,
        signal,
      });
      if (applied.status === "stale")
        return Object.freeze({
          status: "stale" as const,
          requestedDecision: reflected.status,
          projectId: reflected.project.projectId,
          expectedActiveAdjustmentId: reflected.expectedActiveAdjustmentId,
          activeAdjustmentId: applied.currentActiveAdjustmentId,
          adjustmentId,
          observation: reflected.observation,
          retrievalStrategyId: payload.retrievalStrategyId,
          routingStrategyId: payload.routingStrategyId,
          telemetry: reflected.telemetry,
        });
      return Object.freeze({
        status: applied.replacedAdjustmentId === null ? ("adjusted" as const) : ("replaced" as const),
        adjustmentId,
        projectId: reflected.project.projectId,
        rationale: reflected.rationale,
        observation: reflected.observation,
        expectedActiveAdjustmentId: reflected.expectedActiveAdjustmentId,
        replacedAdjustmentId: applied.replacedAdjustmentId,
        retrievalStrategyId: payload.retrievalStrategyId,
        routingStrategyId: payload.routingStrategyId,
        telemetry: reflected.telemetry,
      });
    }
    if (reflected.status === "unapply_working_adjustment") {
      const unapplied = await options.workingAdjustments.unapply({
        projectId: reflected.project.projectId,
        expectedActiveAdjustmentId: reflected.expectedActiveAdjustmentId,
        signal,
      });
      if (unapplied.status === "stale")
        return Object.freeze({
          status: "stale" as const,
          requestedDecision: reflected.status,
          projectId: reflected.project.projectId,
          expectedActiveAdjustmentId: reflected.expectedActiveAdjustmentId,
          activeAdjustmentId: unapplied.currentActiveAdjustmentId,
          adjustmentId: reflected.expectedActiveAdjustmentId,
          observation: reflected.observation,
          retrievalStrategyId: payload.retrievalStrategyId,
          routingStrategyId: payload.routingStrategyId,
          telemetry: reflected.telemetry,
        });
      return Object.freeze({
        status: "unapplied" as const,
        adjustmentId: reflected.expectedActiveAdjustmentId,
        projectId: reflected.project.projectId,
        reason: reflected.reason,
        observation: reflected.observation,
        retrievalStrategyId: payload.retrievalStrategyId,
        routingStrategyId: payload.routingStrategyId,
        telemetry: reflected.telemetry,
      });
    }
    if (reflected.status === "deduped") {
      const existing = await options.workspace.research.experiments.getExperiment(
        reflected.experiment.experimentId,
      );
      if (existing && existing.status !== "hypothesis")
        return Object.freeze({
          status: reflected.status,
          experimentId: existing.experimentId,
          hypothesisDedupeKey: reflected.hypothesisDedupeKey,
          retrievalStrategyId: payload.retrievalStrategyId,
          routingStrategyId: payload.routingStrategyId,
          telemetry: Object.freeze({
            ...reflected.telemetry,
            existingExperimentStatus: existing.status,
          }),
        });
    }
    await enqueueAuthor({
      experimentId: reflected.experiment.experimentId,
      sourceSessionId: payload.turn.sessionId,
      parentJobId,
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
    parentJobId: string,
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
      sourceSessionIds: Object.freeze([
        ...new Set([...(payload.sourceSessionId ? [payload.sourceSessionId] : [])]),
      ]),
      parentJobId,
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
    heartbeat.unref?.();
    heartbeats.set(job.jobId, heartbeat);
    try {
      const scheduled = await runScheduledJob(
        options.authority,
        job,
        coordinatorOperationFingerprint(view),
        async () =>
          toJsonValue(
            view.kind === "runtime.reflect_turn"
              ? await runReflect(
                  ReflectTurnJobPayloadSchema.parse(view.payload),
                  controller.signal,
                  job.jobId,
                )
              : view.kind === "runtime.author_revision"
                ? await runAuthor(
                    AuthorRevisionJobPayloadSchema.parse(view.payload),
                    controller.signal,
                    job.jobId,
                  )
                : await runPreflight(PreflightJobPayloadSchema.parse(view.payload), controller.signal),
          ),
      );
      if (!scheduled.ok) {
        if (scheduled.originalError !== undefined) throw scheduled.originalError;
        throw coordinatorOperationError(scheduled.reason, {
          code: `scheduled_${scheduled.code}`,
          retryable: false,
          ambiguous: scheduled.code === "ambiguous",
        });
      }
      await options.workspace.jobs.complete({
        jobId: job.jobId,
        leaseToken,
        now: iso(now()),
        result: scheduled.value,
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
      clearHeartbeat(job.jobId);
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
        // stop() may land while the durable claim is awaiting SQLite. The claim is authoritative
        // once it returns, but execution must not start after shutdown began. Leave the lease
        // unrenewed so the next runtime can recover it after expiry.
        if (stopping) return;
        batch.push(claimed);
        claimedCount += 1;
        remainingBudget -= claimed.estimatedCost;
      }
      if (batch.length === 0) break;
      if (stopping) return;
      await Promise.all(batch.map(execute));
    }
  };

  function runAvailable(): Promise<void> {
    if (draining) return draining;
    if (stopping) return Promise.resolve();
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
    clearHeartbeat(jobId);
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

  const waitForTerminal: RuntimeCoordinator["waitForTerminal"] = async (request) => {
    const deadlineMs = request.deadline.getTime();
    if (!Number.isFinite(deadlineMs)) throw new Error("Coordinator terminal wait requires a valid deadline");
    const terminal = new Set(["completed", "failed", "cancelled", "budget_exhausted"]);
    while (true) {
      if (request.signal?.aborted) return Object.freeze({ status: "cancelled" as const });
      const job = await getJob(request.jobId);
      if (!job) return Object.freeze({ status: "missing" as const });
      if (terminal.has(job.job.status)) return Object.freeze({ status: "terminal" as const, job });
      const remaining = deadlineMs - Date.now();
      if (remaining <= 0) return Object.freeze({ status: "timeout" as const });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(25, remaining));
        timer.unref();
      });
    }
  };

  const listJobs = async (
    request: {
      readonly kind?: CoordinatorJobKind;
      readonly limit?: number;
      readonly after?: DurableJobListCursor;
    } = {},
  ): Promise<readonly CoordinatorJobView[]> =>
    (await options.workspace.jobs.list(request)).flatMap((job) => {
      try {
        return [coordinatorJobPayload(job)];
      } catch {
        return [];
      }
    });

  const listJobPage: RuntimeCoordinator["listJobPage"] = async (request = {}) => {
    if (request.sessionId !== undefined && request.kind === undefined)
      throw new Error("Session-scoped coordinator job pages require an exact coordinator job kind");
    if (request.experimentIds && request.kind === "runtime.reflect_turn")
      throw new Error("Experiment-scoped coordinator job pages are not valid for reflection jobs");
    const page = await options.workspace.jobs.listPage({
      ...(request.kind ? { kind: request.kind } : {}),
      ...(request.limit === undefined ? {} : { limit: request.limit }),
      ...(request.after ? { after: request.after } : {}),
      ...(request.sessionId === undefined
        ? {}
        : request.kind === "runtime.reflect_turn"
          ? { payloadSessionId: request.sessionId }
          : { observedSessionId: request.sessionId }),
      ...(request.experimentIds ? { payloadExperimentIds: request.experimentIds } : {}),
    });
    return Object.freeze({
      jobs: Object.freeze(
        page.records.flatMap((job) => {
          try {
            return [coordinatorJobPayload(job)];
          } catch {
            return [];
          }
        }),
      ),
      exhausted: page.exhausted,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    });
  };

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
    for (const jobId of [...heartbeats.keys()]) clearHeartbeat(jobId);
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
    waitForTerminal,
    listJobs,
    listJobPage,
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
