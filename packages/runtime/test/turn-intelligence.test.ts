import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FrozenBaselineRef } from "@noesis/agent-types";
import {
  capabilityRevisionRef,
  type Capability,
  type CapabilityRevision,
  type CapabilityRevisionRef,
  type FileRevisionRef,
} from "@noesis/domain";
import { createWorkspaceStore, type NoesisWorkspaceStore } from "@noesis/workspace";
import { createWorkspaceRuntimeInternals } from "../../workspace/src/protected-runtime.ts";
import { afterEach, describe, expect, test } from "vitest";
import { createTurnIntelligencePlanner, type TurnCapabilityResolver } from "../src/index.ts";

const homes: { readonly root: string; readonly workspace: NoesisWorkspaceStore }[] = [];
const encoder = new TextEncoder();

afterEach(async () => {
  for (const item of homes.splice(0)) {
    item.workspace.close();
    await rm(item.root, { recursive: true, force: true });
  }
});

async function definition(
  workspace: NoesisWorkspaceStore,
  id: string,
  path: string,
  content: string,
): Promise<FileRevisionRef> {
  const published = await workspace.definitionPublications.publish({
    namespace: "turn-plan-fixture",
    definitionId: id,
    revision: 1,
    workingPath: path,
    bytes: encoder.encode(content),
    activity: Object.freeze({
      kind: "fixture.published",
      actor: Object.freeze({ actorId: "test", kind: "system" as const }),
    }),
  });
  if (!published.ok) throw new Error(published.error.message);
  return published.value.definitionRevision;
}

describe("turn intelligence", () => {
  test("admits exact immutable material while a narrow adaptation abstains from unrelated work", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-turn-plan-"));
    const workspace = await createWorkspaceStore(root);
    const protectedRuntime = createWorkspaceRuntimeInternals(workspace).protectedRuntime;
    homes.push({ root, workspace });
    const capabilities = new Map<string, Capability>();
    const revisions = new Map<string, CapabilityRevision>();
    const makeRevision = async (
      capability: Capability,
      promptContent: string,
    ): Promise<CapabilityRevision> => {
      const [prompt, skill, router] = await Promise.all([
        definition(
          workspace,
          `${capability.capabilityId}-prompt`,
          `prompts/${capability.capabilityId}.md`,
          promptContent,
        ),
        definition(
          workspace,
          `${capability.capabilityId}-skill`,
          `skills/${capability.capabilityId}.md`,
          `# ${capability.name}`,
        ),
        definition(
          workspace,
          `${capability.capabilityId}-router`,
          `capabilities/${capability.capabilityId}-router.json`,
          "{}",
        ),
      ]);
      return Object.freeze({
        capabilityRevisionId: `${capability.capabilityId}-v1`,
        capabilityId: capability.capabilityId,
        promptModules: Object.freeze([prompt]),
        skills: Object.freeze([skill]),
        tools: Object.freeze([]),
        toolset: Object.freeze({
          toolRevisionIds: Object.freeze([]),
          routerRevision: router,
          strategyId: "fixture",
        }),
        activationPolicy: Object.freeze({
          mode: "automatic_low_risk" as const,
          scope: capability.scope,
        }),
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
      });
    };
    const general = Object.freeze({
      capabilityId: "general",
      name: "General",
      scope: "general",
      intent: "baseline",
    });
    const research = Object.freeze({
      capabilityId: "research-brief",
      name: "Research brief",
      scope: "research brief",
      intent: "keep research briefs concise",
    });
    for (const [capability, prompt] of [
      [general, "GENERAL PROMPT"],
      [research, "NARROW RESEARCH PROMPT"],
    ] as const) {
      const revision = await makeRevision(capability, prompt);
      const reference = capabilityRevisionRef(revision);
      capabilities.set(capability.capabilityId, capability);
      revisions.set(reference.capabilityRevisionId, revision);
      const promptRevision = revision.promptModules[0];
      const skillRevision = revision.skills[0];
      if (!promptRevision || !skillRevision) throw new Error("Fixture revision is incomplete");
      await protectedRuntime.activations.bootstrapGenesis({
        capabilityRevision: reference,
        activeDefinitions: Object.freeze({
          [`${capability.capabilityId}:prompt`]: promptRevision,
          [`${capability.capabilityId}:skill`]: skillRevision,
          [`${capability.capabilityId}:router`]: revision.toolset.routerRevision,
        }),
      });
    }
    const resolver: TurnCapabilityResolver = Object.freeze({
      resolveCapability: async (capabilityId: string) => capabilities.get(capabilityId),
      resolveRevision: async (reference: CapabilityRevisionRef) =>
        revisions.get(reference.capabilityRevisionId),
      resolveBaseline: async (reference: CapabilityRevisionRef): Promise<FrozenBaselineRef> => {
        if (reference.capabilityId === "general") return Object.freeze({ kind: "genesis" });
        const baseline = revisions.get("general-v1");
        if (!baseline) throw new Error("Fixture baseline is missing");
        return Object.freeze({
          kind: "capability_revision",
          experimentId: "experiment-research-brief",
          revision: capabilityRevisionRef(baseline),
        });
      },
    });
    const planner = createTurnIntelligencePlanner({
      workspace,
      protectedRuntime,
      capabilities: resolver,
      basePermissionManifest: Object.freeze({
        effects: Object.freeze(["read", "execute"]),
        resourcePatterns: Object.freeze(["*"]),
        credentialRefs: Object.freeze([]),
      }),
      now: () => "2026-07-25T00:00:00.000Z",
    });

    const related = await planner.planAndAdmit({
      sessionId: "session-related",
      turnId: "turn-related",
      userInput: "Prepare a concise research brief",
      provider: "fake",
      model: "fake",
      thinkingLevel: "off",
      baseSystemPrompt: "BASE",
    });
    expect(related.selectedCapabilities.map((item) => item.capabilityId)).toEqual([
      "general",
      "research-brief",
    ]);
    expect(related.renderedSystemPrompt).toContain("NARROW RESEARCH PROMPT");
    expect(related.permissionSnapshot).toEqual({
      effects: ["read", "execute"],
      resourcePatterns: ["*"],
      credentialRefs: [],
    });
    expect(await protectedRuntime.activations.getTurnPlan("session-related", "turn-related")).toEqual(
      related,
    );

    const unrelated = await planner.planAndAdmit({
      sessionId: "session-unrelated",
      turnId: "turn-unrelated",
      userInput: "Explain monads with a tiny example",
      provider: "fake",
      model: "fake",
      thinkingLevel: "off",
      baseSystemPrompt: "BASE",
    });
    expect(unrelated.selectedCapabilities.map((item) => item.capabilityId)).toEqual(["general"]);
    expect(unrelated.renderedSystemPrompt).not.toContain("NARROW RESEARCH PROMPT");
  });
});
