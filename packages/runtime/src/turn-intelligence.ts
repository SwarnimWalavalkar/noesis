import {
  frozenTurnPlanDigest,
  validateFrozenTurnPlan,
  type AgentThinkingLevel,
  type FrozenBaselineRef,
  type FrozenCapabilitySelection,
  type FrozenRevisionMaterial,
  type FrozenTurnPlan,
} from "@noesis/agent-types";
import type {
  Capability,
  CapabilityRevision,
  CapabilityRevisionRef,
  EvidenceRef,
  FileRevisionRef,
} from "@noesis/domain";
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
  readonly retrievalCitations?: readonly EvidenceRef[];
}

export interface TurnIntelligencePlanner {
  readonly planAndAdmit: (request: TurnPlanningRequest) => Promise<FrozenTurnPlan>;
}

export interface TurnIntelligencePlannerOptions {
  readonly workspace: NoesisWorkspaceStore;
  readonly protectedRuntime: ProtectedWorkspaceRuntime;
  readonly capabilities: TurnCapabilityResolver;
  readonly now?: () => string;
  readonly createPlanId?: (turnId: string) => string;
}

const meaningfulScopeTokens = (scope: string): readonly string[] =>
  scope
    .toLocaleLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length >= 3 && token !== "scope");

export function capabilityAppliesToInput(capability: Pick<Capability, "scope">, input: string): boolean {
  const scope = capability.scope.trim().toLocaleLowerCase();
  if (scope === "general" || scope === "global" || scope === "*") return true;
  const tokens = meaningfulScopeTokens(scope);
  if (tokens.length === 0) return false;
  const normalizedInput = input.toLocaleLowerCase();
  return tokens.every((token) => normalizedInput.includes(token));
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
): FrozenTurnPlan["permissionSnapshot"] {
  return Object.freeze({
    effects: Object.freeze([
      ...new Set(selections.flatMap((selection) => selection.permissionManifest.effects)),
    ]),
    resourcePatterns: Object.freeze([
      ...new Set(selections.flatMap((selection) => selection.permissionManifest.resourcePatterns)),
    ]),
    credentialRefs: Object.freeze([
      ...new Set(selections.flatMap((selection) => selection.permissionManifest.credentialRefs)),
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
    const selections: FrozenCapabilitySelection[] = [];
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
      if (!capabilityAppliesToInput(capability, request.userInput)) continue;
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
          selectionReason:
            capability.scope === "general"
              ? "general baseline"
              : `input matched narrow scope ${capability.scope}`,
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
      renderedSystemPrompt: [request.baseSystemPrompt.trim(), ...promptLayers].filter(Boolean).join("\n\n"),
      provider: request.provider,
      model: request.model,
      thinkingLevel: request.thinkingLevel,
      permissionSnapshot: mergedPermissions(selections),
      retrievalCitations: Object.freeze([...(request.retrievalCitations ?? [])]),
      routing: Object.freeze({
        strategyId: "scope-match-v1",
        reason:
          selections.length === 0
            ? "No active capability matched this turn"
            : `Selected ${selections.length} scoped capability revision(s)`,
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
