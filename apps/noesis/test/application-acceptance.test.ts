import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNoesisConfig } from "@noesis/config";
import { createNoesisRuntime } from "@noesis/runtime";
import { createPiAgentRoleRunner, createPiAgentRuntime } from "@noesis/runtime-pi";
import { afterEach, describe, expect, test } from "vitest";
import {
  CONTROLLED_PI_MODEL,
  CONTROLLED_PI_PROVIDER,
  createControlledPiModels,
} from "../../../packages/runtime-pi/test/support/controlled-pi-models.ts";
import { createApplicationRuntimeComposition } from "../src/runtime-composition.ts";
import { researchLoopControlledResponse } from "./support/research-loop-controlled-response.ts";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("credential-free Pi application acceptance", () => {
  test("activates, scopes, serves, and reverts exact durable revisions through AgentHarness", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-controlled-pi-loop-"));
    homes.push(home);
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const controlled = createControlledPiModels({
      respond: researchLoopControlledResponse,
      responseBudget: 200,
    });
    const foreground = await createNoesisRuntime(
      home,
      createPiAgentRuntime(process.cwd(), controlled.models),
      config.agent,
    );
    const runtime = await createApplicationRuntimeComposition({
      config,
      runtime: foreground,
      createAgent: (sessionTools) => createPiAgentRuntime(process.cwd(), controlled.models, { sessionTools }),
      createRoleRunner: (configurations) =>
        createPiAgentRoleRunner(process.cwd(), controlled.models, configurations),
    });

    try {
      const genesis = await runtime.debug.adaptations.activations.current();
      expect(genesis).toBeDefined();
      if (!genesis) return;

      const correctionSession = await runtime.startTrail({ title: "Learning correction" });
      await runtime.runTurn(
        correctionSession.trailId,
        "No, for every research brief separate cited evidence from inference.",
      );
      await runtime.controlPlane.idle();
      const experiments = await runtime.debug.workspace.research.experiments.listExperiments({
        limit: 100,
      });
      const experiment = experiments.find(
        (candidate) =>
          candidate.status === "observing" &&
          candidate.scope === "research brief" &&
          candidate.activatedRevision !== undefined,
      );
      expect(experiment?.activatedRevision).toBeDefined();
      if (!experiment?.activatedRevision) return;
      const candidateRevision = experiment.activatedRevision;

      const activated = await runtime.debug.adaptations.activations.current();
      expect(activated?.activeCapabilityRevisions[candidateRevision.capabilityId]).toEqual(candidateRevision);
      expect(experiment.preflightRef).toBeDefined();

      const relatedSession = await runtime.startTrail({ title: "Related return" });
      const related = await runtime.runTurn(
        relatedSession.trailId,
        "Prepare a research brief about continual learning.",
      );
      const relatedSelection = related.frozenTurnPlan?.selectedCapabilities.find(
        (selection) => selection.capabilityId === candidateRevision.capabilityId,
      );
      expect(relatedSelection?.revision).toEqual(candidateRevision);
      expect(related.frozenTurnPlan?.canonicalDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(related.output).toBe(
        "Served immutable research-brief behavior through the pinned search_sessions tool.",
      );

      const unrelatedSession = await runtime.startTrail({ title: "Unrelated return" });
      const unrelated = await runtime.runTurn(unrelatedSession.trailId, "Draft a meeting agenda.");
      expect(
        unrelated.frozenTurnPlan?.selectedCapabilities.some(
          (selection) => selection.capabilityId === candidateRevision.capabilityId,
        ),
      ).toBe(false);

      for (const input of [
        "No, revise this research brief and keep evidence distinct from inference.",
        "No, undo that adaptation for this research brief.",
      ])
        await runtime.runTurn(relatedSession.trailId, input);
      await runtime.controlPlane.idle();

      const outcome = await runtime.debug.adaptations.feedback.getOutcome(experiment.experimentId);
      expect(outcome).toMatchObject({
        decision: "revert",
        restoredActivationId: expect.any(String),
      });
      const restored = await runtime.debug.adaptations.activations.current();
      expect(restored?.activeCapabilityRevisions).toEqual(genesis.activeCapabilityRevisions);
      expect(restored?.activeCapabilityRevisions[candidateRevision.capabilityId]).toBeUndefined();

      const storedOutcomes = await runtime.debug.workspace.operational.outcomes.listForSession(
        relatedSession.trailId,
      );
      expect(storedOutcomes).toHaveLength(3);
      expect(controlled.provider.state.callCount).toBeGreaterThan(6);
    } finally {
      await runtime.shutdown();
    }
  }, 30_000);
});
