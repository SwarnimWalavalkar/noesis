import type { AgentMessage, StructuredInferencePort } from "@noesis/agent-types";
import {
  type AtomicCapabilityRegistry,
  capabilityEffectKinds,
  capabilityEffects,
  validateCapabilityEffects,
} from "@noesis/capabilities";
import {
  type Capability,
  type CapabilityActivationMode,
  type CapabilityDefinition,
  type CapabilityEffect,
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
const CapabilityEffectDraftSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("instruction"),
    content: z.string().min(1).max(12_000),
  }),
  z.strictObject({
    kind: z.literal("skill"),
    name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
    description: z.string().min(1).max(2_048),
    instructions: z.string().min(1).max(32_000),
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

const CapabilityProposalSchema = z
  .strictObject({
    name: z.string().min(1).max(160),
    /** Accepted only for compatibility with controlled responders written before effects-first authoring. */
    kind: z.literal("instruction").optional(),
    description: z.string().min(1).max(2_048),
    applicability: z.string().min(1).max(2_048),
    summary: z.string().min(1).max(2_048),
    rationale: z.string().min(1).max(4_096),
    anticipatedEffect: z.string().min(1).max(2_048),
    instruction: z.string().min(1).max(12_000).optional(),
    effects: z.array(CapabilityEffectDraftSchema).min(1).max(8).optional(),
    scope: CapabilityScopeDecisionSchema.optional(),
    activationMode: z.enum(["relevant", "always"]).optional(),
    consequence: CapabilityConsequenceSchema,
    consequenceDescription: z.string().min(1).max(2_048),
    evidenceCitationIndexes: z.array(z.number().int().nonnegative()).min(1).max(16),
  })
  .superRefine((proposal, context) => {
    if (proposal.effects === undefined && proposal.instruction === undefined)
      context.addIssue({ code: "custom", message: "Capability proposal requires effects" });
  });

const CapabilityGateChangeSchema = z.strictObject({
  summary: z.string().min(1).max(2_048),
  rationale: z.string().min(1).max(4_096),
  anticipatedEffect: z.string().min(1).max(2_048),
  effects: z.array(CapabilityEffectDraftSchema).min(1).max(8),
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
  readonly programs?: CapabilityProgramLibrary;
  readonly now?: () => string;
  readonly nextId?: (prefix: string) => string;
}

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
  const hasProjectProgram = proposalEffects(proposal).some(
    (effect) => effect.kind === "script" || effect.kind === "workflow",
  );
  if (hasProjectProgram) {
    if (proposal.scope !== undefined && proposal.scope !== "current_project")
      throw new Error("Script and workflow Capability effects require current-project scope");
    return Object.freeze({ kind: "project", project: Object.freeze({ ...input.project }) });
  }
  return proposal.scope === undefined
    ? (current ?? Object.freeze({ kind: "global" as const }))
    : scopeFrom(proposal.scope, input);
}

function proposalEffects(
  proposal: z.infer<typeof CapabilityProposalSchema>,
): readonly z.infer<typeof CapabilityEffectDraftSchema>[] {
  if (proposal.effects) return Object.freeze([...proposal.effects]);
  if (!proposal.instruction) throw new Error("Capability proposal has no effects");
  return Object.freeze([{ kind: "instruction" as const, content: proposal.instruction }]);
}

function proposedActivationMode(
  proposal: z.infer<typeof CapabilityProposalSchema>,
  current?: CapabilityActivationMode,
): CapabilityActivationMode {
  return proposal.activationMode ?? current ?? "relevant";
}

const CURRENT_CAPABILITIES_MAX_CHARACTERS = 12_000;
const CURRENT_CAPABILITIES_MAX_ITEMS = 64;
const CURRENT_MATERIALS_MAX_CHARACTERS = 16_000;
const CURRENT_MATERIAL_EXCERPT_CHARACTERS = 4_000;
const AVAILABLE_PROGRAMS_MAX_CHARACTERS = 8_000;
const AVAILABLE_PROGRAMS_MAX_ITEMS = 64;

function currentCapabilitiesMessage(
  definitions: readonly CapabilityDefinition[],
  bindings: readonly import("@noesis/domain").CapabilityBinding[],
  revisions: ReadonlyMap<string, CapabilityLifecycleRevision>,
  selectedCapabilities: readonly CapabilityRevisionRef[],
): string {
  const bindingByCapabilityId = new Map(bindings.map((binding) => [binding.capabilityId, binding]));
  const selectedIds = new Set(selectedCapabilities.map((reference) => reference.capabilityId));
  const projected = definitions
    .map((definition) => {
      const binding = bindingByCapabilityId.get(definition.capabilityId);
      const lifecycle = revisions.get(definition.capabilityId);
      return Object.freeze({
        capabilityId: definition.capabilityId,
        name: definition.name,
        effects: lifecycle ? capabilityEffectKinds(lifecycle.revision) : Object.freeze([]),
        ...(!lifecycle && definition.kind ? { legacyKind: definition.kind } : {}),
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

const CURRENT_TURN_CITATION_CHARACTERS = 1_200;

function exactCitation(source: ExactCitation["source"], occurredAt: string, content: string): ExactCitation {
  const excerpt = content.slice(0, CURRENT_TURN_CITATION_CHARACTERS);
  return Object.freeze({
    source,
    occurredAt,
    excerpt,
    startOffset: 0,
    endOffset: excerpt.length,
    contentDigest: sha256(content),
  });
}

async function currentTurnCitations(
  workspace: NoesisWorkspaceStore,
  turn: LearningTurnInput,
): Promise<readonly ExactCitation[]> {
  const citations: ExactCitation[] = [];
  for (const reference of turn.evidenceRefs) {
    if (reference.kind !== "database_row") continue;
    if (reference.table === "messages") {
      const message = await workspace.operational.messages.get(reference.rowId);
      if (!message || message.sensitivity !== "normal") continue;
      citations.push(
        exactCitation(
          Object.freeze({
            kind: "database_row",
            table: "messages",
            rowId: message.messageId,
            field: "content",
          }),
          message.createdAt,
          message.content,
        ),
      );
      continue;
    }
    if (reference.table === "tool_calls") {
      const call = await workspace.operational.toolCalls.get(reference.rowId);
      if (!call || call.sensitivity !== "normal") continue;
      const content = [
        call.toolName,
        canonicalJson(call.request),
        canonicalJson(call.response ?? call.update ?? null),
      ].join("\n");
      citations.push(
        exactCitation(
          Object.freeze({
            kind: "database_row",
            table: "tool_calls",
            rowId: call.toolCallId,
            field: "trace",
          }),
          call.createdAt,
          content,
        ),
      );
      continue;
    }
    if (reference.table === "outcomes") {
      const outcome = await workspace.operational.outcomes.get(reference.rowId);
      if (!outcome || outcome.sensitivity !== "normal") continue;
      citations.push(
        exactCitation(
          Object.freeze({
            kind: "database_row",
            table: "outcomes",
            rowId: outcome.outcomeId,
            field: "summary",
          }),
          outcome.createdAt,
          outcome.summary,
        ),
      );
    }
  }
  if (citations.length > 0) return Object.freeze(citations);
  return Object.freeze([
    exactCitation(
      Object.freeze({
        kind: "database_row",
        table: "messages",
        rowId: `${turn.turnId}:user`,
        field: "content",
      }),
      turn.occurredAt,
      turn.userMessage,
    ),
  ]);
}

async function currentCapabilityMaterialsMessage(
  workspace: NoesisWorkspaceStore,
  revisions: ReadonlyMap<string, CapabilityLifecycleRevision>,
  selectedCapabilities: readonly CapabilityRevisionRef[],
): Promise<string> {
  const selectedIds = new Set(selectedCapabilities.map((reference) => reference.capabilityId));
  const ordered = [...revisions.entries()].sort((left, right) => {
    const selectedDelta = Number(selectedIds.has(right[0])) - Number(selectedIds.has(left[0]));
    return selectedDelta || left[0].localeCompare(right[0]);
  });
  const projected: unknown[] = [];
  let characters = 0;
  for (const [capabilityId, lifecycle] of ordered) {
    const effects = capabilityEffects(lifecycle.revision);
    if (effects.length === 0) continue;
    const materials = await Promise.all(
      effects.map(async (effect) => {
        const reference =
          effect.kind === "instruction" || effect.kind === "skill"
            ? effect.material
            : effect.definitionRevision;
        const content = new TextDecoder("utf8", { fatal: true })
          .decode(await workspace.reads.readRevision(reference))
          .slice(0, CURRENT_MATERIAL_EXCERPT_CHARACTERS);
        return Object.freeze({
          kind: effect.kind,
          ...(effect.kind === "skill" || effect.kind === "script" || effect.kind === "workflow"
            ? { name: effect.name }
            : {}),
          ...(effect.kind === "skill" ? { description: effect.description } : {}),
          revisionId: reference.revisionId,
          contentDigest: reference.contentDigest,
          content,
        });
      }),
    );
    const item = Object.freeze({
      capabilityId,
      revisionId: lifecycle.reference.capabilityRevisionId,
      summary: lifecycle.summary,
      effects: materials,
    });
    const encoded = canonicalJson(item);
    if (characters + encoded.length > CURRENT_MATERIALS_MAX_CHARACTERS) break;
    projected.push(item);
    characters += encoded.length;
  }
  return canonicalJson({ capabilities: projected });
}

function availableProgramsMessage(programs: Awaited<ReturnType<CapabilityProgramLibrary["list"]>>): string {
  const projected = [...programs]
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name))
    .slice(0, AVAILABLE_PROGRAMS_MAX_ITEMS);
  while (projected.length > 0) {
    const encoded = canonicalJson({
      instruction:
        "Script and workflow effects must reference one exact saved project program from this list.",
      programs: projected,
      omittedCount: Math.max(0, programs.length - projected.length),
    });
    if (encoded.length <= AVAILABLE_PROGRAMS_MAX_CHARACTERS) return encoded;
    projected.pop();
  }
  return canonicalJson({
    instruction: "No saved project programs fit the bounded reflection context.",
    programs: [],
    omittedCount: programs.length,
  });
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
  const programs: CapabilityProgramLibrary =
    options.programs ??
    Object.freeze({
      list: async () => Object.freeze([]),
      resolve: async () => undefined,
    });

  const compatibilityRouter = async (evidenceRefs: readonly EvidenceRef[]) => {
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
        actor: Object.freeze({ actorId: "capability-learning", kind: "noesis" as const }),
        reason: "Compatibility identity for the central semantic Capability router",
      }),
    });
    if (publication.ok) return publication.value.definitionRevision;
    const raced = await options.workspace.definitionMetadata.getCurrent(namespace, definitionId);
    if (!raced) throw new Error(publication.error.message);
    return raced.definitionRevision;
  };

  const authorRevision = async (input: {
    readonly proposal: z.infer<typeof CapabilityProposalSchema>;
    readonly capabilityId: string;
    readonly predecessor?: CapabilityLifecycleRevision;
    readonly evidenceRefs: readonly EvidenceRef[];
    readonly project?: ProjectRef;
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
    const drafts = proposalEffects(input.proposal);
    const definition: CapabilityDefinition = Object.freeze({
      capabilityId: input.capabilityId,
      name: existingDefinition?.name ?? input.proposal.name,
      ...(existingDefinition?.kind ? { kind: existingDefinition.kind } : {}),
      description: existingDefinition?.description ?? input.proposal.description,
      applicability: existingDefinition?.applicability ?? input.proposal.applicability,
      createdAt: existingDefinition?.createdAt ?? now(),
    });
    options.registry.registerCapability(registryCapability(definition));
    const actor = Object.freeze({ actorId: "capability-learning", kind: "noesis" as const });
    const predecessorEffects = input.predecessor
      ? capabilityEffects(input.predecessor.revision)
      : Object.freeze([]);
    const effects = validateCapabilityEffects(
      await Promise.all(
        drafts.map(async (draft, index): Promise<CapabilityEffect> => {
          if (draft.kind === "instruction") {
            const instructionIndex = drafts
              .slice(0, index)
              .filter((candidate) => candidate.kind === "instruction").length;
            const predecessor = predecessorEffects.filter((effect) => effect.kind === "instruction")[
              instructionIndex
            ];
            const material = await options.workspace.definitions.recordWorkingDefinition({
              workingPath: `capabilities/${input.capabilityId}/${capabilityRevisionId}/instruction-${String(index + 1)}.md`,
              bytes: new TextEncoder().encode(`${draft.content.trim()}\n`),
              actor,
              reason: input.proposal.rationale,
              provenanceRefs: input.evidenceRefs,
              ...(predecessor?.kind === "instruction"
                ? { predecessorRevisionId: predecessor.material.revisionId }
                : {}),
            });
            return Object.freeze({ kind: "instruction" as const, material });
          }
          if (draft.kind === "skill") {
            const predecessor = predecessorEffects.find(
              (effect) => effect.kind === "skill" && effect.name === draft.name,
            );
            const material = await options.workspace.definitions.recordWorkingDefinition({
              workingPath: `capabilities/${input.capabilityId}/${capabilityRevisionId}/skills/${draft.name}/SKILL.md`,
              bytes: new TextEncoder().encode(`${draft.instructions.trim()}\n`),
              actor,
              reason: input.proposal.rationale,
              provenanceRefs: input.evidenceRefs,
              ...(predecessor?.kind === "skill"
                ? { predecessorRevisionId: predecessor.material.revisionId }
                : {}),
            });
            return Object.freeze({
              kind: "skill" as const,
              name: draft.name,
              description: draft.description,
              material,
            });
          }
          if (!input.project)
            throw new Error(`Capability ${draft.kind} ${draft.name} has no project authority`);
          const resolved = await programs.resolve(draft.kind, draft.name, input.project);
          if (!resolved) throw new Error(`Unknown saved ${draft.kind} ${draft.name}`);
          return resolved;
        }),
      ),
    );
    const router = await compatibilityRouter(input.evidenceRefs);
    const executesPrograms = effects.some((effect) => effect.kind === "script" || effect.kind === "workflow");
    const reference = options.registry.constructRevision({
      definitionState: "candidate",
      capabilityRevisionId,
      capabilityId: input.capabilityId,
      ...(input.predecessor
        ? { predecessorRevisionId: input.predecessor.revision.capabilityRevisionId }
        : {}),
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
    const [definitions, currentRevisions, availablePrograms] = await Promise.all([
      options.store.getDefinitions(bindings.map((binding) => binding.capabilityId)),
      Promise.all(bindings.map(async (binding) => await options.store.getRevision(binding.revision))),
      programs.list(input.project),
    ]);
    const revisionsByCapabilityId = new Map<string, CapabilityLifecycleRevision>();
    for (const revision of currentRevisions)
      if (revision) revisionsByCapabilityId.set(revision.reference.capabilityId, revision);
    const currentEvidence = await currentTurnCitations(options.workspace, input.turn);
    const citations = Object.freeze([...currentEvidence, ...history.hits.map((hit) => hit.citation)]);
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
        content: currentCapabilitiesMessage(
          definitions,
          bindings,
          revisionsByCapabilityId,
          input.selectedCapabilities,
        ),
      }),
      Object.freeze({
        role: "user" as const,
        name: "current_capability_materials",
        content: await currentCapabilityMaterialsMessage(
          options.workspace,
          revisionsByCapabilityId,
          input.selectedCapabilities,
        ),
      }),
      Object.freeze({
        role: "user" as const,
        name: "available_saved_programs",
        content: availableProgramsMessage(availablePrograms),
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
    const decisionEvidence = Object.freeze([...input.turn.evidenceRefs]);
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
      project: input.project,
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
        description: definition.description,
        applicability: definition.applicability,
        summary: changed.summary,
        rationale: changed.rationale,
        anticipatedEffect: changed.anticipatedEffect,
        effects: changed.effects,
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
        ...(gate.proposedScope.kind === "project" ? { project: gate.proposedScope.project } : {}),
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
