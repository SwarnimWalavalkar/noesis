import type { FrozenBaselineRef } from "@noesis/agent-types";
import {
  createConditionalObject,
  type Capability,
  type CapabilityRevision,
  type CapabilityRevisionRef,
  capabilityRevisionRef,
  type FileRevisionRef,
} from "@noesis/domain";
import { createWorkspaceStore } from "@noesis/workspace";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createWorkspaceRuntimeInternals } from "../../workspace/src/protected-runtime.ts";
import { createTurnIntelligencePlanner, type TurnCapabilityResolver } from "../src/index.ts";
const opened: {
  readonly root: string;
  readonly close: () => void;
}[] = [];
const encoder = new TextEncoder();
const project = Object.freeze({ projectId: "project-effects", root: "/workspace/effects" });
afterEach(async () => {
  for (const item of opened.splice(0)) {
    item.close();
    await rm(item.root, { recursive: true, force: true });
  }
});
describe("effects-first Capability turn planning", () => {
  test("injects instruction effects, freezes skill effects, and keeps skill bodies out of the prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-turn-effects-"));
    const workspace = await createWorkspaceStore(root);
    opened.push({ root, close: workspace.close });
    const protectedRuntime = createWorkspaceRuntimeInternals(workspace).protectedRuntime;
    await workspace.operational.sessions.put({
      sessionId: "session-effects",
      title: "Capability effects",
      status: "idle",
      provider: "controlled",
      model: "controlled",
      runtime: "pi",
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:00:00.000Z",
      metadata: Object.freeze({}),
    });
    const publish = async (id: string, path: string, content: string): Promise<FileRevisionRef> => {
      // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
      const result = await workspace.definitionPublications.publish({
        namespace: "capability-effect-fixture",
        definitionId: id,
        revision: 1,
        workingPath: path,
        bytes: encoder.encode(content),
        activity: Object.freeze({
          kind: "fixture.published",
          actor: Object.freeze({ actorId: "test", kind: "system" as const }),
        }),
      });
      if (!result.ok) throw new Error(result.error.message);
      return result.value.definitionRevision;
    };
    const [genesisPrompt, router, instruction, skill] = await Promise.all([
      publish("genesis-prompt", "prompts/genesis.md", "GENESIS"),
      publish("router", "capabilities/router.json", "{}"),
      publish("instruction", "capabilities/effects/instruction.md", "Keep answers evidence-dense."),
      publish(
        "skill",
        "capabilities/effects/skills/evidence-synthesis/SKILL.md",
        "PRIVATE SKILL BODY: synthesize sources in three passes.",
      ),
    ]);
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const makeRevision = (
      capabilityId: string,
      capabilityRevisionId: string,
      promptModules: readonly FileRevisionRef[],
      effects?: CapabilityRevision["effects"],
    ): CapabilityRevision =>
      Object.freeze(
        createConditionalObject({
          capabilityRevisionId,
          capabilityId,
        } as const)
          .addOptional(effects ? { effects } : undefined)
          .add({
            promptModules: Object.freeze([...promptModules]),
            skills: Object.freeze([]),
            tools: Object.freeze([]),
            toolset: Object.freeze({
              toolRevisionIds: Object.freeze([]),
              routerRevision: router,
              strategyId: "semantic-capability-router-v1",
            }),
            activationPolicy: Object.freeze({ mode: "automatic_low_risk" as const, scope: "general" }),
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
    const genesis = makeRevision("general", "general-r1", [genesisPrompt]);
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const learned = makeRevision(
      "evidence-synthesis",
      "evidence-synthesis-r1",
      [],
      [
        Object.freeze({ kind: "instruction" as const, material: instruction }),
        Object.freeze({
          kind: "skill" as const,
          name: "evidence-synthesis",
          description: "Synthesize multiple sources into one answer.",
          material: skill,
        }),
      ],
    );
    const genesisRef = capabilityRevisionRef(genesis);
    const learnedRef = capabilityRevisionRef(learned);
    await protectedRuntime.activations.bootstrapGenesis({
      capabilityRevision: genesisRef,
      activeDefinitions: Object.freeze({ prompt: genesisPrompt, router }),
    });
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    await workspace.capabilities.create({
      definition: Object.freeze({
        capabilityId: "evidence-synthesis",
        name: "Evidence synthesis",
        description: "Produce concise, evidence-dense synthesis.",
        applicability: "Requests that combine several sources.",
        createdAt: "2026-08-21T00:00:00.000Z",
      }),
      revision: Object.freeze({
        revision: learned,
        reference: learnedRef,
        summary: "Add concise synthesis guidance and a progressive skill.",
        rationale: "The behavior is repeatedly useful.",
        anticipatedEffect: "Synthesis is concise without losing evidence.",
        createdAt: "2026-08-21T00:00:00.000Z",
      }),
      binding: Object.freeze({
        capabilityId: "evidence-synthesis",
        revision: learnedRef,
        scope: Object.freeze({ kind: "global" as const }),
        activationMode: "always",
        state: "active",
      }),
    });
    const capabilities = new Map<string, Capability>([
      ["general", { capabilityId: "general", name: "General", scope: "general", intent: "baseline" }],
      [
        "evidence-synthesis",
        {
          capabilityId: "evidence-synthesis",
          name: "Evidence synthesis",
          scope: "general",
          intent: "Requests that combine several sources.",
        },
      ],
    ]);
    const revisions = new Map<string, CapabilityRevision>([
      [genesisRef.capabilityRevisionId, genesis],
      [learnedRef.capabilityRevisionId, learned],
    ]);
    const resolver: TurnCapabilityResolver = Object.freeze({
      resolveCapability: async (capabilityId: string) => capabilities.get(capabilityId),
      resolveRevision: async (reference: CapabilityRevisionRef) =>
        revisions.get(reference.capabilityRevisionId),
      resolveBaseline: async (): Promise<FrozenBaselineRef> => Object.freeze({ kind: "unknown_legacy" }),
    });
    const planner = createTurnIntelligencePlanner({
      workspace,
      protectedRuntime,
      capabilities: resolver,
      capabilityRouter: Object.freeze({
        route: async () =>
          Object.freeze({
            strategyId: "semantic-capability-router-v1",
            reason: "No relevance candidates remain after always-active selection.",
            selections: Object.freeze([]),
          }),
      }),
      project,
      now: () => "2026-08-21T00:01:00.000Z",
    });
    const plan = await planner.planAndAdmit({
      sessionId: "session-effects",
      turnId: "turn-effects",
      userInput: "Synthesize these sources.",
      provider: "controlled",
      model: "controlled",
      thinkingLevel: "off",
      baseSystemPrompt: "BASE",
    });
    expect(plan.renderedSystemPrompt).toContain("Keep answers evidence-dense.");
    expect(plan.renderedSystemPrompt).not.toContain("PRIVATE SKILL BODY");
    expect(
      plan.selectedCapabilities.find((item) => item.capabilityId === "evidence-synthesis")?.effects,
    ).toEqual([
      { kind: "instruction", material: { revision: instruction, content: "Keep answers evidence-dense." } },
      {
        kind: "skill",
        name: "evidence-synthesis",
        description: "Synthesize multiple sources into one answer.",
        material: {
          revision: skill,
          content: "PRIVATE SKILL BODY: synthesize sources in three passes.",
        },
      },
    ]);
  });
});
