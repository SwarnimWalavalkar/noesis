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
  return `program:${effect.program.project.projectId}:${effect.program.mode}:${effect.program.name}`;
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
      effect.kind === "instruction" || effect.kind === "skill"
        ? effect.material
        : effect.program.definitionRevision,
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
  if (effects.filter((effect) => effect.kind === "program").length > 1)
    throw new Error("A Capability revision may attach at most one Program effect");
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
    if (effect.kind !== "program") continue;
    const { program } = effect;
    if (program.project.projectId !== input.project.projectId || program.project.root !== input.project.root)
      throw new Error(`Capability Program ${program.name} belongs to another project`);
    if (input.scope.kind !== "project")
      throw new Error(`Capability Program ${program.name} requires a project-scoped binding`);
    if (
      input.scope.project.projectId !== program.project.projectId ||
      input.scope.project.root !== program.project.root
    )
      throw new Error(`Capability Program ${program.name} does not match its binding project`);
  }
}
