import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJson,
  capabilityRevisionRef,
  type CapabilityRevision,
  type CapabilityRevisionRef,
  type EvidenceRevisionRef,
  type FileRevisionRef,
} from "@noesis/domain";
import { createExperienceLedger } from "@noesis/ledger";
import { createAuthorityBoundary, type AuthorityBoundary } from "@noesis/policy";
import {
  createWorkspaceStore,
  type NoesisWorkspaceStore,
  type WorkspaceStoreOptions,
} from "@noesis/workspace";
import { describe, expect, test, vi } from "vitest";
import {
  createAtomicActivationController,
  createContinuousFeedbackController,
  type ActivationCandidateResolver,
  type ContinuousFeedbackConfig,
  type ExperimentOutcomeJudge,
  type PreflightActivationHandoff,
} from "../src/index.ts";

type JudgeInput = Parameters<ExperimentOutcomeJudge["run"]>[0];

const encoder = new TextEncoder();
const autonomy = Object.freeze({
  riskLevel: "low" as const,
  approval: "authority_expansion" as const,
  pins: "respect" as const,
  vetoes: "respect" as const,
});
const config = (minimumEvidence = 3): ContinuousFeedbackConfig =>
  Object.freeze({
    schemaVersion: 1,
    observationWindow: 8,
    minimumEvidence,
    researchStrategyId: "judge-default",
    hardRegression: Object.freeze({
      qualityDrop: 0.4,
      latencyMultiplier: 4,
      costMultiplier: 4,
      failedOutcome: true,
    }),
  });

async function authorityFor(path: string): Promise<AuthorityBoundary> {
  const ledger = createExperienceLedger(path);
  await ledger.initialize();
  return createAuthorityBoundary(ledger);
}

async function definition(
  workspace: NoesisWorkspaceStore,
  path: string,
  body: string,
): Promise<FileRevisionRef> {
  return await workspace.definitions.recordCandidateDefinition({
    workingPath: path,
    bytes: encoder.encode(body),
    actor: Object.freeze({ actorId: "ac-10-author", kind: "noesis" as const }),
    reason: "AC-10 fixture",
  });
}

async function evidence<Kind extends "input" | "output" | "judgment" | "report">(
  workspace: NoesisWorkspaceStore,
  path: string,
  evidenceKind: Kind,
): Promise<EvidenceRevisionRef<Kind>> {
  return await workspace.evidence.appendEvidence({
    workingPath: path,
    bytes: encoder.encode(`${path}\n`),
    actor: Object.freeze({ actorId: "ac-10-evaluator", kind: "system" as const }),
    evidenceKind,
    sensitivity: "normal",
  });
}

async function revision(
  workspace: NoesisWorkspaceStore,
  capabilityId: string,
  revisionId: string,
  predecessorRevisionId: string | undefined,
  effects: readonly string[] = ["read"],
): Promise<CapabilityRevision> {
  const prefix = `${capabilityId}/${revisionId}`;
  const prompt = await definition(workspace, `${prefix}/prompt.md`, `${revisionId} prompt`);
  const skill = await definition(workspace, `${prefix}/skill.md`, `${revisionId} skill`);
  const tool = await definition(workspace, `${prefix}/tool.mjs`, `${revisionId} tool`);
  const router = await definition(workspace, `${prefix}/router.json`, `${revisionId} router`);
  const evaluation = await definition(workspace, `${prefix}/eval.json`, `${revisionId} eval`);
  return Object.freeze({
    capabilityRevisionId: revisionId,
    capabilityId,
    ...(predecessorRevisionId ? { predecessorRevisionId } : {}),
    promptModules: Object.freeze([prompt]),
    skills: Object.freeze([skill]),
    tools: Object.freeze([tool]),
    toolset: Object.freeze({
      toolRevisionIds: Object.freeze([tool.revisionId]),
      routerRevision: router,
      strategyId: `router-${revisionId}`,
    }),
    activationPolicy: Object.freeze({ mode: "automatic_low_risk", scope: `scope-${capabilityId}` }),
    permissionManifest: Object.freeze({
      effects: Object.freeze([...effects]),
      resourcePatterns: Object.freeze(["workspace:"]),
      credentialRefs: Object.freeze([]),
    }),
    evidenceRefs: Object.freeze([]),
    sourceEvaluationDefinitions: Object.freeze([evaluation]),
    requestedPermissionDelta: Object.freeze({
      addedEffects: Object.freeze([]),
      widenedResources: Object.freeze([]),
      addedCredentialRefs: Object.freeze([]),
    }),
  });
}

interface FeedbackFixture {
  readonly root: string;
  readonly workspace: NoesisWorkspaceStore;
  readonly authority: AuthorityBoundary;
  readonly resolver: ActivationCandidateResolver;
  readonly revisions: Map<string, CapabilityRevision>;
  readonly capabilityId: string;
  readonly baseline: CapabilityRevision;
  readonly candidate: CapabilityRevision;
  readonly experimentId: string;
}

async function activate(
  fixture: Pick<FeedbackFixture, "workspace" | "authority" | "resolver" | "revisions">,
  experimentId: string,
  baseline: CapabilityRevision,
  candidate: CapabilityRevision,
): Promise<void> {
  const workspace = fixture.workspace;
  fixture.revisions.set(canonicalJson(capabilityRevisionRef(baseline)), baseline);
  fixture.revisions.set(canonicalJson(capabilityRevisionRef(candidate)), candidate);
  const baselineRef = capabilityRevisionRef(baseline);
  const candidateRef = capabilityRevisionRef(candidate);
  const manifest = await definition(
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
  const experimentBase = Object.freeze({
    experimentId,
    hypothesis: `Improve ${candidate.capabilityRevisionId}`,
    scope: `scope-${candidate.capabilityId}`,
    evidenceRefs: Object.freeze([manifest]),
    baselineRevision: baselineRef,
    candidateRevisions: Object.freeze([candidateRef]),
    feedbackSignalIds: Object.freeze([]),
  });
  for (const status of ["hypothesis", "authoring", "preflight"] as const)
    await workspace.research.experiments.putExperiment(Object.freeze({ ...experimentBase, status }));
  const caseRef = await evidence(workspace, `${experimentId}/case`, "input");
  const baselineOutput = await evidence(workspace, `${experimentId}/baseline-output`, "output");
  const candidateOutput = await evidence(workspace, `${experimentId}/candidate-output`, "output");
  const judgment = await evidence(workspace, `${experimentId}/judgment`, "judgment");
  const reportEvidence = await evidence(workspace, `${experimentId}/report`, "report");
  const baselineTrialId = `${experimentId}-baseline`;
  const candidateTrialId = `${experimentId}-candidate`;
  const variant = Object.freeze({
    variantId: `${experimentId}-variant`,
    axis: "activation" as const,
    configurationRefs: Object.freeze([]),
  });
  await workspace.research.trials.putTrial(
    Object.freeze({
      trialId: baselineTrialId,
      experimentId,
      comparisonGroupId: `${experimentId}-comparison`,
      arm: "baseline" as const,
      capabilityRevision: baselineRef,
      inputRefs: Object.freeze([caseRef]),
      outputEvidenceRefs: Object.freeze([baselineOutput]),
      traceEvidenceRefs: Object.freeze([]),
      variant,
      status: "completed" as const,
    }),
  );
  await workspace.research.trials.putTrial(
    Object.freeze({
      trialId: candidateTrialId,
      experimentId,
      comparisonGroupId: `${experimentId}-comparison`,
      arm: "candidate" as const,
      capabilityRevision: candidateRef,
      inputRefs: Object.freeze([caseRef]),
      outputEvidenceRefs: Object.freeze([candidateOutput]),
      traceEvidenceRefs: Object.freeze([]),
      variant,
      status: "completed" as const,
    }),
  );
  const planId = `${experimentId}-plan`;
  const preflightId = `${experimentId}-preflight`;
  const plan = Object.freeze({
    planId,
    experimentId,
    candidateRevision: candidateRef,
    baselineRevision: baselineRef,
    caseRefs: Object.freeze([caseRef]),
    judgeVariant: variant,
    runtimeVariant: variant,
    budget: Object.freeze({ maxCases: 1, maxAttemptsPerArm: 1, maxCost: 1 }),
  });
  await workspace.research.preflights.putPreflightPlan(plan);
  const report = Object.freeze({
    preflightId,
    experimentId,
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
    railChecks: Object.freeze([{ rail: "protected", passed: true, evidenceRefs: Object.freeze([judgment]) }]),
    comparison: Object.freeze({ winner: "candidate" as const, confidence: 0.9, summary: "better" }),
    decision: "pass" as const,
    reportEvidence,
  });
  await workspace.research.preflights.putPreflightReport(report);
  const preflightExperiment = Object.freeze({
    ...experimentBase,
    status: "preflight" as const,
    preflightRef: {
      kind: "database_row" as const,
      table: "preflight_reports" as const,
      rowId: preflightId,
    },
  });
  await workspace.research.experiments.putExperiment(preflightExperiment);
  const handoff: PreflightActivationHandoff = Object.freeze({
    experiment: preflightExperiment,
    candidateRevision: candidateRef,
    manifestRevision: manifest,
    reportRef: preflightExperiment.preflightRef,
    report,
  });
  const controller = createAtomicActivationController({
    workspace,
    authority: fixture.authority,
    candidates: fixture.resolver,
    autonomy,
  });
  const activated = await controller.activateFromPreflight(handoff);
  if (!activated.ok || activated.status !== "activated")
    throw new Error(`Fixture activation failed: ${canonicalJson(activated)}`);
}

async function createFixture(
  options: {
    readonly storeOptions?: WorkspaceStoreOptions;
    readonly baselineEffects?: readonly string[];
    readonly candidateEffects?: readonly string[];
  } = {},
): Promise<FeedbackFixture> {
  const root = await mkdtemp(join(tmpdir(), "noesis-ac-10-"));
  const workspace = await createWorkspaceStore(root, options.storeOptions);
  const authority = await authorityFor(join(root, "authority"));
  const revisions = new Map<string, CapabilityRevision>();
  const resolver: ActivationCandidateResolver = Object.freeze({
    resolve: async (reference: CapabilityRevisionRef) => revisions.get(canonicalJson(reference)),
    lineage: async (reference: CapabilityRevisionRef) =>
      Object.freeze(
        [...revisions.values()]
          .filter((revision) => revision.capabilityId === reference.capabilityId)
          .map(capabilityRevisionRef),
      ),
    controls: async (capabilityId: string) =>
      Object.freeze({ capabilityId, pin: null, vetoes: Object.freeze([]) }),
  });
  const capabilityId = "capability-feedback";
  const rootRevision = await revision(
    workspace,
    capabilityId,
    "r0",
    undefined,
    options.baselineEffects ?? ["read"],
  );
  const baseline = await revision(workspace, capabilityId, "r1", "r0", options.baselineEffects ?? ["read"]);
  const candidate = await revision(workspace, capabilityId, "r2", "r1", options.candidateEffects ?? ["read"]);
  const partial = { workspace, authority, resolver, revisions };
  await activate(partial, "experiment-baseline-materialization", rootRevision, baseline);
  const experimentId = "experiment-feedback";
  await activate(partial, experimentId, baseline, candidate);
  return Object.freeze({
    root,
    workspace,
    authority,
    resolver,
    revisions,
    capabilityId,
    baseline,
    candidate,
    experimentId,
  });
}

async function pinTurn(fixture: FeedbackFixture, turnId: string): Promise<void> {
  await fixture.workspace.operational.sessions.put(
    Object.freeze({
      sessionId: "session-feedback",
      title: "Feedback",
      status: "idle" as const,
      provider: "fake",
      model: "fake",
      runtime: "fake",
      createdAt: "2026-07-22T00:00:00.000Z",
      updatedAt: "2026-07-22T00:00:00.000Z",
      metadata: Object.freeze({}),
    }),
  );
  await fixture.workspace.protectedActivations.pinTurn({
    sessionId: "session-feedback",
    turnId,
  });
}

const judge = (proposal: "keep" | "revise" | "revert" = "keep"): ExperimentOutcomeJudge =>
  Object.freeze({
    run: async ({ comparison }: JudgeInput) =>
      Object.freeze({
        proposal,
        citedObservationIds: Object.freeze(
          comparison.observations.map((observation) => observation.observationId),
        ),
        summary: proposal,
      }),
  });

function controller(
  fixture: FeedbackFixture,
  outcomeJudge: ExperimentOutcomeJudge = judge(),
  feedbackConfig: ContinuousFeedbackConfig = config(),
) {
  return createContinuousFeedbackController({
    workspace: fixture.workspace,
    authority: fixture.authority,
    capabilities: fixture.resolver,
    judge: outcomeJudge,
    config: feedbackConfig,
  });
}

function observationInput(
  fixture: FeedbackFixture,
  turnId: string,
  overrides: Partial<Parameters<ReturnType<typeof controller>["observeTurnOutcome"]>[0]> = {},
) {
  return {
    sessionId: "session-feedback",
    turnId,
    status: "accepted" as const,
    summary: "accepted",
    sensitivity: "normal" as const,
    usedCapabilityIds: Object.freeze([fixture.capabilityId]),
    evidenceRefs: Object.freeze([]),
    signal: Object.freeze({ scope: `scope-${fixture.capabilityId}`, strength: 0.8, novelty: 0.5 }),
    metrics: Object.freeze({ quality: 0.9, baselineQuality: 0.7, failed: false }),
    ...overrides,
  };
}

describe("AC-10 continuous feedback and experiment outcomes", () => {
  test("attributes through the turn pin, excludes unrelated use, dedupes, and remains observing below evidence minimum", async () => {
    const fixture = await createFixture();
    await pinTurn(fixture, "turn-1");
    const feedback = controller(fixture);
    const first = await feedback.observeTurnOutcome(observationInput(fixture, "turn-1"));
    expect(first[0]).toMatchObject({ status: "observing", experimentId: fixture.experimentId });
    const duplicate = await feedback.observeTurnOutcome(observationInput(fixture, "turn-1"));
    expect(duplicate[0]).toMatchObject({ status: "observing" });
    expect(await fixture.workspace.protectedFeedback.listObservations(fixture.experimentId, 8)).toHaveLength(
      1,
    );
    await pinTurn(fixture, "turn-unrelated");
    await expect(
      feedback.observeTurnOutcome(
        observationInput(fixture, "turn-unrelated", {
          usedCapabilityIds: Object.freeze(["unrelated-capability"]),
        }),
      ),
    ).resolves.toEqual([{ status: "excluded", reason: "turn used no pinned capability revision" }]);
    const comparison = await feedback.experimentComparison(fixture.experimentId);
    expect(comparison).toMatchObject({
      preflight: { winner: "candidate", baselineTrials: 1, candidateTrials: 1 },
      liveMetrics: { count: 1, averageQuality: 0.9 },
    });
    expect(await feedback.capabilityHealth(fixture.capabilityId)).toMatchObject({
      status: "observing",
      activeRevision: capabilityRevisionRef(fixture.candidate),
    });
  });

  test("keep resolves while preserving the active revision", async () => {
    const fixture = await createFixture();
    await pinTurn(fixture, "turn-keep");
    const result = await controller(fixture, judge("keep"), config(1)).observeTurnOutcome(
      observationInput(fixture, "turn-keep"),
    );
    expect(result[0]).toMatchObject({ status: "resolved", outcome: { decision: "keep" } });
    expect(
      (await fixture.workspace.protectedActivations.current())?.activeCapabilityRevisions[
        fixture.capabilityId
      ],
    ).toEqual(capabilityRevisionRef(fixture.candidate));
  });

  test("revise creates a durable successor lineage input without activation", async () => {
    const fixture = await createFixture();
    await pinTurn(fixture, "turn-revise");
    const before = await fixture.workspace.protectedActivations.current();
    const result = await controller(fixture, judge("revise"), config(1)).observeTurnOutcome(
      observationInput(fixture, "turn-revise"),
    );
    expect(result[0]).toMatchObject({
      status: "resolved",
      outcome: { decision: "revise", successorExperimentId: expect.any(String) },
    });
    const lineage = await fixture.workspace.protectedFeedback.getSuccessorInput(fixture.experimentId);
    expect(lineage).toMatchObject({
      predecessorExperimentId: fixture.experimentId,
      predecessorRevision: capabilityRevisionRef(fixture.candidate),
      baselineRevision: capabilityRevisionRef(fixture.baseline),
    });
    expect(
      await fixture.workspace.research.experiments.getExperiment(lineage?.successorExperimentId ?? ""),
    ).toMatchObject({
      status: "hypothesis",
      candidateRevisions: [],
      baselineRevision: capabilityRevisionRef(fixture.candidate),
    });
    expect(await fixture.workspace.protectedActivations.current()).toEqual(before);
  });

  test("explicit correction overrides a judge keep proposal", async () => {
    const fixture = await createFixture();
    await pinTurn(fixture, "turn-correction");
    const result = await controller(fixture, judge("keep"), config(1)).observeTurnOutcome(
      observationInput(fixture, "turn-correction", {
        status: "corrected",
        summary: "user corrected the result",
        signal: Object.freeze({
          kind: "explicit_correction",
          scope: `scope-${fixture.capabilityId}`,
          strength: 1,
          novelty: 0.8,
        }),
      }),
    );
    expect(result[0]).toMatchObject({ status: "resolved", outcome: { decision: "revise" } });
  });

  test("a hard regression automatically reverts to the exact prior snapshot and restart is idempotent", async () => {
    const fixture = await createFixture();
    const priorOperation = (await fixture.workspace.protectedActivations.listOperations(100)).find(
      (operation) => operation.binding.experimentId === fixture.experimentId,
    );
    const prior = await fixture.workspace.operational.activations.get(
      priorOperation?.previousActivationId ?? "missing",
    );
    await pinTurn(fixture, "turn-hard");
    const result = await controller(fixture, judge("keep"), config(3)).observeTurnOutcome(
      observationInput(fixture, "turn-hard", {
        status: "failed",
        summary: "hard failure",
        metrics: Object.freeze({ failed: true, protectedRailViolation: true }),
      }),
    );
    expect(result[0]).toMatchObject({ status: "resolved", outcome: { decision: "revert" } });
    const restored = await fixture.workspace.protectedActivations.current();
    expect(restored?.activeDefinitions).toEqual(prior?.activeDefinitions);
    expect(restored?.activeCapabilityRevisions).toEqual(prior?.activeCapabilityRevisions);
    const restoredRevision = restored?.revision;
    fixture.workspace.close();
    const reopened = await createWorkspaceStore(fixture.root);
    const restarted = createContinuousFeedbackController({
      workspace: reopened,
      authority: await authorityFor(join(fixture.root, "restart-authority")),
      capabilities: fixture.resolver,
      judge: judge(),
      config: config(),
    });
    await expect(restarted.evaluateExperiment(fixture.experimentId)).resolves.toMatchObject({
      status: "resolved",
      outcome: { decision: "revert" },
    });
    expect((await reopened.protectedActivations.current())?.revision).toBe(restoredRevision);
  });

  test.each([
    [
      "before",
      {
        beforeOutcomeCommitForTesting: () => {
          throw new Error("before");
        },
      },
    ],
    [
      "inside",
      {
        duringOutcomeCommitForTesting: () => {
          throw new Error("inside");
        },
      },
    ],
  ] as const)("%s-transaction failure exposes neither outcome nor partial restore", async (_name, storeOptions) => {
    const fixture = await createFixture({ storeOptions });
    const candidateActivation = await fixture.workspace.protectedActivations.current();
    await pinTurn(fixture, `turn-${_name}`);
    await expect(
      controller(fixture).observeTurnOutcome(
        observationInput(fixture, `turn-${_name}`, {
          status: "failed",
          summary: "failure",
          metrics: Object.freeze({ failed: true, protectedRailViolation: true }),
        }),
      ),
    ).rejects.toThrow();
    expect(await fixture.workspace.protectedFeedback.getOutcome(fixture.experimentId)).toBeUndefined();
    expect(await fixture.workspace.protectedActivations.current()).toEqual(candidateActivation);
    expect(await fixture.workspace.research.experiments.getExperiment(fixture.experimentId)).toMatchObject({
      status: "observing",
    });
  });

  test("post-transaction failure is recovered as one committed restoration", async () => {
    const fixture = await createFixture({
      storeOptions: {
        afterOutcomeCommitForTesting: () => {
          throw new Error("after");
        },
      },
    });
    await pinTurn(fixture, "turn-after");
    const result = await controller(fixture).observeTurnOutcome(
      observationInput(fixture, "turn-after", {
        status: "failed",
        summary: "failure",
        metrics: Object.freeze({ failed: true, protectedRailViolation: true }),
      }),
    );
    expect(result[0]).toMatchObject({ status: "resolved", outcome: { decision: "revert" } });
    expect(
      (await fixture.workspace.protectedActivations.listOperations()).filter(
        (operation) => operation.binding.experimentId === fixture.experimentId,
      ),
    ).toHaveLength(1);
  });

  test("stale serving activation fails closed", async () => {
    const fixture = await createFixture();
    await pinTurn(fixture, "turn-stale");
    const otherRoot = await revision(fixture.workspace, "other-capability", "other-r0", undefined);
    const otherCandidate = await revision(fixture.workspace, "other-capability", "other-r1", "other-r0");
    await activate(fixture, "experiment-other", otherRoot, otherCandidate);
    await expect(
      controller(fixture).observeTurnOutcome(
        observationInput(fixture, "turn-stale", {
          status: "failed",
          summary: "stale failure",
          metrics: Object.freeze({ failed: true, protectedRailViolation: true }),
        }),
      ),
    ).rejects.toThrow(/stale|CAS/iu);
    expect(await fixture.workspace.protectedFeedback.getOutcome(fixture.experimentId)).toBeUndefined();
  });

  test("revert rejects permission widening and an unrecorded prior snapshot", async () => {
    const widening = await createFixture({ baselineEffects: ["read", "write"], candidateEffects: ["read"] });
    await pinTurn(widening, "turn-widen");
    await expect(
      controller(widening).observeTurnOutcome(
        observationInput(widening, "turn-widen", {
          status: "failed",
          summary: "failure",
          metrics: Object.freeze({ failed: true, protectedRailViolation: true }),
        }),
      ),
    ).rejects.toThrow(/permissions/iu);

    const root = await mkdtemp(join(tmpdir(), "noesis-ac-10-unrecorded-"));
    const workspace = await createWorkspaceStore(root);
    const authority = await authorityFor(join(root, "authority"));
    const revisions = new Map<string, CapabilityRevision>();
    const resolver: ActivationCandidateResolver = Object.freeze({
      resolve: async (reference: CapabilityRevisionRef) => revisions.get(canonicalJson(reference)),
      lineage: async () => Object.freeze([...revisions.values()].map(capabilityRevisionRef)),
      controls: async (capabilityId: string) =>
        Object.freeze({ capabilityId, pin: null, vetoes: Object.freeze([]) }),
    });
    const base = await revision(workspace, "single", "single-r0", undefined);
    const candidate = await revision(workspace, "single", "single-r1", "single-r0");
    await activate({ workspace, authority, resolver, revisions }, "single-experiment", base, candidate);
    const single = Object.freeze({
      root,
      workspace,
      authority,
      resolver,
      revisions,
      capabilityId: "single",
      baseline: base,
      candidate,
      experimentId: "single-experiment",
    });
    await pinTurn(single, "turn-unrecorded");
    await expect(
      controller(single).observeTurnOutcome(
        observationInput(single, "turn-unrecorded", {
          status: "failed",
          summary: "failure",
          metrics: Object.freeze({ failed: true, protectedRailViolation: true }),
        }),
      ),
    ).rejects.toThrow(/prior AC-09/iu);
  });

  test("research failures are visible and retryable, alternative strategies run, and roles receive no authority", async () => {
    const fixture = await createFixture();
    await pinTurn(fixture, "turn-research");
    let attempt = 0;
    const seen: unknown[] = [];
    const role: ExperimentOutcomeJudge = Object.freeze({
      run: async (input: JudgeInput) => {
        seen.push(input);
        attempt += 1;
        if (attempt === 1) throw new Error("temporary fake-role failure");
        return Object.freeze({
          proposal: "keep" as const,
          citedObservationIds: Object.freeze(
            input.comparison.observations.map((observation) => observation.observationId),
          ),
          summary: "keep",
        });
      },
    });
    const feedback = controller(fixture, role, config(1));
    const first = await feedback.observeTurnOutcome(observationInput(fixture, "turn-research"));
    expect(first[0]).toMatchObject({ status: "research_failed", run: { retryable: true, attempt: 1 } });
    const retried = await feedback.evaluateExperiment(fixture.experimentId, "alternative-judge-v2");
    expect(retried).toMatchObject({ status: "resolved", outcome: { decision: "keep" } });
    expect(seen).toHaveLength(2);
    expect((await feedback.experimentComparison(fixture.experimentId)).researchRuns).toMatchObject([
      { strategyId: "judge-default", status: "failed", retryable: true },
      { strategyId: "alternative-judge-v2", status: "completed", proposal: "keep" },
    ]);
    expect(canonicalJson(seen)).not.toMatch(/authority|threshold|protectedFeedback|commitOutcome/iu);
  });
});
