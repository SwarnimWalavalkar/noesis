import { createConditionalObject } from "@noesis/domain";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FrozenTurnPlan } from "@noesis/agent-types";
import { compileContext } from "@noesis/context";
import type { CapabilityRevisionRef } from "@noesis/domain";
import {
  createDeterministicEmbeddingPort,
  createDeterministicRerankPort,
  createHistoryPort,
  createSessionSearchTools,
  SESSION_RETRIEVAL_STRATEGIES,
} from "@noesis/intelligence";
import { createWorkspaceStore, type NoesisWorkspaceStore } from "@noesis/workspace";
import { afterEach, describe, expect, test } from "vitest";
import { createTurnSettlement } from "../src/index.ts";
const homes: {
  readonly root: string;
  readonly workspace: NoesisWorkspaceStore;
}[] = [];
afterEach(async () => {
  for (const item of homes.splice(0)) {
    item.workspace.close();
    await rm(item.root, { recursive: true, force: true });
  }
});
const revisionRef = (capabilityId: string): CapabilityRevisionRef =>
  Object.freeze({
    kind: "capability_revision",
    capabilityId,
    capabilityRevisionId: `${capabilityId}-v1`,
    bundleDigest: capabilityId === "general" ? "a".repeat(64) : "b".repeat(64),
  });
function turnPlan(
  sessionId: string,
  turnId: string,
  selections: readonly {
    readonly capabilityId: string;
    readonly name: string;
    readonly scope: string;
  }[],
  learningAttribution?: {
    readonly capabilityId: string;
    readonly reason: string;
  },
): FrozenTurnPlan {
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  return Object.freeze({
    schemaVersion: 1,
    planId: `plan-${turnId}`,
    sessionId,
    turnId,
    project: Object.freeze({ projectId: "project_test", root: "/workspace/noesis" }),
    activationId: "activation-test",
    activationRevision: 2,
    selectedCapabilities: Object.freeze(
      selections.map((selection) =>
        Object.freeze({
          ...selection,
          description: `Fixture Capability ${selection.name}`,
          applicability: `When ${selection.name} applies.`,
          selectionReason: "fixture",
          revision: revisionRef(selection.capabilityId),
          baseline: Object.freeze({ kind: "genesis" as const }),
          promptModules: Object.freeze([]),
          skills: Object.freeze([]),
          tools: Object.freeze([]),
          router: Object.freeze({
            revision: Object.freeze({
              kind: "file_revision" as const,
              revisionId: `router-${selection.capabilityId}`,
              workingPath: `definitions/capabilities/${selection.capabilityId}.json`,
              snapshotPath: `revisions/${selection.capabilityId}`,
              contentDigest: "c".repeat(64),
            }),
            content: "{}",
          }),
          permissionManifest: Object.freeze({
            effects: Object.freeze([]),
            resourcePatterns: Object.freeze([]),
            credentialRefs: Object.freeze([]),
          }),
        }),
      ),
    ),
    renderedSystemPrompt: "Noesis fixture",
    provider: "fake",
    model: "fake",
    thinkingLevel: "off",
    permissionSnapshot: Object.freeze({
      effects: Object.freeze([]),
      resourcePatterns: Object.freeze([]),
      credentialRefs: Object.freeze([]),
    }),
    retrievalCitations: Object.freeze([]),
    routing: Object.freeze(
      createConditionalObject({
        strategyId: "semantic-capability-router-v1",
        reason: "fixture",
      } as const)
        .addOptional(
          learningAttribution ? { learningAttribution: Object.freeze(learningAttribution) } : undefined,
        )
        .finish(),
    ),
    createdAt: "2026-07-25T00:00:00.000Z",
    canonicalDigest: "d".repeat(64),
  });
}
describe("turn settlement", () => {
  test("records canonical outcomes and reflects every settled turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-turn-settlement-"));
    const workspace = await createWorkspaceStore(root);
    homes.push({ root, workspace });
    await workspace.operational.sessions.put({
      sessionId: "session-1",
      title: "Settlement",
      status: "idle",
      provider: "fake",
      model: "fake",
      runtime: "fake",
      createdAt: "2026-07-25T00:00:00.000Z",
      updatedAt: "2026-07-25T00:00:00.000Z",
      metadata: Object.freeze({}),
    });
    const observedSelections: (readonly CapabilityRevisionRef[])[] = [];
    const reflectionFailures: string[] = [];
    const observedLearningTurns: {
      readonly outcome: string;
      readonly toolFailureCount: number;
      readonly evidenceTables: readonly string[];
    }[] = [];
    const settlement = createTurnSettlement({
      workspace,
      project: Object.freeze({ projectId: "project_test", root: "/workspace/noesis" }),
      coordinator: Object.freeze({
        observeSettledTurn: async (input) => {
          observedSelections.push(input.selectedCapabilities);
          observedLearningTurns.push({
            outcome: input.turn.outcome,
            toolFailureCount: input.turn.telemetry.toolFailureCount,
            evidenceTables: input.turn.evidenceRefs.map((reference) =>
              reference.kind === "database_row" ? reference.table : reference.kind,
            ),
          });
          return await Promise.reject(new Error("fixture stops after observing reflection"));
        },
      }),
      onReflectionFailure: (error) => {
        reflectionFailures.push(error instanceof Error ? error.message : String(error));
      },
    });
    const context = compileContext([], {}, { maxTokens: 8, maxFragmentTokens: 8 });
    const plan = turnPlan(
      "session-1",
      "turn-accepted",
      [
        { capabilityId: "general", name: "General", scope: "general" },
        {
          capabilityId: "noesis-research",
          name: "Noesis research",
          scope: "project/noesis/research",
        },
        {
          capabilityId: "review-style",
          name: "Review style",
          scope: "project/noesis/research/review-only-writing-style",
        },
      ],
      {
        capabilityId: "noesis-research",
        reason: "The semantic router chose research as the primary learning context",
      },
    );
    seedForegroundTurn(workspace, "session-1", "turn-accepted", plan.planId);
    seedForegroundTurn(workspace, "session-1", "turn-unrelated", "plan-turn-unrelated");
    await workspace.operational.toolCalls.put({
      toolCallId: "turn-unrelated:tool-failure",
      sessionId: "session-1",
      turnId: "turn-unrelated",
      toolName: "files.read",
      request: Object.freeze({ path: "also-missing.md" }),
      response: Object.freeze({ error: "not found" }),
      status: "failed",
      sensitivity: "normal",
      createdAt: "2026-07-25T00:00:00.500Z",
      completedAt: "2026-07-25T00:00:00.750Z",
    });
    await expect(
      settlement.run({
        sessionId: "session-1",
        turnId: "turn-accepted",
        input: "Write the Noesis research note",
        sourceIntentId: "intent-accepted",
        occurredAt: "2026-07-25T00:00:00.000Z",
        plan,
        execute: async () => {
          await workspace.operational.toolCalls.put({
            toolCallId: "turn-accepted:tool-failure",
            sessionId: "session-1",
            turnId: "turn-accepted",
            toolName: "files.read",
            request: Object.freeze({ path: "missing.md" }),
            response: Object.freeze({ error: "not found" }),
            status: "failed",
            sensitivity: "normal",
            createdAt: "2026-07-25T00:00:01.000Z",
            completedAt: "2026-07-25T00:00:02.000Z",
          });
          await workspace.operational.toolCalls.put({
            toolCallId: "turn-accepted:tool-success",
            sessionId: "session-1",
            turnId: "turn-accepted",
            toolName: "files.read",
            request: Object.freeze({ path: "found.md" }),
            response: Object.freeze({ content: "found" }),
            status: "completed",
            sensitivity: "normal",
            createdAt: "2026-07-25T00:00:03.000Z",
            completedAt: "2026-07-25T00:00:04.000Z",
          });
          return {
            outcome: "completed",
            output: "done",
            context,
            usedCapabilities: Object.freeze({}),
            frozenTurnPlan: plan,
          };
        },
      }),
    ).resolves.toMatchObject({ result: { outcome: "completed", output: "done" } });
    expect(reflectionFailures).toEqual(["fixture stops after observing reflection"]);
    expect(observedSelections).toEqual([
      [revisionRef("general"), revisionRef("noesis-research"), revisionRef("review-style")],
    ]);
    expect(observedLearningTurns).toEqual([
      {
        outcome: "unknown",
        toolFailureCount: 1,
        evidenceTables: ["messages", "messages", "tool_calls", "tool_calls"],
      },
    ]);
    expect(
      (await workspace.operational.toolCalls.listForTurn("session-1", "turn-accepted")).map(
        (toolCall) => toolCall.toolCallId,
      ),
    ).toEqual(["turn-accepted:tool-failure", "turn-accepted:tool-success"]);
    expect(await workspace.operational.outcomes.listForSession("session-1")).toHaveLength(1);
    expect(await workspace.operational.outcomes.get("turn-accepted:outcome")).toMatchObject({
      status: "unknown",
    });
    expect((await workspace.operational.messages.get("turn-accepted:user"))?.metadata).toMatchObject({
      turnId: "turn-accepted",
      sourceIntentId: "intent-accepted",
    });
    const abortedPlan = turnPlan("session-1", "turn-aborted", [
      { capabilityId: "general", name: "General", scope: "general" },
    ]);
    seedForegroundTurn(workspace, "session-1", "turn-aborted", abortedPlan.planId);
    await expect(
      settlement.run({
        sessionId: "session-1",
        turnId: "turn-aborted",
        input: "stop",
        occurredAt: "2026-07-25T00:01:00.000Z",
        plan: abortedPlan,
        execute: async () => ({
          outcome: "aborted",
          output: "partial",
          context,
          usedCapabilities: Object.freeze({}),
          frozenTurnPlan: abortedPlan,
        }),
      }),
    ).resolves.toMatchObject({ result: { outcome: "aborted", output: "partial" } });
    expect(observedLearningTurns.at(-1)?.outcome).toBe("failed");
    const outcomes = await workspace.operational.outcomes.listForSession("session-1");
    expect(outcomes).toHaveLength(2);
    expect(outcomes.find((outcome) => outcome.turnId === "turn-aborted")).toMatchObject({
      status: "failed",
      metadata: { aborted: true, replayEligible: false },
    });
    const correctedPlan = turnPlan("session-1", "turn-corrected", [
      { capabilityId: "general", name: "General", scope: "general" },
    ]);
    seedForegroundTurn(workspace, "session-1", "turn-corrected", correctedPlan.planId);
    await expect(
      settlement.run({
        sessionId: "session-1",
        turnId: "turn-corrected",
        input: "Actually, cite the exact primary source.",
        occurredAt: "2026-07-25T00:02:00.000Z",
        plan: correctedPlan,
        execute: async () => ({
          outcome: "completed",
          output: "Corrected response with an exact primary source.",
          context,
          usedCapabilities: Object.freeze({}),
          frozenTurnPlan: correctedPlan,
        }),
      }),
    ).resolves.toMatchObject({
      result: { outcome: "completed", output: "Corrected response with an exact primary source." },
    });
    expect(reflectionFailures).toHaveLength(3);
    expect(observedLearningTurns.at(-1)?.outcome).toBe("unknown");
    await workspace.operational.outcomes.classify({
      outcomeId: "turn-corrected:outcome",
      sessionId: "session-1",
      turnId: "turn-corrected",
      classification: "correction",
      reason: "The semantic reflector identified a correction to the preceding behavior.",
    });
    expect(await workspace.operational.outcomes.get("turn-corrected:outcome")).toMatchObject({
      status: "corrected",
      metadata: {
        semanticObservation: {
          kind: "correction",
          reason: "The semantic reflector identified a correction to the preceding behavior.",
        },
      },
    });
    const history = createHistoryPort({
      workspace,
      embeddings: createDeterministicEmbeddingPort(),
      reranker: createDeterministicRerankPort(),
    });
    const sessionTools = createSessionSearchTools({
      workspace,
      history,
      authorization: { currentSessionId: "consumer-session" },
    });
    const corrections = await sessionTools.findCorrections({
      topic: "exact primary source corrected response",
      strategy: SESSION_RETRIEVAL_STRATEGIES.ftsOnly.strategyId,
    });
    expect(corrections.ok).toBe(true);
    if (corrections.ok) expect(corrections.value.fragments).toHaveLength(1);
  });
});
function seedForegroundTurn(
  workspace: NoesisWorkspaceStore,
  sessionId: string,
  turnId: string,
  planId: string,
): void {
  const database = new DatabaseSync(workspace.unsafeDatabasePathForTesting);
  database.exec("PRAGMA foreign_keys = OFF");
  database
    .prepare(`INSERT INTO foreground_turns(
        turn_id, session_id, plan_id, status, outcome_id, admitted_at, settled_at
      ) VALUES (?, ?, ?, 'running', NULL, ?, NULL)`)
    .run(turnId, sessionId, planId, "2026-07-25T00:00:00.000Z");
  database.close();
}
