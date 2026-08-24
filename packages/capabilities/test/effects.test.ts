import type { CapabilityEffect, CapabilityRevision, FileRevisionRef, ProjectRef } from "@noesis/domain";
import {
  createConditionalObject,
  CapabilityDefinitionSchema,
  CapabilityRevisionSchema,
  capabilityRevisionRef,
} from "@noesis/domain";
import { describe, expect, test } from "vitest";
import {
  assertCapabilityEffectsEligible,
  capabilityEffectKinds,
  capabilityEffectReferences,
  validateCapabilityEffects,
} from "../src/index.ts";
const project: ProjectRef = Object.freeze({ projectId: "project-effects", root: "/workspace/effects" });
function revisionRef(name: string, digestCharacter: string): FileRevisionRef {
  return Object.freeze({
    kind: "file_revision",
    revisionId: `${name}-revision`,
    workingPath: `capabilities/${name}`,
    snapshotPath: `.noesis/revisions/${name}`,
    contentDigest: digestCharacter.repeat(64),
  });
}
function revision(effects?: readonly CapabilityEffect[]): CapabilityRevision {
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  return Object.freeze(
    createConditionalObject({
      capabilityRevisionId: "capability-effects-r1",
      capabilityId: "capability-effects",
    } as const)
      .addOptional(effects ? { effects } : undefined)
      .add({
        promptModules: Object.freeze([]),
        skills: Object.freeze([]),
        tools: Object.freeze([]),
        toolset: Object.freeze({
          toolRevisionIds: Object.freeze([]),
          routerRevision: revisionRef("router.json", "a"),
          strategyId: "semantic-capability-router-v1",
        }),
        activationPolicy: Object.freeze({ mode: "automatic_low_risk", scope: "general" }),
        permissionManifest: Object.freeze({
          effects: Object.freeze([]),
          resourcePatterns: Object.freeze([]),
          credentialRefs: Object.freeze([]),
        }),
        evidenceRefs: Object.freeze([]),
        sourceEvaluationDefinitions: Object.freeze([]),
        requestedPermissionDelta: Object.freeze({
          addedEffects: Object.freeze([]),
          widenedResources: Object.freeze([]),
          addedCredentialRefs: Object.freeze([]),
        }),
      } as const)
      .finish(),
  );
}
describe("Capability effects", () => {
  test("keeps legacy revisions readable while current definitions need no mechanism kind", () => {
    expect(CapabilityRevisionSchema.parse(revision()).effects).toBeUndefined();
    expect(
      CapabilityDefinitionSchema.parse({
        capabilityId: "capability-effects",
        name: "Reusable evidence synthesis",
        description: "Synthesizes evidence into a reusable result.",
        applicability: "Evidence-heavy synthesis work.",
        createdAt: "2026-08-21T00:00:00.000Z",
      }).kind,
    ).toBeUndefined();
  });
  test("binds every exact effect material into revision identity", () => {
    const first = revision([
      { kind: "instruction", material: revisionRef("instruction.md", "b") },
      {
        kind: "skill",
        name: "evidence-synthesis",
        description: "Synthesize evidence progressively.",
        material: revisionRef("SKILL.md", "c"),
      },
      {
        kind: "program",
        program: {
          mode: "workflow",
          name: "evidence-synthesis",
          project,
          definitionRevision: revisionRef("program.json", "d"),
        },
      },
    ]);
    const changed = revision([
      { kind: "instruction", material: revisionRef("instruction.md", "e") },
      ...(first.effects?.slice(1) ?? []),
    ]);
    expect(capabilityEffectKinds(first)).toEqual(["instruction", "skill", "program"]);
    expect(capabilityEffectReferences(first)).toHaveLength(3);
    expect(capabilityRevisionRef(first).bundleDigest).not.toBe(capabilityRevisionRef(changed).bundleDigest);
  });
  test("rejects duplicate effects and project programs outside their exact project binding", () => {
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const program = Object.freeze({
      kind: "program" as const,
      program: Object.freeze({
        mode: "workflow" as const,
        name: "evidence-synthesis",
        project,
        definitionRevision: revisionRef("program.json", "d"),
      }),
    });
    expect(() => validateCapabilityEffects([program, program])).toThrow("repeats effect");
    expect(() =>
      validateCapabilityEffects([
        program,
        {
          kind: "program",
          program: {
            mode: "script",
            name: "second-program",
            project,
            definitionRevision: revisionRef("second-program.json", "e"),
          },
        },
      ]),
    ).toThrow("at most one Program");
    expect(() =>
      assertCapabilityEffectsEligible({ effects: [program], scope: { kind: "global" }, project }),
    ).toThrow("project-scoped");
    expect(() =>
      assertCapabilityEffectsEligible({
        effects: [program],
        scope: { kind: "project", project },
        project,
      }),
    ).not.toThrow();
  });
});
