import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FrozenTurnPlan } from "@noesis/agent-types";
import { compileContext } from "@noesis/context";
import type { CapabilityRevisionRef } from "@noesis/domain";
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
  }[],
): FrozenTurnPlan {
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  return Object.freeze({
    schemaVersion: 2,
    planId: `plan-${turnId}`,
    sessionId,
    turnId,
    project: Object.freeze({ projectId: "project_test", root: "/workspace/noesis" }),
    selectedCapabilities: Object.freeze(
      selections.map((selection) =>
        Object.freeze({
          ...selection,
          description: `Fixture Capability ${selection.name}`,
          applicability: `When ${selection.name} applies.`,
          selectionReason: "fixture",
          delivery: "prompt" as const,
          revision: revisionRef(selection.capabilityId),
          effects: Object.freeze([
            Object.freeze({
              kind: "instruction" as const,
              material: Object.freeze({
                revision: Object.freeze({
                  kind: "file_revision" as const,
                  revisionId: `instruction-${selection.capabilityId}`,
                  workingPath: `definitions/capabilities/${selection.capabilityId}.md`,
                  snapshotPath: `revisions/${selection.capabilityId}`,
                  contentDigest: "c".repeat(64),
                }),
                content: "Fixture guidance.",
              }),
            }),
          ]),
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
    const releasedSessions: string[] = [];
    const observedLearningTurns: {
      readonly outcome: string;
      readonly cause: string | undefined;
      readonly toolFailureCount: number;
      readonly evidenceTables: readonly string[];
    }[] = [];
    const settlement = createTurnSettlement({
      workspace,
      project: Object.freeze({ projectId: "project_test", root: "/workspace/noesis" }),
      coordinator: Object.freeze({
        releaseSession: async (sessionId: string) => {
          releasedSessions.push(sessionId);
        },
        observeSettledTurn: async (input) => {
          observedSelections.push(input.selectedCapabilities);
          observedLearningTurns.push({
            outcome: input.turn.outcome,
            cause: input.turn.cause,
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
    const plan = turnPlan("session-1", "turn-accepted", [
      { capabilityId: "general", name: "General" },
      {
        capabilityId: "noesis-research",
        name: "Noesis research",
      },
      {
        capabilityId: "review-style",
        name: "Review style",
      },
    ]);
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
        cause: "completed",
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
    const abortedPlan = turnPlan("session-1", "turn-aborted", [{ capabilityId: "general", name: "General" }]);
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
    expect(observedLearningTurns.at(-1)).toMatchObject({ outcome: "failed", cause: "user_aborted" });
    const outcomes = await workspace.operational.outcomes.listForSession("session-1");
    expect(outcomes).toHaveLength(2);
    expect(outcomes.find((outcome) => outcome.turnId === "turn-aborted")).toMatchObject({
      status: "failed",
      metadata: { cause: "user_aborted", aborted: true, replayEligible: false },
    });
    const providerFailurePlan = turnPlan("session-1", "turn-provider-failure", []);
    seedForegroundTurn(workspace, "session-1", "turn-provider-failure", providerFailurePlan.planId);
    await expect(
      settlement.run({
        sessionId: "session-1",
        turnId: "turn-provider-failure",
        input: "hey hey",
        occurredAt: "2026-07-25T00:01:30.000Z",
        plan: providerFailurePlan,
        execute: async () => await Promise.reject(new Error("400 MissingSessionID")),
      }),
    ).rejects.toThrow("400 MissingSessionID");
    expect(await workspace.operational.outcomes.get("turn-provider-failure:outcome")).toMatchObject({
      status: "failed",
      metadata: { cause: "failed_before_output" },
    });
    // A turn that failed before the model produced anything is never reflected on.
    expect(observedLearningTurns).toHaveLength(2);
    const correctedPlan = turnPlan("session-1", "turn-corrected", [
      { capabilityId: "general", name: "General" },
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
    // Every user message releases the session's held reflections, since it reacts to the last turn.
    expect(releasedSessions).toEqual(["session-1", "session-1", "session-1", "session-1"]);
    expect(observedLearningTurns.at(-1)?.outcome).toBe("unknown");
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
