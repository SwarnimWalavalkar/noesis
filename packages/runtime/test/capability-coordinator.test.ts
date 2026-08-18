import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceStore } from "@noesis/workspace";
import { afterEach, describe, expect, test } from "vitest";
import { createWorkspaceRuntimeInternals } from "../../workspace/src/protected-runtime.ts";
import { createCapabilityCoordinator } from "../src/capability-coordinator.ts";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("Capability coordinator", () => {
  test("settles a completed reflection when shutdown arrives after the lifecycle mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-capability-coordinator-"));
    roots.push(root);
    const workspace = await createWorkspaceStore(root);
    const timestamp = "2026-08-19T00:00:00.000Z";
    await workspace.operational.sessions.put({
      sessionId: "session-1",
      title: "Capability reflection",
      status: "idle",
      provider: "fake",
      model: "fake",
      runtime: "fake",
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: Object.freeze({}),
    });
    const evidence = await workspace.operational.messages.put({
      messageId: "turn-1:user",
      sessionId: "session-1",
      role: "user",
      content: "Remember this preference.",
      sensitivity: "normal",
      createdAt: timestamp,
      metadata: Object.freeze({ turnId: "turn-1" }),
    });
    let reflectCalls = 0;
    let releaseReflection: (() => void) | undefined;
    const reflectionCanReturn = new Promise<void>((resolve) => {
      releaseReflection = resolve;
    });
    let reflectionStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      reflectionStarted = resolve;
    });
    const coordinator = createCapabilityCoordinator({
      workspace,
      authority: createWorkspaceRuntimeInternals(workspace).authority,
      learning: Object.freeze({
        reflectSettledTurn: async () => {
          reflectCalls += 1;
          reflectionStarted?.();
          await reflectionCanReturn;
          return Object.freeze({ status: "no_change" as const, reason: "Lifecycle mutation committed" });
        },
      }),
      now: () => new Date(timestamp),
      workerId: "capability-coordinator-test",
    });
    const observed = await coordinator.observeSettledTurn({
      turn: Object.freeze({
        sessionId: "session-1",
        turnId: "turn-1",
        userMessage: "Remember this preference.",
        outcome: "accepted",
        servedWorkingAdjustmentOutcomes: Object.freeze([]),
        scope: "general",
        sensitivity: "normal",
        evidenceRefs: [evidence],
        telemetry: Object.freeze({ retryCount: 0, toolFailureCount: 0, aborted: false }),
        occurredAt: timestamp,
      }),
      project: Object.freeze({ projectId: "project-1", root }),
      selectedCapabilities: Object.freeze([]),
    });
    await started;
    const stopped = coordinator.stop();
    releaseReflection?.();
    await stopped;

    expect(reflectCalls).toBe(1);
    expect(await workspace.jobs.get(observed.job.jobId)).toMatchObject({
      status: "completed",
      result: { status: "no_change", reason: "Lifecycle mutation committed" },
    });
    workspace.close();
  });
});
