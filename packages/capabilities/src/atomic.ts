import {
  CapabilityRevisionRefSchema,
  err,
  ok,
  type ActivationPolicy,
  type Capability,
  type CapabilityEffect,
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
  type WorkspaceStore,
  sameCapabilityRevisionRef,
  sha256,
} from "@noesis/domain";
import { z } from "zod";

export interface CapabilityRevisionConstruction {
  /** Candidate definitions are materialized separately; this registry never accepts active working bytes. */
  readonly definitionState: "candidate";
  readonly capabilityRevisionId: string;
  readonly capabilityId: string;
  readonly predecessorRevisionId?: string;
  readonly effects?: readonly CapabilityEffect[];
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

export interface CapabilityControlState {
  readonly controls: CapabilityControlReadModel;
  readonly revision?: FileRevisionRef;
}

export interface CapabilityControlStorePort {
  readonly read: (capabilityId: string) => Promise<CapabilityControlState>;
  readonly commit: (request: {
    readonly controls: CapabilityControlReadModel;
    readonly expectedRevisionId?: string;
  }) => Promise<Result<CapabilityControlState, CapabilityControlError>>;
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
  readonly controlStore?: CapabilityControlStorePort;
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
  readonly pin: (
    metadata: CapabilityPinMetadata,
  ) => Promise<Result<CapabilityPinMetadata, CapabilityControlError>>;
  readonly veto: (
    metadata: CapabilityVetoMetadata,
  ) => Promise<Result<CapabilityVetoMetadata, CapabilityControlError>>;
  readonly readControls: (capabilityId: string) => Promise<CapabilityControlReadModel | undefined>;
  readonly read: (capabilityId: string) => Promise<CapabilityReadModel | undefined>;
}

const CapabilityControlReadModelSchema: z.ZodType<CapabilityControlReadModel> = z.strictObject({
  capabilityId: z.string().min(1),
  pin: CapabilityPinMetadataSchema.nullable(),
  vetoes: z.array(CapabilityVetoMetadataSchema),
});

function emptyControls(capabilityId: string): CapabilityControlReadModel {
  return Object.freeze({ capabilityId, pin: null, vetoes: Object.freeze([]) });
}

function freezeControls(value: CapabilityControlReadModel): CapabilityControlReadModel {
  return Object.freeze({
    capabilityId: value.capabilityId,
    pin: value.pin
      ? Object.freeze({ ...value.pin, revision: Object.freeze({ ...value.pin.revision }) })
      : null,
    vetoes: Object.freeze(
      value.vetoes.map((item) =>
        Object.freeze({ ...item, rootRevision: Object.freeze({ ...item.rootRevision }) }),
      ),
    ),
  });
}

export function createInMemoryCapabilityControlStore(): CapabilityControlStorePort {
  const states = new Map<string, CapabilityControlState>();
  const store: CapabilityControlStorePort = {
    read: async (capabilityId) => states.get(capabilityId) ?? { controls: emptyControls(capabilityId) },
    commit: async (request): Promise<Result<CapabilityControlState, CapabilityControlError>> => {
      const current = states.get(request.controls.capabilityId);
      if (current?.revision?.revisionId !== request.expectedRevisionId)
        return err({
          code: "invalid_control",
          message: "Capability controls changed concurrently",
          capabilityId: request.controls.capabilityId,
        });
      const sequence = (current?.revision ? Number(current.revision.revisionId.split("-").at(-1)) : 0) + 1;
      const bytes = new TextEncoder().encode(JSON.stringify(request.controls));
      const revision: FileRevisionRef = {
        kind: "file_revision",
        revisionId: `memory-control-${sequence}`,
        workingPath: `definitions/capabilities/${request.controls.capabilityId}/controls.json`,
        snapshotPath: `revisions/memory-control-${sequence}/controls.json`,
        contentDigest: sha256(bytes),
      };
      const state = Object.freeze({ controls: freezeControls(request.controls), revision });
      states.set(request.controls.capabilityId, state);
      return ok(state);
    },
  };
  return Object.freeze(store);
}

export function createWorkspaceCapabilityControlStore(
  workspace: Pick<WorkspaceStore, "definitionMetadata" | "definitionPublications" | "reads">,
): CapabilityControlStorePort {
  const namespace = "capability_control";
  const actor = { actorId: "capability-control-store", kind: "system" as const };
  const read = async (capabilityId: string): Promise<CapabilityControlState> => {
    const metadata = await workspace.definitionMetadata.getCurrent(namespace, capabilityId);
    if (!metadata) return { controls: emptyControls(capabilityId) };
    const parsed = CapabilityControlReadModelSchema.parse(
      JSON.parse(
        new TextDecoder("utf8", { fatal: true }).decode(
          await workspace.reads.readRevision(metadata.definitionRevision),
        ),
      ),
    );
    if (parsed.capabilityId !== capabilityId)
      throw new Error("Capability control file identity does not match its revision metadata");
    if (
      parsed.pin &&
      (parsed.pin.capabilityId !== capabilityId || parsed.pin.revision.capabilityId !== capabilityId)
    )
      throw new Error("Capability pin identity does not match its control file");
    if (
      parsed.vetoes.some(
        (veto) => veto.capabilityId !== capabilityId || veto.rootRevision.capabilityId !== capabilityId,
      )
    )
      throw new Error("Capability veto identity does not match its control file");
    return Object.freeze({ controls: freezeControls(parsed), revision: metadata.definitionRevision });
  };
  const store: CapabilityControlStorePort = {
    read,
    commit: async (request): Promise<Result<CapabilityControlState, CapabilityControlError>> => {
      const current = await read(request.controls.capabilityId);
      if (current.revision?.revisionId !== request.expectedRevisionId)
        return err({
          code: "invalid_control",
          message: "Capability controls changed concurrently",
          capabilityId: request.controls.capabilityId,
        });
      const parsed = CapabilityControlReadModelSchema.parse(request.controls);
      const currentMetadata = await workspace.definitionMetadata.getCurrent(namespace, parsed.capabilityId);
      const committed = await workspace.definitionPublications.publish({
        namespace,
        definitionId: parsed.capabilityId,
        revision: (currentMetadata?.revision ?? 0) + 1,
        workingPath: `capabilities/${parsed.capabilityId}/controls.json`,
        bytes: new TextEncoder().encode(`${JSON.stringify(parsed, null, 2)}\n`),
        ...(request.expectedRevisionId === undefined
          ? {}
          : { expectedCurrentRevisionId: request.expectedRevisionId }),
        sensitivity: "normal",
        activity: { kind: "capability.controls_updated", actor },
      });
      if (!committed.ok)
        return err({
          code: "invalid_control",
          message: committed.error.message,
          capabilityId: parsed.capabilityId,
        });
      return ok({ controls: freezeControls(parsed), revision: committed.value.definitionRevision });
    },
  };
  return Object.freeze(store);
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
    ...(construction.effects
      ? {
          effects: Object.freeze(
            construction.effects.map((effect) =>
              Object.freeze(
                effect.kind === "instruction" || effect.kind === "skill"
                  ? { ...effect, material: cloneFileRevision(effect.material) }
                  : {
                      ...effect,
                      project: Object.freeze({ ...effect.project }),
                      definitionRevision: cloneFileRevision(effect.definitionRevision),
                    },
              ),
            ),
          ),
        }
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
  const controlStore: CapabilityControlStorePort =
    options.controlStore ??
    Object.freeze({
      read: async (capabilityId: string) => ({ controls: emptyControls(capabilityId) }),
      commit: async (request: { readonly controls: CapabilityControlReadModel }) =>
        err({
          code: "invalid_control" as const,
          message: "Capability control mutation requires a durable control store",
          capabilityId: request.controls.capabilityId,
        }),
    });

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

  const pin = async (
    metadata: CapabilityPinMetadata,
  ): Promise<Result<CapabilityPinMetadata, CapabilityControlError>> => {
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
    const current = await controlStore.read(parsed.data.capabilityId);
    const committed = await controlStore.commit({
      controls: freezeControls({ ...current.controls, pin: stored }),
      ...(current.revision === undefined ? {} : { expectedRevisionId: current.revision.revisionId }),
    });
    return committed.ok ? ok(stored) : committed;
  };

  const veto = async (
    metadata: CapabilityVetoMetadata,
  ): Promise<Result<CapabilityVetoMetadata, CapabilityControlError>> => {
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
    const current = await controlStore.read(parsed.data.capabilityId);
    const committed = await controlStore.commit({
      controls: freezeControls({ ...current.controls, vetoes: [...current.controls.vetoes, stored] }),
      ...(current.revision === undefined ? {} : { expectedRevisionId: current.revision.revisionId }),
    });
    return committed.ok ? ok(stored) : committed;
  };

  const isVetoed = (revision: CapabilityRevision, controls: CapabilityControlReadModel): boolean => {
    const lineageRoots = controls.vetoes.map((item) => item.rootRevision);
    let current: CapabilityRevision | undefined = revision;
    while (current) {
      const currentRef = capabilityRevisionRef(current);
      if (lineageRoots.some((root) => sameCapabilityRevisionRef(root, currentRef))) return true;
      current = current.predecessorRevisionId ? getStoredRevision(current.predecessorRevisionId) : undefined;
    }
    return false;
  };

  const readControls = async (capabilityId: string): Promise<CapabilityControlReadModel | undefined> => {
    if (!getCapability(capabilityId)) return undefined;
    return freezeControls((await controlStore.read(capabilityId)).controls);
  };

  const read = async (capabilityId: string): Promise<CapabilityReadModel | undefined> => {
    const capability = getCapability(capabilityId);
    if (!capability) return undefined;
    const activation = options.activationReader
      ? await options.activationReader.read(capability)
      : Object.freeze({ capability, activeRevision: null, activationPointer: null });
    const controls = await readControls(capabilityId);
    if (!controls) return undefined;
    const pinMetadata = controls.pin;
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
          vetoed: isVetoed(revision, controls),
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
