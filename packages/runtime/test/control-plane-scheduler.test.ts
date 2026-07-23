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
    const controlPlane = createRuntimeControlPlane({
      workspace,
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
  });
});
