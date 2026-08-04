import type { DurableJobRecord, DurableJobStatus } from "@noesis/domain";
import type {
  AuthorRevisionJobPayload,
  CoordinatorJobView,
  PreflightJobPayload,
  ReflectTurnJobPayload,
  RuntimeCoordinator,
} from "@noesis/runtime";
import { describe, expect, test } from "vitest";
import { learningActivityForSession, loadLearningActivityForSession } from "../src/learning-read-model.ts";

const evidence = Object.freeze({
  kind: "database_row" as const,
  table: "messages" as const,
  rowId: "message-1",
});
const baseline = Object.freeze({
  kind: "capability_revision" as const,
  capabilityId: "general-collaboration",
  capabilityRevisionId: "general-collaboration-v1",
  bundleDigest: "a".repeat(64),
});

function isReflectionJob(job: CoordinatorJobView): job is CoordinatorJobView & {
  readonly kind: "runtime.reflect_turn";
  readonly payload: ReflectTurnJobPayload;
} {
  return job.kind === "runtime.reflect_turn";
}

function isExperimentJob(job: CoordinatorJobView): job is CoordinatorJobView & {
  readonly kind: "runtime.author_revision" | "runtime.preflight";
  readonly payload: AuthorRevisionJobPayload | PreflightJobPayload;
} {
  return job.kind === "runtime.author_revision" || job.kind === "runtime.preflight";
}

function record(input: {
  readonly jobId: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly status: DurableJobStatus;
  readonly updatedAt: string;
  readonly result?: unknown;
  readonly error?: string;
}): DurableJobRecord {
  return Object.freeze({
    jobId: input.jobId,
    kind: input.kind,
    payload: input.payload,
    payloadRefs: Object.freeze([evidence]),
    operationId: `operation:${input.jobId}`,
    idempotencyKey: `idempotency:${input.jobId}`,
    status: input.status,
    notBefore: "2026-08-01T00:00:00.000Z",
    attempt: input.status === "scheduled" ? 0 : 1,
    maxAttempts: 3,
    estimatedCost: 1,
    budgetRemaining: 2,
    ...(input.result === undefined ? {} : { result: input.result }),
    ...(input.error
      ? {
          lastError: Object.freeze({
            code: "research_failed",
            message: input.error,
            retryable: false,
            ambiguous: false,
          }),
        }
      : {}),
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: input.updatedAt,
    ...(input.status === "completed" || input.status === "failed" ? { completedAt: input.updatedAt } : {}),
  });
}

function reflection(input: {
  readonly jobId: string;
  readonly sessionId: string;
  readonly status: DurableJobStatus;
  readonly updatedAt: string;
  readonly result?: unknown;
}): CoordinatorJobView {
  const payload: ReflectTurnJobPayload = Object.freeze({
    schemaVersion: 1,
    turn: Object.freeze({
      sessionId: input.sessionId,
      turnId: `${input.sessionId}:turn`,
      scope: "general",
      userMessage: "Useful completed work",
      outcome: "accepted",
      occurredAt: "2026-08-01T00:00:00.000Z",
      evidenceRefs: [evidence],
      sensitivity: "normal",
      telemetry: Object.freeze({ retryCount: 0, toolFailureCount: 0, aborted: false }),
    }),
    baselineRevision: baseline,
    capability: Object.freeze({
      capabilityId: "general-collaboration",
      name: "General collaboration",
      scope: "general",
      intent: "collaborate",
    }),
    retrievalStrategyId: "session-search.hybrid.v1",
    retrievalStrategyReason: "Use relevant session history",
    routingStrategyId: "router.default.v1",
  });
  return Object.freeze({
    kind: "runtime.reflect_turn",
    payload,
    job: record({
      jobId: input.jobId,
      kind: "runtime.reflect_turn",
      payload,
      status: input.status,
      updatedAt: input.updatedAt,
      ...(input.result === undefined ? {} : { result: input.result }),
    }),
  });
}

function author(input: {
  readonly jobId: string;
  readonly experimentId: string;
  readonly status: DurableJobStatus;
  readonly updatedAt: string;
  readonly result?: unknown;
  readonly error?: string;
  readonly sourceSessionId?: string;
  readonly parentJobId?: string;
}): CoordinatorJobView {
  const payload: AuthorRevisionJobPayload = Object.freeze({
    schemaVersion: 1,
    experimentId: input.experimentId,
    ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
    ...(input.parentJobId ? { parentJobId: input.parentJobId } : {}),
    hypothesisDedupeKey: `hypothesis:${input.experimentId}`,
    retrievalStrategyId: "session-search.hybrid.v1",
    routingStrategyId: "router.default.v1",
  });
  return Object.freeze({
    kind: "runtime.author_revision",
    payload,
    job: record({
      jobId: input.jobId,
      kind: "runtime.author_revision",
      payload,
      status: input.status,
      updatedAt: input.updatedAt,
      ...(input.result === undefined ? {} : { result: input.result }),
      ...(input.error ? { error: input.error } : {}),
    }),
  });
}

function preflight(
  experimentId: string,
  lineage: { readonly sourceSessionId?: string; readonly parentJobId?: string } = {},
): CoordinatorJobView {
  const payload: PreflightJobPayload = Object.freeze({
    schemaVersion: 1,
    experimentId,
    ...(lineage.sourceSessionId ? { sourceSessionId: lineage.sourceSessionId } : {}),
    ...(lineage.parentJobId ? { parentJobId: lineage.parentJobId } : {}),
    preflightId: "preflight-1",
    planId: "plan-1",
    retrievalStrategyId: "session-search.hybrid.v1",
    routingStrategyId: "router.default.v1",
  });
  return Object.freeze({
    kind: "runtime.preflight",
    payload,
    job: record({
      jobId: "preflight-complete",
      kind: "runtime.preflight",
      payload,
      status: "completed",
      updatedAt: "2026-08-01T00:00:05.000Z",
      result: {
        experimentId,
        decision: "pass",
        candidateRevision: {
          kind: "capability_revision",
          capabilityId: "research-brief",
          capabilityRevisionId: "research-brief-v2",
          bundleDigest: "b".repeat(64),
        },
      },
    }),
  });
}

describe("ambient learning read model", () => {
  test("projects authoritative job state and follows only this session's experiment chain", () => {
    const experimentId = "experiment-session-a";
    const activity = learningActivityForSession(
      [
        reflection({
          jobId: "reflection-running",
          sessionId: "session-a",
          status: "running",
          updatedAt: "2026-08-01T00:00:01.000Z",
        }),
        reflection({
          jobId: "reflection-no-change",
          sessionId: "session-a",
          status: "completed",
          updatedAt: "2026-08-01T00:00:02.000Z",
          result: { status: "no_change", reason: "The turn already worked well" },
        }),
        reflection({
          jobId: "reflection-experiment",
          sessionId: "session-a",
          status: "completed",
          updatedAt: "2026-08-01T00:00:03.000Z",
          result: { status: "experiment", experimentId },
        }),
        author({
          jobId: "author-failed",
          experimentId,
          status: "failed",
          updatedAt: "2026-08-01T00:00:04.000Z",
          error: "Candidate source could not be validated",
        }),
        preflight(experimentId),
        reflection({
          jobId: "other-reflection",
          sessionId: "session-b",
          status: "completed",
          updatedAt: "2026-08-01T00:00:06.000Z",
          result: { status: "experiment", experimentId: "experiment-session-b" },
        }),
        author({
          jobId: "other-author",
          experimentId: "experiment-session-b",
          status: "scheduled",
          updatedAt: "2026-08-01T00:00:07.000Z",
        }),
        author({
          jobId: "modern-local-payload-only-author",
          experimentId,
          status: "completed",
          updatedAt: "2026-08-01T00:00:07.500Z",
          sourceSessionId: "session-a",
          parentJobId: "reflection-experiment",
        }),
        author({
          jobId: "modern-foreign-author",
          experimentId,
          status: "completed",
          updatedAt: "2026-08-01T00:00:08.000Z",
          sourceSessionId: "session-b",
          parentJobId: "other-reflection",
        }),
      ],
      "session-a",
    );

    expect(activity.map(({ jobId }) => jobId)).toEqual([
      "preflight-complete",
      "author-failed",
      "reflection-experiment",
      "reflection-no-change",
      "reflection-running",
    ]);
    expect(activity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          jobId: "reflection-running",
          stage: "reflection",
          status: "running",
          capabilityId: "general-collaboration",
        }),
        expect.objectContaining({
          jobId: "reflection-no-change",
          status: "no_change",
          summary: "The turn already worked well",
        }),
        expect.objectContaining({
          jobId: "author-failed",
          status: "failed",
          failure: "Candidate source could not be validated",
          experimentId,
        }),
        expect.objectContaining({
          jobId: "preflight-complete",
          status: "completed",
          summary: "Preflight decision: pass",
          capabilityId: "research-brief",
          capabilityRevisionId: "research-brief-v2",
        }),
      ]),
    );
    expect(activity.some(({ jobId }) => jobId === "modern-foreign-author")).toBe(false);
    expect(activity.some(({ jobId }) => jobId === "modern-local-payload-only-author")).toBe(false);
  });

  test("loads a session and its experiment chain beyond one thousand older unrelated jobs", async () => {
    const unrelated = Array.from({ length: 1_001 }, (_, index) =>
      reflection({
        jobId: `reflection-unrelated-${String(index).padStart(4, "0")}`,
        sessionId: `unrelated-${String(index)}`,
        status: "completed",
        updatedAt: "2026-08-01T00:00:01.000Z",
        result: { status: "no_change", reason: "Unrelated turn" },
      }),
    );
    const targetExperiment = "experiment-target-session";
    const jobs: readonly CoordinatorJobView[] = Object.freeze([
      ...unrelated,
      reflection({
        jobId: "reflection-zz-target",
        sessionId: "target-session",
        status: "failed",
        updatedAt: "2026-08-01T00:00:02.000Z",
      }),
      author({
        jobId: "author-target",
        experimentId: targetExperiment,
        status: "failed",
        updatedAt: "2026-08-01T00:00:03.000Z",
        error: "Target author failure",
        sourceSessionId: "target-session",
        parentJobId: "reflection-zz-target",
      }),
      preflight(targetExperiment, {
        sourceSessionId: "target-session",
        parentJobId: "author-target",
      }),
      author({
        jobId: "modern-foreign-fallback",
        experimentId: targetExperiment,
        status: "completed",
        updatedAt: "2026-08-01T00:00:04.000Z",
        sourceSessionId: "other-session",
        parentJobId: "other-reflection",
      }),
    ]);
    const requests: Array<NonNullable<Parameters<RuntimeCoordinator["listJobPage"]>[0]>> = [];
    const listJobPage: RuntimeCoordinator["listJobPage"] = async (request = {}) => {
      requests.push(request);
      const ordered = jobs
        .filter(({ kind }) => !request.kind || kind === request.kind)
        .filter(
          (job) =>
            !request.sessionId ||
            (isReflectionJob(job) && job.payload.turn.sessionId === request.sessionId) ||
            (isExperimentJob(job) && job.payload.sourceSessionId === request.sessionId),
        )
        .filter(
          (job) =>
            !request.experimentIds ||
            (isExperimentJob(job) && request.experimentIds.includes(job.payload.experimentId)),
        )
        .filter(({ job }) => {
          if (!request.after) return true;
          return (
            job.createdAt > request.after.createdAt ||
            (job.createdAt === request.after.createdAt && job.jobId > request.after.jobId)
          );
        })
        .sort(
          (left, right) =>
            left.job.createdAt.localeCompare(right.job.createdAt) ||
            left.job.jobId.localeCompare(right.job.jobId),
        );
      const limit = request.limit ?? 100;
      const page = Object.freeze(ordered.slice(0, limit));
      const last = page.at(-1)?.job;
      return Object.freeze({
        jobs: page,
        exhausted: page.length < limit,
        ...(last ? { nextCursor: Object.freeze({ createdAt: last.createdAt, jobId: last.jobId }) } : {}),
      });
    };

    const activity = await loadLearningActivityForSession({ listJobPage }, "target-session");

    expect(activity.map(({ jobId }) => jobId)).toEqual([
      "preflight-complete",
      "author-target",
      "reflection-zz-target",
    ]);
    expect(activity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          jobId: "author-target",
          experimentId: targetExperiment,
          failure: "Target author failure",
        }),
      ]),
    );
    expect(activity.some(({ summary }) => summary === "Unrelated turn")).toBe(false);
    expect(activity.some(({ jobId }) => jobId === "modern-foreign-fallback")).toBe(false);
    expect(requests).toHaveLength(5);
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "runtime.reflect_turn", sessionId: "target-session" }),
        expect.objectContaining({ kind: "runtime.author_revision", sessionId: "target-session" }),
        expect.objectContaining({ kind: "runtime.preflight", sessionId: "target-session" }),
        expect.objectContaining({
          kind: "runtime.author_revision",
          experimentIds: [targetExperiment],
        }),
        expect.objectContaining({ kind: "runtime.preflight", experimentIds: [targetExperiment] }),
      ]),
    );
    expect(
      requests.every((request) => request.sessionId !== undefined || request.experimentIds !== undefined),
    ).toBe(true);
  });

  test("continues after a full raw page decodes to no coordinator jobs", async () => {
    const target = reflection({
      jobId: "reflection-after-legacy-row",
      sessionId: "target-session",
      status: "completed",
      updatedAt: "2026-08-01T00:00:02.000Z",
      result: { status: "no_change", reason: "Valid reflection after legacy row" },
    });
    const legacyCursor = Object.freeze({
      createdAt: "2026-08-01T00:00:00.000Z",
      jobId: "legacy-undecodable-row",
    });
    const listJobPage: RuntimeCoordinator["listJobPage"] = async ({ kind, after, sessionId } = {}) => {
      if (kind !== "runtime.reflect_turn") return Object.freeze({ jobs: Object.freeze([]), exhausted: true });
      expect(sessionId).toBe("target-session");
      if (!after)
        return Object.freeze({
          jobs: Object.freeze([]),
          exhausted: false,
          nextCursor: legacyCursor,
        });
      return Object.freeze({ jobs: Object.freeze([target]), exhausted: true });
    };

    const activity = await loadLearningActivityForSession({ listJobPage }, "target-session");

    expect(activity).toEqual([
      expect.objectContaining({
        jobId: "reflection-after-legacy-row",
        summary: "Valid reflection after legacy row",
      }),
    ]);
  });

  test("processes experiment chunks sequentially without truncating the session chain", async () => {
    const experimentIds = Array.from(
      { length: 251 },
      (_, index) => `experiment-${String(index).padStart(3, "0")}`,
    );
    const reflections = experimentIds.map((experimentId, index) =>
      reflection({
        jobId: `reflection-${String(index).padStart(3, "0")}`,
        sessionId: "target-session",
        status: "completed",
        updatedAt: "2026-08-01T00:00:01.000Z",
        result: { status: "experiment", experimentId },
      }),
    );
    const authors = experimentIds.map((experimentId, index) =>
      author({
        jobId: `author-${String(index).padStart(3, "0")}`,
        experimentId,
        status: "completed",
        updatedAt: "2026-08-01T00:00:02.000Z",
      }),
    );
    const requestedChunkSizes: number[] = [];
    let concurrentExperimentQueries = 0;
    let maximumConcurrentExperimentQueries = 0;
    const listJobPage: RuntimeCoordinator["listJobPage"] = async (request = {}) => {
      if (request.kind === "runtime.reflect_turn")
        return Object.freeze({ jobs: Object.freeze(reflections), exhausted: true });
      if (request.experimentIds) requestedChunkSizes.push(request.experimentIds.length);
      concurrentExperimentQueries += 1;
      maximumConcurrentExperimentQueries = Math.max(
        maximumConcurrentExperimentQueries,
        concurrentExperimentQueries,
      );
      await Promise.resolve();
      const jobs =
        request.kind === "runtime.author_revision"
          ? authors.filter(
              (job) => isExperimentJob(job) && request.experimentIds?.includes(job.payload.experimentId),
            )
          : [];
      concurrentExperimentQueries -= 1;
      return Object.freeze({ jobs: Object.freeze(jobs), exhausted: true });
    };

    const activity = await loadLearningActivityForSession({ listJobPage }, "target-session");

    expect(maximumConcurrentExperimentQueries).toBe(2);
    expect(requestedChunkSizes).toEqual([250, 250, 1, 1]);
    expect(activity.filter(({ stage }) => stage === "reflection")).toHaveLength(251);
    expect(activity.filter(({ stage }) => stage === "authoring")).toHaveLength(251);
  });
});
