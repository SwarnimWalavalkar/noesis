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
  canonicalJson,
  createConditionalObject,
  createId,
  type EvidenceRef,
  type ProjectRef,
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
    kind: z.literal("script"),
    name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
  }),
  z.strictObject({
    kind: z.literal("workflow"),
    name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
  }),
]);

/** The complete behavior-bearing proposal authored by either reflection or the foreground agent. */
export const CapabilityProposalSchema = z.strictObject({
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
      readonly kind: "script" | "workflow";
      readonly name: string;
      readonly description: string;
      readonly revision: number;
    }[]
  >;
  readonly resolve: (
    kind: "script" | "workflow",
    name: string,
    project: ProjectRef,
  ) => Promise<Extract<CapabilityEffect, { readonly kind: "script" | "workflow" }> | undefined>;
}

export interface CapabilityPublicationContext {
  readonly project: ProjectRef;
  readonly sessionId: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly actor: ActorRef;
  readonly interpretation?: string;
  /** Foreground turns may pin program effects to the exact saved definitions visible at admission. */
  readonly programResolver?: Pick<CapabilityProgramLibrary, "resolve">;
}

export interface CapabilityPublisher {
  readonly publish: (
    decision: CapabilityDecision,
    context: CapabilityPublicationContext,
    signal: AbortSignal,
  ) => Promise<CapabilityPublicationResult>;
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
  const hasProjectProgram = proposal.effects.some(
    (effect) => effect.kind === "script" || effect.kind === "workflow",
  );
  if (hasProjectProgram) {
    if (proposal.scope !== undefined && proposal.scope !== "current_project")
      throw new Error("Script and workflow Capability effects require current-project scope");
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
    if (
      effect.kind === "instruction" ||
      effect.kind === "skill" ||
      effect.kind === "script" ||
      effect.kind === "workflow"
    )
      continue;
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
    if (
      existingDefinition &&
      (input.proposal.name !== existingDefinition.name ||
        input.proposal.description !== existingDefinition.description ||
        input.proposal.applicability !== existingDefinition.applicability)
    )
      throw new Error(
        `Capability ${input.capabilityId} definition fields are immutable; revise only its behavior-bearing revision`,
      );
    const definition: CapabilityDefinition = Object.freeze(
      createConditionalObject({
        capabilityId: input.capabilityId,
        name: existingDefinition?.name ?? input.proposal.name,
      } as const)
        .addOptional(existingDefinition?.kind ? { kind: existingDefinition.kind } : undefined)
        .add({
          description: existingDefinition?.description ?? input.proposal.description,
          applicability: existingDefinition?.applicability ?? input.proposal.applicability,
          createdAt: existingDefinition?.createdAt ?? now(),
        } as const)
        .finish(),
    );
    options.registry.registerCapability(registryCapability(definition));
    const predecessorEffects = input.predecessor
      ? capabilityEffects(input.predecessor.revision)
      : Object.freeze([]);
    const effects = validateCapabilityEffects(
      await Promise.all(
        input.proposal.effects.map(async (draft, index): Promise<CapabilityEffect> => {
          if (draft.kind === "instruction") {
            const instructionIndex = input.proposal.effects
              .slice(0, index)
              .filter((candidate) => candidate.kind === "instruction").length;
            const predecessor = predecessorEffects.filter((effect) => effect.kind === "instruction")[
              instructionIndex
            ];
            const material = await options.workspace.definitions.recordWorkingDefinition(
              createConditionalObject({
                workingPath: `capabilities/${input.capabilityId}/${capabilityRevisionId}/instruction-${String(index + 1)}.md`,
                bytes: new TextEncoder().encode(`${draft.content.trim()}\n`),
                actor: input.actor,
                reason: input.proposal.rationale,
                provenanceRefs: input.evidenceRefs,
              } as const)
                .addOptional(
                  predecessor?.kind === "instruction"
                    ? { predecessorRevisionId: predecessor.material.revisionId }
                    : undefined,
                )
                .finish(),
            );
            return Object.freeze({ kind: "instruction" as const, material });
          }
          if (draft.kind === "skill") {
            const predecessor = predecessorEffects.find(
              (effect) => effect.kind === "skill" && effect.name === draft.name,
            );
            const material = await options.workspace.definitions.recordWorkingDefinition(
              createConditionalObject({
                workingPath: `capabilities/${input.capabilityId}/${capabilityRevisionId}/skills/${draft.name}/SKILL.md`,
                bytes: new TextEncoder().encode(`${draft.instructions.trim()}\n`),
                actor: input.actor,
                reason: input.proposal.rationale,
                provenanceRefs: input.evidenceRefs,
              } as const)
                .addOptional(
                  predecessor?.kind === "skill"
                    ? { predecessorRevisionId: predecessor.material.revisionId }
                    : undefined,
                )
                .finish(),
            );
            return Object.freeze({
              kind: "skill" as const,
              name: draft.name,
              description: draft.description,
              material,
            });
          }
          if (!input.project)
            throw new Error(`Capability ${draft.kind} ${draft.name} has no project authority`);
          const resolved = await (input.programResolver ?? programs).resolve(
            draft.kind,
            draft.name,
            input.project,
          );
          if (!resolved) throw new Error(`Unknown saved ${draft.kind} ${draft.name}`);
          return resolved;
        }),
      ),
    );
    const router = await compatibilityRouter(input.evidenceRefs, input.actor);
    const executesPrograms = effects.some((effect) => effect.kind === "script" || effect.kind === "workflow");
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
                effect.kind === "script"
                  ? [`script:${effect.project.projectId}:${effect.name}:run`, "scripts:*"]
                  : effect.kind === "workflow"
                    ? [`workflow:${effect.project.projectId}:${effect.name}:run`, "workflows:*"]
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
      revision: Object.freeze({
        revision,
        reference,
        summary: input.proposal.summary,
        rationale: input.proposal.rationale,
        anticipatedEffect: input.proposal.anticipatedEffect,
        createdAt: now(),
      }),
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
      feedback,
      expectedBindingRevision,
      scope: nextScope,
      activationMode: nextActivationMode,
    });
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

  return Object.freeze({ publish, replacePendingGate });
}
