import type { FrozenTurnPlan } from "@noesis/agent-types";
import type { SessionToolDefinition } from "@noesis/intelligence";

export type FrozenPlanMaterialKind = "skill" | "router" | "tool";

export interface FrozenPlanMaterialUse {
  readonly capabilityId: string;
  readonly kind: FrozenPlanMaterialKind;
  readonly revisionId: string;
  readonly contentDigest: string;
}

export interface FrozenSessionToolResolution {
  readonly planId: string;
  readonly canonicalDigest: string;
  /**
   * Every non-prompt material consumed while constructing this exact turn-scoped
   * registration. Runtime-pi rejects partial, stale, duplicate, or foreign coverage.
   */
  readonly consumedMaterials: readonly FrozenPlanMaterialUse[];
  readonly definitions: readonly SessionToolDefinition[];
}

export interface FrozenSessionToolResolver {
  readonly resolve: (plan: FrozenTurnPlan, signal: AbortSignal) => Promise<FrozenSessionToolResolution>;
}

function materialKey(material: FrozenPlanMaterialUse): string {
  return [material.capabilityId, material.kind, material.revisionId, material.contentDigest].join("\u0000");
}

export function frozenPlanMaterialUses(plan: FrozenTurnPlan): readonly FrozenPlanMaterialUse[] {
  return Object.freeze(
    plan.selectedCapabilities.flatMap((selection) => [
      ...selection.skills.map((material) =>
        Object.freeze({
          capabilityId: selection.capabilityId,
          kind: "skill" as const,
          revisionId: material.revision.revisionId,
          contentDigest: material.revision.contentDigest,
        }),
      ),
      Object.freeze({
        capabilityId: selection.capabilityId,
        kind: "router" as const,
        revisionId: selection.router.revision.revisionId,
        contentDigest: selection.router.revision.contentDigest,
      }),
      ...selection.tools.map((material) =>
        Object.freeze({
          capabilityId: selection.capabilityId,
          kind: "tool" as const,
          revisionId: material.revision.revisionId,
          contentDigest: material.revision.contentDigest,
        }),
      ),
    ]),
  );
}

export async function resolveFrozenSessionToolDefinitions(
  plan: FrozenTurnPlan,
  resolver: FrozenSessionToolResolver | undefined,
  signal: AbortSignal,
): Promise<readonly SessionToolDefinition[]> {
  const expected = frozenPlanMaterialUses(plan);
  if (!resolver) {
    if (expected.length > 0)
      throw new Error(
        `Frozen turn plan ${plan.planId} contains skill, router, or tool material without a turn-scoped session-tool resolver`,
      );
    return Object.freeze([]);
  }

  const resolution = await resolver.resolve(plan, signal);
  if (signal.aborted) return Object.freeze([]);
  if (resolution.planId !== plan.planId || resolution.canonicalDigest !== plan.canonicalDigest)
    throw new Error(`Session-tool resolution does not match frozen turn plan ${plan.planId}`);

  const expectedKeys = new Set(expected.map(materialKey));
  const consumedKeys = new Set<string>();
  for (const material of resolution.consumedMaterials) {
    const key = materialKey(material);
    if (consumedKeys.has(key))
      throw new Error(`Session-tool resolution duplicated frozen material ${material.revisionId}`);
    if (!expectedKeys.has(key))
      throw new Error(`Session-tool resolution consumed foreign frozen material ${material.revisionId}`);
    consumedKeys.add(key);
  }
  const missing = expected.filter((material) => !consumedKeys.has(materialKey(material)));
  if (missing.length > 0)
    throw new Error(
      `Session-tool resolution left frozen material unsupported: ${missing
        .map((material) => material.revisionId)
        .join(", ")}`,
    );

  return Object.freeze([...resolution.definitions]);
}
