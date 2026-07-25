import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CapabilityRevisionSchema,
  canonicalJson,
  capabilityRevisionRef,
  sameCapabilityRevisionRef,
  type CapabilityRevision,
  type CapabilityRevisionRef,
  type EvidenceRevisionRef,
  type FileRevisionRef,
  type PreflightDecision,
} from "@noesis/domain";
import {
  createWorkspaceStore,
  type NoesisWorkspaceStore,
  type WorkspaceStoreOptions,
} from "@noesis/workspace";
import {
  createWorkspaceRuntimeInternals,
  type ProtectedWorkspaceRuntime,
} from "../../workspace/src/protected-runtime.ts";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";
import {
  createAtomicActivationController,
  createContinuousFeedbackController,
  createRuntimeControlPlane,
  createRuntimeCoordinator,
  type ActivationCandidateResolver,
  type ContinuousFeedbackConfig,
  type ExperimentOutcomeJudge,
  type PreflightActivationHandoff,
  type RuntimeCoordinatorConfig,
  type RuntimeCoordinatorResearchPort,
} from "../src/index.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf8", { fatal: true });
const timestamp = "2026-07-23T00:00:00.000Z";
const autonomy = Object.freeze({
  riskLevel: "low" as const,
  approval: "authority_expansion" as const,
  pins: "respect" as const,
  vetoes: "respect" as const,
});

const coordinatorConfig: RuntimeCoordinatorConfig = Object.freeze({
  schemaVersion: 1,
  maxConcurrency: 2,
  maxJobsPerDrain: 20,
  leaseMs: 1_000,
  heartbeatMs: 100,
  retry: Object.freeze({ maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 }),
  drainBudget: 20,
  jobs: Object.freeze({
    reflect: Object.freeze({ estimatedCost: 1, budget: 3 }),
    author: Object.freeze({ estimatedCost: 1, budget: 3 }),
    preflight: Object.freeze({ estimatedCost: 1, budget: 3 }),
  }),
});

const feedbackConfig = (minimumEvidence = 2): ContinuousFeedbackConfig =>
  Object.freeze({
    schemaVersion: 1,
    observationWindow: 8,
    minimumEvidence,
    researchStrategyId: "fake-outcome-judge-v1",
    hardRegression: Object.freeze({
      qualityDrop: 0.4,
      latencyMultiplier: 4,
      costMultiplier: 4,
      failedOutcome: true,
    }),
  });

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function definition(
  workspace: NoesisWorkspaceStore,
  path: string,
  content: string,
): Promise<FileRevisionRef> {
  return await workspace.definitions.recordCandidateDefinition({
    workingPath: path,
    bytes: encoder.encode(content),
    actor: Object.freeze({ actorId: "barrier-c-fake-author", kind: "noesis" as const }),
    reason: "Barrier C acceptance fixture",
  });
}

async function evidence<Kind extends "input" | "output" | "judgment" | "report">(
  workspace: NoesisWorkspaceStore,
  path: string,
  kind: Kind,
  value: unknown,
): Promise<EvidenceRevisionRef<Kind>> {
  return await workspace.evidence.appendEvidence({
    workingPath: path,
    bytes: encoder.encode(`${canonicalJson(value)}\n`),
    actor: Object.freeze({ actorId: "barrier-c-fake-evaluator", kind: "system" as const }),
    evidenceKind: kind,
    sensitivity: "private",
  });
}

async function revision(input: {
  readonly workspace: NoesisWorkspaceStore;
  readonly capabilityId: string;
  readonly revisionId: string;
  readonly predecessorRevisionId?: string;
  readonly activationPolicy?: "automatic_low_risk" | "approval_required";
  readonly effects?: readonly string[];
  readonly requestedEffects?: readonly string[];
}): Promise<CapabilityRevision> {
  const prefix = `${input.capabilityId}/${input.revisionId}`;
  const prompt = await definition(input.workspace, `${prefix}/prompt.md`, `${input.revisionId} prompt`);
  const skill = await definition(input.workspace, `${prefix}/SKILL.md`, `${input.revisionId} skill`);
  const tool = await definition(input.workspace, `${prefix}/tool.mjs`, `${input.revisionId} tool`);
  const router = await definition(input.workspace, `${prefix}/router.json`, `${input.revisionId} router`);
  const evaluation = await definition(
    input.workspace,
    `${prefix}/source-case.json`,
    `${input.revisionId} source case`,
  );
  return Object.freeze({
    capabilityRevisionId: input.revisionId,
    capabilityId: input.capabilityId,
    ...(input.predecessorRevisionId ? { predecessorRevisionId: input.predecessorRevisionId } : {}),
    promptModules: Object.freeze([prompt]),
    skills: Object.freeze([skill]),
    tools: Object.freeze([tool]),
    toolset: Object.freeze({
      toolRevisionIds: Object.freeze([tool.revisionId]),
      routerRevision: router,
      strategyId: `router-${input.revisionId}`,
    }),
    activationPolicy: Object.freeze({
      mode: input.activationPolicy ?? "automatic_low_risk",
      scope: "writing",
    }),
    permissionManifest: Object.freeze({
      effects: Object.freeze([...(input.effects ?? ["read"])]),
      resourcePatterns: Object.freeze(["workspace:writing/**"]),
      credentialRefs: Object.freeze([]),
    }),
    evidenceRefs: Object.freeze([]),
    sourceEvaluationDefinitions: Object.freeze([evaluation]),
    requestedPermissionDelta: Object.freeze({
      addedEffects: Object.freeze([...(input.requestedEffects ?? [])]),
      widenedResources: Object.freeze([]),
      addedCredentialRefs: Object.freeze([]),
    }),
  });
}

async function recordManifest(
  workspace: NoesisWorkspaceStore,
  experimentId: string,
  candidate: CapabilityRevision,
): Promise<FileRevisionRef> {
  const candidateRef = capabilityRevisionRef(candidate);
  return await definition(
    workspace,
    `${candidate.capabilityId}/${candidate.capabilityRevisionId}/manifest.json`,
    canonicalJson({
      schemaVersion: 1,
      kind: "learning_candidate_revision",
      brief: { experimentId },
      revision: candidate,
      revisionRef: candidateRef,
      researchRefs: {
        experiment: { kind: "database_row", table: "experiments", rowId: experimentId },
      },
    }),
  );
}

async function recordPreflight(input: {
  readonly workspace: NoesisWorkspaceStore;
  readonly experimentId: string;
  readonly baseline: CapabilityRevision;
  readonly candidate: CapabilityRevision;
  readonly manifest: FileRevisionRef;
  readonly decision: PreflightDecision;
}): Promise<PreflightActivationHandoff> {
  const baselineRef = capabilityRevisionRef(input.baseline);
  const candidateRef = capabilityRevisionRef(input.candidate);
  const current = await input.workspace.research.experiments.getExperiment(input.experimentId);
  if (!current) {
    const base = Object.freeze({
      experimentId: input.experimentId,
      hypothesis: `Improve ${input.candidate.capabilityRevisionId}`,
      scope: "writing",
      evidenceRefs: Object.freeze([input.manifest]),
      baselineRevision: baselineRef,
      candidateRevisions: Object.freeze([candidateRef]),
      feedbackSignalIds: Object.freeze([]),
    });
    await input.workspace.research.experiments.putExperiment(
      Object.freeze({ ...base, status: "hypothesis" as const }),
    );
    await input.workspace.research.experiments.putExperiment(
      Object.freeze({ ...base, status: "authoring" as const }),
    );
  }
  const authoring = await input.workspace.research.experiments.getExperiment(input.experimentId);
  if (!authoring || (authoring.status !== "authoring" && authoring.status !== "preflight")) {
    throw new Error(`Expected authoring or preflight experiment ${input.experimentId}`);
  }
  const preflightExperiment = Object.freeze({ ...authoring, status: "preflight" as const });
  if (authoring.status === "authoring") {
    await input.workspace.research.experiments.putExperiment(preflightExperiment);
  }

  const caseRef = await evidence(input.workspace, `${input.experimentId}/case`, "input", {
    instruction: "preserve voice",
  });
  const baselineOutput = await evidence(input.workspace, `${input.experimentId}/baseline-output`, "output", {
    arm: "baseline",
  });
  const candidateOutput = await evidence(
    input.workspace,
    `${input.experimentId}/candidate-output`,
    "output",
    { arm: "candidate" },
  );
  const judgment = await evidence(input.workspace, `${input.experimentId}/judgment`, "judgment", {
    winner: "candidate",
    cited: [caseRef],
  });
  const reportEvidence = await evidence(input.workspace, `${input.experimentId}/report`, "report", {
    decision: input.decision,
    cited: [judgment],
  });
  const planId = `${input.experimentId}:plan`;
  const preflightId = `${input.experimentId}:preflight`;
  const sourceEvaluationDefinition = input.candidate.sourceEvaluationDefinitions[0];
  if (!sourceEvaluationDefinition) throw new Error("Candidate has no source evaluation definition");
  const variant = Object.freeze({
    variantId: "barrier-c-fake-evaluation-v1",
    axis: "evaluation" as const,
    configurationRefs: Object.freeze([sourceEvaluationDefinition]),
  });
  await input.workspace.research.preflights.putPreflightPlan(
    Object.freeze({
      planId,
      experimentId: input.experimentId,
      candidateRevision: candidateRef,
      baselineRevision: baselineRef,
      caseRefs: Object.freeze([caseRef]),
      judgeVariant: variant,
      runtimeVariant: variant,
      budget: Object.freeze({ maxCases: 1, maxAttemptsPerArm: 1, maxCost: 0 }),
    }),
  );
  const baselineTrialId = `${preflightId}:baseline`;
  const candidateTrialId = `${preflightId}:candidate`;
  for (const trial of [
    {
      trialId: baselineTrialId,
      arm: "baseline" as const,
      capabilityRevision: baselineRef,
      outputEvidenceRefs: Object.freeze([baselineOutput]),
    },
    {
      trialId: candidateTrialId,
      arm: "candidate" as const,
      capabilityRevision: candidateRef,
      outputEvidenceRefs: Object.freeze([candidateOutput]),
    },
  ]) {
    await input.workspace.research.trials.putTrial(
      Object.freeze({
        ...trial,
        experimentId: input.experimentId,
        comparisonGroupId: `${preflightId}:comparison`,
        inputRefs: Object.freeze([caseRef]),
        traceEvidenceRefs: Object.freeze([]),
        variant,
        status: "completed" as const,
      }),
    );
  }
  const report = Object.freeze({
    preflightId,
    experimentId: input.experimentId,
    planId,
    candidateRevision: candidateRef,
    baselineRevision: baselineRef,
    trialRowRefs: Object.freeze([
      { kind: "database_row" as const, table: "experiment_trials" as const, rowId: baselineTrialId },
      { kind: "database_row" as const, table: "experiment_trials" as const, rowId: candidateTrialId },
    ]),
    trialEvidence: Object.freeze([baselineOutput, candidateOutput]),
    judgmentEvidence: Object.freeze([judgment]),
    appliedCriteria: Object.freeze([]),
    railChecks: Object.freeze([
      { rail: "protected-authority", passed: true, evidenceRefs: Object.freeze([judgment]) },
    ]),
    comparison: Object.freeze({ winner: "candidate" as const, confidence: 0.98, summary: "better" }),
    decision: input.decision,
    reportEvidence,
  });
  const reportRef = await input.workspace.research.preflights.putPreflightReport(report);
  const finalExperiment = Object.freeze({ ...preflightExperiment, preflightRef: reportRef });
  await input.workspace.research.experiments.putExperiment(finalExperiment);
  return Object.freeze({
    experiment: finalExperiment,
    candidateRevision: candidateRef,
    manifestRevision: input.manifest,
    reportRef,
    report,
  });
}

interface AcceptanceHarness {
  readonly root: string;
  readonly workspace: NoesisWorkspaceStore;
  readonly protectedRuntime: ProtectedWorkspaceRuntime;
  readonly resolver: ActivationCandidateResolver;
  readonly baseline: CapabilityRevision;
  readonly baselineActiveDefinitions: Readonly<Record<string, FileRevisionRef>>;
  readonly candidate: CapabilityRevision;
  readonly experimentId: string;
  readonly roleInputs: readonly object[];
  readonly controlPlane: ReturnType<typeof createRuntimeControlPlane>;
}

async function createHarness(
  options: {
    readonly decision?: PreflightDecision;
    readonly activationPolicy?: "automatic_low_risk" | "approval_required";
    readonly permissionExpansion?: boolean;
    readonly storeOptions?: WorkspaceStoreOptions;
    readonly judgeProposal?: "keep" | "revise" | "revert";
    readonly minimumEvidence?: number;
  } = {},
): Promise<AcceptanceHarness> {
  const root = await mkdtemp(join(tmpdir(), "noesis-barrier-c-"));
  roots.push(root);
  const workspace = await createWorkspaceStore(root, options.storeOptions);
  const internals = createWorkspaceRuntimeInternals(workspace);
  const protectedRuntime = internals.protectedRuntime;
  const capabilityId = "writing";
  const rootRevision = await revision({ workspace, capabilityId, revisionId: "writing-r0" });
  const baseline = await revision({
    workspace,
    capabilityId,
    revisionId: "writing-r1",
    predecessorRevisionId: rootRevision.capabilityRevisionId,
  });
  const candidate = await revision({
    workspace,
    capabilityId,
    revisionId: "writing-r2",
    predecessorRevisionId: baseline.capabilityRevisionId,
    ...(options.activationPolicy === undefined ? {} : { activationPolicy: options.activationPolicy }),
    effects: options.permissionExpansion ? ["read", "write"] : ["read"],
    requestedEffects: options.permissionExpansion ? ["write"] : [],
  });
  const revisions = new Map<string, CapabilityRevision>(
    [rootRevision, baseline, candidate].map((value) => [canonicalJson(capabilityRevisionRef(value)), value]),
  );
  const resolver: ActivationCandidateResolver = Object.freeze({
    resolve: async (reference: CapabilityRevisionRef) => revisions.get(canonicalJson(reference)),
    lineage: async (reference: CapabilityRevisionRef) =>
      Object.freeze(
        [...revisions.values()]
          .filter((value) => value.capabilityId === reference.capabilityId)
          .map(capabilityRevisionRef),
      ),
    controls: async (requestedCapabilityId: string) =>
      Object.freeze({ capabilityId: requestedCapabilityId, pin: null, vetoes: Object.freeze([]) }),
  });
  const activation = createAtomicActivationController({
    workspace,
    protectedRuntime,
    candidates: resolver,
    autonomy,
  });
  const baselineManifest = await recordManifest(workspace, "experiment-baseline", baseline);
  const baselineHandoff = await recordPreflight({
    workspace,
    experimentId: "experiment-baseline",
    baseline: rootRevision,
    candidate: baseline,
    manifest: baselineManifest,
    decision: "pass",
  });
  const baselineActivation = await activation.activateFromPreflight(baselineHandoff);
  if (!baselineActivation.ok || baselineActivation.status !== "activated") {
    throw new Error(`Could not seed baseline activation: ${canonicalJson(baselineActivation)}`);
  }
  const baselineSnapshot = await protectedRuntime.activations.current();
  if (!baselineSnapshot) throw new Error("Baseline activation snapshot is missing");
  const baselineActiveDefinitions = Object.freeze({ ...baselineSnapshot.activeDefinitions });

  await workspace.operational.sessions.put(
    Object.freeze({
      sessionId: "session-correction",
      title: "Normal correction",
      status: "idle" as const,
      provider: "fake",
      model: "fake",
      runtime: "fake",
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: Object.freeze({}),
    }),
  );
  const messageRef = await workspace.operational.messages.put(
    Object.freeze({
      messageId: "message-correction",
      sessionId: "session-correction",
      role: "user" as const,
      content: "No, always preserve my voice instead.",
      sensitivity: "normal" as const,
      createdAt: timestamp,
      metadata: Object.freeze({}),
    }),
  );
  const experimentId = "experiment-correction";
  let manifest: FileRevisionRef | undefined;
  const roleInputs: object[] = [];
  const research: RuntimeCoordinatorResearchPort = {
    reflect: async (payload) => {
      roleInputs.push(payload);
      return Object.freeze({
        status: "experiment" as const,
        experiment: Object.freeze({
          experimentId,
          hypothesis: "Preserve the user's voice during writing corrections",
          scope: "writing",
          evidenceRefs: payload.turn.evidenceRefs,
          baselineRevision: payload.baselineRevision,
          feedbackSignalIds: Object.freeze([]),
          status: "hypothesis" as const,
        }),
        hypothesisDedupeKey: "writing:preserve-voice",
        telemetry: Object.freeze({ role: "fake-reflector", provider: "fake" }),
      });
    },
    author: async (payload) => {
      roleInputs.push(payload);
      manifest ??= await recordManifest(workspace, experimentId, candidate);
      const base = Object.freeze({
        experimentId,
        hypothesis: "Preserve the user's voice during writing corrections",
        scope: "writing",
        evidenceRefs: Object.freeze([messageRef, manifest]),
        baselineRevision: capabilityRevisionRef(baseline),
        candidateRevisions: Object.freeze([capabilityRevisionRef(candidate)]),
        feedbackSignalIds: Object.freeze([]),
      });
      await workspace.research.experiments.putExperiment(
        Object.freeze({ ...base, status: "hypothesis" as const }),
      );
      await workspace.research.experiments.putExperiment(
        Object.freeze({ ...base, status: "authoring" as const }),
      );
      return Object.freeze({
        experimentId,
        candidateRevision: capabilityRevisionRef(candidate),
        manifestRevision: manifest,
        telemetry: Object.freeze({ role: "fake-revision-author", provider: "fake" }),
      });
    },
    rehydrateCandidate: async (requestedExperimentId) => {
      if (requestedExperimentId !== experimentId || !manifest) return undefined;
      const parsed = z
        .object({ revision: CapabilityRevisionSchema })
        .parse(JSON.parse(decoder.decode(await workspace.reads.readRevision(manifest))));
      const { predecessorRevisionId, dependencyLock, ...requiredRevision } = parsed.revision;
      const rehydratedRevision: CapabilityRevision = Object.freeze({
        ...requiredRevision,
        ...(predecessorRevisionId === undefined ? {} : { predecessorRevisionId }),
        ...(dependencyLock === undefined ? {} : { dependencyLock }),
      });
      const rehydrated = capabilityRevisionRef(rehydratedRevision);
      if (!sameCapabilityRevisionRef(rehydrated, capabilityRevisionRef(candidate))) {
        throw new Error("Fake author did not rehydrate the exact candidate bytes");
      }
      return Object.freeze({
        experimentId,
        candidateRevision: rehydrated,
        manifestRevision: manifest,
        telemetry: Object.freeze({ recovered: true }),
      });
    },
    preflight: async (payload) => {
      roleInputs.push(payload);
      if (!manifest) throw new Error("Candidate manifest was not authored");
      const handoff = await recordPreflight({
        workspace,
        experimentId,
        baseline,
        candidate,
        manifest,
        decision: options.decision ?? "pass",
      });
      return Object.freeze({
        experimentId,
        candidateRevision: handoff.candidateRevision,
        reportRef: handoff.reportRef,
        decision: handoff.report.decision,
        telemetry: Object.freeze({ role: "fake-blind-judge", provider: "fake" }),
      });
    },
  };
  const coordinator = createRuntimeCoordinator({
    workspace,
    authority: internals.authority,
    research,
    config: coordinatorConfig,
    workerId: "barrier-c-worker",
  });
  const outcomeJudge: ExperimentOutcomeJudge = {
    run: async (input) => {
      roleInputs.push(input);
      return Object.freeze({
        proposal: options.judgeProposal ?? "keep",
        citedObservationIds: Object.freeze(
          input.comparison.observations.map((observation) => observation.observationId),
        ),
        summary: "fake outcome judge",
      });
    },
  };
  const feedback = createContinuousFeedbackController({
    workspace,
    protectedRuntime,
    authority: internals.authority,
    capabilities: resolver,
    judge: outcomeJudge,
    config: feedbackConfig(options.minimumEvidence),
  });
  const controlPlane = createRuntimeControlPlane({ workspace, coordinator, activation, feedback });
  await controlPlane.observeCompletedTurn({
    turn: Object.freeze({
      sessionId: "session-correction",
      turnId: "turn-correction",
      scope: "writing",
      userMessage: "No, always preserve my voice instead.",
      correction: "No, always preserve my voice instead.",
      outcome: "corrected",
      occurredAt: timestamp,
      evidenceRefs: [messageRef],
      sensitivity: "normal",
      telemetry: Object.freeze({ retryCount: 0, toolFailureCount: 0, aborted: false }),
    }),
    baselineRevision: capabilityRevisionRef(baseline),
    capability: Object.freeze({
      capabilityId,
      name: "Writing",
      scope: "writing",
      intent: "Preserve voice",
    }),
    requestedRetrievalStrategy: "session-search.fts-only.v1",
    routingStrategyId: "writing-router-v1",
  });
  return Object.freeze({
    root,
    workspace,
    protectedRuntime,
    resolver,
    baseline,
    baselineActiveDefinitions,
    candidate,
    experimentId,
    roleInputs,
    controlPlane,
  });
}

function outcomeInput(
  turnId: string,
  overrides: Partial<
    Parameters<ReturnType<typeof createContinuousFeedbackController>["observeTurnOutcome"]>[0]
  > = {},
) {
  return Object.freeze({
    sessionId: "session-correction",
    turnId,
    status: "accepted" as const,
    summary: "accepted",
    sensitivity: "normal" as const,
    usedCapabilityIds: Object.freeze(["writing"]),
    evidenceRefs: Object.freeze([]),
    signal: Object.freeze({ scope: "writing", strength: 0.8, novelty: 0.5 }),
    metrics: Object.freeze({ quality: 0.9, baselineQuality: 0.7, failed: false }),
    ...overrides,
  });
}

describe("Barrier C AC-08 -> AC-09 -> AC-10 integration", () => {
  test("automatically drains a correction through exact candidate rehydration, preflight, and atomic activation", async () => {
    const harness = await createHarness();
    await harness.controlPlane.idle();

    expect(
      (await harness.controlPlane.coordinator.listJobs()).map(({ job }) => ({
        status: job.status,
        error: job.lastError?.message ?? null,
      })),
    ).toEqual([
      { status: "completed", error: null },
      { status: "completed", error: null },
      { status: "completed", error: null },
    ]);
    const experiment = await harness.workspace.research.experiments.getExperiment(harness.experimentId);
    expect(experiment).toMatchObject({
      status: "observing",
      candidateRevisions: [capabilityRevisionRef(harness.candidate)],
      activatedRevision: capabilityRevisionRef(harness.candidate),
      preflightRef: { table: "preflight_reports" },
    });
    const current = await harness.protectedRuntime.activations.current();
    expect(current?.activeCapabilityRevisions["writing"]).toEqual(capabilityRevisionRef(harness.candidate));
    const operation = (await harness.protectedRuntime.activations.listOperations()).find(
      (candidate) => candidate.binding.experimentId === harness.experimentId,
    );
    expect(operation?.materializations).toHaveLength(5);
    expect(operation?.materializations.every((item) => item.published)).toBe(true);
    for (const materialization of operation?.materializations ?? []) {
      expect(await harness.workspace.reads.readRevision(materialization.activeRevision)).toEqual(
        await harness.workspace.reads.readRevision(materialization.sourceRevision),
      );
    }
    expect(
      harness.roleInputs.every(
        (input) =>
          !("authority" in input) &&
          !("activation" in input) &&
          !("restoration" in input) &&
          !("protectedActivations" in input) &&
          !("protectedFeedback" in input),
      ),
    ).toBe(true);
  });

  test("keeps permission expansion pending for exact approval and rejection never activates", async () => {
    const harness = await createHarness({
      decision: "approval_required",
      permissionExpansion: true,
    });
    await harness.controlPlane.idle();
    const pending = (await harness.protectedRuntime.activations.listOperations()).find(
      (operation) => operation.binding.experimentId === harness.experimentId,
    );
    expect(pending).toMatchObject({ status: "pending_approval", approvalId: expect.any(String) });
    if (!pending?.approvalId) throw new Error("Expected approval");
    expect(
      (await harness.protectedRuntime.activations.current())?.activeCapabilityRevisions["writing"],
    ).toEqual(capabilityRevisionRef(harness.baseline));
    await expect(
      harness.controlPlane.activation.approve({
        approvalId: pending.approvalId,
        operationId: pending.operationId,
        bindingDigest: "0".repeat(64),
      }),
    ).resolves.toMatchObject({ ok: false, code: "validation_failed" });
    await expect(
      harness.controlPlane.activation.reject({
        approvalId: pending.approvalId,
        operationId: pending.operationId,
        bindingDigest: pending.bindingDigest,
      }),
    ).resolves.toMatchObject({ ok: true, status: "rejected" });
    expect(
      (await harness.protectedRuntime.activations.current())?.activeCapabilityRevisions["writing"],
    ).toEqual(capabilityRevisionRef(harness.baseline));
  });

  test("uses the frozen serving pin for later feedback and revise records cited successor lineage without activation", async () => {
    const harness = await createHarness({ judgeProposal: "revise", minimumEvidence: 1 });
    await harness.controlPlane.idle();
    expect(
      (await harness.protectedRuntime.activations.current())?.activeCapabilityRevisions["writing"],
    ).toEqual(capabilityRevisionRef(harness.candidate));
    const pin = await harness.controlPlane.activation.pinTurnActivation("session-correction", "turn-revise");
    const before = await harness.protectedRuntime.activations.current();
    const result = await harness.controlPlane.feedback.observeTurnOutcome(outcomeInput("turn-revise"));

    expect(result[0]).toMatchObject({
      status: "resolved",
      outcome: { decision: "revise", successorExperimentId: expect.any(String) },
    });
    const outcome = await harness.protectedRuntime.feedback.getOutcome(harness.experimentId);
    const successor = await harness.protectedRuntime.feedback.getSuccessorInput(harness.experimentId);
    expect(successor).toMatchObject({
      predecessorExperimentId: harness.experimentId,
      predecessorActivationId: pin.activationId,
      predecessorRevision: capabilityRevisionRef(harness.candidate),
    });
    expect(successor?.evidenceRefs).toEqual(outcome?.evidenceRefs);
    expect(await harness.protectedRuntime.activations.current()).toEqual(before);
    expect(
      (await harness.protectedRuntime.activations.listOperations()).some(
        (operation) => operation.binding.experimentId === successor?.successorExperimentId,
      ),
    ).toBe(false);
    const comparison = await harness.controlPlane.feedback.experimentComparison(harness.experimentId);
    const health = await harness.controlPlane.feedback.capabilityHealth("writing");
    expect(comparison).toMatchObject({
      preflight: { winner: "candidate", baselineTrials: 1, candidateTrials: 1 },
      observations: [
        {
          servingActivationId: pin.activationId,
          capabilityRevision: capabilityRevisionRef(harness.candidate),
        },
      ],
      outcome: { decision: "revise" },
    });
    expect(comparison.evidenceRefs).toEqual(expect.arrayContaining([...(outcome?.evidenceRefs ?? [])]));
    expect(health).toMatchObject({ activeRevision: capabilityRevisionRef(harness.candidate) });
  });

  test("hard regression restores the exact prior snapshot once and restart recovers the committed outcome", async () => {
    let failAfterOutcome = true;
    const harness = await createHarness({
      storeOptions: {
        afterOutcomeCommitForTesting: () => {
          if (failAfterOutcome) {
            failAfterOutcome = false;
            throw new Error("injected after outcome commit");
          }
        },
      },
    });
    await harness.controlPlane.idle();
    expect(
      (await harness.protectedRuntime.activations.current())?.activeCapabilityRevisions["writing"],
    ).toEqual(capabilityRevisionRef(harness.candidate));
    const candidateOperation = (await harness.protectedRuntime.activations.listOperations()).find(
      (operation) => operation.binding.experimentId === harness.experimentId,
    );
    expect(candidateOperation?.previousActivationId).toEqual(expect.any(String));
    await harness.controlPlane.activation.pinTurnActivation("session-correction", "turn-hard");
    const result = await harness.controlPlane.feedback.observeTurnOutcome(
      outcomeInput("turn-hard", {
        status: "failed",
        summary: "hard protected regression",
        metrics: Object.freeze({ failed: true, protectedRailViolation: true }),
      }),
    );
    expect(result[0]).toMatchObject({ status: "resolved", outcome: { decision: "revert" } });
    const restored = await harness.protectedRuntime.activations.current();
    expect(restored?.activeDefinitions).toEqual(harness.baselineActiveDefinitions);
    expect(restored?.activeCapabilityRevisions["writing"]).toEqual(capabilityRevisionRef(harness.baseline));
    const restoredRevision = restored?.revision;
    harness.workspace.close();

    const reopened = await createWorkspaceStore(harness.root);
    const reopenedInternals = createWorkspaceRuntimeInternals(reopened);
    const restarted = createContinuousFeedbackController({
      workspace: reopened,
      protectedRuntime: reopenedInternals.protectedRuntime,
      authority: reopenedInternals.authority,
      capabilities: harness.resolver,
      judge: Object.freeze({
        run: async () => {
          throw new Error("Committed outcome must not rerun a model role");
        },
      }),
      config: feedbackConfig(),
    });
    await expect(restarted.evaluateExperiment(harness.experimentId)).resolves.toMatchObject({
      status: "resolved",
      outcome: { decision: "revert" },
    });
    const reopenedProtected = reopenedInternals.protectedRuntime;
    expect((await reopenedProtected.activations.current())?.revision).toBe(restoredRevision);
    expect(await reopenedProtected.activations.recoverCommittedPublications()).toBe(0);
    expect(await reopenedProtected.feedback.getOutcome(harness.experimentId)).toMatchObject({
      decision: "revert",
      restoredActivationId: restored?.activationId,
    });
    reopened.close();
  });
});
