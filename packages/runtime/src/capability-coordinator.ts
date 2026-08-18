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
} from "@noesis/learning";
import type { AuthorityBoundary } from "@noesis/policy";
import type { NoesisWorkspaceStore } from "@noesis/workspace";
import { z } from "zod";
import { authorizeScheduledJob, runScheduledJob } from "./scheduled-execution.ts";

export const CAPABILITY_REFLECTION_JOB_KIND = "runtime.reflect_capability" as const;
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled", "budget_exhausted"]);
const REFLECTION_LEASE_MS = 120_000;
const REFLECTION_HEARTBEAT_MS = 30_000;

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
  readonly now?: () => Date;
  readonly workerId?: string;
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

function failureFrom(error: unknown): DurableJobFailure {
  return (
    durableJobFailureFromError(error) ??
    Object.freeze({
      code: "capability_reflection_failed",
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
      ambiguous: false,
    })
  );
}

export function createCapabilityCoordinator(
  options: CreateCapabilityCoordinatorOptions,
): CapabilityCoordinator {
  const now = options.now ?? (() => new Date());
  const workerId = options.workerId ?? `capability-coordinator:${process.pid}`;
  const active = new Map<string, AbortController>();
  let draining: Promise<void> | undefined;
  let stopping = false;

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
        notBefore: iso(now()),
        maxAttempts: 3,
        estimatedCost: 1,
        budget: 3,
      });
    } catch (error) {
      const existing = await options.workspace.jobs.get(jobId);
      if (!existing || canonicalJson(existing.payload) !== canonicalJson(payload)) throw error;
      job = existing;
    }
    queueMicrotask(() => void runAvailable());
    return decodeJob(job);
  };

  const execute = async (job: DurableJobRecord): Promise<void> => {
    const view = decodeJob(job);
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
        async () => toJsonValue(await options.learning.reflectSettledTurn(view.payload, controller.signal)),
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
        failure: failureFrom(error),
      });
    } finally {
      clearInterval(heartbeat);
      active.delete(job.jobId);
    }
  };

  const drain = async (): Promise<void> => {
    for (let claimedCount = 0; !stopping && claimedCount < 24; claimedCount += 1) {
      const job = await options.workspace.jobs.claim({
        workerId,
        now: iso(now()),
        leaseUntil: iso(new Date(now().getTime() + REFLECTION_LEASE_MS)),
        maximumCost: 24 - claimedCount,
        kinds: Object.freeze([CAPABILITY_REFLECTION_JOB_KIND]),
      });
      if (!job || stopping) return;
      await execute(job);
    }
  };

  function runAvailable(): Promise<void> {
    if (stopping) return Promise.resolve();
    if (draining) return draining;
    const next = drain().finally(() => {
      if (draining === next) draining = undefined;
    });
    draining = next;
    return next;
  }

  const waitForTerminal: CapabilityCoordinator["waitForTerminal"] = async (request) => {
    const deadlineMs = request.deadline.getTime();
    if (!Number.isFinite(deadlineMs)) throw new Error("Capability reflection wait needs a valid deadline");
    for (;;) {
      if (request.signal?.aborted) return Object.freeze({ status: "cancelled" as const });
      const job = await options.workspace.jobs.get(request.jobId);
      if (!job) return Object.freeze({ status: "missing" as const });
      if (TERMINAL_JOB_STATUSES.has(job.status)) return Object.freeze({ status: "terminal" as const, job });
      const remaining = deadlineMs - Date.now();
      if (remaining <= 0) return Object.freeze({ status: "timeout" as const });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(25, remaining));
        timer.unref();
      });
    }
  };

  const stop = async (): Promise<void> => {
    stopping = true;
    for (const controller of active.values()) controller.abort("runtime_stopped");
    await draining;
  };

  queueMicrotask(() => void runAvailable());
  return Object.freeze({
    observeSettledTurn,
    runAvailable,
    idle: runAvailable,
    waitForTerminal,
    stop,
  });
}
