import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FrozenTurnPlan, frozenTurnPlanDigest } from "@noesis/agent-types";
import { createWorkspaceCapabilityControlStore, type CapabilityControlReadModel } from "@noesis/capabilities";
import {
  createConditionalObject,
  canonicalJson,
  capabilityRevisionRef,
  type CapabilityRevision,
  type CapabilityRevisionRef,
  type EvidenceRevisionRef,
  type Experiment,
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
import { describe, expect, test } from "vitest";
import {
  createAtomicActivationController,
  decidePreflightActivation,
  derivePermissionExpansion,
  type ActivationCandidateResolver,
  type PreflightActivationHandoff,
} from "../src/index.ts";
const encoder = new TextEncoder();
// SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
const autonomy = Object.freeze({
  riskLevel: "low" as const,
  approval: "authority_expansion" as const,
  pins: "respect" as const,
  vetoes: "respect" as const,
});
const protectedRuntime = (workspace: NoesisWorkspaceStore): ProtectedWorkspaceRuntime =>
  createWorkspaceRuntimeInternals(workspace).protectedRuntime;
async function recordCompletedSourceTurn(
  workspace: NoesisWorkspaceStore,
  sessionId: string,
  turnId: string,
): Promise<void> {
  await workspace.operational.sessions.put({
    sessionId,
    title: "Working adjustment source",
    status: "idle",
    provider: "controlled",
    model: "controlled",
    runtime: "pi",
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
    metadata: Object.freeze({}),
  });
  const runtime = protectedRuntime(workspace);
  const activation = await runtime.activations.current();
  if (activation === undefined) throw new Error("Source turn requires an active baseline");
  const body: Omit<FrozenTurnPlan, "canonicalDigest"> = {
    schemaVersion: 1,
    planId: `plan-${turnId}`,
    sessionId,
    turnId,
    activationId: activation.activationId,
    activationRevision: activation.revision,
    selectedCapabilities: Object.freeze([]),
    renderedSystemPrompt: "Controlled source turn",
    provider: "controlled",
    model: "controlled",
    thinkingLevel: "off",
    permissionSnapshot: Object.freeze({ effects: [], resourcePatterns: [], credentialRefs: [] }),
    retrievalCitations: Object.freeze([]),
    routing: Object.freeze({ strategyId: "baseline", reason: "Controlled source turn" }),
    createdAt: "2026-07-26T00:00:00.000Z",
  };
  await runtime.activations.admitTurnPlan(
    Object.freeze({ ...body, canonicalDigest: frozenTurnPlanDigest(body) }),
  );
  const outcomeId = `${turnId}:outcome`;
  await workspace.operational.outcomes.put({
    outcomeId,
    sessionId,
    turnId,
    status: "accepted",
    summary: "The source turn completed before reflection.",
    sensitivity: "normal",
    createdAt: "2026-07-26T00:00:01.000Z",
    metadata: Object.freeze({}),
  });
  await workspace.operational.foregroundTurns.settle({
    turnId,
    outcomeId,
    status: "completed",
    settledAt: "2026-07-26T00:00:01.000Z",
  });
}
interface FixtureOptions {
  readonly suffix?: string;
  readonly capabilityId?: string;
  readonly activationPolicy?: "automatic_low_risk" | "approval_required";
  readonly decision?: PreflightDecision;
  readonly permissionExpansion?: boolean;
  readonly extraTool?: boolean;
  readonly controls?: CapabilityControlReadModel;
  readonly storeOptions?: WorkspaceStoreOptions;
  readonly root?: string;
  readonly workspace?: NoesisWorkspaceStore;
  readonly authorityHome?: string;
  readonly newSlot?: boolean;
  readonly claimedCrossCapabilityPredecessor?: boolean;
  readonly sourceAdjustmentId?: string;
}
interface Fixture {
  readonly root: string;
  readonly authorityHome: string;
  readonly workspace: NoesisWorkspaceStore;
  readonly handoff: PreflightActivationHandoff;
  readonly candidate: CapabilityRevision;
  readonly candidateRef: CapabilityRevisionRef;
  readonly baseline: CapabilityRevision;
  readonly baselineRef: CapabilityRevisionRef;
  readonly resolver: ActivationCandidateResolver;
  readonly controller: ReturnType<typeof createAtomicActivationController>;
}
const refKey = (reference: CapabilityRevisionRef): string => canonicalJson(reference);
async function definition(
  workspace: NoesisWorkspaceStore,
  path: string,
  content: string,
): Promise<FileRevisionRef> {
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  return await workspace.definitions.recordCandidateDefinition({
    workingPath: path,
    bytes: encoder.encode(content),
    actor: Object.freeze({ actorId: "ac-09-test-author", kind: "noesis" as const }),
    reason: "AC-09 fixture",
  });
}
// BOUNDARY: Test evidence is serialized immediately into the workspace evidence contract.
async function evidence<Kind extends "input" | "output" | "judgment" | "report">(
  workspace: NoesisWorkspaceStore,
  path: string,
  kind: Kind,
  value: unknown,
): Promise<EvidenceRevisionRef<Kind>> {
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  return await workspace.evidence.appendEvidence({
    workingPath: path,
    bytes: encoder.encode(`${JSON.stringify(value)}\n`),
    actor: Object.freeze({ actorId: "ac-09-test-evaluator", kind: "system" as const }),
    evidenceKind: kind,
    sensitivity: "private",
  });
}
// SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const suffix = options.suffix ?? "one";
  const capabilityId = options.capabilityId ?? `capability-${suffix}`;
  const baselineCapabilityId = options.newSlot ? `genesis-${suffix}` : capabilityId;
  const root = options.root ?? (await mkdtemp(join(tmpdir(), `noesis-ac-09-${suffix}-`)));
  const workspace = options.workspace ?? (await createWorkspaceStore(root, options.storeOptions ?? {}));
  const authorityHome = options.authorityHome ?? join(root, `authority-${suffix}`);
  const baselinePrompt = await definition(workspace, `${suffix}/baseline-prompt.md`, "baseline prompt");
  const baselineSkill = await definition(workspace, `${suffix}/baseline-skill.md`, "baseline skill");
  const baselineTool = await definition(workspace, `${suffix}/baseline-tool.mjs`, "baseline tool");
  const baselineRouter = await definition(workspace, `${suffix}/baseline-router.json`, "baseline router");
  const baselineEval = await definition(workspace, `${suffix}/baseline-eval.json`, "baseline eval");
  const baseline: CapabilityRevision = Object.freeze({
    capabilityRevisionId: `${baselineCapabilityId}-r1`,
    capabilityId: baselineCapabilityId,
    promptModules: Object.freeze([baselinePrompt]),
    skills: Object.freeze([baselineSkill]),
    tools: Object.freeze([baselineTool]),
    toolset: Object.freeze({
      toolRevisionIds: Object.freeze([baselineTool.revisionId]),
      routerRevision: baselineRouter,
      strategyId: "baseline-router",
    }),
    activationPolicy: Object.freeze({ mode: "automatic_low_risk", scope: `scope-${suffix}` }),
    permissionManifest: Object.freeze({
      effects: Object.freeze(["read"]),
      resourcePatterns: Object.freeze(["workspace:"]),
      credentialRefs: Object.freeze([]),
    }),
    evidenceRefs: Object.freeze([]),
    sourceEvaluationDefinitions: Object.freeze([baselineEval]),
    requestedPermissionDelta: Object.freeze({
      addedEffects: Object.freeze([]),
      widenedResources: Object.freeze([]),
      addedCredentialRefs: Object.freeze([]),
    }),
  });
  const baselineRef = capabilityRevisionRef(baseline);
  const prompt = await definition(workspace, `${suffix}/candidate-prompt.md`, "candidate prompt");
  const skill = await definition(workspace, `${suffix}/candidate-skill.md`, "candidate skill");
  const tool = await definition(workspace, `${suffix}/candidate-tool.mjs`, "candidate tool");
  const extraTool = options.extraTool
    ? await definition(workspace, `${suffix}/candidate-extra-tool.mjs`, "candidate extra tool")
    : undefined;
  const router = await definition(workspace, `${suffix}/candidate-router.json`, "candidate router");
  const evaluation = await definition(workspace, `${suffix}/candidate-eval.json`, "candidate eval");
  const expands = options.permissionExpansion ?? false;
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  const candidate: CapabilityRevision = Object.freeze(
    createConditionalObject({
      capabilityRevisionId: `${capabilityId}-r2`,
      capabilityId,
    } as const)
      .addOptional(
        !options.newSlot || options.claimedCrossCapabilityPredecessor
          ? {
              predecessorRevisionId: baseline.capabilityRevisionId,
            }
          : undefined,
      )
      .add({
        promptModules: Object.freeze([prompt]),
        skills: Object.freeze([skill]),
        tools: Object.freeze([tool, ...(extraTool ? [extraTool] : [])]),
        toolset: Object.freeze({
          toolRevisionIds: Object.freeze([tool.revisionId, ...(extraTool ? [extraTool.revisionId] : [])]),
          routerRevision: router,
          strategyId: "candidate-router",
        }),
        activationPolicy: Object.freeze({
          mode: options.activationPolicy ?? "automatic_low_risk",
          scope: `scope-${suffix}`,
        }),
        permissionManifest: Object.freeze({
          effects: Object.freeze(expands ? ["read", "write"] : ["read"]),
          resourcePatterns: Object.freeze(["workspace:"]),
          credentialRefs: Object.freeze([]),
        }),
        evidenceRefs: Object.freeze([]),
        sourceEvaluationDefinitions: Object.freeze([evaluation]),
        requestedPermissionDelta: Object.freeze({
          addedEffects: Object.freeze(expands ? ["write"] : []),
          widenedResources: Object.freeze([]),
          addedCredentialRefs: Object.freeze([]),
        }),
      } as const)
      .finish(),
  );
  const candidateRef = capabilityRevisionRef(candidate);
  const experimentId = `experiment-${suffix}`;
  const manifestRevision = await definition(
    workspace,
    `${capabilityId}/${candidate.capabilityRevisionId}/manifest.json`,
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
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  const experimentBase = Object.freeze(
    createConditionalObject({
      experimentId,
      hypothesis: `Improve ${suffix}`,
      scope: `scope-${suffix}`,
      evidenceRefs: Object.freeze([manifestRevision]),
      baselineRevision: baselineRef,
      candidateRevisions: Object.freeze([candidateRef]),
      feedbackSignalIds: Object.freeze([]),
    } as const)
      .addOptional(
        !(options.sourceAdjustmentId === undefined)
          ? {
              sourceAdjustmentId: options.sourceAdjustmentId,
            }
          : undefined,
      )
      .finish(),
  );
  if (options.sourceAdjustmentId !== undefined) {
    await protectedRuntime(workspace).activations.bootstrapGenesis({
      capabilityRevision: baselineRef,
      activeDefinitions: Object.freeze({
        [`${baselineCapabilityId}:prompt`]: baselinePrompt,
        [`${baselineCapabilityId}:skill`]: baselineSkill,
        [`${baselineCapabilityId}:tool`]: baselineTool,
        [`${baselineCapabilityId}:router`]: baselineRouter,
      }),
    });
    await recordCompletedSourceTurn(workspace, `session-${suffix}`, `turn-${suffix}`);
    await protectedRuntime(workspace).workingAdjustments.apply({
      adjustment: Object.freeze({
        adjustmentId: options.sourceAdjustmentId,
        scope: Object.freeze({ projectId: `project-${suffix}`, root }),
        observation: "A project-local strategy may improve the next turn.",
        strategy: "Verify observable state before claiming success.",
        successSignal: "The activation preflight confirms the durable candidate.",
        evidenceRefs: Object.freeze([manifestRevision]),
        createdFromTurnId: `turn-${suffix}`,
      }),
      expectedActiveAdjustmentId: null,
    });
  }
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  await workspace.research.experiments.putExperiment(
    Object.freeze({ ...experimentBase, status: "hypothesis" as const }),
  );
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  await workspace.research.experiments.putExperiment(
    Object.freeze({ ...experimentBase, status: "authoring" as const }),
  );
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  await workspace.research.experiments.putExperiment(
    Object.freeze({ ...experimentBase, status: "preflight" as const }),
  );
  const caseRef = await evidence(workspace, `${suffix}/case`, "input", { input: suffix });
  const baselineOutput = await evidence(workspace, `${suffix}/baseline-output`, "output", {
    arm: "baseline",
  });
  const candidateOutput = await evidence(workspace, `${suffix}/candidate-output`, "output", {
    arm: "candidate",
  });
  const judgment = await evidence(workspace, `${suffix}/judgment`, "judgment", { winner: "candidate" });
  const reportEvidence = await evidence(workspace, `${suffix}/report`, "report", { decision: "pass" });
  const planId = `plan-${suffix}`;
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  const variant = Object.freeze({
    variantId: `variant-${suffix}`,
    axis: "evaluation" as const,
    configurationRefs: Object.freeze([evaluation]),
  });
  await workspace.research.preflights.putPreflightPlan(
    Object.freeze({
      planId,
      experimentId,
      candidateRevision: candidateRef,
      baselineRevision: baselineRef,
      caseRefs: Object.freeze([caseRef]),
      judgeVariant: variant,
      runtimeVariant: variant,
      budget: Object.freeze({ maxCases: 1, maxAttemptsPerArm: 1, maxCost: 0 }),
    }),
  );
  const baselineTrialId = `trial-${suffix}-baseline`;
  const candidateTrialId = `trial-${suffix}-candidate`;
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
  ])
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    await workspace.research.trials.putTrial(
      Object.freeze({
        ...trial,
        experimentId,
        comparisonGroupId: `comparison-${suffix}`,
        inputRefs: Object.freeze([caseRef]),
        traceEvidenceRefs: Object.freeze([]),
        variant,
        status: "completed" as const,
      }),
    );
  const preflightId = `preflight-${suffix}`;
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
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
    railChecks: Object.freeze([
      { rail: "protected-authority", passed: true, evidenceRefs: Object.freeze([]) },
    ]),
    comparison: Object.freeze({ winner: "candidate" as const, confidence: 0.95, summary: "better" }),
    decision: options.decision ?? ("pass" as const),
    reportEvidence,
  });
  const reportRef = await workspace.research.preflights.putPreflightReport(report);
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  const finalExperiment = Object.freeze({
    ...experimentBase,
    status: "preflight" as const,
    preflightRef: reportRef,
  }) satisfies Experiment & {
    readonly status: "preflight";
  };
  await workspace.research.experiments.putExperiment(finalExperiment);
  const handoff: PreflightActivationHandoff = Object.freeze({
    experiment: finalExperiment,
    candidateRevision: candidateRef,
    manifestRevision,
    reportRef,
    report,
  });
  const revisions = new Map<string, CapabilityRevision>([
    [refKey(baselineRef), baseline],
    [refKey(candidateRef), candidate],
  ]);
  const controls = options.controls ?? Object.freeze({ capabilityId, pin: null, vetoes: Object.freeze([]) });
  const resolver: ActivationCandidateResolver = Object.freeze({
    resolve: async (reference: CapabilityRevisionRef) => revisions.get(refKey(reference)),
    lineage: async () =>
      options.newSlot ? Object.freeze([candidateRef]) : Object.freeze([baselineRef, candidateRef]),
    controls: async () => controls,
  });
  if (options.newSlot) {
    await protectedRuntime(workspace).activations.bootstrapGenesis({
      capabilityRevision: baselineRef,
      activeDefinitions: Object.freeze({
        [`${baselineCapabilityId}:prompt`]: baselinePrompt,
        [`${baselineCapabilityId}:skill`]: baselineSkill,
        [`${baselineCapabilityId}:tool`]: baselineTool,
        [`${baselineCapabilityId}:router`]: baselineRouter,
      }),
    });
  }
  const controller = createAtomicActivationController({
    workspace,
    protectedRuntime: protectedRuntime(workspace),
    candidates: resolver,
    autonomy,
  });
  return Object.freeze({
    root,
    authorityHome,
    workspace,
    handoff,
    candidate,
    candidateRef,
    baseline,
    baselineRef,
    resolver,
    controller,
  });
}
describe("AC-09 preflight policy", () => {
  test("derives expansion and requires approval independently of autonomy", () => {
    const expansion = derivePermissionExpansion(
      { effects: ["read"], resourcePatterns: ["workspace:"], credentialRefs: [] },
      { effects: ["read", "write"], resourcePatterns: ["workspace:"], credentialRefs: [] },
      { addedEffects: ["write"], widenedResources: [], addedCredentialRefs: [] },
    );
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const candidate = {
      capabilityRevisionId: "r2",
      capabilityId: "cap",
      promptModules: [],
      skills: [],
      tools: [],
      toolset: {
        toolRevisionIds: [],
        routerRevision: {
          kind: "file_revision" as const,
          revisionId: "router",
          workingPath: "definitions/candidates/router",
          snapshotPath: "revisions/router",
          contentDigest: "a".repeat(64),
        },
        strategyId: "router",
      },
      activationPolicy: { mode: "automatic_low_risk" as const, scope: "scope" },
      permissionManifest: {
        effects: ["read", "write"],
        resourcePatterns: ["workspace:"],
        credentialRefs: [],
      },
      evidenceRefs: [],
      sourceEvaluationDefinitions: [],
      requestedPermissionDelta: { addedEffects: ["write"], widenedResources: [], addedCredentialRefs: [] },
    } satisfies CapabilityRevision;
    const candidateRef = capabilityRevisionRef(candidate);
    expect(
      decidePreflightActivation({
        canonicalDecision: "pass",
        candidateRevision: candidateRef,
        candidate,
        baseline: {
          ...candidate,
          permissionManifest: { effects: ["read"], resourcePatterns: ["workspace:"], credentialRefs: [] },
        },
        lineage: [candidateRef],
        controls: { capabilityId: "cap", pin: null, vetoes: [] },
        controlsValid: true,
        identityBound: true,
        scopeBound: true,
        allRailsPassed: true,
        risk: "low",
        autonomy: { ...autonomy, riskLevel: "high" },
        permissionExpansion: expansion,
      }),
    ).toMatchObject({ outcome: "approval_required", reasonCodes: ["authority_expansion"] });
  });
});
describe("AC-09 atomic activation with real WorkspaceStore", () => {
  test("conditionally unapplies the exact source adjustment in the activation commit", async () => {
    const fixture = await createFixture({
      suffix: "source-adjustment",
      sourceAdjustmentId: "adjustment-source",
    });
    expect(await fixture.workspace.workingAdjustments.getActive("project-source-adjustment")).toMatchObject({
      adjustmentId: "adjustment-source",
    });
    await expect(fixture.controller.activateFromPreflight(fixture.handoff)).resolves.toMatchObject({
      ok: true,
      status: "activated",
    });
    expect(await fixture.workspace.workingAdjustments.getActive("project-source-adjustment")).toBeUndefined();
  });
  test("preserves a newer working adjustment when an older source candidate activates", async () => {
    const fixture = await createFixture({
      suffix: "replaced-source-adjustment",
      sourceAdjustmentId: "adjustment-source-old",
    });
    await recordCompletedSourceTurn(fixture.workspace, "session-replacement", "turn-replacement");
    await protectedRuntime(fixture.workspace).workingAdjustments.apply({
      adjustment: Object.freeze({
        adjustmentId: "adjustment-source-new",
        scope: Object.freeze({ projectId: "project-replaced-source-adjustment", root: fixture.root }),
        observation: "Newer evidence supports a replacement strategy.",
        strategy: "Preserve the newer project-local hypothesis.",
        successSignal: "Later turns continue to receive this exact adjustment.",
        evidenceRefs: Object.freeze([fixture.handoff.manifestRevision]),
        createdFromTurnId: "turn-replacement",
      }),
      expectedActiveAdjustmentId: "adjustment-source-old",
    });
    await expect(fixture.controller.activateFromPreflight(fixture.handoff)).resolves.toMatchObject({
      ok: true,
      status: "activated",
    });
    expect(
      await fixture.workspace.workingAdjustments.getActive("project-replaced-source-adjustment"),
    ).toMatchObject({ adjustmentId: "adjustment-source-new" });
  });
  test("auto-activates a low-risk pass only after the complete immutable set is materialized", async () => {
    const fixture = await createFixture();
    const result = await fixture.controller.activateFromPreflight(fixture.handoff);
    if (!result.ok) throw new Error(result.message);
    expect(result).toMatchObject({ ok: true, status: "activated" });
    const current = await protectedRuntime(fixture.workspace).activations.current();
    expect(current?.revision).toBe(1);
    expect(current?.previousActivationId).toBeNull();
    expect(current?.activeCapabilityRevisions[fixture.candidateRef.capabilityId]).toEqual(
      fixture.candidateRef,
    );
    expect(Object.keys(current?.activeDefinitions ?? {})).toHaveLength(5);
    if (result.ok && result.status === "activated") {
      expect(result.operation.materializations).toHaveLength(5);
      expect(result.operation.materializations.every((item) => item.published)).toBe(true);
      expect(
        result.operation.materializations.every(
          (item) => item.activeRevision.contentDigest === item.sourceRevision.contentDigest,
        ),
      ).toBe(true);
    }
  });
  test("adds a no-predecessor scoped capability while preserving the active genesis fallback", async () => {
    const fixture = await createFixture({ suffix: "new-slot", newSlot: true });
    const before = await protectedRuntime(fixture.workspace).activations.current();
    const result = await fixture.controller.activateFromPreflight(fixture.handoff);
    expect(result).toMatchObject({ ok: true, status: "activated" });
    const current = await protectedRuntime(fixture.workspace).activations.current();
    expect(current?.revision).toBe((before?.revision ?? 0) + 1);
    expect(current?.activeCapabilityRevisions[fixture.baselineRef.capabilityId]).toEqual(fixture.baselineRef);
    expect(current?.activeCapabilityRevisions[fixture.candidateRef.capabilityId]).toEqual(
      fixture.candidateRef,
    );
  });
  test("rejects a cross-capability candidate that claims predecessor lineage", async () => {
    const fixture = await createFixture({
      suffix: "cross-capability-predecessor",
      newSlot: true,
      claimedCrossCapabilityPredecessor: true,
    });
    await expect(fixture.controller.activateFromPreflight(fixture.handoff)).resolves.toMatchObject({
      ok: true,
      status: "blocked",
      policy: { reasonCodes: expect.arrayContaining(["scope_mismatch"]) },
    });
    const current = await protectedRuntime(fixture.workspace).activations.current();
    expect(current?.activeCapabilityRevisions[fixture.candidateRef.capabilityId]).toBeUndefined();
    expect(current?.activeCapabilityRevisions[fixture.baselineRef.capabilityId]).toEqual(fixture.baselineRef);
  });
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  test.each([
    ["candidate policy", { activationPolicy: "approval_required" as const }],
    ["canonical preflight decision", { decision: "approval_required" as const }],
    ["derived permission expansion", { permissionExpansion: true }],
  ])("requires exact protected approval for %s", async (_label, setup) => {
    const fixture = await createFixture({ suffix: `approval-${_label.replaceAll(" ", "-")}`, ...setup });
    const pending = await fixture.controller.activateFromPreflight(fixture.handoff);
    expect(pending).toMatchObject({ ok: true, status: "pending_approval" });
    if (!pending.ok || pending.status !== "pending_approval") throw new Error("Expected approval");
    await expect(
      fixture.controller.approve({
        approvalId: pending.approvalId,
        operationId: pending.operation.operationId,
        bindingDigest: "0".repeat(64),
      }),
    ).resolves.toMatchObject({ ok: false, code: "validation_failed" });
    expect(await protectedRuntime(fixture.workspace).activations.current()).toBeUndefined();
    const approved = await fixture.controller.approve({
      approvalId: pending.approvalId,
      operationId: pending.operation.operationId,
      bindingDigest: pending.bindingDigest,
    });
    expect(approved).toMatchObject({ ok: true, status: "activated" });
  });
  test("rejects an exact pending approval without activating", async () => {
    const fixture = await createFixture({ suffix: "reject", activationPolicy: "approval_required" });
    const pending = await fixture.controller.activateFromPreflight(fixture.handoff);
    if (!pending.ok || pending.status !== "pending_approval") throw new Error("Expected approval");
    const rejected = await fixture.controller.reject({
      approvalId: pending.approvalId,
      operationId: pending.operation.operationId,
      bindingDigest: pending.bindingDigest,
    });
    expect(rejected).toMatchObject({ ok: true, status: "rejected" });
    expect(await protectedRuntime(fixture.workspace).activations.current()).toBeUndefined();
    await expect(
      fixture.controller.approve({
        approvalId: pending.approvalId,
        operationId: pending.operation.operationId,
        bindingDigest: pending.bindingDigest,
      }),
    ).resolves.toMatchObject({ ok: true, status: "rejected" });
  });
  test("fails closed when a durable pin arrives after preflight staging", async () => {
    const fixture = await createFixture({ suffix: "late-pin", activationPolicy: "approval_required" });
    const pending = await fixture.controller.activateFromPreflight(fixture.handoff);
    if (!pending.ok || pending.status !== "pending_approval") throw new Error("Expected approval");
    const controls = createWorkspaceCapabilityControlStore(fixture.workspace);
    await expect(
      controls.commit({
        controls: Object.freeze({
          capabilityId: fixture.candidateRef.capabilityId,
          pin: Object.freeze({
            capabilityId: fixture.candidateRef.capabilityId,
            revision: fixture.baselineRef,
            reason: "late user pin",
          }),
          vetoes: Object.freeze([]),
        }),
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      fixture.controller.approve({
        approvalId: pending.approvalId,
        operationId: pending.operation.operationId,
        bindingDigest: pending.bindingDigest,
      }),
    ).resolves.toMatchObject({ ok: false, code: "activation_conflict" });
    expect(await protectedRuntime(fixture.workspace).activations.current()).toBeUndefined();
  });
  test("block, complete-ref veto, and stale report mismatch never activate", async () => {
    const blocked = await createFixture({ suffix: "blocked", decision: "block" });
    await expect(blocked.controller.activateFromPreflight(blocked.handoff)).resolves.toMatchObject({
      ok: true,
      status: "blocked",
    });
    expect(await protectedRuntime(blocked.workspace).activations.current()).toBeUndefined();
    const vetoBase = await createFixture({ suffix: "veto-base" });
    const vetoedControls: CapabilityControlReadModel = Object.freeze({
      capabilityId: vetoBase.candidateRef.capabilityId,
      pin: null,
      vetoes: Object.freeze([
        {
          capabilityId: vetoBase.candidateRef.capabilityId,
          rootRevision: vetoBase.candidateRef,
          reason: "user veto",
        },
      ]),
    });
    const vetoController = createAtomicActivationController({
      workspace: vetoBase.workspace,
      protectedRuntime: protectedRuntime(vetoBase.workspace),
      candidates: Object.freeze({
        ...vetoBase.resolver,
        controls: async () => vetoedControls,
      }),
      autonomy,
    });
    await expect(vetoController.activateFromPreflight(vetoBase.handoff)).resolves.toMatchObject({
      ok: true,
      status: "blocked",
    });
    expect(await protectedRuntime(vetoBase.workspace).activations.current()).toBeUndefined();
    const mismatched = await createFixture({ suffix: "mismatch" });
    const stale = Object.freeze({
      ...mismatched.handoff,
      report: Object.freeze({
        ...mismatched.handoff.report,
        candidateRevision: Object.freeze({
          ...mismatched.candidateRef,
          bundleDigest: "f".repeat(64),
        }),
      }),
    });
    await expect(mismatched.controller.activateFromPreflight(stale)).resolves.toMatchObject({
      ok: false,
      code: "validation_failed",
    });
    expect(await protectedRuntime(mismatched.workspace).activations.current()).toBeUndefined();
  });
  test("failure before the SQLite transaction leaves an inert stage and exact retry fails closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-ac-09-before-"));
    const fixture = await createFixture({
      suffix: "before",
      root,
      storeOptions: {
        beforeActivationCommitForTesting: () => {
          throw new Error("injected before activation transaction");
        },
      },
    });
    const first = await fixture.controller.activateFromPreflight(fixture.handoff);
    expect(first).toMatchObject({ ok: false, code: "authority_denied" });
    const operations = await protectedRuntime(fixture.workspace).activations.listOperations();
    expect(operations[0]).toMatchObject({ status: "staged" });
    expect(operations[0]?.materializations.every((item) => !item.published)).toBe(true);
    expect(await protectedRuntime(fixture.workspace).activations.current()).toBeUndefined();
    fixture.workspace.close();
    const reopened = await createWorkspaceStore(root);
    await expect(
      protectedRuntime(reopened).activations.commit({
        operationId: operations[0]?.operationId ?? "missing",
        bindingDigest: operations[0]?.bindingDigest ?? "missing",
      }),
    ).rejects.toThrow("Protected workspace authority failed");
    expect((await protectedRuntime(reopened).activations.current())?.revision).toBeUndefined();
    reopened.close();
  });
  test("failure during the transaction rolls back; failure after commit recovers unambiguously", async () => {
    const duringRoot = await mkdtemp(join(tmpdir(), "noesis-ac-09-during-"));
    const during = await createFixture({
      suffix: "during",
      root: duringRoot,
      storeOptions: {
        duringActivationCommitForTesting: () => {
          throw new Error("injected inside activation transaction");
        },
      },
    });
    await expect(during.controller.activateFromPreflight(during.handoff)).resolves.toMatchObject({
      ok: false,
      code: "authority_denied",
    });
    expect(await protectedRuntime(during.workspace).activations.current()).toBeUndefined();
    expect((await protectedRuntime(during.workspace).activations.listOperations())[0]?.status).toBe("staged");
    const afterRoot = await mkdtemp(join(tmpdir(), "noesis-ac-09-after-"));
    const after = await createFixture({
      suffix: "after",
      root: afterRoot,
      storeOptions: {
        afterActivationCommitForTesting: () => {
          throw new Error("injected after activation commit");
        },
      },
    });
    await expect(after.controller.activateFromPreflight(after.handoff)).resolves.toMatchObject({
      ok: false,
      code: "authority_denied",
    });
    const committedBeforeRestart = (await protectedRuntime(after.workspace).activations.listOperations())[0];
    expect(committedBeforeRestart?.status).toBe("committed");
    expect((await protectedRuntime(after.workspace).activations.current())?.activeDefinitions).toBeDefined();
    expect(committedBeforeRestart?.materializations.every((item) => !item.published)).toBe(true);
    after.workspace.close();
    const reopened = await createWorkspaceStore(afterRoot);
    const recovered = await protectedRuntime(reopened).activations.getOperation(
      committedBeforeRestart?.operationId ?? "missing",
    );
    expect(recovered?.status).toBe("committed");
    expect(recovered?.materializations.every((item) => item.published)).toBe(true);
    expect((await protectedRuntime(reopened).activations.current())?.revision).toBe(1);
    const recoveredController = createAtomicActivationController({
      workspace: reopened,
      protectedRuntime: protectedRuntime(reopened),
      candidates: after.resolver,
      autonomy,
    });
    await expect(recoveredController.activateFromPreflight(after.handoff)).resolves.toMatchObject({
      ok: true,
      status: "activated",
    });
    expect(
      (await protectedRuntime(reopened).activations.listOperations()).filter(
        (item) => item.status === "committed",
      ),
    ).toHaveLength(1);
  });
  test("turn pins survive later activation and history records the prior snapshot", async () => {
    const first = await createFixture({
      suffix: "turn-one",
      capabilityId: "turn-capability",
      extraTool: true,
    });
    const activated = await first.controller.activateFromPreflight(first.handoff);
    expect(activated).toMatchObject({ ok: true, status: "activated" });
    const turnPin = await first.controller.pinTurnActivation("session-1", "turn-1");
    const second = await createFixture({
      suffix: "turn-two",
      capabilityId: "turn-capability",
      root: first.root,
      workspace: first.workspace,
      authorityHome: join(first.root, "authority-turn-two"),
    });
    await expect(second.controller.activateFromPreflight(second.handoff)).resolves.toMatchObject({
      ok: true,
      status: "activated",
    });
    const current = await protectedRuntime(first.workspace).activations.current();
    expect(current?.revision).toBe(2);
    expect(current?.previousActivationId).toBe(turnPin.activationId);
    expect(await protectedRuntime(first.workspace).activations.getTurnPin("session-1", "turn-1")).toEqual(
      turnPin,
    );
    expect(turnPin.activeCapabilityRevisions["turn-capability"]).toEqual(first.candidateRef);
    expect(Object.keys(turnPin.activeDefinitions)).toHaveLength(6);
    expect(current?.activeCapabilityRevisions["turn-capability"]).toEqual(second.candidateRef);
    expect(Object.keys(current?.activeDefinitions ?? {})).toHaveLength(5);
  });
  test("concurrent approvals serialize through activation CAS and never expose a partial set", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-ac-09-concurrent-"));
    const workspace = await createWorkspaceStore(root);
    const first = await createFixture({
      suffix: "concurrent-a",
      capabilityId: "cap-a",
      root,
      workspace,
      activationPolicy: "approval_required",
    });
    const second = await createFixture({
      suffix: "concurrent-b",
      capabilityId: "cap-b",
      root,
      workspace,
      activationPolicy: "approval_required",
    });
    const [pendingA, pendingB] = await Promise.all([
      first.controller.activateFromPreflight(first.handoff),
      second.controller.activateFromPreflight(second.handoff),
    ]);
    if (!pendingA.ok || pendingA.status !== "pending_approval") throw new Error("Expected A approval");
    if (!pendingB.ok || pendingB.status !== "pending_approval") throw new Error("Expected B approval");
    const results = await Promise.all([
      first.controller.approve({
        approvalId: pendingA.approvalId,
        operationId: pendingA.operation.operationId,
        bindingDigest: pendingA.bindingDigest,
      }),
      second.controller.approve({
        approvalId: pendingB.approvalId,
        operationId: pendingB.operation.operationId,
        bindingDigest: pendingB.bindingDigest,
      }),
    ]);
    expect(results.filter((result) => result.ok && result.status === "activated")).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.code === "activation_conflict")).toHaveLength(1);
    const current = await protectedRuntime(workspace).activations.current();
    expect(current?.revision).toBe(1);
    expect(Object.keys(current?.activeCapabilityRevisions ?? {})).toHaveLength(1);
    expect(Object.keys(current?.activeDefinitions ?? {})).toHaveLength(5);
    const firstWon = results[0]?.ok === true && results[0].status === "activated";
    const stalePending = firstWon ? pendingB : pendingA;
    const staleFixture = firstWon ? second : first;
    const fresh = await staleFixture.controller.activateFromPreflight(staleFixture.handoff);
    if (!fresh.ok || fresh.status !== "pending_approval")
      throw new Error("Expected a fresh approval after stale activation CAS");
    expect(fresh.operation.operationId).not.toBe(stalePending.operation.operationId);
    expect(fresh.approvalId).not.toBe(stalePending.approvalId);
    expect(
      await protectedRuntime(workspace).activations.getOperation(stalePending.operation.operationId),
    ).toMatchObject({
      status: "rejected",
      supersededByOperationId: fresh.operation.operationId,
    });
    expect(await protectedRuntime(workspace).activations.getApproval(stalePending.approvalId)).toMatchObject({
      status: "rejected",
      decisionActor: "protected-activation:stale-cas",
    });
    await expect(
      staleFixture.controller.approve({
        approvalId: fresh.approvalId,
        operationId: fresh.operation.operationId,
        bindingDigest: fresh.bindingDigest,
      }),
    ).resolves.toMatchObject({ ok: true, status: "activated" });
    expect((await protectedRuntime(workspace).activations.current())?.revision).toBe(2);
  });
  test("controller leaks no authority handle to candidate resolvers or generated content", async () => {
    const fixture = await createFixture({ suffix: "no-leak" });
    const seen: unknown[] = [];
    const resolver: ActivationCandidateResolver = Object.freeze({
      resolve: async (reference: CapabilityRevisionRef) => {
        seen.push([reference]);
        return await fixture.resolver.resolve(reference);
      },
      lineage: async (reference: CapabilityRevisionRef) => {
        seen.push([reference]);
        return await fixture.resolver.lineage(reference);
      },
      controls: async (capabilityId: string) => {
        seen.push([capabilityId]);
        return await fixture.resolver.controls(capabilityId);
      },
    });
    const controller = createAtomicActivationController({
      workspace: fixture.workspace,
      protectedRuntime: protectedRuntime(fixture.workspace),
      candidates: resolver,
      autonomy,
    });
    await expect(controller.activateFromPreflight(fixture.handoff)).resolves.toMatchObject({
      ok: true,
      status: "activated",
    });
    expect("authority" in controller).toBe(false);
    expect("protectedActivations" in controller).toBe(false);
    expect(
      seen
        .flat(Infinity)
        .some((value) => value && typeof value === "object" && "effect" in value && "resource" in value),
    ).toBe(false);
  });
});
