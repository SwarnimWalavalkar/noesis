import type {
  CapabilityEffect,
  CapabilityEffectKind,
  CapabilityRevision,
  CapabilityScope,
  FileRevisionRef,
  ProjectRef,
} from "@noesis/domain";

function effectIdentity(effect: CapabilityEffect): string {
  if (effect.kind === "instruction") return `instruction:${effect.material.revisionId}`;
  if (effect.kind === "skill") return `skill:${effect.name}`;
  return `${effect.kind}:${effect.project.projectId}:${effect.name}`;
}

/** Current effects only. Legacy bundle arrays remain available to their historical consumers. */
export function capabilityEffects(revision: CapabilityRevision): readonly CapabilityEffect[] {
  return Object.freeze([...(revision.effects ?? [])]);
}

export function capabilityEffectKinds(revision: CapabilityRevision): readonly CapabilityEffectKind[] {
  return Object.freeze([...new Set(capabilityEffects(revision).map((effect) => effect.kind))]);
}

export function capabilityEffectReferences(revision: CapabilityRevision): readonly FileRevisionRef[] {
  return Object.freeze(
    capabilityEffects(revision).map((effect) =>
      effect.kind === "instruction" || effect.kind === "skill" ? effect.material : effect.definitionRevision,
    ),
  );
}

export function validateCapabilityEffects(effects: readonly CapabilityEffect[]): readonly CapabilityEffect[] {
  if (effects.length === 0) throw new Error("A Capability revision must produce at least one effect");
  const identities = new Set<string>();
  for (const effect of effects) {
    const identity = effectIdentity(effect);
    if (identities.has(identity)) throw new Error(`Capability revision repeats effect ${identity}`);
    identities.add(identity);
  }
  return Object.freeze([...effects]);
}

/**
 * Project programs keep their existing project authority. A Capability may be global only when
 * every exact effect is portable; project programs therefore require a matching project binding.
 */
export function assertCapabilityEffectsEligible(input: {
  readonly effects: readonly CapabilityEffect[];
  readonly scope: CapabilityScope;
  readonly project: ProjectRef;
}): void {
  for (const effect of input.effects) {
    if (effect.kind !== "script" && effect.kind !== "workflow") continue;
    if (effect.project.projectId !== input.project.projectId || effect.project.root !== input.project.root)
      throw new Error(`Capability ${effect.kind} ${effect.name} belongs to another project`);
    if (input.scope.kind !== "project")
      throw new Error(`Capability ${effect.kind} ${effect.name} requires a project-scoped binding`);
    if (
      input.scope.project.projectId !== effect.project.projectId ||
      input.scope.project.root !== effect.project.root
    )
      throw new Error(`Capability ${effect.kind} ${effect.name} does not match its binding project`);
  }
}
