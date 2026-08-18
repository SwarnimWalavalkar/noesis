import type { AgentMessage, StructuredInferencePort } from "@noesis/agent-types";
import type { AtomicCapabilityRegistry } from "@noesis/capabilities";
import {
  type Capability,
  type CapabilityActivationMode,
  type CapabilityDefinition,
  type CapabilityFeedback,
  type CapabilityLifecycleRevision,
  type CapabilityRevisionRef,
  type CapabilityScope,
  canonicalJson,
  createId,
  type EvidenceRef,
  type ProjectRef,
  sha256,
} from "@noesis/domain";
import type { ExactCitation, HistoryPort } from "@noesis/intelligence";
import type { CapabilityLifecycleStore, NoesisWorkspaceStore } from "@noesis/workspace";
import { z } from "zod";
import type { LearningRoleConfiguration, LearningTurnInput } from "./schemas.ts";

const CapabilityScopeDecisionSchema = z.enum(["global", "current_project", "current_session"]);
const CapabilityConsequenceSchema = z.enum([
  "ordinary",
  "recovery_control",
  "credential_export",
  "irreversible_external",
]);
const CapabilityProposalSchema = z.strictObject({
  name: z.string().min(1).max(160),
  kind: z.literal("instruction"),
  description: z.string().min(1).max(2_048),
  applicability: z.string().min(1).max(2_048),
  summary: z.string().min(1).max(2_048),
  rationale: z.string().min(1).max(4_096),
  anticipatedEffect: z.string().min(1).max(2_048),
  instruction: z.string().min(1).max(12_000),
  scope: CapabilityScopeDecisionSchema.optional(),
  activationMode: z.enum(["relevant", "always"]).optional(),
  consequence: CapabilityConsequenceSchema,
  consequenceDescription: z.string().min(1).max(2_048),
  evidenceCitationIndexes: z.array(z.number().int().nonnegative()).min(1).max(16),
});

const CapabilityGateChangeSchema = z.strictObject({
  summary: z.string().min(1).max(2_048),
  rationale: z.string().min(1).max(4_096),
  anticipatedEffect: z.string().min(1).max(2_048),
  instruction: z.string().min(1).max(12_000),
  consequence: CapabilityConsequenceSchema,
  consequenceDescription: z.string().min(1).max(2_048),
});

export const CapabilityReflectionOutputSchema = z.discriminatedUnion("decision", [
  z.strictObject({ decision: z.literal("no_change"), reason: z.string().min(1).max(2_048) }),
  z.strictObject({ decision: z.literal("create"), proposal: CapabilityProposalSchema }),
  z.strictObject({
    decision: z.literal("revise"),
    capabilityId: z.string().min(1),
    proposal: CapabilityProposalSchema,
  }),
  z.strictObject({
    decision: z.literal("pause"),
    capabilityId: z.string().min(1),
    reason: z.string().min(1).max(2_048),
  }),
  z.strictObject({
    decision: z.literal("restore"),
    capabilityId: z.string().min(1),
    capabilityRevisionId: z.string().min(1),
    reason: z.string().min(1).max(2_048),
  }),
  z.strictObject({
    decision: z.literal("change_binding"),
    capabilityId: z.string().min(1),
    scope: CapabilityScopeDecisionSchema,
    activationMode: z.enum(["relevant", "always"]),
    reason: z.string().min(1).max(2_048),
  }),
]);
export type CapabilityReflectionOutput = Readonly<z.infer<typeof CapabilityReflectionOutputSchema>>;

export interface CapabilityLearningTurn {
  readonly turn: LearningTurnInput;
  readonly project: ProjectRef;
  readonly selectedCapabilities: readonly CapabilityRevisionRef[];
}

export type CapabilityReflectionResult =
  | { readonly status: "no_change"; readonly reason: string }
  | {
      readonly status: "activated" | "revised" | "pending" | "paused" | "restored" | "binding_changed";
      readonly capabilityId: string;
      readonly message: string;
    }
  | { readonly status: "stale"; readonly capabilityId: string; readonly message: string };

export type CapabilityManagementIntent =
  | {
      readonly type: "pause";
      readonly capabilityId: string;
      readonly expectedBindingRevision: number;
    }
  | {
      readonly type: "resume";
      readonly capabilityId: string;
      readonly expectedBindingRevision: number;
    }
  | {
      readonly type: "restore";
      readonly capabilityId: string;
      readonly target: CapabilityRevisionRef;
      readonly expectedBindingRevision: number;
    }
  | {
      readonly type: "set-scope";
      readonly capabilityId: string;
      readonly scope: CapabilityScope;
      readonly expectedBindingRevision: number;
    }
  | {
      readonly type: "set-activation-mode";
      readonly capabilityId: string;
      readonly mode: CapabilityActivationMode;
      readonly expectedBindingRevision: number;
    }
  | { readonly type: "approve"; readonly gateRequestId: string }
  | { readonly type: "deny"; readonly gateRequestId: string }
  | { readonly type: "change"; readonly gateRequestId: string; readonly instruction: string };

export interface CapabilityLearningModule {
  readonly reflectSettledTurn: (
    turn: CapabilityLearningTurn,
    signal: AbortSignal,
  ) => Promise<CapabilityReflectionResult>;
  readonly iterateOnFeedback: (
    input: CapabilityLearningTurn & { readonly feedback: string },
    signal: AbortSignal,
  ) => Promise<CapabilityReflectionResult>;
  readonly manage: (
    intent: CapabilityManagementIntent,
    signal: AbortSignal,
  ) => Promise<CapabilityReflectionResult>;
}

export interface CreateCapabilityLearningModuleOptions {
  readonly workspace: NoesisWorkspaceStore;
  readonly store: CapabilityLifecycleStore;
  readonly registry: AtomicCapabilityRegistry;
  readonly history: Pick<HistoryPort, "search">;
  readonly inference: StructuredInferencePort;
  readonly reflector: LearningRoleConfiguration;
  readonly now?: () => string;
  readonly nextId?: (prefix: string) => string;
}

function roleRequest(
  configuration: LearningRoleConfiguration,
  runId: string,
  messages: readonly AgentMessage[],
  evidenceRefs: readonly EvidenceRef[],
  signal: AbortSignal,
) {
  return Object.freeze({
    runId,
    role: "reflector" as const,
    variant: configuration.variant,
    messages,
    evidenceRefs,
    availableTools: Object.freeze([]),
    signal,
  });
}

function scopeFrom(
  decision: z.infer<typeof CapabilityScopeDecisionSchema>,
  input: CapabilityLearningTurn,
): CapabilityScope {
  if (decision === "global") return Object.freeze({ kind: "global" });
  if (decision === "current_project")
    return Object.freeze({ kind: "project", project: Object.freeze({ ...input.project }) });
  return Object.freeze({ kind: "session", sessionId: input.turn.sessionId });
}

function scopeDecision(scope: CapabilityScope): z.infer<typeof CapabilityScopeDecisionSchema> {
  if (scope.kind === "global") return "global";
  if (scope.kind === "project") return "current_project";
  return "current_session";
}

function proposedScope(
  proposal: z.infer<typeof CapabilityProposalSchema>,
  input: CapabilityLearningTurn,
  current?: CapabilityScope,
): CapabilityScope {
  return proposal.scope === undefined
    ? (current ?? Object.freeze({ kind: "global" as const }))
    : scopeFrom(proposal.scope, input);
}

function proposedActivationMode(
  proposal: z.infer<typeof CapabilityProposalSchema>,
  current?: CapabilityActivationMode,
): CapabilityActivationMode {
  return proposal.activationMode ?? current ?? "relevant";
}

const CURRENT_CAPABILITIES_MAX_CHARACTERS = 12_000;
const CURRENT_CAPABILITIES_MAX_ITEMS = 64;

function currentCapabilitiesMessage(
  definitions: readonly CapabilityDefinition[],
  bindings: readonly import("@noesis/domain").CapabilityBinding[],
  selectedCapabilities: readonly CapabilityRevisionRef[],
): string {
  const bindingByCapabilityId = new Map(bindings.map((binding) => [binding.capabilityId, binding]));
  const selectedIds = new Set(selectedCapabilities.map((reference) => reference.capabilityId));
  const projected = definitions
    .map((definition) => {
      const binding = bindingByCapabilityId.get(definition.capabilityId);
      return Object.freeze({
        capabilityId: definition.capabilityId,
        name: definition.name,
        kind: definition.kind,
        description: definition.description,
        applicability: definition.applicability,
        ...(binding
          ? {
              binding: Object.freeze({
                revision: binding.revision,
                scope: binding.scope,
                activationMode: binding.activationMode,
                state: binding.state,
                revisionNumber: binding.revisionNumber,
              }),
            }
          : {}),
      });
    })
    .sort((left, right) => {
      const selectedDelta =
        Number(selectedIds.has(right.capabilityId)) - Number(selectedIds.has(left.capabilityId));
      return selectedDelta || left.capabilityId.localeCompare(right.capabilityId);
    })
    .slice(0, CURRENT_CAPABILITIES_MAX_ITEMS);
  while (projected.length > 0) {
    const encoded = canonicalJson({
      capabilities: projected,
      omittedCount: Math.max(0, definitions.length - projected.length),
    });
    if (encoded.length <= CURRENT_CAPABILITIES_MAX_CHARACTERS) return encoded;
    projected.pop();
  }
  return canonicalJson({ capabilities: [], omittedCount: definitions.length });
}

function citedEvidence(
  indexes: readonly number[],
  citations: readonly ExactCitation[],
): readonly EvidenceRef[] {
  const selected = new Map<string, EvidenceRef>();
  for (const index of indexes) {
    const citation = citations[index];
    if (!citation) throw new Error(`Capability reflection cited unavailable evidence index ${index}`);
    if (citation.source.kind !== "database_row") continue;
    const reference: EvidenceRef = Object.freeze({
      kind: "database_row",
      table: citation.source.table,
      rowId: citation.source.rowId,
    });
    selected.set(canonicalJson(reference), reference);
  }
  if (selected.size === 0) throw new Error("Capability decision requires authoritative evidence");
  return Object.freeze([...selected.values()]);
}

function registryCapability(capability: CapabilityDefinition): Capability {
  return Object.freeze({
    capabilityId: capability.capabilityId,
    name: capability.name,
    scope: "general",
    intent: capability.applicability,
  });
}

export function createCapabilityLearningModule(
  options: CreateCapabilityLearningModuleOptions,
): CapabilityLearningModule {
  const now = options.now ?? (() => new Date().toISOString());
  const nextId = options.nextId ?? createId;

  const authorRevision = async (input: {
    readonly proposal: z.infer<typeof CapabilityProposalSchema>;
    readonly capabilityId: string;
    readonly predecessor?: CapabilityLifecycleRevision;
    readonly evidenceRefs: readonly EvidenceRef[];
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
    const definition: CapabilityDefinition = Object.freeze({
      capabilityId: input.capabilityId,
      name: existingDefinition?.name ?? input.proposal.name,
      kind: existingDefinition?.kind ?? input.proposal.kind,
      description: existingDefinition?.description ?? input.proposal.description,
      applicability: existingDefinition?.applicability ?? input.proposal.applicability,
      createdAt: existingDefinition?.createdAt ?? now(),
    });
    options.registry.registerCapability(registryCapability(definition));
    const actor = Object.freeze({ actorId: "capability-learning", kind: "noesis" as const });
    const prompt = await options.workspace.definitions.recordWorkingDefinition({
      workingPath: `capabilities/${input.capabilityId}/${capabilityRevisionId}/instructions.md`,
      bytes: new TextEncoder().encode(`${input.proposal.instruction.trim()}\n`),
      actor,
      reason: input.proposal.rationale,
      provenanceRefs: input.evidenceRefs,
      ...(input.predecessor?.revision.promptModules[0]
        ? { predecessorRevisionId: input.predecessor.revision.promptModules[0].revisionId }
        : {}),
    });
    const strategyId = `capability-${input.capabilityId}-v1`;
    const router = await options.workspace.definitions.recordWorkingDefinition({
      workingPath: `capabilities/${input.capabilityId}/${capabilityRevisionId}/router.json`,
      bytes: new TextEncoder().encode(`${canonicalJson({ strategyId, scope: "general" })}\n`),
      actor,
      reason: `Route ${definition.name} by semantic relevance`,
      provenanceRefs: input.evidenceRefs,
      ...(input.predecessor
        ? { predecessorRevisionId: input.predecessor.revision.toolset.routerRevision.revisionId }
        : {}),
    });
    const reference = options.registry.constructRevision({
      definitionState: "candidate",
      capabilityRevisionId,
      capabilityId: input.capabilityId,
      ...(input.predecessor
        ? { predecessorRevisionId: input.predecessor.revision.capabilityRevisionId }
        : {}),
      promptModules: Object.freeze([prompt]),
      skills: Object.freeze([]),
      tools: Object.freeze([]),
      routerRevision: router,
      routerStrategyId: strategyId,
      activationPolicy: Object.freeze({ mode: "automatic_low_risk", scope: "general" }),
      permissionManifest: Object.freeze({
        effects: Object.freeze([]),
        resourcePatterns: Object.freeze([]),
        credentialRefs: Object.freeze([]),
      }),
      evidenceRefs: input.evidenceRefs,
      sourceEvaluationDefinitions: Object.freeze([]),
      requestedPermissionDelta: Object.freeze({
        addedEffects: Object.freeze([]),
        widenedResources: Object.freeze([]),
        addedCredentialRefs: Object.freeze([]),
      }),
    });
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

  const reflect = async (
    input: CapabilityLearningTurn & { readonly feedback?: string },
    signal: AbortSignal,
  ): Promise<CapabilityReflectionResult> => {
    signal.throwIfAborted();
    if (input.turn.sensitivity === "secret")
      return Object.freeze({
        status: "no_change",
        reason: "Secret turns are excluded from ambient capability authoring",
      });
    const [history, bindings] = await Promise.all([
      options.history.search({
        query: input.feedback ?? input.turn.correction ?? input.turn.userMessage,
        sessionScope: Object.freeze({ kind: "previous", currentSessionId: input.turn.sessionId }),
        limit: 8,
        maxExcerptChars: 800,
        signal,
      }),
      options.store.listBindings({
        project: input.project,
        sessionId: input.turn.sessionId,
        limit: 1_000,
      }),
    ]);
    const definitions = await options.store.getDefinitions(bindings.map((binding) => binding.capabilityId));
    const currentEvidence: ExactCitation = Object.freeze({
      source: Object.freeze({
        kind: "database_row" as const,
        table: "messages" as const,
        rowId: `${input.turn.turnId}:user`,
        field: "content",
      }),
      occurredAt: input.turn.occurredAt,
      excerpt: input.turn.userMessage,
      startOffset: 0,
      endOffset: input.turn.userMessage.length,
      contentDigest: sha256(input.turn.userMessage),
    });
    const citations = Object.freeze([currentEvidence, ...history.hits.map((hit) => hit.citation)]);
    const messages: readonly AgentMessage[] = Object.freeze([
      Object.freeze({
        role: "user" as const,
        name: "settled_turn",
        content: canonicalJson({
          ...input.turn,
          selectedCapabilities: input.selectedCapabilities,
          ...(input.feedback ? { explicitFeedback: input.feedback } : {}),
        }),
      }),
      Object.freeze({
        role: "user" as const,
        name: "current_capabilities",
        content: currentCapabilitiesMessage(definitions, bindings, input.selectedCapabilities),
      }),
      Object.freeze({
        role: "user" as const,
        name: "evidence",
        content: canonicalJson(
          citations.map((citation, index) => ({
            index,
            source: citation.source,
            occurredAt: citation.occurredAt,
            excerpt: citation.excerpt,
          })),
        ),
      }),
    ]);
    const inferred = await options.inference.run(
      roleRequest(
        options.reflector,
        nextId(input.feedback ? "iterate-feedback" : "reflect-capability"),
        messages,
        input.turn.evidenceRefs,
        signal,
      ),
      CapabilityReflectionOutputSchema,
    );
    signal.throwIfAborted();
    const decision = inferred.value;
    const decisionEvidence = Object.freeze([
      Object.freeze({
        kind: "database_row" as const,
        table: "messages" as const,
        rowId: `${input.turn.turnId}:user`,
      }),
    ]);
    const decisionFeedback = (
      binding: import("@noesis/domain").CapabilityBinding,
      interpretation: string,
      disposition: CapabilityFeedback["disposition"],
    ): CapabilityFeedback =>
      Object.freeze({
        feedbackId: nextId("capability_feedback"),
        capabilityId: binding.capabilityId,
        revision: binding.revision,
        evidenceRefs: decisionEvidence,
        interpretation,
        disposition,
        createdAt: now(),
      });
    if (decision.decision === "no_change")
      return Object.freeze({ status: "no_change", reason: decision.reason });
    if (decision.decision === "pause") {
      const binding = await options.store.getBinding(decision.capabilityId);
      if (!binding) throw new Error(`Unknown capability ${decision.capabilityId}`);
      signal.throwIfAborted();
      const updated = await options.store.updateBindingWithFeedback({
        capabilityId: binding.capabilityId,
        expectedRevisionNumber: binding.revisionNumber,
        state: "paused",
        feedback: decisionFeedback(binding, decision.reason, "correction"),
      });
      return Object.freeze({
        status: updated.status === "stale" ? "stale" : "paused",
        capabilityId: binding.capabilityId,
        message: decision.reason,
      });
    }
    if (decision.decision === "restore") {
      const [binding, revisions] = await Promise.all([
        options.store.getBinding(decision.capabilityId),
        options.store.listRevisions(decision.capabilityId),
      ]);
      if (!binding) throw new Error(`Unknown capability ${decision.capabilityId}`);
      const target = revisions.find(
        (revision) => revision.reference.capabilityRevisionId === decision.capabilityRevisionId,
      );
      if (!target) throw new Error(`Unknown restorable revision ${decision.capabilityRevisionId}`);
      signal.throwIfAborted();
      const updated = await options.store.updateBindingWithFeedback({
        capabilityId: binding.capabilityId,
        expectedRevisionNumber: binding.revisionNumber,
        revision: target.reference,
        state: "active",
        feedback: decisionFeedback(binding, decision.reason, "restore_request"),
      });
      return Object.freeze({
        status: updated.status === "stale" ? "stale" : "restored",
        capabilityId: binding.capabilityId,
        message: decision.reason,
      });
    }
    if (decision.decision === "change_binding") {
      const binding = await options.store.getBinding(decision.capabilityId);
      if (!binding) throw new Error(`Unknown capability ${decision.capabilityId}`);
      signal.throwIfAborted();
      const updated = await options.store.updateBindingWithFeedback({
        capabilityId: binding.capabilityId,
        expectedRevisionNumber: binding.revisionNumber,
        scope: scopeFrom(decision.scope, input),
        activationMode: decision.activationMode,
        feedback: decisionFeedback(
          binding,
          decision.reason,
          decision.activationMode !== binding.activationMode ? "activation_change" : "scope_change",
        ),
      });
      return Object.freeze({
        status: updated.status === "stale" ? "stale" : "binding_changed",
        capabilityId: binding.capabilityId,
        message: decision.reason,
      });
    }
    const proposal = decision.proposal;
    const evidenceRefs = citedEvidence(proposal.evidenceCitationIndexes, citations);
    const capabilityId = decision.decision === "create" ? nextId("capability") : decision.capabilityId;
    const binding = await options.store.getBinding(capabilityId);
    const predecessor = binding ? await options.store.getRevision(binding.revision) : undefined;
    if (decision.decision === "revise" && (!binding || !predecessor))
      throw new Error(`Cannot revise unknown capability ${capabilityId}`);
    const authored = await authorRevision({
      proposal,
      capabilityId,
      evidenceRefs,
      ...(predecessor ? { predecessor } : {}),
    });
    const requiresGate = proposal.consequence !== "ordinary";
    const nextScope = proposedScope(proposal, input, binding?.scope);
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
      await options.store.create({
        definition: authored.definition,
        revision: authored.revision,
        binding: Object.freeze({
          capabilityId,
          revision: authored.revision.reference,
          scope: nextScope,
          activationMode: nextActivationMode,
          state: requiresGate ? "paused" : "active",
        }),
        ...(gate ? { gate } : {}),
      });
      return Object.freeze({
        status: requiresGate ? "pending" : "activated",
        capabilityId,
        message: authored.revision.summary,
      });
    }
    const feedback = Object.freeze({
      feedbackId: nextId("capability_feedback"),
      capabilityId,
      revision: binding.revision,
      evidenceRefs,
      interpretation: input.feedback ?? input.turn.correction ?? proposal.rationale,
      disposition: "correction" as const,
      createdAt: now(),
    }) satisfies CapabilityFeedback;
    if (requiresGate) {
      signal.throwIfAborted();
      await options.store.stageGatedRevision({
        revision: authored.revision,
        feedback,
        gate: Object.freeze({
          gateRequestId: nextId("capability_gate"),
          capabilityId,
          revision: authored.revision.reference,
          expectedBindingRevision: binding.revisionNumber,
          proposedScope: nextScope,
          proposedActivationMode: nextActivationMode,
          consequence: proposal.consequenceDescription,
          status: "pending",
          createdAt: now(),
        }),
      });
      return Object.freeze({ status: "pending", capabilityId, message: authored.revision.summary });
    }
    signal.throwIfAborted();
    const updated = await options.store.applyRevision({
      revision: authored.revision,
      feedback,
      expectedBindingRevision: binding.revisionNumber,
      scope: nextScope,
      activationMode: nextActivationMode,
    });
    return Object.freeze({
      status: updated.status === "stale" ? "stale" : "revised",
      capabilityId,
      message: authored.revision.summary,
    });
  };

  const manage: CapabilityLearningModule["manage"] = async (intent, signal) => {
    signal.throwIfAborted();
    if (intent.type === "approve" || intent.type === "deny") {
      const gate = await options.store.getGate(intent.gateRequestId);
      if (!gate) throw new Error(`Unknown capability gate ${intent.gateRequestId}`);
      if (gate.status !== "pending")
        throw new Error(`Capability gate ${intent.gateRequestId} is already ${gate.status}`);
      signal.throwIfAborted();
      const decided = await options.store.decideGate({
        gateRequestId: gate.gateRequestId,
        decision: intent.type,
      });
      if (intent.type === "deny") {
        return Object.freeze({
          status: "paused",
          capabilityId: gate.capabilityId,
          message: "Capability decision denied",
        });
      }
      if (decided.status === "stale")
        return Object.freeze({
          status: "stale",
          capabilityId: gate.capabilityId,
          message: "Binding changed",
        });
      return Object.freeze({
        status: "activated",
        capabilityId: gate.capabilityId,
        message: "Capability approved",
      });
    }
    if (intent.type === "change") {
      const gate = await options.store.getGate(intent.gateRequestId);
      if (!gate) throw new Error(`Unknown capability gate ${intent.gateRequestId}`);
      if (gate.status !== "pending")
        throw new Error(`Capability gate ${intent.gateRequestId} is already ${gate.status}`);
      const [binding, predecessor, definition] = await Promise.all([
        options.store.getBinding(gate.capabilityId),
        options.store.getRevision(gate.revision),
        options.store.getDefinition(gate.capabilityId),
      ]);
      if (!binding || !predecessor || !definition)
        throw new Error(`Capability gate ${intent.gateRequestId} has incomplete authority`);
      const inferred = await options.inference.run(
        roleRequest(
          options.reflector,
          nextId("change-capability-gate"),
          Object.freeze([
            Object.freeze({
              role: "user" as const,
              name: "pending_capability",
              content: canonicalJson({ definition, revision: predecessor, binding, gate }),
            }),
            Object.freeze({
              role: "user" as const,
              name: "user_change_request",
              content: intent.instruction,
            }),
          ]),
          predecessor.revision.evidenceRefs,
          signal,
        ),
        CapabilityGateChangeSchema,
      );
      signal.throwIfAborted();
      const changed = inferred.value;
      const proposal: z.infer<typeof CapabilityProposalSchema> = Object.freeze({
        name: definition.name,
        kind: "instruction",
        description: definition.description,
        applicability: definition.applicability,
        summary: changed.summary,
        rationale: changed.rationale,
        anticipatedEffect: changed.anticipatedEffect,
        instruction: changed.instruction,
        scope: scopeDecision(gate.proposedScope),
        activationMode: gate.proposedActivationMode,
        consequence: changed.consequence,
        consequenceDescription: changed.consequenceDescription,
        evidenceCitationIndexes: [0],
      });
      const authored = await authorRevision({
        proposal,
        capabilityId: gate.capabilityId,
        predecessor,
        evidenceRefs: predecessor.revision.evidenceRefs,
      });
      signal.throwIfAborted();
      await options.store.stageGatedRevision({
        revision: authored.revision,
        feedback: Object.freeze({
          feedbackId: nextId("capability_feedback"),
          capabilityId: gate.capabilityId,
          revision: binding.revision,
          evidenceRefs: predecessor.revision.evidenceRefs,
          interpretation: intent.instruction,
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
          consequence: changed.consequenceDescription,
          status: "pending",
          instruction: intent.instruction,
          createdAt: now(),
        }),
      });
      return Object.freeze({
        status: "pending",
        capabilityId: gate.capabilityId,
        message: authored.revision.summary,
      });
    }
    const binding = await options.store.getBinding(intent.capabilityId);
    if (!binding) throw new Error(`Unknown capability ${intent.capabilityId}`);
    const request =
      intent.type === "pause" || intent.type === "resume"
        ? {
            capabilityId: intent.capabilityId,
            expectedRevisionNumber: intent.expectedBindingRevision,
            state: intent.type === "pause" ? ("paused" as const) : ("active" as const),
          }
        : intent.type === "restore"
          ? {
              capabilityId: intent.capabilityId,
              expectedRevisionNumber: intent.expectedBindingRevision,
              revision: intent.target,
              state: "active" as const,
            }
          : intent.type === "set-scope"
            ? {
                capabilityId: intent.capabilityId,
                expectedRevisionNumber: intent.expectedBindingRevision,
                scope: intent.scope,
              }
            : {
                capabilityId: intent.capabilityId,
                expectedRevisionNumber: intent.expectedBindingRevision,
                activationMode: intent.mode,
              };
    signal.throwIfAborted();
    const updated = await options.store.updateBinding(request);
    return Object.freeze({
      status:
        updated.status === "stale"
          ? "stale"
          : intent.type === "restore"
            ? "restored"
            : intent.type === "pause"
              ? "paused"
              : "binding_changed",
      capabilityId: intent.capabilityId,
      message: updated.status === "stale" ? "Capability changed concurrently" : "Capability updated",
    });
  };

  return Object.freeze({
    reflectSettledTurn: async (turn: CapabilityLearningTurn, signal: AbortSignal) =>
      await reflect(turn, signal),
    iterateOnFeedback: async (
      input: CapabilityLearningTurn & { readonly feedback: string },
      signal: AbortSignal,
    ) => await reflect(input, signal),
    manage,
  });
}
