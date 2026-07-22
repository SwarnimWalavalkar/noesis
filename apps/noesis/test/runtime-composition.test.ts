import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNoesisConfig } from "@noesis/config";
import { createNoesisRuntime } from "@noesis/runtime";
import { createFakeAgentRoleRunner, createFakeAgentRuntime } from "@noesis/runtime-pi";
import { createWorkspaceStore } from "@noesis/workspace";
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
    const legacy = await createNoesisRuntime(home, createFakeAgentRuntime(), config.agent);
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
    expect(config.schemaVersion).toBe(1);
    expect(await runtime.workspace.operational.sessions.get(trail.trailId)).toMatchObject({
      sessionId: trail.trailId,
      runtime: "fake",
    });
    const messages = await runtime.workspace.operational.messages.listForSession(trail.trailId);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    const outcomes = await runtime.workspace.operational.outcomes.listForSession(trail.trailId);
    expect(outcomes).toMatchObject([{ status: "accepted", summary: result.output }]);
    const turnId = String(messages[0]?.metadata["turnId"]);
    expect(await runtime.workspace.protectedActivations.getTurnPin(trail.trailId, turnId)).toMatchObject({
      activationId: "activation_genesis",
      activeCapabilityRevisions: {},
    });
    expect(await runtime.workspace.definitionMetadata.listCurrent("runtime_role")).toHaveLength(7);
    expect(JSON.stringify(seenConfigurations)).not.toMatch(
      /protectedActivations|protectedFeedback|authorityBoundary|restorationHandle/iu,
    );

    await runtime.shutdown();
    const reopened = await createWorkspaceStore(home);
    expect(await reopened.operational.messages.listForSession(trail.trailId)).toHaveLength(2);
    expect(await reopened.operational.outcomes.listForSession(trail.trailId)).toHaveLength(1);
    expect(await reopened.protectedActivations.getTurnPin(trail.trailId, turnId)).toBeDefined();
    reopened.close();
  });
});
