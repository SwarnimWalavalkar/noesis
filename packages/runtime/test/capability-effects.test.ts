import { type CapabilityRevision, capabilityRevisionRef, type FileRevisionRef } from "@noesis/domain";
import { createWorkspaceStore } from "@noesis/workspace";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createWorkspaceRuntimeInternals } from "../../workspace/src/protected-runtime.ts";
import { createTurnIntelligencePlanner } from "../src/index.ts";
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
  test("puts always guidance in the prompt and lists relevant Capabilities on demand", async () => {
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
    const [instruction, relevantInstruction] = await Promise.all([
      publish("instruction", "capabilities/effects/instruction.md", "Keep answers evidence-dense."),
      publish(
        "relevant",
        "capabilities/effects/relevant.md",
        "RELEVANT BODY: synthesize sources in three passes.",
      ),
    ]);
    const makeRevision = (
      capabilityId: string,
      capabilityRevisionId: string,
      material: FileRevisionRef,
    ): CapabilityRevision =>
      Object.freeze({
        capabilityRevisionId,
        capabilityId,
        effects: Object.freeze([Object.freeze({ kind: "instruction" as const, material })]),
        evidenceRefs: Object.freeze([]),
      });
    const create = async (
      revision: CapabilityRevision,
      name: string,
      activationMode: "always" | "relevant",
    ): Promise<void> => {
      const reference = capabilityRevisionRef(revision);
      // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
      await workspace.capabilities.create({
        definition: Object.freeze({
          capabilityId: revision.capabilityId,
          name,
          description: `${name} fixture.`,
          applicability: "Requests that combine several sources.",
          createdAt: "2026-08-21T00:00:00.000Z",
        }),
        revision: Object.freeze({
          revision,
          reference,
          summary: `${name} guidance.`,
          rationale: "Fixture.",
          anticipatedEffect: "None.",
          createdAt: "2026-08-21T00:00:00.000Z",
        }),
        binding: Object.freeze({
          capabilityId: revision.capabilityId,
          revision: reference,
          scope: Object.freeze({ kind: "global" as const }),
          activationMode,
          state: "active",
        }),
      });
    };
    await create(
      makeRevision("evidence-synthesis", "evidence-synthesis-r1", instruction),
      "Evidence synthesis",
      "always",
    );
    await create(
      makeRevision("relevant-synthesis", "relevant-synthesis-r1", relevantInstruction),
      "Relevant synthesis",
      "relevant",
    );
    const planner = createTurnIntelligencePlanner({
      workspace,
      protectedRuntime,
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
    expect(plan.renderedSystemPrompt).not.toContain("RELEVANT BODY");
    expect(plan.selectedCapabilities.map((item) => [item.capabilityId, item.delivery])).toEqual([
      ["evidence-synthesis", "prompt"],
      ["relevant-synthesis", "on_demand"],
    ]);
    expect(
      plan.selectedCapabilities.find((item) => item.capabilityId === "relevant-synthesis")?.effects,
    ).toEqual([
      {
        kind: "instruction",
        material: {
          revision: relevantInstruction,
          content: "RELEVANT BODY: synthesize sources in three passes.",
        },
      },
    ]);

    // Always-active guidance shares one allowance; a Capability past it is listed on demand instead.
    const longGuidance = `LONG ALWAYS GUIDANCE ${"x".repeat(7000)}`;
    const longInstruction = await publish("long-instruction", "capabilities/effects/long.md", longGuidance);
    await create(makeRevision("long-always", "long-always-r1", longInstruction), "Long always", "always");
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
