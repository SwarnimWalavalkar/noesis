import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceStore, type NoesisWorkspaceStore } from "@noesis/workspace";
import { afterEach, describe, expect, test } from "vitest";
import { createWorkspaceRuntimeInternals } from "../../workspace/src/protected-runtime.ts";
import { createCapabilityCoordinator } from "../src/capability-coordinator.ts";

const opened: { readonly root: string; readonly workspace: NoesisWorkspaceStore }[] = [];

afterEach(async () => {
  for (const item of opened.splice(0)) {
    item.workspace.close();
    await rm(item.root, { recursive: true, force: true });
  }
});

describe("Capability coordinator", () => {
  test("settles a completed reflection when shutdown arrives after the lifecycle mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-capability-coordinator-"));
    const workspace = await createWorkspaceStore(root);
    opened.push({ root, workspace });
    const timestamp = new Date().toISOString();
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
          // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
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
    // The reflection waits for the user's reaction. The next user message releases it.
    expect(observed.job.notBefore > timestamp).toBe(true);
    await coordinator.releaseSession("session-1");
    await started;
    const stopped = coordinator.stop();
    releaseReflection?.();
    await stopped;

    expect(reflectCalls).toBe(1);
    expect(await workspace.jobs.get(observed.job.jobId)).toMatchObject({
      status: "completed",
      result: { status: "no_change", reason: "Lifecycle mutation committed" },
    });
  });

  test("holds a reflection until the session goes idle when the user does not reply", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-capability-coordinator-idle-"));
    const workspace = await createWorkspaceStore(root);
    opened.push({ root, workspace });
    const start = new Date("2026-10-29T10:00:00.000Z");
    let current = start;
    await workspace.operational.sessions.put({
      sessionId: "session-idle",
      title: "Idle reflection",
      status: "idle",
      provider: "fake",
      model: "fake",
      runtime: "fake",
      createdAt: start.toISOString(),
      updatedAt: start.toISOString(),
      metadata: Object.freeze({}),
    });
    const evidence = await workspace.operational.messages.put({
      messageId: "turn-idle:user",
      sessionId: "session-idle",
      role: "user",
      content: "Summarize the plan.",
      sensitivity: "normal",
      createdAt: start.toISOString(),
      metadata: Object.freeze({ turnId: "turn-idle" }),
    });
    let reflectCalls = 0;
    const coordinator = createCapabilityCoordinator({
      workspace,
      authority: createWorkspaceRuntimeInternals(workspace).authority,
      learning: Object.freeze({
        reflectSettledTurn: async () => {
          reflectCalls += 1;
          // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
          return Object.freeze({ status: "no_change" as const, reason: "Nothing lasting" });
        },
      }),
      now: () => current,
      exchangeIdleMs: 60_000,
      workerId: "capability-coordinator-idle-test",
    });
    try {
      const observed = await coordinator.observeSettledTurn({
        turn: Object.freeze({
          sessionId: "session-idle",
          turnId: "turn-idle",
          userMessage: "Summarize the plan.",
          outcome: "unknown",
          cause: "completed",
          servedWorkingAdjustmentOutcomes: Object.freeze([]),
          scope: "general",
          sensitivity: "normal",
          evidenceRefs: [evidence],
          telemetry: Object.freeze({ retryCount: 0, toolFailureCount: 0, aborted: false }),
          occurredAt: start.toISOString(),
        }),
        project: Object.freeze({ projectId: "project-1", root }),
        selectedCapabilities: Object.freeze([]),
      });
      await coordinator.runAvailable();
      expect(reflectCalls).toBe(0);
      expect((await workspace.jobs.get(observed.job.jobId))?.status).toBe("scheduled");

      current = new Date(start.getTime() + 60_000);
      await coordinator.runAvailable();
      expect(reflectCalls).toBe(1);
      expect((await workspace.jobs.get(observed.job.jobId))?.status).toBe("completed");
    } finally {
      await coordinator.stop();
    }
  });
});
