import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { initializeNoesisConfig, resolveNoesisConfig } from "@noesis/config";
import { createPiAgentRuntime, createPiAgentRoleRunner } from "@noesis/runtime-pi";
import { createApplicationRuntimeComposition } from "../src/runtime-composition.ts";
import {
  CONTROLLED_PI_MODEL,
  CONTROLLED_PI_PROVIDER,
  createControlledPiModels,
} from "../../../packages/runtime-pi/test/support/controlled-pi-models.ts";

test.each([undefined, true, false])(
  "uses canonical notebook compaction with autoCompact=%s across restart",
  async (autoCompact) => {
    const home = await mkdtemp(join(tmpdir(), "noesis-compaction-acceptance-"));
    await initializeNoesisConfig(home, {
      schemaVersion: 1,
      agent: { provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL },
      context: autoCompact === undefined ? { tokenBudget: 50_000 } : { tokenBudget: 50_000, autoCompact },
      learning: { enabled: false },
    });
    const compactorInputs: string[] = [];
    const foregroundInputs: string[] = [];
    const largeInput = "user-history-".repeat(5_000);
    const largeAnswer = "assistant-history-".repeat(6_000);
    const controlled = createControlledPiModels({
      respond: (request) => {
        if (request.systemPrompt.includes("role: session_compactor")) {
          compactorInputs.push(request.lastUserText);
          return JSON.stringify({
            notes: [{ kind: "fact", text: `Continuity marker ${compactorInputs.length}.` }],
          });
        }
        if (request.systemPrompt.startsWith("Noesis protected role:"))
          return '{"observation":{"kind":"other","reason":"No learning."},"decision":"no_change","reason":"No change."}';
        foregroundInputs.push(JSON.stringify(request.context.messages));
        return request.lastUserText === largeInput ? largeAnswer : "Continued using the notebook.";
      },
    });
    const openRuntime = async () =>
      await createApplicationRuntimeComposition({
        config: await resolveNoesisConfig({ home, env: {} }),
        resolveModelContext: () => ({ contextWindow: 200_000, maxOutputTokens: 1_000 }),
        createAgent: (_tools, codeExecution) =>
          createPiAgentRuntime(home, controlled.models, { codeExecution }),
        createRoleRunner: (configurations) =>
          createPiAgentRoleRunner(home, controlled.models, configurations),
      });
    let runtime = await openRuntime();
    try {
      const trail = await runtime.startTrail({ title: "Notebook acceptance" });
      const first = await runtime.debug.runTurn(trail.trailId, largeInput);
      expect(first.output).toBe(largeAnswer);
      expect(compactorInputs).toHaveLength(0);
      const originalTranscript = await runtime.getTranscript(trail.trailId);

      if (autoCompact === false) {
        await expect(runtime.debug.runTurn(trail.trailId, "Continue.")).rejects.toThrow(
          "automatic compaction is disabled. Run /compact",
        );
        expect(compactorInputs).toHaveLength(0);
        expect(foregroundInputs).toHaveLength(1);
        expect(
          await runtime.debug.workspace.operational.contextCheckpoints.getActive(trail.trailId),
        ).toBeUndefined();
        expect(await runtime.getTranscript(trail.trailId)).toEqual(originalTranscript);
        await runtime.compact(trail.trailId);
      }

      const second = await runtime.debug.runTurn(trail.trailId, "Continue.");
      expect(compactorInputs).toHaveLength(1);
      const firstCheckpoint = second.frozenTurnPlan?.contextCheckpoint;
      expect(firstCheckpoint?.notes?.[0]?.summaryKind).toBe("note_delta");
      expect(firstCheckpoint?.summary).toContain("Continuity marker 1.");
      expect(foregroundInputs.at(-1)).toContain("SESSION CONTINUITY NOTEBOOK");
      expect(foregroundInputs.at(-1)).not.toContain(largeInput);
      expect(compactorInputs[0]).toContain(largeInput);
      expect(compactorInputs[0]).toContain(largeAnswer);

      await runtime.compact(trail.trailId);
      expect(compactorInputs).toHaveLength(2);
      expect(compactorInputs[1]).not.toContain("Continuity marker 1.");
      expect(compactorInputs[1]).not.toContain(largeInput);
      const lineage = await runtime.debug.workspace.operational.contextCheckpoints.lineage(
        (await runtime.debug.workspace.operational.contextCheckpoints.getActive(trail.trailId))
          ?.checkpointId ?? "",
      );
      expect(lineage).toHaveLength(2);
      expect(lineage[0]?.summary).toContain("Continuity marker 1.");
      const fullTranscript = await runtime.getTranscript(trail.trailId);
      expect(fullTranscript).toEqual(expect.arrayContaining([...originalTranscript]));
      await runtime.shutdown();

      runtime = await openRuntime();
      await runtime.resumeTrail(trail.trailId);
      expect(await runtime.getTranscript(trail.trailId)).toEqual(fullTranscript);
      const preview = await runtime.inspectContext?.(trail.trailId);
      expect(preview?.source).toBe("preview");
      const notebook = preview?.components.find((part) => part.label === "Session notebook");
      expect(notebook?.content).toContain("Continuity marker 1.");
      expect(notebook?.content).toContain("Continuity marker 2.");
      expect(compactorInputs).toHaveLength(2);
      const resumed = await runtime.debug.runTurn(trail.trailId, "Continue after restart.");
      expect(resumed.frozenTurnPlan?.contextCheckpoint?.summary).toBe(notebook?.content);
      expect(resumed.frozenTurnPlan?.contextCheckpoint?.notes).toHaveLength(2);
      expect(foregroundInputs.at(-1)).toContain("Continuity marker 1.");
      expect(foregroundInputs.at(-1)).toContain("Continuity marker 2.");
      expect(compactorInputs).toHaveLength(2);
    } finally {
      await runtime.shutdown();
      await rm(home, { recursive: true, force: true });
    }
  },
  30_000,
);
