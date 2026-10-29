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
    const [router, instruction, skill] = await Promise.all([
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
    const learnedRef = capabilityRevisionRef(learned);
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
    const revisions = new Map<string, CapabilityRevision>([[learnedRef.capabilityRevisionId, learned]]);
    const resolver: TurnCapabilityResolver = Object.freeze({
      resolveCapability: async (capabilityId: string) => capabilities.get(capabilityId),
      resolveRevision: async (reference: CapabilityRevisionRef) =>
        revisions.get(reference.capabilityRevisionId),
    });
    const planner = createTurnIntelligencePlanner({
      workspace,
      protectedRuntime,
      capabilities: resolver,
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

    // Always-active guidance shares one allowance; a Capability past it is listed on demand instead.
    const longGuidance = `LONG ALWAYS GUIDANCE ${"x".repeat(7000)}`;
    const longInstruction = await publish("long-instruction", "capabilities/effects/long.md", longGuidance);
    const long = makeRevision(
      "long-always",
      "long-always-r1",
      [],
      [Object.freeze({ kind: "instruction" as const, material: longInstruction })],
    );
    const longRef = capabilityRevisionRef(long);
    revisions.set(longRef.capabilityRevisionId, long);
    capabilities.set("long-always", {
      capabilityId: "long-always",
      name: "Long always",
      scope: "general",
      intent: "Every turn.",
    });
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    await workspace.capabilities.create({
      definition: Object.freeze({
        capabilityId: "long-always",
        name: "Long always",
        description: "Too long to enter every prompt.",
        applicability: "Every turn.",
        createdAt: "2026-08-21T00:00:00.000Z",
      }),
      revision: Object.freeze({
        revision: long,
        reference: longRef,
        summary: "Long guidance.",
        rationale: "Fixture.",
        anticipatedEffect: "None.",
        createdAt: "2026-08-21T00:00:00.000Z",
      }),
      binding: Object.freeze({
        capabilityId: "long-always",
        revision: longRef,
        scope: Object.freeze({ kind: "global" as const }),
        activationMode: "always",
        state: "active",
      }),
    });
    const bounded = await planner.planAndAdmit({
      sessionId: "session-effects",
      turnId: "turn-effects-bounded",
      userInput: "Synthesize these sources again.",
      provider: "controlled",
      model: "controlled",
      thinkingLevel: "off",
      baseSystemPrompt: "BASE",
    });
    expect(bounded.renderedSystemPrompt).toContain("Keep answers evidence-dense.");
    expect(bounded.renderedSystemPrompt).not.toContain("LONG ALWAYS GUIDANCE");
    expect(bounded.selectedCapabilities.find((item) => item.capabilityId === "long-always")?.delivery).toBe(
      "on_demand",
    );
  });
});
