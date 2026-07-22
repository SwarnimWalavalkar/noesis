import type {
  Capability,
  CapabilityActivationReadModel,
  capabilityRevisionRef,
  DatabaseRowRef,
  DatabaseTable,
  EvaluationRecord,
  Experiment,
  ExperimentTrial,
  ExperimentVariantRef,
  FileRevisionRef,
  ResearchStatePort,
} from "@noesis/domain";
import { createWorkspaceStore } from "@noesis/workspace";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  type CapabilityRevisionConstruction,
  createAtomicCapabilityRegistry,
  createInMemoryCapabilityControlStore,
  createWorkspaceCapabilityControlStore,
} from "../src/index.ts";

const capability: Capability = {
  capabilityId: "source-research",
  name: "Source research",
  scope: "research",
  intent: "Find and cite primary evidence",
};

const fileRef = (name: string, byte: string): FileRevisionRef => ({
  kind: "file_revision",
  revisionId: name,
  workingPath: `definitions/candidates/${name}`,
  snapshotPath: `revisions/${name}`,
  contentDigest: byte.repeat(64),
});

const construction = (
  capabilityRevisionId: string,
  bytes: { readonly prompt: string; readonly tool: string; readonly router: string },
  predecessorRevisionId?: string,
): CapabilityRevisionConstruction => ({
  definitionState: "candidate",
  capabilityRevisionId,
  capabilityId: capability.capabilityId,
  ...(predecessorRevisionId ? { predecessorRevisionId } : {}),
  promptModules: [fileRef("prompt.md", bytes.prompt)],
  skills: [fileRef("skill.md", "b")],
  tools: [fileRef("tool.mjs", bytes.tool)],
  routerRevision: fileRef("router.json", bytes.router),
  routerStrategyId: "research-router",
  activationPolicy: { mode: "automatic_low_risk", scope: "research" },
  permissionManifest: { effects: ["read"], resourcePatterns: ["workspace:"], credentialRefs: [] },
  evidenceRefs: [],
  sourceEvaluationDefinitions: [fileRef("eval.json", "e")],
  requestedPermissionDelta: { addedEffects: [], widenedResources: [], addedCredentialRefs: [] },
});

describe("atomic capability registry", () => {
  test("binds every coupled prompt, tool, and router byte into revision identity", () => {
    const byteVariants: readonly {
      readonly prompt: string;
      readonly tool: string;
      readonly router: string;
    }[] = [
      { prompt: "1", tool: "2", router: "3" },
      { prompt: "4", tool: "2", router: "3" },
      { prompt: "1", tool: "4", router: "3" },
      { prompt: "1", tool: "2", router: "4" },
    ];
    const refs = byteVariants.map((bytes) => {
      const registry = createAtomicCapabilityRegistry();
      registry.registerCapability(capability);
      return registry.constructRevision(construction("revision-1", bytes));
    });

    expect(new Set(refs.map((ref) => ref.bundleDigest)).size).toBe(byteVariants.length);
  });

  test("preserves predecessor lineage and rejects cross-capability predecessors", () => {
    const registry = createAtomicCapabilityRegistry({ controlStore: createInMemoryCapabilityControlStore() });
    registry.registerCapability(capability);
    const first = registry.constructRevision(
      construction("revision-1", { prompt: "1", tool: "2", router: "3" }),
    );
    const second = registry.constructRevision(
      construction("revision-2", { prompt: "4", tool: "2", router: "3" }, first.capabilityRevisionId),
    );

    expect(registry.getRevision(second)?.predecessorRevisionId).toBe(first.capabilityRevisionId);
    expect(registry.listRevisionLineage(capability.capabilityId)).toEqual([first, second]);
    expect(() =>
      registry.constructRevision(
        construction("revision-3", { prompt: "5", tool: "2", router: "3" }, "missing"),
      ),
    ).toThrow("predecessor");
  });

  test("freezes the complete recorded revision bundle", () => {
    const registry = createAtomicCapabilityRegistry();
    registry.registerCapability(capability);
    const ref = registry.constructRevision(
      construction("revision-1", { prompt: "1", tool: "2", router: "3" }),
    );
    const revision = registry.getRevision(ref);

    expect(Object.isFrozen(revision)).toBe(true);
    expect(Object.isFrozen(revision?.promptModules)).toBe(true);
    expect(Object.isFrozen(revision?.promptModules[0])).toBe(true);
    expect(Object.isFrozen(revision?.toolset)).toBe(true);
    expect(Object.isFrozen(revision?.toolset.routerRevision)).toBe(true);
    expect(Object.isFrozen(revision?.permissionManifest.effects)).toBe(true);
    expect(Object.isFrozen(revision?.requestedPermissionDelta)).toBe(true);
  });

  test("keeps candidate definitions separate from externally owned active state", async () => {
    let externallyActive: ReturnType<typeof capabilityRevisionRef> | null = null;
    const registry = createAtomicCapabilityRegistry({
      activationReader: {
        read: async (stableCapability): Promise<CapabilityActivationReadModel> => ({
          capability: stableCapability,
          activeRevision: externallyActive,
          activationPointer: externallyActive
            ? { kind: "database_row", table: "activation_pointers", rowId: "active-1" }
            : null,
        }),
      },
    });
    registry.registerCapability(capability);
    const candidate = registry.constructRevision(
      construction("revision-1", { prompt: "1", tool: "2", router: "3" }),
    );
    const before = await registry.read(capability.capabilityId);
    expect(before?.candidateRevisions[0]?.definitionState).toBe("candidate");
    expect(before?.activation.activeRevision).toBeNull();

    externallyActive = candidate;
    const after = await registry.read(capability.capabilityId);
    expect(after?.candidateRevisions[0]?.definitionState).toBe("candidate");
    expect(after?.activation.activeRevision).toEqual(candidate);
    expect("activate" in registry).toBe(false);
  });

  test("tracks pin and predecessor-rooted veto metadata without mutating activation", async () => {
    const registry = createAtomicCapabilityRegistry({
      controlStore: createInMemoryCapabilityControlStore(),
    });
    registry.registerCapability(capability);
    const first = registry.constructRevision(
      construction("revision-1", { prompt: "1", tool: "2", router: "3" }),
    );
    registry.constructRevision(
      construction("revision-2", { prompt: "4", tool: "2", router: "3" }, first.capabilityRevisionId),
    );
    await registry.pin({ capabilityId: capability.capabilityId, revision: first, reason: "user pin" });
    await registry.veto({
      capabilityId: capability.capabilityId,
      rootRevision: first,
      reason: "user veto",
    });

    const readModel = await registry.read(capability.capabilityId);
    expect(readModel?.candidateRevisions.map(({ pinned, vetoed }) => ({ pinned, vetoed }))).toEqual([
      { pinned: true, vetoed: true },
      { pinned: false, vetoed: true },
    ]);
    expect(readModel?.controls).toEqual({
      capabilityId: capability.capabilityId,
      pin: { capabilityId: capability.capabilityId, revision: first, reason: "user pin" },
      vetoes: [{ capabilityId: capability.capabilityId, rootRevision: first, reason: "user veto" }],
    });
    expect("activate" in ((await registry.readControls(capability.capabilityId)) ?? {})).toBe(false);
  });

  test("binds pin and veto controls to the canonical capability revision digest", async () => {
    const registry = createAtomicCapabilityRegistry({ controlStore: createInMemoryCapabilityControlStore() });
    registry.registerCapability(capability);
    const revision = registry.constructRevision(
      construction("revision-1", { prompt: "1", tool: "2", router: "3" }),
    );
    const digestMismatch = { ...revision, bundleDigest: "f".repeat(64) };

    expect(
      await registry.pin({
        capabilityId: capability.capabilityId,
        revision: digestMismatch,
        reason: "bad pin",
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_control" } });
    expect(
      await registry.veto({
        capabilityId: capability.capabilityId,
        rootRevision: digestMismatch,
        reason: "bad veto",
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_control" } });
    expect(await registry.readControls(capability.capabilityId)).toEqual({
      capabilityId: capability.capabilityId,
      pin: null,
      vetoes: [],
    });
  });

  test("reloads canonical-file pin and veto controls through WorkspaceStore revisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-capability-controls-"));
    try {
      const firstWorkspace = await createWorkspaceStore(root);
      const firstRegistry = createAtomicCapabilityRegistry({
        controlStore: createWorkspaceCapabilityControlStore(firstWorkspace),
      });
      firstRegistry.registerCapability(capability);
      const firstRevision = firstRegistry.constructRevision(
        construction("revision-1", { prompt: "1", tool: "2", router: "3" }),
      );
      await expect(
        firstRegistry.pin({
          capabilityId: capability.capabilityId,
          revision: firstRevision,
          reason: "durable user pin",
        }),
      ).resolves.toMatchObject({ ok: true });
      await expect(
        firstRegistry.veto({
          capabilityId: capability.capabilityId,
          rootRevision: firstRevision,
          reason: "durable lineage veto",
        }),
      ).resolves.toMatchObject({ ok: true });
      firstWorkspace.close();

      const secondWorkspace = await createWorkspaceStore(root);
      const secondRegistry = createAtomicCapabilityRegistry({
        controlStore: createWorkspaceCapabilityControlStore(secondWorkspace),
      });
      secondRegistry.registerCapability(capability);
      secondRegistry.constructRevision(construction("revision-1", { prompt: "1", tool: "2", router: "3" }));
      expect(await secondRegistry.readControls(capability.capabilityId)).toEqual({
        capabilityId: capability.capabilityId,
        pin: {
          capabilityId: capability.capabilityId,
          revision: firstRevision,
          reason: "durable user pin",
        },
        vetoes: [
          {
            capabilityId: capability.capabilityId,
            rootRevision: firstRevision,
            reason: "durable lineage veto",
          },
        ],
      });
      expect(
        await secondWorkspace.definitionMetadata.listRevisions("capability_control", capability.capabilityId),
      ).toHaveLength(2);
      secondWorkspace.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("links only explicit children of the canonical Experiment lifecycle", async () => {
    let experiment: Experiment | undefined;
    let trial: ExperimentTrial | undefined;
    let evaluation: EvaluationRecord | undefined;
    const row = <Table extends DatabaseTable>(table: Table, rowId: string): DatabaseRowRef<Table> => ({
      kind: "database_row",
      table,
      rowId,
    });
    const researchState: ResearchStatePort = {
      experiments: {
        getExperiment: async (experimentId) =>
          experiment?.experimentId === experimentId ? experiment : undefined,
        listExperiments: async (request) => {
          const current = experiment;
          if (!current || (request.status !== undefined && current.status !== request.status)) return [];
          return [current].slice(0, request.limit);
        },
        putExperiment: async (value) => row("experiments", value.experimentId),
      },
      trials: {
        getTrial: async (trialId) => (trial?.trialId === trialId ? trial : undefined),
        listTrials: async (experimentId) => {
          const current = trial;
          return current?.experimentId === experimentId ? [current] : [];
        },
        putTrial: async (value) => row("experiment_trials", value.trialId),
      },
      preflights: {
        getPreflightPlan: async () => undefined,
        putPreflightPlan: async (value) => row("preflight_plans", value.planId),
        getPreflightReport: async () => undefined,
        putPreflightReport: async (value) => row("preflight_reports", value.preflightId),
        completePreflight: async ({ report, evaluation: completedEvaluation }) => ({
          report: row("preflight_reports", report.preflightId),
          evaluation: row("evaluations", completedEvaluation.evaluationId),
        }),
      },
      evaluations: {
        getEvaluation: async (evaluationId) =>
          evaluation?.evaluationId === evaluationId ? evaluation : undefined,
        listEvaluations: async (experimentId) => {
          const current = evaluation;
          return current?.experimentId === experimentId ? [current] : [];
        },
        putEvaluation: async (value) => row("evaluations", value.evaluationId),
      },
      feedbackSignals: {
        getFeedbackSignal: async () => undefined,
        recordFeedbackSignal: async (value) => row("feedback_signals", value.signalId),
      },
    };
    const registry = createAtomicCapabilityRegistry({ researchState });
    registry.registerCapability(capability);
    const baseline = registry.constructRevision(
      construction("revision-1", { prompt: "1", tool: "2", router: "3" }),
    );
    const candidate = registry.constructRevision(
      construction("revision-2", { prompt: "4", tool: "2", router: "3" }, "revision-1"),
    );
    experiment = {
      experimentId: "experiment-1",
      hypothesis: "The revision improves research",
      scope: "research",
      evidenceRefs: [],
      baselineRevision: baseline,
      candidateRevisions: [candidate],
      feedbackSignalIds: [],
      status: "preflight",
    };
    const variant: ExperimentVariantRef = {
      variantId: "fake",
      axis: "tool_runtime",
      configurationRefs: [],
    };
    trial = {
      trialId: "trial-1",
      experimentId: experiment.experimentId,
      comparisonGroupId: "comparison-1",
      arm: "candidate",
      capabilityRevision: candidate,
      inputRefs: [],
      outputEvidenceRefs: [],
      traceEvidenceRefs: [],
      variant,
      status: "completed",
    };
    evaluation = {
      evaluationId: "evaluation-1",
      experimentId: experiment.experimentId,
      preflightId: "preflight-1",
      candidateRevision: candidate,
      trialIds: [trial.trialId],
      evidenceRefs: [],
      status: "completed",
    };
    await registry.recordResearchRefs(candidate, {
      experimentId: experiment.experimentId,
      trialRefs: [row("experiment_trials", trial.trialId)],
      evaluationRefs: [row("evaluations", evaluation.evaluationId)],
    });

    expect((await registry.read(capability.capabilityId))?.candidateRevisions[1]?.researchRefs).toEqual({
      experimentId: "experiment-1",
      trialRefs: [row("experiment_trials", "trial-1")],
      evaluationRefs: [row("evaluations", "evaluation-1")],
    });
    await expect(
      registry.recordResearchRefs(candidate, {
        experimentId: "different-experiment",
        trialRefs: [],
        evaluationRefs: [],
      }),
    ).rejects.toThrow("canonical Experiment");
  });

  test("rejects a reused revision id with different coupled bytes", () => {
    const registry = createAtomicCapabilityRegistry();
    registry.registerCapability(capability);
    registry.constructRevision(construction("revision-1", { prompt: "1", tool: "2", router: "3" }));
    expect(() =>
      registry.constructRevision(construction("revision-1", { prompt: "9", tool: "2", router: "3" })),
    ).toThrow("identity collision");
  });
});
