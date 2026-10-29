import {
  type AtomicCapabilityRegistry,
  capabilityEffects,
  validateCapabilityEffects,
} from "@noesis/capabilities";
import {
  type ActorRef,
  type Capability,
  type CapabilityActivationMode,
  type CapabilityDefinition,
  type CapabilityEffect,
  type CapabilityFeedback,
  type CapabilityLifecycleRevision,
  type CapabilityScope,
  CapabilityEvidenceClaimSchema,
  capabilityEvidenceLabel,
  canonicalJson,
  createConditionalObject,
  createId,
  type EvidenceRef,
  type FileRevisionRef,
  type ProjectRef,
  capabilityGuidance,
  learnedCapabilitySkillName,
  parseCapabilityDocument,
  renderCapabilityDocument,
  sha256,
} from "@noesis/domain";
import type { CapabilityLifecycleStore, NoesisWorkspaceStore } from "@noesis/workspace";
import { z } from "zod";

export const CapabilityScopeDecisionSchema = z.enum(["global", "current_project", "current_session"]);

export const CapabilityConsequenceSchema = z.enum([
  "ordinary",
  "recovery_control",
  "credential_export",
  "irreversible_external",
]);

export const CapabilityEffectDraftSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("instruction"),
    content: z.string().trim().min(1).max(12_000),
  }),
  z.strictObject({
    kind: z.literal("skill"),
    name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
    description: z.string().trim().min(1).max(2_048),
    instructions: z.string().trim().min(1).max(32_000),
  }),
  z.strictObject({
    kind: z.literal("program"),
    mode: z.enum(["script", "workflow"]),
    name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
  }),
]);

/** The complete behavior-bearing proposal authored by either reflection or the foreground agent. */
export const CapabilityProposalSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(2_048),
    applicability: z.string().trim().min(1).max(2_048),
    summary: z.string().trim().min(1).max(2_048),
    rationale: z.string().trim().min(1).max(4_096),
    anticipatedEffect: z.string().trim().min(1).max(2_048),
    effects: z.array(CapabilityEffectDraftSchema).min(1).max(8),
    scope: CapabilityScopeDecisionSchema.optional(),
    activationMode: z.enum(["relevant", "always"]).optional(),
    consequence: CapabilityConsequenceSchema,
    consequenceDescription: z.string().trim().min(1).max(2_048),
    evidence: CapabilityEvidenceClaimSchema.optional(),
  })
  .superRefine((proposal, context) => {
    if (proposal.effects.filter((effect) => effect.kind === "program").length <= 1) return;
    context.addIssue({
      code: "custom",
      path: ["effects"],
      message: "A Capability may attach at most one Program effect",
    });
  });

export type CapabilityProposal = Readonly<z.infer<typeof CapabilityProposalSchema>>;

const ExistingCapabilityDecisionFields = {
  capabilityId: z.string().trim().min(1),
  expectedBindingRevision: z.number().int().positive(),
};

/**
 * One complete semantic decision. The protected publisher supplies identity, evidence resolution,
 * immutable recording, stale-write detection, gating, and rollback lineage; it does not reinterpret
 * this decision with another model call.
 */
export const CapabilityDecisionSchema = z.discriminatedUnion("decision", [
  z.strictObject({
    decision: z.literal("no_change"),
    reason: z.string().trim().min(1).max(2_048),
  }),
  z.strictObject({
    decision: z.literal("create"),
    proposal: CapabilityProposalSchema,
  }),
  z.strictObject({
    decision: z.literal("revise"),
    ...ExistingCapabilityDecisionFields,
    proposal: CapabilityProposalSchema,
  }),
  z.strictObject({
    decision: z.literal("pause"),
    ...ExistingCapabilityDecisionFields,
    reason: z.string().trim().min(1).max(2_048),
  }),
  z.strictObject({
    decision: z.literal("restore"),
    ...ExistingCapabilityDecisionFields,
    capabilityRevisionId: z.string().trim().min(1),
    reason: z.string().trim().min(1).max(2_048),
  }),
  z.strictObject({
    decision: z.literal("change_binding"),
    ...ExistingCapabilityDecisionFields,
    scope: CapabilityScopeDecisionSchema,
    activationMode: z.enum(["relevant", "always"]),
    reason: z.string().trim().min(1).max(2_048),
  }),
]);

export type CapabilityDecision = Readonly<z.infer<typeof CapabilityDecisionSchema>>;

export const CapabilityPublicationResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("no_change"),
    reason: z.string(),
  }),
  z.strictObject({
    status: z.enum(["activated", "revised", "pending", "paused", "restored", "binding_changed"]),
    capabilityId: z.string(),
    message: z.string(),
  }),
  z.strictObject({
    status: z.literal("stale"),
    capabilityId: z.string(),
    message: z.string(),
  }),
]);

export type CapabilityPublicationResult = Readonly<z.infer<typeof CapabilityPublicationResultSchema>>;

export interface CapabilityProgramLibrary {
  readonly list: (project: ProjectRef) => Promise<
    readonly {
      readonly mode: "script" | "workflow";
      readonly name: string;
      readonly description: string;
      readonly revision: number;
      readonly definitionRevision: FileRevisionRef;
    }[]
  >;
  readonly resolve: (
    mode: "script" | "workflow",
    name: string,
    project: ProjectRef,
  ) => Promise<Extract<CapabilityEffect, { readonly kind: "program" }> | undefined>;
}

export interface CapabilityPublicationContext {
  readonly project: ProjectRef;
  readonly sessionId: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly actor: ActorRef;
  readonly interpretation?: string;
  /** Foreground turns may pin program effects to the exact saved definitions visible at admission. */
  readonly programResolver?: Pick<CapabilityProgramLibrary, "resolve">;
  /**
   * Set only by the startup move into Capability files. It keeps an existing long always-active
   * Capability as it was; the per-turn allowance still bounds what reaches the prompt.
   */
  readonly preservingExistingGuidance?: true;
}

export interface CapabilityPublisher {
  readonly publish: (
    decision: CapabilityDecision,
    context: CapabilityPublicationContext,
    signal: AbortSignal,
  ) => Promise<CapabilityPublicationResult>;
  /** Rewrites a Capability's working file to match its current revision after a restore or approval. */
  /** Rejects an always-active mode when the current guidance is too long for every prompt. */
  readonly assertCurrentGuidanceFitsAlways: (capabilityId: string) => Promise<void>;
  /** Rejects approving a pending always-active revision whose guidance is too long. */
  readonly assertGateFitsAlways: (gateRequestId: string) => Promise<void>;
  readonly syncWorkingDocument: (
    capabilityId: string,
    context?: Pick<CapabilityPublicationContext, "project" | "sessionId">,
  ) => Promise<void>;
  /**
   * Records direct edits to Capability files as new revisions. An edit that cannot be read is left
   * in place and reported, and the Capability keeps its current revision.
   */
  readonly recordDocumentEdits: (
    context: Pick<CapabilityPublicationContext, "project" | "sessionId">,
    signal: AbortSignal,
  ) => Promise<CapabilityDocumentEditReport>;
  /** Gives every Capability made before Capability files a readable file, as a new revision. */
  readonly moveToDocuments: (
    context: Pick<CapabilityPublicationContext, "project" | "sessionId">,
    signal: AbortSignal,
  ) => Promise<number>;
  /** Replace one exact pending gated revision after a user-authored natural-language amendment. */
  readonly replacePendingGate: (
    input: {
      readonly gateRequestId: string;
      readonly proposal: CapabilityProposal;
      readonly instruction: string;
    },
    context: {
      readonly project?: ProjectRef;
      readonly actor: ActorRef;
    },
    signal: AbortSignal,
  ) => Promise<CapabilityPublicationResult>;
}

export interface CapabilityDocumentEditReport {
  readonly recorded: readonly { readonly capabilityId: string; readonly name: string }[];
  readonly problems: readonly {
    readonly capabilityId: string;
    readonly path: string;
    readonly error: string;
  }[];
}

export interface CreateCapabilityPublisherOptions {
  readonly workspace: NoesisWorkspaceStore;
  readonly store: CapabilityLifecycleStore;
  readonly registry: AtomicCapabilityRegistry;
  readonly programs?: CapabilityProgramLibrary;
  readonly now?: () => string;
  readonly nextId?: (prefix: string) => string;
}

function scopeFrom(
  decision: z.infer<typeof CapabilityScopeDecisionSchema>,
  context: Pick<CapabilityPublicationContext, "project" | "sessionId">,
): CapabilityScope {
  if (decision === "global") return Object.freeze({ kind: "global" });
  if (decision === "current_project")
    return Object.freeze({ kind: "project", project: Object.freeze({ ...context.project }) });
  return Object.freeze({ kind: "session", sessionId: context.sessionId });
}

export function capabilityScopeDecision(
  scope: CapabilityScope,
): z.infer<typeof CapabilityScopeDecisionSchema> {
  if (scope.kind === "global") return "global";
  if (scope.kind === "project") return "current_project";
  return "current_session";
}

function proposedScope(
  proposal: CapabilityProposal,
  context: Pick<CapabilityPublicationContext, "project" | "sessionId">,
  current?: CapabilityScope,
): CapabilityScope {
  const hasProjectProgram = proposal.effects.some((effect) => effect.kind === "program");
  if (hasProjectProgram) {
    if (proposal.scope !== undefined && proposal.scope !== "current_project")
      throw new Error("Program Capability effects require current-project scope");
    return Object.freeze({ kind: "project", project: Object.freeze({ ...context.project }) });
  }
  return proposal.scope === undefined
    ? (current ?? Object.freeze({ kind: "global" as const }))
    : scopeFrom(proposal.scope, context);
}

function proposedActivationMode(
  proposal: CapabilityProposal,
  current?: CapabilityActivationMode,
): CapabilityActivationMode {
  return proposal.activationMode ?? current ?? "relevant";
}

const evidenceKindLabel = capabilityEvidenceLabel;
/** An always-active Capability enters every turn's prompt, so its guidance must stay short. */
export const ALWAYS_GUIDANCE_MAX_CHARACTERS = 2_000;

function assertAlwaysGuidanceFits(guidance: string): void {
  if (guidance.length > ALWAYS_GUIDANCE_MAX_CHARACTERS)
    throw new Error(
      `An always-active Capability's guidance must be at most ${String(ALWAYS_GUIDANCE_MAX_CHARACTERS)} characters; it has ${String(guidance.length)}. Keep it relevant, or shorten the guidance.`,
    );
}
const DOCUMENT_PATH = /^definitions\/(?:candidates\/)?capabilities\/[^/]+\.md$/u;

/** The readable file for a new Capability. It keeps this path for every later revision. */
function capabilityDocumentPath(capabilityId: string, name: string): string {
  return `capabilities/${learnedCapabilitySkillName(capabilityId, name).slice("learned-".length)}.md`;
}

/** The editable working file for a Capability file revision, outside the candidate area. */
export function capabilityWorkingDocumentPath(document: FileRevisionRef): string {
  return document.workingPath.replace(/^definitions\/candidates\//u, "definitions/");
}

/** The Capability file a revision pins, or undefined for revisions made before Capability files. */
export function capabilityDocumentRevision(
  revision: CapabilityLifecycleRevision,
): FileRevisionRef | undefined {
  const first = capabilityEffects(revision.revision)[0];
  return first?.kind === "instruction" && DOCUMENT_PATH.test(first.material.workingPath)
    ? first.material
    : undefined;
}

function registryCapability(capability: CapabilityDefinition): Capability {
  return Object.freeze({
    capabilityId: capability.capabilityId,
    name: capability.name,
    scope: "general",
    intent: capability.applicability,
  });
}

function normalizedEvidence(references: readonly EvidenceRef[]): readonly EvidenceRef[] {
  const unique = new Map(references.map((reference) => [canonicalJson(reference), reference]));
  if (unique.size === 0) throw new Error("Capability publication requires authoritative evidence");
  return Object.freeze([...unique.values()]);
}

/** Model-authored consequence text may escalate a gate, but only host-owned authority may suppress one. */
function hostRequiresActivationGate(revision: CapabilityLifecycleRevision): boolean {
  const delta = revision.revision.requestedPermissionDelta;
  if (
    delta.addedCredentialRefs.length > 0 ||
    delta.addedEffects.length > 0 ||
    delta.widenedResources.length > 0
  )
    return true;
  for (const effect of capabilityEffects(revision.revision)) {
    // The current effect union only mounts exact guidance or a reference to an already-published
    // project program. Activating either is reversible; any later protected execution still passes
    // through that program's frozen Broker and AuthorityBoundary.
    if (effect.kind === "instruction" || effect.kind === "skill" || effect.kind === "program") continue;
    const unsupported: never = effect;
    return unsupported;
  }
  return false;
}

export function createCapabilityPublisher(options: CreateCapabilityPublisherOptions): CapabilityPublisher {
  const now = options.now ?? (() => new Date().toISOString());
  const nextId = options.nextId ?? createId;
  const programs: CapabilityProgramLibrary =
    options.programs ??
    Object.freeze({
      list: async () => Object.freeze([]),
      resolve: async () => undefined,
    });

  const compatibilityRouter = async (evidenceRefs: readonly EvidenceRef[], actor: ActorRef) => {
    const namespace = "capability_system";
    const definitionId = "semantic-router-v1";
    const current = await options.workspace.definitionMetadata.getCurrent(namespace, definitionId);
    if (current) return current.definitionRevision;
    const publication = await options.workspace.definitionPublications.publish({
      namespace,
      definitionId,
      revision: 1,
      workingPath: "capabilities/system/semantic-router.json",
      bytes: new TextEncoder().encode(
        `${canonicalJson({ strategyId: "semantic-capability-router-v1", scope: "central" })}\n`,
      ),
      provenanceRefs: evidenceRefs,
      activity: Object.freeze({
        kind: "capability.semantic_router_initialized",
        actor,
        reason: "Compatibility identity for the central semantic Capability router",
      }),
    });
    if (publication.ok) return publication.value.definitionRevision;
    const raced = await options.workspace.definitionMetadata.getCurrent(namespace, definitionId);
    if (!raced) throw new Error(publication.error.message);
    return raced.definitionRevision;
  };

  const authorRevision = async (input: {
    readonly proposal: CapabilityProposal;
    readonly capabilityId: string;
    readonly predecessor?: CapabilityLifecycleRevision;
    readonly evidenceRefs: readonly EvidenceRef[];
    readonly project?: ProjectRef;
    readonly actor: ActorRef;
    readonly programResolver?: Pick<CapabilityProgramLibrary, "resolve">;
  }): Promise<{
    readonly definition: CapabilityDefinition;
    readonly revision: CapabilityLifecycleRevision;
  }> => {
    const capabilityRevisionId = nextId("capability_revision");
    const existingDefinition = input.predecessor
      ? await options.store.getDefinition(input.capabilityId)
      : undefined;
    if (input.predecessor && !existingDefinition)
      throw new Error(`Capability ${input.capabilityId} has a revision but no definition`);
    // A revision may refine the name, description, and applicability. The Capability ID and its
    // creation time stay fixed, so lineage and restoration still refer to the same Capability.
    const definition: CapabilityDefinition = Object.freeze(
      createConditionalObject({
        capabilityId: input.capabilityId,
        name: input.proposal.name,
      } as const)
        .addOptional(existingDefinition?.kind ? { kind: existingDefinition.kind } : undefined)
        .add({
          description: input.proposal.description,
          applicability: input.proposal.applicability,
          createdAt: existingDefinition?.createdAt ?? now(),
        } as const)
        .finish(),
    );
    options.registry.registerCapability(registryCapability(definition));
    // Instruction and skill drafts become the guidance of one readable Capability file.
    const guidance = input.proposal.effects
      .flatMap((draft) =>
        draft.kind === "instruction"
          ? [draft.content.trim()]
          : draft.kind === "skill"
            ? [`## ${draft.name}\n\n${draft.description.trim()}\n\n${draft.instructions.trim()}`]
            : [],
      )
      .join("\n\n");
    const programDrafts = input.proposal.effects.filter((draft) => draft.kind === "program");
    if (guidance.length === 0 && programDrafts.length === 0)
      throw new Error("A Capability needs guidance or a saved Program");
    const predecessorDocument = input.predecessor ? capabilityDocumentRevision(input.predecessor) : undefined;
    // listRevisions without a limit returns the oldest first; the file lists the newest first.
    const history = input.predecessor
      ? (await options.store.listRevisions(input.capabilityId)).toReversed().map((revision) => ({
          date: revision.createdAt.slice(0, 10),
          summary: revision.summary,
        }))
      : [];
    const bytes = new TextEncoder().encode(
      renderCapabilityDocument(
        {
          name: input.proposal.name,
          when: input.proposal.applicability,
          description: input.proposal.description,
          guidance:
            guidance.length > 0
              ? guidance
              : `Use the saved ${programDrafts.map((draft) => `${draft.mode} \`${draft.name}\``).join(" and ")}.`,
        },
        createConditionalObject({
          rationale: input.proposal.rationale,
          history: [{ date: now().slice(0, 10), summary: input.proposal.summary }, ...history],
        } as const)
          .addOptional(
            input.proposal.evidence
              ? {
                  evidence: {
                    label: evidenceKindLabel(input.proposal.evidence.kind),
                    quote: input.proposal.evidence.quote,
                    wouldOtherwise: input.proposal.evidence.wouldOtherwise,
                  },
                }
              : undefined,
          )
          .finish(),
      ),
    );
    const documentRequest = createConditionalObject({
      workingPath: predecessorDocument
        ? capabilityWorkingDocumentPath(predecessorDocument)
        : capabilityDocumentPath(input.capabilityId, input.proposal.name),
      bytes,
      actor: input.actor,
      reason: input.proposal.rationale,
      provenanceRefs: input.evidenceRefs,
    } as const)
      .addOptional(
        predecessorDocument ? { predecessorRevisionId: predecessorDocument.revisionId } : undefined,
      )
      .finish();
    // Each revision is recorded as a candidate snapshot. The file the user reads changes only after
    // the revision becomes current, so a failed or stale publication never looks like a user edit.
    const document = await options.workspace.definitions.recordCandidateDefinition(documentRequest);
    const programEffects = await Promise.all(
      programDrafts.map(async (draft): Promise<CapabilityEffect> => {
        if (!input.project) throw new Error(`Capability program ${draft.name} has no project authority`);
        const resolved = await (input.programResolver ?? programs).resolve(
          draft.mode,
          draft.name,
          input.project,
        );
        if (!resolved) throw new Error(`Unknown saved ${draft.mode} Program ${draft.name}`);
        return resolved;
      }),
    );
    const effects = validateCapabilityEffects([
      Object.freeze({ kind: "instruction" as const, material: document }),
      ...programEffects,
    ]);
    const router = await compatibilityRouter(input.evidenceRefs, input.actor);
    const executesPrograms = effects.some((effect) => effect.kind === "program");
    const reference = options.registry.constructRevision(
      createConditionalObject({
        definitionState: "candidate",
        capabilityRevisionId,
        capabilityId: input.capabilityId,
      } as const)
        .addOptional(
          input.predecessor
            ? { predecessorRevisionId: input.predecessor.revision.capabilityRevisionId }
            : undefined,
        )
        .add({
          effects,
          promptModules: Object.freeze(
            effects.flatMap((effect) => (effect.kind === "instruction" ? [effect.material] : [])),
          ),
          skills: Object.freeze([]),
          tools: Object.freeze([]),
          routerRevision: router,
          routerStrategyId: "semantic-capability-router-v1",
          activationPolicy: Object.freeze({ mode: "automatic_low_risk", scope: "general" }),
          permissionManifest: Object.freeze({
            effects: Object.freeze(executesPrograms ? ["execute"] : []),
            resourcePatterns: Object.freeze(
              effects.flatMap((effect) =>
                effect.kind === "program"
                  ? [
                      `program:${effect.program.project.projectId}:${effect.program.mode}:${effect.program.name}:run`,
                    ]
                  : [],
              ),
            ),
            credentialRefs: Object.freeze([]),
          }),
          evidenceRefs: input.evidenceRefs,
          sourceEvaluationDefinitions: Object.freeze([]),
          requestedPermissionDelta: Object.freeze({
            addedEffects: Object.freeze([]),
            widenedResources: Object.freeze([]),
            addedCredentialRefs: Object.freeze([]),
          }),
        } as const)
        .finish(),
    );
    const revision = options.registry.getRevision(reference);
    if (!revision) throw new Error(`Capability registry lost authored revision ${capabilityRevisionId}`);
    return Object.freeze({
      definition,
      revision: Object.freeze(
        createConditionalObject({
          revision,
          reference,
          summary: input.proposal.summary,
          rationale: input.proposal.rationale,
          anticipatedEffect: input.proposal.anticipatedEffect,
        } as const)
          .addOptional(input.proposal.evidence ? { evidence: input.proposal.evidence } : undefined)
          .add({ createdAt: now() } as const)
          .finish(),
      ),
    });
  };

  const publish: CapabilityPublisher["publish"] = async (decision, context, signal) => {
    signal.throwIfAborted();
    if (decision.decision === "no_change")
      return Object.freeze({ status: "no_change" as const, reason: decision.reason });
    const evidenceRefs = normalizedEvidence(context.evidenceRefs);
    const decisionFeedback = (
      binding: import("@noesis/domain").CapabilityBinding,
      interpretation: string,
      disposition: CapabilityFeedback["disposition"],
    ): CapabilityFeedback =>
      Object.freeze({
        feedbackId: nextId("capability_feedback"),
        capabilityId: binding.capabilityId,
        revision: binding.revision,
        evidenceRefs,
        interpretation,
        disposition,
        createdAt: now(),
      });

    if (decision.decision === "pause") {
      const binding = await options.store.getBinding(decision.capabilityId);
      if (!binding) throw new Error(`Unknown capability ${decision.capabilityId}`);
      if (binding.revisionNumber !== decision.expectedBindingRevision)
        return Object.freeze({
          status: "stale" as const,
          capabilityId: binding.capabilityId,
          message: "Capability changed concurrently",
        });
      signal.throwIfAborted();
      const updated = await options.store.updateBindingWithFeedback({
        capabilityId: binding.capabilityId,
        expectedRevisionNumber: decision.expectedBindingRevision,
        state: "paused",
        feedback: decisionFeedback(binding, decision.reason, "correction"),
      });
      return Object.freeze({
        status: updated.status === "stale" ? ("stale" as const) : ("paused" as const),
        capabilityId: binding.capabilityId,
        message: decision.reason,
      });
    }

    if (decision.decision === "restore") {
      const [binding, target] = await Promise.all([
        options.store.getBinding(decision.capabilityId),
        options.store.getRevisionById(decision.capabilityId, decision.capabilityRevisionId),
      ]);
      if (!binding) throw new Error(`Unknown capability ${decision.capabilityId}`);
      if (binding.revisionNumber !== decision.expectedBindingRevision)
        return Object.freeze({
          status: "stale" as const,
          capabilityId: binding.capabilityId,
          message: "Capability changed concurrently",
        });
      if (!target) throw new Error(`Unknown restorable revision ${decision.capabilityRevisionId}`);
      signal.throwIfAborted();
      const updated = await options.store.updateBindingWithFeedback({
        capabilityId: binding.capabilityId,
        expectedRevisionNumber: decision.expectedBindingRevision,
        revision: target.reference,
        state: "active",
        feedback: decisionFeedback(binding, decision.reason, "restore_request"),
      });
      if (updated.status !== "stale") await syncWorkingDocument(binding.capabilityId, context);
      return Object.freeze({
        status: updated.status === "stale" ? ("stale" as const) : ("restored" as const),
        capabilityId: binding.capabilityId,
        message: decision.reason,
      });
    }

    if (decision.decision === "change_binding") {
      const binding = await options.store.getBinding(decision.capabilityId);
      if (!binding) throw new Error(`Unknown capability ${decision.capabilityId}`);
      if (binding.revisionNumber !== decision.expectedBindingRevision)
        return Object.freeze({
          status: "stale" as const,
          capabilityId: binding.capabilityId,
          message: "Capability changed concurrently",
        });
      if (decision.activationMode === "always") await assertCurrentGuidanceFitsAlways(binding.capabilityId);
      signal.throwIfAborted();
      const updated = await options.store.updateBindingWithFeedback({
        capabilityId: binding.capabilityId,
        expectedRevisionNumber: decision.expectedBindingRevision,
        scope: scopeFrom(decision.scope, context),
        activationMode: decision.activationMode,
        feedback: decisionFeedback(
          binding,
          decision.reason,
          decision.activationMode !== binding.activationMode ? "activation_change" : "scope_change",
        ),
      });
      return Object.freeze({
        status: updated.status === "stale" ? ("stale" as const) : ("binding_changed" as const),
        capabilityId: binding.capabilityId,
        message: decision.reason,
      });
    }

    const proposal = decision.proposal;
    const capabilityId = decision.decision === "create" ? nextId("capability") : decision.capabilityId;
    const binding = await options.store.getBinding(capabilityId);
    if (decision.decision === "create" && binding)
      throw new Error(`Cannot create existing capability ${capabilityId}`);
    if (decision.decision === "revise") {
      if (!binding) throw new Error(`Cannot revise unknown capability ${capabilityId}`);
      if (binding.revisionNumber !== decision.expectedBindingRevision)
        return Object.freeze({
          status: "stale" as const,
          capabilityId,
          message: "Capability changed concurrently",
        });
    }
    const predecessor = binding ? await options.store.getRevision(binding.revision) : undefined;
    if (decision.decision === "revise" && !predecessor)
      throw new Error(`Cannot revise unknown capability ${capabilityId}`);
    const authored = await authorRevision(
      createConditionalObject({
        proposal,
        capabilityId,
        evidenceRefs,
        project: context.project,
        actor: context.actor,
      } as const)
        .addOptional(context.programResolver ? { programResolver: context.programResolver } : undefined)
        .addOptional(predecessor ? { predecessor } : undefined)
        .finish(),
    );
    const requiresGate = hostRequiresActivationGate(authored.revision) || proposal.consequence !== "ordinary";
    const nextScope = proposedScope(proposal, context, binding?.scope);
    const nextActivationMode = proposedActivationMode(proposal, binding?.activationMode);
    if (nextActivationMode === "always" && !context.preservingExistingGuidance)
      await assertRevisionGuidanceFitsAlways(authored.revision);

    if (!binding) {
      const gate = requiresGate
        ? Object.freeze({
            gateRequestId: nextId("capability_gate"),
            capabilityId,
            revision: authored.revision.reference,
            expectedBindingRevision: 1,
            proposedScope: nextScope,
            proposedActivationMode: nextActivationMode,
            consequence: proposal.consequenceDescription,
            status: "pending" as const,
            createdAt: now(),
          })
        : undefined;
      signal.throwIfAborted();
      await options.store.create(
        createConditionalObject({
          definition: authored.definition,
          revision: authored.revision,
          binding: Object.freeze({
            capabilityId,
            revision: authored.revision.reference,
            scope: nextScope,
            activationMode: nextActivationMode,
            state: requiresGate ? ("paused" as const) : ("active" as const),
          }),
        } as const)
          .addOptional(gate ? { gate } : undefined)
          .finish(),
      );
      await syncWorkingDocument(capabilityId, context);
      return Object.freeze({
        status: requiresGate ? ("pending" as const) : ("activated" as const),
        capabilityId,
        message: authored.revision.summary,
      });
    }

    const expectedBindingRevision =
      decision.decision === "revise" ? decision.expectedBindingRevision : binding.revisionNumber;
    const feedback = Object.freeze({
      feedbackId: nextId("capability_feedback"),
      capabilityId,
      revision: binding.revision,
      evidenceRefs,
      interpretation: context.interpretation ?? proposal.rationale,
      disposition: "correction" as const,
      createdAt: now(),
    }) satisfies CapabilityFeedback;
    if (requiresGate) {
      signal.throwIfAborted();
      const staged = await options.store.stageGatedRevision({
        revision: authored.revision,
        feedback,
        gate: Object.freeze({
          gateRequestId: nextId("capability_gate"),
          capabilityId,
          revision: authored.revision.reference,
          expectedBindingRevision,
          proposedScope: nextScope,
          proposedActivationMode: nextActivationMode,
          consequence: proposal.consequenceDescription,
          status: "pending",
          createdAt: now(),
        }),
      });
      if (staged.status === "stale")
        return Object.freeze({
          status: "stale" as const,
          capabilityId,
          message: "Capability changed concurrently",
        });
      return Object.freeze({
        status: "pending" as const,
        capabilityId,
        message: authored.revision.summary,
      });
    }
    signal.throwIfAborted();
    const updated = await options.store.applyRevision({
      revision: authored.revision,
      definition: authored.definition,
      feedback,
      expectedBindingRevision,
      scope: nextScope,
      activationMode: nextActivationMode,
    });
    if (updated.status !== "stale") await syncWorkingDocument(capabilityId, context);
    return Object.freeze({
      status: updated.status === "stale" ? ("stale" as const) : ("revised" as const),
      capabilityId,
      message: authored.revision.summary,
    });
  };

  const replacePendingGate: CapabilityPublisher["replacePendingGate"] = async (input, context, signal) => {
    signal.throwIfAborted();
    const gate = await options.store.getGate(input.gateRequestId);
    if (!gate) throw new Error(`Unknown capability gate ${input.gateRequestId}`);
    if (gate.status !== "pending")
      throw new Error(`Capability gate ${input.gateRequestId} is already ${gate.status}`);
    const [binding, predecessor, definition] = await Promise.all([
      options.store.getBinding(gate.capabilityId),
      options.store.getRevision(gate.revision),
      options.store.getDefinition(gate.capabilityId),
    ]);
    if (!binding || !predecessor || !definition)
      throw new Error(`Capability gate ${input.gateRequestId} has incomplete authority`);
    const evidenceRefs = normalizedEvidence(predecessor.revision.evidenceRefs);
    const authored = await authorRevision(
      createConditionalObject({
        proposal: input.proposal,
        capabilityId: gate.capabilityId,
        predecessor,
        evidenceRefs,
        actor: context.actor,
      } as const)
        .addOptional(context.project ? { project: context.project } : undefined)
        .finish(),
    );
    if (gate.proposedActivationMode === "always") await assertRevisionGuidanceFitsAlways(authored.revision);
    signal.throwIfAborted();
    const staged = await options.store.stageGatedRevision({
      revision: authored.revision,
      feedback: Object.freeze({
        feedbackId: nextId("capability_feedback"),
        capabilityId: gate.capabilityId,
        revision: binding.revision,
        evidenceRefs,
        interpretation: input.instruction,
        disposition: "correction",
        createdAt: now(),
      }),
      supersedeGateRequestId: gate.gateRequestId,
      gate: Object.freeze({
        gateRequestId: nextId("capability_gate"),
        capabilityId: gate.capabilityId,
        revision: authored.revision.reference,
        expectedBindingRevision: binding.revisionNumber,
        proposedScope: gate.proposedScope,
        proposedActivationMode: gate.proposedActivationMode,
        consequence: input.proposal.consequenceDescription,
        status: "pending",
        instruction: input.instruction,
        createdAt: now(),
      }),
    });
    if (staged.status === "stale")
      return Object.freeze({
        status: "stale" as const,
        capabilityId: gate.capabilityId,
        message: "Capability changed concurrently",
      });
    return Object.freeze({
      status: "pending" as const,
      capabilityId: gate.capabilityId,
      message: authored.revision.summary,
    });
  };

  async function assertRevisionGuidanceFitsAlways(revision: CapabilityLifecycleRevision): Promise<void> {
    const document = capabilityDocumentRevision(revision);
    // Revisions from before Capability files keep their guidance in separate materials.
    const guidance = document
      ? capabilityGuidance(new TextDecoder().decode(await options.workspace.reads.readRevision(document)))
      : (await currentDrafts(revision)).drafts
          .flatMap((draft) => (draft.kind === "instruction" ? [draft.content] : []))
          .join("\n\n");
    assertAlwaysGuidanceFits(guidance);
  }
  const assertCurrentGuidanceFitsAlways = async (capabilityId: string): Promise<void> => {
    const binding = await options.store.getBinding(capabilityId);
    const lifecycle = binding ? await options.store.getRevision(binding.revision) : undefined;
    if (lifecycle) await assertRevisionGuidanceFitsAlways(lifecycle);
  };
  const assertGateFitsAlways = async (gateRequestId: string): Promise<void> => {
    const gate = await options.store.getGate(gateRequestId);
    if (gate?.proposedActivationMode !== "always") return;
    const lifecycle = await options.store.getRevision(gate.revision);
    if (lifecycle) await assertRevisionGuidanceFitsAlways(lifecycle);
  };
  const systemActor: ActorRef = Object.freeze({ actorId: "capability-files", kind: "system" });
  const userActor: ActorRef = Object.freeze({ actorId: "workspace-user", kind: "user" });

  /** Guidance and Program drafts that reproduce a revision's current effects exactly. */
  const currentDrafts = async (
    lifecycle: CapabilityLifecycleRevision,
  ): Promise<{
    readonly drafts: readonly CapabilityProposal["effects"][number][];
    readonly resolver: Pick<CapabilityProgramLibrary, "resolve">;
    readonly project?: ProjectRef;
  }> => {
    const decoder = new TextDecoder("utf8", { fatal: true });
    const effects = capabilityEffects(lifecycle.revision);
    const texts =
      effects.length > 0
        ? await Promise.all(
            effects.flatMap((effect) =>
              effect.kind === "instruction"
                ? [
                    (async () =>
                      capabilityGuidance(
                        decoder.decode(await options.workspace.reads.readRevision(effect.material)),
                      ))(),
                  ]
                : effect.kind === "skill"
                  ? [
                      (async () =>
                        `## ${effect.name}\n\n${effect.description}\n\n${decoder.decode(await options.workspace.reads.readRevision(effect.material)).trim()}`)(),
                    ]
                  : [],
            ),
          )
        : await Promise.all(
            [...lifecycle.revision.promptModules, ...lifecycle.revision.skills].map(async (material) =>
              decoder.decode(await options.workspace.reads.readRevision(material)).trim(),
            ),
          );
    const programs = effects.filter((effect) => effect.kind === "program");
    const guidance = texts.filter((text) => text.length > 0).join("\n\n");
    return createConditionalObject({
      drafts: Object.freeze<CapabilityProposal["effects"][number][]>([
        ...(guidance.length > 0 ? [{ kind: "instruction" as const, content: guidance }] : []),
        ...programs.map((effect) => ({
          kind: "program" as const,
          mode: effect.program.mode,
          name: effect.program.name,
        })),
      ]),
      // Keep the exact pinned Program revisions instead of resolving the live library.
      resolver: Object.freeze({
        resolve: async (mode: "script" | "workflow", name: string) =>
          programs.find((effect) => effect.program.mode === mode && effect.program.name === name),
      }),
    } as const)
      .addOptional(programs[0] ? { project: programs[0].program.project } : undefined)
      .finish();
  };

  // Syncs for one Capability run one at a time. Each reads the binding when it starts, so the last
  // sync always writes the current revision even when publications race.
  const syncQueues = new Map<string, Promise<void>>();
  const syncWorkingDocument: CapabilityPublisher["syncWorkingDocument"] = async (capabilityId, context) => {
    // A restored revision from before Capability files gets a file as a new revision. That move
    // publishes, and publishing syncs again, so it runs outside the queue to avoid waiting on itself.
    // Without a project context, the next startup moves it instead.
    const binding = await options.store.getBinding(capabilityId);
    const lifecycle = binding ? await options.store.getRevision(binding.revision) : undefined;
    if (binding && lifecycle && !capabilityDocumentRevision(lifecycle)) {
      if (context) await moveOne(binding, lifecycle, context, new AbortController().signal);
      return;
    }
    const previous = syncQueues.get(capabilityId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => await syncNow(capabilityId));
    syncQueues.set(capabilityId, next);
    try {
      await next;
    } finally {
      if (syncQueues.get(capabilityId) === next) syncQueues.delete(capabilityId);
    }
  };
  const syncNow = async (capabilityId: string): Promise<void> => {
    const binding = await options.store.getBinding(capabilityId);
    if (!binding) return;
    const lifecycle = await options.store.getRevision(binding.revision);
    if (!lifecycle) return;
    const document = capabilityDocumentRevision(lifecycle);
    if (!document) return;
    // A restore or approval may select a revision with an older name or "when" text.
    const bytes = await options.workspace.reads.readRevision(document);
    const parsed = parseCapabilityDocument(new TextDecoder().decode(bytes));
    const definition = await options.store.getDefinition(capabilityId);
    if (
      parsed.ok &&
      definition &&
      (definition.name !== parsed.content.name ||
        definition.applicability !== parsed.content.when ||
        definition.description !== parsed.content.description)
    ) {
      const updated = Object.freeze({
        ...definition,
        name: parsed.content.name,
        applicability: parsed.content.when,
        description: parsed.content.description,
      });
      await options.store.updateDefinition(updated);
      options.registry.registerCapability(registryCapability(updated));
    }
    const path = capabilityWorkingDocumentPath(document);
    const working = await options.workspace.reads.readWorkingFile(path);
    if (working && sha256(working) === document.contentDigest) return;
    // The store skips a write whose bytes match the path's latest record. Record the out-of-date
    // file first, so the current revision is always written back to disk.
    if (working)
      await options.workspace.recordDirectEdit(path, systemActor, "Out-of-date Capability file before sync");
    await options.workspace.definitions.recordWorkingDefinition({
      workingPath: path,
      bytes,
      actor: systemActor,
      reason: "Match the Capability file to its current revision",
      provenanceRefs: [document],
    });
  };

  const moveOne = async (
    binding: import("@noesis/domain").CapabilityBinding,
    lifecycle: CapabilityLifecycleRevision,
    context: Pick<CapabilityPublicationContext, "project" | "sessionId">,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const definition = await options.store.getDefinition(binding.capabilityId);
    if (!definition) return false;
    const current = await currentDrafts(lifecycle);
    if (current.drafts.length === 0) return false;
    const result = await publish(
      {
        decision: "revise",
        capabilityId: binding.capabilityId,
        expectedBindingRevision: binding.revisionNumber,
        proposal: createConditionalObject({
          name: definition.name,
          description: definition.description,
          applicability: definition.applicability,
          summary: "Moved into a readable Capability file.",
          rationale: lifecycle.rationale,
          anticipatedEffect: lifecycle.anticipatedEffect,
          effects: Array.from(current.drafts),
          consequence: "ordinary" as const,
          consequenceDescription: "The guidance is unchanged. Only its storage changes.",
        } as const)
          .addOptional(lifecycle.evidence ? { evidence: lifecycle.evidence } : undefined)
          .finish(),
      },
      {
        project: current.project ?? context.project,
        sessionId: context.sessionId,
        // Older revisions may carry no evidence rows; their recorded material is then the evidence.
        evidenceRefs:
          lifecycle.revision.evidenceRefs.length > 0
            ? lifecycle.revision.evidenceRefs
            : [
                ...capabilityEffects(lifecycle.revision).flatMap((effect) =>
                  effect.kind === "program" ? [] : [effect.material],
                ),
                ...lifecycle.revision.promptModules,
              ].slice(0, 1),
        actor: systemActor,
        interpretation: "Moved into a readable Capability file",
        programResolver: current.resolver,
        preservingExistingGuidance: true,
      },
      signal,
    );
    return result.status === "revised";
  };

  const moveToDocuments: CapabilityPublisher["moveToDocuments"] = async (context, signal) => {
    const definitions = await options.store.listDefinitions();
    const bindings = await options.store.getBindings(
      definitions.map((definition) => definition.capabilityId),
    );
    let moved = 0;
    for (const binding of bindings) {
      signal.throwIfAborted();
      const lifecycle = await options.store.getRevision(binding.revision);
      if (!lifecycle || capabilityDocumentRevision(lifecycle)) continue;
      // A pending gate expects the binding as it is, so leave this Capability until it is decided.
      if ((await options.store.listGates(binding.capabilityId)).some((gate) => gate.status === "pending"))
        continue;
      // One Capability that cannot move must not keep the others, or Noesis, from starting.
      const result = await moveOne(binding, lifecycle, context, signal).then(
        (done) => done,
        () => false,
      );
      if (result) moved += 1;
    }
    return moved;
  };

  const recordDocumentEdits: CapabilityPublisher["recordDocumentEdits"] = async (context, signal) => {
    const definitions = await options.store.listDefinitions();
    const bindings = await options.store.getBindings(
      definitions.map((definition) => definition.capabilityId),
    );
    const recorded: { capabilityId: string; name: string }[] = [];
    const problems: { capabilityId: string; path: string; error: string }[] = [];
    for (const binding of bindings) {
      signal.throwIfAborted();
      const lifecycle = await options.store.getRevision(binding.revision);
      const document = lifecycle ? capabilityDocumentRevision(lifecycle) : undefined;
      if (!lifecycle || !document) continue;
      const path = capabilityWorkingDocumentPath(document);
      const working = await options.workspace.reads.readWorkingFile(path);
      if (!working || sha256(working) === document.contentDigest) continue;
      // A file that still holds a Capability file Noesis wrote, and nothing recorded since, was never
      // brought up to date, e.g. Noesis stopped right after publishing. Any edit by the user changes
      // the bytes away from that record, so it is still imported below, even if it matches an older
      // revision restored from a backup.
      const workingDigest = sha256(working);
      const lastRecorded = await options.workspace.reads.latestWorkingRevision(path);
      const writtenByNoesis =
        lastRecorded?.contentDigest === workingDigest &&
        (await options.store.listRevisions(binding.capabilityId)).some(
          (revision) => capabilityDocumentRevision(revision)?.contentDigest === workingDigest,
        );
      if (writtenByNoesis) {
        await syncWorkingDocument(binding.capabilityId, context);
        continue;
      }
      const parsed = parseCapabilityDocument(new TextDecoder().decode(working));
      if (!parsed.ok) {
        problems.push({ capabilityId: binding.capabilityId, path, error: parsed.error });
        continue;
      }
      const current = await currentDrafts(lifecycle);
      if (current.project && current.project.projectId !== context.project.projectId) continue;
      const outcome = await (async () => {
        const edit = await options.workspace.recordDirectEdit(
          path,
          userActor,
          "Direct edit to a Capability file",
        );
        return await publish(
          {
            decision: "revise",
            capabilityId: binding.capabilityId,
            expectedBindingRevision: binding.revisionNumber,
            proposal: {
              name: parsed.content.name,
              description: parsed.content.description,
              applicability: parsed.content.when,
              summary: "Edited directly in its Capability file.",
              rationale: "The user edited the Capability file.",
              anticipatedEffect: "Noesis follows the edited guidance from the next turn.",
              effects: [
                { kind: "instruction", content: parsed.content.guidance },
                ...current.drafts.filter((draft) => draft.kind === "program"),
              ],
              consequence: "ordinary",
              consequenceDescription: "The user changed the guidance directly.",
              evidence: {
                kind: "explicit_request",
                quote: `Edited ${path}`,
                wouldOtherwise: "Noesis would keep following the guidance the user replaced.",
              },
            },
          },
          {
            project: current.project ?? context.project,
            sessionId: context.sessionId,
            evidenceRefs: [edit],
            actor: userActor,
            interpretation: "The user edited the Capability file directly",
            programResolver: current.resolver,
          },
          signal,
        );
      })().then(
        (result) => ({ ok: true as const, result }),
        (cause: Error) => ({ ok: false as const, message: cause.message }),
      );
      if (!outcome.ok) {
        // The edit stays in the file. Noesis reports it and keeps the current revision.
        problems.push({ capabilityId: binding.capabilityId, path, error: outcome.message });
        continue;
      }
      const result = outcome.result;
      if (result.status === "revised")
        recorded.push({ capabilityId: binding.capabilityId, name: parsed.content.name });
    }
    return Object.freeze({ recorded: Object.freeze(recorded), problems: Object.freeze(problems) });
  };

  return Object.freeze({
    publish,
    replacePendingGate,
    assertCurrentGuidanceFitsAlways,
    assertGateFitsAlways,
    syncWorkingDocument,
    recordDocumentEdits,
    moveToDocuments,
  });
}
