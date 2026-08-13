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
      const evidence = Object.freeze({
        kind: "database_row" as const,
        table: "sessions" as const,
        rowId: sessionId,
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
    const privateSignal = snapshot.primitives.find(
      (primitive) => primitive.id === "feedback_signal:signal-project-a",
    );
    expect(privateSignal?.rawJson).toContain('"redacted":true');
    expect(Object.hasOwn(privateSignal ?? {}, "raw")).toBe(false);
    expect(Object.hasOwn(privateSignal ?? {}, "sensitivity")).toBe(false);
    workspace.close();
  });
});
