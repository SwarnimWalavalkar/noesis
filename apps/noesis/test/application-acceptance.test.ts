import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNoesisConfig } from "@noesis/config";
import { createPiAgentRoleRunner, createPiAgentRuntime } from "@noesis/runtime-pi";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";
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
    const runtime = await createApplicationRuntimeComposition({
      config,
      createAgent: (_sessionTools, codeExecution, selfTools) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution, selfTools }),
      createRoleRunner: (configurations) =>
        createPiAgentRoleRunner(process.cwd(), controlled.models, configurations),
    });

    try {
      const genesis = await runtime.debug.adaptations.activations.current();
      expect(genesis).toBeDefined();
      if (!genesis) return;

      const correctionSession = await runtime.startTrail({ title: "Learning correction" });
      await runtime.debug.runTurn(
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
      const related = await runtime.debug.runTurn(
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
      const relatedSearchCall = (
        await runtime.debug.workspace.operational.toolCalls.listForSession(relatedSession.trailId)
      ).find((toolCall) => toolCall.toolName === "history.search_sessions");
      const rankedSearch = z
        .object({
          output: z.object({
            hits: z
              .array(
                z.object({
                  fragmentId: z.string(),
                  rerankReason: z.string(),
                }),
              )
              .min(2),
            fragments: z
              .array(
                z.object({
                  id: z.string(),
                  citation: z.object({
                    documentId: z.string(),
                    contentDigest: z.string().regex(/^[a-f0-9]{64}$/u),
                  }),
                }),
              )
              .min(2),
          }),
        })
        .parse(relatedSearchCall?.response).output;
      const citationsByFragmentId = new Map(
        rankedSearch.fragments.map((fragment) => [fragment.id, fragment.citation]),
      );
      let previousRank = 0;
      for (const hit of rankedSearch.hits) {
        const citation = citationsByFragmentId.get(hit.fragmentId);
        expect(citation).toBeDefined();
        const reason = z
          .string()
          .regex(/^Controlled reverse rank \d+ for [a-f0-9]{64}\.$/u)
          .parse(hit.rerankReason);
        expect(reason).toContain(`for ${citation?.documentId}.`);
        const rank = Number.parseInt(reason.match(/rank (\d+)/u)?.[1] ?? "0", 10);
        expect(rank).toBeGreaterThan(previousRank);
        previousRank = rank;
      }

      const unrelatedSession = await runtime.startTrail({ title: "Unrelated return" });
      const unrelated = await runtime.debug.runTurn(unrelatedSession.trailId, "Draft a meeting agenda.");
      expect(
        unrelated.frozenTurnPlan?.selectedCapabilities.some(
          (selection) => selection.capabilityId === candidateRevision.capabilityId,
        ),
      ).toBe(false);

      for (const input of [
        "No, revise this research brief and keep evidence distinct from inference.",
        "No, undo that adaptation for this research brief.",
      ])
        await runtime.debug.runTurn(relatedSession.trailId, input);
      await runtime.controlPlane.idle();

      const outcome = await runtime.debug.adaptations.feedback.getOutcome(experiment.experimentId);
      const origin = activated
        ? await runtime.debug.adaptations.feedback.operationForActivation(activated.activationId)
        : undefined;
      expect(origin?.binding.experimentId).toBe(experiment.experimentId);
      expect(outcome).toMatchObject({
        decision: "revert",
        restoreSourceActivationId: origin?.previousActivationId,
        restoredActivationId: expect.any(String),
      });
      expect(
        await runtime.debug.workspace.research.experiments.getExperiment(experiment.experimentId),
      ).toMatchObject({
        status: "completed",
        outcome: "revert",
      });

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
