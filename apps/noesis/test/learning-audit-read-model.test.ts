import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CapabilityLifecycleRevision,
  type CapabilityRevision,
  capabilityRevisionRef,
} from "@noesis/domain";
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
        project: Object.freeze({ projectId: "project-a", root: "/workspace/a" }),
      },
      "session-project-a",
    );

    const ids = snapshot.primitives.map((primitive) => primitive.id);
    expect(ids).toContain("reflection:reflection-project-a");
    expect(ids).toContain("experiment:experiment-project-a");
    expect(ids).toContain("feedback_signal:signal-project-a");
    expect(ids.some((id) => id.includes("project-b"))).toBe(false);
    const experiment = snapshot.primitives.find(
      (primitive) => primitive.id === "experiment:experiment-project-a",
    );
    expect(experiment).toMatchObject({
      title: "Hypothesis for project-a",
      sessionId: "session-project-a",
    });
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
        project,
      },
      "session-readable",
    );
    const reflection = snapshot.primitives.find(
      (primitive) => primitive.id === "reflection:reflection-readable",
    );
    expect(reflection).toMatchObject({
      title: "The correction establishes a reusable project constraint.",
      consideredEvidenceCount: 1,
    });
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

  test("presents the active Capability as an exact, evidence-backed product change", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-learning-capability-"));
    const workspace = await createWorkspaceStore(home);
    const project = Object.freeze({ projectId: "project-capability", root: "/workspace/capability" });
    await workspace.operational.sessions.put({
      sessionId: "session-capability",
      title: "Capability authoring",
      status: "idle",
      provider: "controlled",
      model: "controlled",
      runtime: "pi",
      createdAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:00:00.000Z",
      metadata: Object.freeze({}),
    });
    await workspace.operational.messages.put({
      messageId: "message-capability",
      sessionId: "session-capability",
      role: "user",
      content: "Use the existing adaptation path instead of editing protected files.",
      sensitivity: "normal",
      createdAt: "2026-08-18T00:00:00.000Z",
      metadata: Object.freeze({}),
    });
    const evidence = Object.freeze({
      kind: "database_row" as const,
      table: "messages" as const,
      rowId: "message-capability",
    });
    await workspace.jobs.enqueue({
      jobId: "reflection-capability",
      kind: "runtime.reflect_turn",
      payload: Object.freeze({
        turn: Object.freeze({
          project,
          sessionId: "session-capability",
          turnId: "turn-capability",
          sensitivity: "normal",
        }),
      }),
      payloadRefs: Object.freeze([evidence]),
      operationId: "operation-capability-reflection",
      idempotencyKey: "operation-capability-reflection",
      notBefore: "2026-08-18T00:00:01.000Z",
      maxAttempts: 1,
      estimatedCost: 0,
      budget: 1,
    });
    const claimed = await workspace.jobs.claim({
      workerId: "worker-capability",
      now: "2026-08-18T00:00:02.000Z",
      leaseUntil: "2026-08-18T00:01:00.000Z",
      maximumCost: 1,
      kinds: Object.freeze(["runtime.reflect_turn"]),
    });
    if (!claimed?.leaseToken) throw new Error("Expected the Capability reflection job to be claimed");
    await workspace.jobs.complete({
      jobId: claimed.jobId,
      leaseToken: claimed.leaseToken,
      now: "2026-08-18T00:00:03.000Z",
      result: Object.freeze({
        status: "activated",
        capabilityId: "capability-adaptation-path",
        rationale: "The correction is likely to recur.",
      }),
    });
    const actor = Object.freeze({ actorId: "learning-audit-test", kind: "system" as const });
    const [prompt, router] = await Promise.all([
      workspace.definitions.recordWorkingDefinition({
        workingPath: "capabilities/adaptation-path/instructions.md",
        bytes: new TextEncoder().encode(
          "Use the existing adaptation path for self-extension requests instead of editing protected files.",
        ),
        actor,
        reason: "Capability audit fixture",
        provenanceRefs: Object.freeze([evidence]),
      }),
      workspace.definitions.recordWorkingDefinition({
        workingPath: "capabilities/adaptation-path/router.json",
        bytes: new TextEncoder().encode('{"appliesWhen":"self-extension requests"}'),
        actor,
        reason: "Capability audit fixture",
        provenanceRefs: Object.freeze([evidence]),
      }),
    ]);
    const exactRevision: CapabilityRevision = Object.freeze({
      capabilityRevisionId: "capability-adaptation-path-r1",
      capabilityId: "capability-adaptation-path",
      effects: Object.freeze([Object.freeze({ kind: "instruction" as const, material: prompt })]),
      promptModules: Object.freeze([prompt]),
      skills: Object.freeze([]),
      tools: Object.freeze([]),
      toolset: Object.freeze({
        toolRevisionIds: Object.freeze([]),
        routerRevision: router,
        strategyId: "semantic-capability-router-v1",
      }),
      activationPolicy: Object.freeze({ mode: "automatic_low_risk", scope: "general" }),
      permissionManifest: Object.freeze({
        effects: Object.freeze([]),
        resourcePatterns: Object.freeze([]),
        credentialRefs: Object.freeze([]),
      }),
      evidenceRefs: Object.freeze([evidence]),
      sourceEvaluationDefinitions: Object.freeze([]),
      requestedPermissionDelta: Object.freeze({
        addedEffects: Object.freeze([]),
        widenedResources: Object.freeze([]),
        addedCredentialRefs: Object.freeze([]),
      }),
    });
    const lifecycleRevision: CapabilityLifecycleRevision = Object.freeze({
      revision: exactRevision,
      reference: capabilityRevisionRef(exactRevision),
      summary: "Use the established adaptation path",
      rationale: "The correction is likely to recur across future self-extension requests.",
      anticipatedEffect: "Noesis proposes inspectable Capabilities instead of bypassing its control plane.",
      createdAt: "2026-08-18T00:00:03.000Z",
    });
    await workspace.capabilities.create({
      definition: Object.freeze({
        capabilityId: exactRevision.capabilityId,
        name: "Use the established adaptation path",
        description: "Keep self-extension work inside the inspectable adaptation flow.",
        applicability: "Requests to extend or modify Noesis itself.",
        createdAt: lifecycleRevision.createdAt,
      }),
      revision: lifecycleRevision,
      binding: Object.freeze({
        capabilityId: exactRevision.capabilityId,
        revision: lifecycleRevision.reference,
        scope: Object.freeze({ kind: "global" as const }),
        activationMode: "relevant" as const,
        state: "active" as const,
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
        project,
      },
      "session-capability",
    );
    const capability = snapshot.primitives.find(
      (primitive) => primitive.id === "capability:capability-adaptation-path",
    );
    expect(capability).toMatchObject({
      kind: "capability",
      group: "capabilities",
      capabilityFacets: ["instruction"],
      sessionId: "session-capability",
      capabilityScope: "global",
      capabilityActivationMode: "relevant",
      capabilityState: "active",
      consideredEvidenceCount: 1,
      evidence: ["messages:message-capability"],
    });
    expect(capability?.evidencePreviews).toEqual([
      expect.objectContaining({
        label: "USER",
        excerpt: "Use the existing adaptation path instead of editing protected files.",
      }),
    ]);
    expect(capability?.detailSections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "WHAT CHANGED",
          entries: expect.arrayContaining([
            expect.objectContaining({ label: "effects", value: "instruction" }),
            expect.objectContaining({
              label: "instruction",
              value: expect.stringContaining("Use the existing adaptation path for self-extension requests"),
            }),
          ]),
        }),
        expect.objectContaining({
          title: "BEHAVIOR",
          entries: expect.arrayContaining([
            expect.objectContaining({ label: "scope", value: "Global" }),
            expect.objectContaining({
              label: "selection",
              value: "Selected when semantically relevant",
            }),
          ]),
        }),
        expect.objectContaining({
          title: "WHY",
          entries: expect.arrayContaining([
            expect.objectContaining({
              label: "expected effect",
              value: "Noesis proposes inspectable Capabilities instead of bypassing its control plane.",
            }),
          ]),
        }),
      ]),
    );
    expect(capability?.relations).toEqual([
      expect.objectContaining({
        label: "authored by reflection",
        targetId: "reflection:reflection-capability",
      }),
    ]);
    expect(capability?.rawJson).toContain('"currentRevision"');
    const revision = snapshot.primitives.find(
      (primitive) => primitive.id === "capability_revision:capability-adaptation-path-r1",
    );
    expect(revision).toMatchObject({
      group: "history",
      capabilityFacets: ["instruction"],
      evidence: ["messages:message-capability"],
    });
    workspace.close();
  });

  test("redacts sensitive reflections and presents unapply evidence and transitions truthfully", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-learning-sensitive-unapply-"));
    const workspace = await createWorkspaceStore(home);
    const project = Object.freeze({
      projectId: "project-sensitive-unapply",
      root: "/workspace/sensitive-unapply",
    });
    await workspace.operational.sessions.put({
      sessionId: "session-sensitive-unapply",
      title: "Sensitive unapply decision",
      status: "idle",
      provider: "controlled",
      model: "controlled",
      runtime: "pi",
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
      metadata: Object.freeze({}),
    });
    const adjustmentEvidence = Object.freeze({
      kind: "database_row" as const,
      table: "sessions" as const,
      rowId: "session-sensitive-unapply",
    });
    await workspace.operational.messages.put({
      messageId: "message-removal-evidence",
      sessionId: "session-sensitive-unapply",
      role: "user",
      content: "The temporary strategy is no longer useful.",
      sensitivity: "normal",
      createdAt: "2026-08-14T00:00:01.000Z",
      metadata: Object.freeze({}),
    });
    const removalEvidence = Object.freeze({
      kind: "database_row" as const,
      table: "messages" as const,
      rowId: "message-removal-evidence",
    });
    const adjustment = Object.freeze({
      adjustmentId: "adjustment-to-remove",
      scope: project,
      observation: "A temporary workflow constraint was useful.",
      strategy: "Always use the temporary workflow constraint.",
      successSignal: "The temporary workflow remains reliable.",
      evidenceRefs: Object.freeze([adjustmentEvidence]),
      createdFromTurnId: "turn-adjustment-origin",
    });
    const sourceWorkspace = Object.freeze({
      ...workspace,
      workingAdjustments: Object.freeze({
        ...workspace.workingAdjustments,
        list: async (request: { readonly projectId?: string; readonly limit: number }) =>
          Object.freeze(request.projectId === project.projectId ? [adjustment] : []),
        getActive: async () => undefined,
      }),
    });

    const enqueueReflection = async (
      jobId: string,
      sensitivity: "normal" | "private",
      result: Readonly<Record<string, unknown>>,
    ): Promise<void> => {
      await workspace.jobs.enqueue({
        jobId,
        kind: "runtime.reflect_turn",
        payload: Object.freeze({
          turn: Object.freeze({
            project,
            sessionId: "session-sensitive-unapply",
            turnId: `turn-${jobId}`,
            sensitivity,
          }),
        }),
        payloadRefs: Object.freeze([removalEvidence]),
        operationId: `operation-${jobId}`,
        idempotencyKey: `operation-${jobId}`,
        notBefore: "2026-08-14T00:00:02.000Z",
        maxAttempts: 1,
        estimatedCost: 0,
        budget: 1,
      });
      const claimed = await workspace.jobs.claim({
        workerId: `worker-${jobId}`,
        now: "2026-08-14T00:00:03.000Z",
        leaseUntil: "2026-08-14T00:01:00.000Z",
        maximumCost: 1,
        kinds: Object.freeze(["runtime.reflect_turn"]),
      });
      if (!claimed?.leaseToken) throw new Error(`Expected ${jobId} to be claimed`);
      await workspace.jobs.complete({
        jobId: claimed.jobId,
        leaseToken: claimed.leaseToken,
        now: "2026-08-14T00:00:04.000Z",
        result,
      });
    };
    await enqueueReflection(
      "reflection-unapplied",
      "normal",
      Object.freeze({
        status: "unapplied",
        adjustmentId: adjustment.adjustmentId,
        project,
        reason: "The temporary strategy no longer has a credible future use.",
        evidenceRefs: Object.freeze([removalEvidence]),
      }),
    );
    await enqueueReflection(
      "reflection-private",
      "private",
      Object.freeze({
        status: "adjusted",
        adjustmentId: adjustment.adjustmentId,
        rationale: "PRIVATE RATIONALE MUST NOT APPEAR",
        observation: Object.freeze({
          kind: "correction",
          reason: "PRIVATE OBSERVATION MUST NOT APPEAR",
        }),
      }),
    );
    await workspace.jobs.enqueue({
      jobId: "author-with-evidence",
      kind: "runtime.author_revision",
      payload: Object.freeze({ sourceSessionId: "session-sensitive-unapply" }),
      payloadRefs: Object.freeze([removalEvidence]),
      operationId: "operation-author-with-evidence",
      idempotencyKey: "operation-author-with-evidence",
      notBefore: "2026-08-14T00:00:05.000Z",
      maxAttempts: 1,
      estimatedCost: 0,
      budget: 0,
    });

    const snapshot = await loadLearningAuditSnapshot(
      {
        workspace: sourceWorkspace,
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
        project,
      },
      "session-sensitive-unapply",
    );
    const unapplied = snapshot.primitives.find(
      (primitive) => primitive.id === "reflection:reflection-unapplied",
    );
    expect(unapplied?.evidence).toEqual(["messages:message-removal-evidence"]);
    expect(unapplied?.evidence).not.toContain("sessions:session-sensitive-unapply");
    expect(unapplied?.detailSections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "What changed",
          entries: expect.arrayContaining([
            expect.objectContaining({
              label: "Before",
              value: "Always use the temporary workflow constraint.",
            }),
            expect.objectContaining({ label: "Now", value: "No project strategy is active." }),
          ]),
        }),
      ]),
    );
    const privateReflection = snapshot.primitives.find(
      (primitive) => primitive.id === "reflection:reflection-private",
    );
    expect(privateReflection?.summary).toContain("Sensitive reflection details are hidden");
    expect(JSON.stringify(privateReflection?.detailSections)).not.toContain("PRIVATE RATIONALE");
    expect(JSON.stringify(privateReflection?.detailSections)).not.toContain("PRIVATE OBSERVATION");
    expect(privateReflection?.rawJson).toContain('"redacted":true');
    expect(privateReflection?.evidence).toEqual([]);
    expect(privateReflection?.evidencePreviews).toEqual([]);
    expect(privateReflection?.consideredEvidenceCount).toBe(0);
    expect(privateReflection?.consideredEvidencePreviews).toEqual([]);
    const author = snapshot.primitives.find((primitive) => primitive.id === "job:author-with-evidence");
    expect(author?.evidence).toEqual(["messages:message-removal-evidence"]);
    expect(author?.evidencePreviews).toEqual([
      expect.objectContaining({
        identity: "messages:message-removal-evidence",
        excerpt: "The temporary strategy is no longer useful.",
      }),
    ]);
    workspace.close();
  });
});
