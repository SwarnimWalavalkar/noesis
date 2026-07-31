import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CapabilityRevisionRef, Experiment, FileRevisionRef, PreflightDecision } from "@noesis/domain";
import { createWorkspaceStore } from "@noesis/workspace";
import { describe, expect, test } from "vitest";
import { createWorkspaceRuntimeInternals } from "../../workspace/src/protected-runtime.ts";
import {
  type CompletedNormalTurn,
  coordinatorOperationError,
  createRuntimeCoordinator,
  type RuntimeCoordinatorConfig,
  type RuntimeCoordinatorResearchPort,
} from "../src/index.ts";

const baseline: CapabilityRevisionRef = Object.freeze({
  kind: "capability_revision",
  capabilityId: "writing",
  capabilityRevisionId: "writing-r1",
  bundleDigest: "a".repeat(64),
});
const candidate: CapabilityRevisionRef = Object.freeze({
  kind: "capability_revision",
  capabilityId: "writing",
  capabilityRevisionId: "writing-r2",
  bundleDigest: "b".repeat(64),
});

const config = (overrides: Partial<RuntimeCoordinatorConfig> = {}): RuntimeCoordinatorConfig => ({
  schemaVersion: 1,
  maxConcurrency: overrides.maxConcurrency ?? 2,
  maxJobsPerDrain: overrides.maxJobsPerDrain ?? 20,
  leaseMs: overrides.leaseMs ?? 1_000,
  heartbeatMs: overrides.heartbeatMs ?? 100,
  retry: overrides.retry ?? { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
  drainBudget: overrides.drainBudget ?? 20,
  jobs: overrides.jobs ?? {
    reflect: { estimatedCost: 1, budget: 3 },
    author: { estimatedCost: 1, budget: 3 },
    preflight: { estimatedCost: 1, budget: 3 },
  },
});

async function fixture(decision: PreflightDecision = "pass") {
  const root = await mkdtemp(join(tmpdir(), "noesis-coordinator-"));
  const workspace = await createWorkspaceStore(root);
  const timestamp = "2026-07-22T00:00:00.000Z";
  await workspace.operational.sessions.put({
    sessionId: "session-1",
    title: "normal work",
    status: "idle",
    provider: "fake",
    model: "fake",
    runtime: "fake",
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: {},
  });
  const messageRef = await workspace.operational.messages.put({
    messageId: "message-1",
    sessionId: "session-1",
    role: "user",
    content: "No, always preserve my voice instead.",
    sensitivity: "normal",
    createdAt: timestamp,
    metadata: {},
  });
  let manifest: FileRevisionRef | undefined;
  let reflectCalls = 0;
  let authorCalls = 0;
  let preflightCalls = 0;
  let transientPreflightFailures = 0;
  let terminalAuthorFailure = false;
  let briefPublicationCollisions = 0;
  let dedupedStatus: "authoring" | "completed" | undefined;
  let blockingReflect: Promise<void> | undefined;
  let activeReflects = 0;
  let peakReflects = 0;

  const rehydrate = async (experimentId: string) => {
    const experiment = await workspace.research.experiments.getExperiment(experimentId);
    if (!experiment || experiment.candidateRevisions.length !== 1 || !manifest) return undefined;
    return {
      experimentId,
      candidateRevision: candidate,
      manifestRevision: manifest,
      telemetry: { recovered: true },
    };
  };

  const research: RuntimeCoordinatorResearchPort = {
    reflect: async (payload, signal) => {
      reflectCalls += 1;
      if (briefPublicationCollisions > 0) {
        briefPublicationCollisions -= 1;
        throw new Error(`Experiment brief publication collision for dedupe:${payload.turn.turnId}`);
      }
      activeReflects += 1;
      peakReflects = Math.max(peakReflects, activeReflects);
      try {
        if (blockingReflect) await blockingReflect;
        if (signal.aborted)
          throw coordinatorOperationError("cancelled", { code: "cancelled", retryable: false });
        if (!payload.turn.userMessage.includes("preserve"))
          return { status: "no_change", reason: "irrelevant", telemetry: { role: "fake-reflector" } };
        if (dedupedStatus) {
          const experiment: Experiment =
            dedupedStatus === "completed"
              ? {
                  experimentId: `experiment:${payload.turn.turnId}`,
                  hypothesis: "preserve voice",
                  scope: payload.turn.scope,
                  evidenceRefs: payload.turn.evidenceRefs,
                  baselineRevision: payload.baselineRevision,
                  candidateRevisions: [],
                  feedbackSignalIds: [],
                  status: "completed",
                  outcome: "keep",
                }
              : {
                  experimentId: `experiment:${payload.turn.turnId}`,
                  hypothesis: "preserve voice",
                  scope: payload.turn.scope,
                  evidenceRefs: payload.turn.evidenceRefs,
                  baselineRevision: payload.baselineRevision,
                  candidateRevisions: [],
                  feedbackSignalIds: [],
                  status: "authoring",
                };
          await workspace.research.experiments.putExperiment(experiment);
          return {
            status: "deduped",
            experiment,
            hypothesisDedupeKey: `dedupe:${payload.turn.turnId}`,
            telemetry: { role: "fake-reflector" },
          };
        }
        const experiment = {
          experimentId: `experiment:${payload.turn.turnId}`,
          hypothesis: "preserve voice",
          scope: payload.turn.scope,
          evidenceRefs: payload.turn.evidenceRefs,
          baselineRevision: payload.baselineRevision,
          candidateRevisions: [],
          feedbackSignalIds: [],
          status: "hypothesis" as const,
        };
        return {
          status: "experiment",
          experiment,
          hypothesisDedupeKey: `dedupe:${payload.turn.turnId}`,
          telemetry: { role: "fake-reflector", authorityHandleSeen: "authority" in payload },
        };
      } finally {
        activeReflects -= 1;
      }
    },
    author: async (payload, signal) => {
      authorCalls += 1;
      if (terminalAuthorFailure)
        throw coordinatorOperationError("author rejected", {
          code: "author_rejected",
          retryable: false,
        });
      if (signal.aborted) throw new Error("cancelled");
      manifest ??= await workspace.definitions.recordCandidateDefinition({
        workingPath: "writing/writing-r2/manifest.json",
        bytes: new TextEncoder().encode('{"fakeRole":"revision_author"}'),
        actor: { actorId: "fake-revision-author", kind: "noesis" },
      });
      const current = await workspace.research.experiments.getExperiment(payload.experimentId);
      if (current) throw new Error("candidate experiment already exists");
      await workspace.research.experiments.putExperiment({
        experimentId: payload.experimentId,
        hypothesis: "preserve voice",
        scope: "writing",
        status: "authoring",
        candidateRevisions: [candidate],
        evidenceRefs: [messageRef, manifest],
        baselineRevision: baseline,
        feedbackSignalIds: [],
      });
      return {
        experimentId: payload.experimentId,
        candidateRevision: candidate,
        manifestRevision: manifest,
        telemetry: { role: "fake-revision-author" },
      };
    },
    rehydrateCandidate: rehydrate,
    preflight: async (payload, signal) => {
      preflightCalls += 1;
      if (transientPreflightFailures > 0) {
        transientPreflightFailures -= 1;
        throw coordinatorOperationError("temporary fake role outage", {
          code: "role_unavailable",
          retryable: true,
        });
      }
      if (signal.aborted) throw new Error("cancelled");
      const caseEvidence = await workspace.evidence.appendEvidence({
        workingPath: `${payload.preflightId}/case.json`,
        bytes: new TextEncoder().encode('{"case":"preserve voice"}'),
        actor: { actorId: "fake-case-generator", kind: "system" },
        evidenceKind: "input",
      });
      const baselineOutput = await workspace.evidence.appendEvidence({
        workingPath: `${payload.preflightId}/baseline.json`,
        bytes: new TextEncoder().encode('{"arm":"baseline"}'),
        actor: { actorId: "fake-trial", kind: "system" },
        evidenceKind: "output",
      });
      const candidateOutput = await workspace.evidence.appendEvidence({
        workingPath: `${payload.preflightId}/candidate.json`,
        bytes: new TextEncoder().encode('{"arm":"candidate"}'),
        actor: { actorId: "fake-trial", kind: "system" },
        evidenceKind: "output",
      });
      const judgmentEvidence = await workspace.evidence.appendEvidence({
        workingPath: `${payload.preflightId}/judgment.json`,
        bytes: new TextEncoder().encode('{"winner":"candidate"}'),
        actor: { actorId: "fake-judge", kind: "system" },
        evidenceKind: "judgment",
      });
      const reportEvidence = await workspace.evidence.appendEvidence({
        workingPath: `${payload.preflightId}/report.json`,
        bytes: new TextEncoder().encode(`{"decision":"${decision}"}`),
        actor: { actorId: "fake-judge", kind: "system" },
        evidenceKind: "report",
      });
      const variant = { variantId: "fake-evaluation-v1", axis: "evaluation" as const, configurationRefs: [] };
      await workspace.research.preflights.putPreflightPlan({
        planId: payload.planId,
        experimentId: payload.experimentId,
        candidateRevision: candidate,
        baselineRevision: baseline,
        caseRefs: [caseEvidence],
        judgeVariant: variant,
        runtimeVariant: variant,
        budget: { maxCases: 1, maxAttemptsPerArm: 1, maxCost: 1 },
      });
      const baselineTrial = await workspace.research.trials.putTrial({
        trialId: `${payload.preflightId}:baseline`,
        experimentId: payload.experimentId,
        comparisonGroupId: `${payload.preflightId}:case`,
        arm: "baseline",
        capabilityRevision: baseline,
        inputRefs: [caseEvidence],
        outputEvidenceRefs: [baselineOutput],
        traceEvidenceRefs: [],
        variant,
        status: "completed",
      });
      const candidateTrial = await workspace.research.trials.putTrial({
        trialId: `${payload.preflightId}:candidate`,
        experimentId: payload.experimentId,
        comparisonGroupId: `${payload.preflightId}:case`,
        arm: "candidate",
        capabilityRevision: candidate,
        inputRefs: [caseEvidence],
        outputEvidenceRefs: [candidateOutput],
        traceEvidenceRefs: [],
        variant,
        status: "completed",
      });
      await workspace.research.preflights.completePreflight({
        report: {
          preflightId: payload.preflightId,
          experimentId: payload.experimentId,
          planId: payload.planId,
          candidateRevision: candidate,
          baselineRevision: baseline,
          trialRowRefs: [baselineTrial, candidateTrial],
          trialEvidence: [baselineOutput, candidateOutput],
          judgmentEvidence: [judgmentEvidence],
          appliedCriteria: [],
          railChecks: [],
          comparison: { winner: "candidate", confidence: 1, summary: "fake judge" },
          decision,
          reportEvidence,
        },
        evaluation: {
          evaluationId: `evaluation:${payload.preflightId}`,
          experimentId: payload.experimentId,
          preflightId: payload.preflightId,
          candidateRevision: candidate,
          trialIds: [`${payload.preflightId}:baseline`, `${payload.preflightId}:candidate`],
          evidenceRefs: [judgmentEvidence, reportEvidence],
          status: "completed",
        },
      });
      return {
        experimentId: payload.experimentId,
        candidateRevision: candidate,
        reportRef: { kind: "database_row", table: "preflight_reports", rowId: payload.preflightId },
        decision,
        telemetry: { role: "fake-judge", effectCount: 0 },
      };
    },
  };

  const turn = (
    turnId: string,
    userMessage = "No, always preserve my voice instead.",
  ): CompletedNormalTurn => ({
    turn: {
      sessionId: "session-1",
      turnId,
      scope: "writing",
      userMessage,
      correction: userMessage,
      outcome: "corrected",
      occurredAt: timestamp,
      evidenceRefs: [messageRef],
      sensitivity: "normal",
      telemetry: { retryCount: 0, toolFailureCount: 0, aborted: false },
    },
    baselineRevision: baseline,
    capability: { capabilityId: "writing", name: "Writing", scope: "writing", intent: "write" },
    requestedRetrievalStrategy: "session-search.fts-only.v1",
    routingStrategyId: "router.alternative.v2",
  });

  return {
    workspace,
    authority: createWorkspaceRuntimeInternals(workspace).authority,
    research,
    turn,
    counts: () => ({ reflectCalls, authorCalls, preflightCalls, peakReflects }),
    setTransientPreflightFailures: (count: number) => {
      transientPreflightFailures = count;
    },
    setTerminalAuthorFailure: (value: boolean) => {
      terminalAuthorFailure = value;
    },
    setBriefPublicationCollisions: (count: number) => {
      briefPublicationCollisions = count;
    },
    setDedupedStatus: (status: "authoring" | "completed") => {
      dedupedStatus = status;
    },
    setBlockingReflect: (value: Promise<void> | undefined) => {
      blockingReflect = value;
    },
  };
}

describe("automatic runtime coordinator", () => {
  test("automatically completes correction through candidate and preflight while carrying approval", async () => {
    const f = await fixture("approval_required");
    const coordinator = createRuntimeCoordinator({
      workspace: f.workspace,
      authority: f.authority,
      research: f.research,
      config: config(),
    });
    const observed = await coordinator.observeCompletedTurn(f.turn("turn-approval"));
    await coordinator.idle();

    expect(observed.payload).toMatchObject({
      retrievalStrategyId: "session-search.fts-only.v1",
      routingStrategyId: "router.alternative.v2",
    });
    expect((await coordinator.listJobs()).map(({ job }) => job.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
    const experiment = await f.workspace.research.experiments.getExperiment("experiment:turn-approval");
    expect(experiment).toMatchObject({ status: "preflight", candidateRevisions: [candidate] });
    const handoff = await coordinator.getPreflightActivationHandoff("experiment:turn-approval");
    expect(handoff?.report.decision).toBe("approval_required");
    expect(handoff?.candidateRevision).toEqual(candidate);
    expect(f.counts()).toEqual({ reflectCalls: 1, authorCalls: 1, preflightCalls: 1, peakReflects: 1 });
    const database = new DatabaseSync(f.workspace.unsafeDatabasePathForTesting, { readOnly: true });
    const scheduledOperations = database
      .prepare(
        `SELECT resource, status FROM authority_operations
         WHERE principal = 'scheduler' AND effect = 'execute'
         ORDER BY resource`,
      )
      .all() as Array<{ readonly resource: string; readonly status: string }>;
    expect(scheduledOperations).toHaveLength(3);
    expect(new Set(scheduledOperations.map(({ resource }) => resource)).size).toBe(3);
    expect(scheduledOperations.every(({ resource }) => /:runtime:[a-f0-9]{64}$/u.test(resource))).toBe(true);
    expect(scheduledOperations.every(({ status }) => status === "completed")).toBe(true);
    database.close();
    f.workspace.close();
  });

  test("records irrelevant turns as a no-op without child jobs", async () => {
    const f = await fixture();
    const coordinator = createRuntimeCoordinator({
      workspace: f.workspace,
      authority: f.authority,
      research: f.research,
      config: config(),
    });
    await coordinator.observeCompletedTurn(f.turn("turn-noop", "ordinary weather question"));
    await coordinator.idle();
    const jobs = await coordinator.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.job.result).toMatchObject({ status: "no_change", reason: "irrelevant" });
    expect(f.counts()).toMatchObject({ authorCalls: 0, preflightCalls: 0 });
    f.workspace.close();
  });

  test("advances an authoritative page cursor past an undecodable legacy coordinator row", async () => {
    const f = await fixture();
    const coordinator = createRuntimeCoordinator({
      workspace: f.workspace,
      authority: f.authority,
      research: f.research,
      config: config(),
    });
    await coordinator.stop();
    await f.workspace.jobs.enqueue({
      jobId: "000-legacy-reflection",
      kind: "runtime.reflect_turn",
      payload: Object.freeze({ turn: Object.freeze({ sessionId: "session-1" }), legacy: true }),
      payloadRefs: Object.freeze([]),
      operationId: "legacy-reflection-operation",
      idempotencyKey: "legacy-reflection-idempotency",
      notBefore: "2026-07-22T00:00:00.000Z",
      maxAttempts: 1,
      estimatedCost: 0,
      budget: 0,
    });
    await coordinator.observeCompletedTurn(f.turn("turn-page-valid", "ordinary weather question"));

    const firstPage = await coordinator.listJobPage({
      kind: "runtime.reflect_turn",
      limit: 1,
      sessionId: "session-1",
    });
    expect(firstPage).toEqual({
      jobs: [],
      exhausted: false,
      nextCursor: {
        createdAt: "2026-07-22T00:00:00.000Z",
        jobId: "000-legacy-reflection",
      },
    });
    if (!firstPage.nextCursor) throw new Error("Expected an authoritative cursor");
    const secondPage = await coordinator.listJobPage({
      kind: "runtime.reflect_turn",
      limit: 1,
      after: firstPage.nextCursor,
      sessionId: "session-1",
    });

    expect(secondPage.jobs).toHaveLength(1);
    expect(secondPage.jobs[0]?.payload).toMatchObject({ turn: { turnId: "turn-page-valid" } });
    f.workspace.close();
  });

  test("rejects an explicitly empty reflection session selector", async () => {
    const f = await fixture();
    const coordinator = createRuntimeCoordinator({
      workspace: f.workspace,
      authority: f.authority,
      research: f.research,
      config: config(),
    });

    await expect(coordinator.listJobPage({ kind: "runtime.reflect_turn", sessionId: "" })).rejects.toThrow();

    await coordinator.stop();
    f.workspace.close();
  });

  test("retries transient role failure but keeps terminal failure inspectable and manually retryable", async () => {
    const f = await fixture();
    f.setTransientPreflightFailures(1);
    const coordinator = createRuntimeCoordinator({
      workspace: f.workspace,
      authority: f.authority,
      research: f.research,
      config: config(),
    });
    await coordinator.observeCompletedTurn(f.turn("turn-retry"));
    await coordinator.idle();
    const preflight = (await coordinator.listJobs({ kind: "runtime.preflight" }))[0];
    expect(preflight?.job).toMatchObject({ status: "completed", attempt: 2 });

    const second = await fixture();
    second.setTerminalAuthorFailure(true);
    const terminal = createRuntimeCoordinator({
      workspace: second.workspace,
      authority: second.authority,
      research: second.research,
      config: config(),
    });
    await terminal.observeCompletedTurn(second.turn("turn-terminal"));
    await terminal.idle();
    const failed = (await terminal.listJobs({ kind: "runtime.author_revision" }))[0];
    expect(failed?.job).toMatchObject({ status: "failed", lastError: { code: "author_rejected" } });
    second.setTerminalAuthorFailure(false);
    if (!failed) throw new Error("expected failed author job");
    await terminal.retry(failed.job.jobId, 1);
    await terminal.idle();
    expect((await terminal.getJob(failed.job.jobId))?.job.status).toBe("completed");
    f.workspace.close();
    second.workspace.close();
  });

  test("retries a cross-process experiment brief publication collision", async () => {
    const f = await fixture();
    f.setBriefPublicationCollisions(1);
    const coordinator = createRuntimeCoordinator({
      workspace: f.workspace,
      authority: f.authority,
      research: f.research,
      config: config(),
    });

    const observed = await coordinator.observeCompletedTurn(f.turn("turn-brief-collision"));
    await coordinator.idle();

    expect((await coordinator.getJob(observed.job.jobId))?.job).toMatchObject({
      status: "completed",
      attempt: 2,
    });
    expect(f.counts().reflectCalls).toBe(2);
    f.workspace.close();
  });

  test.each([
    "authoring",
    "completed",
  ] as const)("does not enqueue duplicate author work for an authoritative deduped %s experiment", async (status) => {
    const f = await fixture();
    f.setDedupedStatus(status);
    const coordinator = createRuntimeCoordinator({
      workspace: f.workspace,
      authority: f.authority,
      research: f.research,
      config: config(),
    });

    const observed = await coordinator.observeCompletedTurn(f.turn(`turn-deduped-${status}`));
    await coordinator.idle();

    expect((await coordinator.getJob(observed.job.jobId))?.job.result).toMatchObject({
      status: "deduped",
      telemetry: { existingExperimentStatus: status },
    });
    expect(await coordinator.listJobs({ kind: "runtime.author_revision" })).toEqual([]);
    expect(f.counts()).toMatchObject({ reflectCalls: 1, authorCalls: 0, preflightCalls: 0 });
    f.workspace.close();
  });

  test("bounds concurrency and budget and propagates cancellation", async () => {
    const f = await fixture();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.setBlockingReflect(blocked);
    const coordinator = createRuntimeCoordinator({
      workspace: f.workspace,
      authority: f.authority,
      research: f.research,
      config: config({ maxConcurrency: 1, drainBudget: 2 }),
    });
    const first = await coordinator.observeCompletedTurn(f.turn("turn-cancel"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await coordinator.cancel(first.job.jobId);
    release?.();
    await coordinator.idle();
    expect((await coordinator.getJob(first.job.jobId))?.job.status).toBe("cancelled");
    expect(f.counts().peakReflects).toBe(1);

    const budget = await fixture();
    const budgeted = createRuntimeCoordinator({
      workspace: budget.workspace,
      authority: budget.authority,
      research: budget.research,
      config: config({
        jobs: {
          reflect: { estimatedCost: 2, budget: 1 },
          author: { estimatedCost: 1, budget: 1 },
          preflight: { estimatedCost: 1, budget: 1 },
        },
      }),
    });
    const exhausted = await budgeted.observeCompletedTurn(budget.turn("turn-budget"));
    await budgeted.idle();
    expect((await budgeted.getJob(exhausted.job.jobId))?.job.status).toBe("budget_exhausted");
    f.workspace.close();
    budget.workspace.close();
  });

  test("stops renewing an active lease before waiting for a non-cooperative job", async () => {
    const f = await fixture();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.setBlockingReflect(blocked);
    let renewCalls = 0;
    const workspace = Object.freeze({
      ...f.workspace,
      jobs: Object.freeze({
        ...f.workspace.jobs,
        renew: async (input: Parameters<typeof f.workspace.jobs.renew>[0]) => {
          renewCalls += 1;
          return await f.workspace.jobs.renew(input);
        },
      }),
    });
    const coordinator = createRuntimeCoordinator({
      workspace,
      authority: f.authority,
      research: f.research,
      config: config({ leaseMs: 100, heartbeatMs: 25 }),
    });
    await coordinator.observeCompletedTurn(f.turn("turn-stop-heartbeat"));
    for (let attempt = 0; attempt < 20 && f.counts().reflectCalls === 0; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(f.counts().reflectCalls).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(renewCalls).toBeGreaterThan(0);

    const stopping = coordinator.stop();
    const renewCallsAtStop = renewCalls;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(renewCalls).toBe(renewCallsAtStop);

    release?.();
    await stopping;
    f.workspace.close();
  });

  test("does not launch a claimed job when stop lands while the claim is pending", async () => {
    const f = await fixture();
    let releaseReflection: (() => void) | undefined;
    f.setBlockingReflect(
      new Promise<void>((resolve) => {
        releaseReflection = resolve;
      }),
    );
    let markClaimStarted: (() => void) | undefined;
    const claimStarted = new Promise<void>((resolve) => {
      markClaimStarted = resolve;
    });
    let releaseClaim: (() => void) | undefined;
    const claimBlocked = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    let firstClaim = true;
    const workspace = Object.freeze({
      ...f.workspace,
      jobs: Object.freeze({
        ...f.workspace.jobs,
        claim: async (input: Parameters<typeof f.workspace.jobs.claim>[0]) => {
          if (firstClaim) {
            firstClaim = false;
            markClaimStarted?.();
            await claimBlocked;
          }
          return await f.workspace.jobs.claim(input);
        },
      }),
    });
    const coordinator = createRuntimeCoordinator({
      workspace,
      authority: f.authority,
      research: f.research,
      config: config({ maxConcurrency: 1 }),
    });

    try {
      await coordinator.observeCompletedTurn(f.turn("turn-stop-during-claim"));
      await claimStarted;
      const stopping = coordinator.stop();
      releaseClaim?.();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(f.counts().reflectCalls).toBe(0);
      await stopping;
      expect((await coordinator.listJobs())[0]?.job).toMatchObject({
        status: "running",
        leaseToken: expect.any(String),
      });
    } finally {
      releaseClaim?.();
      releaseReflection?.();
      await coordinator.stop();
      f.workspace.close();
    }
  });

  test("reclaims a stale lease after restart exactly once without duplicate candidate or preflight", async () => {
    const f = await fixture();
    let current = new Date("2026-07-22T00:00:00.000Z");
    const paused = createRuntimeCoordinator({
      workspace: f.workspace,
      authority: f.authority,
      research: f.research,
      config: config({ drainBudget: 0 }),
      now: () => current,
    });
    const observed = await paused.observeCompletedTurn(f.turn("turn-restart"));
    await paused.idle();
    const abandoned = await f.workspace.jobs.claim({
      workerId: "dead-process",
      now: current.toISOString(),
      leaseUntil: new Date(current.getTime() + 100).toISOString(),
      maximumCost: 10,
      kinds: ["runtime.reflect_turn"],
    });
    expect(abandoned?.jobId).toBe(observed.job.jobId);
    current = new Date(current.getTime() + 200);
    const resumed = createRuntimeCoordinator({
      workspace: f.workspace,
      authority: f.authority,
      research: f.research,
      config: config(),
      now: () => current,
      workerId: "new-process",
    });
    await resumed.idle();
    expect((await resumed.getJob(observed.job.jobId))?.job).toMatchObject({
      status: "completed",
      attempt: 2,
    });
    expect(await f.workspace.research.experiments.listExperiments({ limit: 10 })).toHaveLength(1);
    expect(await f.workspace.research.evaluations.listEvaluations("experiment:turn-restart")).toHaveLength(1);
    expect(f.counts()).toMatchObject({ authorCalls: 1, preflightCalls: 1 });
    f.workspace.close();
  });
});
