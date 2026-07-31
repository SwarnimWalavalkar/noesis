import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  frozenTurnPlanDigest,
  type AgentRuntimeEvent,
  type AgentRuntimeRequest,
  type FrozenTurnPlan,
  type NoesisAgentRuntime,
} from "@noesis/agent-types";
import { resolveNoesisConfig } from "@noesis/config";
import { eventChecksum, type LedgerEvent } from "@noesis/domain";
import { createPiAgentRoleRunner, createPiAgentRuntime, createPiSkillLibrary } from "@noesis/runtime-pi";
import { createWorkspaceStore } from "@noesis/workspace";
import { afterEach, describe, expect, test } from "vitest";
import { createWorkspaceRuntimeInternals } from "../../../packages/workspace/src/protected-runtime.ts";
import {
  CONTROLLED_PI_MODEL,
  CONTROLLED_PI_PROVIDER,
  createControlledPiModels,
} from "../../../packages/runtime-pi/test/support/controlled-pi-models.ts";
import { createScriptedAgentRoleRunner } from "../../../packages/runtime-pi/test/support/scripted-role-runner.ts";
import { createApplicationRuntimeComposition } from "../src/runtime-composition.ts";

const roots: string[] = [];

const recoveryTurnPlan = (sessionId: string, turnId: string): FrozenTurnPlan => {
  const body: Omit<FrozenTurnPlan, "canonicalDigest"> = {
    schemaVersion: 1,
    planId: `plan-${turnId}`,
    sessionId,
    turnId,
    activationId: "activation_genesis",
    activationRevision: 1,
    selectedCapabilities: [],
    renderedSystemPrompt: "Noesis recovery fixture",
    provider: CONTROLLED_PI_PROVIDER,
    model: CONTROLLED_PI_MODEL,
    thinkingLevel: "off",
    permissionSnapshot: { effects: [], resourcePatterns: [], credentialRefs: [] },
    retrievalCitations: [],
    routing: { strategyId: "baseline", reason: "Recovery fixture" },
    createdAt: "2026-07-26T00:00:00.000Z",
  };
  return Object.freeze({ ...body, canonicalDigest: frozenTurnPlanDigest(body) });
};

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for runtime interaction");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function writeLegacyCompletedTurn(
  home: string,
  runtimeIdentity: string,
): Promise<{
  readonly trailId: string;
  readonly input: string;
  readonly output: string;
}> {
  const trailId = "trail-legacy-import";
  const input = "Preserve this legitimate history";
  const output = "Imported legacy completion";
  const unsignedStart: Omit<LedgerEvent, "checksum"> = {
    schemaVersion: 1,
    eventId: "event-legacy-start",
    sequence: 1,
    occurredAt: "2026-01-01T00:00:00.000Z",
    principal: "foreground",
    type: "trail.started",
    trailId,
    payload: {
      title: "Legacy import",
      provider: CONTROLLED_PI_PROVIDER,
      model: CONTROLLED_PI_MODEL,
      runtime: runtimeIdentity,
    },
    previousChecksum: null,
  };
  const start: LedgerEvent = { ...unsignedStart, checksum: eventChecksum(unsignedStart) };
  const unsignedTurn: Omit<LedgerEvent, "checksum"> = {
    schemaVersion: 1,
    eventId: "event-legacy-turn",
    sequence: 2,
    occurredAt: "2026-01-01T00:01:00.000Z",
    principal: "foreground",
    type: "turn.completed",
    trailId,
    payload: { input, output },
    previousChecksum: start.checksum,
  };
  const turn: LedgerEvent = { ...unsignedTurn, checksum: eventChecksum(unsignedTurn) };
  await mkdir(join(home, "ledger"), { recursive: true });
  await writeFile(
    join(home, "ledger", "events.jsonl"),
    `${[start, turn].map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
  return Object.freeze({ trailId, input, output });
}

describe("apps/noesis production control-plane composition", () => {
  test("starts from marked SQLite authority without parsing corrupted abandoned JSONL", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-marked-corrupt-legacy-"));
    roots.push(home);
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const controlled = createControlledPiModels();
    const first = await createApplicationRuntimeComposition({
      config,
      createAgent: (_sessionTools, codeExecution, selfTools) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution, selfTools }),
      createRoleRunner: (configurations) =>
        createPiAgentRoleRunner(process.cwd(), controlled.models, configurations),
    });
    const trail = await first.startTrail({ title: "SQLite-authoritative session" });
    await first.shutdown();

    await mkdir(join(home, "ledger"), { recursive: true });
    await writeFile(join(home, "ledger", "events.jsonl"), "{ definitely not valid JSONL\n");

    const reopened = await createApplicationRuntimeComposition({
      config,
      createAgent: (_sessionTools, codeExecution, selfTools) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution, selfTools }),
      createRoleRunner: (configurations) =>
        createPiAgentRoleRunner(process.cwd(), controlled.models, configurations),
    });
    expect(reopened.getTrail(trail.trailId)).toMatchObject({
      trailId: trail.trailId,
      title: "SQLite-authoritative session",
    });
    await reopened.shutdown();
  });

  test("imports completed pre-marker legacy turns once and retains them for resume", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-pre-marker-import-"));
    roots.push(home);
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const controlled = createControlledPiModels();
    const runtimeIdentity = createPiAgentRuntime(process.cwd(), controlled.models).name;
    const legacy = await writeLegacyCompletedTurn(home, runtimeIdentity);

    const runtime = await createApplicationRuntimeComposition({
      config,
      createAgent: (_sessionTools, codeExecution, selfTools) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution, selfTools }),
      createRoleRunner: (configurations) =>
        createPiAgentRoleRunner(process.cwd(), controlled.models, configurations),
    });
    expect(runtime.getTrail(legacy.trailId).turns).toEqual([
      {
        input: legacy.input,
        output: legacy.output,
      },
    ]);
    await runtime.shutdown();
  });

  test("retains an aborted partial pair for inspection but excludes it after restart and resume", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-aborted-replay-"));
    roots.push(home);
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const controlled = createControlledPiModels();
    const noOp = async (): Promise<void> => undefined;
    const runtimeIdentity = createPiAgentRuntime(process.cwd(), controlled.models).name;
    const abortedAgent: NoesisAgentRuntime = Object.freeze({
      name: runtimeIdentity,
      run: async (request: AgentRuntimeRequest) =>
        Object.freeze({
          outcome: "aborted" as const,
          stopReason: "aborted" as const,
          text: "partial answer that must not resume",
          provider: request.provider,
          model: request.model,
        }),
      steer: noOp,
      abort: noOp,
    });
    const first = await createApplicationRuntimeComposition({
      config,
      agent: abortedAgent,
      createRoleRunner: (configurations) =>
        createPiAgentRoleRunner(process.cwd(), controlled.models, configurations),
    });
    const trail = await first.startTrail({ title: "Aborted partial replay" });
    const aborted = await first.runTurn(trail.trailId, "input attached to an aborted answer");
    expect(aborted).toMatchObject({
      outcome: "aborted",
      output: "partial answer that must not resume",
    });
    expect(await first.debug.workspace.operational.messages.listForSession(trail.trailId)).toMatchObject([
      { role: "user", content: "input attached to an aborted answer" },
      { role: "assistant", content: "partial answer that must not resume" },
    ]);
    expect(await first.debug.workspace.operational.outcomes.listForSession(trail.trailId)).toMatchObject([
      {
        status: "failed",
        metadata: { aborted: true, replayEligible: false },
      },
    ]);
    await first.shutdown();

    const requests: AgentRuntimeRequest[] = [];
    const resumedAgent: NoesisAgentRuntime = Object.freeze({
      name: abortedAgent.name,
      run: async (request: AgentRuntimeRequest) => {
        requests.push(request);
        return Object.freeze({
          outcome: "completed" as const,
          stopReason: "stop" as const,
          text: "clean resumed completion",
          provider: request.provider,
          model: request.model,
        });
      },
      steer: noOp,
      abort: noOp,
    });
    const reopened = await createApplicationRuntimeComposition({
      config,
      agent: resumedAgent,
      createRoleRunner: (configurations) =>
        createPiAgentRoleRunner(process.cwd(), controlled.models, configurations),
    });
    expect(reopened.getTrail(trail.trailId).turns).toEqual([]);
    await reopened.resumeTrail(trail.trailId);
    await reopened.runTurn(trail.trailId, "continue with clean context");
    expect(requests[0]?.systemPrompt).not.toContain("partial answer that must not resume");
    expect(requests[0]?.systemPrompt).not.toContain("input attached to an aborted answer");
    expect(await reopened.debug.workspace.operational.messages.listForSession(trail.trailId)).toHaveLength(4);
    await reopened.shutdown();
  });

  test("recovers a process-killed foreground turn before hydration and keeps its action inspectable", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-foreground-recovery-"));
    roots.push(home);
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const controlled = createControlledPiModels();
    const runtimeIdentity = createPiAgentRuntime(process.cwd(), controlled.models).name;
    const seed = await createWorkspaceStore(home, {
      now: () => "2026-07-26T00:00:00.000Z",
    });
    await seed.operational.sessions.put({
      sessionId: "session-process-killed",
      title: "Process-killed turn",
      status: "running",
      provider: CONTROLLED_PI_PROVIDER,
      model: CONTROLLED_PI_MODEL,
      runtime: runtimeIdentity,
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:00:00.000Z",
      metadata: Object.freeze({}),
    });
    const protectedRuntime = createWorkspaceRuntimeInternals(seed).protectedRuntime;
    await protectedRuntime.activations.bootstrapGenesis({
      capabilityRevision: {
        kind: "capability_revision",
        capabilityId: "general-collaboration",
        capabilityRevisionId: "general-collaboration-genesis-v1",
        bundleDigest: "a".repeat(64),
      },
      activeDefinitions: Object.freeze({}),
    });
    await protectedRuntime.activations.admitTurnPlan(
      recoveryTurnPlan("session-process-killed", "turn-process-killed"),
    );
    await seed.operational.messages.put({
      messageId: "turn-process-killed:user",
      sessionId: "session-process-killed",
      role: "user",
      content: "Inspect this interrupted work",
      sensitivity: "normal",
      createdAt: "2026-07-26T00:00:01.000Z",
      metadata: Object.freeze({ turnId: "turn-process-killed" }),
    });
    await seed.operational.toolCalls.put({
      toolCallId: "action-process-killed",
      sessionId: "session-process-killed",
      turnId: "turn-process-killed",
      toolName: "shell.run",
      request: Object.freeze({ command: "long-running-command" }),
      status: "running",
      sensitivity: "normal",
      createdAt: "2026-07-26T00:00:02.000Z",
    });
    seed.close();

    const runtime = await createApplicationRuntimeComposition({
      config,
      createAgent: (_sessionTools, codeExecution, selfTools) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution, selfTools }),
      createRoleRunner: (configurations) =>
        createPiAgentRoleRunner(process.cwd(), controlled.models, configurations),
    });

    expect(runtime.getTrail("session-process-killed")).toMatchObject({ status: "aborted", turns: [] });
    expect(await runtime.getTranscript("session-process-killed")).toMatchObject([
      { kind: "message", role: "user", text: "Inspect this interrupted work" },
      {
        kind: "action",
        actionId: "action-process-killed",
        status: "interrupted",
        output: { error: "Runtime exited before turn settled", reason: "interrupted" },
      },
    ]);
    await expect(runtime.resumeTrail("session-process-killed")).resolves.toMatchObject({
      status: "idle",
      turns: [],
    });
    expect(
      (await runtime.debug.workspace.operational.messages.listForSession("session-process-killed")).filter(
        (message) => message.role === "assistant",
      ),
    ).toEqual([]);
    await runtime.shutdown();
  });

  test("hydrates and resumes running sessions left before admission or after turn settlement", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-session-window-recovery-"));
    roots.push(home);
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const controlled = createControlledPiModels();
    const runtimeIdentity = createPiAgentRuntime(process.cwd(), controlled.models).name;
    const seed = await createWorkspaceStore(home, {
      now: () => "2026-07-26T00:00:00.000Z",
    });
    const runningSession = (sessionId: string) =>
      Object.freeze({
        sessionId,
        title: sessionId,
        status: "running" as const,
        provider: CONTROLLED_PI_PROVIDER,
        model: CONTROLLED_PI_MODEL,
        runtime: runtimeIdentity,
        createdAt: "2026-07-26T00:00:00.000Z",
        updatedAt: "2026-07-26T00:00:00.000Z",
        metadata: Object.freeze({}),
      });
    await seed.operational.sessions.put(runningSession("session-before-admission"));
    await seed.operational.sessions.put(runningSession("session-after-settlement"));

    const protectedRuntime = createWorkspaceRuntimeInternals(seed).protectedRuntime;
    await protectedRuntime.activations.bootstrapGenesis({
      capabilityRevision: {
        kind: "capability_revision",
        capabilityId: "general-collaboration",
        capabilityRevisionId: "general-collaboration-genesis-v1",
        bundleDigest: "a".repeat(64),
      },
      activeDefinitions: Object.freeze({}),
    });
    await protectedRuntime.activations.admitTurnPlan(
      recoveryTurnPlan("session-after-settlement", "turn-before-idle-persist"),
    );
    await seed.operational.messages.put({
      messageId: "turn-before-idle-persist:user",
      sessionId: "session-after-settlement",
      role: "user",
      content: "A completed request",
      sensitivity: "normal",
      createdAt: "2026-07-26T00:00:01.000Z",
      metadata: Object.freeze({ turnId: "turn-before-idle-persist" }),
    });
    await seed.operational.messages.put({
      messageId: "turn-before-idle-persist:assistant",
      sessionId: "session-after-settlement",
      role: "assistant",
      content: "A completed response",
      sensitivity: "normal",
      createdAt: "2026-07-26T00:00:02.000Z",
      metadata: Object.freeze({ turnId: "turn-before-idle-persist" }),
    });
    await seed.operational.outcomes.put({
      outcomeId: "turn-before-idle-persist:outcome",
      sessionId: "session-after-settlement",
      turnId: "turn-before-idle-persist",
      status: "accepted",
      summary: "A completed response",
      sensitivity: "normal",
      createdAt: "2026-07-26T00:00:03.000Z",
      metadata: Object.freeze({ replayEligible: true, aborted: false }),
    });
    await seed.operational.foregroundTurns.settle({
      turnId: "turn-before-idle-persist",
      outcomeId: "turn-before-idle-persist:outcome",
      status: "completed",
      settledAt: "2026-07-26T00:00:03.000Z",
    });
    // Recreate the process-exit window after durable turn settlement but before the runtime's
    // final trail-state write restored the session to idle.
    await seed.operational.sessions.put(runningSession("session-after-settlement"));
    seed.close();

    const runtime = await createApplicationRuntimeComposition({
      config,
      createAgent: (_sessionTools, codeExecution, selfTools) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution, selfTools }),
      createRoleRunner: (configurations) =>
        createPiAgentRoleRunner(process.cwd(), controlled.models, configurations),
    });

    expect(runtime.getTrail("session-before-admission")).toMatchObject({ status: "aborted", turns: [] });
    expect(runtime.getTrail("session-after-settlement")).toMatchObject({
      status: "aborted",
      turns: [{ input: "A completed request", output: "A completed response" }],
    });
    await expect(runtime.resumeTrail("session-before-admission")).resolves.toMatchObject({
      status: "idle",
      turns: [],
    });
    await expect(runtime.resumeTrail("session-after-settlement")).resolves.toMatchObject({
      status: "idle",
      turns: [{ input: "A completed request", output: "A completed response" }],
    });
    expect(
      await runtime.debug.workspace.operational.outcomes.listForSession("session-before-admission"),
    ).toEqual([]);
    await runtime.shutdown();
  });

  test("persists every top-level model action and exposes the same transcript after restart", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-durable-actions-"));
    roots.push(home);
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const controlled = createControlledPiModels();
    const runtimeIdentity = createPiAgentRuntime(process.cwd(), controlled.models).name;
    const noOp = async (): Promise<void> => undefined;
    const actionAgent: NoesisAgentRuntime = Object.freeze({
      name: runtimeIdentity,
      run: async (request: AgentRuntimeRequest, emit: (event: AgentRuntimeEvent) => void) => {
        for (const [index, name] of ["inspect_self", "remember", "adapt", "execute"].entries()) {
          const actionId = `action-${String(index + 1)}`;
          emit({
            type: "tool-start",
            actionId,
            name,
            input: { fixture: name },
          });
          emit({
            type: "tool-end",
            actionId,
            name,
            isError: false,
            result: { status: "completed", fixture: name },
          });
        }
        return Object.freeze({
          outcome: "completed" as const,
          stopReason: "stop" as const,
          text: "All actions completed.",
          provider: request.provider,
          model: request.model,
        });
      },
      steer: noOp,
      abort: noOp,
    });
    const first = await createApplicationRuntimeComposition({
      config,
      agent: actionAgent,
      createRoleRunner: (configurations) =>
        createPiAgentRoleRunner(process.cwd(), controlled.models, configurations),
    });
    const trail = await first.startTrail({ title: "Durable actions" });
    await first.runTurn(trail.trailId, "Use your full self tool surface");
    const beforeRestart = await first.getTranscript(trail.trailId);
    expect(beforeRestart.flatMap((entry) => (entry.kind === "action" ? [entry.name] : []))).toEqual([
      "inspect_self",
      "remember",
      "adapt",
      "execute",
    ]);
    expect(beforeRestart.flatMap((entry) => (entry.kind === "action" ? [entry.actionId] : []))).toEqual([
      expect.stringMatching(/:action-1$/u),
      expect.stringMatching(/:action-2$/u),
      expect.stringMatching(/:action-3$/u),
      expect.stringMatching(/:action-4$/u),
    ]);
    await first.shutdown();

    const reopened = await createApplicationRuntimeComposition({
      config,
      agent: actionAgent,
      createRoleRunner: (configurations) =>
        createPiAgentRoleRunner(process.cwd(), controlled.models, configurations),
    });
    expect(await reopened.getTranscript(trail.trailId)).toEqual(beforeRestart);
    await reopened.shutdown();
  });

  test("runs queued turns through the durable interaction controller and records successful steering", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-interaction-controller-"));
    roots.push(home);
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const controlled = createControlledPiModels();
    const runtimeIdentity = createPiAgentRuntime(process.cwd(), controlled.models).name;
    let finishTurn: ((outcome: "completed" | "aborted") => void) | undefined;
    const turnFinished = new Promise<"completed" | "aborted">((resolve) => {
      finishTurn = resolve;
    });
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const steered: string[] = [];
    const interactionAgent: NoesisAgentRuntime = Object.freeze({
      name: runtimeIdentity,
      run: async (request: AgentRuntimeRequest) => {
        markStarted?.();
        const outcome = await turnFinished;
        return outcome === "aborted"
          ? Object.freeze({
              outcome: "aborted" as const,
              stopReason: "aborted" as const,
              text: "partial",
              provider: request.provider,
              model: request.model,
            })
          : Object.freeze({
              outcome: "completed" as const,
              stopReason: "stop" as const,
              text: "completed",
              provider: request.provider,
              model: request.model,
            });
      },
      steer: async (_trailId: string, text: string) => {
        steered.push(text);
      },
      abort: async () => {
        finishTurn?.("aborted");
      },
    });
    const runtime = await createApplicationRuntimeComposition({
      config,
      agent: interactionAgent,
      createRoleRunner: (configurations) =>
        createPiAgentRoleRunner(process.cwd(), controlled.models, configurations),
    });
    const trail = await runtime.startTrail({ title: "Durable interaction" });

    const queued = await runtime.interact(trail.trailId, {
      type: "submit",
      text: "Run this as its own turn",
    });
    expect(queued.effect).toBe("queued");
    await started;
    const steeredResult = await runtime.interact(trail.trailId, {
      type: "steer",
      text: "Focus on the durable evidence",
    });
    expect(steeredResult.effect).toBe("steered");
    expect(steered).toEqual(["Focus on the durable evidence"]);
    const messages = await runtime.debug.workspace.operational.messages.listForSession(trail.trailId);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: "Run this as its own turn",
          metadata: expect.objectContaining({ sourceIntentId: queued.intentId }),
        }),
        expect.objectContaining({
          role: "user",
          content: "Focus on the durable evidence",
          metadata: expect.objectContaining({
            sourceIntentId: steeredResult.intentId,
            deliveryMode: "steer",
          }),
        }),
      ]),
    );

    await runtime.interact(trail.trailId, {
      type: "submit",
      text: "Preserve this queued turn",
    });
    await runtime.interact(trail.trailId, { type: "interrupt" });
    await waitUntil(async () => (await runtime.inspectInteraction(trail.trailId)).phase === "idle");
    expect((await runtime.inspectInteraction(trail.trailId)).pending.map((item) => item.text)).toEqual([
      "Preserve this queued turn",
    ]);
    await runtime.shutdown();
  });

  test("settles an interacted completion into the authoritative trail context and turns", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-interacted-settlement-"));
    roots.push(home);
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const controlled = createControlledPiModels();
    const runtimeIdentity = createPiAgentRuntime(process.cwd(), controlled.models).name;
    const noOp = async (): Promise<void> => undefined;
    const runtime = await createApplicationRuntimeComposition({
      config,
      agent: Object.freeze({
        name: runtimeIdentity,
        run: async (request: AgentRuntimeRequest) =>
          Object.freeze({
            outcome: "completed" as const,
            stopReason: "stop" as const,
            text: "durably completed",
            provider: request.provider,
            model: request.model,
          }),
        steer: noOp,
        abort: noOp,
      }),
      createRoleRunner: (configurations) =>
        createPiAgentRoleRunner(process.cwd(), controlled.models, configurations),
    });
    const trail = await runtime.startTrail({ title: "Interacted settlement" });

    await runtime.interact(trail.trailId, {
      type: "submit",
      text: "Complete through the interaction controller",
    });
    await waitUntil(() => runtime.getTrail(trail.trailId).turns.length === 1);

    expect(runtime.getTrail(trail.trailId)).toMatchObject({
      status: "idle",
      contextSnapshotId: expect.any(String),
      context: {
        snapshotId: expect.any(String),
        usedTokens: expect.any(Number),
      },
      turns: [
        {
          input: "Complete through the interaction controller",
          output: "durably completed",
        },
      ],
    });
    await runtime.shutdown();
  });

  test("a real app turn pins admission and records exact durable operational work", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-control-plane-"));
    roots.push(home);
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const controlled = createControlledPiModels();
    const runtimeIdentity = createPiAgentRuntime(process.cwd(), controlled.models).name;
    const skills = createPiSkillLibrary({
      cwd: home,
      agentDirectory: join(home, "agent"),
    });
    const requests: AgentRuntimeRequest[] = [];
    const seenConfigurations: unknown[] = [];
    const runtime = await createApplicationRuntimeComposition({
      config,
      skills,
      createAgent: (_sessionTools, codeExecution, selfTools, skillLibrary) => {
        const pi = createPiAgentRuntime(process.cwd(), controlled.models, {
          codeExecution,
          selfTools,
          requirePinnedSkillSnapshot: true,
          ...(skillLibrary ? { skills: skillLibrary } : {}),
        });
        const capturingAgent: NoesisAgentRuntime = Object.freeze({
          ...pi,
          run: async (request: AgentRuntimeRequest, emit: (event: AgentRuntimeEvent) => void) => {
            requests.push(request);
            return await pi.run(request, emit);
          },
        });
        return capturingAgent;
      },
      createRoleRunner: (configurations) => {
        seenConfigurations.push(...configurations);
        return createPiAgentRoleRunner(process.cwd(), controlled.models, configurations);
      },
    });

    const trail = await runtime.startTrail({ title: "Composition acceptance" });
    const result = await runtime.runTurn(trail.trailId, "Record this ordinary turn");
    expect(result.outcome).toBe("completed");
    expect(config.schemaVersion).toBe(1);
    expect(await runtime.debug.workspace.operational.sessions.get(trail.trailId)).toMatchObject({
      sessionId: trail.trailId,
      runtime: runtimeIdentity,
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
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    let reflectorRuns = 0;
    const controlled = createControlledPiModels({
      respond: ({ systemPrompt, lastUserText }) => {
        if (!systemPrompt.includes("role: reflector")) return `Controlled completion for: ${lastUserText}`;
        reflectorRuns += 1;
        return JSON.stringify({
          decision: "no_change",
          reason: "The single correction is useful evidence but not yet a durable adaptation.",
        });
      },
    });
    const runtime = await createApplicationRuntimeComposition({
      config,
      createAgent: (_sessionTools, codeExecution, selfTools) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution, selfTools }),
      createRoleRunner: (configurations) =>
        createPiAgentRoleRunner(process.cwd(), controlled.models, configurations),
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

  test("bounds shutdown when ambient reflection ignores abort and leaves recovery to its durable lease", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-bounded-shutdown-"));
    roots.push(home);
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const controlled = createControlledPiModels();
    let markReflectionStarted: (() => void) | undefined;
    const reflectionStarted = new Promise<void>((resolve) => {
      markReflectionStarted = resolve;
    });
    let releaseReflection: (() => void) | undefined;
    const blockedReflection = new Promise<void>((resolve) => {
      releaseReflection = resolve;
    });
    const runtime = await createApplicationRuntimeComposition({
      config,
      createAgent: (_sessionTools, codeExecution, selfTools) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution, selfTools }),
      createRoleRunner: (configurations) =>
        createScriptedAgentRoleRunner({
          variants: configurations,
          respond: async (request) => {
            if (!request.systemPrompt.includes("role: reflector"))
              throw new Error("Only reflection should run in the bounded-shutdown fixture");
            markReflectionStarted?.();
            await blockedReflection;
            return Object.freeze({
              text: JSON.stringify({
                decision: "no_change",
                reason: "The fixture releases only after bounded shutdown returns.",
              }),
            });
          },
        }),
    });

    const trail = await runtime.startTrail({ title: "Bounded ambient shutdown" });
    await runtime.runTurn(trail.trailId, "Actually, keep this research brief concise.");
    await reflectionStarted;

    let timeout: NodeJS.Timeout | undefined;
    try {
      const shutdown = runtime.shutdown();
      expect(runtime.shutdown()).toBe(shutdown);
      const outcome = await Promise.race([
        shutdown.then(() => "settled" as const),
        new Promise<"timed-out">((resolve) => {
          timeout = setTimeout(() => resolve("timed-out"), 1_000);
        }),
      ]);
      expect(outcome).toBe("settled");
      const jobs = await runtime.debug.workspace.jobs.list({ limit: 10 });
      expect(jobs).toMatchObject([
        {
          kind: "runtime.reflect_turn",
          status: "running",
          leaseToken: expect.any(String),
          leaseUntil: expect.any(String),
        },
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      releaseReflection?.();
      await runtime.controlPlane.stop();
    }
  });

  test("propagates shutdown cancellation through learning into an active ambient role run", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-cooperative-reflection-shutdown-"));
    roots.push(home);
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const controlled = createControlledPiModels();
    let markReflectionStarted: (() => void) | undefined;
    const reflectionStarted = new Promise<void>((resolve) => {
      markReflectionStarted = resolve;
    });
    let markReflectionAborted: (() => void) | undefined;
    const reflectionAborted = new Promise<void>((resolve) => {
      markReflectionAborted = resolve;
    });
    let releaseReflection: (() => void) | undefined;
    const release = new Promise<void>((resolve) => {
      releaseReflection = resolve;
    });
    const runtime = await createApplicationRuntimeComposition({
      config,
      createAgent: (_sessionTools, codeExecution, selfTools) =>
        createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution, selfTools }),
      createRoleRunner: (configurations) =>
        createScriptedAgentRoleRunner({
          variants: configurations,
          respond: async (request) => {
            if (!request.systemPrompt.includes("role: reflector"))
              throw new Error("Only reflection should run in the cooperative-shutdown fixture");
            markReflectionStarted?.();
            await Promise.race([
              release,
              new Promise<void>((resolve) => {
                const onAbort = () => {
                  markReflectionAborted?.();
                  resolve();
                };
                if (request.signal.aborted) onAbort();
                else request.signal.addEventListener("abort", onAbort, { once: true });
              }),
            ]);
            return Object.freeze({
              text: JSON.stringify({
                decision: "no_change",
                reason: "The role run settled after receiving shutdown cancellation.",
              }),
            });
          },
        }),
    });

    try {
      const trail = await runtime.startTrail({ title: "Cooperative ambient shutdown" });
      await runtime.runTurn(trail.trailId, "Actually, keep this research brief concise.");
      await reflectionStarted;

      await runtime.shutdown();
      const cancellation = await Promise.race([
        reflectionAborted.then(() => "aborted" as const),
        new Promise<"timed-out">((resolve) => {
          const timeout = setTimeout(() => resolve("timed-out"), 1_000);
          timeout.unref();
        }),
      ]);

      expect(cancellation).toBe("aborted");
    } finally {
      releaseReflection?.();
      await runtime.controlPlane.stop();
    }
  });
});
