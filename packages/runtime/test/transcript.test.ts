import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FrozenTurnPlan, frozenTurnPlanDigest } from "@noesis/agent-types";
import { createConditionalObject, sha256 } from "@noesis/domain";
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
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const sourceArtifact = await workspace.artifacts.writeArtifact({
      path: "codemode/execution-1/source.mjs",
      mediaType: "text/javascript",
      bytes: source,
      actor: { actorId: "test", kind: "system" },
      relationshipRefs: Object.freeze([
        { kind: "database_row" as const, table: "sessions" as const, rowId: "session-1" },
      ]),
    });
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
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
      toolName: "capabilities.inspect",
      request: { view: "detail" },
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
      response: { output: { stdout: "/workspace\n", exitCode: 0 } },
      status: "completed",
      sensitivity: "normal",
      createdAt: "2026-07-30T00:00:02.000Z",
      completedAt: "2026-07-30T00:00:02.800Z",
    });
    await workspace.operational.messages.put({
      messageId: "turn-1:steer",
      sessionId: "session-1",
      role: "user",
      content: "Also check the failing command.",
      sensitivity: "normal",
      createdAt: "2026-07-30T00:00:02.500Z",
      metadata: Object.freeze({ turnId: "turn-1" }),
    });
    await workspace.operational.toolCalls.put({
      toolCallId: "broker-call-2",
      sessionId: "session-1",
      turnId: "turn-1",
      executionId: "execution-1",
      parentToolCallId: "action-execute",
      toolName: "shell.run",
      request: { executionId: "execution-1", input: { command: "false" } },
      response: { error: "Command exited with status 1" },
      status: "failed",
      sensitivity: "normal",
      createdAt: "2026-07-30T00:00:02.700Z",
      completedAt: "2026-07-30T00:00:02.900Z",
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
      "action:capabilities.inspect",
      "action:execute",
      "action:shell.run",
      "message:user",
      "action:shell.run",
      "message:assistant",
    ]);
    expect(afterRestart.at(3)).toMatchObject({
      kind: "action",
      actionId: "broker-call-1",
      parentActionId: "action-execute",
      status: "completed",
      input: { command: "pwd" },
      output: { stdout: "/workspace\n", exitCode: 0 },
    });
    expect(afterRestart.at(3)).not.toHaveProperty("executionId");
    expect(afterRestart.at(4)).toMatchObject({
      kind: "message",
      messageId: "turn-1:steer",
    });
    expect(afterRestart.at(5)).toMatchObject({
      kind: "action",
      actionId: "broker-call-2",
      input: { command: "false" },
      output: { error: "Command exited with status 1" },
      status: "failed",
    });
    expect(afterRestart.at(5)).not.toHaveProperty("executionId");
    reopened.close();
  });
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  test("uses durable message sequences for same-timestamp source and inherited history", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-runtime-transcript-message-order-"));
    roots.push(root);
    const workspace = await createWorkspaceStore(root);
    for (const sessionId of ["session-source-order", "session-inherited-order"]) {
      await workspace.operational.sessions.put({
        sessionId,
        title: "Ordered transcript",
        status: "idle",
        provider: "controlled",
        model: "controlled",
        runtime: "pi",
        createdAt: "2026-07-30T00:00:00.000Z",
        updatedAt: "2026-07-30T00:00:00.000Z",
        metadata: Object.freeze({}),
      });
    }
    const createdAt = "2026-07-30T00:00:01.000Z";
    await workspace.operational.messages.put({
      messageId: "source-z-assistant",
      sessionId: "session-source-order",
      role: "assistant",
      content: "assistant",
      sensitivity: "normal",
      createdAt,
      metadata: Object.freeze({ turnId: "turn-source" }),
    });
    await workspace.operational.messages.put({
      messageId: "source-a-steer-later",
      sessionId: "session-source-order",
      role: "user",
      content: "steer later",
      sensitivity: "normal",
      createdAt,
      metadata: Object.freeze({
        turnId: "turn-source",
        deliveryMode: "steer",
        interactionSequence: 8,
      }),
    });
    await workspace.operational.messages.put({
      messageId: "source-z-user",
      sessionId: "session-source-order",
      role: "user",
      content: "ordinary user",
      sensitivity: "normal",
      createdAt,
      metadata: Object.freeze({ turnId: "turn-source" }),
    });
    await workspace.operational.messages.put({
      messageId: "source-z-steer-earlier",
      sessionId: "session-source-order",
      role: "user",
      content: "steer earlier",
      sensitivity: "normal",
      createdAt,
      metadata: Object.freeze({
        turnId: "turn-source",
        deliveryMode: "steer",
        interactionSequence: 7,
      }),
    });
    for (const [messageId, role, content, historySequence] of [
      ["inherited-a-assistant", "assistant", "assistant", 3],
      ["inherited-a-steer", "user", "steer", 2],
      ["inherited-z-user", "user", "ordinary user", 1],
    ] as const) {
      await workspace.operational.messages.put({
        messageId,
        sessionId: "session-inherited-order",
        role,
        content,
        sensitivity: "normal",
        createdAt,
        metadata: Object.freeze({
          replayEligible: true,
          historySequence,
          historyKind: content === "steer" ? "steer" : "turn",
          inheritedFromSessionId: "session-source-order",
          inheritedFromMessageId: `source:${messageId}`,
        }),
      });
    }
    expect(
      (await loadRuntimeTranscript(workspace, "session-source-order")).map((entry) =>
        entry.kind === "message" ? entry.text : entry.name,
      ),
    ).toEqual(["ordinary user", "steer earlier", "steer later", "assistant"]);
    expect(
      (await loadRuntimeTranscript(workspace, "session-inherited-order")).map((entry) =>
        entry.kind === "message" ? entry.text : entry.name,
      ),
    ).toEqual(["ordinary user", "steer", "assistant"]);
    workspace.close();
  });
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  test("uses one durable turn timeline across assistant boundaries, actions, and steering", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-runtime-transcript-turn-timeline-"));
    roots.push(root);
    const workspace = await createWorkspaceStore(root);
    await workspace.operational.sessions.put({
      sessionId: "session-turn-timeline",
      title: "Turn timeline",
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
    await protectedRuntime.activations.admitTurnPlan(plan("session-turn-timeline", "turn-timeline"));
    const createdAt = "2026-07-30T00:00:01.000Z";
    for (const message of [
      {
        messageId: "turn-timeline:user",
        role: "user" as const,
        content: "start",
        timelineSequence: 0,
      },
      {
        messageId: "turn-timeline:assistant:1",
        role: "assistant" as const,
        content: "First boundary",
        timelineSequence: 1,
      },
      {
        messageId: "turn-timeline:steer:intent",
        role: "user" as const,
        content: "steer",
        timelineSequence: 4,
      },
      {
        messageId: "turn-timeline:assistant:4",
        role: "assistant" as const,
        content: "Second boundary",
        timelineSequence: 5,
      },
    ]) {
      // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
      await workspace.operational.messages.put({
        ...message,
        sessionId: "session-turn-timeline",
        sensitivity: "normal",
        createdAt,
        metadata: Object.freeze(
          createConditionalObject({
            turnId: "turn-timeline",
          } as const)
            .addOptional(message.timelineSequence === 4 ? { deliveryMode: "steer" } : undefined)
            .finish(),
        ),
      });
    }
    await workspace.operational.toolCalls.put({
      toolCallId: "turn-timeline:execute",
      sessionId: "session-turn-timeline",
      turnId: "turn-timeline",
      toolName: "execute",
      request: {},
      response: {},
      timelineSequence: 2,
      status: "completed",
      sensitivity: "normal",
      createdAt,
      completedAt: createdAt,
    });
    await workspace.operational.toolCalls.put({
      toolCallId: "tool_call_nested-timeline",
      sessionId: "session-turn-timeline",
      turnId: "turn-timeline",
      parentToolCallId: "turn-timeline:execute",
      toolName: "shell.run",
      request: { command: "pwd" },
      response: { stdout: "/workspace" },
      timelineSequence: 3,
      status: "completed",
      sensitivity: "normal",
      createdAt,
      completedAt: createdAt,
    });
    const beforeRestart = await loadRuntimeTranscript(workspace, "session-turn-timeline");
    workspace.close();
    const reopened = await createWorkspaceStore(root);
    const afterRestart = await loadRuntimeTranscript(reopened, "session-turn-timeline");
    expect(afterRestart).toEqual(beforeRestart);
    expect(afterRestart.map((entry) => (entry.kind === "message" ? entry.text : entry.name))).toEqual([
      "start",
      "First boundary",
      "execute",
      "shell.run",
      "steer",
      "Second boundary",
    ]);
    reopened.close();
  });
  test("uses one total order for same-timestamp entries from different turns", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-runtime-transcript-cross-turn-order-"));
    roots.push(root);
    const workspace = await createWorkspaceStore(root);
    await workspace.operational.sessions.put({
      sessionId: "session-cross-turn",
      title: "Cross-turn order",
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
    await protectedRuntime.activations.admitTurnPlan(plan("session-cross-turn", "turn-a"));
    await protectedRuntime.activations.admitTurnPlan(plan("session-cross-turn", "turn-b"));
    const createdAt = "2026-07-30T00:00:01.000Z";
    await workspace.operational.messages.put({
      messageId: "z-assistant-a",
      sessionId: "session-cross-turn",
      role: "assistant",
      content: "assistant A",
      sensitivity: "normal",
      createdAt,
      metadata: Object.freeze({ turnId: "turn-a" }),
      timelineSequence: 1,
    });
    await workspace.operational.messages.put({
      messageId: "a-steer-a",
      sessionId: "session-cross-turn",
      role: "user",
      content: "steer B",
      sensitivity: "normal",
      createdAt,
      metadata: Object.freeze({
        turnId: "turn-a",
        deliveryMode: "steer",
        interactionSequence: 1,
      }),
      timelineSequence: 2,
    });
    await workspace.operational.toolCalls.put({
      toolCallId: "action-c",
      sessionId: "session-cross-turn",
      turnId: "turn-b",
      toolName: "capabilities.inspect",
      request: {},
      response: {},
      timelineSequence: 0,
      status: "completed",
      sensitivity: "normal",
      createdAt,
      completedAt: createdAt,
    });
    const beforeRestart = await loadRuntimeTranscript(workspace, "session-cross-turn");
    workspace.close();
    const reopened = await createWorkspaceStore(root);
    const afterRestart = await loadRuntimeTranscript(reopened, "session-cross-turn");
    expect(afterRestart).toEqual(beforeRestart);
    expect(afterRestart.map((entry) => (entry.kind === "message" ? entry.text : "tool C"))).toEqual([
      "assistant A",
      "steer B",
      "tool C",
    ]);
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
      toolName: "capabilities.refine",
      request: { decision: "create" },
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
        input: { decision: "create" },
        completedAt: "2026-07-30T00:00:02.000Z",
      }),
    ]);
    workspace.close();
  });
  test("omits turn identity for legacy actions that predate foreground turns", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-runtime-transcript-legacy-action-"));
    roots.push(root);
    const workspace = await createWorkspaceStore(root);
    await workspace.operational.sessions.put({
      sessionId: "session-legacy",
      title: "Legacy action",
      status: "idle",
      provider: "controlled",
      model: "controlled",
      runtime: "pi",
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
      metadata: Object.freeze({}),
    });
    await workspace.operational.toolCalls.put({
      toolCallId: "legacy-action",
      sessionId: "session-legacy",
      toolName: "legacy.tool",
      request: { value: 1 },
      response: { value: 2 },
      status: "completed",
      sensitivity: "normal",
      createdAt: "2026-07-30T00:00:01.000Z",
      completedAt: "2026-07-30T00:00:02.000Z",
    });
    const [action] = await loadRuntimeTranscript(workspace, "session-legacy");
    expect(action).toMatchObject({ kind: "action", actionId: "legacy-action" });
    expect(action).not.toHaveProperty("turnId");
    workspace.close();
  });
});
