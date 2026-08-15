import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceStore } from "@noesis/workspace";
import { describe, expect, test } from "vitest";
import { loadLearningAuditSnapshot } from "../src/learning-audit-read-model.ts";

const baseline = Object.freeze({
  kind: "capability_revision" as const,
  capabilityId: "general-collaboration",
  capabilityRevisionId: "general-collaboration-v1",
  bundleDigest: "a".repeat(64),
});

describe("learning audit read model", () => {
  test("projects only records whose authoritative origin belongs to the active project", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-learning-audit-"));
    const workspace = await createWorkspaceStore(home);
    const projects = [
      Object.freeze({ projectId: "project-a", root: "/workspace/a" }),
      Object.freeze({ projectId: "project-b", root: "/workspace/b" }),
    ] as const;
    for (let index = 0; index < 1_001; index += 1) {
      const jobId = `unrelated-${String(index).padStart(4, "0")}`;
      await workspace.jobs.enqueue({
        jobId,
        kind: "fixture.unrelated",
        payload: Object.freeze({}),
        payloadRefs: Object.freeze([]),
        operationId: `operation-${jobId}`,
        idempotencyKey: `idempotency-${jobId}`,
        notBefore: new Date(Date.UTC(2026, 7, 13, 0, 0, 0, index)).toISOString(),
        maxAttempts: 1,
        estimatedCost: 0,
        budget: 0,
      });
    }
    for (let index = 0; index < 1_001; index += 1) {
      const jobId = `old-project-a-reflection-${String(index).padStart(4, "0")}`;
      await workspace.jobs.enqueue({
        jobId,
        kind: "runtime.reflect_turn",
        payload: Object.freeze({
          turn: Object.freeze({
            project: projects[0],
            sessionId: "session-old-project-a",
            turnId: `turn-old-project-a-${String(index)}`,
            sensitivity: "normal",
          }),
        }),
        payloadRefs: Object.freeze([]),
        operationId: `operation-${jobId}`,
        idempotencyKey: `idempotency-${jobId}`,
        notBefore: new Date(Date.UTC(2026, 7, 13, 1, 0, 0, index)).toISOString(),
        maxAttempts: 1,
        estimatedCost: 0,
        budget: 0,
      });
    }
    for (const project of projects) {
      const sessionId = `session-${project.projectId}`;
      await workspace.operational.sessions.put({
        sessionId,
        title: project.projectId,
        status: "idle",
        provider: "controlled",
        model: "controlled",
        runtime: "pi",
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
        metadata: Object.freeze({}),
      });
      const messageId = `message-${project.projectId}`;
      await workspace.operational.messages.put({
        messageId,
        sessionId,
        role: "user",
        content: `Evidence from ${project.projectId}`,
        sensitivity: "normal",
        createdAt: "2026-08-14T00:00:00.000Z",
        metadata: Object.freeze({}),
      });
      const evidence = Object.freeze({
        kind: "database_row" as const,
        table: "messages" as const,
        rowId: messageId,
      });
      await workspace.jobs.enqueue({
        jobId: `reflection-${project.projectId}`,
        kind: "runtime.reflect_turn",
        payload: Object.freeze({
          turn: Object.freeze({
            project,
            sessionId,
            turnId: `turn-${project.projectId}`,
            sensitivity: "normal",
          }),
        }),
        payloadRefs: Object.freeze([evidence]),
        operationId: `reflection-operation-${project.projectId}`,
        idempotencyKey: `reflection-operation-${project.projectId}`,
        notBefore: "2026-08-14T00:00:00.000Z",
        maxAttempts: 1,
        estimatedCost: 0,
        budget: 0,
      });
      await workspace.jobs.enqueue({
        jobId: `author-${project.projectId}`,
        kind: "runtime.author_revision",
        payload: Object.freeze({
          experimentId: `experiment-${project.projectId}`,
          sourceSessionId: sessionId,
        }),
        payloadRefs: Object.freeze([evidence]),
        operationId: `author-operation-${project.projectId}`,
        idempotencyKey: `author-operation-${project.projectId}`,
        notBefore: "2026-08-14T00:00:00.000Z",
        maxAttempts: 1,
        estimatedCost: 0,
        budget: 0,
      });
      await workspace.research.experiments.putExperiment(
        Object.freeze({
          experimentId: `experiment-${project.projectId}`,
          hypothesis: `Hypothesis for ${project.projectId}`,
          scope: "general",
          evidenceRefs: Object.freeze([evidence]),
          baselineRevision: baseline,
          candidateRevisions: Object.freeze([]),
          feedbackSignalIds: Object.freeze([`signal-${project.projectId}`]),
          status: "hypothesis" as const,
        }),
      );
      await workspace.research.feedbackSignals.recordFeedbackSignal(
        Object.freeze({
          signalId: `signal-${project.projectId}`,
          kind: "turn_observation" as const,
          scope: "general",
          evidenceRefs: Object.freeze([evidence]),
          strength: 0.6,
          novelty: 0.4,
          sensitivity: project.projectId === "project-a" ? ("private" as const) : ("normal" as const),
        }),
      );
    }

    const snapshot = await loadLearningAuditSnapshot(
      {
        workspace,
        criteria: { list: async () => ({ ok: true, value: Object.freeze([]) }) },
        activations: {
          current: async () => undefined,
          listOperations: async () => Object.freeze([]),
          getApproval: async () => undefined,
        },
        feedback: {
          listObservations: async () => Object.freeze([]),
          listResearchRuns: async () => Object.freeze([]),
          getOutcome: async () => undefined,
          getSuccessorInput: async () => undefined,
        },
        continuousFeedback: {
          experimentComparison: async () => {
            throw new Error("No preflight comparison should be loaded in this fixture");
          },
        },
        resolveRevision: async () => undefined,
        resolveCapability: () => undefined,
        projectId: "project-a",
      },
      "session-project-a",
    );

    const ids = snapshot.primitives.map((primitive) => primitive.id);
    expect(ids).toContain("reflection:reflection-project-a");
    expect(ids).toContain("experiment:experiment-project-a");
    expect(ids).toContain("feedback_signal:signal-project-a");
    expect(ids.some((id) => id.includes("project-b"))).toBe(false);
    const reflection = snapshot.primitives.find(
      (primitive) => primitive.id === "reflection:reflection-project-a",
    );
    expect(reflection).toMatchObject({
      title: "scheduled",
      consideredEvidenceCount: 1,
      evidence: [],
    });
    expect(reflection?.consideredEvidencePreviews).toEqual([]);
    const privateSignal = snapshot.primitives.find(
      (primitive) => primitive.id === "feedback_signal:signal-project-a",
    );
    expect(privateSignal?.rawJson).toContain('"redacted":true');
    expect(Object.hasOwn(privateSignal ?? {}, "raw")).toBe(false);
    expect(Object.hasOwn(privateSignal ?? {}, "sensitivity")).toBe(false);
    workspace.close();
  }, 30_000);

  test("projects material reflection decisions into readable sections and evidence previews", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-learning-decision-"));
    const workspace = await createWorkspaceStore(home);
    const project = Object.freeze({ projectId: "project-readable", root: "/workspace/readable" });
    await workspace.operational.sessions.put({
      sessionId: "session-readable",
      title: "Readable decision",
      status: "idle",
      provider: "controlled",
      model: "controlled",
      runtime: "pi",
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
      metadata: Object.freeze({}),
    });
    await workspace.operational.messages.put({
      messageId: "message-readable",
      sessionId: "session-readable",
      role: "user",
      content: "Use the protected adaptation path instead of editing control-plane files.",
      sensitivity: "normal",
      createdAt: "2026-08-14T00:00:00.000Z",
      metadata: Object.freeze({}),
    });
    await workspace.jobs.enqueue({
      jobId: "reflection-readable",
      kind: "runtime.reflect_turn",
      payload: Object.freeze({
        turn: Object.freeze({
          project,
          sessionId: "session-readable",
          turnId: "turn-readable",
          sensitivity: "normal",
        }),
      }),
      payloadRefs: Object.freeze([
        Object.freeze({ kind: "database_row", table: "messages", rowId: "message-readable" }),
      ]),
      operationId: "operation-readable",
      idempotencyKey: "operation-readable",
      notBefore: "2026-08-14T00:00:00.000Z",
      maxAttempts: 1,
      estimatedCost: 0,
      budget: 1,
    });
    const claimed = await workspace.jobs.claim({
      workerId: "worker-readable",
      now: "2026-08-14T00:00:01.000Z",
      leaseUntil: "2026-08-14T00:01:00.000Z",
      maximumCost: 1,
      kinds: Object.freeze(["runtime.reflect_turn"]),
    });
    if (!claimed?.leaseToken) throw new Error("Expected the readable reflection job to be claimed");
    await workspace.jobs.complete({
      jobId: claimed.jobId,
      leaseToken: claimed.leaseToken,
      now: "2026-08-14T00:00:02.000Z",
      result: Object.freeze({
        status: "adjusted",
        rationale: "The correction establishes a reusable project constraint.",
        observation: Object.freeze({
          kind: "correction",
          reason: "The direct edit would bypass the protected adaptation path.",
        }),
      }),
    });

    const snapshot = await loadLearningAuditSnapshot(
      {
        workspace,
        criteria: { list: async () => ({ ok: true, value: Object.freeze([]) }) },
        activations: {
          current: async () => undefined,
          listOperations: async () => Object.freeze([]),
          getApproval: async () => undefined,
        },
        feedback: {
          listObservations: async () => Object.freeze([]),
          listResearchRuns: async () => Object.freeze([]),
          getOutcome: async () => undefined,
          getSuccessorInput: async () => undefined,
        },
        continuousFeedback: {
          experimentComparison: async () => {
            throw new Error("No preflight comparison should be loaded in this fixture");
          },
        },
        resolveRevision: async () => undefined,
        resolveCapability: () => undefined,
        projectId: project.projectId,
      },
      "session-readable",
    );
    const reflection = snapshot.primitives.find(
      (primitive) => primitive.id === "reflection:reflection-readable",
    );
    expect(reflection?.detailSections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Decision",
          entries: expect.arrayContaining([
            expect.objectContaining({ label: "Outcome", value: "Applied project strategy" }),
            expect.objectContaining({
              label: "Why",
              value: "The correction establishes a reusable project constraint.",
            }),
          ]),
        }),
        expect.objectContaining({ title: "Observation" }),
      ]),
    );
    expect(reflection?.consideredEvidencePreviews).toEqual([
      expect.objectContaining({
        identity: "messages:message-readable",
        label: "USER",
        excerpt: "Use the protected adaptation path instead of editing control-plane files.",
        redacted: false,
      }),
    ]);
    workspace.close();
  });
});
