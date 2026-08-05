import {
  type AgentThinkingLevel,
  type FrozenBaselineRef,
  type FrozenCapabilitySelection,
  type FrozenRevisionMaterial,
  type FrozenTurnPlan,
  MAX_FROZEN_CONVERSATION_HISTORY_ENTRY_CHARACTERS,
  MAX_FROZEN_CONVERSATION_HISTORY_MESSAGES,
  MAX_FROZEN_CONVERSATION_HISTORY_TOTAL_CHARACTERS,
  frozenTurnPlanDigest,
  validateFrozenTurnPlan,
} from "@noesis/agent-types";
import type {
  Capability,
  CapabilityRevision,
  CapabilityRevisionRef,
  EvidenceRef,
  FileRevisionRef,
  PermissionManifest,
} from "@noesis/domain";
import { sha256 } from "@noesis/domain";
import type { NoesisWorkspaceStore } from "@noesis/workspace";
import type { ProtectedWorkspaceRuntime } from "../../workspace/src/protected-runtime.ts";

const decoder = new TextDecoder("utf8", { fatal: true });

export interface TurnCapabilityResolver {
  readonly resolveCapability: (capabilityId: string) => Promise<Capability | undefined>;
  readonly resolveRevision: (reference: CapabilityRevisionRef) => Promise<CapabilityRevision | undefined>;
  readonly resolveBaseline: (reference: CapabilityRevisionRef) => Promise<FrozenBaselineRef>;
}

export interface TurnPlanningRequest {
  readonly sessionId: string;
  readonly turnId: string;
  readonly userInput: string;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: AgentThinkingLevel;
  readonly baseSystemPrompt: string;
  readonly priorHistory?: readonly TurnRoutingHistoryMessage[];
  readonly retrievalCitations?: readonly EvidenceRef[];
}

export interface TurnIntelligencePlanner {
  readonly planAndAdmit: (request: TurnPlanningRequest) => Promise<FrozenTurnPlan>;
}

export interface TurnCapabilityRoutingCandidate {
  readonly capabilityId: string;
  readonly name: string;
  readonly scope: string;
  readonly intent: string;
}

export interface TurnRoutingHistoryMessage {
  readonly messageId: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly createdAt: string;
}

export interface TurnCapabilityRoutingRequest {
  readonly sessionId: string;
  readonly turnId: string;
  readonly userInput: string;
  readonly priorConversation: readonly TurnRoutingHistoryMessage[];
  readonly candidates: readonly TurnCapabilityRoutingCandidate[];
}

export interface TurnCapabilityRoutingSelection {
  readonly capabilityId: string;
  readonly reason: string;
}

export interface TurnCapabilityRoutingDecision {
  readonly strategyId: string;
  readonly reason: string;
  readonly selections: readonly TurnCapabilityRoutingSelection[];
  readonly learningAttribution?: {
    readonly capabilityId: string;
    readonly reason: string;
  };
}

/** Semantic relevance is supplied by a capable-model adapter at the composition root. */
export interface TurnCapabilityRouter {
  readonly route: (request: TurnCapabilityRoutingRequest) => Promise<TurnCapabilityRoutingDecision>;
}

export interface TurnIntelligencePlannerOptions {
  readonly workspace: NoesisWorkspaceStore;
  readonly protectedRuntime: ProtectedWorkspaceRuntime;
  readonly capabilities: TurnCapabilityResolver;
  readonly capabilityRouter: TurnCapabilityRouter;
  readonly basePermissionManifest?: PermissionManifest;
  readonly now?: () => string;
  readonly createPlanId?: (turnId: string) => string;
}

export {
  MAX_FROZEN_CONVERSATION_HISTORY_ENTRY_CHARACTERS,
  MAX_FROZEN_CONVERSATION_HISTORY_MESSAGES,
  MAX_FROZEN_CONVERSATION_HISTORY_TOTAL_CHARACTERS,
} from "@noesis/agent-types";

async function freezeConversationHistory(
  workspace: NoesisWorkspaceStore,
  sessionId: string,
  messages: readonly TurnRoutingHistoryMessage[],
): Promise<NonNullable<FrozenTurnPlan["conversationHistory"]>> {
  if (messages.length > MAX_FROZEN_CONVERSATION_HISTORY_MESSAGES)
    throw new Error(
      `Turn history has ${messages.length} messages; maximum is ${MAX_FROZEN_CONVERSATION_HISTORY_MESSAGES}`,
    );
  const seen = new Set<string>();
  let totalCharacters = 0;
  const frozen: NonNullable<FrozenTurnPlan["conversationHistory"]>[number][] = [];
  for (const message of messages) {
    if (seen.has(message.messageId)) throw new Error(`Turn history repeats message ${message.messageId}`);
    seen.add(message.messageId);
    if (message.content.length > MAX_FROZEN_CONVERSATION_HISTORY_ENTRY_CHARACTERS)
      throw new Error(`Turn history message ${message.messageId} exceeds the per-entry character bound`);
    totalCharacters += message.content.length;
    if (totalCharacters > MAX_FROZEN_CONVERSATION_HISTORY_TOTAL_CHARACTERS)
      throw new Error("Turn history exceeds the total character bound");
    const durable = await workspace.operational.messages.get(message.messageId);
    if (
      !durable ||
      durable.sessionId !== sessionId ||
      durable.role !== message.role ||
      durable.content !== message.content ||
      durable.createdAt !== message.createdAt
    )
      throw new Error(`Turn history message ${message.messageId} does not match authoritative SQLite state`);
    frozen.push(
      Object.freeze({
        messageId: message.messageId,
        messageRef: Object.freeze({
          kind: "database_row" as const,
          table: "messages" as const,
          rowId: message.messageId,
        }),
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
        contentDigest: sha256(message.content),
      }),
    );
  }
  return Object.freeze(frozen);
}

async function materialize(
  workspace: NoesisWorkspaceStore,
  reference: FileRevisionRef,
): Promise<FrozenRevisionMaterial> {
  const bytes = await workspace.reads.readRevision(reference);
  return Object.freeze({ revision: reference, content: decoder.decode(bytes) });
}

function mergedPermissions(
  selections: readonly FrozenCapabilitySelection[],
  baseline: PermissionManifest = Object.freeze({
    effects: Object.freeze([]),
    resourcePatterns: Object.freeze([]),
    credentialRefs: Object.freeze([]),
  }),
): FrozenTurnPlan["permissionSnapshot"] {
  return Object.freeze({
    effects: Object.freeze([
      ...new Set([
        ...baseline.effects,
        ...selections.flatMap((selection) => selection.permissionManifest.effects),
      ]),
    ]),
    resourcePatterns: Object.freeze([
      ...new Set([
        ...baseline.resourcePatterns,
        ...selections.flatMap((selection) => selection.permissionManifest.resourcePatterns),
      ]),
    ]),
    credentialRefs: Object.freeze([
      ...new Set([
        ...baseline.credentialRefs,
        ...selections.flatMap((selection) => selection.permissionManifest.credentialRefs),
      ]),
    ]),
  });
}

export function createTurnIntelligencePlanner(
  options: TurnIntelligencePlannerOptions,
): TurnIntelligencePlanner {
  const now = options.now ?? (() => new Date().toISOString());
  const createPlanId = options.createPlanId ?? ((turnId) => `turn_plan_${turnId}`);

  const planAndAdmit = async (request: TurnPlanningRequest): Promise<FrozenTurnPlan> => {
    const activation = await options.protectedRuntime.activations.current();
    if (!activation) throw new Error("A frozen turn plan requires an active genesis baseline");
    const conversationHistory = await freezeConversationHistory(
      options.workspace,
      request.sessionId,
      request.priorHistory ?? [],
    );
    const resolved: {
      readonly reference: CapabilityRevisionRef;
      readonly capability: Capability;
      readonly revision: CapabilityRevision;
      readonly baseline: FrozenBaselineRef;
    }[] = [];
    for (const reference of Object.values(activation.activeCapabilityRevisions)) {
      if (reference.kind !== "capability_revision") continue;
      const [capability, revision, baseline] = await Promise.all([
        options.capabilities.resolveCapability(reference.capabilityId),
        options.capabilities.resolveRevision(reference),
        options.capabilities.resolveBaseline(reference),
      ]);
      if (!capability || !revision)
        throw new Error(
          `Active capability ${reference.capabilityRevisionId} cannot be rehydrated from immutable state`,
        );
      resolved.push(Object.freeze({ reference, capability, revision, baseline }));
    }

    const general = resolved.filter((item) => item.baseline.kind === "genesis");
    const candidates = resolved.filter((item) => item.baseline.kind !== "genesis");
    const routing: TurnCapabilityRoutingDecision =
      candidates.length === 0
        ? Object.freeze({
            strategyId: "semantic-capability-router-v1",
            reason: "No narrow active capabilities required semantic routing",
            selections: Object.freeze([]),
          })
        : await options.capabilityRouter.route({
            sessionId: request.sessionId,
            turnId: request.turnId,
            userInput: request.userInput,
            priorConversation: Object.freeze(
              conversationHistory.map(({ messageId, role, content, createdAt }) =>
                Object.freeze({ messageId, role, content, createdAt }),
              ),
            ),
            candidates: Object.freeze(
              candidates.map(({ capability }) =>
                Object.freeze({
                  capabilityId: capability.capabilityId,
                  name: capability.name,
                  scope: capability.scope,
                  intent: capability.intent,
                }),
              ),
            ),
          });
    if (routing.strategyId.trim().length === 0) throw new Error("Capability router returned no strategy ID");
    if (routing.reason.trim().length === 0) throw new Error("Capability router returned no decision reason");
    const candidatesById = new Map(candidates.map((item) => [item.capability.capabilityId, item]));
    const selectedReasons = new Map<string, string>();
    for (const selection of routing.selections) {
      if (!candidatesById.has(selection.capabilityId))
        throw new Error(`Capability router selected inactive capability ${selection.capabilityId}`);
      if (selectedReasons.has(selection.capabilityId))
        throw new Error(`Capability router selected capability ${selection.capabilityId} more than once`);
      if (selection.reason.trim().length === 0)
        throw new Error(`Capability router returned no reason for ${selection.capabilityId}`);
      selectedReasons.set(selection.capabilityId, selection.reason);
    }
    const learningAttribution = routing.learningAttribution;
    if (routing.selections.length > 0 && learningAttribution === undefined)
      throw new Error("Capability router selected narrow capabilities without learning attribution");
    if (routing.selections.length === 0 && learningAttribution !== undefined)
      throw new Error("Capability router attributed learning without selecting a narrow capability");
    if (learningAttribution !== undefined && !selectedReasons.has(learningAttribution.capabilityId))
      throw new Error(
        `Capability router attributed learning to unselected capability ${learningAttribution.capabilityId}`,
      );
    if (learningAttribution !== undefined && learningAttribution.reason.trim().length === 0)
      throw new Error(
        `Capability router returned no learning-attribution reason for ${learningAttribution.capabilityId}`,
      );

    const selectedResolved = [
      ...general.map((item) => Object.freeze({ ...item, selectionReason: "protected genesis baseline" })),
      ...routing.selections.map((selection) => {
        const item = candidatesById.get(selection.capabilityId);
        if (!item)
          throw new Error(`Capability router selected inactive capability ${selection.capabilityId}`);
        return Object.freeze({ ...item, selectionReason: selection.reason });
      }),
    ];
    const selections: FrozenCapabilitySelection[] = [];
    for (const { reference, capability, revision, baseline, selectionReason } of selectedResolved) {
      const [promptModules, skills, tools, router] = await Promise.all([
        Promise.all(revision.promptModules.map(async (item) => await materialize(options.workspace, item))),
        Promise.all(revision.skills.map(async (item) => await materialize(options.workspace, item))),
        Promise.all(revision.tools.map(async (item) => await materialize(options.workspace, item))),
        materialize(options.workspace, revision.toolset.routerRevision),
      ]);
      selections.push(
        Object.freeze({
          capabilityId: capability.capabilityId,
          name: capability.name,
          scope: capability.scope,
          selectionReason,
          revision: reference,
          baseline,
          promptModules: Object.freeze(promptModules),
          skills: Object.freeze(skills),
          tools: Object.freeze(tools),
          router,
          permissionManifest: revision.permissionManifest,
        }),
      );
    }
    const promptLayers = selections.flatMap((selection) => [
      ...selection.promptModules.map((material) => material.content.trim()),
      ...selection.skills.map((material) => material.content.trim()),
    ]);
    const unsigned = Object.freeze({
      schemaVersion: 1 as const,
      planId: createPlanId(request.turnId),
      sessionId: request.sessionId,
      turnId: request.turnId,
      activationId: activation.activationId,
      activationRevision: activation.revision,
      selectedCapabilities: Object.freeze(selections),
      conversationHistory,
      renderedSystemPrompt: [request.baseSystemPrompt.trim(), ...promptLayers].filter(Boolean).join("\n\n"),
      provider: request.provider,
      model: request.model,
      thinkingLevel: request.thinkingLevel,
      permissionSnapshot: mergedPermissions(selections, options.basePermissionManifest),
      retrievalCitations: Object.freeze([...(request.retrievalCitations ?? [])]),
      routing: Object.freeze({
        strategyId: routing.strategyId,
        reason: routing.reason,
        ...(learningAttribution ? { learningAttribution: Object.freeze({ ...learningAttribution }) } : {}),
      }),
      createdAt: now(),
    });
    const plan = validateFrozenTurnPlan(
      Object.freeze({ ...unsigned, canonicalDigest: frozenTurnPlanDigest(unsigned) }),
    );
    return await options.protectedRuntime.activations.admitTurnPlan(plan);
  };

  return Object.freeze({ planAndAdmit });
}
