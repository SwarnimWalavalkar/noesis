import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frozenTurnPlanDigest, type FrozenTurnPlan } from "@noesis/agent-types";
import { sha256 } from "@noesis/domain";
import { createWorkspaceStore } from "@noesis/workspace";
import { afterEach, describe, expect, test } from "vitest";
import { createWorkspaceRuntimeInternals } from "../../workspace/src/protected-runtime.ts";
import { loadRuntimeTranscript } from "../src/index.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const plan = (sessionId: string, turnId: string): FrozenTurnPlan => {
  const body: Omit<FrozenTurnPlan, "canonicalDigest"> = {
    schemaVersion: 1,
    planId: `plan-${turnId}`,
    sessionId,
    turnId,
    activationId: "activation_genesis",
    activationRevision: 1,
    selectedCapabilities: [],
    renderedSystemPrompt: "Noesis",
    provider: "controlled",
    model: "controlled",
    thinkingLevel: "off",
    permissionSnapshot: { effects: [], resourcePatterns: [], credentialRefs: [] },
    retrievalCitations: [],
    routing: { strategyId: "baseline", reason: "fixture" },
    createdAt: "2026-07-30T00:00:00.000Z",
  };
  return Object.freeze({ ...body, canonicalDigest: frozenTurnPlanDigest(body) });
};

describe("runtime transcript projection", () => {
  test("reconstructs the same ordered action tree after the workspace is reopened", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-runtime-transcript-"));
    roots.push(root);
    const workspace = await createWorkspaceStore(root);
    await workspace.operational.sessions.put({
      sessionId: "session-1",
      title: "Durable transcript",
      status: "running",
      provider: "controlled",
      model: "controlled",
      runtime: "pi",
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
      metadata: Object.freeze({}),
    });
    const protectedRuntime = createWorkspaceRuntimeInternals(workspace).protectedRuntime;
    await protectedRuntime.activations.bootstrapGenesis({
      capabilityRevision: {
        kind: "capability_revision",
        capabilityId: "general-collaboration",
        capabilityRevisionId: "general-collaboration-genesis-v1",
        bundleDigest: "a".repeat(64),
      },
      activeDefinitions: {},
    });
    await protectedRuntime.activations.admitTurnPlan(plan("session-1", "turn-1"));
    await workspace.operational.messages.put({
      messageId: "turn-1:user",
      sessionId: "session-1",
      role: "user",
      content: "Inspect this repository",
      sensitivity: "normal",
      createdAt: "2026-07-30T00:00:00.000Z",
      metadata: Object.freeze({ turnId: "turn-1" }),
    });
    const source = Buffer.from("return await noesis.invoke('shell.run', { command: 'pwd' });");
    const sourceArtifact = await workspace.artifacts.writeArtifact({
      path: "codemode/execution-1/source.mjs",
      mediaType: "text/javascript",
      bytes: source,
      actor: { actorId: "test", kind: "system" },
      relationshipRefs: Object.freeze([
        { kind: "database_row" as const, table: "sessions" as const, rowId: "session-1" },
      ]),
    });
    const [stdoutArtifact, stderrArtifact] = await Promise.all([
      workspace.artifacts.writeArtifact({
        path: "codemode/execution-1/stdout.log",
        mediaType: "text/plain",
        bytes: Buffer.from("/workspace\n"),
        actor: { actorId: "test", kind: "system" },
        relationshipRefs: Object.freeze([
          { kind: "database_row" as const, table: "sessions" as const, rowId: "session-1" },
        ]),
      }),
      workspace.artifacts.writeArtifact({
        path: "codemode/execution-1/stderr.log",
        mediaType: "text/plain",
        bytes: Buffer.from(""),
        actor: { actorId: "test", kind: "system" },
        relationshipRefs: Object.freeze([
          { kind: "database_row" as const, table: "sessions" as const, rowId: "session-1" },
        ]),
      }),
    ]);
    await workspace.operational.codeExecutions.put({
      executionId: "execution-1",
      logicalExecutionId: "logical-1",
      sessionId: "session-1",
      turnId: "turn-1",
      catalogId: "catalog-1",
      catalogDigest: "b".repeat(64),
      sourceDigest: sha256(source),
      sourceArtifactId: sourceArtifact.artifactId,
      stdoutArtifactId: stdoutArtifact.artifactId,
      stderrArtifactId: stderrArtifact.artifactId,
      status: "completed",
      result: "/workspace",
      callCount: 1,
      startedAt: "2026-07-30T00:00:02.000Z",
      completedAt: "2026-07-30T00:00:03.000Z",
    });
    await workspace.operational.toolCalls.put({
      toolCallId: "action-inspect",
      sessionId: "session-1",
      turnId: "turn-1",
      toolName: "inspect_self",
      request: { section: "context" },
      response: { planId: "plan-turn-1" },
      status: "completed",
      sensitivity: "normal",
      createdAt: "2026-07-30T00:00:01.000Z",
      completedAt: "2026-07-30T00:00:01.500Z",
    });
    await workspace.operational.toolCalls.put({
      toolCallId: "action-execute",
      sessionId: "session-1",
      turnId: "turn-1",
      executionId: "execution-1",
      toolName: "execute",
      request: { source: "return await noesis.invoke(...)" },
      update: { kind: "activity", executionId: "execution-1" },
      response: { executionId: "execution-1", value: "/workspace" },
      status: "completed",
      sensitivity: "normal",
      createdAt: "2026-07-30T00:00:02.000Z",
      completedAt: "2026-07-30T00:00:03.000Z",
    });
    await workspace.operational.toolCalls.put({
      toolCallId: "broker-call-1",
      sessionId: "session-1",
      turnId: "turn-1",
      executionId: "execution-1",
      parentToolCallId: "action-execute",
      toolName: "shell.run",
      request: { executionId: "execution-1", input: { command: "pwd" } },
      response: { output: { stdout: "/workspace\n" } },
      status: "completed",
      sensitivity: "normal",
      createdAt: "2026-07-30T00:00:02.200Z",
      completedAt: "2026-07-30T00:00:02.800Z",
    });
    await workspace.operational.messages.put({
      messageId: "turn-1:assistant",
      sessionId: "session-1",
      role: "assistant",
      content: "The repository is in /workspace.",
      sensitivity: "normal",
      createdAt: "2026-07-30T00:00:04.000Z",
      metadata: Object.freeze({ turnId: "turn-1" }),
    });

    const beforeRestart = await loadRuntimeTranscript(workspace, "session-1");
    workspace.close();
    const reopened = await createWorkspaceStore(root);
    const afterRestart = await loadRuntimeTranscript(reopened, "session-1");

    expect(afterRestart).toEqual(beforeRestart);
    expect(
      afterRestart.map((entry) =>
        entry.kind === "message" ? `${entry.kind}:${entry.role}` : `${entry.kind}:${entry.name}`,
      ),
    ).toEqual([
      "message:user",
      "action:inspect_self",
      "action:execute",
      "action:shell.run",
      "message:assistant",
    ]);
    expect(afterRestart.at(3)).toMatchObject({
      kind: "action",
      actionId: "broker-call-1",
      parentActionId: "action-execute",
      executionId: "execution-1",
      status: "completed",
    });
    reopened.close();
  });

  test("marks running actions interrupted without losing their request", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-runtime-transcript-interrupt-"));
    roots.push(root);
    const workspace = await createWorkspaceStore(root);
    await workspace.operational.sessions.put({
      sessionId: "session-interrupted",
      title: "Interrupted",
      status: "running",
      provider: "controlled",
      model: "controlled",
      runtime: "pi",
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
      metadata: Object.freeze({}),
    });
    const protectedRuntime = createWorkspaceRuntimeInternals(workspace).protectedRuntime;
    await protectedRuntime.activations.bootstrapGenesis({
      capabilityRevision: {
        kind: "capability_revision",
        capabilityId: "general-collaboration",
        capabilityRevisionId: "general-collaboration-genesis-v1",
        bundleDigest: "a".repeat(64),
      },
      activeDefinitions: {},
    });
    await protectedRuntime.activations.admitTurnPlan(plan("session-interrupted", "turn-interrupted"));
    await workspace.operational.toolCalls.put({
      toolCallId: "action-running",
      sessionId: "session-interrupted",
      turnId: "turn-interrupted",
      toolName: "remember",
      request: { memory: "Keep exact evidence" },
      status: "running",
      sensitivity: "normal",
      createdAt: "2026-07-30T00:00:01.000Z",
    });

    expect(
      await workspace.operational.toolCalls.interruptRunningForTurn(
        "turn-interrupted",
        "2026-07-30T00:00:02.000Z",
      ),
    ).toBe(1);
    expect(await loadRuntimeTranscript(workspace, "session-interrupted")).toEqual([
      expect.objectContaining({
        kind: "action",
        actionId: "action-running",
        status: "interrupted",
        input: { memory: "Keep exact evidence" },
        completedAt: "2026-07-30T00:00:02.000Z",
      }),
    ]);
    workspace.close();
  });
});
