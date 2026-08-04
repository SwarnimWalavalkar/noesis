import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceStore } from "@noesis/workspace";
import { afterEach, describe, expect, test } from "vitest";
import {
  createRuntimeControlPlane,
  type AtomicActivationController,
  type ContinuousFeedbackController,
  type RuntimeControlPlaneTimerHandle,
  type RuntimeControlPlaneTimers,
  type RuntimeCoordinator,
} from "../src/index.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

function unsupported(): never {
  throw new Error("This scheduler fixture does not exercise the operation");
}

describe("runtime control-plane resident scheduling", () => {
  test("startup recovery re-arms at durable notBefore without a busy loop and stop cancels the timer", async () => {
    let nowMs = Date.parse("2026-07-23T00:00:00.000Z");
    const root = await mkdtemp(join(tmpdir(), "noesis-control-plane-timer-"));
    roots.push(root);
    const workspace = await createWorkspaceStore(root, {
      now: () => new Date(nowMs).toISOString(),
    });
    const deferredJobIds = await Promise.all(
      Array.from({ length: 1_001 }, async (_, index) => {
        const jobId = `deferred-runtime-${String(index).padStart(4, "0")}`;
        await workspace.jobs.enqueue({
          jobId,
          kind: "runtime.author_revision",
          payload: Object.freeze({}),
          payloadRefs: Object.freeze([]),
          operationId: `operation:${jobId}`,
          idempotencyKey: `operation:${jobId}`,
          notBefore: new Date(nowMs + 2_000).toISOString(),
          maxAttempts: 1,
          estimatedCost: 0,
          budget: 0,
        });
        return jobId;
      }),
    );
    const job = await workspace.jobs.enqueue({
      jobId: "job-future",
      kind: "runtime.reflect_turn",
      payload: Object.freeze({}),
      payloadRefs: Object.freeze([]),
      operationId: "future-operation",
      idempotencyKey: "future-operation",
      notBefore: new Date(nowMs + 1_000).toISOString(),
      maxAttempts: 1,
      estimatedCost: 1,
      budget: 1,
    });

    let sequence = 0;
    const scheduled = new Map<
      number,
      { readonly at: number; readonly callback: () => void; cancelled: boolean; unrefed: boolean }
    >();
    const timers: RuntimeControlPlaneTimers = Object.freeze({
      setTimeout: (callback: () => void, delayMs: number): RuntimeControlPlaneTimerHandle => {
        sequence += 1;
        const timer = { at: nowMs + delayMs, callback, cancelled: false, unrefed: false };
        scheduled.set(sequence, timer);
        return Object.freeze({
          cancel: () => {
            timer.cancelled = true;
          },
          unref: () => {
            timer.unrefed = true;
          },
        });
      },
      clearTimeout: (handle: RuntimeControlPlaneTimerHandle) => handle.cancel(),
    });
    let drains = 0;
    const coordinator: RuntimeCoordinator = Object.freeze({
      observeCompletedTurn: async () => unsupported(),
      runAvailable: async () => {
        drains += 1;
        const claimed = await workspace.jobs.claim({
          workerId: "fake-resident-worker",
          now: new Date(nowMs).toISOString(),
          leaseUntil: new Date(nowMs + 10_000).toISOString(),
          maximumCost: 1,
          kinds: Object.freeze(["runtime.reflect_turn"]),
        });
        if (claimed?.leaseToken)
          await workspace.jobs.complete({
            jobId: claimed.jobId,
            leaseToken: claimed.leaseToken,
            now: new Date(nowMs).toISOString(),
          });
      },
      idle: async () => undefined,
      cancel: async () => undefined,
      retry: async () => unsupported(),
      getJob: async () => undefined,
      listJobs: async () => Object.freeze([]),
      listJobPage: async () => Object.freeze({ jobs: Object.freeze([]), exhausted: true }),
      getPreflightActivationHandoff: async () => undefined,
      stop: async () => undefined,
    });
    const activation: AtomicActivationController = Object.freeze({
      activateFromPreflight: async () => unsupported(),
      approve: async () => unsupported(),
      reject: async () => unsupported(),
      getOperation: async () => undefined,
      pinTurnActivation: async () => unsupported(),
    });
    const feedback: ContinuousFeedbackController = Object.freeze({
      observeTurnOutcome: async () => unsupported(),
      evaluateExperiment: async () => undefined,
      experimentComparison: async () => unsupported(),
      capabilityHealth: async () => unsupported(),
      runAvailable: async () => undefined,
      cancel: async () => undefined,
      stop: async () => undefined,
    });
    const listRequests: Array<Parameters<typeof workspace.jobs.listPage>[0]> = [];
    const controlPlane = createRuntimeControlPlane({
      workspace: Object.freeze({
        research: workspace.research,
        jobs: Object.freeze({
          ...workspace.jobs,
          listPage: async (request = {}) => {
            listRequests.push(request);
            return await workspace.jobs.listPage(request);
          },
        }),
      }),
      coordinator,
      activation,
      feedback,
      now: () => new Date(nowMs),
      timers,
    });

    await controlPlane.idle();
    expect(await workspace.jobs.get(job.jobId)).toMatchObject({ status: "scheduled", attempt: 0 });
    const armed = [...scheduled.values()].filter((timer) => !timer.cancelled);
    expect(armed).toHaveLength(1);
    expect(armed[0]).toMatchObject({ at: nowMs + 1_000, unrefed: true });
    expect(drains).toBe(1);
    expect(listRequests.length).toBeGreaterThan(2);
    expect(
      listRequests.every(
        (request) =>
          (request?.status === "scheduled" || request?.status === "running") &&
          request.kind !== undefined &&
          [
            "runtime.reflect_turn",
            "runtime.author_revision",
            "runtime.preflight",
            "runtime.outcome_judge",
          ].includes(request.kind),
      ),
    ).toBe(true);
    expect(
      listRequests.some(
        (request) =>
          request?.status === "scheduled" &&
          request.kind === "runtime.author_revision" &&
          request.after !== undefined,
      ),
    ).toBe(true);

    await Promise.all(
      deferredJobIds.map(async (jobId) => await workspace.jobs.cancel(jobId, new Date(nowMs).toISOString())),
    );

    nowMs += 1_000;
    if (armed[0]) armed[0].cancelled = true;
    armed[0]?.callback();
    await controlPlane.idle();
    expect(await workspace.jobs.get(job.jobId)).toMatchObject({ status: "completed", attempt: 1 });
    expect(drains).toBe(2);
    expect([...scheduled.values()].filter((timer) => !timer.cancelled)).toHaveLength(0);

    await controlPlane.stop();
    expect([...scheduled.values()].filter((timer) => !timer.cancelled)).toHaveLength(0);
    workspace.close();
  }, 30_000);

  test("stop prevents later lifecycle stages when coordinator draining settles afterward", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-control-plane-stop-"));
    roots.push(root);
    const workspace = await createWorkspaceStore(root);
    let markCoordinatorStarted: (() => void) | undefined;
    const coordinatorStarted = new Promise<void>((resolve) => {
      markCoordinatorStarted = resolve;
    });
    let releaseCoordinator: (() => void) | undefined;
    const coordinatorBlocked = new Promise<void>((resolve) => {
      releaseCoordinator = resolve;
    });
    let coordinatorStops = 0;
    let feedbackRuns = 0;
    let feedbackStops = 0;
    let activationAttempts = 0;
    const coordinator: RuntimeCoordinator = Object.freeze({
      observeCompletedTurn: async () => unsupported(),
      runAvailable: async () => {
        markCoordinatorStarted?.();
        await coordinatorBlocked;
      },
      idle: async () => undefined,
      cancel: async () => undefined,
      retry: async () => unsupported(),
      getJob: async () => undefined,
      listJobs: async () => Object.freeze([]),
      listJobPage: async () => Object.freeze({ jobs: Object.freeze([]), exhausted: true }),
      getPreflightActivationHandoff: async () => undefined,
      stop: async () => {
        coordinatorStops += 1;
      },
    });
    const activation: AtomicActivationController = Object.freeze({
      activateFromPreflight: async () => {
        activationAttempts += 1;
        return unsupported();
      },
      approve: async () => unsupported(),
      reject: async () => unsupported(),
      getOperation: async () => undefined,
      pinTurnActivation: async () => unsupported(),
    });
    const feedback: ContinuousFeedbackController = Object.freeze({
      observeTurnOutcome: async () => unsupported(),
      evaluateExperiment: async () => undefined,
      experimentComparison: async () => unsupported(),
      capabilityHealth: async () => unsupported(),
      runAvailable: async () => {
        feedbackRuns += 1;
      },
      cancel: async () => undefined,
      stop: async () => {
        feedbackStops += 1;
      },
    });
    const controlPlane = createRuntimeControlPlane({
      workspace,
      coordinator,
      activation,
      feedback,
      autoStart: false,
    });

    const running = controlPlane.runAvailable();
    await coordinatorStarted;
    const stopping = controlPlane.stop();
    releaseCoordinator?.();
    await Promise.all([running, stopping]);

    expect(coordinatorStops).toBe(1);
    expect(feedbackStops).toBe(1);
    expect(feedbackRuns).toBe(0);
    expect(activationAttempts).toBe(0);
    workspace.close();
  });
});
