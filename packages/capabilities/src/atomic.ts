import {
  CapabilityRevisionRefSchema,
  err,
  ok,
  type ActivationPolicy,
  type Capability,
  type CapabilityActivationReadModel,
  type CapabilityRevision,
  type CapabilityRevisionRef,
  capabilityRevisionRef,
  type DatabaseRowRef,
  type EvidenceRef,
  type FileRevisionRef,
  type PermissionDelta,
  type PermissionManifest,
  type ResearchStatePort,
  type Result,
  sameCapabilityRevisionRef,
} from "@noesis/domain";
import { z } from "zod";
import type { CandidateSkill } from "./index.ts";

export interface CapabilityRevisionConstruction {
  /** Candidate definitions are materialized separately; this registry never accepts active working bytes. */
  readonly definitionState: "candidate";
  readonly capabilityRevisionId: string;
  readonly capabilityId: string;
  readonly predecessorRevisionId?: string;
  readonly promptModules: readonly FileRevisionRef[];
  readonly skills: readonly FileRevisionRef[];
  readonly tools: readonly FileRevisionRef[];
  readonly routerRevision: FileRevisionRef;
  readonly routerStrategyId: string;
  readonly activationPolicy: ActivationPolicy;
  readonly dependencyLock?: FileRevisionRef;
  readonly permissionManifest: PermissionManifest;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly sourceEvaluationDefinitions: readonly FileRevisionRef[];
  readonly requestedPermissionDelta: PermissionDelta;
}

export interface CapabilityRevisionResearchRefs {
  readonly experimentId: string;
  readonly trialRefs: readonly DatabaseRowRef<"experiment_trials">[];
  readonly preflightPlanRef?: DatabaseRowRef<"preflight_plans">;
  readonly preflightReportRef?: DatabaseRowRef<"preflight_reports">;
  readonly evaluationRefs: readonly DatabaseRowRef<"evaluations">[];
}

export interface CapabilityPinMetadata {
  readonly capabilityId: string;
  readonly revision: CapabilityRevisionRef;
  readonly reason: string;
}

export const CapabilityPinMetadataSchema = z.strictObject({
  capabilityId: z.string().min(1),
  revision: CapabilityRevisionRefSchema,
  reason: z.string().min(1),
});

export interface CapabilityVetoMetadata {
  readonly capabilityId: string;
  readonly rootRevision: CapabilityRevisionRef;
  readonly reason: string;
}

export const CapabilityVetoMetadataSchema = z.strictObject({
  capabilityId: z.string().min(1),
  rootRevision: CapabilityRevisionRefSchema,
  reason: z.string().min(1),
});

export interface CapabilityControlError {
  readonly code: "invalid_control";
  readonly message: string;
  readonly capabilityId: string;
}

export interface CapabilityControlReadModel {
  readonly capabilityId: string;
  readonly pin: CapabilityPinMetadata | null;
  readonly vetoes: readonly CapabilityVetoMetadata[];
}

export interface CapabilityRevisionReadModel {
  readonly revision: CapabilityRevision;
  readonly revisionRef: CapabilityRevisionRef;
  readonly definitionState: "candidate";
  readonly researchRefs?: CapabilityRevisionResearchRefs;
  readonly pinned: boolean;
  readonly vetoed: boolean;
}

export interface CapabilityReadModel {
  readonly capability: Capability;
  readonly candidateRevisions: readonly CapabilityRevisionReadModel[];
  readonly controls: CapabilityControlReadModel;
  readonly activation: CapabilityActivationReadModel;
}

export interface CapabilityActivationReader {
  readonly read: (capability: Capability) => Promise<CapabilityActivationReadModel>;
}

export interface AtomicCapabilityRegistryOptions {
  readonly activationReader?: CapabilityActivationReader;
  readonly researchState?: ResearchStatePort;
}

export interface AtomicCapabilityRegistry {
  readonly registerCapability: (capability: Capability) => Capability;
  readonly constructRevision: (construction: CapabilityRevisionConstruction) => CapabilityRevisionRef;
  readonly getCapability: (capabilityId: string) => Capability | undefined;
  readonly getRevision: (ref: CapabilityRevisionRef) => CapabilityRevision | undefined;
  readonly listRevisionLineage: (capabilityId: string) => readonly CapabilityRevisionRef[];
  readonly discover: (scope: string) => readonly Capability[];
  readonly recordResearchRefs: (
    revision: CapabilityRevisionRef,
    refs: CapabilityRevisionResearchRefs,
  ) => Promise<void>;
  readonly pin: (metadata: CapabilityPinMetadata) => Result<CapabilityPinMetadata, CapabilityControlError>;
  readonly veto: (metadata: CapabilityVetoMetadata) => Result<CapabilityVetoMetadata, CapabilityControlError>;
  readonly readControls: (capabilityId: string) => CapabilityControlReadModel | undefined;
  readonly read: (capabilityId: string) => Promise<CapabilityReadModel | undefined>;
}

function cloneFileRevision(ref: FileRevisionRef): FileRevisionRef {
  return Object.freeze({ ...ref });
}

function freezeCapability(capability: Capability): Capability {
  return Object.freeze({ ...capability });
}

function freezeRevision(construction: CapabilityRevisionConstruction): CapabilityRevision {
  const tools = Object.freeze(construction.tools.map(cloneFileRevision));
  const dependencyLock = construction.dependencyLock
    ? cloneFileRevision(construction.dependencyLock)
    : undefined;
  return Object.freeze({
    capabilityRevisionId: construction.capabilityRevisionId,
    capabilityId: construction.capabilityId,
    ...(construction.predecessorRevisionId
      ? { predecessorRevisionId: construction.predecessorRevisionId }
      : {}),
    promptModules: Object.freeze(construction.promptModules.map(cloneFileRevision)),
    skills: Object.freeze(construction.skills.map(cloneFileRevision)),
    tools,
    toolset: Object.freeze({
      toolRevisionIds: Object.freeze(tools.map((tool) => tool.revisionId)),
      routerRevision: cloneFileRevision(construction.routerRevision),
      strategyId: construction.routerStrategyId,
    }),
    activationPolicy: Object.freeze({ ...construction.activationPolicy }),
    ...(dependencyLock ? { dependencyLock } : {}),
    permissionManifest: Object.freeze({
      effects: Object.freeze([...construction.permissionManifest.effects]),
      resourcePatterns: Object.freeze([...construction.permissionManifest.resourcePatterns]),
      credentialRefs: Object.freeze([...construction.permissionManifest.credentialRefs]),
    }),
    evidenceRefs: Object.freeze(
      construction.evidenceRefs.map((evidenceRef) => Object.freeze({ ...evidenceRef })),
    ),
    sourceEvaluationDefinitions: Object.freeze(
      construction.sourceEvaluationDefinitions.map(cloneFileRevision),
    ),
    requestedPermissionDelta: Object.freeze({
      addedEffects: Object.freeze([...construction.requestedPermissionDelta.addedEffects]),
      widenedResources: Object.freeze([...construction.requestedPermissionDelta.widenedResources]),
      addedCredentialRefs: Object.freeze([...construction.requestedPermissionDelta.addedCredentialRefs]),
    }),
  });
}

function assertRowTable(ref: DatabaseRowRef, table: DatabaseRowRef["table"]): void {
  if (ref.table !== table) throw new Error(`Expected ${table} row reference, received ${ref.table}`);
}

function includesRevision(
  revisions: readonly CapabilityRevisionRef[],
  target: CapabilityRevisionRef,
): boolean {
  return revisions.some((revision) => sameCapabilityRevisionRef(revision, target));
}

export function createAtomicCapabilityRegistry(
  options: AtomicCapabilityRegistryOptions = {},
): AtomicCapabilityRegistry {
  const capabilities = new Map<string, Capability>();
  const revisions = new Map<string, CapabilityRevision>();
  const researchRefs = new Map<string, CapabilityRevisionResearchRefs>();
  const pins = new Map<string, CapabilityPinMetadata>();
  const vetoes = new Map<string, CapabilityVetoMetadata[]>();

  const registerCapability = (input: Capability): Capability => {
    const existing = capabilities.get(input.capabilityId);
    if (existing) {
      if (
        existing.name !== input.name ||
        existing.scope !== input.scope ||
        existing.intent !== input.intent
      ) {
        throw new Error(`Capability identity collision for ${input.capabilityId}`);
      }
      return existing;
    }
    const capability = freezeCapability(input);
    capabilities.set(capability.capabilityId, capability);
    return capability;
  };

  const getStoredRevision = (capabilityRevisionId: string): CapabilityRevision | undefined =>
    revisions.get(capabilityRevisionId);

  const constructRevision = (construction: CapabilityRevisionConstruction): CapabilityRevisionRef => {
    if (!capabilities.has(construction.capabilityId)) {
      throw new Error(`Unknown capability ${construction.capabilityId}`);
    }
    if (construction.predecessorRevisionId) {
      const predecessor = getStoredRevision(construction.predecessorRevisionId);
      if (!predecessor || predecessor.capabilityId !== construction.capabilityId) {
        throw new Error("A predecessor must be an existing revision of the same capability");
      }
    }
    const revision = freezeRevision(construction);
    const ref = capabilityRevisionRef(revision);
    const existing = getStoredRevision(revision.capabilityRevisionId);
    if (existing) {
      const existingRef = capabilityRevisionRef(existing);
      if (!sameCapabilityRevisionRef(existingRef, ref)) {
        throw new Error(`Capability revision identity collision for ${revision.capabilityRevisionId}`);
      }
      return existingRef;
    }
    revisions.set(revision.capabilityRevisionId, revision);
    return ref;
  };

  const getCapability = (capabilityId: string): Capability | undefined => capabilities.get(capabilityId);

  const getRevision = (ref: CapabilityRevisionRef): CapabilityRevision | undefined => {
    const revision = getStoredRevision(ref.capabilityRevisionId);
    if (!revision) return undefined;
    const actual = capabilityRevisionRef(revision);
    return sameCapabilityRevisionRef(actual, ref) ? revision : undefined;
  };

  const listRevisionLineage = (capabilityId: string): readonly CapabilityRevisionRef[] =>
    Object.freeze(
      [...revisions.values()]
        .filter((revision) => revision.capabilityId === capabilityId)
        .map(capabilityRevisionRef),
    );

  const discover = (scope: string): readonly Capability[] =>
    Object.freeze(
      [...capabilities.values()].filter(
        (capability) => capability.scope === scope || scope.startsWith(`${capability.scope}/`),
      ),
    );

  const recordResearchRefs = async (
    revisionRef: CapabilityRevisionRef,
    refs: CapabilityRevisionResearchRefs,
  ): Promise<void> => {
    if (!getRevision(revisionRef)) throw new Error("Unknown or digest-mismatched capability revision");
    for (const ref of refs.trialRefs) assertRowTable(ref, "experiment_trials");
    for (const ref of refs.evaluationRefs) assertRowTable(ref, "evaluations");
    if (refs.preflightPlanRef) assertRowTable(refs.preflightPlanRef, "preflight_plans");
    if (refs.preflightReportRef) assertRowTable(refs.preflightReportRef, "preflight_reports");

    if (options.researchState) {
      const experiment = await options.researchState.experiments.getExperiment(refs.experimentId);
      if (!experiment || !includesRevision(experiment.candidateRevisions, revisionRef)) {
        throw new Error("Research references must belong to the canonical Experiment candidate revision");
      }
      const trials = await options.researchState.trials.listTrials(refs.experimentId);
      for (const trialRef of refs.trialRefs) {
        if (!trials.some((trial) => trial.trialId === trialRef.rowId)) {
          throw new Error(`Unknown ExperimentTrial ${trialRef.rowId}`);
        }
      }
      for (const evaluationRef of refs.evaluationRefs) {
        const evaluation = await options.researchState.evaluations.getEvaluation(evaluationRef.rowId);
        if (!evaluation || evaluation.experimentId !== refs.experimentId) {
          throw new Error(`Evaluation ${evaluationRef.rowId} does not belong to the Experiment`);
        }
      }
      if (refs.preflightPlanRef) {
        const plan = await options.researchState.preflights.getPreflightPlan(refs.preflightPlanRef.rowId);
        if (!plan || !sameCapabilityRevisionRef(plan.candidateRevision, revisionRef)) {
          throw new Error("Preflight plan is not pinned to this capability revision");
        }
      }
      if (refs.preflightReportRef) {
        const report = await options.researchState.preflights.getPreflightReport(
          refs.preflightReportRef.rowId,
        );
        if (!report || !sameCapabilityRevisionRef(report.candidateRevision, revisionRef)) {
          throw new Error("Preflight report is not pinned to this capability revision");
        }
      }
    }

    researchRefs.set(
      revisionRef.capabilityRevisionId,
      Object.freeze({
        ...refs,
        trialRefs: Object.freeze(refs.trialRefs.map((ref) => Object.freeze({ ...ref }))),
        evaluationRefs: Object.freeze(refs.evaluationRefs.map((ref) => Object.freeze({ ...ref }))),
      }),
    );
  };

  const pin = (metadata: CapabilityPinMetadata): Result<CapabilityPinMetadata, CapabilityControlError> => {
    const parsed = CapabilityPinMetadataSchema.safeParse(metadata);
    if (
      !parsed.success ||
      !getRevision(parsed.data.revision) ||
      parsed.data.capabilityId !== parsed.data.revision.capabilityId
    ) {
      return err({
        code: "invalid_control",
        message: "Pin metadata must identify a recorded revision of the capability",
        capabilityId: metadata.capabilityId,
      });
    }
    const stored = Object.freeze({
      ...parsed.data,
      revision: Object.freeze({ ...parsed.data.revision }),
    });
    pins.set(parsed.data.capabilityId, stored);
    return ok(stored);
  };

  const veto = (metadata: CapabilityVetoMetadata): Result<CapabilityVetoMetadata, CapabilityControlError> => {
    const parsed = CapabilityVetoMetadataSchema.safeParse(metadata);
    if (
      !parsed.success ||
      !getRevision(parsed.data.rootRevision) ||
      parsed.data.rootRevision.capabilityId !== parsed.data.capabilityId
    ) {
      return err({
        code: "invalid_control",
        message: "Veto metadata must identify a recorded revision lineage",
        capabilityId: metadata.capabilityId,
      });
    }
    const stored = Object.freeze({
      ...parsed.data,
      rootRevision: Object.freeze({ ...parsed.data.rootRevision }),
    });
    const existing = vetoes.get(parsed.data.capabilityId) ?? [];
    vetoes.set(parsed.data.capabilityId, [...existing, stored]);
    return ok(stored);
  };

  const isVetoed = (revision: CapabilityRevision): boolean => {
    const lineageRoots = (vetoes.get(revision.capabilityId) ?? []).map((item) => item.rootRevision);
    let current: CapabilityRevision | undefined = revision;
    while (current) {
      const currentRef = capabilityRevisionRef(current);
      if (lineageRoots.some((root) => sameCapabilityRevisionRef(root, currentRef))) return true;
      current = current.predecessorRevisionId ? getStoredRevision(current.predecessorRevisionId) : undefined;
    }
    return false;
  };

  const readControls = (capabilityId: string): CapabilityControlReadModel | undefined => {
    if (!getCapability(capabilityId)) return undefined;
    const pinMetadata = pins.get(capabilityId);
    const vetoMetadata = vetoes.get(capabilityId) ?? [];
    return Object.freeze({
      capabilityId,
      pin: pinMetadata
        ? Object.freeze({
            ...pinMetadata,
            revision: Object.freeze({ ...pinMetadata.revision }),
          })
        : null,
      vetoes: Object.freeze(
        vetoMetadata.map((item) =>
          Object.freeze({
            ...item,
            rootRevision: Object.freeze({ ...item.rootRevision }),
          }),
        ),
      ),
    });
  };

  const read = async (capabilityId: string): Promise<CapabilityReadModel | undefined> => {
    const capability = getCapability(capabilityId);
    if (!capability) return undefined;
    const activation = options.activationReader
      ? await options.activationReader.read(capability)
      : Object.freeze({ capability, activeRevision: null, activationPointer: null });
    const pinMetadata = pins.get(capabilityId);
    const controls = readControls(capabilityId);
    if (!controls) return undefined;
    const candidateRevisions = [...revisions.values()]
      .filter((revision) => revision.capabilityId === capabilityId)
      .map((revision) => {
        const revisionRef = capabilityRevisionRef(revision);
        const refs = researchRefs.get(revision.capabilityRevisionId);
        const model: CapabilityRevisionReadModel = Object.freeze({
          revision,
          revisionRef,
          definitionState: "candidate",
          ...(refs ? { researchRefs: refs } : {}),
          pinned: pinMetadata ? sameCapabilityRevisionRef(pinMetadata.revision, revisionRef) : false,
          vetoed: isVetoed(revision),
        });
        return model;
      });
    return Object.freeze({
      capability,
      candidateRevisions: Object.freeze(candidateRevisions),
      controls,
      activation,
    });
  };

  return Object.freeze({
    registerCapability,
    constructRevision,
    getCapability,
    getRevision,
    listRevisionLineage,
    discover,
    recordResearchRefs,
    pin,
    veto,
    readControls,
    read,
  });
}

export interface LegacyCapabilityMaterialization {
  readonly construction: Omit<
    CapabilityRevisionConstruction,
    "capabilityId" | "capabilityRevisionId" | "predecessorRevisionId"
  >;
}

export interface LegacyCapabilityMigration {
  readonly migrate: (
    candidate: CandidateSkill,
    capability: Capability,
    capabilityRevisionId: string,
    predecessorRevisionId?: string,
  ) => Promise<CapabilityRevisionRef>;
}

/** Explicit seam for materializing legacy ledger candidates into byte-stable AC-03 definitions. */
export function createLegacyCapabilityMigration(
  registry: AtomicCapabilityRegistry,
  materialize: (candidate: CandidateSkill) => Promise<LegacyCapabilityMaterialization>,
): LegacyCapabilityMigration {
  return Object.freeze({
    migrate: async (
      candidate: CandidateSkill,
      capability: Capability,
      capabilityRevisionId: string,
      predecessorRevisionId?: string,
    ): Promise<CapabilityRevisionRef> => {
      if (candidate.capabilityId !== capability.capabilityId) {
        throw new Error("Legacy candidate and stable capability identities differ");
      }
      registry.registerCapability(capability);
      const materialized = await materialize(candidate);
      return registry.constructRevision({
        ...materialized.construction,
        capabilityId: capability.capabilityId,
        capabilityRevisionId,
        ...(predecessorRevisionId ? { predecessorRevisionId } : {}),
      });
    },
  });
}
