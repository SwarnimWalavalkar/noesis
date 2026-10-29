import {
  canonicalJson,
  type DurableJobFailure,
  type DurableJobRecord,
  durableJobFailureFromError,
  sha256,
  toJsonValue,
} from "@noesis/domain";
import {
  type CapabilityLearningModule,
  type CapabilityLearningTurn,
  LearningTurnInputSchema,
  type SessionReviewRequest,
  type SessionReviewResult,
} from "@noesis/learning";
import type { AuthorityBoundary } from "@noesis/policy";
import type { NoesisWorkspaceStore } from "@noesis/workspace";
import { z } from "zod";
import { authorizeScheduledJob, runScheduledJob } from "./scheduled-execution.ts";

// SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
export const CAPABILITY_REFLECTION_JOB_KIND = "runtime.reflect_capability" as const;
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled", "budget_exhausted"]);
const REFLECTION_LEASE_MS = 120_000;
const REFLECTION_HEARTBEAT_MS = 30_000;
/**
 * A turn's reflection waits for the user's reaction. The next user message in the session
 * releases it early; otherwise it runs once the session has been idle this long.
 */
export const EXCHANGE_IDLE_MS = 10 * 60_000;
export const SESSION_REVIEW_JOB_KIND = "runtime.review_session" as const;
/** A session is reviewed once it has been quiet this long after its last turn. */
export const SESSION_REVIEW_IDLE_MS = 30 * 60_000;
const SessionReviewJobPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  occurredAt: z.string().datetime(),
  project: z.strictObject({ projectId: z.string().min(1), root: z.string().min(1) }),
});
const DELAYED_JOB_POLL_MS = 60_000;

const CapabilityReflectionJobPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  turn: LearningTurnInputSchema,
  project: z.strictObject({ projectId: z.string().min(1), root: z.string().min(1) }),
  selectedCapabilities: z.array(
    z.strictObject({
      kind: z.literal("capability_revision"),
      capabilityId: z.string().min(1),
      capabilityRevisionId: z.string().min(1),
      bundleDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    }),
  ),
});

export interface CapabilityReflectionJobView {
  readonly job: DurableJobRecord;
  readonly payload: CapabilityLearningTurn;
}

export interface CapabilityCoordinator {
  readonly observeSettledTurn: (input: CapabilityLearningTurn) => Promise<CapabilityReflectionJobView>;
  /** Runs every held reflection for a session now, because its user has reacted. */
  readonly releaseSession: (sessionId: string) => Promise<void>;
  readonly runAvailable: () => Promise<void>;
  readonly idle: () => Promise<void>;
  readonly waitForTerminal: (request: {
    readonly jobId: string;
    readonly deadline: Date;
    readonly signal?: AbortSignal;
  }) => Promise<
    | { readonly status: "terminal"; readonly job: DurableJobRecord }
    | { readonly status: "timeout" | "missing" | "cancelled" }
  >;
  readonly stop: () => Promise<void>;
}

export interface CreateCapabilityCoordinatorOptions {
  readonly workspace: Pick<NoesisWorkspaceStore, "jobs">;
  readonly authority: AuthorityBoundary;
  readonly learning: Pick<CapabilityLearningModule, "reflectSettledTurn">;
  /** Reviews a whole session after it goes quiet. Omitted, no session reviews are scheduled. */
  readonly reviewSession?: (
    request: SessionReviewRequest,
    signal: AbortSignal,
  ) => Promise<SessionReviewResult>;
  readonly sessionReviewIdleMs?: number;
  readonly now?: () => Date;
  readonly workerId?: string;
  /** How long a reflection waits for the user's reaction. Defaults to {@link EXCHANGE_IDLE_MS}. */
  readonly exchangeIdleMs?: number;
}

function iso(date: Date): string {
  return date.toISOString();
}

function jobIdFor(input: CapabilityLearningTurn): string {
  return `job_${sha256(`capability-reflection:${input.turn.sessionId}:${input.turn.turnId}`).slice(0, 32)}`;
}

function decodeJob(job: DurableJobRecord): CapabilityReflectionJobView {
  if (job.kind !== CAPABILITY_REFLECTION_JOB_KIND)
    throw new Error(`Expected ${CAPABILITY_REFLECTION_JOB_KIND}, received ${job.kind}`);
  const parsed = CapabilityReflectionJobPayloadSchema.parse(job.payload);
  return Object.freeze({
    job,
    payload: Object.freeze({
      turn: parsed.turn,
      project: Object.freeze(parsed.project),
      selectedCapabilities: Object.freeze(parsed.selectedCapabilities),
    }),
  });
}

function failureFrom(cause: unknown, retryable = false): DurableJobFailure {
  if (retryable)
    return Object.freeze({
      code: "capability_reflection_interrupted",
      message: cause instanceof Error ? cause.message : String(cause),
      retryable: true,
      ambiguous: false,
    });
  return (
    durableJobFailureFromError(cause) ??
    Object.freeze({
      code: "capability_reflection_failed",
      message: cause instanceof Error ? cause.message : String(cause),
      retryable: false,
      ambiguous: false,
    })
  );
}

export function createCapabilityCoordinator(
  options: CreateCapabilityCoordinatorOptions,
): CapabilityCoordinator {
  const now = options.now ?? (() => new Date());
  const exchangeIdleMs = options.exchangeIdleMs ?? EXCHANGE_IDLE_MS;
  const sessionReviewIdleMs = options.sessionReviewIdleMs ?? SESSION_REVIEW_IDLE_MS;
  const workerId = options.workerId ?? `capability-coordinator:${process.pid}`;
  const active = new Map<string, AbortController>();
  let draining: Promise<void> | undefined;
  let stopping = false;

  const runInBackground = (): void => {
    queueMicrotask(() => {
      void runAvailable().catch(() => undefined);
    });
  };

  const observeSettledTurn: CapabilityCoordinator["observeSettledTurn"] = async (input) => {
    const payload = CapabilityReflectionJobPayloadSchema.parse({
      schemaVersion: 1,
      turn: input.turn,
      project: input.project,
      selectedCapabilities: input.selectedCapabilities,
    });
    const jobId = jobIdFor(input);
    await authorizeScheduledJob(options.authority, {
      jobId,
      budget: 3,
      expiresAt: iso(new Date(now().getTime() + 24 * 60 * 60 * 1_000)),
    });
    let job: DurableJobRecord;
    try {
      job = await options.workspace.jobs.enqueue({
        jobId,
        kind: CAPABILITY_REFLECTION_JOB_KIND,
        payload,
        payloadRefs: input.turn.evidenceRefs,
        operationId: `capability-reflection:${input.turn.sessionId}:${input.turn.turnId}`,
        idempotencyKey: `capability-reflection:${input.turn.sessionId}:${input.turn.turnId}`,
        notBefore: iso(new Date(now().getTime() + exchangeIdleMs)),
        maxAttempts: 3,
        estimatedCost: 1,
        budget: 3,
      });
    } catch (error) {
      const existing = await options.workspace.jobs.get(jobId);
      if (!existing || canonicalJson(existing.payload) !== canonicalJson(payload)) throw error;
      job = existing;
    }
    if (options.reviewSession) await scheduleSessionReview(input);
    runInBackground();
    return decodeJob(job);
  };

  // Each turn schedules a review of its session. When it runs, the review skips itself if the
  // session had later activity, so only the review after the last turn does any work.
  const scheduleSessionReview = async (input: CapabilityLearningTurn): Promise<void> => {
    const identity = `session-review:${input.turn.sessionId}:${input.turn.turnId}`;
    const jobId = `job_${sha256(identity).slice(0, 32)}`;
    const payload = SessionReviewJobPayloadSchema.parse({
      schemaVersion: 1,
      sessionId: input.turn.sessionId,
      turnId: input.turn.turnId,
      occurredAt: input.turn.occurredAt,
      project: input.project,
    });
    await authorizeScheduledJob(options.authority, {
      jobId,
      budget: 3,
      expiresAt: iso(new Date(now().getTime() + 24 * 60 * 60 * 1_000)),
    });
    try {
      await options.workspace.jobs.enqueue({
        jobId,
        kind: SESSION_REVIEW_JOB_KIND,
        payload,
        payloadRefs: input.turn.evidenceRefs,
        operationId: identity,
        idempotencyKey: identity,
        notBefore: iso(new Date(now().getTime() + sessionReviewIdleMs)),
        maxAttempts: 2,
        estimatedCost: 1,
        budget: 3,
      });
    } catch (error) {
      const existing = await options.workspace.jobs.get(jobId);
      if (!existing || canonicalJson(existing.payload) !== canonicalJson(payload)) throw error;
    }
  };

  const releaseSession: CapabilityCoordinator["releaseSession"] = async (sessionId) => {
    const held = await options.workspace.jobs.list({
      kind: CAPABILITY_REFLECTION_JOB_KIND,
      status: "scheduled",
      payloadSessionId: sessionId,
      limit: 100,
    });
    const releasedAt = iso(now());
    for (const job of held) await options.workspace.jobs.release(job.jobId, releasedAt);
    if (held.length > 0) runInBackground();
  };

  const execute = async (job: DurableJobRecord): Promise<void> => {
    const leaseToken = job.leaseToken;
    if (!leaseToken) throw new Error(`Claimed job ${job.jobId} has no lease token`);
    const controller = new AbortController();
    active.set(job.jobId, controller);
    const heartbeat = setInterval(() => {
      void options.workspace.jobs
        .renew({
          jobId: job.jobId,
          leaseToken,
          now: iso(now()),
          leaseUntil: iso(new Date(now().getTime() + REFLECTION_LEASE_MS)),
        })
        .then((renewed) => {
          if (!renewed) controller.abort("lease_lost");
        })
        .catch(() => controller.abort("lease_renewal_failed"));
    }, REFLECTION_HEARTBEAT_MS);
    heartbeat.unref();
    try {
      const scheduled = await runScheduledJob(
        options.authority,
        job,
        sha256(canonicalJson({ kind: job.kind, payload: job.payload })),
        async () => {
          controller.signal.throwIfAborted();
          if (job.kind === SESSION_REVIEW_JOB_KIND) {
            const review = options.reviewSession;
            if (!review) throw new Error("Session review is not configured");
            const payload = SessionReviewJobPayloadSchema.parse(job.payload);
            return toJsonValue(
              await review(
                Object.freeze({
                  sessionId: payload.sessionId,
                  turnId: payload.turnId,
                  occurredAt: payload.occurredAt,
                  project: Object.freeze(payload.project),
                }),
                controller.signal,
              ),
            );
          }
          const view = decodeJob(job);
          const result = await options.learning.reflectSettledTurn(view.payload, controller.signal);
          return toJsonValue(result);
        },
      );
      if (!scheduled.ok) {
        if (scheduled.originalError !== undefined) throw scheduled.originalError;
        throw new Error(`Capability reflection ${scheduled.code}: ${scheduled.reason}`);
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
      await options.workspace.jobs.fail({
        jobId: job.jobId,
        leaseToken,
        now: iso(now()),
        retryAt: iso(new Date(now().getTime() + Math.min(60_000, 1_000 * 2 ** (job.attempt - 1)))),
        failure: failureFrom(error, controller.signal.aborted && stopping),
      });
    } finally {
      clearInterval(heartbeat);
      active.delete(job.jobId);
    }
  };

  const drain = async (): Promise<boolean> => {
    for (let claimedCount = 0; !stopping && claimedCount < 24; claimedCount += 1) {
      const job = await options.workspace.jobs.claim({
        workerId,
        now: iso(now()),
        leaseUntil: iso(new Date(now().getTime() + REFLECTION_LEASE_MS)),
        maximumCost: 24 - claimedCount,
        kinds: Object.freeze(
          options.reviewSession
            ? [CAPABILITY_REFLECTION_JOB_KIND, SESSION_REVIEW_JOB_KIND]
            : [CAPABILITY_REFLECTION_JOB_KIND],
        ),
      });
      if (!job || stopping) return false;
      await execute(job);
    }
    return !stopping;
  };

  function runAvailable(): Promise<void> {
    if (stopping) return Promise.resolve();
    if (draining) return draining;
    let exhausted = false;
    const next = drain()
      .then((shouldContinue) => {
        exhausted = shouldContinue;
      })
      .finally(() => {
        if (draining === next) draining = undefined;
        if (exhausted && !stopping) runInBackground();
      });
    draining = next;
    return next;
  }

  const waitForTerminal: CapabilityCoordinator["waitForTerminal"] = async (request) => {
    const deadlineMs = request.deadline.getTime();
    if (!Number.isFinite(deadlineMs)) throw new Error("Capability reflection wait needs a valid deadline");
    for (;;) {
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      if (request.signal?.aborted) return Object.freeze({ status: "cancelled" as const });
      const job = await options.workspace.jobs.get(request.jobId);
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      if (!job) return Object.freeze({ status: "missing" as const });
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      if (TERMINAL_JOB_STATUSES.has(job.status)) return Object.freeze({ status: "terminal" as const, job });
      const remaining = deadlineMs - Date.now();
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      if (remaining <= 0) return Object.freeze({ status: "timeout" as const });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(25, remaining));
        timer.unref();
      });
    }
  };

  // Held reflections become due without any event, so check for them periodically.
  const delayedJobPoll = setInterval(() => runInBackground(), DELAYED_JOB_POLL_MS);
  delayedJobPoll.unref();

  const stop = async (): Promise<void> => {
    stopping = true;
    clearInterval(delayedJobPoll);
    for (const controller of active.values()) controller.abort("runtime_stopped");
    await draining;
  };

  runInBackground();
  return Object.freeze({
    observeSettledTurn,
    releaseSession,
    runAvailable,
    idle: runAvailable,
    waitForTerminal,
    stop,
  });
}
