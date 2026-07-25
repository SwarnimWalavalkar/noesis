import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNoesisConfig } from "@noesis/config";
import { createNoesisRuntime } from "@noesis/runtime";
import { createFakeAgentRoleRunner, createFakeAgentRuntime } from "@noesis/runtime-pi";
import { createWorkspaceStore } from "@noesis/workspace";
import { createWorkspaceRuntimeInternals } from "../../../packages/workspace/src/protected-runtime.ts";
import type { AgentRuntimeEvent, AgentRuntimeRequest, NoesisAgentRuntime } from "@noesis/agent-types";
import { afterEach, describe, expect, test } from "vitest";
import { createApplicationRuntimeComposition } from "../src/runtime-composition.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("apps/noesis production control-plane composition", () => {
  test("a real app turn pins admission and records exact durable operational work", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-control-plane-"));
    roots.push(home);
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ runtime: "fake", provider: "fake", model: "noesis-fake-1" }),
    });
    const fake = createFakeAgentRuntime();
    const requests: AgentRuntimeRequest[] = [];
    const capturingAgent: NoesisAgentRuntime = Object.freeze({
      ...fake,
      run: async (request: AgentRuntimeRequest, emit: (event: AgentRuntimeEvent) => void) => {
        requests.push(request);
        return await fake.run(request, emit);
      },
    });
    const legacy = await createNoesisRuntime(home, capturingAgent, config.agent);
    const legacyEventCount = legacy.ledger.readAll().length;
    const seenConfigurations: unknown[] = [];
    const runtime = await createApplicationRuntimeComposition({
      config,
      runtime: legacy,
      createRoleRunner: (configurations) => {
        seenConfigurations.push(...configurations);
        return createFakeAgentRoleRunner({
          variants: configurations,
          respond: () => {
            throw new Error("A fresh unactivated workspace must not invoke a research role");
          },
        });
      },
    });

    const trail = await runtime.startTrail({ title: "Composition acceptance" });
    const result = await runtime.runTurn(trail.trailId, "Record this ordinary turn");
    expect(result.outcome).toBe("completed");
    expect(legacy.ledger.readAll()).toHaveLength(legacyEventCount);
    expect(config.schemaVersion).toBe(1);
    expect(await runtime.debug.workspace.operational.sessions.get(trail.trailId)).toMatchObject({
      sessionId: trail.trailId,
      runtime: "fake",
    });
    const messages = await runtime.debug.workspace.operational.messages.listForSession(trail.trailId);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    const outcomes = await runtime.debug.workspace.operational.outcomes.listForSession(trail.trailId);
    expect(outcomes).toMatchObject([{ status: "accepted", summary: result.output }]);
    const turnId = String(messages[0]?.metadata["turnId"]);
    expect(await runtime.debug.workspace.operational.foregroundTurns.get(turnId)).toMatchObject({
      sessionId: trail.trailId,
      status: "completed",
      outcomeId: `${turnId}:outcome`,
    });
    const pin = await runtime.debug.adaptations.activations.getTurnPin(trail.trailId, turnId);
    const storedPlan = await runtime.debug.adaptations.activations.getTurnPlan(trail.trailId, turnId);
    const deliveredPlan = requests[0]?.frozenTurnPlan;
    expect(pin).toMatchObject({
      activationId: "activation_genesis",
      activeCapabilityRevisions: {
        "general-collaboration": { capabilityRevisionId: "general-collaboration-genesis-v1" },
      },
    });
    expect(deliveredPlan).toEqual(storedPlan);
    expect(result.frozenTurnPlan).toEqual(storedPlan);
    expect(requests[0]?.systemPrompt).toBe(storedPlan?.renderedSystemPrompt);
    expect(storedPlan).toMatchObject({
      schemaVersion: 1,
      sessionId: trail.trailId,
      turnId,
      selectedCapabilities: [
        {
          capabilityId: "general-collaboration",
          baseline: { kind: "genesis" },
          promptModules: [
            {
              content: expect.stringContaining("thinking-and-creation partner"),
            },
          ],
          tools: [],
        },
      ],
    });
    expect(await runtime.debug.workspace.definitionMetadata.listCurrent("runtime_role")).toHaveLength(7);
    expect(JSON.stringify(seenConfigurations)).not.toMatch(
      /protectedActivations|protectedFeedback|authorityBoundary|restorationHandle/iu,
    );
    const activeBeforeLegacyNoise = await runtime.debug.adaptations.activations.current();
    await legacy.ledger.append({
      type: "capability.promoted",
      principal: "promoter",
      payload: { capabilityId: "legacy-only", version: 99 },
    });
    expect(await runtime.debug.adaptations.activations.current()).toEqual(activeBeforeLegacyNoise);
    expect("promoteCandidate" in runtime).toBe(false);

    await runtime.shutdown();
    const reopened = await createWorkspaceStore(home);
    const reopenedProtected = createWorkspaceRuntimeInternals(reopened).protectedRuntime;
    expect(await reopened.operational.messages.listForSession(trail.trailId)).toHaveLength(2);
    expect(await reopened.operational.outcomes.listForSession(trail.trailId)).toHaveLength(1);
    expect(await reopenedProtected.activations.getTurnPin(trail.trailId, turnId)).toBeDefined();
    expect(await reopenedProtected.activations.getTurnPlan(trail.trailId, turnId)).toEqual(storedPlan);
    reopened.close();
  });

  test("a first-turn correction on a fresh home reflects against the immutable genesis baseline", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-genesis-correction-"));
    roots.push(home);
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ runtime: "fake", provider: "fake", model: "noesis-fake-1" }),
    });
    const legacy = await createNoesisRuntime(home, createFakeAgentRuntime(), config.agent);
    let reflectorRuns = 0;
    const runtime = await createApplicationRuntimeComposition({
      config,
      runtime: legacy,
      createRoleRunner: (configurations) =>
        createFakeAgentRoleRunner({
          variants: configurations,
          respond: (request) => {
            if (!request.systemPrompt.includes("role: reflector"))
              throw new Error("Only reflection should run for a no-change fixture");
            reflectorRuns += 1;
            return Object.freeze({
              text: JSON.stringify({
                decision: "no_change",
                reason: "The single correction is useful evidence but not yet a durable adaptation.",
              }),
            });
          },
        }),
    });

    const trail = await runtime.startTrail({ title: "First correction" });
    const result = await runtime.runTurn(trail.trailId, "Actually, keep this research brief concise.");
    expect(result.frozenTurnPlan?.selectedCapabilities).toMatchObject([
      {
        capabilityId: "general-collaboration",
        baseline: { kind: "genesis" },
      },
    ]);
    await runtime.controlPlane.idle();
    expect(reflectorRuns).toBe(1);
    const outcomes = await runtime.debug.workspace.operational.outcomes.listForSession(trail.trailId);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ status: "corrected" });
    await runtime.shutdown();
  });
});
